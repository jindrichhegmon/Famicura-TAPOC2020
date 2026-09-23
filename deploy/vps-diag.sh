#!/usr/bin/env bash
# Diagnostika událostí kamery na VPS: co kamera nabízí a co doopravdy posílá.
# Spouštět z Macu ve složce projektu:
#   ./deploy/vps-diag.sh            (60 s)
#   ./deploy/vps-diag.sh 120        (déle)
# Mezitím projděte před kamerou, opusťte zónu, zakryjte objektiv.
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
DIR=/opt/famicura-tapo
SEKUND="${1:-60}"
[[ "$SEKUND" =~ ^[0-9]{1,4}$ ]] || { echo "Počet sekund musí být číslo."; exit 1; }

cd "$(dirname "$0")/.."
# The script is new; make sure the server has it and the client it uses.
scp -q -i "$KEY" scripts/onvif-diag.mjs "$VPS:$DIR/scripts/"
scp -q -i "$KEY" src/onvif.mjs src/xml.mjs "$VPS:$DIR/src/"
ssh -i "$KEY" "$VPS" "chown jhnapps:jhnapps $DIR/scripts/onvif-diag.mjs $DIR/src/onvif.mjs $DIR/src/xml.mjs"
ssh -t -i "$KEY" "$VPS" "su - jhnapps -c 'cd $DIR && node scripts/onvif-diag.mjs $SEKUND'"
echo
echo "Log serveru (poslední řádky o událostech kamery):"
ssh -i "$KEY" "$VPS" "su - jhnapps -c 'pm2 logs famicura-tapo --lines 200 --nostream --timestamp'" | grep -E "události kamery|mimo katalog|CLB1" | tail -20 || true
