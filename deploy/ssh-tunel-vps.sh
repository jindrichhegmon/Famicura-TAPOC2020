#!/usr/bin/env bash
# Kamera přes tunel SSH z Windows serveru – strana VPS. Spouštět z Macu ve složce projektu:
#   ./deploy/ssh-tunel-vps.sh "ssh-ed25519 AAAA… famicura-tunel@SERVER"   klíč, který vypsal skript na Windows
#   ./deploy/ssh-tunel-vps.sh klic.txt                                     totéž ze souboru
#   ./deploy/ssh-tunel-vps.sh stav                                         drží server tunel?
#   ./deploy/ssh-tunel-vps.sh odebrat
#
# Kdy: když firewall na Windows serveru (např. ESET) nepustí příchozí provoz
# z tunelu WireGuard a nikdo ho nemůže nastavit. Spojení pak navazuje server
# směrem ven (to firewally pouštějí) a obraz i události jdou tímhle spojením.
# Postup: 1. na Windows .\u-kamery-windows-ssh.ps1 -Kamera <IP>  (vypíše klíč)
#         2. tady ./deploy/ssh-tunel-vps.sh "<klíč>"
#         3. ./deploy/vps-kamera.sh   (pozná režim ssh, na IP se neptá)
set -e
VPS="${VPS:-root@95.216.201.2}"
KEY="${KEY:-$HOME/.ssh/id_ed25519_jhnapps}"
SSH="ssh -i $KEY -o BatchMode=yes"
cd "$(dirname "$0")/.."

case "${1:-}" in
  stav|odebrat) $SSH "$VPS" "bash -s -- $1" < deploy/ssh-tunel/vps-setup.sh; exit ;;
  "") echo "Použití: $0 \"<veřejný klíč ssh-ed25519 …>\" | klic.txt | stav | odebrat"; exit 1 ;;
esac

KLIC="$1"
[ -f "$KLIC" ] && KLIC=$(head -1 "$KLIC")
KLIC=$(printf '%s' "$KLIC" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
# Klíč jde na server jako argument: jen tvar, který tam projde stejnou kontrolou.
[[ "$KLIC" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [A-Za-z0-9@._-]+)?$ ]] || { echo "To nevypadá jako klíč ssh-ed25519. Zkopírujte celý řádek, který vypsal u-kamery-windows-ssh.ps1."; exit 1; }

$SSH "$VPS" "bash -s -- nastav '$KLIC'" < deploy/ssh-tunel/vps-setup.sh
echo
echo "Windows server se zkouší připojit každých 10 s. Za chvíli ověřte:  $0 stav"
echo "Pak nastavte kameru:  ./deploy/vps-kamera.sh   (režim ssh pozná sám; IP kamery zná Windows server)"
