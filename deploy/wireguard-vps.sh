#!/usr/bin/env bash
# Tunel WireGuard mezi VPS a zařízením u kamery. Spouštět z Macu ve složce projektu:
#   ./deploy/wireguard-vps.sh <IP kamery v místní síti>
#
# Na VPS nastaví rozhraní wg-famicura (UDP 51821) a sem uloží
# famicura-wg-u-kamery.conf pro zařízení u kamery. Ten obsahuje soukromý
# klíč: po instalaci na zařízení ho smažte. Opakované spuštění vydá nový
# klíč zařízení – starý soubor pak přestane platit.
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
SSH="ssh -i $KEY -o BatchMode=yes"
IP="$1"
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Použití: $0 <IP kamery, např. 192.168.1.50>"; exit 1; }

cd "$(dirname "$0")/.."
OUT=famicura-wg-u-kamery.conf
umask 077
$SSH "$VPS" "bash -s -- $IP" < deploy/wireguard/vps-setup.sh > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

cat <<TEXT

Hotovo na straně VPS. Konfigurace pro zařízení u kamery: $PWD/$OUT

Na zařízení u kamery (Raspberry Pi / mini PC s Linuxem ve stejné síti jako kamera):
  scp $OUT deploy/wireguard/u-kamery.sh deploy/wireguard/brana.sh UZIVATEL@ZARIZENI:~/
  ssh UZIVATEL@ZARIZENI 'sudo ./u-kamery.sh $OUT brana.sh && rm $OUT'
  rm $OUT          # i tady na Macu

Ověření z VPS:
  $SSH $VPS "wg show wg-famicura && ping -c 2 $IP"
TEXT
