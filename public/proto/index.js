// Says up front whether the real camera will show, so nobody hunts for a missing picture.
const el = document.getElementById('stav');
try {
  const r = await fetch('/api/status');
  const s = await r.json();
  if (!s.authenticated) { el.innerHTML = 'Nejste přihlášeni v hlavní aplikaci: prototyp pokreslí náhradní scénu. <a href="/" target="_blank">Přihlásit se</a> a obnovit tuto stránku.'; el.classList.add('warn'); }
  else {
    const cam = (s.cameras || [])[0];
    if (cam?.online) { el.textContent = `Obraz z kamery ${cam.name} je k dispozici. Otevřete některou roli.`; el.classList.add('ok'); }
    else { el.textContent = `Kamera ${cam?.name || ''} teď neposílá obraz; prototyp pokreslí náhradní scénu.`; el.classList.add('warn'); }
  }
} catch { el.textContent = 'Stav kamery se nepodařilo zjistit; prototyp pokreslí náhradní scénu.'; }
