#!/bin/sh
# Brána na zařízení u kamery: z tunelu jen na RTSP kamery (TCP 554) a ping,
# nikam jinam v místní síti a na zařízení samotné také ne.
#
# Volá ho wg-quick (PostUp/PostDown) jako:  brana.sh up|down <rozhraní>
# KAMERA a LAN_IF doplní wireguard-u-kamery.sh při instalaci.
set -e
KAMERA="${KAMERA:-__KAMERA__}"
LAN_IF="${LAN_IF:-__LAN_IF__}"
VPS_T=10.77.0.1              # VPS na konci tunelu
CH=FAMICURA-WG
ACT="$1"; WG="$2"

pravidla() {   # $1 = -A (přidat) nebo -D (odebrat) – jen pro NAT
  iptables -t nat "$1" POSTROUTING -o "$LAN_IF" -s "$VPS_T" -d "$KAMERA" -j MASQUERADE
}

case "$ACT" in
  up)
    sysctl -qw net.ipv4.ip_forward=1
    iptables -N "$CH" 2>/dev/null || iptables -F "$CH"
    iptables -A "$CH" -i "$WG" -o "$LAN_IF" -s "$VPS_T" -d "$KAMERA" -p tcp --dport 554 -j ACCEPT
    iptables -A "$CH" -i "$WG" -o "$LAN_IF" -s "$VPS_T" -d "$KAMERA" -p icmp -j ACCEPT
    iptables -A "$CH" -i "$LAN_IF" -o "$WG" -s "$KAMERA" -d "$VPS_T" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -A "$CH" -j DROP
    # První v řetězci FORWARD, aby žádné dřívější "povol vše" nemělo přednost.
    iptables -I FORWARD 1 -i "$WG" -j "$CH"
    iptables -I FORWARD 1 -o "$WG" -j "$CH"
    # Na zařízení samotné z tunelu nic (ani SSH), jen odpovědi.
    iptables -I INPUT 1 -i "$WG" -j DROP
    iptables -I INPUT 1 -i "$WG" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Kamera odpovídá svému routeru, ne tunelu: odpovědi musí jít zpět přes toto zařízení.
    pravidla -A
    ;;
  down)
    iptables -D FORWARD -i "$WG" -j "$CH" 2>/dev/null || true
    iptables -D FORWARD -o "$WG" -j "$CH" 2>/dev/null || true
    iptables -D INPUT -i "$WG" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    iptables -D INPUT -i "$WG" -j DROP 2>/dev/null || true
    iptables -F "$CH" 2>/dev/null || true
    iptables -X "$CH" 2>/dev/null || true
    pravidla -D 2>/dev/null || true
    ;;
  *) echo "Použití: $0 up|down <rozhraní>" >&2; exit 1 ;;
esac
