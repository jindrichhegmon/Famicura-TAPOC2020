#!/usr/bin/env bash
# Přidá nebo změní kameru Tapo na VPS. Spouštět z Macu ve složce projektu
# (totéž umí od 3.42 hlavní aplikace, karta Správa kamer – bez Terminálu a bez restartu):
#   ./deploy/vps-kamera.sh            (zeptá se na údaje)
#   ./deploy/vps-kamera.sh seznam     (kamery bez hesel)
#   ./deploy/vps-kamera.sh smaz ID
#   ./deploy/vps-kamera.sh tenant ID_KAMERY ID_TENANTA [místo]   (kameru přiřadí poskytovateli z Péče doma plus)
#   ./deploy/vps-kamera.sh svetlo ID        (heslo účtu TP-Link pro světlo kamery, když účet kamery nestačí; Enter = smazat)
#
# Kam go2rtc na kameru chodí, pozná z místa (brány) na VPS – /etc/wireguard/famicura-mista/<N>.rezim,
# u jediného místa /etc/wireguard/famicura-rezim; víc míst = skript se zeptá na číslo místa:
#   linux    přímo na IP kamery tunelem WireGuard
#   windows  na Windows server v tunelu (10.77.0.(místo+1)), ten porty předává kameře
#   ssh      na 127.0.0.1:10554 a :12020, kam kameru přivedl Windows server tunelem SSH
#            (deploy/ssh-tunel-vps.sh); přepínač --ssh to vynutí i bez toho souboru
#
# Účet kamery založíte v aplikaci Tapo: kamera → Nastavení → Pokročilá
# nastavení → Účet kamery. IP adresu kamery si v routeru zarezervujte, aby
# se neměnila – jinak ji tunel a go2rtc přestanou nacházet.
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
DIR=/opt/famicura-tapo
PORT="${PORT:-3112}"
SSH="ssh -i $KEY -o BatchMode=yes"
JAKO="su - jhnapps -c"

cd "$(dirname "$0")/.."
rsync -az -e "$SSH" scripts/set-camera.mjs scripts/set-env.mjs "$VPS:$DIR/scripts/"
rsync -az -e "$SSH" src/kamery.mjs "$VPS:$DIR/src/"
$SSH "$VPS" "chown -R jhnapps:jhnapps $DIR"

# ID a IP jdou do příkazů na serveru: jen tvary, které server stejně přijme.
platne_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,39}$ ]] || { echo "ID kamery: malá písmena, číslice, - a _."; exit 1; }; }

restart() {
  $SSH "$VPS" "$JAKO 'cd $DIR && PORT=$PORT pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null'"
}

VYNUTIT_SSH=
[ "$1" = "--ssh" ] && { VYNUTIT_SSH=1; shift; }
case "$1" in
  seznam) $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs seznam'"; exit 0 ;;
  smaz)   platne_id "$2"
          $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs smaz $2'"; restart; exit 0 ;;
  tenant) platne_id "$2"; [[ "$3" =~ ^[A-Za-z0-9]{4,16}$ ]] || { echo "Použití: $0 tenant ID_KAMERY ID_TENANTA [místo]"; exit 1; }
          $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs tenant $2 $3 ${4:-}'"; restart; exit 0 ;;
  svetlo) platne_id "$2"
          # Světlo kamery jde přes místní rozhraní Tapo; když kameru účet kamery na něj nepustí, je potřeba „admin“
          # s heslem účtu TP-Link (e-mail a heslo z aplikace Tapo). Heslo jde přes stdin do ssh, ne na příkazovou řádku.
          read -rs -p "Heslo účtu TP-Link (aplikace Tapo; Enter = odebrat): " TAPO_HESLO; echo
          TAPO_HESLO="$TAPO_HESLO" node -e 'process.stdout.write(JSON.stringify({ user: "admin", pass: process.env.TAPO_HESLO }))' | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs svetlo $2'"
          unset TAPO_HESLO; restart; exit 0 ;;
esac

read -r -p "ID kamery [tapoc2020]: " ID;            ID="${ID:-tapoc2020}"; platne_id "$ID"
read -r -p "Název v aplikaci [Tapo C2020]: " NAZEV;  NAZEV="${NAZEV:-Tapo C2020}"
# Přes Windows server go2rtc nechodí na kameru, ale na server v tunelu:
# ten předává svůj port 554 kameře (u-kamery-windows.ps1).
# Místa (brány) na VPS: "1 linux 192.168.8.211" na řádek; více míst = otázka, které to je.
MISTA=$($SSH "$VPS" 'for f in /etc/wireguard/famicura-mista/*.rezim; do [ -s "$f" ] || continue; n=$(basename "$f" .rezim); echo "$n $(cat "$f") $(cat /etc/wireguard/famicura-mista/$n.kamera 2>/dev/null)"; done' 2>/dev/null || true)
MISTO=1
if [ "$(echo "$MISTA" | grep -c .)" -gt 1 ]; then
  echo "Místa (brány) na VPS – číslo, režim, kamera, kterou tunel zná:"; echo "$MISTA" | sed 's/^/   /'
  read -r -p "Místo, kde kamera je [1]: " MISTO; MISTO="${MISTO:-1}"
  [[ "$MISTO" =~ ^[0-9]+$ ]] && echo "$MISTA" | grep -q "^$MISTO " || { echo "Takové místo na VPS není (./deploy/wireguard-vps.sh <IP kamery> --misto $MISTO ho založí)."; exit 1; }
fi
REZIM=$(echo "$MISTA" | awk -v m="$MISTO" '$1 == m { print $2 }')
[ -n "$REZIM" ] || REZIM=$($SSH "$VPS" "cat /etc/wireguard/famicura-rezim 2>/dev/null" || true)
[ -n "$VYNUTIT_SSH" ] && REZIM=ssh
RTSP_PORT=554; ONVIF_PORT=2020
if [ "$REZIM" = ssh ]; then
  IP=127.0.0.1; RTSP_PORT=10554; ONVIF_PORT=12020
  echo "Kameru přivádí Windows server tunelem SSH – obraz půjde z $IP:$RTSP_PORT, události z :$ONVIF_PORT. IP kamery zná server."
elif [ "$REZIM" = windows ]; then
  IP="10.77.0.$((MISTO + 1))"
  echo "Kamera je za Windows serverem (místo $MISTO) – obraz půjde přes něj ($IP). IP kamery zná server."
else
  read -r -p "IP adresa kamery v místní síti: " IP
  [[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "IP adresa musí vypadat jako 192.168.1.50."; exit 1; }
fi
read -r -p "ID tenanta – poskytovatele z Péče doma plus (např. 22202480FAMICURA; Enter = zatím bez): " TENANT
[ -z "$TENANT" ] || [[ "$TENANT" =~ ^[A-Za-z0-9]{4,16}$ ]] || { echo "ID tenanta je 4 až 16 písmen a číslic."; exit 1; }
read -r -p "Místo kamery (např. Byt 7, Kladno; Enter = nic): " MISTO
read -r -p "Uživatel účtu kamery: " UZIV
read -rs -p "Heslo účtu kamery: " HESLO; echo
read -r -p "Kvalita – 1 = plné rozlišení, 2 = nízké [1]: " Q
[ "$Q" = "2" ] && STREAM=stream2 || STREAM=stream1

# JSON skládá node z proměnných prostředí: heslo s uvozovkou nebo lomítkem
# tak nerozbije ani JSON, ani příkaz – a do ssh jde přes stdin.
ID="$ID" NAZEV="$NAZEV" IP="$IP" UZIV="$UZIV" HESLO="$HESLO" STREAM="$STREAM" RTSP_PORT="$RTSP_PORT" ONVIF_PORT="$ONVIF_PORT" TENANT="$TENANT" MISTO="$MISTO" node -e '
  const e = process.env;
  process.stdout.write(JSON.stringify({ id: e.ID, name: e.NAZEV, ip: e.IP, user: e.UZIV, pass: e.HESLO, stream: e.STREAM,
    rtspPort: Number(e.RTSP_PORT), onvifPort: Number(e.ONVIF_PORT), tenant: e.TENANT, place: e.MISTO }));
' | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs nastav'"
unset HESLO

restart
echo "Zkouším, jestli kamera posílá obraz (až 15 s)…"
sleep 2
KOD=$($SSH "$VPS" "curl -s -o /dev/null -m 15 -w '%{http_code}' 'http://127.0.0.1:1984/api/stream.mp4?src=$ID'" || true)
if [ "$KOD" = "200" ]; then
  echo "Kamera $ID posílá obraz. Otevřete https://famicuratapo.95-216-201-2.sslip.io"
  echo "Události, které kamera hlásí sama (port 2020), uvidíte v Diagnostice do půl minuty."
else
  echo "Kamera $ID neodpovídá (go2rtc vrátil ${KOD:-nic}). Zkontrolujte:"
  if [ "$REZIM" = ssh ]; then
    echo "  tunel:  ./deploy/ssh-tunel-vps.sh stav   a na Windows serveru .\\u-kamery-windows-ssh.ps1 -Stav"
  else
    echo "  tunel:  ssh -i $KEY $VPS \"wg show wg-famicura && ping -c 2 $IP\""
  fi
  echo "  go2rtc: ssh -i $KEY $VPS \"su - jhnapps -c 'pm2 logs famicura-go2rtc --lines 20 --nostream'\""
  [ "$REZIM" = windows ] && echo "  Windows server: PowerShell jako správce → netsh interface portproxy show v4tov4"
  echo "  a v aplikaci Tapo, že účet kamery a heslo sedí."
  exit 1
fi
