#!/usr/bin/env bash
# Běží na VPS jako root; volá ho deploy/wireguard-vps.sh přes ssh.
# Nastaví tunel wg-famicura a na stdout vypíše konfiguraci pro zařízení
# u kamery. Všechna hlášení jdou na stderr, aby do ní nic nepřimíchala.
#
#   bash vps-setup.sh <IP kamery> [linux|windows]
#
# linux:   zařízení u kamery (Raspberry Pi…) posílá provoz dál ke kameře,
#          VPS má do tunelu cestu i na IP kamery.
# windows: Windows server u kamery předává jen port 554 (netsh portproxy);
#          VPS se připojuje na server (10.77.0.2) a kameru samotnou nevidí.
# Pro zkoušku bez systému: DRY=1 WG_DIR=/tmp/wg bash vps-setup.sh 192.168.1.50 windows
set -euo pipefail
KAMERA="${1:-}"
REZIM="${2:-linux}"
IFACE=wg-famicura
WG_DIR="${WG_DIR:-/etc/wireguard}"
PORT="${WG_PORT:-51821}"
NET=10.77.0
VPS_IP="${PUBLIC_IP:-95.216.201.2}"
DRY="${DRY:-}"
log() { echo "$@" >&2; }

[[ "$KAMERA" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { log "Použití: $0 <IP kamery v místní síti> [linux|windows]"; exit 1; }
case "$REZIM" in linux|windows) ;; *) log "Režim musí být linux nebo windows."; exit 1 ;; esac

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
mkdir -p "$WG_DIR"
[ -s "$WG_DIR/famicura-vps.key" ] || wg genkey > "$WG_DIR/famicura-vps.key"
VPS_PUB=$(wg pubkey < "$WG_DIR/famicura-vps.key")
# Klíč zařízení vzniká tady, aby se celé nastavení dalo udělat jedním příkazem.
# Soukromá část odchází jen v konfiguraci na stdout; na VPS nezůstává.
SITE_PRIV=$(wg genkey)
SITE_PUB=$(printf '%s' "$SITE_PRIV" | wg pubkey)

if [ "$REZIM" = windows ]; then
  POPIS="# Windows server u kamery. Předává jen svůj port 554 na kameru $KAMERA;
# kameru ani nic jiného v síti VPS nevidí."
  ALLOWED="$NET.2/32"
else
  POPIS="# Zařízení u kamery. Za ním je dosažitelná jen kamera $KAMERA
# (a i na ní jen RTSP – to hlídá brana.sh na zařízení)."
  ALLOWED="$NET.2/32, $KAMERA/32"
fi

cat > "$WG_DIR/$IFACE.conf" <<CONF
# Famicura Tapo – tunel k zařízení u kamery. Generuje deploy/wireguard-vps.sh.
[Interface]
Address = $NET.1/24
ListenPort = $PORT
PrivateKey = $(cat "$WG_DIR/famicura-vps.key")

[Peer]
$POPIS
PublicKey = $SITE_PUB
AllowedIPs = $ALLOWED
CONF
# vps-kamera.sh podle toho ví, kam má go2rtc ke kameře chodit.
echo "$REZIM" > "$WG_DIR/famicura-rezim"

if [ -z "$DRY" ]; then
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow "$PORT/udp" >/dev/null && log "ufw: UDP $PORT otevřen."; fi
  systemctl enable "wg-quick@$IFACE" >/dev/null 2>&1
  systemctl restart "wg-quick@$IFACE"
  log "Tunel $IFACE na VPS běží (UDP $PORT). Čeká na zařízení u kamery."
fi

if [ "$REZIM" = windows ]; then
  INSTALACE="# Famicura Tapo – Windows server u kamery. Nainstaluje deploy/wireguard/u-kamery-windows.ps1."
else
  INSTALACE="# Famicura Tapo – zařízení u kamery. Nainstaluje deploy/wireguard/u-kamery.sh."
fi
cat <<CONF
$INSTALACE
# Obsahuje soukromý klíč: po instalaci soubor smažte.
# REZIM=$REZIM
# KAMERA=$KAMERA
[Interface]
Address = $NET.2/32
PrivateKey = $SITE_PRIV

[Peer]
# VPS
PublicKey = $VPS_PUB
Endpoint = $VPS_IP:$PORT
AllowedIPs = $NET.1/32
PersistentKeepalive = 25
CONF
