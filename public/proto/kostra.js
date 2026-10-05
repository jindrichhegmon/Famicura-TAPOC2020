/* Přehrávač nahrávky jako drátěného modelu: JSON { w, h, fps, spoje, snimky: [{ t, b: [[x, y, s]…] }] }
 * (src/kostra.mjs) kreslí na plátno jako animaci. Klepnutím pauza / pokračování. */
export function prehrajKostru(container, data) {
  const canvas = document.createElement('canvas'); canvas.className = 'prehravac kostra'; canvas.width = 640; canvas.height = Math.round(640 * (data.h || 180) / (data.w || 320));
  const bar = document.createElement('div'); bar.className = 'kostra-lista small muted';
  container.append(canvas, bar);
  const ctx = canvas.getContext('2d'); const spoje = data.spoje || [];
  const snimky = (data.snimky || []).filter((s) => s && s.t != null);
  const delka = snimky.length ? snimky[snimky.length - 1].t + 1000 / (data.fps || 5) : 0;
  let start = performance.now(), pauza = false, pauzaOd = 0, raf = null;
  const kresli = (t) => {
    ctx.fillStyle = '#17212b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += canvas.width / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    let s = null; for (const x of snimky) { if (x.t <= t) s = x; else break; }
    if (s && s.b) {
      ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = Math.max(3, canvas.width / 230); ctx.lineCap = 'round';
      for (const [a, b] of spoje) { const p = s.b[a], q = s.b[b]; if (!p || !q || p[2] < 0.3 || q[2] < 0.3) continue; ctx.beginPath(); ctx.moveTo(p[0] * canvas.width, p[1] * canvas.height); ctx.lineTo(q[0] * canvas.width, q[1] * canvas.height); ctx.stroke(); }
      for (const p of s.b) { if (!p || p[2] < 0.3) continue; ctx.beginPath(); ctx.arc(p[0] * canvas.width, p[1] * canvas.height, Math.max(3, canvas.width / 185), 0, Math.PI * 2); ctx.fill(); }
    } else { ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = `${Math.round(canvas.width / 32)}px sans-serif`; ctx.fillText('postava nerozpoznána', 16, 32); }
    bar.textContent = `drátěný model · ${(t / 1000).toFixed(1)} s z ${(delka / 1000).toFixed(0)} s${pauza ? ' · pauza (klepněte)' : ''}`;
  };
  const krok = () => {
    if (pauza) return;
    const t = performance.now() - start;
    if (t >= delka) { kresli(delka - 1); start = performance.now() + 1500; raf = requestAnimationFrame(krok); return; }   // po konci chvíli stát a jet znovu
    kresli(Math.max(0, t)); raf = requestAnimationFrame(krok);
  };
  canvas.onclick = () => { pauza = !pauza; if (pauza) pauzaOd = performance.now(); else { start += performance.now() - pauzaOd; krok(); } };
  krok();
  return { stop() { pauza = true; cancelAnimationFrame(raf); canvas.remove(); bar.remove(); }, canvas };
}
