/*
 * Nápověda dispečinku a asistent. Témata slouží panelu Nápověda i asistentovi:
 * ten hledá v otázce klíčová slova a odpoví textem tématu. Když je na serveru
 * nastavený webhook asistenta (ASISTENT_WEBHOOK_URL, scénář Make s AI),
 * odpovídá AI s touhle nápovědou jako podkladem; bez něj odpovídá jen odsud.
 */
export const TEMATA = [
  { id: 'prehled', obrazky: [{ src: '/proto/napoveda/dlazdice.png', popis: 'Dlaždice kamer se štítkem režimu, který platí teď' }, { src: '/proto/napoveda/detail.png', popis: 'Detail kamery: co rodina povolila a proč, drátěný model přes obraz' }], nazev: 'Dlaždice a režimy obrazu', klicova: ['dlazdic', 'rezim', 'obraz', 'rozostr', 'rozmaz', 'drateny', 'kostra', 'plny obraz', 'bez obrazu', 'co vidim', 'proc nevidim', 'cerny', 'skeleton', 'blur'],
    text: 'Každá dlaždice ukazuje kameru v režimu, který povolila rodina: plný obraz, rozostření, drátěný model (jen kostra postavy) nebo bez obrazu (jen události). Štítek na dlaždici říká, který režim platí teď; v detailu je i proč (denní nebo noční nastavení rodiny, rychlé přepnutí rodiny, povolení na vaši žádost). Rodina si nastavuje režim pro den a pro noc a čas, kdy den a noc začínají, a může obraz kdykoli rychle přepnout do dalšího střídání den/noc. Dispečink režim sám nemění; může jen požádat o plný obraz nebo v kritické situaci použít nouzový přístup.' },
  { id: 'zadost', obrazky: [{ src: '/proto/napoveda/zadost.png', popis: 'Detail kamery: Požádat rodinu o plný obraz s důvodem' }, { src: '/proto/napoveda/rodina-zadost.png', popis: 'Telefon rodiny: žádost přes celou obrazovku s tlačítky Povolit / Odmítnout' }], nazev: 'Žádost o plný obraz', klicova: ['zadost', 'pozadat', 'plny obraz', 'povolit', 'povoleni', '15 minut', 'do odvolani', 'rodina nereaguje', 'odmit'],
    text: 'Klepněte na dlaždici, v detailu na „Požádat rodinu o plný obraz“, vyberte důvod (rodina ho uvidí) a odešlete. Rodině na telefonu vyskočí žádost přes celou obrazovku, bliká a zní, dokud ji nevyřídí: Povolit na 15 minut, Povolit do odvolání, nebo Odmítnout. Žádost platí 10 minut; bez odpovědi zůstane dosavadní režim. Po povolení ukazuje dlaždice plný obraz, rodina vidí, kdo se dívá, a může přístup kdykoli ukončit. Vy ho ukončíte tlačítkem „Ukončit plný obraz“.' },
  { id: 'nouze', obrazky: [{ src: '/proto/napoveda/nouze.png', popis: 'Tlačítko Nouzový přístup 10 min v detailu kamery' }], nazev: 'Nouzový přístup', klicova: ['nouz', 'nouzovy', 'pad', 'sos', 'kriticky', 'bez souhlasu', '10 minut'],
    text: 'Nouzový přístup otevře plný obraz na 10 minut bez čekání na rodinu. Jde to jen při otevřeném kritickém alertu (pád, dlouhé ležení, SOS) a jen když rodina nouzový přístup předem povolila (přepínač „V nouzi plný obraz“ v aplikaci rodiny). Rodina dostane okamžitě zprávu, zásah je v historii (auditu). Tlačítko je v detailu kamery vedle žádosti o plný obraz.' },
  { id: 'alerty', obrazky: [{ src: '/proto/napoveda/fronta.png', popis: 'Fronta alertů vpravo: Převzít, Řeším, Uzavřít s výsledkem; červený pruh u kritických' }], nazev: 'Fronta alertů: převzít, řešit, uzavřít', klicova: ['alert', 'fronta', 'prevzit', 'prevzat', 'resim', 'uzavrit', 'uzavren', 'eskal', 'vysledek', 'plany poplach', 'vyjezd', 'zachran'],
    text: 'Nový alert se objeví ve frontě vpravo a u kritických i v červeném pruhu nahoře se zvukem. Postup: Převzít (alert je váš, rodina vidí vaše jméno) → Řeším → Uzavřít s výsledkem (planý poplach, vyřešeno na dálku, výjezd pečovatele, záchranná služba, předáno rodině). Nepřevzatý kritický alert po 2 minutách eskaluje na zálohu a vedoucího. Informativní události (osoba, pohyb) do fronty nejdou, jsou jen v historii.' },
  { id: 'rodina', obrazky: [{ src: '/proto/napoveda/uzivatele.png', popis: 'Uživatelé rodiny v detailu skutečné kamery: založení účtu a pozvánka SMS' }], nazev: 'Uživatelé rodiny a pozvánka SMS', klicova: ['rodin', 'uzivatel', 'pozvank', 'sms', 'ucet', 'heslo', 'telefon', 'prihlasit rodinu', 'zapomn', 'odebrat'],
    text: 'V detailu skutečné kamery je část „Uživatelé rodiny“. Zadejte jméno a telefon, zaškrtněte „poslat SMS ze serveru“ a založte účet: rodina dostane SMS s odkazem, při prvním otevření si zvolí heslo a dál se přihlašuje telefonem a heslem. Odkaz platí 7 dní a je na jedno použití. Zapomenuté heslo: „Nová pozvánka (nové heslo)“ pošle nový odkaz a staré heslo přestane platit. „Odebrat“ účet zruší a rodinu odhlásí.' },
  { id: 'sledovani', obrazky: [{ src: '/proto/napoveda/sledovani.png', popis: 'Tabulka Sledování a nahrávání v detailu kamery' }], nazev: 'Sledování a nahrávání', klicova: ['sledov', 'hlidat', 'nahrav', 'hodiny', 'vypnout udalost', 'nezapsala', 'prekroceni', 'cara', 'zakryti', 'necinnost'],
    text: 'V detailu kamery v tabulce „Sledování a nahrávání“ určujete, které události se hlídají, jen v kterých hodinách a jestli se k nim ukládá nahrávka. Rodina to vidí jen ke čtení v kartě „Co poskytovatel hlídá“. Událost mimo nastavené hodiny nebo vypnutá se nezapíše; panel Simulace pak ukáže, proč. Kritické události (pád, SOS) doporučujeme nechat zapnuté bez omezení.' },
  { id: 'zdroj', obrazky: [{ src: '/proto/napoveda/zdroj.png', popis: 'Přepínač Jen skutečné kamery / Demo nad dlaždicemi' }], nazev: 'Jen skutečné kamery / Demo', klicova: ['demo', 'skutecn', 'fiktiv', 'ukazk', 'prepinac', 'kolik kamer', 'jedna dlazdice', 'chybi pacient'],
    text: 'Přepínač nad dlaždicemi: „Jen skutečné kamery“ ukáže pouze kamery připojené k serveru, „Demo (i fiktivní)“ přidá ukázkové pacienty pro předvádění. Volba platí pro tento prohlížeč; v adrese jde vynutit ?zdroj=demo nebo ?zdroj=real. Fronta alertů, počty i panel Simulace se řídí stejnou volbou.' },
  { id: 'poskytovatel', obrazky: [{ src: '/proto/napoveda/nastaveni.png', popis: 'Nastavení pod ozubeným kolečkem: poskytovatel, dispečink, zobrazení' }], nazev: 'Údaje poskytovatele (záhlaví)', klicova: ['poskytovatel', 'zahlavi', 'dispecer', 'smena', 'zaloha', 'jmeno', 'upravit', 'nazev sluzby'],
    text: 'Tlačítko „Upravit“ v záhlaví otevře údaje poskytovatele: název služby, telefon, jméno dispečera, směnu a zálohu. Zadávají se na jednom místě a ukládají na server: stejné údaje vidí všichni dispečeři, detail kamery i aplikace rodiny (název a telefon poskytovatele). Jméno dispečera se zapisuje k převzetí alertů a do žádostí o obraz.' },
  { id: 'prihlaseni', obrazky: [{ src: '/proto/napoveda/prihlaseni.png', popis: 'Přihlášení heslem Famicura přímo v okně dispečinku' }], nazev: 'Přihlášení', klicova: ['prihlas', 'heslo famicura', 'odhlas', '12 hodin', 'nejde se prihlasit', 'prihlaseni'],
    text: 'Dispečink se přihlašuje heslem Famicura (stejné jako hlavní aplikace); přihlášení platí 12 hodin pro dispečink, provoz i hlavní aplikaci v tomhle prohlížeči. Po 10 chybných pokusech se na 15 minut nepřihlásí nikdo. Heslo mění správce skriptem vps-env.sh. Rodina má vlastní účty (telefon a heslo), ty dispečink nepotřebuje.' },
  { id: 'klid', obrazky: [{ src: '/proto/napoveda/rodina-pristup.png', popis: 'Telefon rodiny: karta Přístup poskytovatele a Klid' }], nazev: 'Klid a notifikace rodiny', klicova: ['klid', 'notifik', 'upozorn', 'rodina nedostala', 'ticho', 'do rana', 'do vecera'],
    text: 'Rodina si může zapnout Klid (na 2 hodiny, do rána, do večera, do vypnutí): informativní zprávy a varování jí pak nechodí, kritické (pád, SOS) vždy. Žádost o plný obraz a nouzový přístup rodina dostane vždy. Dispečinku se Klid netýká, fronta alertů běží dál.' },
  { id: 'obraz', obrazky: [{ src: '/proto/napoveda/diagnostika.png', popis: 'Lišta nahoře, když obraz z kamery nejde; odkaz na Diagnostiku v hlavní aplikaci' }], nazev: 'Když obraz z kamery nejde', klicova: ['nejde obraz', 'nahradni scena', 'vypadek', 'nedostupn', 'offline', 'tunel', 'mango', 'diagnostik', 'kamera neodpovida', 'spojeni'],
    text: 'Když dlaždice kreslí náhradní scénu místo kamery, podívejte se do Diagnostiky v hlavní aplikaci (odkaz v panelu Simulace → Aplikace): kamera „odpovídá“ a události „odebírám“ znamená, že je vše v pořádku. Jinak je problém v tunelu (brána Mango u klienta bez internetu, nebo výpadek proudu) nebo v účtu kamery. Postup je v README projektu (kapitoly 2c a Diagnostika). Nahoře na stránce se mezitím ukazuje lišta s důvodem.' },
];

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Odpověď z nápovědy: nejlépe odpovídající téma, nebo nabídka témat. */
export function odpovez(dotaz) {
  const q = norm(dotaz).trim();
  if (!q) return { text: 'Napište, s čím potřebujete poradit, třeba „jak požádat o plný obraz“.', tema: null };
  if (/^(ahoj|dobry den|dobry vecer|zdravim|cau|hello)\b/.test(q)) return { text: 'Dobrý den. Zeptejte se na cokoli k dispečinku: režimy obrazu, žádost o plný obraz, nouzový přístup, alerty, účty rodiny, sledování, přihlášení.', tema: null };
  if (/^(dekuj|diky|dik)\b/.test(q)) return { text: 'Rádo se stalo.', tema: null };
  let best = null, bestSkore = 0;
  for (const t of TEMATA) {
    let skore = 0;
    for (const k of t.klicova) if (q.includes(norm(k))) skore += k.length > 5 ? 2 : 1;
    if (q.includes(norm(t.nazev))) skore += 3;
    if (skore > bestSkore) { best = t; bestSkore = skore; }
  }
  if (best) return { text: best.text, tema: best.id, nazev: best.nazev };
  return { text: 'Tohle v nápovědě nemám. Témata: ' + TEMATA.map((t) => t.nazev).join(', ') + '. Zkuste otázku jinak, nebo otevřete téma v Nápovědě vedle.', tema: null };
}

/** Celá nápověda jako text (podklad pro AI přes webhook). */
export function napovedaText() { return TEMATA.map((t) => `## ${t.nazev}\n${t.text}`).join('\n\n'); }
