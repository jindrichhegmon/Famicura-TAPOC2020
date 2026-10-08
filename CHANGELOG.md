# Změny Famicura Kamera

Verze je na jednom místě v `public/verze.js` a ukazuje se v hlavičce všech
aplikací (hlavní aplikace, rodina, dispečink, provoz, přihlášení). Stejné
číslo nese značka v gitu (`git tag`) a téma „Co je nové“ v nápovědě
dispečinku. Postup nové verze je v README, část „Verze“.

## 3.14 · 8. 10. 2026 · teplota bodytemp2, vypnutí náramku na heslo

- **Změřit teplotu posílá `bodytemp2`** (Beesure/SeTracker: příkaz k okamžitému
  měření); `btemp2` je jen rámec, kterým náramek teplotu hlásí, a jako příkaz
  ho V48 ignoroval.
- **Vypnout náramek** je červené tlačítko a chce **heslo hlavní aplikace
  Famicura** (`FAMICURA_PASSWORD`); `POST /api/naramek/prikaz` s `vypnout`
  bez správného `heslo` vrací 401 a nic neposílá, pokusy brzdí stejný limiter
  jako přihlášení (429).
- Testy: `bodytemp2` do spojení, vypnutí bez hesla / se špatným heslem 401,
  se správným 200.

## 3.13 · 8. 10. 2026 · tep a tlak jedním tlačítkem, odkaz na mapu u poplachu

- **Změřit tep a tlak** je jedno tlačítko (`bphrt`): ReachFar V48 příkaz
  `hrtstart,1` přijme, ale hodnotu tepu neposílá; `bphrt` vrací tlak i tep.
  V automatickém měření je proto jedna volba „tep a tlak“. `btemp2` (teplota)
  V48 neodpovídá – tlačítko zůstává pro jiné modely.
- **Před měřením tlaku, kyslíku a teploty server pošle `hrtstart,1`** a po
  1,5 s vlastní příkaz (z logu: V48 odpovídá na `bphrt`/`oxygen` jen v sekvenci
  za `hrtstart,1`, samotné nechá bez odpovědi); tlačítka tak dávají výsledek
  stejně jako automatické měření. Odpověď API nese `predtim`.
- **Odkaz „mapa“** místo surové adresy Google Map v textu poplachu z náramku
  (záložka Náramek, fronta alertů, historie, aplikace rodiny); otevírá se
  v novém okně (`escOdkazy` v sim.js).
- Pole pro vlastní příkaz a tabulka příkazů (3.12) v dispečinku zrušené;
  `POST /api/naramek/prikaz` s `vlastni` zůstává pro ladění.

## 3.12 · 8. 10. 2026 · seznam příkazů náramku

- **Tabulka příkazů** v záložce Náramek pod polem pro vlastní příkaz: bphrt,
  oxygen, hrtstart,1 / hrtstart,300, btemp2, CR, UPLOAD, FIND, CALL, MONITOR,
  SOS1–3, CENTER, LOWBAT, REMOVE, PEDO, LZ, VERNO, TS, RESET, POWEROFF s popisem;
  klepnutí vloží příkaz do pole. ✔ = ověřeno u ReachFar V48 z logu serveru
  (`bphrt` → tlak 110/68 a tep, `oxygen,1,95`, `hrtstart` přijato, POWEROFF),
  ? = podle dokumentace protokolu. Varování před IP, PW a FACTORY.

## 3.11 · 8. 10. 2026 · mapa polohy, příkazy náramku, automatické měření

- **Mapa poslední polohy** v záložce Náramek (dlaždice OpenStreetMap, zoom 16,
  značka uprostřed; CSP `img-src https://tile.openstreetmap.org`).
- **Příkazy náramku** (`POST /api/naramek/prikaz`, jen poskytovatel, jen do
  právě připojeného náramku): Změřit tep `hrtstart,1`, tlak `bphrt`, kyslík
  `oxygen`, teplotu `btemp2`, Zjistit polohu `CR`, Vypnout náramek `POWEROFF`
  (do historie), vlastní příkaz pro ladění modelu (do historie). Server si
  pamatuje spojení každého náramku a posílá rámec `[3G*ID*DÉLKA*příkaz]`.
- **Automatické měření** (akce `setNaramekAuto`, `Naramek.auto` – interval
  v minutách a veličiny): server každou minutu zkontroluje připojené náramky
  a po uplynutí intervalu pošle zvolená měření.
- Testy: příkazy, 409 bez spojení, vlastní příkaz jen bezpečné znaky,
  automatické měření podle intervalu, API (403 rodina, 400 bez náramku).

## 3.10 · 8. 10. 2026 · záložka Náramek, měření zdraví, poplach V48

- **Detail kamery má záložku ⌚ Náramek** (místo bloku v Komunikaci): přiřazení
  (ID zařízení), stav (poslední ozvání, baterie, poloha), **měření zdraví**
  (poslední hodnoty a tabulka posledních 48 měření: tep, krevní tlak, kyslík,
  teplota) a poplachy z náramku (SOS, pád, slabá baterie).
- **Zdravotní rámce**: `bphrt` (tlak horní, dolní, tep), `heart`/`PULSE` (tep),
  `oxygen` (kyslík %), `btemp2` (teplota) → `A_KAM_Kamera.Naramek.zdravi`
  a `.mereni`; do historie kamery řádek „Měření náramku“ nejvýš jednou za
  hodinu (druh `mereni`, informativní).
- **ReachFar V48**: poplach přichází jako `AL_LTE`, poloha jako `UD_LTE`;
  každý typ začínající `AL` se bere jako poplach a potvrzuje se `AL`. Poloha
  bez GPS fixu (`V`) se souřadnicemi z mobilní sítě se ukládá jako přibližná
  (odkaz „přibližná, z mobilní sítě“). `calllog` a ostatní typy jen do logu.

## 3.9 · 8. 10. 2026 · náramky a přívěsky SOS přímo na server

- **Nouzový přívěsek / hodinky (ReachFar RF‑V48, protokol hodinek jako
  SeTracker) se připojují mobilními daty přímo na server** (`src/naramky.mjs`,
  TCP `NARAMKY_PORT`, výchozí 5093, `vps-deploy.sh` otevře v ufw). Server
  rozumí rámcům `[3G*ID*DÉLKA*OBSAH]` i s indexem, potvrzuje `LK`, `AL`
  a `TKQ`, z `UD`/`AL` čte polohu, baterii a bity stavu (SOS, pád, slabá
  baterie; sejmutí a opuštění oblasti jen do logu).
- **Přiřazení ke kameře v dispečinku:** Komunikace → Náramek / přívěsek SOS
  (akce `setNaramek`, sloupec `A_KAM_Kamera.Naramek` – JSON id, posledni,
  baterie, poloha; server si ho přidá sám). SOS → `sos` (Nouzové tlačítko),
  pád → `devfall`, slabá baterie → `battery`, vše jako skutečné události
  kamery (fronta, SMS, e‑mail, nahrávka). SOS z náramku projde i u kamery
  deaktivované rodinou. Opakovaný poplach do minuty se počítá jednou; neznámé
  ID server jen potvrdí a jednou za hodinu zaloguje.
- V Komunikaci je vidět poslední ozvání, baterie a odkaz na poslední polohu;
  `/api/health` má `naramky` (port, spojení, přijato, poplachy).
- Rodina náramek přiřadit nemůže (403), jen poskytovatel.
- Diagnostika: každý přijatý rámec jde do logu serveru jedním řádkem (`[naramky] ID TYP stav= baterie= poloha= poplachy=`, u polohových typů bez souřadnic); samostatný typ `SOS` se bere jako nouzové tlačítko.

## Nasazení · 8. 10. 2026 · další kamera za stejnou bránou

- **`./deploy/wireguard-vps.sh <IP> --misto N --dalsi`**: další kamera na
  Wi-Fi téhož Manga (nebo za týmž Raspberry Pi). Tunel na VPS pouštěl jen
  adresu kamery z instalace (AllowedIPs peeru), druhá kamera byla ze serveru
  nedosažitelná („go2rtc vrátil 500“, ping bez odpovědi). Nový
  `deploy/wireguard/vps-dalsi-kamera.sh` přidá adresu do AllowedIPs místa
  i do běžícího tunelu (`wg set`, cesta), bez nových klíčů a bez zásahu do
  zařízení; skript vypíše pravidlo firewallu pro Mango. Kontrola „stejná
  kamera na dvou místech“ počítá s více kamerami na místě. README 2d.

## 3.8 · 7. 10. 2026 · návrat kamery na původní záběr, deaktivace bez zamrznutí

- **Po aktivaci se kamera vrací na záběr, který měla před deaktivací.** Server si
  před otočením do stropu přečte polohu kamery (ONVIF `GetStatus`, x/y) a uloží
  ji k deaktivaci (`A_KAM_Kamera.Deaktivace.poloha`); při aktivaci kameru otočí
  `AbsoluteMove` na tu polohu a teprve když to kamera neumí, jede jako dřív
  (výchozí poloha → předvolba → střed). V historii je „kamera se vrací na
  původní záběr“ / „do výchozí polohy“ podle toho, co se povedlo.
- **Deaktivace hned po šipce nekončí chybou „kamera se právě otáčí“:** otočení do
  stropu a zpět počká na dokončení běžícího kroku (`src/ptz.mjs`); krok šipkou
  během jiného pohybu dál vrací 409.
- **Oprava: aplikace rodiny zamrzla a deaktivace se neprovedla, když účet rodiny
  ukazoval na kameru, která už poskytovateli nepatří** (po `vps-kamera.sh tenant …`
  přesunuté k jinému poskytovateli). Server (`/api/rodina/ja`, obraz) teď rodině
  dává jen kamery jejího poskytovatele; když v účtu žádná taková není, stránka
  řekne „Kamera, ke které máte přístup, už u tohoto poskytovatele není…“. Dřív
  stránka kameru založila do stavu, server ji odmítl (403) a aplikace se tiše
  přepnula na místní simulaci – tlačítka vypadala živá, ale nic se nedělo.
- Robustnost klientů: odpověď serveru 403 už nepřepíná stránku do simulace (jen
  401 = odhlášení), každé volání serveru má limit 30 s a hlásí chybu místo
  zamrznutí, tlačítko Deaktivovat/Aktivovat se po chybě zase uvolní.

## 3.7 · 7. 10. 2026 · kamera přiřazená jinému poskytovateli zmizí z původního dispečinku

- **Přiřazení kamery jinému tenantovi** (`vps-kamera.sh tenant …`) dřív nechalo
  u původního poskytovatele starou dlaždici bez obrazu a události kamery se
  zapisovaly oběma. Teď server při načtení stavu porovná kamery tenanta se
  serverem (cameras.json): kamera, která tenantovi už nepatří, z dispečinku
  zmizí (řádek v `A_KAM_Kamera` zůstane s `Aktivni = 0` i s celou historií),
  události se jí dál nezapisují; když se vrátí, řádek ožije i s nastavením.
- **Název a místo kamery v dispečinku se drží podle serveru** (`vps-kamera.sh
  seznam`), aby obě strany říkaly totéž; dřív zůstal název z doby založení
  řádku.

## 3.6 · 7. 10. 2026 · odkaz s jiným tenantem má přednost před přihlášením

- **Dispečink otevřený odkazem `?tenant=ID` jiného poskytovatele, než ke kterému
  je prohlížeč přihlášený, ukáže přihlášení k tomu novému poskytovateli**
  (s poznámkou, u koho je prohlížeč přihlášený teď). Dřív server parametr
  přehlédl a otevřel dispečink původního tenanta, takže se zdálo, že odkaz
  nefunguje. Odkaz bez parametru dál otevře dispečink přihlášeného tenanta.

## 3.5 · 7. 10. 2026 · deník na telefonu

- **Deník (historie) na telefonu:** datum se překrývalo s textem události,
  protože se sloupec s datem zmenšoval pod šířku textu. Datum se už
  nezmenšuje a na úzké obrazovce (do 600 px) stojí na vlastním řádku nad
  textem, který má celou šířku. Platí pro historii a seznam nahrávek
  v dispečinku i v aplikaci rodiny.

## 3.4 · 7. 10. 2026 · barevná schémata dispečinku

- **Dispečink: výběr barevného schématu** v ⚙ Nastavení → Zobrazení na
  tomto počítači: Modrá (výchozí), Tyrkysová, Zelená, Fialová, Oranžová,
  Grafitová a Tmavě modrá (jako rodina). Mění záhlaví, tlačítka a zvýraznění;
  volba platí jen v tomhle prohlížeči (`localStorage`, `html[data-schema]`)
  a projeví se hned, bez probliknutí při načtení. Aplikace rodiny zůstává
  tmavě modrá.

## 3.3 · 7. 10. 2026 · dispečink na telefonu a světlejší záhlaví

- **Dispečink jde používat na telefonu.** Záhlaví je na úzké obrazovce
  kompaktní (název, tlačítka, počty v jedné řadě), fronta alertů je nad
  dlaždicemi, tabulka Sledování v Nastavení kamery se posouvá do strany sama
  a neroztahuje stránku (dřív se celá stránka zmenšila na 644 px a dialog
  Nastavení nešel zavřít), dialogy a záhlaví se posouvají podle skutečné výšky
  pruhu s hlášením o obrazu, panel Simulace je sbalený do malé pilulky vpravo
  dole. Ověřeno v Chromu na rozměru iPhone 13 (390 px): žádné vodorovné
  posouvání na dlaždicích, v detailu (Monitoring, Komunikace, Nastavení),
  v Nastavení poskytovatele ani v Nápovědě.
- **Záhlaví dispečinku je světlejší modré** než záhlaví aplikace rodiny
  (tmavě modré), aby šlo obě aplikace rozeznat na první pohled.

## 3.2 · 6. 10. 2026 · rodina může kameru deaktivovat a aktivovat

- **Rodina má v aplikaci tlačítko „⏻ Deaktivovat kameru“** (karta hned pod
  stavem, s potvrzením) a u deaktivované kamery **„▶ Aktivovat kameru“**.
  Deaktivovaná kamera: server nedá obraz nikomu (dispečink, rodina, hlavní
  aplikace; `/api/stream*` odpoví 423), nepořizuje se žádná nahrávka (ani
  ruční, ani po události, ani kritická s nouzovým přístupem), události
  z kamery se nezapisují a nikdo není upozorněn, povolení plného obrazu
  končí a otáčení kamery nejde. **Kamera se otočí do stropu** (ONVIF PTZ:
  horní doraz) a po aktivaci zpět do výchozí polohy.
- Rodina to pozná na první pohled: tmavý pruh „Kamera je deaktivovaná“ nahoře,
  přes obraz nápis „⏻ KAMERA DEAKTIVOVANÁ“ a karta s výčtem, co je vypnuté,
  včetně toho, zda se kamera opravdu otočila do stropu (výsledek otočení
  server zapíše ke stavu, chyba jde i do historie).
- Dispečink: dlaždice s nápisem „⏻ deaktivovaná rodinou“ a červeným rámem,
  v detailu kdo a od kdy, bez tlačítek otáčení, Nahrát teď odmítne.
  Deaktivaci a aktivaci může provést jen rodina (API 403 pro poskytovatele);
  obojí je v historii („Rodina (jméno) deaktivovala kameru…“).
- Databáze: sloupec `A_KAM_Kamera.Deaktivace` (JSON od/kdo/otoceni), server
  si ho přidá sám při startu.
- **Obraz náhradní cestou HTTPS se drží u živého bodu.** Přehrávač v rodině
  i dispečinku (`public/proto/zdroj.js`) hlídá náskok vyrovnávací paměti:
  nad 2 s hraje rychleji, nad 5 s skočí na konec, po návratu z pozadí
  telefonu se připojí znovu. Dřív mohl obraz přes HTTPS zůstat desítky sekund
  pozadu a kamera pak vypadala „jinak otočená“ než v dispečinku (WebRTC
  živě). Pod obrazem je vidět, kterou cestou obraz jde a kolik je pozadu.

## 3.1 · 6. 10. 2026 · událost mimo hlídané hodiny jde do deníku jako informace

- **Skutečná událost z kamery mimo nastavené hodiny se už nezahazuje.** Do
  deníku (historie v dispečinku i u rodiny, log období, Excel) se zapíše jako
  **informační řádek**: uzavřený, s textem „… (mimo hlídané hodiny 07:00–20:00)“,
  v databázi `A_KAM_Udalost.Uroven = 'info'`. Nevzniká alert ve frontě, nejde
  SMS ani e-mail, nepořizuje se nahrávka, dispečink nepípne ani neukáže
  bublinu. V logu serveru je u ní „nenahrává se (událost mimo hlídané hodiny –
  jen zápis do deníku)“.
- Druh s vypnutým **Hlídat** se zahazuje dál (nic v deníku), stejně jako
  simulovaná událost z panelu Simulace mimo hodiny (panel ukáže proč).

## 3.0 · 6. 10. 2026 · nahrávka vždy v plném obrazu, při rozostření uzamčená pro poskytovatele

- **Nahrávka po události i tlačítkem Nahrát se pořizuje vždy v plném obrazu.**
  Když má rodina v tu chvíli nastavený rozostřený obraz nebo drátěný model,
  nahrávka vznikne, ale je **uzamčená**: rodina ji ve své aplikaci vidí
  a přehraje, poskytovatel (dispečink i správce) ji nepřehraje ani nestáhne
  (HTTP 423), dokud ji rodina tlačítkem **Odemknout** neodemkne. Odemknutí se
  zapíše (kdo, kdy – sloupce `Zamek`, `OdemklKdo`, `OdemklCas` v
  `A_KAM_Nahravka`) a do historie jde řádek „Rodina (jméno) odemkla
  poskytovateli nahrávku z …“. Kritická událost s nouzovým přístupem se dál
  nahrává volně, při „žádný obraz“ se nenahrává nic.
- Dispečink: v Nahrávkách „🔒 nahrávka uzamčena · odemkne rodina“, v historii
  „🔒 nahrávka uzamčena“, po odemknutí „odemkla rodina (jméno)“; Nahrát teď
  při rozostření upozorní, že nahrávka bude uzamčená. Log období a Excel:
  „uzamčená – odemkne rodina“ / „odemkla rodina (jméno)“.
- Rodina: u nahrávky „🔒 nahrávka uzamčena · poskytovatel ji neuvidí, dokud ji
  neodemknete“ a tlačítko Odemknout (s potvrzením); v historii 🔒 u odkazu.
- **Rodina: výběr kamery dlaždicemi pod hlavičkou** (jen když má rodina víc
  kamer): název, místo a stav (v pořádku / otevřené alerty / nedostupná).
  Přepnutí vymění obraz, deník, nahrávky i nastavení na vybranou kameru
  (dřív rozbalovací seznam v hlavičce vyměnil jen texty, obraz zůstal
  z první kamery).
- **Jeden člen rodiny u více kamer:** když v dispečinku u další kamery zadáte
  telefon, který už účet má, kamera se k účtu přidá (žádná nová pozvánka,
  stejné heslo; v aplikaci rodiny přibude přepínač kamer). „Odebrat“ u kamery
  odebere jen tu kameru, účet zmizí až s poslední (`DELETE …?kamera=ID`).
  V seznamu uživatelů je u účtu vidět, které další kamery má.
- **Záložní zdroj obrazu přes ffmpeg** (`src/kamery.mjs` → `go2rtc.yaml`): u každé
  kamery jsou dva zdroje, vlastní RTSP klient go2rtc a za ním
  `ffmpeg:rtsp://…#video=copy#audio=copy`. Tapo C220 s firmwarem 1.3.1 odmítá
  ověření go2rtc („wrong user/pass“), ffmpeg ověřuje jako VLC a go2rtc od něj
  bere obraz beze změny přes vlastní RTSP server jen na localhostu
  (`rtsp.listen: 127.0.0.1:8554`). Ověřeno: při selhání prvního zdroje go2rtc
  obraz vezme z druhého. Vyžaduje ffmpeg na VPS (od 2.7 už je).
- **Drátěný model z nahrávek (2.8–2.9) je zrušen**: pryč je `src/kostra.mjs`,
  pomocný proces, model MoveNet i balíky TensorFlow (`npm install` je
  o stovky MB menší), `KOSTRA_*` v `.env` a `kostra` v `/api/health`. Starší
  záznamy drátěného modelu v Nahrávkách jdou už jen stáhnout. Živý drátěný
  model v prohlížeči (dispečink i rodina) zůstává beze změny.

## 2.9 · 5. 10. 2026 · drátěný model v dispečinku, jednotná terminologie

- **Drátěný model přes obraz v dispečinku je výrazné tlačítko a je po
  spuštění zapnutý** (🦴 Drátěný model přes obraz: zapnuto/vypnuto, volba
  se pamatuje v prohlížeči). Jde použít při plném a rozostřeném obrazu.
- **Přes skutečný obraz z kamery se kreslí jen skutečná postava** spočítaná
  modelem MediaPipe v prohlížeči (`public/proto/zdroj.js`). Ukázková
  (vymyšlená) postava patří jen k náhradní scéně při nedostupné kameře a už
  se nepřenese na živý obraz; dokud se model načítá nebo není k dispozici,
  plátno to napíše a kostru nekreslí. Náhradní scéna má popisek „postava je
  jen ukázková“.
- **Oprava stažení modelu MoveNet na serveru** (`src/kostra.mjs`): váhy modelu
  se stahují z původní adresy tfhub (s `?tfjs-format=file`) stejně jako to dělá
  TensorFlow.js; z přesměrované podepsané adresy Kaggle šel jen `model.json`
  a váhy vracely 403, takže nahrávka v režimu drátěného modelu skončila
  „neuloženo: váhy modelu … 403“. Chybová hláška teď říká, co nastavit nebo
  kam soubor nahrát ručně.
- **Výpočet drátěného modelu běží v samostatném procesu** (`src/kostra-proces.mjs`,
  nižší priorita): TensorFlow počítá synchronně a v hlavním procesu po každé
  události na sekundy (dřív přes minutu) zastavil obsluhu požadavků, takže
  rodině vypadával obraz přes HTTPS/HLS a API neodpovídalo. Proces se spustí
  při startu, model drží načtený, po pádu se spustí znovu při dalším použití.
- **Drátěný model z nahrávky se počítá nativně** (`@tensorflow/tfjs-node`,
  volitelná závislost; bez ní WebAssembly, nouzově čistý JavaScript, který
  potřeboval asi sekundu na snímek). `KOSTRA_BACKEND` vynutí backend,
  `/api/health` ukazuje `kostraVypocet`, `scripts/kostra-test.mjs` ho vypíše.
- **Rodina: místo seznamu upozornění jen počet otevřených alertů** (např.
  „2 otevřené alerty (1 kritický, 1 varování) · řeší a uzavírá dispečink“
  s tlačítkem do Historie). Podrobnosti jsou v historii, alerty uzavírá
  dispečink; tlačítko „Vše v pořádku“ u náhledu zmizelo.
- **Rodina má u náhledu tlačítko „🦴 Drátěný model: zapnuto/vypnuto“**,
  už není jen v Testu obrazu. Volba se pamatuje v telefonu.
- **Jedna terminologie ve všech aplikacích:** plný obraz, rozostřený obraz
  (rozostření), drátěný model, bez obrazu. Zmizelo „Ostrý“, „Normální“ a
  „Rozmazaný“ (rodina, hlavní aplikace, rozcestník, README).

## 2.8 · 5. 10. 2026 · nahrávka jako drátěný model při rozostření

- **Když rodina povolila jen rozostření nebo drátěný model, nahrávka po
  události vznikne jako drátěný model** (`src/kostra.mjs`): server z klipu
  vytáhne 5 snímků za sekundu (ffmpeg, 320×180), na každém najde postavu
  modelem MoveNet (TensorFlow.js, 17 bodů) a uloží jen souřadnice kostry
  (JSON, pár desítek kB) – plný obraz existuje jen pár sekund v paměti
  serveru při zpracování. Dispečink i rodina ho přehrají jako animaci
  („🦴 přehrát drátěný model“, `public/proto/kostra.js`); stažení dá
  soubor `.json`. Při plném obrazu a u kritické události s nouzovým
  přístupem zůstává plná nahrávka; při „žádný obraz“ se nenahrává nic.
- Model se stáhne při prvním startu do `data/modely` (`KOSTRA_MODEL_URL`
  pro jiný zdroj); ověření na serveru: `node scripts/kostra-test.mjs
  klip.mp4`. Vývoj a testy bez modelu: `KOSTRA_DETEKTOR=fake`. Nové
  závislosti `@tensorflow/tfjs` a `@tensorflow-models/pose-detection`
  (nasazení je nainstaluje).

## 2.7 · 5. 10. 2026 · obraz před událostí na serveru, události kamer bez otevřené stránky

- **Nahrávka po události začíná před ní.** Server drží pro každou kameru
  s poskytovatelem posledních pár sekund obrazu z go2rtc v paměti
  (`src/zasobnik.mjs`, fMP4 bez překódování; `NAHRAVKY_NABEH_S` v `.env`,
  výchozí 12 s zásobníku, 0 = vypnuto). Nahrávka po překročení čáry, vstupu
  do oblasti nebo tlačítkem Nahrát pak obsahuje nastavený náběh (⚙ Nastavení
  → Obraz před událostí, 0–10 s, výchozí 5) od posledního klíčového snímku
  před událostí, plus nastavené sekundy po ní; délka v Nahrávkách je součet.
  Kamera, jejíž obraz zrovna nejde, zásobník nemá a nahrávka jde postaru
  od chvíle spuštění. Čtení běží trvale (asi 1–2 Mbit/s na kameru přes
  tunel); stav je v `/api/health` (`zasobnik`).
- **Události kamer zpracovává server sám**, každé 2 sekundy
  (`najemci.start`), ne až při dotazu otevřené stránky: zápis události,
  SMS, e-mail i nahrávka odcházejí hned, i když nikdo nemá dispečink
  otevřený. Dříve bez otevřené stránky nahrávka vznikla až při příštím
  otevření, tedy pozdě.
- **Hromadné uzavření alertů**: tlačítko „✓ Uzavřít vše (N)“ v hlavičce
  Fronty alertů a „✓ Uzavřít alerty (N)“ v liště pod obrazem kamery; zeptá se
  na výsledek a zapíše ho ke každému (akce `closeAll`).
- **Domeček (výchozí poloha kamery)**: když kamera GotoHomePosition nemá,
  server zkusí první uloženou předvolbu a pak střed (AbsoluteMove 0,0); když
  nejde nic, srozumitelná hláška místo chyby 500.
- **Přehrávání nahrávky v aplikaci rodiny (iPhone)**: klip z go2rtc se při
  ukládání převede přes ffmpeg na obyčejný MP4 s hlavičkou napřed
  (`src/remux.mjs`, bez překódování), který Safari přehraje a má správnou
  délku; přehrávač startuje ztlumený (nahrávka zvuk nemá, jinak iPhone
  nespustí přehrávání) a přežije obnovu seznamu. Bez ffmpeg na serveru
  zůstane původní soubor (log).
- **Až tři časová okna na událost** (Nastavení → Jen v hodinách, tlačítko +):
  např. 07:00–08:00, 12:00–13:00 a 19:00–20:00; událost se hlídá, když
  padne do kteréhokoli; rodina vidí všechna okna v „Co poskytovatel hlídá“.
- **Opakované hlášení kamery během nahrávky** (překročení čáry třikrát za
  20 s) už nezapisuje řádky „neuloženo: nahrávka z téhle kamery právě
  běží“: druhá a další událost patří k běžící nahrávce (v historii na ni
  ukazují, i po restartu podle času), v Nahrávkách je jen jeden řádek.
  Staré řádky s tímto důvodem se v seznamu neukazují.

## 2.6 · 4. 10. 2026 · hlídání místa na serveru (pojistka disku, limit poskytovatele, varování)

- **Pojistka proti plnému disku**: když je na disku VPS volno méně než
  `NAHRAVKY_MIN_VOLNE_GB` (výchozí 5 GB, `.env`), server při hodinovém
  mazání smaže nejstarší nahrávky napříč poskytovateli bez ohledu na dobu
  uchování, dokud není volno zpět nad hranicí; do logu jde řádek `POZOR`.
  Plný disk by jinak zastavil aplikaci.
- **Limit místa na poskytovatele** (⚙ Nastavení → Limit místa nahrávek,
  GB; výchozí 2, 0 = bez limitu): nad limit se mažou nejstarší nahrávky
  toho poskytovatele. Řádek v ⚙ „Nahrávky na serveru“ ukazuje obsazení z
  limitu, volné místo a pojistku serveru.
- **Varování v dispečinku**: oranžový proužek nahoře (s tlačítkem ⚙), když
  je na serveru málo místa, poskytovatel je přes 90 % limitu, nebo ho
  překročil; stránka se ptá každých 5 minut (`misto.varovani` v
  `GET /api/nahravky/stav`).
- **Nahrát 15 s v aplikaci rodiny nahrává doopravdy**: dřív jen zapsalo řádek do
  historie; teď server pořídí klip z kamery a uloží ho podle Nastavení
  poskytovatele (server / Google Disk), nahrávka je v kartě Nahrávky u
  rodiny i v dispečinku (se jménem rodiny) a v historii je řádek „Ruční
  nahrávka“ (nový druh `nahravka`, i u Nahrát teď v dispečinku). Platí
  stejné pravidlo soukromí: jen při plném obrazu, nebo s nouzovým přístupem.
- **Deník v aplikaci rodiny po 12 záznamech**: pod seznamem tlačítka
  „Starších 12“ a „Novějších 12“ s počítadlem (1–12 z 37); změna filtru
  vrátí na začátek.
- **Filtr typu událostí v historii** (detail kamery → Historie), jako v
  aplikaci rodiny: Vše, Kritické, Varování, Kamera, Analýza, S nahrávkou,
  S upozorněním, Souhlasy, Poznámky. Platí pro posledních 12 i pro zvolené
  období; s filtrem se živě ukazuje až 40 posledních vyhovujících. Excel
  stahuje vždy celé období bez filtru.

## 2.5 · 4. 10. 2026 · log za období s exportem do Excelu, detail v blocích, nahrávka po události

- **Log událostí za zvolené období a stažení do Excelu** (detail kamery →
  Monitoring → blok Historie): zadejte *od* a *do* (dny pražského času),
  *Zobrazit období* načte události přímo z databáze (ne jen posledních pár
  v paměti), zaškrtnutí *všechny kamery* vezme celý dispečink; *Stáhnout do
  Excelu* uloží sešit `.xlsx` (list Události: datum, čas, kamera, událost,
  závažnost, zdroj, text, stav, převzal(a), převzato, uzavřeno, výsledek,
  poznámka, eskalováno, SMS, e-mail, nahrávka, původ; list Období). Bez
  období se stáhne celá historie. `GET /api/udalosti?od=&do=&kamera=&format=xlsx`;
  sešit skládá `src/xlsx.mjs` bez knihoven. Rodina log nemá.
- **Detail kamery přehledněji**: každé téma je v ohraničeném bloku s
  nadpisem (Monitoring: Obraz z kamery, Přidat poznámku, Historie,
  Nahrávky; Komunikace: Klient a poskytovatel, Uživatelé rodiny, Kontakty
  pro upozornění, Poznámky dispečinku; Nastavení: Sledování, nahrávání a
  upozornění) a tlačítka každého bloku jsou v jedné liště pod obrazem /
  nad seznamem, ne roztroušená v textu.
- **Nahrávka po události, která se nepořídila, má vždy vidět důvod**: když ji
  server odmítne (rodina nepovolila plný obraz a nejde o kritickou událost
  s nouzovým přístupem) nebo klip selže, zapíše se řádek s důvodem do
  Nahrávek i k události v historii (🎞 nenahráno: …) a zůstane tam i po
  restartu serveru; každý krok je v logu serveru (`pm2 logs famicura-tapo`,
  řádky `[nahravky]`). Skutečná událost z kamery se nahrává, i když je kamera
  v dispečinku označená jako nedostupná (právě ji sama nahlásila). Tlačítko
  Nahrát teď hlásí, kam se uložilo (server / Google Disk).
- **Stažení nahrávky ze serveru** (dispečink → Nahrávky → ⬇ stáhnout):
  soubor `.mp4` se uloží do počítače pod názvem nahrávky (kamera, datum, čas,
  druh události); server ho dešifruje jen pro přihlášeného dispečera a stažení
  zapíše do auditu jako „stažení“ (`GET /api/nahravky/:id/soubor?stahnout=1`).
  Rodina nahrávky jen přehrává.

## 2.4 · 4. 10. 2026 · všechny detekce kamery Tapo v nastavení

- **Všechny události, které Tapo přes ONVIF hlásí, mají svůj řádek v
  Nastavení** (dispečink, detail kamery → Nastavení): k překročení čáry,
  zakrytí, osobě a pohybu přibyly *vstup do hlídané oblasti*, *pláč*,
  *hlasitý nebo neobvyklý zvuk*, *rozbití skla*, *vozidlo* a *zvíře*
  (štěkot a mňoukání se počítají jako zvíře). Vozidlo a zvíře jsou výchozí
  vypnuté, vstup do oblasti se nahrává; u uložených nastavení se nové řádky
  doplní výchozí hodnotou, nic se nepřepisuje. Rodina je vidí v „Co
  poskytovatel hlídá“, hlavní aplikace má nové popisky (Pláč, Vstup do
  hlídané oblasti, …) místo jmen z kamery.
- **Zařazení podle položky, ne podle jména tématu** (`POLOZKY` v
  `src/onvif.mjs`): Tapo pojmenovává témata podle firmwaru různě
  (`PeopleDetector/People` i `CellMotionDetector/People`,
  `TPSmartEventDetector/TPSmartEvent` s `IsVehicle` i
  `VehicleDetector/Vehicle`, `CellMotionDetector/Intrusion`,
  `FieldDetector/ObjectsInside`, `AudioAnalytics/Audio/DetectedSound`), teď
  všechny varianty padnou do stejného druhu. Neznámý detektor se dál nabízí
  pod jménem z kamery; `scripts/onvif-diag.mjs` značí ✓ podle téhož.

## 2.3 · 4. 10. 2026 · Google Disk zapnout/vypnout, místo na serveru, otáčení kamery

- **Google Disk jde zapnout a vypnout** (⚙ Nastavení → zaškrtávátko Google
  Disk): zapnuto = každá nahrávka je na serveru i jako kopie na Google Disku
  poskytovatele; vypnuto = na Disk se nic neposílá, i když je adresář
  zapojený. Chyba Disku nahrávku na serveru neruší, jen se zapíše k řádku.
- **Místo na serveru**: v ⚙ u části Nahrávky na serveru je, kolik nahrávky
  tohoto poskytovatele zabírají (MB/GB, počet souborů) a kolik je na VPS
  volného místa (`misto` v `GET /api/nahravky/stav`).
- **Otáčení kamery** (Tapo C200/C210/C220, ONVIF PTZ stejným účtem a portem
  2020 jako události): kříž šipek na obraze v detailu dispečinku i v aplikaci
  rodiny (jen u své kamery), ⌂ = výchozí poloha; `POST /api/ptz` (`src/ptz.mjs`,
  `onvif.ptz`), krok = krátký ContinuousMove a Stop, jeden pohyb na kameru
  najednou.

## 2.2 · 4. 10. 2026 · úložiště nahrávek na serveru, přehrávání v aplikaci

- **Druhá volba úložiště: na serveru (doporučeno).** ⚙ Nastavení → Úložiště
  nahrávek: *Na serveru* nebo *Google Disk poskytovatele*. Na serveru jsou
  soubory v `data/nahravky/<tenant>/` šifrované AES-256-GCM klíčem
  `NAHRAVKY_KLIC` (`src/uloziste.mjs`; `vps-env.sh` ho vygeneruje). Nahrávka
  z prohlížeče zůstává v režimu, ve kterém byla pořízena (rozostřená zůstane
  rozostřená); server ji jen uloží.
- **Přehrávání jen v aplikaci s kontrolou přístupu**
  (`GET /api/nahravky/:id/soubor`, Range pro posouvání): dispečink
  poskytovatele a rodina jen u svých kamer (karta Nahrávky v aplikaci rodiny,
  odkaz 🎞 u události v historii). **Každé přehrání je v auditu**
  (`A_KAM_Prehrani`: kdo, role, čas, adresa; dispečink
  `GET /api/nahravky/:id/audit`).
- **Automatické mazání** po době uchování (⚙ Uchovat nahrávky, výchozí 30
  dnů; nahrávky na Google Disku se nemažou), kontrola každou hodinu; řádek
  zůstává v evidenci se značkou smazání. Dispečink může nahrávku smazat ručně.
- **Evidence v CLB1**: každou uloženou nahrávku (ze serveru i z prohlížeče)
  server zapíše do `FamicuraRingNahravky` (Soubor = název, Složka =
  `server:<tenant>` nebo `Google Disk <účet>`).
- Tabulka `A_KAM_Nahravka` má nové sloupce (Uloziste, Soubor, Mime,
  SmazanoCas); DDL doplní chybějící sloupce i do tabulek, které už existují.

## 2.1 · 4. 10. 2026 · nahrávky na Google Disku poskytovatele

- **Nahrávky kamer se ukládají na Google Disk poskytovatele** stejným
  principem jako Export dat v Péče doma plus: poskytovatel má Google účet
  připojený jednou v portálu Plus (Export dat → Připojit Google účet),
  v Google se nic dalšího nenastavuje. Dispečink v ⚙ Nastavení → Nahrávky
  na Google Disku založí adresář „Famicura Kamera – <poskytovatel>“.
- **Nahrává server, ne prohlížeč** (`src/nahravky.mjs`): po události se
  zatrženým Nahrávat vezme z go2rtc nastavený počet sekund obrazu (⚙ →
  Nahrávka po události, 5–60 s, výchozí 15) jako MP4 a nahraje ho na Disk
  (`src/disk.mjs`, přes aplikaci `pecedomaplus-kamera-disk` na jhn-apps
  s klíčem `FAMICURA_KAMERA_KLIC`). Řádek je v tabulce `A_KAM_Nahravka`
  tenanta, odkaz 🎞 u události v historii a v seznamu Nahrávky v detailu
  kamery; tlačítko **Nahrát teď**. Obraz před událostí server nemá.
- **Soukromí:** nahrává se jen při plném obrazu povoleném rodinou, nebo při
  kritické události s povoleným nouzovým přístupem; jinak je u události
  důvod, proč se nenahrálo.
- Hlavní aplikace: každou hotovou nahrávku (ruční, plán, událost z analýzy)
  pošle serveru a ten ji uloží na Disk poskytovatele kamery
  (`POST /api/nahravky`, až 64 MB); odkaz je u nahrávky v seznamu.
- Tunel pro více míst (`wireguard-vps.sh --misto N`, README 2d): kamera
  u jiného poskytovatele má vlastní bránu a vlastní místo v tunelu.
- Adresář na Disku je jeden: jiný jde založit až po **Odpojit adresář**
  (⚙ Nastavení; odpojený adresář na Disku zůstává i s nahrávkami).
- Nasazení: `vps-env.sh` vygeneruje `FAMICURA_KAMERA_KLIC` a opíše ho do
  `.env` jhn-apps (`deploy/sdilej-klic-jhn.sh`); v repozitáři
  WEB-PeceDomaPlus `./deploy-jhn-apps.sh` nasadí aplikaci
  `pecedomaplus-kamera-disk`.

## 2.0 · 3. 10. 2026 · ostrý provoz podle poskytovatele (tenanta)

- **Konec prototypu se společným stavem.** Každý poskytovatel (tenant Péče
  doma plus, `dbo.Tenants`) má svá data v databázi **PeceDomaPlus**
  v tabulkách `A_KAM_Kamera`, `A_KAM_Udalost`, `A_KAM_Zadost`,
  `A_KAM_Povoleni`, `A_KAM_Nastaveni` a `A_KAM_UzivatelRodiny`
  (`src/tabulky.mjs`; server je při startu založí, každá má `IDTENANT`
  a Row-Level Security podle `SESSION_CONTEXT('IDTENANT')` jako ostatní
  tabulky Plus). Soubory `data/proto-stav.json` a `data/uzivatele.json`
  se už nepoužívají, do Softru se nepíše nic.
- **Dispečink se spouští s ID tenanta v odkazu** jako Péče doma plus:
  `/proto/dispecink.html?tenant=22202480FAMICURA`. ID si prohlížeč
  zapamatuje, z adresy zmizí. Dispečer se přihlašuje **účtem Péče doma
  plus** (jméno a heslo z portálu, ověřuje aplikační server jhn-apps);
  správce serveru heslem správce. V záhlaví je vidět poskytovatel a kdo je
  přihlášen, vpravo Odhlásit.
- **Kamery patří tenantovi**: `./deploy/vps-kamera.sh` se ptá na ID tenanta
  a místo; dodatečně `./deploy/vps-kamera.sh tenant tapoc2020 22202480FAMICURA
  "Kancelář"`. Dispečink, provoz, rodina i obraz (`/api/stream`) pustí jen
  kamery toho tenanta; cizí kamera je 404. Přepínač Jen skutečné / Demo
  a tlačítko Vynulovat v ostrém provozu nejsou (ukázka bez přihlášení
  zůstává jen v prohlížeči).
- **Údaje poskytovatele** (⚙) začínají názvem z `dbo.Tenants`, ostatní pole
  prázdná; uloží se k tenantovi. Účty rodiny jsou v tabulce tenanta, telefon
  je jedinečný v rámci tenanta.
- Nastavení serveru: `PDP_SQL_PASSWORD` (login `pecedomaplus_app`) a
  `JHN_APPS_TOKEN` v `.env`; `./deploy/vps-env.sh` je vezme z
  `/opt/jhn-apps/.env` na serveru, nebo se zeptá. Vývoj bez SQL Serveru:
  `PDP_FAKE_TENANTS="ID=Název"` (jen v paměti).

## 1.1 · 3. 10. 2026

- Aplikace rodiny: vlastní obraz na telefonu je vždy ostrý; volba zobrazení
  (normální, rozostření, černé pozadí, drátěný model) je schovaná za jedním
  tlačítkem **Test obrazu** a zavřením testu se vrátí ostrý obraz; drátěný
  model je zapnutý jako výchozí a jde přidat k ostrému i rozmazanému obrazu. Tři
  tlačítka Ostrý / Rozmazaný / Drátěný model, kterými rodina přepíná, co vidí
  poskytovatel, zůstávají v kartě Přístup poskytovatele.
- Dispečink: detail kamery ve třech sekcích. **Monitoring** (obraz, režim,
  žádost o plný obraz, nouzový přístup, přidání poznámky, historie), **Komunikace** (poskytovatel,
  poznámka ke klientovi, uživatelé rodiny, kontakty pro upozornění, poznámky
  dispečinku) a **Nastavení** (sledování, nahrávání a upozornění).
- Kontakty kamery: až tři čísla na SMS a tři e-maily (`setKontakty`), změna
  v historii kamery; rodina je vidí v kartě „Co poskytovatel hlídá“.
- U každé události lze zatrhnout Nahrávat, SMS a E-mail. Server po události
  (skutečné z kamery i simulované) pošle SMS a e-mail na kontakty
  (`src/upozorneni.mjs`), výsledek je u události v historii (📱 2/2 ✉ 1/1,
  chyba po najetí). Kritické události mají SMS i e-mail zatržené předem.
- E-mail jde stejným webhookem Make jako SMS (`kanal: mail`, schránka
  Centrum LB); v nastavení dispečinku je zkušební SMS i zkušební e-mail
  a varování, když je `SMS_WEBHOOK_URL` stejná jako adresa asistenta
  (server to hlásí i při startu).

## 1.0 · oprava 3. 10. 2026 (odpoledne)

- SMS rodině (pozvánky, žádosti o plný obraz) jdou přes Twilio: scénář Make
  `Famicura_Tapo_SMS_Pozvanka` místo SMSzasilam používá stejné Twilio spojení
  a číslo jako „JARVIS poslání SMS přes Twilio“ (SMSzasilam hlásil úspěch,
  ale SMS nedocházely). Server bere SMS za odeslanou jen po odpovědi scénáře
  `{"ok":true}`; „Accepted“ nebo chyba Twilia se ukáže dispečinku.
- Nastavení dispečinku (ozubené kolečko): sekce SMS rodině se stavem
  a tlačítkem Poslat zkušební SMS na vlastní číslo (`POST /api/sms/test`).
- Log serveru píše každou SMS (konec čísla, typ, Twilio SID nebo chyba),
  nikdy text.

## 1.0 · 3. 10. 2026

První označená verze. Obsahuje:

- Hlavní aplikace: obraz z kamery Tapo přes go2rtc (WebRTC, náhradně HTTPS),
  nahrávky, plány, události kamery (ONVIF) se zápisem do CLB1, diagnostika,
  tunel WireGuard k bráně GL.iNet Mango (nebo Windows server / tunel SSH).
- Aplikace rodiny (telefon, na plochu): účty s pozvánkou SMS, karta Přístup
  poskytovatele (co poskytovatel vidí teď, rychlé přepnutí Ostrý / Rozmazaný /
  Drátěný model, nastavení podle denní doby s časy, nouzový přístup), Klid,
  žádost o plný obraz přes celou obrazovku se zvukem, historie.
- Dispečink poskytovatele (jen po přihlášení): dlaždice v režimu, který rodina
  povolila, fronta alertů s převzetím a uzavřením, eskalace podle nastavení,
  žádost o plný obraz (rodině odejde SMS), nouzový přístup, sledování
  a nahrávání, účty rodiny, poznámky dispečinku ke kameře, trvalá poznámka
  ke klientovi, nastavení pod ozubeným kolečkem, nápověda s obrázky obrazovek
  a asistent (z nápovědy, volitelně AI přes Make), přepínač Jen skutečné / Demo.
- Provoz: flotila míst, provozní alarmy, diagnostika skutečné kamery.
- Stav prototypu sdílený přes server mezi všemi zařízeními.
- Dokumentace: README, návody ve Wordu, prodejní prezentace a scénář videa
  v `docs/prezentace/`.
