#!/usr/bin/env bash
# Běží na VPS jako root; volá ho deploy/wireguard-vps.sh <IP> --misto N --dalsi přes ssh.
# Další kamera za stejnou bránou (Mango, Raspberry Pi): tunel na VPS pustí i její
# adresu – přidá ji do AllowedIPs u [Peer] toho místa a do cest. Klíče místa se
# nemění, zařízení u kamery se nepřenastavuje (jen Mango potřebuje pravidlo
# firewallu pro novou adresu, to vypíše wireguard-vps.sh).
#
#   bash vps-dalsi-kamera.sh <IP kamery> [místo]
# Pro zkoušku bez systému: DRY=1 WG_DIR=/tmp/wg bash vps-dalsi-kamera.sh 192.168.8.224 1
set -euo pipefail
KAMERA="${1:-}"
MISTO="${2:-1}"
IFACE=wg-famicura
WG_DIR="${WG_DIR:-/etc/wireguard}"
MISTA="$WG_DIR/famicura-mista"
DRY="${DRY:-}"
log() { echo "$@" >&2; }

[[ "$KAMERA" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { log "Použití: $0 <IP kamery v místní síti> [místo]"; exit 1; }
[[ "$MISTO" =~ ^[0-9]+$ ]] && [ "$MISTO" -ge 1 ] && [ "$MISTO" -le 200 ] || { log "Místo je číslo 1 až 200."; exit 1; }
PEER="$MISTA/$MISTO.peer"
[ -s "$PEER" ] || { log "Místo $MISTO na VPS není (./deploy/wireguard-vps.sh <IP kamery> --misto $MISTO ho založí)."; exit 1; }
REZIM=$(cat "$MISTA/$MISTO.rezim" 2>/dev/null || echo linux)
[ "$REZIM" = linux ] || { log "Místo $MISTO je Windows server: ten předává jen jednu kameru (porty 554 a 2020). Další kamera potřebuje vlastní místo (--misto N bez --dalsi)."; exit 1; }

# Stejná kamera nemůže být na dvou místech: tunel by nevěděl, kam ji poslat.
for f in "$MISTA"/*.kamera; do
  [ -s "$f" ] || continue
  n=$(basename "$f" .kamera)
  if grep -qw "$KAMERA" "$f"; then
    if [ "$n" = "$MISTO" ]; then log "Kamera $KAMERA už v tunelu místa $MISTO je; nic neměním."; exit 0; fi
    log "Kameru $KAMERA už má místo $n. Na dalším místě musí mít kamera jinou adresu (v Mangu jí zamkněte jinou IP)."; exit 1
  fi
done
if [ -z "$DRY" ] && ip -4 route | grep -v "dev $IFACE" | grep -q "^$KAMERA "; then log "Na adresu $KAMERA už na VPS vede jiná cesta."; exit 1; fi

umask 077
# [Peer] místa: adresa kamery do AllowedIPs a do poznámky; seznam kamer místa (mezerou) pro vps-kamera.sh.
sed -i "s|^AllowedIPs = .*|&, $KAMERA/32|" "$PEER"
sed -i "s|dosažitelná jen kamera \(.*\)$|dosažitelná jen kamera \1, $KAMERA|" "$PEER"
STARE=$(cat "$MISTA/$MISTO.kamera" 2>/dev/null || true)   # napřed přečíst, přesměrování by soubor zkrátilo dřív
echo "$STARE $KAMERA" | xargs > "$MISTA/$MISTO.kamera"

# Celý wg-famicura.conf znovu: [Interface] zůstává, [Peer] ze všech míst.
{
  awk '/^\[Peer\]/{exit} NF{print}' "$WG_DIR/$IFACE.conf"
  for f in $(ls "$MISTA" | grep '\.peer$' | sort -n); do echo; grep -v '^$' "$MISTA/$f"; done
} > "$WG_DIR/$IFACE.conf.tmp"
mv "$WG_DIR/$IFACE.conf.tmp" "$WG_DIR/$IFACE.conf"

if [ -z "$DRY" ]; then
  # Běžící tunel bez restartu (ostatní místa nepřeruší): nové AllowedIPs peeru a cesta na kameru.
  PUB=$(awk -F' = ' '/^PublicKey/{print $2}' "$PEER")
  ALLOWED=$(awk -F' = ' '/^AllowedIPs/{print $2}' "$PEER" | tr -d ' ')
  wg set "$IFACE" peer "$PUB" allowed-ips "$ALLOWED"
  ip route replace "$KAMERA/32" dev "$IFACE"
fi
log "Tunel místa $MISTO pustí i kameru $KAMERA (kamery místa: $(cat "$MISTA/$MISTO.kamera"))."
