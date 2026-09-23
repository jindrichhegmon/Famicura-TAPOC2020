#!/usr/bin/env bash
# Instalace tunelu na zařízení u kamery (Raspberry Pi nebo mini PC s Linuxem,
# Debian/Ubuntu/Raspberry Pi OS). Spouštět na zařízení jako root:
#
#   sudo ./u-kamery.sh famicura-wg-u-kamery.conf brana.sh
#
# Zařízení musí být ve stejné síti jako kamera a stále zapnuté. Ven se
# připojuje samo (UDP na VPS), takže na routeru se nic neotevírá.
set -euo pipefail
CONF_IN="${1:-}"; BRANA_IN="${2:-$(dirname "$0")/brana.sh}"
IFACE=wg-famicura
WG_DIR="${WG_DIR:-/etc/wireguard}"
DRY="${DRY:-}"

[ -f "$CONF_IN" ] || { echo "Použití: sudo $0 <famicura-wg-u-kamery.conf> [brana.sh]"; exit 1; }
[ -f "$BRANA_IN" ] || { echo "Chybí brana.sh (je ve složce deploy/wireguard)."; exit 1; }
[ -n "$DRY" ] || [ "$(id -u)" = 0 ] || { echo "Spusťte přes sudo."; exit 1; }

# A config made for a Windows server has no NAT side; here it would half work.
grep -q '^# REZIM=windows' "$CONF_IN" && { echo "Tahle konfigurace je pro Windows server (u-kamery-windows.ps1)."; exit 1; }
KAMERA=$(sed -n 's/^# KAMERA=//p' "$CONF_IN")
[[ "$KAMERA" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "V konfiguraci chybí řádek # KAMERA=<IP>."; exit 1; }

if [ -z "$DRY" ]; then
  command -v wg >/dev/null && command -v iptables >/dev/null || {
    echo "Instaluji wireguard-tools a iptables…"; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools iptables; }
fi

# Kterým rozhraním je kamera vidět (eth0, wlan0…).
LAN_IF="${LAN_IF:-$(ip -o route get "$KAMERA" 2>/dev/null | grep -o 'dev [^ ]*' | cut -d' ' -f2)}"
[ -n "$LAN_IF" ] || { echo "Nevím, kterým rozhraním je vidět kamera $KAMERA."; exit 1; }
if [ -z "$DRY" ] && ! ping -c1 -W2 "$KAMERA" >/dev/null 2>&1; then
  echo "POZOR: kamera $KAMERA z tohoto zařízení neodpovídá na ping. Je ve stejné síti a zapnutá?"
fi

umask 077
mkdir -p "$WG_DIR"
sed -e "s/__KAMERA__/$KAMERA/" -e "s/__LAN_IF__/$LAN_IF/" "$BRANA_IN" > "$WG_DIR/famicura-brana.sh"
chmod 700 "$WG_DIR/famicura-brana.sh"
{
  sed -n '/^\[Interface\]/,$p' "$CONF_IN" | sed '/^\[Peer\]/,$d'
  echo "PostUp = $WG_DIR/famicura-brana.sh up %i"
  echo "PostDown = $WG_DIR/famicura-brana.sh down %i"
  echo
  sed -n '/^\[Peer\]/,$p' "$CONF_IN"
} > "$WG_DIR/$IFACE.conf"

if [ -z "$DRY" ]; then
  systemctl enable "wg-quick@$IFACE" >/dev/null 2>&1
  systemctl restart "wg-quick@$IFACE"
  sleep 3
  if ping -c2 -W2 10.77.0.1 >/dev/null 2>&1 || wg show "$IFACE" latest-handshakes | awk '{exit !($2>0)}'; then
    echo "Tunel na VPS běží (kamera $KAMERA přes $LAN_IF). Soubor $CONF_IN teď smažte – obsahuje soukromý klíč."
  else
    echo "Tunel je nastavený, ale VPS zatím neodpovídá. Zkontrolujte: wg show $IFACE"
  fi
fi
