<#
.SYNOPSIS
  Famicura Tapo – Windows server u kamery přivede kameru na VPS odchozím tunelem SSH.

.DESCRIPTION
  Náhrada za tunel WireGuard tam, kde firewall na serveru (typicky ESET) nepustí
  příchozí spojení z tunelu a nikdo ho nemůže nastavit. Tady spojení navazuje
  server směrem ven (port 22 na VPS, to firewally pouštějí) a tímhle spojením
  přivede kameru na VPS: obraz (RTSP 554) na 127.0.0.1:10554 a události
  (ONVIF 2020) na 127.0.0.1:12020 – jen na localhost VPS, nikam jinam.
  Tunel drží úloha plánovače jako SYSTEM: naběhne po restartu, po výpadku se
  připojí znovu do 10 s. Účet na VPS nemá heslo ani shell; smí jen tyhle dva porty.

  Spouštět v PowerShellu otevřeném jako správce, ve složce se skriptem:

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    .\u-kamery-windows-ssh.ps1 -Kamera 192.168.10.109

  Skript vypíše veřejný klíč. Ten pak na Macu:  ./deploy/ssh-tunel-vps.sh "<klíč>"
  Když už tu tunel WireGuard byl, IP kamery si vezme z jeho konfigurace a -Kamera netřeba.

  Stav tunelu:                .\u-kamery-windows-ssh.ps1 -Stav
  Změna IP kamery:            .\u-kamery-windows-ssh.ps1 -Kamera 192.168.10.110
  Odebrání všeho ze serveru:  .\u-kamery-windows-ssh.ps1 -Odebrat

  Skript jde spustit opakovaně; klíč zůstává, ostatní jen znovu nastaví.
#>
param(
  [string]$Kamera,
  [string]$Vps = '95.216.201.2',
  [switch]$Stav,
  [switch]$Odebrat
)
$ErrorActionPreference = 'Stop'
$Slozka   = Join-Path $env:ProgramData 'Famicura\ssh'
$WgConf   = Join-Path $env:ProgramData 'Famicura\wg-famicura.conf'   # dřívější tunel WireGuard, je-li
$Ssh      = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$SshKeygen= Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
$Klic     = Join-Path $Slozka 'tunel_ed25519'
$Bezec    = Join-Path $Slozka 'tunel.ps1'
$Log      = Join-Path $Slozka 'tunel.log'
$Uloha    = 'Famicura Tapo – tunel SSH'
$Ucet     = 'famicura-tunel'
$PortRtsp = 10554                        # na VPS: 127.0.0.1:10554 → kamera:554
$PortOnvif= 12020                        # na VPS: 127.0.0.1:12020 → kamera:2020

function Konec([string]$text) { Write-Host $text -ForegroundColor Red; exit 1 }
function Platna-IP([string]$ip) { return $ip -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -and ($ip.Split('.') | Where-Object { [int]$_ -gt 255 }).Count -eq 0 }

# Procesy ssh.exe, které drží náš tunel (jiných ssh na serveru se nedotkne).
function Nase-Spojeni {
  return @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Ucet@*" })
}
function Zastav-Tunel {
  if (Get-ScheduledTask -TaskName $Uloha -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $Uloha -ErrorAction SilentlyContinue }
  Nase-Spojeni | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Bezec*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Konec 'Spusťte PowerShell jako správce (pravým tlačítkem → Spustit jako správce).'
}

if ($Stav) {
  $u = Get-ScheduledTask -TaskName $Uloha -ErrorAction SilentlyContinue
  if (-not $u) { Konec 'Tunel SSH na tomto serveru není nastavený. Spusťte skript s -Kamera <IP kamery>.' }
  Write-Host "Úloha plánovače: $($u.State)"
  $s = Nase-Spojeni
  if ($s.Count) { Write-Host "Spojení k VPS: běží (ssh.exe PID $($s[0].ProcessId))" -ForegroundColor Green }
  else { Write-Host 'Spojení k VPS: teď neběží (úloha ho zkusí znovu do 10 s)' -ForegroundColor Yellow }
  if (Test-Path $Log) { Write-Host "Poslední řádky ${Log}:"; Get-Content $Log -Tail 8 | ForEach-Object { "  $_" } }
  if (Test-Path "$Klic.pub") { Write-Host "Veřejný klíč (pro ./deploy/ssh-tunel-vps.sh):"; Write-Host (Get-Content "$Klic.pub") -ForegroundColor Cyan }
  exit 0
}

if ($Odebrat) {
  Zastav-Tunel
  if (Get-ScheduledTask -TaskName $Uloha -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $Uloha -Confirm:$false }
  Remove-Item -Recurse -Force $Slozka -ErrorAction SilentlyContinue
  Write-Host 'Odebráno: úloha plánovače, spojení k VPS i klíč. Na VPS pak: ./deploy/ssh-tunel-vps.sh odebrat' -ForegroundColor Green
  exit 0
}

# IP kamery: z parametru, nebo z konfigurace dřívějšího tunelu WireGuard.
if (-not $Kamera -and (Test-Path $WgConf)) {
  $m = [regex]::Match((Get-Content -Raw $WgConf), '(?m)^# KAMERA=(\S+)\s*$')
  if ($m.Success) { $Kamera = $m.Groups[1].Value; Write-Host "IP kamery z konfigurace WireGuard: $Kamera" }
}
if (-not $Kamera) { Konec 'Zadejte IP adresu kamery: .\u-kamery-windows-ssh.ps1 -Kamera 192.168.10.109' }
if (-not (Platna-IP $Kamera)) { Konec "Neplatná IP adresa kamery: $Kamera" }
if (-not (Platna-IP $Vps)) { Konec "Neplatná IP adresa VPS: $Vps" }

# Klient OpenSSH je ve Windows 10/Server 2019 a novějších jako volitelná součást.
if (-not (Test-Path $Ssh)) {
  Write-Host 'Instaluji klienta OpenSSH (součást Windows)…'
  try { Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null } catch { }
  if (-not (Test-Path $Ssh)) { Konec 'Klient OpenSSH se nepodařilo nainstalovat. Nastavení → Aplikace → Volitelné funkce → přidat „Klient OpenSSH“, pak skript spusťte znovu.' }
}

Write-Host "Zkouším, jestli server vidí kameru $Kamera na portu 554…"
if (Test-NetConnection -ComputerName $Kamera -Port 554 -InformationLevel Quiet -WarningAction SilentlyContinue) {
  Write-Host "Kamera $Kamera odpovídá." -ForegroundColor Green
} else {
  Write-Host "POZOR: kamera $Kamera z tohoto serveru na portu 554 neodpovídá. Je zapnutá a ve stejné síti? Tunel nastavím i tak." -ForegroundColor Yellow
}

# Složka s klíčem: jen SYSTEM a Administrators (SID platí i v české Windows).
# OpenSSH klíč s právy pro kohokoli dalšího odmítne.
New-Item -ItemType Directory -Force $Slozka | Out-Null
icacls $Slozka /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

if (-not (Test-Path $Klic)) {
  Write-Host 'Vytvářím klíč serveru (ed25519, bez hesla – používá ho služba)…'
  # --% : zbytek řádku jde ssh-keygen doslova, takže prázdné heslo "" projde
  # v každé verzi PowerShellu; cestu doplní proměnná prostředí.
  $env:FAMICURA_KLIC = $Klic
  & $SshKeygen --% -q -t ed25519 -N "" -C famicura-tunel@windows -f "%FAMICURA_KLIC%"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$Klic.pub")) { Konec 'ssh-keygen klíč nevytvořil.' }
}
# ssh-keygen dá klíč účtu, který skript spustil. Když ssh běží jako SYSTEM,
# bere to OpenSSH jako přístup pro někoho dalšího a klíč odmítne („bad
# permissions“). Vlastník i práva proto jen SYSTEM a Administrators.
foreach ($soubor in @($Klic, "$Klic.pub")) {
  icacls $soubor /setowner '*S-1-5-32-544' | Out-Null
  if ($LASTEXITCODE -ne 0) { Konec "Nepodařilo se nastavit vlastníka souboru $soubor." }
  icacls $soubor /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Konec "Nepodařilo se nastavit práva souboru $soubor." }
}
$verejny = (Get-Content "$Klic.pub" -Raw).Trim()

# Skript, který tunel drží: po pádu spojení (výpadek internetu, restart VPS)
# ho za 10 s naváže znovu. Spouští ho úloha plánovače jako SYSTEM.
$radky = @(
  '# Famicura Tapo – drží tunel SSH k VPS. Generuje u-kamery-windows-ssh.ps1; spouští úloha plánovače.',
  '$ErrorActionPreference = ''Continue''',
  "`$log = '$Log'",
  'while ($true) {',
  '  if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Clear-Content $log }',
  '  Add-Content $log "$(Get-Date -Format s) pripojuji k VPS"',
  "  & '$Ssh' -N -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ``",
  "    -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o `"UserKnownHostsFile=$Slozka\known_hosts`" ``",
  "    -o IdentitiesOnly=yes -i '$Klic' ``",
  "    -R 127.0.0.1:${PortRtsp}:${Kamera}:554 -R 127.0.0.1:${PortOnvif}:${Kamera}:2020 $Ucet@$Vps 2>&1 |",
  '    ForEach-Object { "$_" } | Add-Content $log',
  '  Add-Content $log "$(Get-Date -Format s) spojeni skoncilo, za 10 s znovu"',
  '  Start-Sleep -Seconds 10',
  '}'
)
Zastav-Tunel
Set-Content -Path $Bezec -Value $radky -Encoding UTF8
if (Test-Path $Log) { Clear-Content $Log }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$akce = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Bezec`""
$spoust = New-ScheduledTaskTrigger -AtStartup
$nastaveni = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$nastaveni.ExecutionTimeLimit = 'PT0S'   # bez časového limitu (TimeSpan::Zero některé verze ignorují)
$hlavni = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Uloha -Action $akce -Trigger $spoust -Settings $nastaveni -Principal $hlavni -Force | Out-Null
Start-ScheduledTask -TaskName $Uloha
Write-Host "Úloha plánovače „$Uloha“ běží (jako SYSTEM, i po restartu)." -ForegroundColor Green

# První pokusy: dokud klíč není na VPS, končí „Permission denied“ – to je v pořádku.
Start-Sleep -Seconds 8
$zaznam = if (Test-Path $Log) { (Get-Content $Log -Raw) } else { '' }
if ($zaznam -match 'Permission denied') {
  Write-Host 'Server se k VPS dostal, VPS zatím klíč nezná (Permission denied) – to se spraví krokem na Macu níže.' -ForegroundColor Yellow
} elseif ($zaznam -match 'Connection timed out|Connection refused|Could not resolve|Network is unreachable') {
  Write-Host "POZOR: server se na VPS $Vps port 22 vůbec nedostal. Pouští firewall odchozí spojení na port 22?" -ForegroundColor Red
  Get-Content $Log -Tail 3 | ForEach-Object { "  $_" }
} elseif ((Nase-Spojeni).Count) {
  Write-Host 'Spojení k VPS drží.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Teď na Macu ve složce projektu spusťte (celý řádek klíče je i ve schránce):' -ForegroundColor Green
Write-Host "  ./deploy/ssh-tunel-vps.sh `"$verejny`""
Write-Host '  ./deploy/vps-kamera.sh'
Write-Host ''
Write-Host $verejny -ForegroundColor Cyan
try { Set-Clipboard -Value $verejny } catch { }
Write-Host "Kamera $Kamera bude na VPS jako 127.0.0.1:$PortRtsp (obraz) a 127.0.0.1:$PortOnvif (události). Stav: .\u-kamery-windows-ssh.ps1 -Stav"
