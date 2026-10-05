/** Falešný detektor postavy pro testy a vývoj bez modelu (KOSTRA_DETEKTOR=fake): panáček, který jde zleva doprava a na konci si lehne. */
export function fakeDetektor() {
  let i = 0;
  return {
    nazev: 'fake17',
    async body() {
      const f = i++;
      const x = 0.2 + (f % 40) / 40 * 0.6, lezi = f % 40 > 30, y0 = lezi ? 0.65 : 0.25, dy = lezi ? 0 : 0.1, dx = lezi ? 0.1 : 0;
      const b = (ox, oy) => [Math.round((x + ox) * 1000) / 1000, Math.round((y0 + oy) * 1000) / 1000, 0.9];
      // 0 nos, 1–2 oči, 3–4 uši, 5–6 ramena, 7–8 lokty, 9–10 zápěstí, 11–12 boky, 13–14 kolena, 15–16 kotníky
      return [b(0, 0), b(-0.01, -0.01), b(0.01, -0.01), b(-0.02, 0), b(0.02, 0), b(-0.06, dy), b(0.06, dy), b(-0.1 - dx, dy * 2), b(0.1 + dx, dy * 2), b(-0.12 - dx * 2, dy * 3), b(0.12 + dx * 2, dy * 3),
        b(-0.04 + dx * 2, dy * 3 + 0.02), b(0.04 + dx * 2, dy * 3 + 0.02), b(-0.05 + dx * 3, dy * 4.5 + 0.02), b(0.05 + dx * 3, dy * 4.5 + 0.02), b(-0.05 + dx * 4, dy * 6 + 0.02), b(0.05 + dx * 4, dy * 6 + 0.02)];
    },
  };
}
