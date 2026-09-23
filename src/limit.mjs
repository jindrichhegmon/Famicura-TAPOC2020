/**
 * Omezení pokusů o přihlášení. Server je na internetu přímo, takže heslo
 * nesmí jít zkoušet donekonečna: po MAX chybách z jedné adresy se na OKNO
 * minut přihlásit nedá.
 */
const MAX = 10;
const OKNO_MS = 15 * 60 * 1000;

export function createLimiter({ max = MAX, oknoMs = OKNO_MS, now = () => Date.now() } = {}) {
  const chyby = new Map();   // ip -> [časy chyb]

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
      return list.length >= max ? Math.ceil((list[0] + oknoMs - now()) / 1000) : 0;
    },
    chyba(ip) { chyby.set(ip, [...cerstve(ip), now()]); },
    uspech(ip) { chyby.delete(ip); },
  };
}
