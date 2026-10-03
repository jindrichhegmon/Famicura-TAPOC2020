#!/usr/bin/env bash
# Běží na VPS jako root (volá ho deploy/vps-env.sh z Macu): vezme hodnotu z .env
# jiné aplikace (čitelné často jen rootovi, např. /opt/jhn-apps/.env) a zapíše
# ji do našeho .env jako jhnapps. Hodnota neopustí server a nejde na příkazovou řádku.
#
#   prevezmi-jhn.sh NAS_KLIC 'REGEX_NAZVU_KLICE' /opt/jhn-apps/.env /opt/famicura-tapo
#   prevezmi-jhn.sh seznam   'REGEX_NAZVU_KLICE' /opt/jhn-apps/.env     → jen názvy klíčů, bez hodnot
#
# Klíč *_URL (spojení jako mssql://user:heslo@server/db) se rozebere na část,
# kterou náš klíč potřebuje (set-env.mjs nastav-z-url).
set -e
KLIC=$1; REGEX=$2; ZDROJ=$3; DIR=$4
JAKO=${PREVEZMI_JAKO:-"su - jhnapps -c"}
[ -n "$KLIC" ] && [ -n "$REGEX" ] && [ -n "$ZDROJ" ] || { echo "Použití: $0 NAS_KLIC|seznam REGEX /cesta/.env [/opt/aplikace]" >&2; exit 1; }
[ -r "$ZDROJ" ] || { echo "$ZDROJ na serveru není (nebo nejde číst)." >&2; exit 2; }
nazvy() { grep -oE '^[A-Z0-9_]+=' "$ZDROJ" | tr -d = | grep -E "$REGEX" || true; }
if [ "$KLIC" = seznam ]; then nazvy; exit 0; fi
[ -n "$DIR" ] || { echo "Chybí složka aplikace." >&2; exit 1; }
K=$(nazvy | head -1)
[ -n "$K" ] || { echo "V $ZDROJ není klíč jako /$REGEX/." >&2; exit 3; }
V=$(grep -m1 "^$K=" "$ZDROJ" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")
[ -n "$V" ] || { echo "$K je v $ZDROJ prázdné." >&2; exit 4; }
AKCE=nastav; case "$K" in *_URL) AKCE=nastav-z-url ;; esac
printf '%s' "$V" | $JAKO "cd $DIR && node scripts/set-env.mjs $AKCE $KLIC" >/dev/null && echo "$KLIC: převzato z $ZDROJ ($K)."
