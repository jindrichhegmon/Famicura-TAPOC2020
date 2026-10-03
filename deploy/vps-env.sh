#!/usr/bin/env bash
# Doplní tajné hodnoty do /opt/famicura-tapo/.env na VPS. Spouštět z Macu ve složce projektu:
#   ./deploy/vps-env.sh
#
# SQL_PASSWORD se převezme přímo na serveru z aplikace se stejným SQL
# serverem i uživatelem (clb1_app), takže nikudy necestuje. Heslo k databázi
# PeceDomaPlus (PDP_SQL_PASSWORD, login pecedomaplus_app) a token aplikačního
# serveru jhn-apps (JHN_APPS_TOKEN = FAMICURA_REPORTY_TOKEN) se vezmou z
# /opt/jhn-apps/.env na serveru; když tam nejsou, skript se zeptá. SESSION_KEY
# se na serveru vygeneruje. Na FAMICURA_PASSWORD (heslo správce) se skript
# zeptá; hodnota jde do ssh přes stdin, ne na příkazovou řádku, a v historii
# ani ve výpisu procesů se neobjeví.
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
DIR=/opt/famicura-tapo
PORT="${PORT:-3112}"
SQL_ZDROJ="${SQL_ZDROJ:-/opt/pecedoma-sestra/.env}"
JHN_ZDROJ="${JHN_ZDROJ:-/opt/jhn-apps/.env}"
SSH="ssh -i $KEY -o BatchMode=yes"
JAKO="su - jhnapps -c"

cd "$(dirname "$0")/.."
# Pomocník musí být na VPS i tehdy, když se od posledního nasazení změnil.
$SSH "$VPS" "mkdir -p $DIR/scripts $DIR/deploy && chown -R jhnapps:jhnapps $DIR"
rsync -az -e "$SSH" scripts/set-env.mjs "$VPS:$DIR/scripts/"
rsync -az -e "$SSH" deploy/prevezmi-jhn.sh "$VPS:$DIR/deploy/"
PREVEZMI="bash $DIR/deploy/prevezmi-jhn.sh"
rsync -az -e "$SSH" .env.example "$VPS:$DIR/"
$SSH "$VPS" "chown -R jhnapps:jhnapps $DIR && $JAKO 'cd $DIR && ( [ -f .env ] || cp .env.example .env ) && chmod 600 .env'"

echo "Před:"
$SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs stav'"
echo

$SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs prevezmi SQL_PASSWORD $SQL_ZDROJ'" || {
  echo "Heslo k SQL se převzít nepodařilo – zadejte ho ručně."
  read -rs -p "SQL_PASSWORD: " H; echo
  printf '%s' "$H" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav SQL_PASSWORD'"
  unset H
}

$SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs generuj SESSION_KEY'"

echo
echo "Databáze PeceDomaPlus (tenanti a data poskytovatelů, login pecedomaplus_app): heslo z $JHN_ZDROJ, jinak ručně."
# jhn-apps má spojení pojmenovaná DB_<NAZEV>_PASSWORD (nebo celé jako DB_<NAZEV>_URL); spojení PeceDomaPlus se jmenuje pecedomaplus.
# Soubor čte na serveru root (prevezmi-jhn.sh), hodnota jde rovnou do našeho .env a nikam necestuje.
if $SSH "$VPS" "$PREVEZMI PDP_SQL_PASSWORD '^DB_PECEDOMAPLUS_(PASSWORD|URL)\$|PECEDOMAPLUS.*(PASSWORD|HESLO)' $JHN_ZDROJ $DIR"; then
  # server, port, uživatel a databáze jen když je jhn-apps má zapsané (jinak zůstane SQL_SERVER / pecedomaplus_app / PeceDomaPlus)
  for K in SERVER PORT USER DATABASE; do
    $SSH "$VPS" "$PREVEZMI PDP_SQL_$K '^DB_PECEDOMAPLUS_($K|URL)\$' $JHN_ZDROJ $DIR" 2>/dev/null || true
  done
else
  echo "Heslo k PeceDomaPlus se v $JHN_ZDROJ nenašlo. Klíče, které tam jsou (jen názvy, bez hodnot):"
  $SSH "$VPS" "$PREVEZMI seznam '^DB_|TOKEN|PECEDOMA' $JHN_ZDROJ" 2>/dev/null | sed 's/^/   /' || echo "   (soubor nejde přečíst)"
  echo "Zadejte heslo ručně (login pecedomaplus_app, stejné jako má portál Péče doma plus; Enter = nechat, jak je)."
  read -rs -p "PDP_SQL_PASSWORD: " H; echo
  [ -n "$H" ] && printf '%s' "$H" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav PDP_SQL_PASSWORD'"
  unset H
fi

echo
echo "Přihlášení dispečera účtem Péče doma plus přes aplikační server jhn-apps: token z $JHN_ZDROJ (FAMICURA_REPORTY_TOKEN), jinak ručně."
if $SSH "$VPS" "$PREVEZMI JHN_APPS_TOKEN '^FAMICURA_REPORTY_TOKEN\$' $JHN_ZDROJ $DIR"; then :; else
  echo "Token se převzít nepodařilo – zadejte ho ručně (Enter = nechat, jak je)."
  read -rs -p "JHN_APPS_TOKEN: " H; echo
  [ -n "$H" ] && printf '%s' "$H" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav JHN_APPS_TOKEN'"
  unset H
fi

echo "Heslo správce serveru (hlavní aplikace, nouzový vstup do dispečinku bez účtu Péče doma plus)."
read -rs -p "FAMICURA_PASSWORD (Enter = nechat, jak je): " P; echo
if [ -n "$P" ]; then
  read -rs -p "Ještě jednou pro kontrolu: " P2; echo
  if [ "$P" != "$P2" ]; then echo "Hesla se neshodují, nic neměním."; unset P P2; exit 1; fi
  printf '%s' "$P" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav FAMICURA_PASSWORD'"
fi
unset P P2

echo
echo "SMS rodině (pozvánky, žádosti o obraz) přes webhook Make → Twilio (scénář Famicura_Tapo_SMS_Pozvanka). Enter = nechat, jak je."
read -r -p "SMS_WEBHOOK_URL (https://hook.eu2.make.com/…): " W
if [ -n "$W" ]; then
  [[ "$W" =~ ^https://[A-Za-z0-9./_-]+$ ]] || { echo "Adresa webhooku musí začínat https:// a být bez mezer."; exit 1; }
  printf '%s' "$W" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav SMS_WEBHOOK_URL'"
  read -rs -p "SMS_WEBHOOK_KLIC (klíč, který scénář kontroluje): " K; echo
  [ -n "$K" ] && printf '%s' "$K" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav SMS_WEBHOOK_KLIC'"
fi
unset W K

echo
echo "Asistent v dispečinku přes webhook Make s AI (volitelné; bez něj odpovídá z nápovědy). Enter = nechat, jak je."
read -r -p "ASISTENT_WEBHOOK_URL (https://hook.eu2.make.com/…): " W
if [ -n "$W" ]; then
  [[ "$W" =~ ^https://[A-Za-z0-9./_-]+$ ]] || { echo "Adresa webhooku musí začínat https:// a být bez mezer."; exit 1; }
  printf '%s' "$W" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav ASISTENT_WEBHOOK_URL'"
  read -rs -p "ASISTENT_WEBHOOK_KLIC (klíč, který scénář kontroluje): " K; echo
  [ -n "$K" ] && printf '%s' "$K" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav ASISTENT_WEBHOOK_KLIC'"
fi
unset W K

echo
echo "Po:"
$SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs stav'"

# server.mjs čte .env jen při startu.
$SSH "$VPS" "$JAKO 'cd $DIR && [ -f deploy/ecosystem.config.cjs ] && PORT=$PORT pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo \"Aplikace restartována.\" || echo \"Aplikace ještě není nasazená – spusťte ./deploy/vps-deploy.sh\"'"
sleep 4
echo "Kontrola serveru (tenanti = databáze PeceDomaPlus, dispecer = přihlášení účtem Péče doma plus):"
$SSH "$VPS" "curl -s http://127.0.0.1:$PORT/api/health" | tr ',' '\n' | grep -E '"(ok|tenanti|dispecer)"' | sed 's/^/   /'
echo "Poslední hlášky serveru o databázi:"
$SSH "$VPS" "$JAKO 'pm2 logs famicura-tapo --lines 60 --nostream 2>/dev/null | grep -i \"pdp\|PeceDomaPlus\|jhn-apps\" | tail -5'" | sed 's/^/   /'
