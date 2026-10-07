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
vozidlo, zvíře, překročení čáry, vstup do hlídané oblasti, zakrytí nebo
posunutí kamery a zvukové detekce (pláč, hlasitý nebo neobvyklý zvuk,
rozbití skla, štěkot, mňoukání – podle modelu). Hlásí je přes ONVIF na
svém portu 2020 a v `GetEventProperties` řekne, které z nich umí. Témata
pojmenovává každý firmware trochu jinak (`PeopleDetector/People` i
`CellMotionDetector/People`, `TPSmartEventDetector/TPSmartEvent` s
`IsVehicle` i `VehicleDetector/Vehicle`), ale jména položek (`IsPeople`,
`IsVehicle`, `IsIntrusion`, `IsBabyCry` …) drží, proto aplikace zařazuje
podle položky (`POLOZKY` v `src/onvif.mjs`). Detektor, který katalog
nezná, se nabídne pod jménem z kamery (např. „Visitor (hlásí kamera)“);
stavy obrazu (`ImageTooDark`) a vstupy zařízení se nenabízí. Server na VPS se ke kameře přihlásí účtem kamery (tím samým, co
go2rtc), založí odběr (PullPoint) a drží ho trvale: každou událost projde
nastavením Sledovaných událostí té kamery a zapíše do CLB1 sám, **i když
nikdo nemá otevřený prohlížeč**. Stránka se každých pár sekund zeptá, co
přišlo, a ukáže to v logu vedle událostí z analýzy. Tapo C220 občas na
jeden dotaz (typicky hned po sérii hlášení) neodpoví; server pak odběr
založí znovu do pár sekund, ztratí se jen to, co kamera hlásila v těch
sekundách. Kamera, která neodpovídá vůbec, se zkouší s rostoucím odstupem.

V kartě **Události** u kamery jsou dvě části: „Z analýzy obrazu v
prohlížeči“ (pád, dlouhé ležení… – běží jen s otevřenou kamerou) a
„Rozpozná kamera sama“ – tam je přesně to, co kamera nahlásila, že umí:
C200 jen pohyb, C210/C220 i osobu, vozidlo, zvíře, překročení čáry, vstup
do oblasti, zakrytí a pláč. V dispečinku (sekce Nastavení) má každá z
těchto detekcí svůj řádek (Hlídat, hodiny, Nahrávat, SMS, E-mail); vozidlo
a zvíře jsou tam výchozí vypnuté, protože v péči o klienta nejsou důvod k
alertu. Každou událost lze
vypnout nebo omezit hodinami (v čase pečovatelů, Europe/Prague, ne serveru).
Bez nastavení je vše zapnuté celý den. Událost je přechod hodnoty na
„true“: Tapo C220 (firmware 1.0.3) posílá během detekce „true“ každých
~100 ms a všechno označuje „Initialized“, takže rozhoduje jen změna
hodnoty, ne označení zprávy. Jedna detekce je jedna událost, ať přišla v
jedné nebo ve sto zprávách; stejná detekce do 5 s po sobě se nepočítá
dvakrát.

### Odkud nahrávka bere obraz

Když je obraz zobrazený tak, jak je (bez rozostření, černého pozadí a
drátěného modelu), nahrává se přímo přenos z kamery. Takové nahrávání
běží i ve chvíli, kdy okno prohlížeče není vidět – zakryté jiným oknem,
minimalizované, zamčená obrazovka. Režimy soukromí a drátěný model
existují jen na kresleném plátně, takže ty se nahrávají z plátna; plátno
se ve skrytém okně nekreslí a nahrávka by byla prázdná. Prázdná nahrávka
se do seznamu ani do složky nedává, místo ní je v logu řádek „Nahrávka …
je prázdná – okno prohlížeče nebylo vidět“. Obnova spojení ukončí
nahrávku běžící z přenosu (další událost začne novou).

### Ukládání nahrávek

V Chromu a Edgi na počítači se každá hotová nahrávka zapíše hned do složky
zvolené tlačítkem **Vybrat složku pro videa** (typicky složka Disku Google,
která ji sama nahraje). Co se nestihlo – nahrávky z doby, než byla složka
vybraná, nebo než prohlížeč po obnovení stránky znovu potvrdil přístup – se
dopíše, jakmile je složka k dispozici, a každou minutu se to zkouší znovu.
Safari (Mac i iPhone) do složky zapisovat neumí; místo toho je tam
zatržítko **Každou hotovou nahrávku rovnou stáhnout**, po němž jde každá
nahrávka sama do složky Stažené soubory prohlížeče.

Ruční nahrávku pořídí dispečink (Nahrát teď) i rodina u své kamery (Nahrát
15 s v aplikaci rodiny, `POST /api/nahravky/rucni`); obojí zapíše řádek
„Ruční nahrávka“ do historie. Nahrávku ze serveru dispečink také stáhne (⬇ stáhnout, `?stahnout=1`):
server soubor dešifruje a pošle jako přílohu pod názvem nahrávky; stažení
je v auditu (`A_KAM_Prehrani`, Kdo „… (stažení)“). Rodina jen přehrává.

### Hlídání místa na serveru (od 2.6)

Mazání běží každou hodinu ve třech krocích (`nahravky.promaz`): nahrávky
starší než doba uchování poskytovatele (⚙, výchozí 30 dnů); nad limit
místa poskytovatele (⚙ Limit místa nahrávek, výchozí 2 GB, 0 = bez
limitu) nejstarší nahrávky toho poskytovatele; a pojistka disku: když je na
disku VPS volno méně než `NAHRAVKY_MIN_VOLNE_GB` (`.env`, výchozí 5 GB),
nejstarší nahrávky napříč poskytovateli, dokud není volno zpět nad
hranicí (log `[nahravky] POZOR`). Dispečink ukazuje oranžový proužek, když
je místa málo nebo je poskytovatel u limitu; ⚙ Nastavení ukazuje obsazení
z limitu a volné místo. Dlouhodobý archiv řeší kopie na Google Disk
(⚙ Google Disk), která se ze serveru nemaže.

### Log událostí za období a export do Excelu (od 2.5)

V detailu kamery (Monitoring → Historie) jde zvolit období *od–do* (dny
pražského času) a zobrazit události přímo z databáze PeceDomaPlus
(`A_KAM_Udalost`), jedné kamery nebo všech kamer poskytovatele; *Stáhnout
do Excelu* uloží sešit `.xlsx` se všemi sloupci (datum, čas, kamera,
událost, závažnost, zdroj, text, stav, kdo převzal, převzato, uzavřeno,
výsledek, poznámka, eskalace, SMS a e-mail odesláno/příjemci, nahrávka,
původ kamera/simulace). Endpoint `GET /api/udalosti?od=RRRR-MM-DD&do=…&kamera=…&format=xlsx`
(bez `format` JSON pro stránku) je jen pro dispečera a správce; sešit
skládá `src/xlsx.mjs` (ZIP + XML, bez knihoven). Nahrávka po události,
která se nepořídila, má důvod v Nahrávkách i v historii (řádek bez souboru
v `A_KAM_Nahravka`) a v logu serveru (`[nahravky]`).

### Úložiště nahrávek na serveru (od 2.2, doporučené)

⚙ Nastavení → **Úložiště nahrávek**: *Na serveru* (výchozí) nebo *Google
Disk poskytovatele* (níže). Na serveru:

- **Soubory** v `DATA_DIR/nahravky/<tenant>/<id>.enc`, šifrované AES-256-GCM
  klíčem `NAHRAVKY_KLIC` (`src/uloziste.mjs`; 32 B base64url, generuje
  `vps-env.sh`, při ztrátě klíče jsou staré nahrávky nečitelné). Nahrávka
  z prohlížeče (hlavní aplikace, `POST /api/nahravky`) zůstává v režimu,
  ve kterém byla pořízena: rozostřená zůstane rozostřená. Nahrávka ze
  serveru po události (go2rtc) je plný obraz, proto platí pravidlo
  soukromí níže.
- **Přehrávání jen v aplikaci** (`GET /api/nahravky/:id/soubor`, s Range
  pro posouvání): dispečink a správce tenanta, rodina jen u svých kamer
  (karta Nahrávky v aplikaci rodiny, 🎞 u události v historii). Každé
  přehrání (celé nebo od začátku) se zapíše do auditu `A_KAM_Prehrani`
  (kdo, role, čas, adresa); dispečink ho vidí přes
  `GET /api/nahravky/:id/audit`. Nahrávka na Google Disku se otevře
  přesměrováním (také s auditem).
- **Mazání**: automaticky po době uchování (⚙ *Uchovat nahrávky*, 1–365
  dnů, výchozí 30), kontrola každou hodinu (`nahravky.promaz()`), soubor
  zmizí a řádek dostane `SmazanoCas`; ručně `DELETE /api/nahravky/:id`
  (dispečink). Nahrávky na Google Disku server nemaže.
- **Evidence v CLB1**: každá uložená nahrávka jde i do
  `FamicuraRingNahravky` (Soubor = název, Složka = `server:<tenant>` nebo
  `Google Disk <účet>`, Zdroj = rucni / plan / udalost).
- **Google Disk zapnout/vypnout** (od 2.3, ⚙ zaškrtávátko Google Disk,
  `nahravkyDisk`): zapnuto = kopie každé nahrávky na Disk vedle serveru
  (řádek má `Soubor` i `Url`), vypnuto = na Disk se nic neposílá. Chyba
  Disku se zapíše k řádku, nahrávka na serveru zůstává.
- **Místo** (od 2.3): `GET /api/nahravky/stav` vrací `misto` (soubory, bajty
  nahrávek tenanta na serveru, volné a celkové místo disku VPS přes
  `statfs`); ⚙ to ukazuje u části Nahrávky na serveru.
- Bez `NAHRAVKY_KLIC` se ukládá na Google Disk (je-li nastavený) a naopak;
  bez obojího server nahrávku nepořídí a řekne to.

### Otáčení kamery (od 2.3)

Tapo C200/C210/C220 mají otočnou hlavu a ONVIF PTZ na stejném portu (2020)
a účtu jako události. `src/ptz.mjs` + `onvif.ptz(smer)`: `GetCapabilities`
→ adresa služby PTZ (přepsaná na adresu v tunelu), `GetProfiles` → profil
s `PTZConfiguration`, krok = `ContinuousMove` (rychlost 0,5, 400 ms) a
`Stop`; `home` = `GotoHomePosition`. `POST /api/ptz { kamera, smer }`
smí každý, kdo kameru smí vidět (rodina jen svou); jeden pohyb na kameru
najednou (409), kamera bez PTZ nebo bez odpovědi 502. Kříž šipek je na
obraze v detailu dispečinku a v aplikaci rodiny (`.ptz` v `proto.css`).

### Nahrávky na Google Disku poskytovatele (od 2.1)

Stejný princip jako Export dat v Péče doma plus: poskytovatel má Google
účet připojený jednou v portálu Plus (Export dat → Připojit Google účet)
a v Google se nic dalšího nenastavuje. Aplikace `pecedomaplus-kamera-disk`
na jhn-apps (repozitář WEB-PeceDomaPlus) zná jeho token z Exportu dat,
drží adresář „Famicura Kamera – <poskytovatel>“ (`KAMERA_SLOZKA_*`
v `A_MSPPP_Nastaveni`) a tomuhle serveru dá na hodinu access token jen
pro nahrání (rozsah `drive.file`). Server se jí hlásí hlavičkou
`x-app-token` (`JHN_APPS_TOKEN`) a klíčem `FAMICURA_KAMERA_KLIC` – stejná
hodnota v `.env` obou aplikací; `vps-env.sh` ji vygeneruje a opíše
(`deploy/sdilej-klic-jhn.sh`, jhn-apps se restartuje).

- **Adresář** zakládá dispečink: ⚙ Nastavení → Nahrávky na Google Disku
  (`GET /api/nahravky/stav`, `POST /api/nahravky/slozka`).
- **Nahrává server** (`src/nahravky.mjs`): po události se zatrženým
  Nahrávat (sekce Nastavení v detailu kamery) vezme z go2rtc
  `stream.mp4?duration=N` (⚙ → Nahrávka po události, 5–60 s, výchozí 15;
  jen obraz H.264 beze změny) a nahraje ho na Disk (`src/disk.mjs`,
  resumable upload). Řádek je v `A_KAM_Nahravka` tenanta (čas, délka,
  velikost, událost, odkaz, chyba), odkaz 🎞 u události v historii
  a v seznamu Nahrávky v detailu (`GET /api/nahravky?kamera=`); tlačítko
  **Nahrát teď** (`POST /api/nahravky/rucni`). Jedna nahrávka na kameru
  najednou. Od 2.7 má server i obraz před událostí: `src/zasobnik.mjs`
  čte trvale proud každé kamery s poskytovatelem (`stream.mp4?video=h264`,
  fMP4) a drží posledních `NAHRAVKY_NABEH_S` sekund (výchozí 12) v paměti;
  klip = inicializace + fragmenty od posledního klíčového snímku před
  (teď − náběh) + dalších N sekund, časy tfdt přepsané od nuly. Náběh
  nastavuje poskytovatel (⚙ Obraz před událostí, 0–10 s, výchozí 5). Bez
  běžícího zásobníku (kamera nejede) jde klip postaru od spuštění.
  Klip se při ukládání převede přes `ffmpeg -c copy -movflags +faststart`
  (`src/remux.mjs`) na obyčejný MP4, který přehraje Safari na iPhonu; bez
  ffmpeg na VPS (`apt install ffmpeg`) zůstane fragmentovaný.
  Události kamer zpracovává server ve smyčce každé 2 s (`najemci.krok`),
  takže nahrávka, SMS i e-mail odcházejí hned i bez otevřené stránky.
- **Soukromí:** `smiNahravat` – nahrávka je vždy v plném obrazu. Při plném
  obrazu povoleném rodinou (nebo u kritické události s nouzovým přístupem)
  volně; při rozostření nebo drátěném modelu rodiny **uzamčená** (od 3.0):
  řádek má `Zamek = 1`, rodina ji ve své aplikaci přehraje, poskytovatel
  dostane na `/api/nahravky/:id/soubor` HTTP 423, dokud ji rodina
  neodemkne (`POST /api/nahravky/:id/odemknout`, jen rodina kamery; zapíše
  `OdemklKdo`, `OdemklCas` a řádek souhlasu do historie). Při „žádný obraz“
  se nenahrává nic a u události je důvod.
- **Hlavní aplikace** pošle každou hotovou nahrávku (ruční, plán,
  událost z analýzy) na `POST /api/nahravky?kamera=…` (tělo video/webm
  nebo mp4, až 64 MB) a server ji uloží na Disk poskytovatele kamery;
  odkaz je u nahrávky v seznamu. Složka v prohlížeči a CLB1 fungují dál.

### Nahrávka po události

U každé události (z analýzy i z kamery) je zatržítko **nahrávat**: když
nastane, prohlížeč, který má kameru otevřenou, nahraje následující sekundy.
Délka je pro kameru jedna, posuvník **Délka nahrávání události** 5–30 s
(výchozí 15). Nahrávka se objeví v seznamu s poznámkou „událost: …“ a do
CLB1 jde se zdrojem `udalost`. Ručně nebo plánem spuštěné nahrávání má
přednost (událost ho nepřeruší); nahrávku spuštěnou událostí každá další
událost prodlouží, takže rušná minuta je jeden soubor. Nahrává se jen
tam, kde je kamera otevřená – server sám nenahrává.

**Obraz před událostí** (posuvník 0–10 s, výchozí 5): dokud je u některé
události zatrženo nahrávat a obraz hraje, prohlížeč obraz průběžně kóduje
do vyrovnávací paměti (dva střídající se záznamy, ten starší má vždy
aspoň zvolené sekundy plus 3 s rezervy na to, že událost kamery přichází
do stránky dotazem každé 3 s). Událost ten starší záznam převezme a jen
pokračuje, takže soubor začíná nejméně zvolený počet sekund před
událostí (a nejvýš dvojnásobek plus 6 s) a v seznamu má poznámku „(N s
před ní)“. Stojí to trochu výkonu, i když se nic neděje; na nule se nic
dopředu nekóduje a nahrávka začne až událostí. Ruční a plánované nahrávání
paměť na tu dobu pozastaví.

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
i takovou, kterou katalog nezná; když kamera na dotaz neodpoví, vypíše
to a odběr založí znovu, stejně jako server. Firmware Tapo 1.3.4 a 1.3.5 (jaro 2023)
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

## Prototyp prostředí pro role (rodina, dispečink, provoz)

Verze všech aplikací je na jednom místě (`public/verze.js`, teď **2.3**) a
ukazuje se v hlavičce hlavní aplikace, rodiny, dispečinku i provozu.
Na `/proto/` jsou tři
simulovaná prostředí podle zadání pro vývojáře: **rodina** (telefon:
obraz normální, rozostřený nebo na černém pozadí, drátěný model jde
zapnout k plnému i rozostřenému obrazu a na černém pozadí je vždy; tahle volba vlastního zobrazení je schovaná za
tlačítkem Test obrazu a zavřením testu se vrátí plný obraz;
notifikace, historie; karta **Přístup poskytovatele** říká, co
poskytovatel vidí teď a proč, má rychlé přepnutí Plný obraz / Rozostřený obraz /
Drátěný model platné do další změny nebo do střídání den/noc, nastavení
podle denní doby včetně časů, kdy den a noc začínají, a nouzový přístup;
**Klid** na 2 hodiny, do rána, do večera, do vypnutí; žádost poskytovatele
o plný obraz přijde přes celou obrazovku, bliká a zní, dokud ji rodina
nepovolí, neodmítne nebo nezavře), **dispečink poskytovatele** (dlaždice
pacientů v režimu, který rodina povolila, fronta alertů s převzetím a
uzavřením, eskalace po 2 minutách, žádost o plný obraz, nouzový přístup;
dlaždice jsou **jen kamery přiřazené poskytovateli (tenantovi)**, žádné
demo; dispečink se otevírá odkazem s ID tenanta
(`/proto/dispecink.html?tenant=22202480FAMICURA`, ID si prohlížeč pamatuje)
a bez přihlášení server místo `dispecink.html` a `provoz.html` pošle
`prihlaseni.html` (žádná aplikace ani data): dispečer se přihlásí účtem
Péče doma plus, správce serveru heslem správce, a dispečink naběhne
s obrazem kamer; v záhlaví je poskytovatel, kdo je přihlášen a Odhlásit; pod obrazem v detailu je trvalá
**Poznámka ke klientovi** (upravuje poskytovatel, změna jde do logu);
u každé kamery jsou **poznámky dispečinku** (datum, čas a jméno se doplní samy, zapisují se do logu
kamery jako události a jsou vidět i samostatně; rodina je nevidí);
**⚙** vpravo nahoře
drží všechny údaje poskytovatele a dispečinku, které se kdekoli
zobrazují (název služby, telefon, e-mail, dispečer, směna, záloha
s telefonem, vedoucí s telefonem, po kolika minutách eskaluje nepřevzatý
kritický alert); název začíná jménem poskytovatele z `dbo.Tenants`, ostatní
pole prázdná; ukládají se k tenantovi a stejně je vidí všichni jeho dispečeři, detail kamery,
karta Směna i aplikace rodiny; jméno dispečera se zapisuje k převzetí
alertů a k žádostem o obraz; karta Směna počítá dobu převzetí a podíl
planých poplachů z dnešních alertů; **? Nápověda** otevře okno v grafice
Case manageru s tématy a obrázky obrazovek (`public/proto/napoveda/`,
pořizuje je test v prohlížeči) a záložku **Asistent**: ten odpovídá z nápovědy
(`public/proto/napoveda.js`) přímo v prohlížeči, a když je v `.env`
`ASISTENT_WEBHOOK_URL` + `ASISTENT_WEBHOOK_KLIC` (scénář Make s AI, který
dostane otázku a text nápovědy a vrátí `{ "odpoved": … }`), odpovídá AI
přes `POST /api/proto/asistent`; bez webhooku nebo při jeho výpadku se
vrátí k nápovědě)
a **provoz** (flotila míst, provozní alarmy, diagnostika, průvodce novým
místem). Obraz je skutečný, z vaší kamery, kreslený jednou a do každé
dlaždice zvlášť v jejím režimu (`public/proto/zdroj.js`); drátěný model
se počítá jednou a sdílí. Bez přihlášení nebo bez kamery kreslí náhradní
scénu s animovanou postavou (stojí, sedí, leží). Všechno ostatní je
simulace: pacienti, souhlasy, události, žádosti a notifikace. Data i
akce jsou v `public/proto/sim-core.js`, stejný kód běží v prohlížeči i na
serveru. **Přihlášeným drží stav server, zvlášť pro každého
poskytovatele** (`src/stav-tenant.mjs`, `GET /api/proto/stav`,
`POST /api/proto/akce`, tabulky `A_KAM_*` v databázi PeceDomaPlus, viz
níže): rozostření, které rodina nastaví na telefonu,
vidí dispečink na jiném počítači do 2 s, žádost dispečinku o plný obraz
dojde na telefon rodiny a její odpověď zpět. Prohlížeč se každé 2 s ptá
na číslo verze a stáhne stav jen při změně; skutečné události kamery do
něj skládá server sám. Bez přihlášení (ukázka) zůstává stav jen v tom
prohlížeči, sdílený mezi okny přes localStorage a BroadcastChannel.
Panel **Simulace** má aplikace rodiny jen na vyžádání
(`/proto/rodina.html?simulace=1`) nebo v ukázce (`?ukazka=1`); skutečná
rodina ho nevidí. Dispečink a provoz ho mají vždy.
Hodiny (noc 22–6, „jen v hodinách“) se počítají v pražském čase i na
serveru v UTC. Panel **Simulace** vlevo dole vyvolá pád, překročení
čáry, SOS z náramku, výpadek kamery, žádost dispečera o plný obraz nebo
noc (události jdou do dat tenanta jako skutečné, jen bez příznaku
„skutečná“); tlačítko Vynulovat je jen v ukázce bez přihlášení, data
poskytovatele se nenulují. Nastavení aplikace (plány, sledování, kamery)
to nemění.

### Poskytovatelé (tenanti) a databáze Péče doma plus

Od verze 2.0 nemá kamerové sledování žádný společný „prototypový“ stav:
**každý poskytovatel má svá data** a pozná se stejně jako v portálu Péče
doma plus, podle **ID tenanta** (`dbo.Tenants` v databázi `PeceDomaPlus`,
např. `22202480FAMICURA` = FamiCura s.r.o.). Do Softru se nepíše nic.

- **Tabulky** (`src/tabulky.mjs`, zakládá je server při startu, jen když
  chybí): `A_KAM_Kamera` (kamera = klient: název, místo, poznámka, souhlas
  rodiny, sledování, kontakty, dočasné nastavení, klid), `A_KAM_Udalost`
  (události a alerty včetně převzetí, uzavření, eskalace a výsledku
  upozornění), `A_KAM_Zadost` (žádosti o plný obraz), `A_KAM_Povoleni`
  (platná povolení a kdo se dívá), `A_KAM_Nastaveni` (údaje poskytovatele,
  notifikace), `A_KAM_Nahravka` (nahrávky na Google Disku) a `A_KAM_UzivatelRodiny` (účty rodiny: scrypt hash hesla,
  SHA-256 pozvánky, kamery). Každá má `IDTENANT char(16)` s výchozí
  hodnotou `SESSION_CONTEXT('IDTENANT')`, primární klíč začíná tenantem a
  tabulka je ve stejné politice Row-Level Security (`sec.TenantPolicy`,
  `sec.fn_TenantPredicate`) jako ostatní tabulky Plus. Každá dávka začíná
  `EXEC sp_set_session_context 'IDTENANT'`, takže databáze pustí jen
  řádky tenanta; dotazy navíc filtrují `IDTENANT` i samy.
- **Spojení**: `PDP_SQL_SERVER` / `PDP_SQL_PORT` (prázdné = stejný server
  jako CLB1), `PDP_SQL_DATABASE=PeceDomaPlus`, `PDP_SQL_USER=pecedomaplus_app`,
  `PDP_SQL_PASSWORD` (`src/pdp.mjs`). Bez hesla server běží jen pro ukázku
  bez přihlášení a při startu to hlásí. Vývoj bez SQL Serveru:
  `PDP_FAKE_TENANTS="22202480FAMICURA=FamiCura s.r.o."` drží tenanty
  a tabulky jen v paměti procesu.
- **Stav tenanta** (`src/stav-tenant.mjs`, registr `src/najemci.mjs`): při
  prvním použití se načte z tabulek, akce jsou tytéž jako v prohlížeči
  (`sim-core.js`), po každé změně se zapíšou jen změněné řádky (otisk
  řádku). Skutečné události kamer tenanta do něj skládá server sám a hned
  posílá upozornění (`src/upozorneni.mjs`). Akce patří jen kamerám
  tenanta (cizí kamera 404), vynulování neexistuje.
- **Kamera patří tenantovi**: v `cameras.json` má pole `tenant` a `place`;
  `./deploy/vps-kamera.sh` se na ně ptá při zavedení kamery, dodatečně
  `./deploy/vps-kamera.sh tenant tapoc2020 22202480FAMICURA "Kancelář"`.
  Kamera bez tenanta se v žádném dispečinku neukáže (hlavní aplikace ji
  vypíše jako „bez poskytovatele“).
- **Přihlášení** (`src/session.mjs`): cookie nese tenanta a roli. Dispečer
  = účet Péče doma plus (`POST /api/dispecink/login { tenant, login, heslo }`
  → aplikace `pecedomaplus-auth` na aplikačním serveru jhn-apps,
  `JHN_APPS_URL` + `JHN_APPS_TOKEN`, `src/dispecer.mjs`; heslo se zde
  neukládá ani neověřuje); správce serveru = `FAMICURA_PASSWORD` plus
  zvolený tenant (`POST /api/login { password, tenant }`), v dispečinku
  vystupuje jako „Správce“; rodina = telefon a heslo z tabulky tenanta.
  Stránka `prihlaseni.html` vezme tenanta z odkazu (`?tenant=`), ověří ho
  (`GET /api/tenant?id=`), uloží do prohlížeče a z adresy ho odstraní.
  Každé API s daty (`/api/proto/*`, `/api/rodina/*`, `/api/devices`,
  `/api/stream*`, `/api/events`) pracuje jen s tenantem z cookie;
  nastavení serveru (plány, sledování, diagnostika) má jen správce.

### Přihlášení rodiny, účty a pozvánka SMS

Když dispečink požádá o plný obraz, server pošle každému členovi rodiny
s účtem u té kamery SMS (`textZadosti`: ať otevře aplikaci a žádost povolí
nebo odmítne); dispečink vidí, kolika lidem odešla. Bez `SMS_WEBHOOK_URL`
se SMS neposílá a dispečink to ví.
Heslo v SMS není: rodina si ho zvolí sama po otevření odkazu. Platný odkaz
z pozvánky má přednost před čímkoli přihlášeným v tom prohlížeči (jiný člen
rodiny, nebo poskytovatel, který odkaz zkouší u sebe): vždy ukáže volbu
hesla pro nového člena. Změna hesla: karta Můj účet → Změnit heslo.

Aplikace rodiny je jen pro přihlášené. Princip je z aplikace pacienta Péče
doma (kód z SMS od centrály), navíc s heslem, protože rodina vidí obraz:

1. **Poskytovatel založí účet** v dispečinku (detail skutečné kamery →
   Uživatelé rodiny): jméno a telefon. Server připraví pozvánku: krátký odkaz
   `/r/<token>` (server ho přesměruje na `/proto/rodina.html?pozvanka=…`),
   platný 7 dní a na jedno použití. SMS je bez diakritiky a vejde se do
   dvou dílů; radí i, jak si aplikaci dát na plochu. Použitý odkaz vede
   rovnou na přihlášení (nebo do aplikace, když je rodina ještě přihlášená).
2. **Pozvánka jde SMS**: ze serveru webhookem Make (`SMS_WEBHOOK_URL`,
   `SMS_WEBHOOK_KLIC` v `.env`), nebo tlačítkem
   „Poslat SMS z tohoto telefonu“ z dispečerova mobilu, nebo zkopírovaným
   odkazem. Bez webhooku se SMS ze serveru neposílá a dispečink to vidí.
3. **Rodina otevře odkaz**, zvolí si heslo (aspoň 8 znaků, ne jen číslice)
   a je přihlášená. Dál se přihlašuje telefonem a heslem; cookie platí
   30 dní, takže na telefonu jednou za měsíc. Heslo si změní v „Můj účet“.
   Zapomenuté heslo řeší poskytovatel novou pozvánkou (stará přestane platit).
4. **Jak SMS odchází (Twilio přes Make).** Server pošle na webhook scénáře
   **Famicura_Tapo_SMS_Pozvanka** (Make, id 9896185) JSON `{ klic, telefon,
   text, typ, poznamka }`. Scénář ověří klíč, pošle SMS modulem **Twilio –
   Send SMS** ze stejného spojení a čísla (+420 736 354 150) jako scénář
   „JARVIS poslání SMS přes Twilio“, zapíše záznam do tabulky SMS v Softru
   (autor „Famicura Kamera“) a odpoví `{"ok":true,"sid":"SM…"}`. Server bere
   SMS za odeslanou **jen** s touhle odpovědí (jako portál Péče doma plus):
   holé „Accepted“ od Make znamená, že požadavek neprošel filtrem (jiný klíč)
   nebo scénář neběží, a dispečink dostane chybu místo falešného „odesláno“.
   Do 3. 10. 2026 scénář posílal přes SMSzasilam jako Péče doma; běhy byly
   „úspěšné“, ale SMS nedocházely, proto Twilio. Ověření bez zakládání účtu:
   ozubené kolečko v dispečinku → **SMS rodině → Poslat zkušební SMS** na
   vlastní číslo (`POST /api/sms/test`, jen poskytovatel). Když nedojde:
   v Make otevřít historii scénáře; běh s **1 operací** = špatný klíč
   (`SMS_WEBHOOK_KLIC` musí být ten z filtru scénáře), chyba u modulu Twilio
   = číslo nebo kredit Twilia; v logu serveru (`pm2 logs famicura-tapo`)
   jsou řádky `[sms] …456: odesláno (…)` nebo důvod chyby (bez textu SMS).
5. **Upozornění na události SMS a e-mailem.** V detailu kamery v dispečinku
   (sekce Komunikace → Kontakty pro upozornění) jdou zadat až tři česká
   mobilní čísla a tři e-maily; v sekci Nastavení se u každé události
   zatrhne Nahrávat, SMS a E-mail (kritické mají SMS i e-mail předem).
   Server po každé zapsané události (skutečné z kamery i simulované; stav
   prototypu, `src/proto-stav.mjs`) pošle přes `src/upozorneni.mjs` SMS
   (bez diakritiky, do 160 znaků: klient, událost, čas, telefon dispečinku)
   a e-mail s podrobnostmi a odkazem na aplikaci rodiny (`PUBLIC_URL`).
   E-mail jde stejným webhookem jako SMS s `kanal: "mail"` (scénář má router:
   SMS → Twilio, e-mail → modul Microsoft 365 Email ze schránky Centrum LB);
   výsledek se zapíše k události (`upozorneni`) a dispečink ho vidí v historii.
   Nic neodchází u kamery deaktivované rodinou (od 3.2, viz CHANGELOG) ani
   u události vypnuté nebo mimo hodiny (od 3.1 se skutečná
   událost z kamery mimo hodiny zapíše do deníku jako informační řádek
   „(mimo hlídané hodiny …)“, uzavřený, bez alertu a bez nahrávky).
6. **Stejné přihlášení platí pro obraz a události** z hlavní aplikace: uživatel
   rodiny smí `/api/devices`, `/api/stream*`, `/api/events` jen pro své kamery,
   nic z nastavení (`403`). Do hlavní aplikace (nastavení, diagnostika)
   se dál přihlašuje jen poskytovatel heslem Famicura; jeho cookie platí
   i v dispečinku a v aplikaci rodiny.

Účty jsou v tabulce `A_KAM_UzivatelRodiny` tenanta (PeceDomaPlus): heslo jen
jako scrypt hash, pozvánka jen jako SHA-256 tokenu; telefon je jedinečný
v rámci tenanta. Přihlášení rodiny má stejný limit pokusů jako heslo
Famicura. Bez přihlášení nabízí stránka rodiny **ukázku** (simulace bez
skutečné kamery), aby šel prototyp dál předvádět.

### Aplikace rodiny na ploše telefonu

`/proto/rodina.html` jde uložit na plochu jako aplikace: má manifest
(`public/proto/rodina.webmanifest`, ikony v `public/proto/ikony/`),
ikonu pro iPhone (`apple-touch-icon`) a servisní skript `public/proto/sw.js`.
Ten nic nekešuje, obraz i události jsou živé; je tu kvůli instalaci a
stránce „jste bez připojení“. Stránka sama ukáže kartu **Aplikace na
telefonu** s postupem pro iPhone (Sdílet → Přidat na plochu) a Android
(nabídka → Přidat na plochu, nebo rovnou tlačítko Nainstalovat), a skryje
ji, jakmile běží z plochy. Rodina se přihlašuje přímo v aplikaci (telefon
a heslo, cookie 30 dní). Odkaz na přihlášení poskytovatele z ostatních
stránek prototypu otevře hlavní aplikaci ve stejném okně (nové okno by
iPhone poslal do Safari) a ta se po přihlášení vrátí zpět
(`/?zpet=/proto/dispecink.html`; přijímá jen cesty do `/proto/`). Ikony vznikly
skriptem v Pillow (srdce s křivkou tepu v modré Famicury); zdroj je
v historii gitu u tohoto commitu.

## Verze

Číslo verze je v `public/verze.js` (teď 3.4) a vidí ho každá aplikace
v hlavičce. Nová verze = tři kroky v jednom commitu: změnit číslo v
`public/verze.js`, dopsat odstavec do `CHANGELOG.md` a do tématu „Co je
nové“ v `public/proto/napoveda.js`, a po nahrání označit commit:
`git tag -a v2.4 -m "Famicura Kamera 2.4" && git push origin v2.4`.
Drobné opravy mezi verzemi číslo nemění.

## Prezentace a video

`docs/prezentace/` drží prodejní prezentaci (`Famicura-Kamera-pribeh-po-instalaci.pptx`,
16 slidů s obrázky obrazovek a QR kódy), scénář namluvení po slidech
(`scenar-videa.md`, i s postupem, jak z toho udělat video v PowerPointu,
Keynote nebo s umělým hlasem) a titulky `titulky.srt` ve stejném časování.
Video samotné se do gitu neukládá.

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

### 2c. Brána GL.iNet Mango místo Windows serveru

Malý router GL.iNet Mango (GL-MT300N-V2) nahradí Windows server i jeho
firewall: kamera se připojí na Wi-Fi Manga, Mango se připojí k internetu
klienta (kabelem do WAN, nebo jako opakovač jeho Wi-Fi) a naváže tunel
WireGuard k VPS. Je to stejný režim jako Raspberry Pi (`linux`): VPS vidí
přímo kameru. Nastavení ve webovém rozhraní Manga, bez skriptů na zařízení.

1. Mango zapojte do napájení, připojte se na jeho Wi-Fi (jméno a heslo
   jsou na štítku zespodu) a otevřete http://192.168.8.1. Nastavte heslo
   správce a připojení k internetu: kabel do portu WAN, nebo
   **Repeater** na Wi-Fi v místě.
2. Kameru připojte na Wi-Fi Manga (Tapo: kameru resetovat, v aplikaci Tapo
   nastavit znovu a zvolit síť Manga; znovu založit **Účet kamery**).
   V Mangu ve **Clients** kameře zamkněte IP adresu (statický DHCP).
3. Na Macu: `./deploy/wireguard-vps.sh <IP kamery v síti Manga>` (bez
   `--windows`). Vznikne `famicura-wg-u-kamery.conf`.
4. V Mangu **VPN → WireGuard Client → New Group → Add Manually**: vložte
   obsah `famicura-mango.conf` (stejná konfigurace bez řádků `#`, které
   GL.iNet odmítá; `cat famicura-mango.conf | pbcopy`), Apply, Connect.
   Pak **VPN Dashboard → ozubené kolo**: Proxy Mode „Based on the Target
   Domain or IP“ s adresou 10.77.0.1 (Global Proxy by Mangu vzal internet),
   „Allow Remote Access LAN“ zapnuto, „Block Non-VPN Traffic“ vypnuto. Oba
   soubory `.conf` pak smažte, mají soukromý klíč.
5. Firewall Manga provoz z tunelu ke kameře sám nepustí („Allow Remote Access
   LAN“ ve firmwaru 4.3 nestačí a ruční úprava zóny v LuCI se po dalším
   připojení VPN ztratí; LuCI navíc při Save & Apply končí „XHR timeout“).
   Pravidlo se zapíše přes SSH do Manga (Mac na Wi-Fi Manga, heslo správce
   Manga, IP kamery z kroku 2):
   ```
   ssh root@192.168.8.1 "uci add firewall forwarding; uci set firewall.@forwarding[-1].name='famicura_wg_lan'; uci set firewall.@forwarding[-1].src='wgclient'; uci set firewall.@forwarding[-1].dest='lan'; uci add firewall rule; uci set firewall.@rule[-1].name='Famicura kamera'; uci set firewall.@rule[-1].src='wgclient'; uci set firewall.@rule[-1].dest='lan'; uci set firewall.@rule[-1].dest_ip='192.168.8.211'; uci set firewall.@rule[-1].proto='all'; uci set firewall.@rule[-1].target='ACCEPT'; uci commit firewall; /etc/init.d/firewall restart"
   ```
   Výpis varování `[!] Section … fw4` je normální. Po resetu Manga se
   příkaz spouští znovu (a před ním `ssh-keygen -R 192.168.8.1`, Mango má
   nový klíč).
6. Na Macu `./deploy/vps-kamera.sh`: zadáte IP kamery z kroku 2 a účet
   kamery. Ověření z VPS:
   `ping -c 2 <IP kamery>; nc -zv -w 5 <IP kamery> 554` (má být
   „2 received“ a „succeeded“; „Destination Port Unreachable“ nebo
   „Connection refused“ od 10.77.0.2 znamená, že chybí krok 5).

Tunel SSH z Windows (2b) ani WireGuard na Windows pak nejsou potřeba; VPS
přepne `vps-kamera.sh` automaticky podle `/etc/wireguard/famicura-rezim`
(po kroku 3 je `linux`).

### 2d. Další místo: kamera u jiného poskytovatele

Každý poskytovatel (nebo každá adresa) má svou bránu, nejčastěji další
Mango, a v tunelu vlastní **místo**: číslo 1, 2, 3… Místo je jeden `[Peer]`
`wg-famicura` s adresou `10.77.0.(místo+1)`; soubory jsou v
`/etc/wireguard/famicura-mista/<N>.peer|rezim|kamera` a `wg-famicura.conf`
se z nich skládá. Nové místo ostatní místa nechá být (první kamera
nevypadne); stejné číslo znovu vydá tomu místu nový klíč.

1. Nové Mango nastavte podle 2c (kroky 1 a 2: internet, kamera na jeho
   Wi-Fi, zamčená IP). Síť Manga může zůstat 192.168.8.x, jen kamera
   nesmí mít stejnou IP jako kamera jiného místa (tunel míří na IP kamery);
   nejjistější je Mangu dát jinou síť (System → LAN IP, např. 192.168.9.1).
2. Na Macu: `./deploy/wireguard-vps.sh <IP kamery> --misto 2`. Vznikne
   `famicura-wg-misto-2.conf` a `famicura-mango-misto-2.conf`; do Manga
   a jeho firewallu podle 2c (kroky 4 a 5), pak oba soubory smazat.
3. `./deploy/vps-kamera.sh`: když je míst víc, zeptá se na číslo místa;
   dál ID kamery (jiné než u ostatních kamer), název, IP kamery, ID tenanta
   toho poskytovatele, místo, účet kamery. Dispečink poskytovatele kameru
   ukáže hned (`?tenant=<jeho ID>`).

Více kamer na jednom místě (stejné Mango): jen `vps-kamera.sh` s další
IP a ID; v Mangu přidejte pravidlo firewallu i pro její IP (krok 5 v 2c).
Windows server jako brána dalšího místa: `--windows --misto N`, go2rtc pak
chodí na `10.77.0.(N+1)`.

### 2b. Když firewall serveru tunel nepustí: tunel SSH

Příznak: tunel WireGuard na obou stranách hlásí čerstvý handshake, server
z VPS ping dostane (počítadlo *received* v `wg show` roste), ale sám nic
neodpoví a porty 554 a 2020 z VPS nejdou. Tak se chová firewall třetí
strany na serveru (typicky ESET), který síť tunelu bere jako veřejnou a
příchozí spojení zahodí, i když ho pravidla firewallu Windows pouštějí.
Bez hesla k tomu firewallu to nikdo neopraví.

Řešení bez zásahu do firewallu: spojení navazuje **server směrem ven**
na port 22 VPS (odchozí spojení firewally pouštějí) a tímhle spojením
přivede kameru na VPS. Nic se na serveru neotevírá zvenku.

| na VPS | vede na |
|---|---|
| `127.0.0.1:10554` | kamera, port 554 (obraz, RTSP) |
| `127.0.0.1:12020` | kamera, port 2020 (události, ONVIF) |

1. Na **Windows serveru** (PowerShell jako správce, ve složce se skriptem
   `deploy/wireguard/u-kamery-windows-ssh.ps1`):
   ```
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
   .\u-kamery-windows-ssh.ps1 -Kamera 192.168.10.109
   ```
   Doinstaluje klienta OpenSSH (součást Windows), vytvoří klíč serveru
   v `C:\ProgramData\Famicura\ssh` (přístup jen správci a SYSTEM), založí
   úlohu plánovače „Famicura Tapo – tunel SSH“ (běží jako SYSTEM, naběhne po
   restartu, po výpadku se připojí znovu do 10 s) a **vypíše veřejný klíč**
   (dá ho i do schránky). Když už na serveru byl tunel WireGuard, IP kamery
   si vezme z jeho konfigurace a `-Kamera` netřeba.
2. Na **Macu** klíč zaregistrujte na VPS:
   ```
   ./deploy/ssh-tunel-vps.sh "ssh-ed25519 AAAA… famicura-tunel@windows"
   ./deploy/ssh-tunel-vps.sh stav        # za chvíli: drží server tunel?
   ```
   Na VPS vznikne účet `famicura-tunel` bez hesla a bez shellu. Jeho klíč má
   v `authorized_keys` `restrict,port-forwarding,permitlisten=…` a sshd má
   pro něj blok `Match User` (`AllowTcpForwarding remote`, `PermitListen`
   jen 10554 a 12020, `PermitOpen none`, `GatewayPorts no`, žádný terminál,
   agent ani X11). Smí tedy jen přivést tyhle dva porty na localhost VPS;
   kam vedou na druhé straně, určuje server u kamery a VPS z jeho sítě nic
   jiného nevidí. `ClientAliveInterval 15` uvolní port po spadlém spojení
   do minuty, jinak by se server po výpadku nemohl připojit znovu.
3. Kameru nastavte jako obvykle: `./deploy/vps-kamera.sh`. Režim `ssh`
   pozná sám (soubor `/etc/wireguard/famicura-rezim` na VPS) a go2rtc i
   odběr událostí pošle na 127.0.0.1:10554 a :12020 (`rtspPort` a
   `onvifPort` v `cameras.json`). Vynucení: `./deploy/vps-kamera.sh --ssh`.

Stav a hledání chyb: na serveru `.\u-kamery-windows-ssh.ps1 -Stav` (úloha,
spojení, konec `tunel.log`), na Macu `./deploy/ssh-tunel-vps.sh stav`.
Dokud VPS klíč nezná, je v logu serveru „Permission denied“; to je před
krokem 2 v pořádku. Odebrání: `.\u-kamery-windows-ssh.ps1 -Odebrat` na
serveru a `./deploy/ssh-tunel-vps.sh odebrat` na Macu. Tunel WireGuard
může zůstat nainstalovaný; nepřekáží.

### 3. Aplikace a go2rtc na VPS

```
./deploy/vps-deploy.sh      # aplikace + go2rtc pod pm2, port 3112, otevře 8555
./deploy/vps-env.sh         # heslo správce; hesla k SQL (CLB1, PeceDomaPlus) a token jhn-apps převezme, klíč vygeneruje; SMS a asistent
./deploy/vps-kamera.sh      # IP kamery, účet kamery (heslo skrytě), název, ID tenanta a místo
```

`vps-kamera.sh` na konci ověří, že kamera posílá obraz. S Windows
serverem se na IP kamery neptá: go2rtc chodí na server v tunelu
(10.77.0.2), nebo s tunelem SSH na 127.0.0.1:10554, a IP kamery zná jen
server. Přihlášení ke
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
| stav | `.env`, `cameras.json`, `go2rtc.yaml`, `data/` (plány, sledované události). Nasazení je nepřepisuje. Data poskytovatelů (kamery, události, souhlasy, účty rodiny) jsou v databázi PeceDomaPlus. |
| go2rtc | verze 1.9.14, stažená z GitHubu a ověřená SHA-256 |

Logy:

```
ssh -i ~/.ssh/id_ed25519_jhnapps root@95.216.201.2 "su - jhnapps -c 'pm2 logs famicura-tapo famicura-go2rtc --lines 50'"
```

### PeceDomaPlus

Tenanti (`dbo.Tenants`) a data každého poskytovatele v tabulkách `A_KAM_*`
(viz „Poskytovatelé (tenanti) a databáze Péče doma plus“). Login
`pecedomaplus_app` (db_owner, stejný jako portál Plus), heslo
`PDP_SQL_PASSWORD` bere `vps-env.sh` z `/opt/jhn-apps/.env`. Tabulky si
server založí sám při prvním startu s heslem; DDL vypíše
`node -e "import('./src/tabulky.mjs').then(m => console.log(m.ddl()))"`.

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
* Stav prototypu na serveru je jen pro přihlášené (poskytovatel i
  rodina) a obsahuje jen ukázková data a simulaci; rodina ho vidí celý,
  protože je to společná ukázka, ne data jiných klientů. Každý vstup
  z prohlížeče se na serveru kontroluje (`sim-core.js`: druh události,
  režim obrazu, hodiny, délky textů, ID), chybný vrací 400. Nastavení
  serveru ani kamer tudy nejde změnit.
* Tunel SSH (2b) otáčí jen směr navázání spojení, ne co je dostupné:
  účet `famicura-tunel` na VPS nemá heslo ani shell a sshd mu dovolí jen
  přivést porty 10554 a 12020 na localhost VPS. Z VPS tunelem ven nic
  nejde (`PermitOpen none`), zvenku na VPS nic nového nevede. Klíč
  serveru leží jen v `C:\ProgramData\Famicura\ssh` s právy pro správce.

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
