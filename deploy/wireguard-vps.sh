#!/usr/bin/env bash
# Tunel WireGuard mezi VPS a zařízením u kamery. Spouštět z Macu ve složce projektu:
#   ./deploy/wireguard-vps.sh <IP kamery v místní síti> --windows   (Windows server u kamery)
#   ./deploy/wireguard-vps.sh <IP kamery v místní síti>             (Raspberry Pi / Linux)
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
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Použití: $0 <IP kamery, např. 192.168.1.50> [--windows]"; exit 1; }
REZIM=linux
[ "$2" = "--windows" ] && REZIM=windows

cd "$(dirname "$0")/.."
OUT=famicura-wg-u-kamery.conf
umask 077
$SSH "$VPS" "bash -s -- $IP $REZIM" < deploy/wireguard/vps-setup.sh > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

if [ "$REZIM" = windows ]; then
BS='\'        # Windows path separator; typed into the heredoc it would escape the next character
cat <<TEXT

Hotovo na straně VPS. Konfigurace pro Windows server: $PWD/$OUT

Na Windows serveru (ve stejné síti jako kamera):
  1. Nainstalujte WireGuard pro Windows: https://www.wireguard.com/install/
  2. Zkopírujte na server tyto dva soubory (např. přes vzdálenou plochu):
       $OUT
       deploy/wireguard/u-kamery-windows.ps1
  3. Otevřete PowerShell jako správce, přejděte do složky s nimi a spusťte:
       Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
       .${BS}u-kamery-windows.ps1 -Konfigurace .${BS}$OUT
  4. Soubor $OUT pak smažte na serveru i tady:  rm $OUT

Ověření z VPS:
  $SSH $VPS "wg show wg-famicura && ping -c 2 10.77.0.2"
TEXT
exit 0
fi

# GL.iNet odmítne konfiguraci s řádky „#“; pro Mango jde stejný obsah bez nich.
MANGO=famicura-mango.conf
grep -v '^#' "$OUT" > "$MANGO"
cat <<TEXT

Hotovo na straně VPS. Konfigurace pro zařízení u kamery: $PWD/$OUT
Totéž bez poznámek pro GL.iNet Mango: $PWD/$MANGO

Brána GL.iNet Mango (kamera na Wi-Fi Manga): v http://192.168.8.1 → VPN → WireGuard Client
→ skupina → Add Manually: vložte obsah $MANGO (do schránky: cat $MANGO | pbcopy), Apply, Connect;
VPN Dashboard → ozubené kolo → Proxy Mode „Based on the Target Domain or IP“ (10.77.0.1), „Allow Remote Access LAN“ zapnout.
Firewall Manga (Mac na Wi-Fi Manga, heslo správce Manga) – bez toho VPS kameru nevidí:
  ssh root@192.168.8.1 "uci add firewall forwarding; uci set firewall.@forwarding[-1].src='wgclient'; uci set firewall.@forwarding[-1].dest='lan'; uci add firewall rule; uci set firewall.@rule[-1].name='Famicura kamera'; uci set firewall.@rule[-1].src='wgclient'; uci set firewall.@rule[-1].dest='lan'; uci set firewall.@rule[-1].dest_ip='$IP'; uci set firewall.@rule[-1].proto='all'; uci set firewall.@rule[-1].target='ACCEPT'; uci commit firewall; /etc/init.d/firewall restart"
Pak:  rm $OUT $MANGO   (soubory mají soukromý klíč)

Raspberry Pi / mini PC s Linuxem ve stejné síti jako kamera:
  scp $OUT deploy/wireguard/u-kamery.sh deploy/wireguard/brana.sh UZIVATEL@ZARIZENI:~/
  ssh UZIVATEL@ZARIZENI 'sudo ./u-kamery.sh $OUT brana.sh && rm $OUT'
  rm $OUT          # i tady na Macu

Ověření z VPS:
  $SSH $VPS "wg show wg-famicura && ping -c 2 $IP"
TEXT
