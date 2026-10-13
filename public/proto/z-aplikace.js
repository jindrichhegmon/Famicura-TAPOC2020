/* Aplikace rodiny otevřená z aplikace klienta PéčeDoma mobil (od 3.63): PéčeDoma je jediná aplikace pro klienty a rodinu,
 * kamera a náramek se v ní otevírají jako tahle stránka – na iPhonu ve stejném okně aplikace (Capacitor allowNavigation),
 * na webu ve stejné záložce. PéčeDoma přidá do odkazu ?zpet=<adresa PéčeDoma>; tady se uloží (přežije přihlášení,
 * obnovu stránky i další otevření) a v hlavičce je tlačítko „‹ PéčeDoma“. Karta „Aplikace na telefonu“ (uložit Famicuru
 * na plochu) se v PéčeDoma schová – druhá ikona na ploše by tam nedávala smysl.
 * Zpět se smí jen do PéčeDoma (pevný seznam adres), jinak by odkaz šel zneužít k přesměrování na cizí stránku. */
(() => {
  const KLIC = 'famicura.zpet';
  // pecedoma:// = nativní aplikace PéčeDoma (z aplikace Famicura Kamera, kde je rodina samostatnou aplikací)
  const POVOLENE = [/^capacitor:\/\/localhost(\/|$)/, /^https:\/\/(pecedomamobil|pecedomapacient)\.netlify\.app(\/|$)/, /^http:\/\/(127\.0\.0\.1|localhost):8792(\/|$)/, /^pecedoma:\/\/$/];
  const povolena = (u) => typeof u === 'string' && u.length < 500 && POVOLENE.some((r) => r.test(u));
  let zpet = null;
  try {
    const q = new URLSearchParams(location.search);
    const z = q.get('zpet');
    if (z === 'ne') localStorage.removeItem(KLIC);
    else if (povolena(z)) localStorage.setItem(KLIC, z);
    zpet = localStorage.getItem(KLIC);
    if (!povolena(zpet)) zpet = null;
  } catch { /* bez úložiště: bez tlačítka */ }
  if (!zpet) return;
  document.documentElement.classList.add('vpecedoma');
  const styl = document.createElement('style');
  styl.textContent = '.vpecedoma #install{display:none!important}'
    + '.zpetPecedoma{flex:0 0 auto;border:0;border-radius:999px;padding:7px 12px;margin-right:8px;font:inherit;font-weight:700;font-size:14px;'
    + 'background:rgba(255,255,255,.18);color:inherit;cursor:pointer;white-space:nowrap}'
    + '.gatecard .zpetPecedoma{display:block;margin:0 auto 12px;background:#eef3f8;color:#0d4a75}'
    + '.gatecard .zPecedomaInfo{margin:0 0 10px;font-size:14px;color:#55687a;text-align:center}';
  document.head.append(styl);
  const tlacitko = () => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'zpetPecedoma'; b.textContent = '‹ PéčeDoma';
    b.title = 'Zpět do aplikace PéčeDoma';
    b.addEventListener('click', () => { location.href = zpet; });
    return b;
  };
  const vloz = () => {
    const h = document.querySelector('.apphead');
    if (h && !h.querySelector('.zpetPecedoma')) h.prepend(tlacitko());
    // brána přihlášení (rodina ještě nepřihlášená): tlačítko zpět i vysvětlení, proč se tu přihlašuje
    const g = document.querySelector('.gatecard');
    if (g && !g.querySelector('.zpetPecedoma')) {
      const info = document.createElement('p'); info.className = 'zPecedomaInfo';
      info.textContent = 'Kamera a náramek v aplikaci PéčeDoma: přihlaste se telefonem a heslem rodiny. Přihlášení vydrží 30 dní.';
      g.prepend(info); g.prepend(tlacitko());
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vloz); else vloz();
})();
