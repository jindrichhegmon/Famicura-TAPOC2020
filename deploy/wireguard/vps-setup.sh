#!/usr/bin/env bash
# Běží na VPS jako root; volá ho deploy/wireguard-vps.sh přes ssh.
# Nastaví tunel wg-famicura a na stdout vypíše konfiguraci pro zařízení
# u kamery. Všechna hlášení jdou na stderr, aby do ní nic nepřimíchala.
#
#   bash vps-setup.sh <IP kamery> [linux|windows] [místo]
#
# Místo = jedna brána (Mango, Raspberry Pi nebo Windows server) u jednoho
# poskytovatele; číslo 1, 2, 3… Každé místo je jeden [Peer] tunelu s adresou
# 10.77.0.(místo+1); místa jsou v /etc/wireguard/famicura-mista/<N>.peer a
# celý wg-famicura.conf se z nich skládá. Nové místo ostatní nechá být,
# stejné číslo znovu = nový klíč pro to místo (staré zařízení přestane platit).
#
# linux:   zařízení u kamery (Mango, Raspberry Pi…) posílá provoz dál ke kameře,
#          VPS má do tunelu cestu i na IP kamery.
# windows: Windows server u kamery předává jen porty 554 a 2020 (netsh portproxy);
#          VPS se připojuje na server (10.77.0.N+1) a kameru samotnou nevidí.
# Pro zkoušku bez systému: DRY=1 WG_DIR=/tmp/wg bash vps-setup.sh 192.168.1.50 windows 2
set -euo pipefail
KAMERA="${1:-}"
REZIM="${2:-linux}"
MISTO="${3:-1}"
IFACE=wg-famicura
WG_DIR="${WG_DIR:-/etc/wireguard}"
MISTA="$WG_DIR/famicura-mista"
PORT="${WG_PORT:-51821}"
NET=10.77.0
VPS_IP="${PUBLIC_IP:-95.216.201.2}"
DRY="${DRY:-}"
log() { echo "$@" >&2; }

[[ "$KAMERA" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { log "Použití: $0 <IP kamery v místní síti> [linux|windows] [místo]"; exit 1; }
case "$REZIM" in linux|windows) ;; *) log "Režim musí být linux nebo windows."; exit 1 ;; esac
[[ "$MISTO" =~ ^[0-9]+$ ]] && [ "$MISTO" -ge 1 ] && [ "$MISTO" -le 200 ] || { log "Místo je číslo 1 až 200."; exit 1; }
ADRESA="$NET.$((MISTO + 1))"

if [ -z "$DRY" ]; then
  command -v wg >/dev/null || { log "Instaluji wireguard-tools…"; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools >&2; }
  # Nový tunel nesmí sáhnout na port ani síť, které už na VPS někdo používá.
  if ! ip link show "$IFACE" >/dev/null 2>&1; then
    if ss -lun | grep -q ":$PORT "; then log "UDP port $PORT na VPS už někdo používá. Spusťte znovu s WG_PORT=<jiný port>."; exit 1; fi
    if ip -4 addr | grep -q "inet $NET\."; then log "Síť $NET.0/24 už na VPS je. Tunel by se s ní přetahoval o adresy."; exit 1; fi
  fi
  if [ "$REZIM" = linux ] && ip -4 route | grep -v "dev $IFACE" | grep -q "^$KAMERA "; then log "Na adresu $KAMERA už na VPS vede jiná cesta."; exit 1; fi
fi

umask 077
mkdir -p "$WG_DIR" "$MISTA"
[ -s "$WG_DIR/famicura-vps.key" ] || wg genkey > "$WG_DIR/famicura-vps.key"
VPS_PUB=$(wg pubkey < "$WG_DIR/famicura-vps.key")

# Tunel z doby jednoho místa: jeho [Peer] se stane místem 1, ať zařízení dál platí.
if [ -s "$WG_DIR/$IFACE.conf" ] && [ ! -s "$MISTA/1.peer" ]; then
  awk '/^\[Peer\]/{p=1} p' "$WG_DIR/$IFACE.conf" > "$MISTA/1.peer"
  if [ -s "$MISTA/1.peer" ]; then
    { cat "$WG_DIR/famicura-rezim" 2>/dev/null || echo linux; } > "$MISTA/1.rezim"
    grep -o '[0-9]\+\(\.[0-9]\+\)\{3\}/32' "$MISTA/1.peer" | grep -v "^$NET\." | head -1 | sed 's|/32||' > "$MISTA/1.kamera" || true
    log "Dosavadní tunel (jedno místo) převeden na místo 1."
  else rm -f "$MISTA/1.peer"; fi
fi

# Stejná kamera nemůže být na dvou místech: tunel by nevěděl, kam ji poslat.
for f in "$MISTA"/*.kamera; do
  [ -s "$f" ] || continue
  n=$(basename "$f" .kamera); [ "$n" = "$MISTO" ] && continue
  if [ "$(cat "$f")" = "$KAMERA" ] && [ "$REZIM" = linux ]; then log "Kameru $KAMERA už má místo $n. Druhé zařízení musí mít kameru na jiné adrese (v Mangu kameře zamkněte jinou IP, nebo Mangu dejte jinou síť, např. 192.168.9.1)."; exit 1; fi
done

# Klíč zařízení vzniká tady, aby se celé nastavení dalo udělat jedním příkazem.
# Soukromá část odchází jen v konfiguraci na stdout; na VPS nezůstává.
SITE_PRIV=$(wg genkey)
SITE_PUB=$(printf '%s' "$SITE_PRIV" | wg pubkey)

if [ "$REZIM" = windows ]; then
  POPIS="# Místo $MISTO: Windows server u kamery. Předává jen své porty 554 a 2020 na kameru $KAMERA;
# kameru ani nic jiného v síti VPS nevidí."
  ALLOWED="$ADRESA/32"
else
  POPIS="# Místo $MISTO: zařízení u kamery. Za ním je dosažitelná jen kamera $KAMERA
# (a i na ní jen RTSP – to hlídá brana.sh na zařízení)."
  ALLOWED="$ADRESA/32, $KAMERA/32"
fi
cat > "$MISTA/$MISTO.peer" <<PEER
[Peer]
$POPIS
PublicKey = $SITE_PUB
AllowedIPs = $ALLOWED
PEER
echo "$REZIM" > "$MISTA/$MISTO.rezim"
echo "$KAMERA" > "$MISTA/$MISTO.kamera"
# vps-kamera.sh podle toho ví, kam má go2rtc ke kameře chodit (soubor bez čísla = místo 1, starší skripty).
[ "$MISTO" = 1 ] && echo "$REZIM" > "$WG_DIR/famicura-rezim"

{
cat <<CONF
# Famicura Tapo – tunel k zařízením u kamer. Generuje deploy/wireguard-vps.sh,
# jedno místo = jeden [Peer] z famicura-mista/<N>.peer; ručně needitovat.
[Interface]
Address = $NET.1/24
ListenPort = $PORT
PrivateKey = $(cat "$WG_DIR/famicura-vps.key")
CONF
for f in $(ls "$MISTA" | grep '\.peer$' | sort -n); do echo; cat "$MISTA/$f"; done
} > "$WG_DIR/$IFACE.conf"

if [ -z "$DRY" ]; then
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow "$PORT/udp" >/dev/null && log "ufw: UDP $PORT otevřen."; fi
  systemctl enable "wg-quick@$IFACE" >/dev/null 2>&1
  systemctl restart "wg-quick@$IFACE"
  log "Tunel $IFACE na VPS běží (UDP $PORT), místo $MISTO má adresu $ADRESA. Čeká na zařízení u kamery."
fi

if [ "$REZIM" = windows ]; then
  INSTALACE="# Famicura Tapo – Windows server u kamery (místo $MISTO). Nainstaluje deploy/wireguard/u-kamery-windows.ps1."
else
  INSTALACE="# Famicura Tapo – zařízení u kamery (místo $MISTO). Nainstaluje deploy/wireguard/u-kamery.sh."
fi
cat <<CONF
$INSTALACE
# Obsahuje soukromý klíč: po instalaci soubor smažte.
# REZIM=$REZIM
# KAMERA=$KAMERA
# MISTO=$MISTO
[Interface]
Address = $ADRESA/32
PrivateKey = $SITE_PRIV

[Peer]
# VPS
PublicKey = $VPS_PUB
Endpoint = $VPS_IP:$PORT
AllowedIPs = $NET.1/32
PersistentKeepalive = 25
CONF
