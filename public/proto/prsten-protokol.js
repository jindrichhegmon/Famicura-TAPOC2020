/* Protokol chytrého prstenu Yawell / Colmi (aplikace QRing: R02, R03, R06, R09, R10…).
 *
 * Prsten má Bluetooth LE službu podobnou Nordic UART: do RX se zapisují
 * 16bajtové pakety, z TX chodí odpovědi jako notifikace. Paket je
 * [příkaz, data… (14 B), kontrolní součet], součet = součet prvních 15 bajtů & 0xFF.
 * Popis podle otevřených projektů Gadgetbridge a colmi_r02_client.
 *
 * Čisté funkce bez prohlížeče – testuje je test/prsten.test.mjs. */

export const SLUZBA = '6e40fff0-b5a3-f393-e0a9-e50e24dcca9e';
export const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // zápis do prstenu
export const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // notifikace z prstenu

export const CMD = {
  CAS: 0x01,              // nastavení času
  BATERIE: 0x03,          // [3, %, nabíjí]
  HISTORIE_TEPU: 0x15,    // log tepu za den
  NASTAVENI_TEPU: 0x16,   // automatické měření tepu: [2 = zápis, 1 zapnuto / 2 vypnuto, interval min]
  POKRACUJ: 0x1e,         // „pokračuj“ při měření tepu v reálném čase
  MERENI_START: 0x69,     // [typ, 1]; odpověď [0x69, typ, chyba, hodnota]
  MERENI_STOP: 0x6a,      // [typ, 0, 0]
};
export const TYP = { TEP: 1, SPO2: 3 };

export function paket(cmd, data = []) {
  const b = new Uint8Array(16);
  b[0] = cmd & 0xff;
  for (let i = 0; i < Math.min(14, data.length); i++) b[i + 1] = data[i] & 0xff;
  let s = 0; for (let i = 0; i < 15; i++) s += b[i];
  b[15] = s & 0xff;
  return b;
}
export const platny = (b) => b && b.length === 16 && ((Array.from(b.slice(0, 15)).reduce((a, x) => a + x, 0) & 0xff) === b[15]);

const bcd = (n) => (Math.floor(n / 10) << 4) | (n % 10);
/** Čas prstenu v UTC (stejně jako colmi_r02_client): historie pak chodí s časem v UTC. */
export function paketCas(d = new Date()) {
  return paket(CMD.CAS, [bcd(d.getUTCFullYear() % 100), bcd(d.getUTCMonth() + 1), bcd(d.getUTCDate()), bcd(d.getUTCHours()), bcd(d.getUTCMinutes()), bcd(d.getUTCSeconds()), 1]);
}
export const paketBaterie = () => paket(CMD.BATERIE);
export const paketNastaveniTepu = (intervalMin = 5) => paket(CMD.NASTAVENI_TEPU, [2, 1, Math.max(1, Math.min(60, intervalMin))]);
/** Historie tepu za den: půlnoc dne v UTC jako unixový čas (sekundy, little-endian). */
export function paketHistorieTepu(pulnocUtcMs) {
  const t = Math.floor(pulnocUtcMs / 1000);
  return paket(CMD.HISTORIE_TEPU, [t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff]);
}
export const paketStart = (typ) => paket(CMD.MERENI_START, [typ, 1]);
export const paketStop = (typ) => paket(CMD.MERENI_STOP, [typ, 0, 0]);
export const paketPokracuj = () => paket(CMD.POKRACUJ, [0x33]);

export const pulnocUtc = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/** Skládá odpovědi na HISTORIE_TEPU. vloz(paket) vrací null (čeká na další), nebo výsledek
 *  { hotovo: true, zaznamy: [{ cas (ms), tep }] } – prázdné, když prsten za ten den nic nemá. */
export function skladacHistorieTepu() {
  let pocet = 0, rozsah = 5, cas0 = null; const hodnoty = [];
  return function vloz(b) {
    if (b[0] !== CMD.HISTORIE_TEPU) return null;
    const sub = b[1];
    if (sub === 0xff) return { hotovo: true, zaznamy: [] };
    if (sub === 0) { pocet = b[2]; rozsah = b[3] || 5; return null; }
    if (sub === 1) { cas0 = (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)) >>> 0; hodnoty.push(...b.slice(6, 15)); }
    else hodnoty.push(...b.slice(2, 15));
    if (pocet && sub >= pocet - 1) {
      const zaznamy = [];
      if (cas0 !== null) hodnoty.slice(0, Math.floor(1440 / rozsah)).forEach((tep, i) => { if (tep > 0) zaznamy.push({ cas: (cas0 + i * rozsah * 60) * 1000, tep }); });
      return { hotovo: true, zaznamy };
    }
    return null;
  };
}

/** Odpověď na měření v reálném čase: { typ, chyba, hodnota } nebo null. */
export function mereni(b) {
  if (b[0] !== CMD.MERENI_START) return null;
  return { typ: b[1], chyba: b[2], hodnota: b[3] };
}
export const baterie = (b) => (b[0] === CMD.BATERIE ? { procenta: b[1], nabiji: !!b[2] } : null);
