# Změny Famicura Kamera

Verze je na jednom místě v `public/verze.js` a ukazuje se v hlavičce všech
aplikací (hlavní aplikace, rodina, dispečink, provoz, přihlášení). Stejné
číslo nese značka v gitu (`git tag`) a téma „Co je nové“ v nápovědě
dispečinku. Postup nové verze je v README, část „Verze“.

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
