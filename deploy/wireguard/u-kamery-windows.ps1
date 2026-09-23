<#
.SYNOPSIS
  Famicura Tapo – Windows server u kamery jako brána pro obraz z kamery.

.DESCRIPTION
  Nainstaluje tunel WireGuard k VPS (jako službu, naběhne i po restartu) a
  předávání dvou portů na kameru: TCP 554 (obraz, RTSP) a TCP 2020 (události,
  které kamera sama hlásí – ONVIF). Tunelem jsou z VPS dostupné jen tyto dva
  porty; nic jiného na serveru ani v místní síti. Firewall je pouští spolu
  s pingem jen z VPS na konci tunelu (10.77.0.1).
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
$Porty   = @(554, 2020)                  # RTSP (obraz) a ONVIF (události kamery)

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

# Jediná pravidla předávání, která tento skript spravuje: 0.0.0.0:554 a :2020 → kamera.
function Nastav-Predavani([string]$ip) {
  Set-Service iphlpsvc -StartupType Automatic      # služba, která portproxy obsluhuje
  Start-Service iphlpsvc
  foreach ($port in $Porty) {
    Spust { netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 } | Out-Null
    $r = Spust { netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$ip }
    if ($r.Kod -ne 0) { Konec "Předávání portu $port se nepodařilo nastavit: $($r.Text)" }
  }
}

function Odeber-Predavani {
  foreach ($port in $Porty) {
    Spust { netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 } | Out-Null
  }
}

# Firewall: porty na kameru a ping jen z VPS na konci tunelu, z nikoho jiného.
function Nastav-Firewall {
  Get-NetFirewallRule -Group $Skupina -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Group $Skupina -DisplayName 'Famicura Tapo – obraz z kamery pro VPS' `
    -Direction Inbound -Protocol TCP -LocalPort 554 -RemoteAddress $Vps -Action Allow -Profile Any | Out-Null
  New-NetFirewallRule -Group $Skupina -DisplayName 'Famicura Tapo – události kamery pro VPS' `
    -Direction Inbound -Protocol TCP -LocalPort 2020 -RemoteAddress $Vps -Action Allow -Profile Any | Out-Null
  New-NetFirewallRule -Group $Skupina -DisplayName 'Famicura Tapo – ping z VPS' `
    -Direction Inbound -Protocol ICMPv4 -IcmpType 8 -RemoteAddress $Vps -Action Allow -Profile Any | Out-Null
}

function Odeber-Tunel {
  if (Get-Service -Name $Sluzba -ErrorAction SilentlyContinue) {
    Spust { & $Wg /uninstalltunnelservice $Tunel } | Out-Null
    for ($i = 0; $i -lt 10 -and (Get-Service -Name $Sluzba -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
  }
}

function Zkus-Kameru([string]$ip) {
  foreach ($port in $Porty) {
    Write-Host "Zkouším, jestli server vidí kameru $ip na portu $port…"
    if (Test-NetConnection -ComputerName $ip -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
      Write-Host "Kamera $ip na portu $port odpovídá." -ForegroundColor Green
    } elseif ($port -eq 554) {
      Write-Host "POZOR: kamera $ip z tohoto serveru na portu 554 neodpovídá. Je zapnutá a ve stejné síti?" -ForegroundColor Yellow
    } else {
      Write-Host "POZOR: kamera $ip na portu 2020 (ONVIF) neodpovídá. Události kamery pak nepůjdou; obraz ano." -ForegroundColor Yellow
    }
  }
}

if ($Odebrat) {
  if (Test-Path $Wg) { Odeber-Tunel }
  Odeber-Predavani
  Get-NetFirewallRule -Group $Skupina -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-Item -Recurse -Force $Slozka -ErrorAction SilentlyContinue
  Write-Host 'Odebráno: tunel, předávání portů 554 a 2020 i pravidla firewallu.' -ForegroundColor Green
  exit 0
}

if ($Kamera -and -not $Konfigurace) {
  if (-not (Platna-IP $Kamera)) { Konec "Neplatná IP adresa kamery: $Kamera" }
  Nastav-Predavani $Kamera
  Nastav-Firewall
  Zkus-Kameru $Kamera
  Write-Host "Porty 554 a 2020 teď vedou na kameru $Kamera." -ForegroundColor Green
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

# Porty 554 a 2020 na serveru nesmí držet nic jiného než naše předávání.
foreach ($port in $Porty) {
  $posloucha = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  $nase = @(netsh interface portproxy show v4tov4) -match "\b$port\b"
  if ($posloucha -and -not $nase) {
    Konec "Port $port na tomto serveru už používá jiný program (PID $($posloucha[0].OwningProcess)). Nic jsem neměnil."
  }
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
Nastav-Firewall

$vypnuty = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })
if ($vypnuty.Count) {
  Write-Host "POZOR: firewall Windows je vypnutý (profil $($vypnuty -join ', ')). Porty 554 a 2020 by pak byly dostupné i z místní sítě." -ForegroundColor Yellow
}

Write-Host 'Čekám na spojení s VPS…'
$ok = $false
for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
  Start-Sleep -Seconds 2
  $ok = Test-Connection -ComputerName $Vps -Count 1 -Quiet
}
if ($ok) {
  Write-Host "Hotovo: tunel k VPS běží a porty 554 a 2020 vedou na kameru $Kamera." -ForegroundColor Green
} else {
  Write-Host 'Tunel je nainstalovaný, ale VPS zatím neodpovídá. Stav najdete v aplikaci WireGuard (tunel wg-famicura).' -ForegroundColor Yellow
}
Write-Host "Teď smažte soubor $Konfigurace – obsahuje soukromý klíč. Kopie pro službu je v $Slozka (přístup jen pro správce)."
