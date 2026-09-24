# Famicura Tapo

Kamera TP-Link Tapo → Famicura: živý obraz v prohlížeči, nahrávání, živá
analýza pádů, plán nahrávání, sledované události (z analýzy i to, co kamera
rozpozná sama) a zápis do CLB1.

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
  * **Windows server** (tahle instalace): předává na kameru jen své porty
    554 (obraz, RTSP) a 2020 (události, které kamera hlásí, ONVIF) přes
    `netsh interface portproxy`. VPS kameru ani nic jiného v síti nevidí
    (`deploy/wireguard/u-kamery-windows.ps1`).
  * **Raspberry Pi / Linux**: pouští z tunelu jen tyto dva porty kamery a
    ping (`deploy/wireguard/brana.sh`).
* **go2rtc** na VPS převádí RTSP na WebRTC. Kamera posílá H.264 a G.711,
  obojí prohlížeč umí přímo, takže se nic nepřekódovává. API go2rtc
  poslouchá jen na `127.0.0.1`. Veřejný je jen port 8555 pro šifrovaná
  média.
* **server.mjs** na VPS obsluhuje stránku, přihlášení heslem Famicura,
  WebRTC (předává nabídku go2rtc), plány, sledované události a zápis do CLB1.
  Zároveň odebírá z kamery události, které rozpozná sama (níže).

### Události, které hlásí kamera sama

Kamera Tapo má vlastní rozpoznávání: pohyb, u novějších modelů osobu,
vozidlo, zvíře, překročení čáry, zakrytí nebo posunutí kamery. Hlásí je
přes ONVIF na svém portu 2020 a v `GetEventProperties` řekne, které z nich
umí. Server na VPS se ke kameře přihlásí účtem kamery (tím samým, co
go2rtc), založí odběr (PullPoint) a drží ho trvale: každou událost projde
nastavením Sledovaných událostí té kamery a zapíše do CLB1 sám, **i když
nikdo nemá otevřený prohlížeč**. Stránka se každých pár sekund zeptá, co
přišlo, a ukáže to v logu vedle událostí z analýzy.

V kartě **Události** u kamery jsou dvě části: „Z analýzy obrazu v
prohlížeči“ (pád, dlouhé ležení… – běží jen s otevřenou kamerou) a
„Rozpozná kamera sama“ – tam je přesně to, co kamera nahlásila, že umí:
C200 jen pohyb, C210/C220 i osobu, vozidlo a zvíře. Každou událost lze
vypnout nebo omezit hodinami (v čase pečovatelů, Europe/Prague, ne serveru).
Bez nastavení je vše zapnuté celý den. Událost je přechod hodnoty na
„true“: Tapo C220 (firmware 1.0.3) posílá během detekce „true“ každých
~100 ms a všechno označuje „Initialized“, takže rozhoduje jen změna
hodnoty, ne označení zprávy. Jedna detekce je jedna událost, ať přišla v
jedné nebo ve sto zprávách; stejná detekce do 5 s po sobě se nepočítá
dvakrát.

### Ukládání nahrávek

V Chromu a Edgi na počítači se každá hotová nahrávka zapíše hned do složky
zvolené tlačítkem **Vybrat složku pro videa** (typicky složka Disku Google,
která ji sama nahraje). Co se nestihlo – nahrávky z doby, než byla složka
vybraná, nebo než prohlížeč po obnovení stránky znovu potvrdil přístup – se
dopíše, jakmile je složka k dispozici, a každou minutu se to zkouší znovu.
Safari (Mac i iPhone) do složky zapisovat neumí; místo toho je tam
zatržítko **Každou hotovou nahrávku rovnou stáhnout**, po němž jde každá
nahrávka sama do složky Stažené soubory prohlížeče.

### Nahrávka po události

U každé události (z analýzy i z kamery) je zatržítko **nahrávat**: když
nastane, prohlížeč, který má kameru otevřenou, nahraje následující sekundy.
Délka je pro kameru jedna, posuvník **Délka nahrávání události** 5–30 s
(výchozí 15). Nahrávka se objeví v seznamu s poznámkou „událost: …“ a do
CLB1 jde se zdrojem `udalost`. Ručně nebo plánem spuštěné nahrávání má
přednost (událost ho nepřeruší); nahrávku spuštěnou událostí každá další
událost prodlouží, takže rušná minuta je jeden soubor. Události kamery
přicházejí do stránky dotazem každé 3 s, takže taková nahrávka může začít
až o pár sekund po události; nahrává se jen tam, kde je kamera otevřená –
server sám nenahrává.

Diagnostika ukazuje u každé kamery, zda odběr běží, co kamera umí, poslední
událost, případnou chybu zápisu do CLB1 a **poslední nezapsanou událost s
důvodem** („v Událostech vypnuto“, „mimo hodiny 08:00–20:00 (čas události
21:14)“); totéž jde do logu serveru. Hodiny se počítají v čase
Europe/Prague z času události, který uvádí kamera (UTC). Co kamera pošle pod jménem, které
katalog nezná (jiný detektor, jiná položka), se neztratí: jde do logu
serveru (`pm2 logs famicura-tapo`, řádek „hlásí mimo katalog“) a do
Diagnostiky, aby šlo dohledat, jak kamera pojmenovala třeba opuštění
zóny, a doplnit to do katalogu v `src/onvif.mjs`. Když kamera na portu 2020
neodpovídá (starší skript na Windows serveru předával jen 554), obraz jde
dál, jen události chybí – stav to řekne.

Když kamera nic nehlásí, `./deploy/vps-diag.sh` (z Macu; na VPS spustí
`scripts/onvif-diag.mjs`) vypíše model a firmware, všechna témata ONVIF,
jak je kamera pojmenovala, a minutu každou zprávu tak, jak přišla –
i takovou, kterou katalog nezná. Firmware Tapo 1.3.4 a 1.3.5 (jaro 2023)
události ONVIF neposílal; novější i starší ano. Kdyby diagnostika hlásila odběr v pořádku, ale žádná událost
nechodila, zkontrolujte v aplikaci Tapo, že je detekce zapnutá, a verzi
firmwaru.

### Síť, která nepustí WebRTC: obraz přes HTTPS

Obraz jde normálně WebRTC na port 8555 VPS (UDP). Firemní sítě to často
blokují: stránka se načte, kamera „posílá obraz“, ale v prohlížeči je
černá plocha, zatímco přes mobilní data jde vše. Přehrávač to pozná sám:
když po navázání spojení nepřijde WebRTC ani jeden paket, zapíše do logu
„přes WebRTC nepřišla žádná data … přepínám na náhradní cestu přes HTTPS“
a obraz si vezme přes náš server, stejnou cestou jako stránku
(`/api/stream.mp4` pro Chrome, Edge a Firefox, `/api/stream.m3u8` + `/api/hls/…`
pro Safari; server je jen předává z go2rtc, průběžně a jen přihlášeným).
Karta pak říká „Přehrávám (náhradní cesta přes HTTPS, bez zvuku)“: obraz
je o sekundu až dvě pozadu a **bez zvuku**, protože zvuk kamery (G.711)
prohlížeč v MP4 ani HLS neumí. Nahrávání, analýza i drátěný model fungují
stejně. Prohlížeč si náhradní cestu pamatuje 12 hodin, aby při každém
otevření neztrácel čas na WebRTC; „Zkusit znovu“ po neúspěchu začíná zase
od WebRTC. Přepínač **Cesta obrazu** na kartě (Automaticky / WebRTC /
HTTPS) to nechá zvolit ručně, třeba když WebRTC v dané síti sice projde,
ale zadrhává; volba platí v tom prohlížeči, dokud se nezmění.

Caddy odpovědi bez délky (chunked) posílá průběžně, nic dalšího se v něm
nastavovat nemusí. Ověřeno v Electronu s go2rtc, který nabízel jen
nedostupnou adresu: přepnutí za ~20 s, obraz 1280×720, nahrávka i analýza
přes HTTPS, po obnovení stránky start rovnou přes HTTPS. HLS v Safari
zatím jen podle dokumentace go2rtc, ne naostro.

### Když obraz vypadne

Živý přenos hlídá počet skutečně dekódovaných snímků, ne čas přehrávání –
ten u živého přenosu běží dál, i když z kamery nic nechodí, a prohlížeč
ukazuje černou plochu. Po 7 s bez snímku karta řekne „Obraz se zastavil“
a spojení se obnoví (až 8 pokusů, pak tlačítko Zkusit znovu). Do logu i
CLB1 jde jeden řádek za výpadek s tím, kolik dat, snímků a ztracených
paketů do té doby přišlo: hodně dat a 0 ztracených paketů, pak najednou
nic, znamená, že přestala posílat kamera (nebo tunel); rostoucí ztráty
ukazují na špatnou linku k prohlížeči.

### Prohlížeč

Kamera posílá H.264. Umí ho Chrome, Edge a Safari, na počítači i na
iPhonu. Prohlížeč bez H.264 (např. Chromium v některých Linuxech) dostane
hlášku „Tento prohlížeč neumí obraz H.264 z kamery“. Znovu se pak
nepřipojuje, protože by to nepomohlo.

### Analýza běží sama

Analýza obrazu (pád, dlouhé ležení, prudký pohyb, odchod ze záběru, změny
polohy) nemá tlačítko: běží vždy, když běží obraz a v Událostech je z ní
zapnutá aspoň jedna událost. Vypnete‑li v Událostech všechny, analýza se
zastaví a karta to řekne. Počítač, který ji nezvládne (bez WebGL), to řekne
jednou a dál se nezkouší, dokud se nezmění nastavení nebo neobnoví stránka.
Analýza nic nestojí: model běží v prohlížeči, na VPS ani do internetu nic
neposílá; stojí jen výkon procesoru/grafiky toho počítače.

### Drátěný model

Zaškrtávátko **Drátěný model** na řádku Zobrazení kreslí kostru postavy přes
obraz, i bez spuštěné analýzy; při nahrávání je pak i ve videu. Bez něj se
kostra nekreslí ani při analýze, ta ale běží a zapisuje dál. Režim
**Černé pozadí** kostru ukazuje vždy, protože bez ní by byla jen černá
plocha; režimy soukromí se uplatní hned, model pro kostru se načítá až
po nich. Volbu si prohlížeč pamatuje. Ověřeno na fotce postavy: se
zapnutým modelem je kostra přes ruce, trup i nohy, s vypnutým je na
plátně přesně tolik bílých bodů jako na samotné fotce.

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
3. Otevřete **PowerShell jako správce**, přejděte do složky s nimi a spusťte:
   ```
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
   .\u-kamery-windows.ps1 -Konfigurace .\famicura-wg-u-kamery.conf
   ```
   Skript spouštějte přímo, ne přes další `powershell …`. Výstup vnořeného
   PowerShellu prochází kódovou stránkou konzole a čeština se rozsype.
4. Soubor `famicura-wg-u-kamery.conf` smažte na serveru i na Macu.
   Obsahuje soukromý klíč a je v `.gitignore`.

Na serveru se nastaví jen tři věci:

| | |
|---|---|
| služba WireGuard `wg-famicura` | tunel k VPS, naběhne i po restartu. Tunelem jde jen provoz pro VPS (10.77.0.1), běžný provoz serveru do internetu se nemění. |
| `netsh interface portproxy` 0.0.0.0:554 a :2020 → kamera | předává obraz z kamery a její události |
| firewall „Famicura Tapo“ | porty 554, 2020 a ping povolené **jen z VPS** (10.77.0.1) |

Změna IP kamery: `.\u-kamery-windows.ps1 -Kamera 192.168.1.60`.
Odebrání všeho: `.\u-kamery-windows.ps1 -Odebrat` (obojí jako správce,
po `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`).
Skript jde spustit opakovaně. Co už je nastavené, jen znovu nastaví.

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
* Stránka posílá hlavičku Content-Security-Policy (`src/csp.mjs`). Prohlížeč
  smí z ní mluvit jen s naším serverem a stáhnout model a knihovnu MediaPipe
  (cdn.jsdelivr.net, storage.googleapis.com). Nic jiného neodejde: MediaPipe
  se po ukončení kamery pokouší poslat statistiku použití na
  `odml.pa.googleapis.com` a prohlížeč to kvůli CSP odmítne. Obraz jde přes
  WebRTC, kterého se CSP netýká. Ověřeno v Electronu: požadavek na
  `odml.pa.googleapis.com/v1/log` prohlížeč odmítl, model, WASM ani API
  CSP nezablokovalo.
* Z tunelu je dostupná jen kamera, jen RTSP (554), ONVIF (2020) a ping.
  U Windows serveru jen tyto dva jeho porty, přesměrované na kameru.
  Přihlášení k ONVIF je digest (heslo se neposílá), ale bez šifrování –
  proto jde jen tunelem. Ověřeno testy na modelu sítě:
  u Linuxu jsou jiný port kamery, jiný počítač i zařízení samotné
  zablokované. U Windows přišel obraz přes předávání TCP, i když VPS
  kameru napřímo vůbec neviděl.

## Vývoj a testy

```
npm test          # server, přihlášení, go2rtc klient, kamery, plány, analýza, ONVIF, obraz přes HTTPS
```

`test/server.test.mjs` spouští skutečný `server.mjs` proti falešnému go2rtc
a ověřuje, že obraz přes HTTPS prochází průběžně (první kousek do sekundy,
ne až po konci) a že se odběr z go2rtc ukončí, když prohlížeč odejde.
Události kamery se testují proti falešné kameře ONVIF (`test/fake-onvif.mjs`):
ověřuje digest WS-Security i s hodinami o minuty jinak, hlásí témata jako
C210/C220 nebo C200, svou adresu uvádí v místní síti (aby se ověřilo
přepsání na adresu tunelu) a posílá zprávy z fronty včetně „Initialized“ a
času zaseknutého na 1970.

Celou cestu obrazu jsme ověřili naostro: falešná kamera (ffmpeg, RTSP
s heslem, H.264 Main + G.711), dál go2rtc 1.9.14 s konfigurací z
`scripts/set-camera.mjs`, pak `server.mjs` a nakonec prohlížeč s H.264
(Electron/Chrome 152). Test zahrnoval přihlášení, diagnostiku, živý obraz
1280×720 se zvukem, nahrávání, analýzu, plán, sledované události, události
z falešné kamery ONVIF (v editoru je přesně to, co kamera umí; vypnutý
pohyb se nezapíše, osoba ano, bez otevřené analýzy), výpadek obrazu
(kamera zabitá za běhu: do 10 s „Obraz se zastavil“ s údaji o přijatých
datech, po návratu kamery „Spojení obnoveno“) a prohlížeč bez H.264 a
bez WebGL. Pravidla brány na Linuxu i předávání
přes Windows server (prostá TCP proxy jako `netsh portproxy`) jsme ověřili
na modelu sítě se síťovými jmennými prostory. Skript pro Windows prošel
parserem PowerShellu 7.4. Na skutečném Windows ani se skutečnou kamerou
Tapo zatím spuštěný nebyl.
