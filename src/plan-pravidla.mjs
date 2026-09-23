/*
 * Plány nahrávání: kontrola toho, co posílá editor, před uložením.
 *
 * Interval je denní rozsah. Začátek větší než konec znamená přes půlnoc,
 * což noční hlídání potřebuje, takže je to platný tvar, ne chyba.
 */

export const MAX_INTERVALS = 5;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(hhmm) {
  if (!HHMM.test(String(hhmm || ""))) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/**
 * Accepts what the form sends and returns what is safe to store. Blank rows
 * are dropped rather than refused, because the editor always shows five.
 */
export function normalizeIntervals(raw) {
  if (raw === undefined || raw === null) return { ok: true, intervals: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Rozvrh musí být seznam intervalů." };
  if (raw.length > MAX_INTERVALS) {
    return { ok: false, error: `Nejvýše ${MAX_INTERVALS} intervalů na kameru.` };
  }

  const intervals = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] || {};
    const from = String(row.from ?? "").trim();
    const to = String(row.to ?? "").trim();

    if (!from && !to) continue;                       // an untouched row
    if (!from || !to) {
      return { ok: false, error: `Interval ${i + 1}: vyplňte začátek i konec.` };
    }
    if (toMinutes(from) === null || toMinutes(to) === null) {
      return { ok: false, error: `Interval ${i + 1}: čas musí být ve tvaru HH:MM.` };
    }
    if (from === to) {
      return { ok: false, error: `Interval ${i + 1}: začátek a konec se nesmí rovnat.` };
    }

    intervals.push({ from, to, enabled: row.enabled !== false });
  }
  return { ok: true, intervals };
}

export function isDeviceId(value) {
  const v = String(value ?? "");
  return v.length > 0 && v.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(v);
}
