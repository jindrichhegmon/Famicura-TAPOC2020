/*
 * Nápověda dispečinku a asistent. Témata slouží panelu Nápověda i asistentovi:
 * ten hledá v otázce klíčová slova a odpoví textem tématu. Když je na serveru
 * nastavený webhook asistenta (ASISTENT_WEBHOOK_URL, scénář Make s AI),
 * odpovídá AI s touhle nápovědou jako podkladem; bez něj odpovídá jen odsud.
 *
 * Obsah tématu (obsah) je strukturovaný text, řádek po řádku:
 *   ### Nadpis      nadpis části
 *   - text          odrážka            1. text   číslovaný krok
 *   ! text          zvýrazněné upozornění
 *   prázdný řádek   konec odstavce / seznamu; **tučně** uvnitř textu
 * napovedaHtml() z něj udělá HTML (vše escapované), napovedaProsty() prostý text
 * pro vyhledávání a asistenta (t.text se doplní při načtení modulu).
 */
export const TEMATA = [
  { id: 'prehled', obrazky: [{ src: '/proto/napoveda/dlazdice.png', popis: 'Dlaždice kamer se štítkem režimu, který platí teď' }, { src: '/proto/napoveda/detail.png', popis: 'Detail kamery: co rodina povolila a proč, drátěný model přes obraz' }], nazev: 'Dlaždice a režimy obrazu', klicova: ['dlazdic', 'male okno', 'velke okno', 'seznam', 'zobrazeni', 'rezim', 'obraz', 'rozostr', 'rozmaz', 'drateny', 'kostra', 'plny obraz', 'bez obrazu', 'co vidim', 'proc nevidim', 'cerny', 'skeleton', 'blur'],
    obsah: `
Každá dlaždice ukazuje kameru v režimu, který povolila rodina. Štítek na dlaždici říká, který režim platí teď; v detailu kamery je i proč.

### Režimy obrazu
- **Plný obraz** – ostrý obraz z kamery.
- **Rozostření** – obraz je rozmazaný, postava je rozeznatelná jen podle obrysu.
- **Drátěný model** – jen kostra postavy, bez obrazu.
- **Bez obrazu** – obraz se nekreslí, chodí jen události.

### Kdo režim nastavuje
- Rodina si nastavuje režim pro den a pro noc a čas, kdy den a noc začínají.
- Rodina může obraz kdykoli rychle přepnout do dalšího střídání den/noc (tři tlačítka Ostrý / Rozmazaný / Drátěný model).
- Její vlastní obraz na telefonu je vždy ostrý; tlačítkem Test obrazu si jen vyzkouší, jak rozostření nebo drátěný model vypadají.
- V detailu kamery vidíte, proč režim platí: denní nebo noční nastavení rodiny, rychlé přepnutí rodiny, nebo povolení na vaši žádost.
- Dispečink režim sám nemění. Může jen požádat o plný obraz, nebo v kritické situaci použít nouzový přístup.

### Velikost dlaždic
Přepínač nad dlaždicemi; volba zůstává uložená v prohlížeči.
- **Malé okno** – hodně kamer na obrazovce.
- **Velké okno** – velikost dlaždic podle počtu kamer.
- **Seznam** – řádek s malým náhledem, jménem, stavem a poslední událostí.
` },
  { id: 'zadost', obrazky: [{ src: '/proto/napoveda/zadost.png', popis: 'Detail kamery: Požádat rodinu o plný obraz s důvodem' }, { src: '/proto/napoveda/rodina-zadost.png', popis: 'Telefon rodiny: žádost přes celou obrazovku s tlačítky Povolit / Odmítnout' }], nazev: 'Žádost o plný obraz', klicova: ['zadost', 'pozadat', 'plny obraz', 'povolit', 'povoleni', '15 minut', 'do odvolani', 'rodina nereaguje', 'odmit'],
    obsah: `
### Postup
1. Klepněte na dlaždici kamery.
2. V detailu klepněte na „Požádat rodinu o plný obraz“.
3. Vyberte důvod (rodina ho uvidí) a odešlete.

### Co se stane u rodiny
- Na telefonu vyskočí žádost přes celou obrazovku, bliká a zní, dokud ji rodina nevyřídí: Povolit na 15 minut, Povolit do odvolání, nebo Odmítnout.
- Každému členovi rodiny s účtem u té kamery zároveň odejde SMS, ať otevře aplikaci a žádost povolí nebo odmítne. Dispečink vidí, kolika lidem SMS odešla.
- Žádost platí 10 minut. Bez odpovědi zůstane dosavadní režim.

### Po povolení
- Dlaždice ukazuje plný obraz.
- Rodina vidí, kdo se dívá, a může přístup kdykoli ukončit.
- Vy ho ukončíte tlačítkem „Ukončit plný obraz“.
` },
  { id: 'nouze', obrazky: [{ src: '/proto/napoveda/nouze.png', popis: 'Tlačítko Nouzový přístup 10 min v detailu kamery' }], nazev: 'Nouzový přístup', klicova: ['nouz', 'nouzovy', 'pad', 'sos', 'kriticky', 'bez souhlasu', '10 minut'],
    obsah: `
Nouzový přístup otevře plný obraz na 10 minut bez čekání na rodinu. Tlačítko je v detailu kamery vedle žádosti o plný obraz.

### Kdy ho jde použít
- Jen při otevřeném kritickém alertu (pád, dlouhé ležení, SOS).
- Jen když rodina nouzový přístup předem povolila (přepínač „V nouzi plný obraz“ v aplikaci rodiny).

### Co se stane
- Rodina dostane okamžitě zprávu.
- Zásah je zapsaný v historii (auditu).
` },
  { id: 'alerty', obrazky: [{ src: '/proto/napoveda/fronta.png', popis: 'Fronta alertů vpravo: Převzít, Řeším, Uzavřít s výsledkem; červený pruh u kritických' }], nazev: 'Fronta alertů: převzít, řešit, uzavřít', klicova: ['alert', 'fronta', 'prevzit', 'prevzat', 'resim', 'uzavrit', 'uzavren', 'eskal', 'vysledek', 'plany poplach', 'vyjezd', 'zachran'],
    obsah: `
Nový alert se objeví ve frontě vpravo; kritický i v červeném pruhu nahoře se zvukem. Informativní události (osoba, pohyb) do fronty nejdou, jsou jen v historii.

### Postup u alertu
1. **Převzít** – alert je váš, rodina vidí vaše jméno.
2. **Řeším** – pracujete na něm.
3. **Uzavřít s výsledkem** – planý poplach, vyřešeno na dálku, výjezd pečovatele, záchranná služba, předáno rodině.

### Eskalace
! Nepřevzatý kritický alert po 2 minutách eskaluje na zálohu a vedoucího. Počet minut, zálohu i vedoucího nastavíte v ⚙ Nastavení.

### Uzavření hromadně
- „✓ Uzavřít vše“ v hlavičce Fronty alertů uzavře otevřené alerty všech kamer.
- „✓ Uzavřít alerty“ v liště pod obrazem kamery uzavře jen alerty té kamery.
- Ke každému se zapíše zadaný výsledek.
` },
  { id: 'rodina', obrazky: [{ src: '/proto/napoveda/uzivatele.png', popis: 'Uživatelé rodiny v detailu skutečné kamery: založení účtu a pozvánka SMS' }], nazev: 'Uživatelé rodiny, mobilní dispečer a pozvánka SMS', klicova: ['rodin', 'uzivatel', 'pozvank', 'sms', 'ucet', 'heslo', 'telefon', 'prihlasit rodinu', 'zapomn', 'odebrat', 'nedosla', 'nechodi', 'zkusebni', 'twilio', 'mobilni', 'mobilniho dispecera', 'dispecera', 'dispecer na telefonu', 'deaktivovat ucet', 'typ uctu', 'rezim rodina', 'rodina i dispecer'],
    obsah: `
V detailu skutečné kamery → záložka Komunikace a kontakty → část „Uživatelé rodiny“.

### Založení účtu a pozvánka SMS
1. Vyberte typ účtu: **Rodina** (jen tato kamera), **Dispečer**, nebo **Rodina i dispečer** (u této kamery rodina, u ostatních jen sleduje).
2. Zadejte jméno a telefon, zaškrtněte „poslat SMS ze serveru“ a založte účet.
3. Rodina dostane SMS s odkazem. Odkaz platí 7 dní a je na jedno použití.
4. Heslo v SMS není: rodina si ho zvolí sama po otevření odkazu (obrazovka „Zvolte si heslo“) a dál se přihlašuje telefonem a heslem.
- Odkaz otevřený na počítači, kde je přihlášený poskytovatel nebo jiný člen rodiny, přesto ukáže volbu hesla pro nového člena.
- Stejný člověk u další kamery: u té kamery zadejte jeho telefon znovu. Kamera se k účtu jen přidá (bez nové pozvánky, stejné heslo) a v aplikaci rodiny si ji vybere přepínačem. „Odebrat“ pak odebere jen tu jednu kameru.

### Mobilní dispečer
- Stejná aplikace na telefonu, ale vidí všechny kamery poskytovatele a nic nenastavuje: souhlas s obrazem, klid a deaktivaci kamery nastavuje rodina, hlídání dispečink na počítači; server mu každé nastavení odmítne. Jediné, co si mění, je barevné schéma.
- U kamery s náramkem má (stejně jako rodina) kartu ⌚ Náramek SOS: stav, poloha na mapě, grafy, měření a poplachy, jen ke čtení.
- V jeho aplikaci je nahoře oranžový pruh APLIKACE DISPEČERA a v hlavičce „DISPEČER“; SMS s pozvánkou říká, že jde o přístup dispečera ke všem kamerám poskytovatele.
- Před odesláním pozvánky dispečera se dispečink zeptá, jestli ji opravdu chcete poslat (dispečer uvidí všechny kamery).
- Dispečer se ukazuje u všech kamer poskytovatele s odznakem DISPEČER; poskytovatel jich může mít víc.

### Jeden telefon = jeden účet
- Pozvánka dispečera na telefon, který už má účet rodiny, přidá účtu roli dispečera; své kamery mu zůstanou jako rodině (u kamery má vedle DISPEČER i odznak RODINA).
- V aplikaci na telefonu si v Můj účet přepíná režim **Rodina** (jen své kamery, nastavuje souhlas, klid a deaktivaci) / **Dispečer** (všechny kamery, jen sledování; deaktivovat a aktivovat kameru smí jen rodina).
- Dispečerovi jde u kamery založit i účet rodiny stejným telefonem.

### Deaktivovat, Odebrat, nové heslo
- **Deaktivovat** (u rodiny i dispečera) účet zablokuje: nepřihlásí se, přihlášený je odhlášen, pozvánka neplatí. **Aktivovat** ho vrátí.
- **Odebrat** u rodiny odebere tuhle kameru (poslední kamera účet smaže) a rodinu odhlásí. U dispečera odebere kameru, kde je rodina; u kamery, kde rodina není, smaže celý účet dispečera.
- Změna hesla: v aplikaci rodiny karta Můj účet → Změnit heslo.
- Zapomenuté heslo: „Nová pozvánka (nové heslo)“ pošle nový odkaz a staré heslo přestane platit.

### Když SMS nedošla
! SMS odchází ze serveru přes Make a Twilio. Otevřete ⚙ Nastavení → SMS rodině a pošlete si zkušební SMS na vlastní číslo: hned uvidíte, jestli je SMS nastavená a jestli došla, případně důvod chyby.
` },
  { id: 'naramek', obrazky: [], nazev: 'Náramek / přívěsek SOS ke kameře', klicova: ['naramek', 'naramk', 'náramek', 'privesek', 'privesk', 'přívěsek', 'cisla sos', 'cislo sos', 'sos', 'reachfar', 'v48', 'hodinky', 'tlacitko', 'pad hlaseny', 'baterie naramku', 'id zarizeni', 'anytracking', 'nouzove tlacitko', 'telefonni cisla naramku', 'cisla naramku', 'koho narame', 'naramek v mobilu', 'naramek na telefonu', 'karta naramek', 'naramek rodina', 'naramek dispecer'],
    obsah: `
Nouzový přívěsek nebo hodinky (ReachFar V48 a podobné) posílají poplachy mobilními daty přímo na náš server. Vše je v detailu kamery → záložka ⌚ Náramek (hned za Monitoringem).

### Přiřazení náramku ke kameře
1. V záložce Náramek úplně dole je blok Přiřazení náramku.
2. Zadejte ID zařízení (v aplikaci náramku: O zařízení → ID zařízení).
3. Zadejte telefonní číslo SIM karty v náramku (povinné) a uložte.
4. Přívěsek musí mít nastavenou adresu našeho serveru: SMS příkaz z mobilu na číslo SIM v přívěsku pw,123456,ip,95.216.201.2,5093#
- Telefon náramku je pak výrazně v zeleném rámečku nahoře ve Stavu náramku (klepnutím se volá) a stejně na kartě Náramek v aplikaci rodiny a mobilního dispečera; bez něj svítí červené upozornění.
- Záložka má napřed výsledky (Stav náramku s mapou a grafy posledních 10 měření, Měření zdraví, Poplachy) a pod nimi Ovládání a nastavení náramku (měření, poloha, vypnutí, automatické měření) s přehledem, koho náramek volá.

### Co náramek hlásí
- Jakmile se ozve, vidíte čas posledního ozvání, baterii, odkaz na poslední polohu, poslední měření zdraví (tep, tlak, kyslík, teplota) a tabulku měření.
- Stisk SOS vytvoří kritickou událost **Nouzové tlačítko**, pád událost **Pád hlášený náramkem**, slabá baterie technickou událost. SMS, e-mail a nahrávka kamery se řídí zatržením v Nastavení alertů u těchto druhů.
- Stejný poplach do minuty se počítá jednou. SOS projde i u kamery deaktivované rodinou.
- U poplachu z náramku je odkaz „mapa“, který otevře polohu v Google Mapách v novém okně.
- Když se náramek neozval přes 2 hodiny, je čas posledního ozvání červeně (vybitý, bez signálu, nebo vypnutý tlačítkem).

### Měření zdraví
- Tlačítko **Změřit zdraví** (tep, tlak, kyslík, teplotu) pošle náramku celou sadu: napřed hrtstart,1 (zapne snímač; ReachFar V48 bez něj neodpoví), po 1,5 s bphrt (tlak a tep), oxygen (kyslík) a bodytemp2 (teplota). Výsledky dorazí do minuty do tabulky Měření zdraví.
- V48 posílá tep jen s tlakem a teplotu na vyžádání zatím neposlal (příkaz přijme, hodnotu ne); teplotu hlásí jen podle plánu nastaveného v jeho mobilní aplikaci a ta se do tabulky zapíše také.
- **Automatické měření**: zadejte interval v minutách, zatrhněte „měřit zdraví“ a uložte; server pak celou sadu posílá sám.
- Příkaz jde jen do připojeného náramku, jinak hlásí, že není připojený (náramek se ozývá v intervalech).
- Hodnoty z jedné sady měření (tlak s tepem, kyslík, teplota přicházejí zvlášť během pár desítek sekund) jsou v jednom řádku. Tabulka je trvalá, stránkuje se po 10, 20, 50 nebo 100 (volba se pamatuje v prohlížeči), tlačítka novější/starší listují a **Stáhnout do Excelu** uloží sešit se všemi měřeními kamery (datum, čas, tep, tlak, kyslík, teplota).

### Grafy a barvy hodnot
- Vedle mapy jsou grafy za posledních 24 hodin (tep, tlak horní a dolní, kyslík, teplota) se světlým pásmem běžného rozmezí; body mimo rozmezí jsou oranžové nebo červené a po najetí myší ukážou čas a hodnotu.
- **Oranžově** = mimo běžné rozmezí: tep 50–100, tlak 90–139/60–89, kyslík od 94 %, teplota 35,5–37,4 °C.
- **Červeně** = výrazně mimo: tep pod 40 nebo nad 120, tlak nad 159/99 nebo pod 80/50, kyslík pod 90 %, teplota nad 38,4 nebo pod 35 °C.

### Poloha a vypnutí
- **Zjistit polohu** (CR) vyžádá polohu; bez GPS signálu přijde jen přibližná z mobilní sítě.
- Červené tlačítko **Vypnout náramek** ho vypne (zapne se jen tlačítkem na náramku), proto chce heslo hlavní aplikace Famicura. Ověřuje ho server, po několika špatných pokusech na chvíli zablokuje.
- Po vypnutí svítí v záložce Náramek červené hlášení „NÁRAMEK JE VYPNUTÝ“ (kdo a kdy ho vypnul), záložka má odznak ⏻ a dlaždice kamery „⏻ náramek vypnutý“. Jakmile se náramek po zapnutí tlačítkem zase ozve, hlášení zmizí.
- Ostatní nastavení náramku (interval ozvání, pásmo, hlasitost) se dělá v mobilní aplikaci náramku, ne z dispečinku.

### Telefonní čísla náramku (SOS)
- Nastavují se v Komunikaci a kontaktech → Kontakty, oddíl Telefonní čísla náramku pod Poskytovatelem: ve třech výběrech zvolte, koho má náramek po stisku SOS volat (pořadí 1 → 2 → 3). Jen z kontaktů kamery: lidé z rodiny s mobilem, dispečink, služba a administrace poskytovatele; „– prázdné“ číslo v náramku smaže.
- Ukládají se tlačítkem Uložit kontakty. Když je náramek připojený, odejdou hned (pod výběry je čas odeslání), jinak je server pošle při jeho příštím ozvání.
- Když se odeslání nepovede (náramek odpojený, chybí číslo v Péče doma, jhn-apps neodpovídá), čísla zůstanou uložená, důvod je pod výběry a server je pošle sám, jakmile to jde.
- Skutečná čísla dosadí server z Kontaktů (telefon poskytovatele může být vlastní číslo, nebo z Péče doma / Péče doma plus). Když se kontakt nebo číslo v Péče doma (plus) změní, do 10 minut je pošle do náramku znovu.
- Řádek „Náramek bude volat“ ukazuje skutečná čísla ještě před uložením a vedle nich čísla naposledy nastavená v náramku; pod ním jsou čísla z Péče doma a Péče doma plus (chybějící červeně). Náramek hlásí přijetí v logu serveru (SOS1, SOS2, SOS3).

### Náramek v aplikaci na telefonu
- Rodina i mobilní dispečer mají kartu ⌚ Náramek SOS (za Nahrávkami, dole v liště záložka Náramek): stav a baterie, mapa polohy, grafy posledních 10 měření, tabulka měření po 10 a poplachy z náramku. Jen ke čtení, nic se tam neovládá.
- Karta je vidět jen u kamery s přiřazeným náramkem; vypnutý náramek tam svítí stejným červeným hlášením jako v dispečinku.
` },
  { id: 'deaktivace', obrazky: [], nazev: 'Deaktivace kamery rodinou', klicova: ['deaktiv', 'aktivov', 'vypnout kameru', 'zapnout kameru', 'strop', 'otocena', 'kamera vypnuta', 'deaktivovana rodinou', 'bez obrazu rodina'],
    obsah: `
Rodina může kameru kdykoli deaktivovat tlačítkem „⏻ Deaktivovat kameru“ ve své aplikaci (karta hned pod stavem; žádá potvrzení).

### Co deaktivace znamená
- Kamera nedává obraz nikomu: dispečinku, pečovatelům ani rodině.
- Nepořizuje žádnou nahrávku (ani ruční, ani po události, ani kritickou s nouzovým přístupem).
- Události z ní se nezapisují a nikdo není upozorněn.
- Kamera se otočí objektivem do stropu, aby bylo i v bytě vidět, že nic nesnímá.

### Jak to vidí dispečink
- Dlaždice má nápis „⏻ deaktivovaná rodinou“ s červeným rámem.
- V detailu je kdo a od kdy, tlačítka otáčení zmizí a Nahrát teď odmítne.

### Aktivace
- Aktivovat ji může zase jen rodina (▶ Aktivovat kameru): obraz a hlídání se vrátí podle nastavení a kamera se otočí do výchozí polohy.
- Obě změny jsou v historii kamery.
- Když se otočení nepodaří (kamera neodpoví), deaktivace platí dál a rodina i historie to uvidí.
` },
  { id: 'sledovani', obrazky: [{ src: '/proto/napoveda/sledovani.png', popis: 'Záložka Nastavení alertů v detailu kamery: Hlídat, Jen v hodinách, Nahrávat, SMS komu, E-mail komu' }], nazev: 'Sledování, nahrávání a upozornění (záložka Nastavení alertů)', klicova: ['sledov', 'hlidat', 'nahrav', 'hodiny', 'vypnout udalost', 'nezapsala', 'prekroceni', 'cara', 'zakryti', 'necinnost', 'zatrhnout', 'nastaveni kamery', 'plac', 'zvuk', 'sklo', 'vozidlo', 'zvire', 'oblast', 'vstup', 'detekce', 'co kamera umi'],
    obsah: `
### Záložky detailu kamery
- **Sledování – co se děje**: Monitoring (obraz, žádost o plný obraz, nouzový přístup, poznámky, historie, nahrávky) a Náramek.
- **Nastavení – jak se má chovat**: Komunikace a kontakty (uživatelé rodiny, kontakty pro upozornění, poznámky) a Nastavení alertů.

### Tabulka Sledování, nahrávání a upozornění
V záložce Nastavení alertů u každé události určujete:
- **Hlídat** – jestli se událost sleduje.
- **Jen v hodinách** – až tři časová okna na událost; tlačítkem + přidáte druhé a třetí (např. 07:00–08:00, 12:00–13:00 a 19:00–20:00). Okno přes půlnoc jde také (22:00–06:00). Hodiny se vybírají z nabídky po půlhodině (od – do).
- **Nahrávat** – jestli se k události ukládá nahrávka.
- **SMS komu** – jednotliví lidé z rodiny, dispečink, služba, administrace. Jsou tu i účty rodiny z Uživatelů rodiny (označené „(účet)“): telefon se bere z účtu, platí i po změně čísla; deaktivovaný účet SMS nedostane.
- **E-mail komu** – sada 1, sada 2.
- Příjemci se berou z kontaktů zadaných v Komunikaci a kontaktech; bez kontaktů jsou sloupce prázdné. Kritické události mají předem celou rodinu a obě sady e-mailů.

### Řádek Výchozí (Vše / Bez)
Nad tabulkou je řádek **Výchozí**: vyplňte v něm hlídat, hodiny, nahrávat a příjemce SMS a e-mailů a nad každým políčkem zvolte v rolovacím výběru **Vše** (hodnota toho sloupce se dosadí do všech událostí najednou, jednotlivé řádky pak doladíte) nebo **Bez** (u všech událostí ji zruší).

### Co kamera umí hlásit
- Z kamery Tapo jsou v tabulce všechny detekce, které umí hlásit: překročení čáry, vstup do hlídané oblasti, zakrytí nebo posunutí kamery, pláč, hlasitý nebo neobvyklý zvuk, rozbití skla, osoba, pohyb, vozidlo a zvíře (štěkot a mňoukání se počítají jako zvíře).
- Co z toho vaše kamera opravdu umí, záleží na modelu (C200 jen pohyb, C210/C220 i osobu, vozidlo, zvíře, čáru, oblast, pláč) a na tom, co je zapnuté v aplikaci Tapo. Vozidlo a zvíře jsou výchozí vypnuté.
- Rodina to vidí jen ke čtení v kartě „Co poskytovatel hlídá“ (🎞 nahrává, 📱 SMS, ✉ e-mail).

### Událost mimo hodiny nebo vypnutá
- Skutečná událost z kamery mimo nastavené hodiny se do historie zapíše jen jako informační řádek s poznámkou „(mimo hlídané hodiny …)“ – bez alertu, SMS, e-mailu i nahrávky.
- Vypnutá událost se nezapíše vůbec.
- Simulovaná událost mimo hodiny se nezapíše a panel Simulace ukáže, proč.
` },
  { id: 'upozorneni', obrazky: [{ src: '/proto/napoveda/kontakty.png', popis: 'Sekce Komunikace: kontakty rodiny a sady e-mailů pro upozornění' }], nazev: 'Upozornění SMS a e-mailem (kontakty kamery)', klicova: ['upozorn', 'kontakt', 'rodina', 'telefon sluzby', 'dispecink telefon', 'sada', 'e-mail', 'email', 'mail', 'sms pri udalosti', 'komu jde', 'nedosla', 'neprisla', 'kdo dostane'],
    obsah: `
Kontakty jsou v detailu kamery → záložka Komunikace a kontakty → „Kontakty pro upozornění“. Komu jde SMS a e-mail u které události, zatrháváte v záložce Nastavení alertů.

### Tři oddíly kontaktů
- **Rodina**: až pět lidí (jméno a český mobil).
- **Poskytovatel**: telefon dispečinku, služby a administrace, společné pro všechny kamery. U každého zvolte odkud: vlastní číslo (zadáte vedle), Péče doma (kontaktní telefon poskytovatele v databázi Péče doma, jedno číslo pro všechny tři), nebo Péče doma plus (telefon v nastavení tohoto tenanta; zadáte ho vedle a uloží se do Péče doma plus). Vpravo je vidět skutečné číslo a odkud je.
- **E-maily**: dvě sady adres oddělených čárkou (třeba sada 1 rodina, sada 2 lékař a pečovatelka).
- Pod Poskytovatelem je oddíl Telefonní čísla náramku (SOS 1 → 2 → 3): vybírá se z kontaktů výše a ukládá stejným tlačítkem; server čísla pošle do náramku (podrobnosti v tématu Náramek).
- Klepněte na **Uložit kontakty**; změna rodiny a e-mailů se zapíše do historie kamery. Číslo z Péče doma (plus) dosadí server při každé události i do náramku.

### Výběr příjemců u událostí
- V záložce Nastavení alertů u každé události zatrhněte ve sloupci SMS komu jednotlivé lidi z rodiny, dispečink, službu a administraci a ve sloupci E-mail komu sadu 1 a sadu 2.
- Kritické události (pád, dlouhé ležení, SOS, pád náramku) mají předem celou rodinu a obě sady; varování a informativní si nastavíte podle potřeby.
- Odchází jen to, co projde sloupcem Hlídat a hodinami.

### Co a jak se posílá
- SMS je bez diakritiky: jméno klienta, místo, událost a čas. E-mail má podrobnosti.
- V Historii je u události 📱 2/2 ✉ 1/1, tedy kolik zpráv odešlo; při chybě důvod po najetí myší.
- Posílá se přes stejný webhook Make jako pozvánky (SMS Twilio, e-mail ze schránky Centrum LB).
! Jestli je cesta nastavená, ověříte v ⚙ Nastavení tlačítky Poslat SMS a Poslat e-mail.
` },
  { id: 'poznamky', obrazky: [{ src: '/proto/napoveda/komunikace.png', popis: 'Sekce Komunikace v detailu kamery: poskytovatel, poznámka ke klientovi, dál uživatelé rodiny, kontakty a poznámky' }, { src: '/proto/napoveda/poznamky.png', popis: 'Poznámky dispečinku: pole, tlačítko a seznam s časem a jménem' }], nazev: 'Poznámky dispečinku ke kameře', klicova: ['poznamk', 'zapsat', 'zapis', 'zaznam', 'log', 'co jsem udelal', 'deník', 'denik'],
    obsah: `
### Poznámka ke klientovi
- V záložce Komunikace a kontakty je „Poznámka ke klientovi“: trvalá informace (zdravotní stav, na co dát pozor).
- Poskytovatel ji upraví tlačítkem Upravit; změna se zapíše do logu.

### Poznámky dispečinku
- Novou poznámku píšete v záložce Monitoring pod obrazem (pole „Přidat poznámku“, nebo Cmd+Enter), abyste při řešení alertu nemuseli přepínat záložky.
- Datum, čas a vaše jméno (přihlášený dispečer, jinak dispečer z ⚙ Nastavení) se doplní samy.
- Poznámky se zapisují do logu kamery jako události: jsou v historii v Monitoringu a samostatně v Komunikaci a kontaktech → Poznámky dispečinku, nejnovější nahoře.
- Vidí je všichni dispečeři; rodina je v historii nevidí, jsou interní pro poskytovatele.
- Hodí se na hovory s rodinou, výjezdy, domluvené kontroly.
` },
  { id: 'nahravky', nazev: 'Nahrávky na serveru a na Google Disku', klicova: ['nahravk', 'google', 'disk', 'video', 'zaznam', 'misto', 'limit', 'plny disk', 'pojistka', 'ulozit obraz', 'nahrat ted', 'adresar', 'kam se uklada'],
    obsah: `
Nahrává server, ne prohlížeč. Úložiště se volí v ⚙ Nastavení → Úložiště nahrávek.

### Kdy nahrávka vzniká
- Po každé události, která má v Nastavení alertů zatrženo Nahrávat: server uloží tolik sekund obrazu, kolik je v Nastavení (Nahrávka po události, výchozí 15 s).
- Nahrávka začíná před událostí: server drží posledních pár sekund obrazu každé kamery a přidá nastavený náběh (⚙ Nastavení → Obraz před událostí, 0–10 s, výchozí 5), takže na klipu je i samotné překročení čáry. Délka v seznamu je náběh plus sekundy po události.
- Tlačítko **Nahrát teď** v detailu kamery (a Nahrát 15 s v aplikaci rodiny) pořídí nahrávku stejnou cestou a do historie zapíše řádek „Ruční nahrávka“.
- Nahrávky z hlavní aplikace se ukládají také (zůstávají v režimu, ve kterém byly pořízeny).

### Soukromí
- Nahrává se jen při plném obrazu povoleném rodinou, nebo při kritické události (pád, SOS) s povoleným nouzovým přístupem.
- Při rozostření nebo drátěném modelu se nahrávka pořídí jen jako drátěný model: server z klipu vytáhne souřadnice postavy a obraz zahodí. V Nahrávkách je „🦴 přehrát drátěný model“ (animace kostry, klepnutím pauza), stažení dá soubor .json.
- Nahrávka pořízená v době, kdy měla rodina rozostřený obraz nebo drátěný model, je uzamčená (🔒): přehrát a stáhnout ji půjde, až ji rodina ve své aplikaci odemkne; odemknutí je v historii.
- Když se nahrávka nepořídí (žádný obraz), je důvod u události v historii (🎞 nenahráno: …) i v seznamu Nahrávky: nejčastěji rodina nepovolila plný obraz, nebo kamera v tu chvíli neposlala obraz. Podrobnosti má správce serveru v logu (pm2 logs famicura-tapo, řádky [nahravky]).

### Úložiště na serveru (doporučeno)
- Soubory jsou na našem serveru šifrované a přehrávají se jen v téhle aplikaci (dispečink, rodina u své kamery) tlačítkem ▶ přehrát.
- Každé přehrání i stažení se zapíše do auditu (kdo, kdy).
- Po době uchování (Uchovat nahrávky, výchozí 30 dnů) se samy smažou.
- Nahrávku jde stáhnout do počítače (⬇ stáhnout; soubor .mp4 se jmenuje podle kamery, data, času a události).
- Nahrávky se při uložení převádějí na obyčejný MP4, aby je přehrál i iPhone (Safari) a po stažení každý přehrávač; přehrávač v aplikaci startuje ztlumený (nahrávka zvuk nemá).

### Google Disk poskytovatele
- Stejný účet, jaký má poskytovatel připojený v portálu Péče doma plus v menu Export dat (nic dalšího se v Google nenastavuje).
- V ⚙ Nastavení je část Nahrávky na Google Disku: ukazuje připojený účet; tlačítkem Založit adresář vznikne na Disku adresář „Famicura Kamera – poskytovatel“. Jiný adresář jde založit až po Odpojit adresář (odpojený na Disku zůstává i s nahrávkami).
- Odkaz 🎞 je u události v historii a v seznamu Nahrávky v detailu kamery; soubor se otevře na Google Disku.

### Místo na serveru
- Mazání má tři stupně: po době uchování (Uchovat nahrávky, dnů); nad limit místa poskytovatele (Limit místa nahrávek, GB; 0 = bez limitu) se mažou nejstarší nahrávky poskytovatele; když je na celém serveru volno méně než pojistka správce (výchozí 5 GB), mažou se nejstarší nahrávky napříč poskytovateli.
! Když je místa málo, svítí nahoře v dispečinku oranžový proužek. Co s tím: zkrátit dobu uchování, zvýšit limit, nebo zapnout kopii na Google Disk jako archiv.
` },
  { id: 'log', nazev: 'Log událostí za období a stažení do Excelu', klicova: ['log', 'excel', 'xlsx', 'export', 'stahnout', 'obdobi', 'historie', 'vypis udalosti', 'od do', 'sesit', 'tabulka udalosti'],
    obsah: `
V detailu kamery, blok Historie (záložka Monitoring), je lišta s obdobím.

### Období
1. Zadejte datum od a do (stačí jedno).
2. Klepněte na **Zobrazit období**: historie se načte ze serverové databáze za celé období, ne jen posledních 12 událostí.
3. Zaškrtnutím „všechny kamery“ vidíte události celého dispečinku (u řádků je název kamery).
4. **Zpět na posledních 12** vrátí živý přehled.

### Filtr
- Čipy nad lištou (Vše, Kritické, Varování, Kamera, Analýza, S nahrávkou, S upozorněním, Souhlasy, Poznámky) filtrují typ událostí stejně jako v aplikaci rodiny, a to živě i ve zvoleném období.

### Stažení do Excelu
- **Stáhnout do Excelu** uloží sešit .xlsx se všemi údaji: datum, čas, kamera, událost, závažnost, zdroj, text z kamery, stav, kdo převzal, časy převzetí a uzavření, výsledek, poznámka, eskalace, kolik SMS a e-mailů odešlo, nahrávka a její důvod, původ kamera/simulace.
- Bez zadaného období se stáhne celá historie. Excel vždy obsahuje celé období bez filtru.
- Rodina log nemá, jen svou historii v aplikaci.
` },
  { id: 'otaceni', nazev: 'Otáčení kamery', klicova: ['otoc', 'otac', 'natoc', 'sipk', 'ptz', 'pan', 'tilt', 'vychozi poloha', 'pohnout kamerou'],
    obsah: `
Kamery Tapo s otočnou hlavou (C200, C210, C220) jdou otáčet přímo z aplikace.
- Na obraze v detailu kamery (dispečink) i v aplikaci rodiny je vpravo dole kříž šipek.
- Každé stisknutí kameru krátce pootočí daným směrem, ⌂ ji vrátí do výchozí polohy.
- Otáčí se přes ONVIF stejným účtem kamery jako události, nic dalšího se nenastavuje.
- Když kamera otáčení neumí nebo neodpoví, aplikace to řekne.
- Rodina otáčí jen svou kameru.
` },
  { id: 'svetlo', obrazky: [], nazev: 'Světlo kamery (reflektor)', klicova: ['svetlo', 'světlo', 'reflektor', 'rozsvit', 'zhasn', 'prisvit', 'lampa', 'c320ws', 'c520ws', 'c560ws', 'ucet tp-link', 'heslo tapo', 'zarovka'],
    obsah: `
Kamery Tapo s bílým reflektorem (C320WS, C520WS, C560WS a další s „WS“ v názvu) jdou rozsvítit přímo z dispečinku.

### Ovládání
- V detailu kamery je na obraze vlevo dole tlačítko 💡 Světlo.
- Klepnutím se reflektor rozsvítí (tlačítko zežloutne, „Světlo svítí“), dalším klepnutím zhasne.
- Do historie kamery se zapíše, kdo a kdy světlo přepnul.
- Světlo rozsvícené z dispečinku svítí, dokud ho někdo nezhasne (z dispečinku nebo v aplikaci Tapo); noční režim kamery to nemění.

### Kdy tlačítko není
- Tlačítko se ukáže jen u kamery, která světlo má; server se jí zeptá při otevření detailu. Kamera bez světla (C200, C210, C220) ho nemá.
- Světlo se ovládá přes místní rozhraní Tapo (HTTPS na kameře, tunelem), ne přes ONVIF. Obvykle stačí účet kamery.
- Když kamera na tohle rozhraní účet kamery nepustí, správce serveru uloží heslo účtu TP-Link (to, kterým se přihlašujete do aplikace Tapo): v hlavní aplikaci ve Správě kamer (Upravit → Heslo účtu TP-Link), nebo z Terminálu ./deploy/vps-kamera.sh svetlo ID_KAMERY.
- Stav světla a případnou chybu ukazuje Diagnostika v hlavní aplikaci (řádek „Světlo kamery …“).
` },
  { id: 'tisk', obrazky: [], nazev: 'Nápověda k vytištění nebo do PDF', klicova: ['tisk', 'vytisk', 'pdf', 'ulozit napovedu', 'dokumentace', 'prirucka', 'manual', 'navod'],
    obsah: `
Celá nápověda i s obrázky obrazovek jde vytisknout nebo uložit jako PDF.
1. V Nápovědě (tlačítko ? Nápověda vpravo nahoře) klepněte vpravo na liště Témata / Asistent na „🖨 Tisk / PDF“.
2. Otevře se nová stránka se všemi tématy a obsahem.
3. Tlačítko „Vytisknout / uložit jako PDF“ otevře dialog tisku prohlížeče: zvolte tiskárnu, nebo uložení do PDF (Mac: vlevo dole PDF → Uložit jako PDF; Windows: tiskárna „Uložit jako PDF“).
- Stránka nese číslo verze a datum tisku; téma Co je nové je až na konci na vlastní stránce.
` },
  { id: 'novinky', nazev: 'Co je nové', klicova: ['novink', 'co je nove', 'zmeny', 'verze', 'aktualizace'],
    obsah: `
- **Verze 3.46 (10. 10. 2026)**: v ⚙ Nastavení dispečinku je dole tlačítko Otevřít hlavní aplikaci (nová karta, heslo Famicura) – správa kamer, diagnostika a živý obraz pro správce serveru.
- **Verze 3.45 (10. 10. 2026)**: nápověda dispečinku je přehledně členěná – každé téma má nadpisy, odrážky, číslované kroky a zvýrazněná upozornění (v panelu Nápověda, v odpovědích asistenta i v tisku do PDF); obsah je stejný, jen čitelnější.
- **Verze 3.44 (10. 10. 2026)**: nad dlaždicemi kamer je přepínač Malé okno / Velké okno / Seznam – hodně kamer najednou, velké dlaždice jako dosud, nebo řádky s malým náhledem; volba se pamatuje v prohlížeči.
- **Verze 3.43 (10. 10. 2026)**: hlavní aplikace (heslo Famicura) je jen pro monitoring a správu kamer – Plán nahrávání a Sledované události z ní zmizely, sledování, nahrávání a upozornění se nastavují tady v dispečinku (Nastavení alertů).
- **Verze 3.42 (10. 10. 2026)**: kamery se zavádějí, převádějí k poskytovateli a mažou v hlavní aplikaci (heslo Famicura), karta Správa kamer – bez Terminálu a bez restartu serveru; dispečink poskytovatele tuto kartu nemá.
- **Verze 3.41 (10. 10. 2026)**: dispečinky dvou poskytovatelů jdou otevřít vedle sebe ve dvou kartách jednoho prohlížeče (každý tenant má vlastní přihlášení, odkaz …/dispecink.html?tenant=ID), odhlášení v jedné kartě nechá druhou přihlášenou.
- **Verze 3.40 (10. 10. 2026)**: v Nastavení alertů je nad událostmi řádek Výchozí – u každého sloupce rolovací výběr Vše (dosadí do všech událostí) / Bez (všude zruší); hodiny se vybírají z nabídky po půlhodině; SMS a e-mail o alertu obsahují jméno, místo, událost a čas, bez telefonu dispečinku; světlo kamery doladěné podle skutečné kamery (počítání pokusů, blokace).
- **Verze 3.39 (10. 10. 2026)**: světlo kamery – u kamer Tapo s reflektorem (C320WS, C520WS, C560WS) je v detailu kamery na obraze tlačítko 💡 Světlo, které reflektor rozsvítí a zhasne (zapíše se do historie); záložka Náramek říká na první pohled, jestli je náramek přiřazený (zelený pruh s ID a telefonem), bez náramku je v záložce jen přiřazení a na záložce je štítek „nepřiřazen“.
- **Verze 3.38 (9. 10. 2026)**: kamera přepnutá na H.265 (HEVC) se hlásí srozumitelně („Kamera posílá obraz v H.265 … přepněte v aplikaci Tapo na H.264“) v diagnostice, u obrazu i u nahrávky místo „Kamera neodpovídá“.
- **Verze 3.37 (9. 10. 2026)**: v historii je u události s nepovedenou nahrávkou jasně „🎞 nahrávka se nepořídila: …“, aby se to nepletlo s upozorněním (📱 ✉ = odeslané SMS a e-maily podle události).
- **Verze 3.36 (9. 10. 2026)**: v Nastavení alertů jdou ve sloupci SMS komu zatrhnout i účty rodiny (lidé z Uživatelů rodiny s telefonem), ne jen kontakty a telefony poskytovatele; telefon se bere z účtu, deaktivovaný účet SMS nedostane.
- **Verze 3.35 (9. 10. 2026)**: k náramku se povinně zadává telefonní číslo jeho SIM karty (Přiřazení náramku); je výrazně vidět ve Stavu náramku v dispečinku i na kartě Náramek v aplikaci na telefonu, klepnutím se na náramek zavolá.
- **Verze 3.34 (9. 10. 2026)**: grafy náramku v dispečinku jsou jemnější – čtyři malé karty 2×2 vedle mapy na její výšku, menší písmo a tenčí čáry.
- **Verze 3.33 (9. 10. 2026)**: grafy tepu, tlaku, kyslíku a teploty ukazují posledních 10 měření rovnoměrně vedle sebe s časem pod každým bodem (dřív časová osa 24 h, ve které se měření z jedné hodiny slila do chumlu); v dispečinku i v aplikaci na telefonu.
- **Verze 3.32 (9. 10. 2026)**: Telefonní čísla náramku (SOS) se nastavují v Komunikaci a kontaktech → Kontakty (oddíl pod Poskytovatelem) a ukládají se s kontakty; v záložce Náramek je jen přehled, koho náramek volá. Uložení už nezhatí chyba odeslání do náramku: čísla zůstanou uložená, důvod je pod výběry a server je pošle sám.
- **Verze 3.31 (9. 10. 2026)**: aplikace na telefonu (rodina i mobilní dispečer) má kartu ⌚ Náramek SOS – stav a baterie, mapa polohy, grafy posledních měření, tabulka měření a poplachy, jen ke čtení; dole v liště záložka Náramek.
- **Verze 3.30 (9. 10. 2026)**: nápověda jde vytisknout nebo uložit do PDF (odkaz Tisk / PDF v Nápovědě), témata a obrázky jsou aktualizované podle současných záložek a kontaktů, asistent má nové ukázkové otázky.
- **Verze 3.29 (9. 10. 2026)**: v Uživatelích rodiny je třetí typ účtu „Rodina i dispečer“ – u této kamery rodina, u všech ostatních dispečer.
- **Verze 3.28 (9. 10. 2026)**: účet, který je rodina i dispečer, má v aplikaci na telefonu v Můj účet přepínač režimu Rodina / Dispečer; v dispečinku má u své kamery odznak RODINA.
- **Verze 3.27 (9. 10. 2026)**: jeden telefon může být rodina u svých kamer a zároveň dispečer pro všechny ostatní (pozvánka dispečera na účet rodiny mu roli přidá); před pozvánkou dispečera je bezpečnostní dotaz.
- **Verze 3.26 (9. 10. 2026)**: mobilní dispečer – v Uživatelích rodiny jde založit účet typu Dispečer: stejná aplikace na telefonu, vidí všechny kamery poskytovatele, nic nenastavuje (jen barevné schéma), jasně označená jako aplikace dispečera, pozvánka SMS to říká, ukazuje se u všech kamer, poskytovatel jich může mít víc; účty rodiny i dispečera jde deaktivovat a zase aktivovat.
- **Verze 3.25 (8. 10. 2026)**: v záložce Náramek jsou napřed výsledky (stav, mapa a grafy, měření zdraví, poplachy) a až pod nimi ovládání a nastavení (měření, poloha, vypnutí, automatické měření, čísla SOS) a přiřazení ID zařízení.
- **Verze 3.24 (8. 10. 2026)**: záložky detailu kamery jsou ve dvou skupinách – Sledování (Monitoring, Náramek) modře a Nastavení (Komunikace a kontakty, Nastavení alertů) šedě s čárkovaným rámem.
- **Verze 3.23 (8. 10. 2026)**: kontakty kamery jsou pod sebou (jeden člověk, jeden telefon poskytovatele, jedna sada e-mailů na řádek); vypnutý náramek je jasně vidět – červené hlášení v záložce Náramek, odznak ⏻ na záložce a na dlaždici kamery, dokud se náramek zase neozve.
- **Verze 3.22 (8. 10. 2026)**: v Kontaktech kamery jsou oddíly Rodina, Poskytovatel a E-maily; poskytovatel má tři telefony – dispečink, služba, administrace – každý vlastní číslo, nebo z Péče doma / Péče doma plus (pole v ⚙ Nastavení jsou zrušená); čísla SOS náramku se vybírají jen z těchto kontaktů a server je při změně pošle do náramku znovu; příjemce SMS „administrace“; záložka Náramek je hned za Monitoringem.
- **Verze 3.21 (8. 10. 2026)**: nové kontakty kamery – rodina až pět lidí (jméno a mobil), dvě sady e-mailů oddělených čárkou, telefon dispečinku a telefon služby poskytovatele v ⚙ Nastavení (služba i z Péče doma / Péče doma plus); u každé události se vybírá, kdo dostane SMS (jednotliví lidé, dispečink, služba) a která sada e-mail.
- **Verze 3.20 (8. 10. 2026)**: číslo SOS má tři zdroje – vlastní, Péče doma (telefon poskytovatele, bez tenanta) a Péče doma plus (telefon služby tenanta, jde zadat v dispečinku); řádek „Náramek bude volat“ ukazuje skutečná čísla a co je naposledy v náramku.
- **Verze 3.19 (8. 10. 2026)**: číslo SOS náramku může být „číslo služby (Péče doma)“ – server dosadí telefon služby poskytovatele z Péče doma plus nebo Péče doma a při jeho změně ho do náramku pošle znovu.
- **Verze 3.18 (8. 10. 2026)**: čísla SOS náramku (až tři) jdou nastavit v záložce Náramek; server je pošle do náramku hned, nebo při jeho příštím ozvání.
- **Verze 3.17 (8. 10. 2026)**: v záložce Náramek jsou vedle mapy grafy měření za posledních 24 hodin (tep, tlak, kyslík, teplota) s pásmem běžného rozmezí a hodnoty mimo rozmezí jsou v tabulce i grafu oranžově (špatné) nebo červeně (výrazně špatné).
- **Verze 3.16 (8. 10. 2026)**: hodnoty z jedné sady měření (tep a tlak, kyslík, teplota) jsou v tabulce Měření zdraví i v Excelu v jednom řádku.
- **Verze 3.15 (8. 10. 2026)**: měření zdraví je jedno tlačítko Změřit zdraví (tep, tlak, kyslík, teplotu) a jedno zatržítko v automatickém měření; tabulka měření je trvalá v databázi, stránkuje se po 10/20/50/100 a jde stáhnout do Excelu.
- **Verze 3.14 (8. 10. 2026)**: měření teploty posílá správný příkaz bodytemp2 (btemp2 byl jen název hlášení, proto teplota nechodila); tlačítko Vypnout náramek je červené a chce heslo hlavní aplikace Famicura, které ověřuje server.
- **Verze 3.13 (8. 10. 2026)**: v záložce Náramek je jedno tlačítko Změřit tep a tlak (ReachFar V48 posílá tep jen s tlakem) a pole pro vlastní příkaz s tabulkou příkazů je zrušené; u poplachů z náramku i ve frontě a historii je místo souřadnic odkaz „mapa“, který otevře polohu v novém okně.
- **Verze 3.11 (8. 10. 2026)**: v záložce Náramek je mapa poslední polohy, tlačítka Změřit tep / tlak / kyslík / teplotu, Zjistit polohu a Vypnout náramek, automatické měření v nastaveném intervalu (server posílá příkazy sám) a pole pro vlastní příkaz podle dokumentace modelu.
- **Verze 3.10 (8. 10. 2026)**: náramek má v detailu kamery vlastní záložku ⌚ Náramek: přiřazení, stav (ozvání, baterie, poloha i přibližná z mobilní sítě), poslední měření zdraví a tabulka měření (tep, tlak, kyslík, teplota), poplachy z náramku; poplach V48 (AL_LTE) se přijímá.
- **Verze 3.9 (8. 10. 2026)**: náramky a přívěsky SOS (ReachFar V48 a další s protokolem hodinek) se připojují přímo na server; v detailu kamery → záložka ⌚ Náramek zadáte ID zařízení a SOS, pád a slabá baterie pak jdou do fronty té kamery jako Nouzové tlačítko, Pád hlášený náramkem a Slabá baterie náramku (včetně SMS, e-mailu a nahrávky podle Nastavení); vidíte, kdy se přívěsek naposledy ozval, baterii a poslední polohu.
- **Verze 3.8 (7. 10. 2026)**: kamera se po aktivaci rodinou vrací na záběr, který měla před deaktivací (server si před otočením do stropu uloží polohu), deaktivace stisknutá hned po otočení šipkou počká na dokončení kroku místo chyby „kamera se právě otáčí“; kamera přiřazená jinému poskytovateli zmizí i z účtu rodiny u původního poskytovatele (aplikace rodiny to řekne zprávou, dřív se tiše přepnula do simulace a vypadala zamrzle) a akce, kterou server odmítne nebo do 30 s nevyřídí, skončí srozumitelnou chybou.
- **Verze 3.7 (7. 10. 2026)**: kamera přiřazená jinému poskytovateli zmizí z původního dispečinku (historie zůstává) a název i místo kamery se drží podle serveru.
- **Verze 3.6 (7. 10. 2026)**: odkaz na dispečink s ID jiného poskytovatele (?tenant=…) má přednost před přihlášením v prohlížeči – ukáže přihlášení k tomu poskytovateli.
- **Verze 3.5 (7. 10. 2026)**: deník a seznam nahrávek na telefonu mají datum na vlastním řádku nad textem (dřív se překrývalo).
- **Verze 3.4 (7. 10. 2026)**: v ⚙ Nastavení → Zobrazení si každý dispečer zvolí barevné schéma dispečinku (modrá, tyrkysová, zelená, fialová, oranžová, grafitová, tmavě modrá); platí jen v jeho prohlížeči.
- **Verze 3.3 (7. 10. 2026)**: dispečink jde používat i na telefonu (kompaktní záhlaví, fronta alertů nahoře, tabulka Sledování se posouvá do strany) a jeho záhlaví je světlejší modré než u aplikace rodiny.
- **Verze 3.2 (6. 10. 2026)**: rodina může kameru ve své aplikaci deaktivovat (⏻ Deaktivovat kameru) a zase aktivovat; deaktivovaná kamera nedává obraz nikomu, nenahrává, nezapisuje události a otočí se do stropu, dispečink ji vidí jako „deaktivovaná rodinou“.
- **Verze 3.1 (6. 10. 2026)**: skutečná událost z kamery mimo hlídané hodiny se do historie zapíše jako informační řádek s poznámkou „mimo hlídané hodiny“ – bez alertu, SMS, e-mailu a nahrávky (dřív se zahodila úplně); vypnutá událost se nezapisuje dál.
- **Verze 3.0 (6. 10. 2026)**: nahrávka po události i tlačítkem Nahrát je vždy v plném obrazu; když má rodina zrovna rozostřený obraz nebo drátěný model, je nahrávka uzamčená – v Nahrávkách je „🔒 nahrávka uzamčena“ a přehrát ji půjde, až ji rodina ve své aplikaci odemkne (odemknutí je v historii). Drátěný model z nahrávek (2.8–2.9) je zrušen.
- **Verze 2.9 (5. 10. 2026)**: drátěný model přes obraz v dispečinku je výrazné tlačítko a je po spuštění zapnutý; přes skutečný obraz se kreslí jen skutečná postava z modelu v prohlížeči (ukázková postava patří jen k náhradní scéně); jednotné názvy režimů ve všech aplikacích (plný obraz, rozostřený obraz, drátěný model, bez obrazu).
- **Verze 2.8 (5. 10. 2026)**: když rodina povolila jen rozostření nebo drátěný model, nahrávka po události vznikne jako drátěný model (jen kostra postavy, bez obrazu) a přehraje se jako animace tlačítkem 🦴 v Nahrávkách; plný obraz se ukládá dál jen při plném obrazu nebo nouzovém přístupu.
- **Verze 2.7 (5. 10. 2026)**: nahrávka po události obsahuje i obraz před ní (⚙ Nastavení → Obraz před událostí, výchozí 5 s; server drží posledních pár sekund obrazu každé kamery) a události kamer zpracovává server sám každé 2 sekundy, takže nahrávka, SMS a e-mail odcházejí hned i bez otevřeného dispečinku.
- **Verze 2.6 (4. 10. 2026)**: hlídání místa na serveru – pojistka proti plnému disku (pod nastavené volné místo se mažou nejstarší nahrávky), limit místa na poskytovatele v Nastavení (výchozí 2 GB) a oranžové varování nahoře v dispečinku, když je místa málo nebo je poskytovatel u limitu.
- **Verze 2.5 (4. 10. 2026)**: v detailu kamery (Monitoring → Historie) jde zvolit období od–do, zobrazit události z databáze (jedné kamery nebo všech) a stáhnout je do Excelu; detail kamery je rozdělený do ohraničených bloků s tlačítky v jedné liště; nahrávka po události, která se nepořídila, má vždy vidět důvod (🎞 nenahráno: …) v historii i v Nahrávkách.
- **Verze 2.4 (4. 10. 2026)**: v Nastavení kamery jsou všechny události, které kamera Tapo hlásí: k překročení čáry, zakrytí, osobě a pohybu přibyly vstup do hlídané oblasti, pláč, hlasitý nebo neobvyklý zvuk, rozbití skla, vozidlo a zvíře (vozidlo a zvíře jsou výchozí vypnuté).
- **Verze 2.3 (4. 10. 2026)**: Google Disk jde v Nastavení zapnout a vypnout (zapnuto = kopie každé nahrávky vedle serveru); v Nastavení je vidět, kolik nahrávky zabírají na serveru a kolik je volného místa; kameru Tapo jde otáčet šipkami na obraze v detailu kamery i v aplikaci rodiny (⌂ = výchozí poloha).
- **Verze 2.2 (4. 10. 2026)**: druhá volba úložiště nahrávek – na serveru (doporučeno): šifrované soubory na našem serveru, přehrávání jen v aplikaci (dispečink i rodina u své kamery, tlačítko ▶ přehrát), každé přehrání v auditu, automatické mazání po nastavené době (výchozí 30 dnů), ruční smazání; nahrávka z hlavní aplikace zůstává v režimu, ve kterém byla pořízena; evidence každé nahrávky v CLB1. Volba Server / Google Disk a doba uchování jsou v Nastavení.
- **Verze 2.1 (4. 10. 2026)**: nahrávky z kamer na Google Disk poskytovatele – stejný Google účet jako v Péče doma plus (Export dat), adresář se zakládá v Nastavení dispečinku; server po události se zatrženým Nahrávat uloží nastavený počet sekund obrazu (jen při plném obrazu, nebo kritická událost s nouzovým přístupem), v detailu kamery je tlačítko Nahrát teď a seznam Nahrávky, odkaz 🎞 je u události v historii; nahrávky z hlavní aplikace jdou na Disk také. Tunel pro více míst: kamera u jiného poskytovatele má vlastní bránu (Mango) a vlastní místo v tunelu (wireguard-vps.sh --misto 2).
- **Verze 2.0 (3. 10. 2026)**: konec prototypu – každý poskytovatel (tenant Péče doma plus) má svá data v databázi PeceDomaPlus (tabulky A_KAM_*), nic společného a nic v Softru. Dispečink se otevírá odkazem s ID tenanta (?tenant=…), které si prohlížeč pamatuje; dispečer se přihlašuje účtem Péče doma plus, správce serveru heslem správce; v záhlaví je poskytovatel a kdo je přihlášen. Kamery patří tenantovi (vps-kamera.sh tenant …), dlaždice ukazují jen jeho kamery, demo a Vynulovat v ostrém provozu nejsou. Údaje poskytovatele začínají názvem z Péče doma plus.
- **Verze 1.1 (3. 10. 2026)**: v aplikaci rodiny je vlastní obraz vždy ostrý a volba zobrazení (rozostření, černé pozadí, drátěný model) je schovaná za tlačítkem Test obrazu; zavřením testu se vrátí ostrý obraz. Tři tlačítka Ostrý / Rozmazaný / Drátěný model pro poskytovatele zůstávají v kartě Přístup poskytovatele. Dál: detail kamery v dispečinku je rozdělený do sekcí Monitoring, Komunikace a Nastavení. Ke každé kameře jdou zadat až tři čísla na SMS a tři e-maily (Komunikace → Kontakty pro upozornění) a u každé události zatrhnout Nahrávat, SMS a E-mail (Nastavení); server při události upozorní, historie ukazuje, kolik zpráv odešlo. E-mail jde stejným webhookem Make jako SMS, v Nastavení (ozubené kolečko) je zkušební SMS i zkušební e-mail a varování, když je na serveru zaměněná adresa webhooku. Oprava 3. 10. 2026 odpoledne: SMS rodině (pozvánky, žádosti o plný obraz) jdou přes Twilio stejným spojením jako SMS Jarvise; dřívější cesta hlásila odesláno, ale SMS nedocházely. V Nastavení (ozubené kolečko) je sekce SMS rodině s tlačítkem Poslat zkušební SMS na vlastní číslo.
- **Verze 1.0 (3. 10. 2026)** , číslo verze je v hlavičce každé aplikace. Aplikace rodiny už nemá panel Simulace; zapne se odkazem /proto/rodina.html?simulace=1 (ukázka ?ukazka=1 ho má vždy). Při žádosti o plný obraz odchází rodině SMS. Dál: trvalá poznámka ke klientovi pod obrazem jde upravit; odkaz z pozvánky má přednost před přihlášením v prohlížeči; dispečink a provoz jen po přihlášení poskytovatele; nastavení pod ozubeným kolečkem vpravo nahoře (poskytovatel, dispečink, eskalace, zobrazení); poznámky dispečinku ke kameře s časem a jménem; nápověda s obrázky obrazovek a asistent v grafice Case manageru; údaje poskytovatele na jednom místě pro dispečink i rodinu; karta Směna počítá z dnešních alertů. 2. 10. 2026: stav sdílený přes server (rodina na telefonu, dispečink na počítači); přepínač Jen skutečné kamery / Demo; přihlášení přímo v dispečinku; v aplikaci rodiny karta Přístup poskytovatele s rychlým přepnutím Ostrý / Rozmazaný / Drátěný model, časy dne a noci, Klid na 2 hodiny / do rána / do večera / do vypnutí, žádost o plný obraz přes celou obrazovku se zvukem.
` },
  { id: 'zdroj', nazev: 'Kamery poskytovatele', klicova: ['demo', 'skutecn', 'fiktiv', 'ukazk', 'prepinac', 'kolik kamer', 'jedna dlazdice', 'chybi pacient', 'nova kamera', 'prirazeni kamery'],
    obsah: `
Dlaždice ukazují kamery přiřazené vašemu poskytovateli (tenantovi).
- Kameru přiřazuje správce serveru: v hlavní aplikaci ve Správě kamer (tlačítko Poskytovatel), nebo z Terminálu ./deploy/vps-kamera.sh tenant ID_KAMERY ID_TENANTA.
- Nová kamera se v dispečinku objeví sama s výchozím nastavením.
- Fiktivní ukázkoví pacienti jsou jen v ukázce bez přihlášení (/proto/?ukazka), v dispečinku poskytovatele nejsou.

### Dva poskytovatelé najednou
- Otevřete dva odkazy ve dvou kartách (…/proto/dispecink.html?tenant=ID jednoho a druhého) a v každé se přihlaste.
- Každý poskytovatel má vlastní přihlášení (od verze 3.41): karty se nepřehazují a odhlášení v jedné druhou nechá přihlášenou.
` },
  { id: 'poskytovatel', obrazky: [{ src: '/proto/napoveda/zahlavi.png', popis: 'Záhlaví: údaje poskytovatele vlevo, vpravo nahoře Nápověda a ozubené kolečko' }, { src: '/proto/napoveda/nastaveni.png', popis: 'Nastavení pod ozubeným kolečkem: poskytovatel, dispečink, zobrazení' }], nazev: 'Nastavení (ozubené kolečko)', klicova: ['nastaven', 'hlavni aplikac', 'sprava kamer', 'poskytovatel', 'zahlavi', 'dispecer', 'smena', 'zaloha', 'vedouci', 'eskalac', 'jmeno', 'upravit', 'nazev sluzby', 'kolecko'],
    obsah: `
Ozubené kolečko vpravo nahoře otevře Nastavení. Ukládá se tlačítkem **Uložit** na server: stejné údaje vidí všichni dispečeři, záhlaví, karta Směna, detail kamery i aplikace rodiny (název a telefon dispečinku).

### Co se nastavuje
- **Poskytovatel**: název služby a e-mail. Telefony dispečinku, služby a administrace se zadávají v detailu kamery → Komunikace a kontakty → Poskytovatel a platí pro všechny kamery.
- **Dispečink**: dispečer(ka) ve službě, směna, záloha s telefonem, vedoucí s telefonem a po kolika minutách eskaluje nepřevzatý kritický alert. Jméno dispečera se zapisuje k převzetí alertů, k poznámkám a do žádostí o obraz.
- **Nahrávky**: sekund po události, obraz před událostí, úložiště server / Google Disk, doba uchování, limit místa.
- **Zobrazení**: barevné schéma dispečinku pro tento počítač.
- **Zkušební SMS a e-mail** ze serveru.
- **Hlavní aplikace**: tlačítko Otevřít hlavní aplikaci (nová karta, heslo Famicura) pro správce serveru – správa kamer, diagnostika, živý obraz.
- Enter v poli jen přeskočí na další pole; okno zavře jen Uložit, Zavřít nebo Esc.
` },
  { id: 'prihlaseni', obrazky: [{ src: '/proto/napoveda/prihlaseni.png', popis: 'Bez přihlášení server pošle jen tuhle stránku; po přihlášení naběhne dispečink' }], nazev: 'Přihlášení a poskytovatel (tenant)', klicova: ['prihlas', 'heslo', 'odhlas', '12 hodin', 'nejde se prihlasit', 'prihlaseni', 'tenant', 'poskytovatel id', 'pece doma plus', 'ucet'],
    obsah: `
Dispečink a provoz jsou jen pro přihlášené dispečery poskytovatele.

### Poskytovatel (tenant)
- Poskytovatel je ten samý jako v portálu Péče doma plus. Jeho ID je v odkazu na dispečink (?tenant=22202480FAMICURA), nebo ho zadáte na přihlašovací stránce; prohlížeč si ho pamatuje.
- Odkaz s ID jiného poskytovatele ukáže přihlášení k tomu druhému; každý poskytovatel má vlastní účty.
- Každý poskytovatel má svá vlastní data: kamery, účty rodiny, souhlasy, události i nastavení, v databázi PeceDomaPlus.

### Kdo se jak přihlašuje
- Dispečer stejným jménem a heslem jako do portálu Péče doma plus (Uživatelé a přihlašování); přihlášení platí 12 hodin.
- Správce serveru heslem Famicura; vidí dispečink zvoleného poskytovatele jako „Správce“.
- Rodina má vlastní účty (telefon a heslo) a vlastní aplikaci.
! Po 10 chybných pokusech se na 15 minut nepřihlásí nikdo.
` },
  { id: 'klid', obrazky: [{ src: '/proto/napoveda/rodina-pristup.png', popis: 'Telefon rodiny: karta Přístup poskytovatele a Klid' }], nazev: 'Klid a notifikace rodiny', klicova: ['klid', 'notifik', 'upozorn', 'rodina nedostala', 'ticho', 'do rana', 'do vecera'],
    obsah: `
Rodina si může zapnout Klid: na 2 hodiny, do rána, do večera, nebo do vypnutí.
- Informativní zprávy a varování jí pak nechodí; kritické (pád, SOS) vždy.
- Žádost o plný obraz a nouzový přístup rodina dostane vždy.
- Dispečinku se Klid netýká, fronta alertů běží dál.
` },
  { id: 'obraz', obrazky: [{ src: '/proto/napoveda/diagnostika.png', popis: 'Lišta nahoře, když obraz z kamery nejde; odkaz na Diagnostiku v hlavní aplikaci' }], nazev: 'Když obraz z kamery nejde', klicova: ['nejde obraz', 'nahradni scena', 'vypadek', 'nedostupn', 'offline', 'tunel', 'mango', 'diagnostik', 'kamera neodpovida', 'spojeni'],
    obsah: `
Když dlaždice kreslí náhradní scénu místo kamery, je nahoře oranžová lišta s důvodem a tlačítkem Hlavní aplikace a diagnostika.

### Postup
1. Tlačítko **Načíst znovu** v liště zkusí obraz připojit znovu.
2. V Diagnostice hlavní aplikace: kamera „odpovídá“ a události „odebírám“ znamená, že je vše v pořádku.
3. Jinak je problém v tunelu (brána Mango u klienta bez internetu, nebo výpadek proudu) nebo v účtu kamery. Postup je v README projektu (kapitoly 2c a Diagnostika).

### Hláška H.265
! „Kamera posílá obraz v H.265 (HEVC)“: kamera je v aplikaci Tapo přepnutá na H.265, server umí jen H.264. Obraz i nahrávky selhávají, dokud se v aplikaci Tapo u kamery nepřepne Kódování videa na H.264 (Nastavení kamery → Pokročilá nastavení → Video), nebo správce ve Správě kamer nepřepne kameru na kvalitu 2.
` },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/** Strukturovaný obsah tématu → HTML (h4, ul/ol, p, p.tip); text je vždy escapovaný. */
export function napovedaHtml(obsah) {
  const out = []; let seznam = null;
  const uzavri = () => { if (seznam) { out.push(`<${seznam.tag}>${seznam.polozky.map((p) => `<li>${p}</li>`).join('')}</${seznam.tag}>`); seznam = null; } };
  const polozka = (tag, text) => { if (!seznam || seznam.tag !== tag) { uzavri(); seznam = { tag, polozky: [] }; } seznam.polozky.push(inline(text)); };
  for (const radek of String(obsah || '').split('\n')) {
    const r = radek.trim(); let m;
    if (!r) { uzavri(); continue; }
    if ((m = r.match(/^###\s+(.*)$/))) { uzavri(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = r.match(/^-\s+(.*)$/))) polozka('ul', m[1]);
    else if ((m = r.match(/^\d+\.\s+(.*)$/))) polozka('ol', m[1]);
    else if ((m = r.match(/^!\s+(.*)$/))) { uzavri(); out.push(`<p class="tip">${inline(m[1])}</p>`); }
    else { uzavri(); out.push(`<p>${inline(r)}</p>`); }
  }
  uzavri();
  return out.join('');
}

/** Strukturovaný obsah → prostý text (bez značek), pro vyhledávání a asistenta bez AI. */
export function napovedaProsty(obsah) {
  return String(obsah || '').split('\n').map((l) => l.trim().replace(/^###\s+/, '').replace(/^[-!]\s+/, '').replace(/^\d+\.\s+/, '').replace(/\*\*/g, '')).filter(Boolean).join(' ');
}
for (const t of TEMATA) t.text = napovedaProsty(t.obsah);

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Odpověď z nápovědy: nejlépe odpovídající téma (text i html), nebo nabídka témat. */
export function odpovez(dotaz) {
  const q = norm(dotaz).trim();
  if (!q) return { text: 'Napište, s čím potřebujete poradit, třeba „jak požádat o plný obraz“.', tema: null };
  if (/^(ahoj|dobry den|dobry vecer|zdravim|cau|hello)\b/.test(q)) return { text: 'Dobrý den. Zeptejte se na cokoli k dispečinku: režimy obrazu, žádost o plný obraz, nouzový přístup, alerty, účty rodiny a mobilní dispečer, náramek SOS, kontakty a upozornění, nahrávky, sledování, přihlášení.', tema: null };
  if (/^(dekuj|diky|dik)\b/.test(q)) return { text: 'Rádo se stalo.', tema: null };
  let best = null, bestSkore = 0;
  for (const t of TEMATA) {
    let skore = 0;
    for (const k of t.klicova) if (q.includes(norm(k))) skore += k.length > 5 ? 2 : 1;
    if (q.includes(norm(t.nazev))) skore += 3;
    if (skore > bestSkore) { best = t; bestSkore = skore; }
  }
  if (best) return { text: best.text, html: napovedaHtml(best.obsah), tema: best.id, nazev: best.nazev };
  return { text: 'Tohle v nápovědě nemám. Témata: ' + TEMATA.map((t) => t.nazev).join(', ') + '. Zkuste otázku jinak, nebo otevřete téma v Nápovědě vedle.', tema: null };
}

/** Celá nápověda jako text (podklad pro AI přes webhook) – se strukturou, ať se v ní AI vyzná. */
export function napovedaText() { return TEMATA.map((t) => `## ${t.nazev}\n${t.obsah}`).join('\n\n'); }
