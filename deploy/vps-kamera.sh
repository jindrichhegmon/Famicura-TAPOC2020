#!/usr/bin/env bash
# Přidá nebo změní kameru Tapo na VPS. Spouštět z Macu ve složce projektu:
#   ./deploy/vps-kamera.sh            (zeptá se na údaje)
#   ./deploy/vps-kamera.sh seznam     (kamery bez hesel)
#   ./deploy/vps-kamera.sh smaz ID
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

case "$1" in
  seznam) $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs seznam'"; exit 0 ;;
  smaz)   platne_id "$2"
          $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs smaz $2'"; restart; exit 0 ;;
esac

read -r -p "ID kamery [tapoc2020]: " ID;            ID="${ID:-tapoc2020}"; platne_id "$ID"
read -r -p "Název v aplikaci [Tapo C2020]: " NAZEV;  NAZEV="${NAZEV:-Tapo C2020}"
read -r -p "IP adresa kamery v místní síti: " IP
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "IP adresa musí vypadat jako 192.168.1.50."; exit 1; }
read -r -p "Uživatel účtu kamery: " UZIV
read -rs -p "Heslo účtu kamery: " HESLO; echo
read -r -p "Kvalita – 1 = plné rozlišení, 2 = nízké [1]: " Q
[ "$Q" = "2" ] && STREAM=stream2 || STREAM=stream1

# JSON skládá node z proměnných prostředí: heslo s uvozovkou nebo lomítkem
# tak nerozbije ani JSON, ani příkaz – a do ssh jde přes stdin.
ID="$ID" NAZEV="$NAZEV" IP="$IP" UZIV="$UZIV" HESLO="$HESLO" STREAM="$STREAM" node -e '
  const e = process.env;
  process.stdout.write(JSON.stringify({ id: e.ID, name: e.NAZEV, ip: e.IP, user: e.UZIV, pass: e.HESLO, stream: e.STREAM }));
' | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-camera.mjs nastav'"
unset HESLO

restart
echo "Zkouším, jestli kamera posílá obraz (až 15 s)…"
sleep 2
KOD=$($SSH "$VPS" "curl -s -o /dev/null -m 15 -w '%{http_code}' 'http://127.0.0.1:1984/api/stream.mp4?src=$ID'" || true)
if [ "$KOD" = "200" ]; then
  echo "Kamera $ID posílá obraz. Otevřete https://famicuratapo.95-216-201-2.sslip.io"
else
  echo "Kamera $ID neodpovídá (go2rtc vrátil ${KOD:-nic}). Zkontrolujte:"
  echo "  tunel:  ssh -i $KEY $VPS \"wg show wg-famicura && ping -c 2 $IP\""
  echo "  go2rtc: ssh -i $KEY $VPS \"su - jhnapps -c 'pm2 logs famicura-go2rtc --lines 20 --nostream'\""
  echo "  a v aplikaci Tapo, že účet kamery a heslo sedí."
  exit 1
fi
