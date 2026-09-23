# Famicura Tapo

Kamera TP-Link Tapo → Famicura: živý obraz v prohlížeči, nahrávání, živá
analýza pádů, plán nahrávání, sledované události a zápis do CLB1.

Vzniklo jako klon [Famicura-Ring](https://github.com/jindrichhegmon/famicura-ring).
Přehrávač, analýza, nahrávání, plány, sledované události, hlídání spořiče
obrazovky a zápis do CLB1 jsou stejné. Vyměnil se zdroj obrazu, a protože
Tapo nemá cloudové API jako Ring, běží všechno na VPS.

## Jak to funguje

```
kamera Tapo ──RTSP──▶ Windows server ══ WireGuard ══▶ VPS: go2rtc ──WebRTC──▶ prohlížeč
 (místní síť)          (nebo Raspberry Pi)  (šifrovaně)      server.mjs ──HTTPS──▶ (kdekoli)
```

* **Kamera** vydává obraz jen v místní síti (RTSP). Do internetu se
  neotevírá nic.
* **Zařízení u kamery** je trvale zapnutý počítač ve stejné síti jako kamera.
  Samo se tunelem WireGuard připojí k VPS a obraz z kamery mu předá. Na
  routeru se nic neotevírá. Ke kameře se VPS jinak dostat nemůže, protože
  router zvenku dovnitř nic nepustí a Tapo nemá cloud.
  * **Windows server** (tahle instalace): předává jen svůj port 554 na
    kameru (`netsh interface portproxy`). VPS kameru ani nic jiného v síti
    nevidí (`deploy/wireguard/u-kamery-windows.ps1`).
  * **Raspberry Pi / Linux**: pouští z tunelu jen RTSP kamery a ping
    (`deploy/wireguard/brana.sh`).
* **go2rtc** na VPS převádí RTSP na WebRTC. Kamera posílá H.264 a G.711,
  obojí prohlížeč umí přímo, takže se nic nepřekódovává. API go2rtc
  poslouchá jen na `127.0.0.1`. Veřejný je jen port 8555 pro šifrovaná
  média.
* **server.mjs** na VPS obsluhuje stránku, přihlášení heslem Famicura,
  WebRTC (předává nabídku go2rtc), plány, sledované události a zápis do CLB1.

### Prohlížeč

Kamera posílá H.264. Umí ho Chrome, Edge a Safari, na počítači i na
iPhonu. Prohlížeč bez H.264 (např. Chromium v některých Linuxech) dostane
hlášku „Tento prohlížeč neumí obraz H.264 z kamery“. Znovu se pak
nepřipojuje, protože by to nepomohlo.

Analýza (MediaPipe) potřebuje v prohlížeči **WebGL**, tedy grafickou
akceleraci. Bez něj, třeba přes vzdálenou plochu nebo ve virtuálu, řekne
hned při spuštění, proč neběží. Když by detekce za běhu opakovaně
selhávala (20 snímků po sobě), analýza se zastaví a zapíše to do logu
i CLB1. Hlídání pádů se nesmí tvářit, že běží, když nic nevyhodnocuje.

## Nastavení krok za krokem

Všechny příkazy spouštějte na Macu ve složce projektu, pokud není
uvedeno jinak.

### 1. Kamera (aplikace Tapo)

1. Kamera → Nastavení → Pokročilá nastavení → **Účet kamery**: založte
   uživatele a heslo. Je to jiné heslo než k účtu TP-Link.
2. Zjistěte IP adresu kamery (Nastavení → Informace o zařízení) a
   **zarezervujte ji v routeru** (DHCP rezervace). Kdyby se změnila, tunel
   i go2rtc by kameru ztratily.

### 2. Tunel k VPS přes Windows server

Windows server musí být ve stejné síti jako kamera a trvale zapnutý.
Na Macu:

```
./deploy/wireguard-vps.sh 192.168.1.50 --windows     # IP kamery
```

Na VPS nastaví rozhraní `wg-famicura` (UDP 51821) a sem uloží
`famicura-wg-u-kamery.conf`. Pak na **Windows serveru**:

1. Nainstalujte **WireGuard pro Windows** z https://www.wireguard.com/install/.
2. Zkopírujte na server `famicura-wg-u-kamery.conf` a
   `deploy/wireguard/u-kamery-windows.ps1`, třeba přes vzdálenou plochu.
3. Ve složce s nimi otevřete **PowerShell jako správce** a spusťte:
   ```
   powershell -ExecutionPolicy Bypass -File .\u-kamery-windows.ps1 -Konfigurace .\famicura-wg-u-kamery.conf
   ```
4. Soubor `famicura-wg-u-kamery.conf` smažte na serveru i na Macu.
   Obsahuje soukromý klíč a je v `.gitignore`.

Na serveru se nastaví jen tři věci:

| | |
|---|---|
| služba WireGuard `wg-famicura` | tunel k VPS, naběhne i po restartu. Tunelem jde jen provoz pro VPS (10.77.0.1), běžný provoz serveru do internetu se nemění. |
| `netsh interface portproxy` 0.0.0.0:554 → kamera | předává obraz z kamery |
| firewall „Famicura Tapo“ | port 554 a ping povolené **jen z VPS** (10.77.0.1) |

Změna IP kamery: `.\u-kamery-windows.ps1 -Kamera 192.168.1.60`.
Odebrání všeho: `.\u-kamery-windows.ps1 -Odebrat` (obojí jako správce,
s `powershell -ExecutionPolicy Bypass -File`).

**Místo Windows serveru Raspberry Pi nebo jiný Linux:** vynechte
`--windows`. Skript pak vypíše příkazy pro `deploy/wireguard/u-kamery.sh`.
Router, který umí klienta WireGuard, to zvládne také, ale nastavuje se
u každého výrobce jinak.

### 3. Aplikace a go2rtc na VPS

```
./deploy/vps-deploy.sh      # aplikace + go2rtc pod pm2, port 3112, otevře 8555
./deploy/vps-env.sh         # heslo do aplikace; heslo k SQL převezme, klíč vygeneruje
./deploy/vps-kamera.sh      # IP kamery, účet kamery (heslo skrytě), název
```

`vps-kamera.sh` na konci ověří, že kamera posílá obraz. S Windows
serverem se na IP kamery neptá: go2rtc chodí na server v tunelu
(10.77.0.2) a IP kamery zná jen server. Přihlášení ke
kameře je na VPS jen v `cameras.json` a `go2rtc.yaml`, oba s právy 600.
`go2rtc.yaml` se z `cameras.json` vždy generuje, ručně se needituje.

**Firewall:** `vps-deploy.sh` otevře v ufw port 8555 (TCP i UDP) a
`wireguard-vps.sh` port 51821/UDP. Pokud máte i firewall v konzoli
Hetzner Cloud, povolte tam ručně totéž.

### 4. Caddy

Blok z `deploy/Caddyfile.snippet` přidejte do `/etc/caddy/Caddyfile`:

```
famicuratapo.95-216-201-2.sslip.io {
	reverse_proxy 127.0.0.1:3112
}
```

```
ssh -i ~/.ssh/id_ed25519_jhnapps root@95.216.201.2 "caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"
```

Pak otevřete **https://famicuratapo.95-216-201-2.sslip.io**. V kartě
Diagnostika uvidíte go2rtc, jestli kamera posílá obraz a připojení k CLB1.

## Na VPS

| | |
|---|---|
| složka | `/opt/famicura-tapo` (uživatel `jhnapps`) |
| pm2 | `famicura-tapo` (server), `famicura-go2rtc` |
| porty | 3112 (jen localhost, za Caddy), 8555 TCP+UDP (WebRTC), 51821 UDP (WireGuard), 1984 jen localhost (API go2rtc) |
| stav | `.env`, `cameras.json`, `go2rtc.yaml`, `data/` (plány, sledované události). Nasazení je nepřepisuje. |
| go2rtc | verze 1.9.14, stažená z GitHubu a ověřená SHA-256 |

Logy:

```
ssh -i ~/.ssh/id_ed25519_jhnapps root@95.216.201.2 "su - jhnapps -c 'pm2 logs famicura-tapo famicura-go2rtc --lines 50'"
```

### CLB1

Zapisuje do stejných tabulek jako aplikace pro Ring
(`dbo.FamicuraRingLog`, `dbo.FamicuraRingNahravky`). Kamery se liší
sloupcem `KameraId`: Tapo má ID z go2rtc (`tapoc2020`), Ring dlouhé
`ava1.ring.device…`. Tabulky už existují. Na novém serveru by je
založil `node scripts/init-db.mjs`.

## Bezpečnost

* Přihlášení heslem Famicura (`FAMICURA_PASSWORD`). Cookie je podepsaná
  `SESSION_KEY`, HttpOnly, Secure a platí 12 h. Po 10 chybných pokusech
  z jedné adresy se na 15 minut nepřihlásí nikdo.
* Nepřihlášený uživatel nezjistí ani seznam kamer. API vrací jen `401`.
* Obraz jde jen tomu, kdo po přihlášení dostal odpověď na svou nabídku
  WebRTC. Média jsou šifrovaná (DTLS-SRTP).
* go2rtc má vypnuté vlastní servery RTSP, RTMP a SRTP a jeho API je
  jen na localhostu.
* Z tunelu je dostupná jen kamera, jen na RTSP a ping. U Windows serveru
  jen jeho port 554, přesměrovaný na kameru. Ověřeno testy na modelu sítě:
  u Linuxu jsou jiný port kamery, jiný počítač i zařízení samotné
  zablokované. U Windows přišel obraz přes předávání TCP, i když VPS
  kameru napřímo vůbec neviděl.

## Vývoj a testy

```
npm test          # server, přihlášení, go2rtc klient, kamery, plány, analýza
```

Celou cestu obrazu jsme ověřili naostro: falešná kamera (ffmpeg, RTSP
s heslem, H.264 Main + G.711), dál go2rtc 1.9.14 s konfigurací z
`scripts/set-camera.mjs`, pak `server.mjs` a nakonec prohlížeč s H.264
(Electron/Chrome 152). Test zahrnoval přihlášení, diagnostiku, živý obraz
1280×720 se zvukem, nahrávání, analýzu, plán, sledované události a
prohlížeč bez H.264 a bez WebGL. Pravidla brány na Linuxu i předávání
přes Windows server (prostá TCP proxy jako `netsh portproxy`) jsme ověřili
na modelu sítě se síťovými jmennými prostory. Skript pro Windows prošel
parserem PowerShellu 7.4. Na skutečném Windows ani se skutečnou kamerou
Tapo zatím spuštěný nebyl.
