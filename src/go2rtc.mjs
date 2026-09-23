/**
 * go2rtc na VPS: převádí RTSP z kamery na WebRTC.
 *
 * Jeho API nemá heslo, a proto poslouchá jen na 127.0.0.1 a mluví s ním jen
 * tento server – až po přihlášení. Ověřeno proti go2rtc 1.9.14:
 *   GET  /api                            → { version, config_path, … }
 *   GET  /api/streams                    → { název: { producers, consumers } }
 *   POST /api/webrtc?src=název           → tělo SDP offer (application/sdp), 201 + SDP answer
 *   GET  /api/stream.mp4?src=název       → 200 jakmile kamera posílá, 500 když neodpovídá
 */
export class Go2rtcError extends Error {
  /** retry: false when trying again cannot help (the browser lacks the codec). */
  constructor(message, status, detail, { retry = true } = {}) {
    super(message); this.status = status; this.detail = detail; this.retry = retry;
  }
}

export function createGo2rtc({ url = process.env.GO2RTC_URL || 'http://127.0.0.1:1984', fetchImpl = fetch } = {}) {
  const api = (path) => url.replace(/\/+$/, '') + path;

  async function call(path, init, timeoutMs = 10000) {
    try {
      return await fetchImpl(api(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Go2rtcError('Převodník go2rtc na serveru neodpovídá.', 502, e.message);
    }
  }

  return {
    /** Názvy streamů = ID kamer v aplikaci. */
    async streams() {
      const res = await call('/api/streams');
      if (!res.ok) throw new Go2rtcError(`go2rtc vrátil ${res.status}.`, 502);
      return Object.keys(await res.json() || {});
    },

    async version() {
      // /api, not /api/ (that one is 404). The reply also names the config
      // path, so only the version number goes any further.
      const res = await call('/api', {}, 3000);
      if (!res.ok) return null;
      try { return (await res.json()).version || null; } catch { return null; }
    },

    /** SDP offer z prohlížeče → SDP answer od go2rtc. */
    async webrtc(src, sdpOffer) {
      const res = await call(`/api/webrtc?src=${encodeURIComponent(src)}`, {
        method: 'POST', headers: { 'content-type': 'application/sdp' }, body: sdpOffer,
      }, 20000);
      const body = await res.text();
      if (res.ok) return body;
      // Bez společného kodeku go2rtc hlásí "RTPSender created with no codecs":
      // prohlížeč neumí H.264, které kamera posílá (třeba Chromium bez kodeků).
      if (/no codecs|codec/i.test(body)) {
        throw new Go2rtcError('Tento prohlížeč neumí obraz H.264 z kamery. Použijte Chrome, Edge nebo Safari.', 502, body.slice(0, 300), { retry: false });
      }
      throw new Go2rtcError('Kamera neodpovídá – zkontrolujte tunel WireGuard a kameru.', 502, body.slice(0, 300));
    },

    /** Posílá kamera obraz? Stačí hlavička odpovědi; spojení se hned zavře. */
    async probe(src, timeoutMs = 8000) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(api(`/api/stream.mp4?src=${encodeURIComponent(src)}`), { signal: ctrl.signal });
        const ok = res.status === 200;
        const detail = ok ? null : (await res.text().catch(() => '')).slice(0, 200);
        return { ok, status: res.status, detail };
      } catch (e) {
        return { ok: false, status: 0, detail: ctrl.signal.aborted ? 'bez odpovědi' : e.message };
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }
    },
  };
}
