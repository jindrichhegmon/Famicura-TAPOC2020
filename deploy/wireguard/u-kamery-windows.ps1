<#
.SYNOPSIS
  Famicura Tapo – Windows server u kamery jako brána pro obraz z kamery.

.DESCRIPTION
  Nainstaluje tunel WireGuard k VPS (jako službu, naběhne i po restartu) a
  předávání jediného portu: TCP 554 na tomto serveru → kamera. Tunelem je
  z VPS dostupný jen tento port; nic jiného na serveru ani v místní síti.
  Firewall pouští port 554 a ping jen z VPS na konci tunelu (10.77.0.1).
  Tunel nemění běžné směrování serveru do internetu.

  Spouštět v PowerShellu otevřeném jako správce, ve složce se soubory:

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    .\u-kamery-windows.ps1 -Konfigurace .\famicura-wg-u-kamery.conf

  Změna IP adresy kamery (bez nového tunelu):
    .\u-kamery-windows.ps1 -Kamera 192.168.1.60

  Odebrání všeho, co skript nastavil:
    .\u-kamery-windows.ps1 -Odebrat

  Skript jde spustit opakovaně; co už je nastavené, jen znovu nastaví.
#>
param(
  [string]$Konfigurace,
  [string]$Kamera,
  [switch]$Odebrat
)
$ErrorActionPreference = 'Stop'
$Tunel   = 'wg-famicura'
$Slozka  = Join-Path $env:ProgramData 'Famicura'
$Wg      = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
$Vps     = '10.77.0.1'
$Skupina = 'Famicura Tapo'
$Sluzba  = "WireGuardTunnel`$$Tunel"     # jak služba tunelu jmenuje WireGuard

# wireguard.exe a netsh píšou i běžná hlášení na stderr. Windows PowerShell 5.1
# z nich při ErrorActionPreference=Stop dělá chybu, která skript ukončí, a to
# i přes 2>$null. Proto se volají tady: rozhoduje návratový kód, ne stderr.
function Spust([scriptblock]$prikaz) {
  $puvodni = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $vystup = & $prikaz 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $puvodni }
  return [pscustomobject]@{ Kod = $LASTEXITCODE; Text = (@($vystup) -join ' ').Trim() }
}

function Konec([string]$text) { Write-Host $text -ForegroundColor Red; exit 1 }
function Platna-IP([string]$ip) { return $ip -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -and ($ip.Split('.') | Where-Object { [int]$_ -gt 255 }).Count -eq 0 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Konec 'Spusťte PowerShell jako správce (pravým tlačítkem → Spustit jako správce).'
}

# Jediné pravidlo předávání, které tento skript spravuje: 0.0.0.0:554 → kamera.
function Nastav-Predavani([string]$ip) {
  Set-Service iphlpsvc -StartupType Automatic      # služba, která portproxy obsluhuje
  Start-Service iphlpsvc
  Spust { netsh interface portproxy delete v4tov4 listenport=554 listenaddress=0.0.0.0 } | Out-Null
  $r = Spust { netsh interface portproxy add v4tov4 listenport=554 listenaddress=0.0.0.0 connectport=554 connectaddress=$ip }
  if ($r.Kod -ne 0) { Konec "Předávání portu 554 se nepodařilo nastavit: $($r.Text)" }
}

function Odeber-Tunel {
  if (Get-Service -Name $Sluzba -ErrorAction SilentlyContinue) {
    Spust { & $Wg /uninstalltunnelservice $Tunel } | Out-Null
    for ($i = 0; $i -lt 10 -and (Get-Service -Name $Sluzba -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
  }
}

function Zkus-Kameru([string]$ip) {
  Write-Host "Zkouším, jestli server vidí kameru $ip na portu 554…"
  if (Test-NetConnection -ComputerName $ip -Port 554 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    Write-Host "Kamera $ip odpovídá." -ForegroundColor Green
  } else {
    Write-Host "POZOR: kamera $ip z tohoto serveru na portu 554 neodpovídá. Je zapnutá a ve stejné síti?" -ForegroundColor Yellow
  }
}

if ($Odebrat) {
  if (Test-Path $Wg) { Odeber-Tunel }
  Spust { netsh interface portproxy delete v4tov4 listenport=554 listenaddress=0.0.0.0 } | Out-Null
  Get-NetFirewallRule -Group $Skupina -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-Item -Recurse -Force $Slozka -ErrorAction SilentlyContinue
  Write-Host 'Odebráno: tunel, předávání portu 554 i pravidla firewallu.' -ForegroundColor Green
  exit 0
}

if ($Kamera -and -not $Konfigurace) {
  if (-not (Platna-IP $Kamera)) { Konec "Neplatná IP adresa kamery: $Kamera" }
  Nastav-Predavani $Kamera
  Zkus-Kameru $Kamera
  Write-Host "Port 554 teď vede na kameru $Kamera." -ForegroundColor Green
  exit 0
}

if (-not $Konfigurace -or -not (Test-Path $Konfigurace)) {
  Konec 'Chybí soubor s konfigurací: -Konfigurace .\famicura-wg-u-kamery.conf'
}
if (-not (Test-Path $Wg)) {
  Konec 'Nejdřív nainstalujte WireGuard pro Windows z https://www.wireguard.com/install/ a spusťte tento skript znovu.'
}

$text = Get-Content -Raw -Encoding UTF8 $Konfigurace
$m = [regex]::Match($text, '(?m)^# KAMERA=(\S+)\s*$')
if (-not $m.Success -or -not (Platna-IP $m.Groups[1].Value)) {
  Konec 'V konfiguraci chybí řádek # KAMERA=<IP>. Vytvořte ji znovu na Macu: ./deploy/wireguard-vps.sh <IP kamery> --windows'
}
if ($text -notmatch '(?m)^# REZIM=windows\s*$') {
  Konec 'Tahle konfigurace není pro Windows server. Vytvořte ji na Macu s přepínačem --windows.'
}
if ($Kamera) {
  if (-not (Platna-IP $Kamera)) { Konec "Neplatná IP adresa kamery: $Kamera" }
} else { $Kamera = $m.Groups[1].Value }

# Port 554 na serveru nesmí držet nic jiného než naše předávání.
$posloucha = Get-NetTCPConnection -LocalPort 554 -State Listen -ErrorAction SilentlyContinue
$nase = @(netsh interface portproxy show v4tov4) -match '\b554\b'
if ($posloucha -and -not $nase) {
  Konec "Port 554 na tomto serveru už používá jiný program (PID $($posloucha[0].OwningProcess)). Nic jsem neměnil."
}

Zkus-Kameru $Kamera

# Konfigurace obsahuje soukromý klíč: jen SYSTEM a Administrators (SID platí i v české Windows).
New-Item -ItemType Directory -Force $Slozka | Out-Null
$cil = Join-Path $Slozka "$Tunel.conf"
Copy-Item -Force $Konfigurace $cil
icacls $Slozka /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

# Tunel jako služba WireGuard: naběhne sám i po restartu serveru. Starou
# službu (z dřívějšího spuštění) nejdřív odebrat, jinak by instalace selhala.
Odeber-Tunel
$r = Spust { & $Wg /installtunnelservice $cil }
if ($r.Kod -ne 0) { Konec "Tunel se nepodařilo nainstalovat: $($r.Text)" }
$bezi = $false
for ($i = 0; $i -lt 15 -and -not $bezi; $i++) {
  Start-Sleep -Seconds 1
  $bezi = (Get-Service -Name $Sluzba -ErrorAction SilentlyContinue).Status -eq 'Running'
}
if (-not $bezi) { Konec "Služba tunelu $Sluzba se nespustila. Podívejte se do aplikace WireGuard na záložku Log." }
Write-Host 'Tunel WireGuard je nainstalovaný jako služba.' -ForegroundColor Green

Nastav-Predavani $Kamera

# Firewall: port 554 a ping jen z VPS na konci tunelu, z nikoho jiného.
Get-NetFirewallRule -Group $Skupina -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Group $Skupina -DisplayName 'Famicura Tapo – obraz z kamery pro VPS' `
  -Direction Inbound -Protocol TCP -LocalPort 554 -RemoteAddress $Vps -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -Group $Skupina -DisplayName 'Famicura Tapo – ping z VPS' `
  -Direction Inbound -Protocol ICMPv4 -IcmpType 8 -RemoteAddress $Vps -Action Allow -Profile Any | Out-Null

$vypnuty = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })
if ($vypnuty.Count) {
  Write-Host "POZOR: firewall Windows je vypnutý (profil $($vypnuty -join ', ')). Port 554 by pak byl dostupný i z místní sítě." -ForegroundColor Yellow
}

Write-Host 'Čekám na spojení s VPS…'
$ok = $false
for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
  Start-Sleep -Seconds 2
  $ok = Test-Connection -ComputerName $Vps -Count 1 -Quiet
}
if ($ok) {
  Write-Host "Hotovo: tunel k VPS běží a port 554 vede na kameru $Kamera." -ForegroundColor Green
} else {
  Write-Host 'Tunel je nainstalovaný, ale VPS zatím neodpovídá. Stav najdete v aplikaci WireGuard (tunel wg-famicura).' -ForegroundColor Yellow
}
Write-Host "Teď smažte soubor $Konfigurace – obsahuje soukromý klíč. Kopie pro službu je v $Slozka (přístup jen pro správce)."
