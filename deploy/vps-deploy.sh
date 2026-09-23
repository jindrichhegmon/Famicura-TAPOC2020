#!/usr/bin/env bash
# Nasazení / aktualizace Famicura Tapo na VPS (spouštět z Macu ve složce projektu):  ./deploy/vps-deploy.sh
#
# Nahraje aplikaci do /opt/famicura-tapo, stáhne go2rtc (s kontrolou součtu),
# otevře port 8555 pro obraz a spustí obojí pod pm2 jako jhnapps.
# Stav na serveru nepřepisuje: .env, cameras.json, go2rtc.yaml ani data/.
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
DIR=/opt/famicura-tapo
PORT="${PORT:-3112}"
WEBRTC_PORT=8555
VEREJNA="${VEREJNA:-https://famicuratapo.95-216-201-2.sslip.io}"
SSH="ssh -i $KEY -o BatchMode=yes"

# go2rtc: pevná verze, se kterou je aplikace vyzkoušená, a její SHA-256.
GO2RTC_VER=1.9.14
GO2RTC_SHA=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6

# Porty si smí držet jen tahle aplikace. Porovnává se PID, ne jméno procesu –
# ss ho zkracuje na 15 znaků.
hlidej_port() {  # port proto pm2-jmeno
  local P
  P=$($SSH "$VPS" "ss -l${2}np 2>/dev/null | grep ':$1 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2" || true)
  [ -z "$P" ] && return 0
  local NAS
  NAS=$($SSH "$VPS" "su - jhnapps -c 'pm2 pid $3' 2>/dev/null | tr -d '\r'" || true)
  if [ "$P" != "$NAS" ]; then
    echo "Port $1 na $VPS drží jiná aplikace (pid $P):"
    $SSH "$VPS" "ss -l${2}np | grep ':$1 '" || true
    exit 1
  fi
}
hlidej_port "$PORT" t famicura-tapo
hlidej_port "$WEBRTC_PORT" t famicura-go2rtc

cd "$(dirname "$0")/.."
printf '{"commit":"%s","vetev":"%s","nasazeno":"%s"}\n' "$(git rev-parse --short HEAD 2>/dev/null || echo ?)" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ?)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > verze.json
$SSH "$VPS" "mkdir -p $DIR/bin $DIR/data && chown -R jhnapps:jhnapps $DIR"
rsync -az -e "$SSH" --exclude node_modules --exclude .git --exclude .DS_Store --exclude .env \
  --exclude data --exclude bin --exclude cameras.json --exclude go2rtc.yaml ./ "$VPS:$DIR/"

# go2rtc: stáhnout, jen když chybí nebo nesedí součet.
$SSH "$VPS" "cd $DIR/bin && if ! { [ -f go2rtc ] && echo '$GO2RTC_SHA  go2rtc' | sha256sum -c --status >/dev/null 2>&1; }; then
  curl -fsSL -o go2rtc.new https://github.com/AlexxIT/go2rtc/releases/download/v$GO2RTC_VER/go2rtc_linux_amd64 &&
  echo '$GO2RTC_SHA  go2rtc.new' | sha256sum -c --status && chmod 755 go2rtc.new && mv go2rtc.new go2rtc && echo 'go2rtc $GO2RTC_VER staženo a ověřeno.' ||
  { echo 'go2rtc: stažení nebo kontrola součtu selhala.'; rm -f go2rtc.new; exit 1; }
fi"

# Port pro obraz: TCP i UDP. Jen když na VPS běží ufw; firewall v Hetzner
# Cloud konzoli (pokud ho používáte) je potřeba otevřít ručně.
$SSH "$VPS" "if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow $WEBRTC_PORT/tcp >/dev/null && ufw allow $WEBRTC_PORT/udp >/dev/null && echo 'ufw: port $WEBRTC_PORT otevřen.'; fi"

# .env ze šablony, pokud ještě není; go2rtc.yaml vždy znovu z cameras.json.
$SSH "$VPS" "chown -R jhnapps:jhnapps $DIR && su - jhnapps -c 'cd $DIR &&
  ( [ -f .env ] || { cp .env.example .env && chmod 600 .env && echo \".env vytvořen ze šablony – spusťte ./deploy/vps-env.sh\"; } ) &&
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1 &&
  node scripts/set-camera.mjs obnov &&
  PORT=$PORT pm2 startOrRestart deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null'"

# Poslouchají na svých portech opravdu naše procesy? pm2 hlásí "online" i u
# aplikace, která se po startu v kruhu restartuje.
sleep 3
over() {  # port pm2-jmeno
  local NAS P
  NAS=$($SSH "$VPS" "su - jhnapps -c 'pm2 pid $2' 2>/dev/null | tr -d '\r'" || true)
  P=$($SSH "$VPS" "ss -ltnp 2>/dev/null | grep ':$1 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2" || true)
  if [ -z "$P" ] || [ "$P" != "$NAS" ]; then
    echo; echo "$2 neposlouchá na portu $1 (pm2 pid ${NAS:-?}, na portu ${P:-nikdo})."
    $SSH "$VPS" "su - jhnapps -c 'pm2 logs $2 --lines 15 --nostream --err'" || true
    exit 1
  fi
}
over "$PORT" famicura-tapo
over "$WEBRTC_PORT" famicura-go2rtc
$SSH "$VPS" "su - jhnapps -c 'curl -s localhost:$PORT/api/health'"; echo

# Veřejná adresa musí vést k nám, ne k sousední aplikaci.
ODPOVED=$(curl -s -m 15 "$VEREJNA/api/health" || true)
case "$ODPOVED" in
  *'"aplikace":"famicura-tapo"'*) echo "Veřejná adresa $VEREJNA odpovídá správně." ;;
  *)
    echo; echo "POZOR: na $VEREJNA neodpovídá tahle aplikace. Vrátilo se: ${ODPOVED:-(nic)}"
    echo "Doplňte blok z deploy/Caddyfile.snippet do /etc/caddy/Caddyfile (port $PORT) a:"
    echo "  ssh -i $KEY $VPS \"caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy\""
    exit 1 ;;
esac
echo "Hotovo. Logy: ssh -i $KEY $VPS \"su - jhnapps -c 'pm2 logs famicura-tapo famicura-go2rtc --lines 50'\""
