// Servisní skript aplikace rodiny. Nic neukládá do keše: obraz i události
// jsou živé a stará kopie stránky by jen mátla. Je tu proto, aby šla
// aplikace nainstalovat na plochu telefonu, a aby bez připojení řekla
// „jste offline“ místo chybové stránky prohlížeče.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;   // vše ostatní jde přímo na síť
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Famicura – offline</title>'
    + '<body style="font-family:-apple-system,system-ui,sans-serif;background:#F5F7F9;color:#17212B;padding:32px 20px;text-align:center">'
    + '<div style="font-size:2.4rem">📡</div><h1 style="font-size:1.2rem;margin:10px 0">Jste bez připojení</h1>'
    + '<p style="color:#5A6B7D">Famicura potřebuje internet. Jakmile bude, klepněte na Zkusit znovu.</p>'
    + '<button onclick="location.reload()" style="background:#106FD5;color:#fff;border:0;border-radius:12px;padding:12px 18px;font-size:1rem;font-weight:600">Zkusit znovu</button>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
