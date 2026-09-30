# Aplikace Jindřicha Hegmona a jejich nasazení

Společné: projekty jsou v `~/Downloads` (hlavní Mac i Air; na Airu je Tapo
i v `~`). VPS Hetzner `root@95.216.201.2`, aplikace běží pod uživatelem
`jhnapps` v pm2 za Caddy; klíč na Macu `~/.ssh/id_ed25519_jhnapps` (musí být
na obou Macech). Skripty `deploy/*.sh` se spouštějí **z Macu ve složce
projektu**, nikdy na VPS. Práce se pushuje na GitHub, odkud si ji Mac bere
příkazem `git pull`.

## Famicura Tapo (kamera Tapo C220, aplikace + prototyp rolí)

| | |
|---|---|
| repozitář | `jindrichhegmon/famicura-tapoc2020`, veřejný, práce jde přímo na `main` |
| složka na Macu | `~/Downloads/Famicura-TAPOC2020` (na Airu i `~/Famicura-TAPOC2020`); v bloku vždy `cd ~/Downloads/Famicura-TAPOC2020 2>/dev/null \|\| cd ~/Famicura-TAPOC2020` |
| klon, když chybí | `cd ~/Downloads && git clone https://github.com/jindrichhegmon/famicura-tapoc2020.git Famicura-TAPOC2020` |
| adresa | https://famicuratapo.95-216-201-2.sslip.io (přihlášení heslem Famicura), prototyp `/proto/` |
| testy před pushem | `npm test` (jednotkové); e2e v Electronu jsou mimo repozitář |
| VPS | `/opt/famicura-tapo`, pm2 `famicura-tapo` (port 3112) a `famicura-go2rtc` |

Skripty (všechny `./deploy/…` ve složce projektu):

| skript | kdy | ptá se |
|---|---|---|
| `vps-deploy.sh` | **po každé změně kódu** (public/, src/, server.mjs, scripts/, README) | na nic; nepřepisuje .env, cameras.json, go2rtc.yaml, data/ |
| `vps-env.sh` | jen když přibyla/změnila se proměnná v `.env` | heslo do aplikace (skrytě); SQL heslo bere ze serveru, klíč generuje |
| `vps-kamera.sh` | jen při změně kamery, účtu kamery nebo režimu tunelu | ID kamery (Enter), název (Enter), uživatel účtu kamery, heslo (skrytě), kvalita (Enter). Na IP se neptá, když je režim windows/ssh |
| `vps-kamera.sh seznam` / `smaz ID` | výpis / odebrání | – |
| `ssh-tunel-vps.sh "<klíč>"` / `stav` / `odebrat` | tunel SSH z Windows serveru (režim ssh; používá se, ESET blokuje WireGuard) | klíč vypsaný skriptem na Windows |
| `wireguard-vps.sh <IP kamery> --windows` | jen nový tunel WireGuard (dnes nahrazen SSH) | – ; vytvoří `famicura-wg-u-kamery.conf`, po instalaci smazat |
| `vps-diag.sh [s]` | diagnostika událostí kamery (ONVIF) | – |

Windows server u kamery (Zlín, ESET, bez hesla k ESETu): skripty
`deploy/wireguard/u-kamery-windows-ssh.ps1` (aktuální, tunel SSH) a
`u-kamery-windows.ps1` (WireGuard). Nekopírují se, stáhnou se z GitHubu.
PowerShell **jako správce**:

```
cd $env:USERPROFILE\Downloads
Invoke-WebRequest -Uri https://raw.githubusercontent.com/jindrichhegmon/famicura-tapoc2020/main/deploy/wireguard/u-kamery-windows-ssh.ps1 -OutFile u-kamery-windows-ssh.ps1
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\u-kamery-windows-ssh.ps1 -Kamera 192.168.10.109
```

Stav tunelu: na Windows `.\u-kamery-windows-ssh.ps1 -Stav`, na Macu
`./deploy/ssh-tunel-vps.sh stav`. Ověření po nasazení: otevřít adresu, Cmd+R,
Diagnostika → kamera „odpovídá“, události „odebírám“; prototyp `/proto/`.
Hlavní aplikace se po 8 neúspěšných pokusech přestane připojovat: tlačítko
„Zkusit znovu“ nebo Cmd+R.

## Famicura Ring (kamery Ring, Netlify + VPS pro zápis do CLB1)

| | |
|---|---|
| repozitář | `jindrichhegmon/FAMICURA-Ring`, práce na větvi `claude/…`, push na `main` je povolen |
| složka na Macu | `~/Downloads/FAMICURA-Ring`; v bloku `cd ~/Downloads/FAMICURA-Ring 2>/dev/null \|\| cd ~/FAMICURA-Ring` |
| klon, když chybí | `cd ~/Downloads && git clone https://github.com/jindrichhegmon/FAMICURA-Ring.git` |
| web | Netlify, nasazuje **sama** z `main` (publish `public/`, functions `netlify/functions/`), build trvá 1–2 minuty; na Macu se pro web nic nespouští |
| VPS část | `/opt/famicura-ring`, pm2 `famicura-ring`, port 3111; zdraví: https://famicuraring.95-216-201-2.sslip.io/api/health |
| proměnné Netlify | `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, `RING_HMAC_KEY`, `FAMICURA_LINK_PASSWORD`, volitelně `FAMICURA_USER_EMAIL`, `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN`; nastavují se v Netlify → Site → Environment variables, ne v gitu |

| skript | kdy | ptá se |
|---|---|---|
| `./deploy/vps-deploy.sh` | změna v `server.mjs`, `src/`, `sql/`, `deploy/` (část na VPS) | na nic (rsync + npm install + pm2 restart) |
| `./deploy/vps-env.sh` | jen když se mění tajné hodnoty na VPS | `RING_HMAC_KEY` (skrytě), **stejný jako v Netlify**; SQL heslo bere ze serveru |

Nové SQL tabulky: skripty v `sql/` se spouštějí podle README (část „Založení
tabulek“). Ověření: homepage Netlify → přihlášení → Diagnostika „Konfigurace:
kompletní“, „Netlify Blobs: dostupné“; `/api/clb-health` na VPS.

## Jak přidat další aplikaci

Zapiš stejné položky: repozitář a větev, složka na Macu a příkaz na klon,
adresa, kde běží (VPS/pm2 název a port, nebo Netlify), skripty s tím, kdy se
používají a na co se ptají, a jak se ověří, že nasazení prošlo.
