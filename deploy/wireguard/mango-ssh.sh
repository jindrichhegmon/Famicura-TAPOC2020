#!/usr/bin/env bash
# Brána GL.iNet Mango přes SSH místo jeho webu: z famicura-mango*.conf (od
# ./deploy/wireguard-vps.sh) nastaví v Mangu tunel WireGuard k VPS a firewall,
# který z tunelu pustí jen kameru. Spouštět z Macu připojeného na Wi-Fi Manga:
#   ./deploy/wireguard/mango-ssh.sh famicura-mango-misto-3.conf 192.168.11.50 192.168.11.1
#   (soubor .conf, IP kamery v síti Manga, IP Manga – výchozí 192.168.8.1)
# Zeptá se na heslo správce Manga (to z jeho webu). Soukromý klíč jde jen
# tunelem SSH do Manga, nikde se nevypisuje; po úspěchu soubory .conf smažte.
#
# Nepoužívá klienta WireGuard z webu GL.iNet, ale obyčejné rozhraní OpenWrt
# „wgfam“ s vlastní zónou firewallu: nezávisí na nastavení Proxy Mode ani
# „Allow Remote Access LAN“ a přežije i reset klienta VPN ve webu. Spuštěno
# znovu vše přepíše (nový klíč po dalším wireguard-vps.sh, jiná IP kamery).
set -euo pipefail
CONF="${1:-}"; KAMERA="${2:-}"; MANGO="${3:-192.168.8.1}"
[ -n "$CONF" ] && [ -f "$CONF" ] || { echo "Použití: $0 <famicura-mango*.conf> <IP kamery v síti Manga> [IP Manga, výchozí 192.168.8.1]"; exit 1; }
[[ "$KAMERA" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Druhý parametr je IP kamery v síti Manga (např. 192.168.11.50)."; exit 1; }
[[ "$MANGO" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Třetí parametr je IP Manga (např. 192.168.11.1)."; exit 1; }

hodnota() { grep -i "^[[:space:]]*$1[[:space:]]*=" "$CONF" | head -1 | sed 's/^[^=]*=[[:space:]]*//' | tr -d '\r[:space:]'; }
PRIV=$(hodnota PrivateKey); ADDR=$(hodnota Address); PUB=$(hodnota PublicKey)
EP=$(hodnota Endpoint); ALLOWED=$(hodnota AllowedIPs); KEEP=$(hodnota PersistentKeepalive)
for v in PRIV ADDR PUB EP ALLOWED; do [ -n "${!v}" ] || { echo "V $CONF chybí položka pro $v (PrivateKey, Address, PublicKey, Endpoint, AllowedIPs)."; exit 1; }; done
EP_HOST="${EP%:*}"; EP_PORT="${EP##*:}"
[[ "$EP_PORT" =~ ^[0-9]+$ ]] || { echo "Endpoint v $CONF nemá port: $EP"; exit 1; }
KEEP="${KEEP:-25}"
ALLOWED_SEZNAM=$(echo "$ALLOWED" | tr ',' ' ')

echo "Mango $MANGO: tunel WireGuard k $EP (adresa $ADDR), z tunelu ke kameře $KAMERA. Heslo správce Manga:"
# Celé nastavení běží v Mangu z jednoho skriptu na vstupu ssh; heslo se ptá z terminálu, ne ze vstupu.
ssh -o StrictHostKeyChecking=accept-new "root@$MANGO" 'sh -s' <<REMOTE
set -e
command -v wg >/dev/null 2>&1 || { echo "V Mangu chybí nástroj wg (WireGuard) – firmware GL.iNet 4.x ho má; u staršího ho doinstalujte: opkg update; opkg install wireguard-tools"; exit 2; }
# síť: rozhraní wgfam (starší pokus pryč)
uci -q delete network.wgfam || true
while uci -q delete network.@wireguard_wgfam[0]; do :; done
uci set network.wgfam=interface
uci set network.wgfam.proto='wireguard'
uci set network.wgfam.private_key='$PRIV'
uci add_list network.wgfam.addresses='$ADDR'
uci set network.wgfam.mtu='1420'
uci add network wireguard_wgfam >/dev/null
uci set network.@wireguard_wgfam[-1].description='Famicura VPS'
uci set network.@wireguard_wgfam[-1].public_key='$PUB'
uci set network.@wireguard_wgfam[-1].endpoint_host='$EP_HOST'
uci set network.@wireguard_wgfam[-1].endpoint_port='$EP_PORT'
uci set network.@wireguard_wgfam[-1].persistent_keepalive='$KEEP'
uci set network.@wireguard_wgfam[-1].route_allowed_ips='1'
for a in $ALLOWED_SEZNAM; do uci add_list network.@wireguard_wgfam[-1].allowed_ips="\$a"; done
uci commit network
# firewall: zóna tunelu, provoz z tunelu jen ke kameře (starší sekce stejného jména pryč)
smaz() { while id=\$(uci show firewall 2>/dev/null | grep -E "^firewall\.@\$1\[[0-9]+\]\.name='\$2'\$" | head -1 | sed -E 's/^firewall\.(@[^.]+)\..*/\1/'); [ -n "\$id" ]; do uci delete "firewall.\$id"; done; }
smaz zone famicura_wgfam; smaz forwarding famicura_wgfam_lan; smaz rule 'Famicura kamera wgfam'
uci add firewall zone >/dev/null
uci set firewall.@zone[-1].name='famicura_wgfam'
uci add_list firewall.@zone[-1].network='wgfam'
uci set firewall.@zone[-1].input='ACCEPT'; uci set firewall.@zone[-1].output='ACCEPT'; uci set firewall.@zone[-1].forward='REJECT'; uci set firewall.@zone[-1].masq='0'
uci add firewall forwarding >/dev/null
uci set firewall.@forwarding[-1].name='famicura_wgfam_lan'; uci set firewall.@forwarding[-1].src='famicura_wgfam'; uci set firewall.@forwarding[-1].dest='lan'
uci add firewall rule >/dev/null
uci set firewall.@rule[-1].name='Famicura kamera wgfam'; uci set firewall.@rule[-1].src='famicura_wgfam'; uci set firewall.@rule[-1].dest='lan'; uci set firewall.@rule[-1].dest_ip='$KAMERA'; uci set firewall.@rule[-1].proto='all'; uci set firewall.@rule[-1].target='ACCEPT'
uci commit firewall
/etc/init.d/network reload >/dev/null 2>&1 || /etc/init.d/network restart
sleep 4
/etc/init.d/firewall restart >/dev/null 2>&1 || true
echo "--- stav tunelu v Mangu (wg show wgfam):"
wg show wgfam 2>/dev/null || { echo "rozhraní wgfam nenaběhlo"; ifstatus wgfam 2>/dev/null | head -20; exit 3; }
echo "--- ping na VPS tunelem (10.77.0.1):"
ping -c 2 -W 3 10.77.0.1 2>&1 | tail -2
REMOTE
cat <<TEXT

Hotovo. Když je výše „latest handshake“ a ping „2 packets received“, tunel stojí.
Dál (Mac zpět na internet):
  ./deploy/vps-kamera.sh          (místo podle tunelu, IP kamery $KAMERA)
  rm $CONF ${CONF/mango/wg}       (soubory mají soukromý klíč)
Ověření z VPS: ssh -i ~/.ssh/id_ed25519_jhnapps root@95.216.201.2 "ping -c 2 $KAMERA; nc -zv -w 5 $KAMERA 554"
Bez handshaku: Mango nemá internet (WAN kabel / Repeater), nebo je v Mangu zapnutý
klient VPN z webu GL.iNet se stejným klíčem – vypněte ho (VPN → WireGuard Client → Disconnect/Remove).
TEXT
