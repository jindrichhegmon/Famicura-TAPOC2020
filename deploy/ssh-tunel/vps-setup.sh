#!/usr/bin/env bash
# Běží na VPS jako root; volá ho deploy/ssh-tunel-vps.sh přes ssh.
# Připraví účet famicura-tunel, přes který Windows server u kamery drží
# odchozí spojení SSH a přivádí jím kameru na porty VPS:
#   127.0.0.1:10554 → kamera:554 (obraz, RTSP)
#   127.0.0.1:12020 → kamera:2020 (události, ONVIF)
# Účet nemá heslo ani shell; smí jen otevřít tyhle dva porty, jen na
# localhostu VPS, a nic jiného (žádný tunel ven, terminál, agent, X11).
#
#   bash vps-setup.sh nastav "<veřejný klíč ssh-ed25519 …>"
#   bash vps-setup.sh stav
#   bash vps-setup.sh odebrat
# Pro zkoušku bez systému: DRY=1 ROOT=/tmp/x bash vps-setup.sh nastav "ssh-ed25519 AAAA… x"
set -euo pipefail
AKCE="${1:-}"
KLIC="${2:-}"
UCET=famicura-tunel
RTSP=10554
ONVIF=12020
ROOT="${ROOT:-}"                 # předpona cest jen pro DRY zkoušku
DOMOV="$ROOT/var/lib/$UCET"
SSHD_D="$ROOT/etc/ssh/sshd_config.d"
REZIM="$ROOT/etc/wireguard/famicura-rezim"
DRY="${DRY:-}"
log() { echo "$@" >&2; }

case "$AKCE" in
  nastav)
    # Jen klíč, který vyrobil u-kamery-windows-ssh.ps1: ed25519, base64, komentář bez mezer.
    [[ "$KLIC" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [A-Za-z0-9@._-]+)?$ ]] || { log "Čekám veřejný klíč ve tvaru „ssh-ed25519 AAAA… komentář“ (vypíše ho skript na Windows serveru)."; exit 1; }
    if [ -z "$DRY" ]; then
      command -v sshd >/dev/null || { log "Na VPS chybí sshd."; exit 1; }
      grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || { log "sshd_config na VPS nenačítá sshd_config.d – nastavení pro účet by se nepoužilo."; exit 1; }
      if ! id "$UCET" >/dev/null 2>&1; then
        useradd --system --home-dir "$DOMOV" --create-home --shell /usr/sbin/nologin "$UCET"
      fi
      # Bez hesla, ale ne „zamčený“ („!“): zamčený účet sshd odmítne i s klíčem.
      usermod -p '*' "$UCET"
    fi
    umask 077
    mkdir -p "$DOMOV/.ssh" "$SSHD_D"
    # restrict = žádný terminál, agent, X11 ani tunel; port-forwarding pak povolí
    # jen předávání portů a permitlisten jen tyhle dva. Kam vede druhý konec
    # (kamera), si určuje Windows server – VPS z toho nic jiného nevidí.
    printf 'restrict,port-forwarding,permitlisten="%s",permitlisten="%s" %s\n' "$RTSP" "$ONVIF" "$KLIC" > "$DOMOV/.ssh/authorized_keys"
    cat > "$SSHD_D/famicura-tunel.conf" <<CONF
# Famicura Tapo – účet pro tunel SSH z Windows serveru u kamery. Generuje deploy/ssh-tunel-vps.sh.
Match User $UCET
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthenticationMethods publickey
    AllowTcpForwarding remote
    GatewayPorts no
    PermitListen $RTSP $ONVIF
    PermitOpen none
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    ForceCommand /usr/sbin/nologin
    # Spadlé spojení (výpadek internetu u kamery) se pozná do minuty a port se
    # uvolní; jinak by se server po obnovení sítě nemohl připojit znovu.
    ClientAliveInterval 15
    ClientAliveCountMax 3
CONF
    chmod 644 "$SSHD_D/famicura-tunel.conf"
    # vps-kamera.sh podle toho ví, že má go2rtc poslat na 127.0.0.1:$RTSP.
    mkdir -p "$(dirname "$REZIM")"
    echo ssh > "$REZIM"
    if [ -z "$DRY" ]; then
      chown -R "$UCET:$UCET" "$DOMOV"
      sshd -t || { log "sshd nové nastavení odmítl; nic jsem nenačetl."; rm -f "$SSHD_D/famicura-tunel.conf"; exit 1; }
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
    fi
    log "Účet $UCET je připravený: smí jen přivést kameru na 127.0.0.1:$RTSP a :$ONVIF."
    ;;
  stav)
    if ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:($RTSP|$ONVIF) "; then
      echo "Tunel SSH z Windows serveru je navázaný:"
      ss -ltn | grep -E "127\.0\.0\.1:($RTSP|$ONVIF) "
      exit 0
    fi
    echo "Tunel SSH z Windows serveru teď navázaný není (porty $RTSP a $ONVIF na VPS nikdo nedrží)."
    if [ -z "$DRY" ]; then
      echo "Poslední pokusy účtu $UCET v logu sshd:"
      journalctl -u ssh -u sshd --since '-1h' --no-pager 2>/dev/null | grep -F "$UCET" | tail -5 || true
    fi
    exit 1
    ;;
  odebrat)
    rm -f "$SSHD_D/famicura-tunel.conf"
    [ -z "$DRY" ] && id "$UCET" >/dev/null 2>&1 && { pkill -u "$UCET" || true; userdel -r "$UCET" 2>/dev/null || true; }
    rm -rf "$DOMOV"
    [ -f "$REZIM" ] && [ "$(cat "$REZIM")" = ssh ] && rm -f "$REZIM"
    [ -z "$DRY" ] && { sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd); }
    log "Účet $UCET a jeho nastavení sshd odebrány."
    ;;
  *) log "Použití: $0 nastav \"<veřejný klíč>\" | stav | odebrat"; exit 1 ;;
esac
