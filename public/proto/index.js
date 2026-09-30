// Says up front whether the real camera will show, so nobody hunts for a missing picture.
const el = document.getElementById('stav');
try {
  const r = await fetch('/api/status');
  const s = await r.json();
  if (!s.authenticated) {
    el.innerHTML = '<b>Demo s reálnou kamerou: přihlaste se.</b> Bez přihlášení v hlavní aplikaci prototyp kreslí jen náhradní scénu. <a href="/" target="_blank">Přihlásit se</a>, pak tuto stránku obnovte.'; el.classList.add('warn');
    const bar = document.createElement('div'); bar.id = 'authBar';
    bar.innerHTML = '<span class="grow"><b>Demo s reálnou kamerou:</b> přihlaste se v hlavní aplikaci (stejný prohlížeč), jinak všechna prostředí ukazují jen náhradní scénu.</span><a class="sm btnlike" href="/" target="_blank">Přihlásit se</a><button class="sm sec" onclick="location.reload()">Mám přihlášeno, načíst znovu</button>';
    document.body.prepend(bar); document.body.classList.add('withAuth');
  }
  else {
    const cam = (s.cameras || [])[0];
    if (cam?.online) { el.textContent = `Obraz z kamery ${cam.name} je k dispozici. Otevřete některou roli.`; el.classList.add('ok'); }
    else { el.textContent = `Kamera ${cam?.name || ''} teď neposílá obraz; prototyp pokreslí náhradní scénu.`; el.classList.add('warn'); }
  }
} catch { el.textContent = 'Stav kamery se nepodařilo zjistit; prototyp pokreslí náhradní scénu.'; }
