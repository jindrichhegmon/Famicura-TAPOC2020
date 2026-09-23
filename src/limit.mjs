/**
 * Omezení pokusů o přihlášení. Server je na internetu přímo, takže heslo
 * nesmí jít zkoušet donekonečna: po MAX chybách z jedné adresy se na OKNO
 * minut přihlásit nedá.
 *
 * Kdo zkouší z mnoha adres najednou, narazí na celkový strop MAX_CELKEM
 * chyb ze všech adres dohromady.
 */
const MAX = 10;
const MAX_CELKEM = 50;
const OKNO_MS = 15 * 60 * 1000;

export function createLimiter({ max = MAX, maxCelkem = MAX_CELKEM, oknoMs = OKNO_MS, now = () => Date.now() } = {}) {
  const chyby = new Map();   // ip -> [časy chyb]
  const VSE = '*';           // všechny adresy dohromady

  const cerstve = (ip) => {
    const t = now();
    const list = (chyby.get(ip) || []).filter((x) => t - x < oknoMs);
    if (list.length) chyby.set(ip, list); else chyby.delete(ip);
    return list;
  };

  return {
    /** Kolik sekund ještě čekat, nebo 0. */
    blokovano(ip) {
      const list = cerstve(ip);
      if (list.length >= max) return Math.ceil((list[0] + oknoMs - now()) / 1000);
      const vse = cerstve(VSE);
      return vse.length >= maxCelkem ? Math.ceil((vse[0] + oknoMs - now()) / 1000) : 0;
    },
    chyba(ip) {
      chyby.set(ip, [...cerstve(ip), now()]);
      chyby.set(VSE, [...cerstve(VSE), now()]);
    },
    uspech(ip) { chyby.delete(ip); },
  };
}
