// pm2 startOrRestart deploy/ecosystem.config.cjs   (na VPS jako uživatel jhnapps)
//
// Dvě aplikace: server (stránka + API) a go2rtc (kamera → WebRTC). Obě bez
// roota; go2rtc potřebuje jen port 8555, který je nad 1024.
const ROOT = require('path').resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'famicura-tapo',
      script: 'server.mjs',
      cwd: ROOT,
      // Port určuje nasazení, ne .env: server.mjs dává přednost prostředí před
      // .env, takže zapomenutý PORT v pm2 by .env přebil a proces by padal na
      // EADDRINUSE cizího portu. Tady je vidět, s čím se doopravdy startuje.
      env: { NODE_ENV: 'production', TZ: 'Europe/Prague', PORT: process.env.PORT || '3112' },
      max_memory_restart: '300M',
      autorestart: true,
    },
    {
      name: 'famicura-go2rtc',
      script: ROOT + '/bin/go2rtc',
      args: ['-config', ROOT + '/go2rtc.yaml'],
      interpreter: 'none',
      cwd: ROOT,
      max_memory_restart: '300M',
      autorestart: true,
      // Missing config or a bad camera line: back off instead of spinning.
      exp_backoff_restart_delay: 2000,
    },
  ],
};
