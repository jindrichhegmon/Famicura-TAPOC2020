#!/usr/bin/env bash
# Běží na VPS jako root (volá ho deploy/vps-env.sh z Macu): opíše tajný klíč
# z .env téhle aplikace do .env jhn-apps (aplikační server, čitelný jen rootovi)
# a jhn-apps restartuje, když se hodnota změnila. Hodnota neopustí server.
#
#   sdilej-klic-jhn.sh KLIC /opt/famicura-tapo /opt/jhn-apps/.env
#
# Používá se pro FAMICURA_KAMERA_KLIC: server kamery se jím hlásí aplikaci
# pecedomaplus-kamera-disk (nahrávky na Google Disk poskytovatele).
set -e
KLIC=$1; DIR=$2; CIL=$3
JAKO=${PREVEZMI_JAKO:-"su - jhnapps -c"}
[[ "$KLIC" =~ ^[A-Z0-9_]+$ ]] && [ -n "$DIR" ] && [ -n "$CIL" ] || { echo "Použití: $0 KLIC /opt/aplikace /opt/jhn-apps/.env" >&2; exit 1; }
[ -r "$DIR/.env" ] || { echo "$DIR/.env na serveru není." >&2; exit 2; }
[ -w "$CIL" ] || { echo "$CIL na serveru není (nebo nejde zapsat)." >&2; exit 2; }
V=$(grep -m1 "^$KLIC=" "$DIR/.env" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
[ -n "$V" ] || { echo "$KLIC je v $DIR/.env prázdné." >&2; exit 3; }
STARA=$(grep -m1 "^$KLIC=" "$CIL" | cut -d= -f2- || true)
if [ "$STARA" = "$V" ]; then echo "$KLIC: v $CIL už je stejný."; exit 0; fi
umask 077
if grep -q "^$KLIC=" "$CIL"; then
  # sed s oddělovačem |, hodnota je base64url (bez | a /)
  sed -i "s|^$KLIC=.*|$KLIC=$V|" "$CIL"
else
  printf '\n# Famicura Kamera – klíč pro aplikaci pecedomaplus-kamera-disk (zapisuje ./deploy/vps-env.sh aplikace Famicura Kamera)\n%s=%s\n' "$KLIC" "$V" >> "$CIL"
fi
echo "$KLIC: zapsán do $CIL."
$JAKO "pm2 restart jhn-apps --update-env >/dev/null 2>&1 && pm2 save >/dev/null 2>&1" && echo "jhn-apps restartován." || echo "POZOR: jhn-apps se nepodařilo restartovat (pm2 restart jhn-apps)." >&2
