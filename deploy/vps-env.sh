#!/usr/bin/env bash
# Doplní tajné hodnoty do /opt/famicura-tapo/.env na VPS. Spouštět z Macu ve složce projektu:
#   ./deploy/vps-env.sh
#
# SQL_PASSWORD se převezme přímo na serveru z aplikace se stejným SQL
# serverem i uživatelem (clb1_app), takže nikudy necestuje. SESSION_KEY se
# na serveru vygeneruje. Na FAMICURA_PASSWORD (heslo do aplikace) se skript
# zeptá; hodnota jde do ssh přes stdin, ne na příkazovou řádku, a v historii
# ani ve výpisu procesů se neobjeví.
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
DIR=/opt/famicura-tapo
PORT="${PORT:-3112}"
SQL_ZDROJ="${SQL_ZDROJ:-/opt/pecedoma-sestra/.env}"
SSH="ssh -i $KEY -o BatchMode=yes"
JAKO="su - jhnapps -c"

cd "$(dirname "$0")/.."
# Pomocník musí být na VPS i tehdy, když se od posledního nasazení změnil.
$SSH "$VPS" "mkdir -p $DIR/scripts && chown -R jhnapps:jhnapps $DIR"
rsync -az -e "$SSH" scripts/set-env.mjs "$VPS:$DIR/scripts/"
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

echo "Heslo, kterým se budete přihlašovat do aplikace Famicura Tapo."
read -rs -p "FAMICURA_PASSWORD (Enter = nechat, jak je): " P; echo
if [ -n "$P" ]; then
  read -rs -p "Ještě jednou pro kontrolu: " P2; echo
  if [ "$P" != "$P2" ]; then echo "Hesla se neshodují, nic neměním."; unset P P2; exit 1; fi
  printf '%s' "$P" | $SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs nastav FAMICURA_PASSWORD'"
fi
unset P P2

echo
echo "Po:"
$SSH "$VPS" "$JAKO 'cd $DIR && node scripts/set-env.mjs stav'"

# server.mjs čte .env jen při startu.
$SSH "$VPS" "$JAKO 'cd $DIR && [ -f deploy/ecosystem.config.cjs ] && PORT=$PORT pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo \"Aplikace restartována.\" || echo \"Aplikace ještě není nasazená – spusťte ./deploy/vps-deploy.sh\"'"
