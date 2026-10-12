#!/usr/bin/env bash
# Klíč Apple pro tiché notifikace (APNs) na VPS: server jím každých 15 minut probouzí aplikaci
# PéčeDoma Prsten na iPhonech klientů (stáhne z prstenu tep a kroky). Spouštět z Macu ve složce projektu:
#   ./deploy/vps-apns.sh                       → vezme nejnovější ~/Downloads/AuthKey_*.p8
#   ./deploy/vps-apns.sh ~/Downloads/AuthKey_ABCDE12345.p8
#
# Klíč (.p8) jde na server přes stdin rovnou do /opt/famicura-tapo/data/apns-klic.p8 (práva 600,
# složka data/ se nenasazuje ani necommituje). Na příkazovou řádku, do gitu ani do chatu se nedostane.
# Key ID se vezme z názvu souboru, Team ID je 433U5VUWE2 (TEAM_ID=… pro jiný účet).
set -euo pipefail
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
DIR=/opt/famicura-tapo
PORT="${PORT:-3112}"
TEAM_ID="${TEAM_ID:-433U5VUWE2}"
TOPIC="${TOPIC:-cz.pecedoma.prsten}"
SSH="ssh -i $KEY -o BatchMode=yes"
JAKO="su - jhnapps -c"
cd "$(dirname "$0")/.."

SOUBOR="${1:-}"
if [ -z "$SOUBOR" ]; then SOUBOR=$(ls -t "$HOME"/Downloads/AuthKey_*.p8 2>/dev/null | head -1 || true); fi
if [ -z "$SOUBOR" ] || [ ! -f "$SOUBOR" ]; then
  echo "Klíč .p8 nenalezen. Stáhněte ho na developer.apple.com → Certificates, IDs & Profiles → Keys"
  echo "(Apple Push Notifications service) do složky Stažené soubory, nebo zadejte cestu: ./deploy/vps-apns.sh ~/cesta/AuthKey_XXXXXXXXXX.p8"
  exit 1
fi
grep -q "BEGIN PRIVATE KEY" "$SOUBOR" || { echo "Soubor $SOUBOR není klíč .p8 (chybí BEGIN PRIVATE KEY)."; exit 1; }
KEY_ID=$(basename "$SOUBOR" | sed -n 's/^AuthKey_\([A-Z0-9]\{10\}\)\.p8$/\1/p')
if [ -z "$KEY_ID" ]; then read -r -p "Key ID klíče (10 znaků z developer.apple.com → Keys): " KEY_ID; fi
[[ "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "Key ID musí mít 10 znaků (A–Z, 0–9)."; exit 1; }
echo "Klíč: $(basename "$SOUBOR") · Key ID $KEY_ID · Team ID $TEAM_ID · aplikace $TOPIC"

echo "== 1/3 Klíč na server (data/apns-klic.p8, práva 600)"
$SSH "$VPS" "mkdir -p $DIR/data $DIR/scripts && chown jhnapps:jhnapps $DIR/data && umask 077 && cat > $DIR/data/apns-klic.p8 && chown jhnapps:jhnapps $DIR/data/apns-klic.p8 && chmod 600 $DIR/data/apns-klic.p8" < "$SOUBOR"
rsync -az -e "$SSH" scripts/set-env.mjs "$VPS:$DIR/scripts/"
$SSH "$VPS" "chown -R jhnapps:jhnapps $DIR/scripts"

echo "== 2/3 Nastavení v .env"
printf '%s' "$KEY_ID" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav APNS_KEY_ID'"
printf '%s' "$TEAM_ID" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav APNS_TEAM_ID'"
printf '%s' "$TOPIC" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav APNS_TOPIC'"

echo "== 3/3 Restart serveru"
$SSH "$VPS" "$JAKO 'cd $DIR && PORT=$PORT pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo Aplikace restartována.'"
sleep 5
echo "Hlášky serveru o probouzení (čekejte řádek „probouzení aplikace Prsten každých 15 min“):"
$SSH "$VPS" "$JAKO 'pm2 logs famicura-tapo --lines 80 --nostream 2>/dev/null | grep -i apns | tail -4'" | sed 's/^/   /'
echo
echo "Hotovo. Soubor $(basename "$SOUBOR") si uschovejte (Apple ho stáhnout znovu nedovolí), ale nikomu ho neposílejte."
