/*
 * One open camera: its own WHEP connection, watchdog, picture, recording and
 * analysis, all bound to its own card. The page can hold several at once.
 *
 * Everything shared - the analysis log, the recordings list, CLB1, the folder
 * and the scheduler - stays in index.html and is reached through callbacks.
 */
import { LiveAnalyzer, fmtTime, fmtClock, drawBackground, drawSkeleton } from '/analyzer.js';
import { WatchFilter, defaultWatch, describeWatch } from '/watch.js';

const ICE = [{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];

/*
 * A live session does not last forever - the camera, the tunnel or go2rtc can
 * drop it - and a phone that changes network or goes to the background loses
 * the peer connection. Both fail quietly: the
 * picture holds its last frame while connectionState still reads "connected",
 * so nothing but the frames themselves proves the stream is alive.
 */
const STALL_MS = 7000;        // no new frame for this long counts as frozen
const WATCHDOG_MS = 2000;
const MAX_RECONNECTS = 8;

/*
 * A screen saver, a locked screen or a sleeping computer stops the browser
 * drawing, and with it analysis and recording. A gap this long between two
 * drawn frames is written to the log and CLB1, so nobody takes silence for
 * "nothing happened". Shorter ones - a glance at another tab - are not news.
 */
const GAP_MS = 10000;

// Frames in a row that the pose model may fail on before analysis gives up.
const DETECT_FAILURES_MAX = 20;

// Whether to draw the pose skeleton is a viewer's preference; remember it in
// this browser, and survive a storage that refuses to answer.
const SKELETON_KEY = 'famicura.kostra';
function loadSkeletonPref() {
  try { return localStorage.getItem(SKELETON_KEY) === '1'; } catch { return false; }
}
function saveSkeletonPref(on) {
  try { localStorage.setItem(SKELETON_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

function fmtGap(ms) {
  const min = Math.round(ms / 60000);
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  return min < 90 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// Icon-only control, so the state has to reach assistive tech through the label.
const SPEAKER_BODY = '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/>';
const SPEAKER_ON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true">${SPEAKER_BODY}
  <path d="M16.5 8.8a4.5 4.5 0 010 6.4"/><path d="M19.2 6a8 8 0 010 12"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true">${SPEAKER_BODY}
  <path d="M16.5 9.5l5 5"/><path d="M21.5 9.5l-5 5"/></svg>`;

// go2rtc answers a single SDP offer (WHEP style), so gather ICE candidates
// before sending rather than trickling them afterwards.
function waitForIce(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (peer.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, 3000);
    peer.addEventListener('icegatheringstatechange', check);
  });
}

/*
 * The WASM runtime is loaded once for the page. Each camera still gets its
 * own landmarker: in VIDEO mode a landmarker tracks one stream from frame to
 * frame, and feeding it two cameras in turn would blend them into one person.
 */
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest';
let visionPromise = null;

async function createLandmarker() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const mod = await import(MP);
      return { mod, vision: await mod.FilesetResolver.forVisionTasks(MP + '/wasm') };
    })();
    visionPromise.catch(() => { visionPromise = null; });   // let a later attempt retry
  }
  const { mod, vision } = await visionPromise;
  try {
    const landmarker = await mod.PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55
    });
    return { landmarker, connections: mod.PoseLandmarker.POSE_CONNECTIONS };
  } catch (e) {
    // MediaPipe reads every frame through WebGL, whatever runs the model. A
    // page without it (remote desktop, some virtual machines, acceleration
    // turned off) cannot analyse at all - say that, not a graph error.
    if (/webgl|kGpuService|activeTexture/i.test(String(e?.message || e))) {
      throw new Error('analýza potřebuje grafiku v prohlížeči (WebGL). Zapněte v nastavení prohlížeče hardwarovou akceleraci, nebo použijte jiný počítač');
    }
    throw e;
  }
}

function pickMime() {
  const choices = [
    ['video/mp4;codecs=avc1.42E01E', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']
  ];
  for (const [mime, ext] of choices) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: '', ext: 'webm' };
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

export class CameraView {
  /**
   * @param device    { id, name }
   * @param template  <template> holding one camera card
   * @param hooks     api(path, opts), onLog(ev), onRecording(rec), onChange(),
   *                  onSound(view) when this one is unmuted, onClose(view)
   */
  constructor(device, template, hooks) {
    this.device = { id: device.id, name: device.name, events: device.events || [] };   // events: what the camera reports itself
    this.hooks = hooks;

    this.pc = null;
    this.sessionUrl = null;
    this.wantStream = false;          // the stream stays wanted until Ukončit
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.watchdogId = null;
    this.watchTime = -1;
    this.stalledFor = 0;

    this.displayMode = 'normal';
    this.rafId = null;
    this.lastFrameTime = -1;

    this.recorder = null;
    this.recording = false;
    this.autoWindow = null;           // the schedule interval this recording belongs to
    this.chunks = [];
    this.recStartedAt = 0;
    this.timerId = null;

    this.lastDrawnAt = null;          // when the canvas last got a new frame
    this.pausedAt = null;             // when the page was hidden, if it was
    this.pauseTimer = null;

    this.analyzing = false;
    this.skeleton = loadSkeletonPref();   // draw the pose over the picture
    this.detectFailures = 0;
    this.detectOff = false;               // set when the pose model keeps failing
    this.landmarker = null;
    this.connections = [];
    this.analysisStartedAt = 0;
    this.analyzer = new LiveAnalyzer((ev) => this.log(ev));
    this.filter = new WatchFilter(defaultWatch());   // what this camera reports; see setWatch

    this.card = template.content.firstElementChild.cloneNode(true);
    const q = (sel) => this.card.querySelector(sel);
    this.el = {
      name: q('.name'), video: q('video'), canvas: q('canvas.draw'), small: q('canvas.small'),
      modes: q('.modes'), record: q('.record'), analyze: q('.analyze'), sound: q('.sound'),
      retry: q('.retry'), recBar: q('.recBar'), timer: q('.timer'), stop: q('.stop'), msg: q('.msg'),
      watchInfo: q('.watchInfo'), skeleton: q('input.skeleton'),
    };
    this.cctx = this.el.canvas.getContext('2d');
    this.sctx = this.el.small.getContext('2d');
    this.card.dataset.id = this.device.id;
    this.el.name.textContent = '– ' + this.device.name;
    this.setSoundIcon(true);
    this.setWatch(defaultWatch());
    this.bind();
    this.renderSkeleton();
    if (this.showSkeleton()) this.ensureLandmarker('Načítám model pro drátěný model…').then((ok) => {
      if (!ok) { this.skeleton = false; this.renderSkeleton(); this.updateRender(); }
    });
  }

  /** Which events this camera reports; takes effect at once, even mid-analysis. */
  setWatch(watch) {
    this.filter.set(watch);
    this.analyzer.configure(this.filter.detectorOptions());
    this.el.watchInfo.textContent = 'Sleduje: ' + describeWatch(this.filter.watch, this.device.events || []);
  }

  bind() {
    const e = this.el;
    e.modes.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        this.displayMode = b.dataset.mode;
        e.modes.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        this.renderSkeleton();
        // The privacy modes apply at once; the model for the skeleton follows.
        this.updateRender();
        if (this.displayMode === 'black') this.ensureLandmarker('Načítám model pro drátěný model…');
      };
    });
    e.skeleton.onchange = () => this.setSkeleton(e.skeleton.checked);
    e.record.onclick = () => (this.recording ? this.stopRecording() : this.startRecording());
    e.analyze.onclick = () => (this.analyzing ? this.stopAnalysis() : this.startAnalysis());
    e.sound.onclick = () => this.setMuted(!e.video.muted);
    e.retry.onclick = () => this.retry();
    e.stop.onclick = (ev) => {
      if (ev && ev.isTrusted === false) return;   // never end a stream from script
      this.close();
    };
  }

  /* ---------- state the page asks about ---------- */

  get connected() { return !!this.pc && this.wantStream; }

  /** Frames are flowing, so a recording would not come out black. */
  hasPicture() {
    const v = this.el.video;
    return !!v.srcObject && v.readyState >= 2;
  }

  setMsg(text, bad) {
    this.el.msg.innerHTML = bad ? `<span class="bad">${esc(text)}</span>` : esc(text);
  }

  log(ev) {
    const at = ev.at || new Date();
    if (!this.filter.accept(ev, at)) return;       // not watched here: neither the log nor CLB1
    this.hooks.onLog({ ...ev, at, device: this.device });
  }

  /* ---------- connection ---------- */

  async start({ isReconnect = false, scroll = false } = {}) {
    if (!isReconnect) {
      this.reconnectAttempt = 0;
      this.el.retry.classList.add('hide');
    }
    await this.teardown({ keepIntent: true });
    this.wantStream = true;

    this.setMsg(isReconnect ? 'Obnovuji spojení…' : 'Navazuji spojení…');
    if (scroll) this.card.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const pc = new RTCPeerConnection({ iceServers: ICE });
      this.pc = pc;

      pc.addEventListener('track', (e) => {
        if (this.pc !== pc) return;           // a stale connection must not hijack the player
        const v = this.el.video;
        // An SDP answer without msid gives no stream on the event, so build one
        // from the track rather than assigning undefined and showing nothing.
        v.srcObject = e.streams[0] || new MediaStream([e.track]);
        // iOS Safari will not start playback on its own in every case; muted
        // playback is always allowed, so offer sound as a separate tap.
        v.play().then(() => {
          this.setMsg(this.reconnectAttempt ? 'Spojení obnoveno, přehrávám.' : 'Přehrávám.');
          this.reconnectAttempt = 0;
          this.el.sound.classList.remove('hide');
        }).catch(() => this.setMsg('Klepněte na obraz pro spuštění.'));
      });

      pc.addEventListener('connectionstatechange', () => {
        if (this.pc !== pc) return;
        // "disconnected" often recovers by itself; the watchdog catches it if not.
        if (pc.connectionState === 'failed') this.reconnect('Spojení selhalo');
        else if (pc.connectionState === 'disconnected') this.setMsg('Spojení kolísá…');
      });

      // Receive only: a Tapo camera over RTSP has no way back, and offering one
      // would promise talking to the room.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);

      const { res, body } = await this.hooks.api('/api/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: this.device.id, sdpOffer: pc.localDescription.sdp })
      });

      if (this.pc !== pc) return;             // superseded while the request was in flight
      if (!res.ok) {
        // error is written for people; detail is go2rtc's own wording, for the log.
        const err = new Error(body.error || body.detail || ('HTTP ' + res.status));
        err.final = body.retry === false;       // e.g. the browser cannot play H.264
        throw err;
      }

      this.sessionUrl = body.sessionUrl || null;
      await pc.setRemoteDescription({ type: 'answer', sdp: body.sdpAnswer });

      this.startWatchdog();
      this.updateRender();
      this.hooks.onChange();
    } catch (e) {
      if (e.final) {                           // reconnecting cannot help: say why and stop
        await this.teardown({ keepIntent: false });
        this.setMsg(e.message, true);
        return;
      }
      if (this.wantStream) this.reconnect(`Nepodařilo se připojit (${e.message})`);
      else { this.setMsg(e.message, true); await this.teardown({ keepIntent: false }); }
    }
  }

  retry() {
    this.reconnectAttempt = 0;
    this.el.retry.classList.add('hide');
    this.start();
  }

  /*
   * The picture is alive only while frames keep arriving. currentTime is no
   * proof: on a live stream it runs on with nothing coming in, and the browser
   * shows black while the card still reads "Přehrávám". So the watchdog counts
   * decoded frames from the connection's own statistics.
   */
  async streamStats() {
    const pc = this.pc;
    const out = { frames: null, bytes: 0, lost: 0, packets: 0 };
    if (!pc) return out;
    try {
      for (const s of (await pc.getStats()).values()) {
        if (s.type !== 'inbound-rtp' || (s.kind || s.mediaType) !== 'video') continue;
        out.frames = s.framesDecoded ?? s.framesReceived ?? null;
        out.bytes = s.bytesReceived || 0;
        out.lost = s.packetsLost || 0;
        out.packets = s.packetsReceived || 0;
      }
    } catch { /* stats unavailable: fall back to currentTime below */ }
    if (out.frames === null) out.frames = this.el.video.currentTime;
    return out;
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchTime = -1;
    this.stalledFor = 0;
    const id = setInterval(async () => {
      if (!this.wantStream || !this.pc) return;
      const stats = await this.streamStats();
      if (this.watchdogId !== id) return;      // torn down while the stats were on their way
      if (stats.frames !== this.watchTime) {
        this.watchTime = stats.frames;
        this.stalledFor = 0;
        return;
      }
      this.stalledFor += WATCHDOG_MS;
      if (this.stalledFor >= STALL_MS) this.reconnect('Obraz se zastavil', stats);
    }, WATCHDOG_MS);
    this.watchdogId = id;
  }

  stopWatchdog() {
    if (this.watchdogId !== null) { clearInterval(this.watchdogId); this.watchdogId = null; }
  }

  /** "za spojení přišlo 12,3 MB, 1 480 snímků, ztraceno 0 z 9 800 paketů" – a dead camera reads differently from a bad link. */
  static describeStats(s) {
    if (!s || typeof s.frames !== 'number') return '';
    const cz = (n) => Math.round(n).toLocaleString('cs-CZ');
    return `za spojení přišlo ${(s.bytes / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB, ` +
      `${cz(s.frames)} snímků, ztraceno ${cz(s.lost)} z ${cz(s.packets + s.lost)} paketů`;
  }

  reconnect(reason, stats = null) {
    if (!this.wantStream || this.reconnectTimer !== null) return;
    this.stopWatchdog();

    if (this.reconnectAttempt >= MAX_RECONNECTS) { this.giveUp(reason); return; }

    const delay = Math.min(15000, 1000 * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt++;
    this.setMsg(`${reason}. Obnovuji spojení… (pokus ${this.reconnectAttempt})`);
    // A dropout goes to the log and CLB1 whether or not analysis runs: a black
    // picture nobody wrote down would otherwise pass for a quiet room.
    // Only the first attempt of a series: the next ones say nothing new.
    if (this.reconnectAttempt === 1) {
      const detail = CameraView.describeStats(stats);
      this.log({ t: this.analyzing ? (Date.now() - this.analysisStartedAt) / 1000 : 0, kind: 'stream', level: 'warn',
                 text: `${reason}${detail ? ` (${detail})` : ''}` +
                       (this.analyzing ? ' – analýza pokračuje po obnovení spojení.' : ' – obnovuji spojení.') });
    }
    if (this.analyzing) this.analyzer.notePause();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.teardown({ keepIntent: true });
      if (this.wantStream) this.start({ isReconnect: true });
    }, delay);
  }

  giveUp(reason) {
    this.wantStream = false;
    this.setMsg(`${reason}. Spojení se nepodařilo obnovit.`, true);
    this.log({ t: this.analyzing ? (Date.now() - this.analysisStartedAt) / 1000 : 0, kind: 'stream', level: 'warn',
               text: `${reason} – spojení se po ${MAX_RECONNECTS} pokusech nepodařilo obnovit.` });
    this.el.retry.classList.remove('hide');
    if (this.recording) this.stopRecording();
    if (this.analyzing) this.stopAnalysis();
    this.hooks.onChange();
  }

  /**
   * Releases the go2rtc session and the peer connection. keepIntent leaves the
   * wish to watch in place, so a reconnect or a return to the tab can pick it
   * back up.
   */
  async teardown({ keepIntent }) {
    this.stopWatchdog();
    if (!keepIntent) {
      this.wantStream = false;
      if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    const sessionUrl = this.sessionUrl;
    this.sessionUrl = null;
    if (sessionUrl) {
      try {
        await this.hooks.api('/api/stream', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionUrl })
        });
      } catch { /* go2rtc drops the session when the peer closes anyway */ }
    }
    if (this.pc) { this.pc.close(); this.pc = null; }

    const v = this.el.video;
    v.srcObject = null;
    v.muted = true;
    this.updateRender();
    this.setSoundIcon(true);
    this.el.sound.classList.add('hide');
    this.hooks.onChange();
  }

  /** Ukončit: the only thing that ends a stream for good. */
  async close() {
    clearTimeout(this.pauseTimer);
    this.stopAnalysis();
    if (this.recording) this.stopRecording();
    await this.teardown({ keepIntent: false });
    try { this.landmarker?.close?.(); } catch { /* already gone */ }
    this.landmarker = null;
    this.hooks.onClose(this);
  }

  /*
   * Nothing but Ukončit ends the stream. Safari reports the page hidden for
   * things the user does not think of as leaving - a download sheet, a share
   * sheet, a locked screen - so coming back only revives what the browser
   * itself dropped.
   */
  onPageVisible() {
    if (!this.wantStream) return;
    if (!this.pc) { this.reconnectAttempt = 0; this.start({ isReconnect: true }); return; }
    const v = this.el.video;
    if (v.srcObject && v.paused) v.play().catch(() => {});
  }

  /* ---------- sound ---------- */

  setSoundIcon(muted) {
    const label = muted ? 'Zapnout zvuk' : 'Ztlumit';
    this.el.sound.innerHTML = muted ? SPEAKER_OFF : SPEAKER_ON;
    this.el.sound.setAttribute('aria-label', label);
    this.el.sound.title = label;
  }

  setMuted(muted) {
    const v = this.el.video;
    v.muted = muted;
    if (!muted) { v.play().catch(() => {}); this.hooks.onSound(this); }
    this.setSoundIcon(muted);
  }

  /* ---------- picture ---------- */

  // The canvas pipeline costs CPU, so it only runs when the picture is actually
  // being altered, recorded or analysed; otherwise the raw video is cheaper and
  // keeps the native iOS controls.
  needsCanvas() {
    return this.displayMode !== 'normal' || this.analyzing || this.recording || this.showSkeleton();
  }

  /* ---------- drátěný model (pose skeleton over the picture) ---------- */

  /** Drawn when asked for, and always in Černé pozadí, which is the skeleton alone. */
  showSkeleton() {
    return this.skeleton || this.displayMode === 'black';
  }

  renderSkeleton() {
    const box = this.el.skeleton;
    box.checked = this.showSkeleton();
    box.disabled = this.displayMode === 'black';
    box.parentElement.title = box.disabled
      ? 'V režimu Černé pozadí je drátěný model vždy.'
      : 'Kostra postavy přes obraz';
  }

  async setSkeleton(on) {
    if (on && !(await this.ensureLandmarker('Načítám model pro drátěný model…'))) {
      this.skeleton = false;
      this.renderSkeleton();
      return;
    }
    this.skeleton = on;
    this.detectFailures = 0;
    this.detectOff = false;
    saveSkeletonPref(on);
    this.renderSkeleton();
    this.updateRender();
    if (on && !this.analyzing) this.setMsg('Drátěný model zapnutý.');
  }

  /** Loads the pose model once per camera; says why when it cannot. */
  async ensureLandmarker(loadingText) {
    if (this.landmarker) return true;
    if (!this.landmarkerLoading) {
      this.setMsg(loadingText);
      this.landmarkerLoading = createLandmarker().then(({ landmarker, connections }) => {
        this.landmarker = landmarker;
        this.connections = connections;
        return true;
      }, (e) => {
        this.setMsg(`Model se nepodařilo načíst: ${e.message}`, true);
        return false;
      }).finally(() => { this.landmarkerLoading = null; });
    }
    return this.landmarkerLoading;
  }

  updateRender() {
    const on = this.needsCanvas() && !!this.el.video.srcObject;
    // Only the canvas is toggled. The video stays rendered underneath, because a
    // video that is not rendered can stop decoding - and then the picture we draw
    // from, and the watchdog that checks it, both go stale.
    this.el.canvas.classList.toggle('hide', !on);
    if (on && this.rafId === null) this.rafId = requestAnimationFrame(() => this.renderLoop());
    if (!on && this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  fitCanvas() {
    const { video: v, canvas, small } = this.el;
    const w = v.videoWidth || 1280, h = v.videoHeight || 720;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      // ~48px wide before upscaling, so the mosaic removes detail rather than softening it.
      small.width = 48;
      small.height = Math.max(24, Math.round(48 * h / w));
    }
  }

  renderLoop() {
    this.rafId = null;
    const v = this.el.video;
    if (!v.srcObject || !this.needsCanvas()) { this.updateRender(); return; }

    this.fitCanvas();
    if (v.readyState >= 2 && v.currentTime !== this.lastFrameTime) {
      this.lastFrameTime = v.currentTime;
      this.noteFrame(Date.now());
      drawBackground(this.cctx, this.el.canvas, v, this.displayMode, this.el.small, this.sctx);
      if ((this.analyzing || this.showSkeleton()) && !this.detectOff) this.detectPose(v);
    }
    this.rafId = requestAnimationFrame(() => this.renderLoop());
  }

  /* ---------- gaps: screen saver, locked screen, sleep ---------- */

  /** What is being interrupted, in a form the sentence can agree with. */
  running() {
    if (this.analyzing && this.recording) return { who: 'Analýza i nahrávání', stopped: 'přerušeny' };
    if (this.analyzing) return { who: 'Analýza', stopped: 'přerušena' };
    return { who: 'Nahrávání', stopped: 'přerušeno' };
  }

  sinceStart(ms) {
    return this.analyzing ? (ms - this.analysisStartedAt) / 1000 : 0;
  }

  /**
   * The page was hidden. Say so once it has lasted, stamped with when it began;
   * if the computer goes to sleep first, noteFrame still reports the gap.
   */
  onPageHidden() {
    if (!this.analyzing && !this.recording) return;
    this.pausedAt = Date.now();
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      if (this.pausedAt === null || document.visibilityState !== 'hidden') return;
      const { who, stopped } = this.running();
      this.log({ at: new Date(this.pausedAt), t: this.sinceStart(this.pausedAt), kind: 'pause', level: 'warn',
                 text: `${who} ${stopped} – stránka není vidět (spořič obrazovky, zamčení nebo jiná záložka).` });
    }, GAP_MS);
  }

  /** Every drawn frame: if the last one was long ago, the gap goes on record. */
  noteFrame(now) {
    if (this.analyzing || this.recording) {
      const from = this.pausedAt ?? this.lastDrawnAt;
      if (from !== null && now - from >= GAP_MS) {
        const { who } = this.running();
        this.log({ at: new Date(now), t: this.sinceStart(now), kind: 'resume', level: 'warn',
                   text: `${who} znovu běží – přerušení ${fmtGap(now - from)} (${fmtClock(from)}–${fmtClock(now)}).` });
        // Motion is measured frame to frame; across the gap it would be invented.
        if (this.analyzing) this.analyzer.notePause();
      }
    }
    this.lastDrawnAt = now;
    this.pausedAt = null;
    clearTimeout(this.pauseTimer);
  }

  /** Analysis or recording starts from nothing: there is no gap to measure yet. */
  resetGap() {
    if (this.analyzing || this.recording) return;
    this.lastDrawnAt = null;
    this.pausedAt = null;
    clearTimeout(this.pauseTimer);
  }

  /* ---------- recording ---------- */

  /** interval: the schedule interval that started it, or null when started by hand. */
  startRecording(interval = null) {
    const canvas = this.el.canvas;
    if (!canvas.captureStream || !window.MediaRecorder) {
      this.setMsg('Tento prohlížeč neumí nahrávat canvas.', true);
      return;
    }
    this.chunks = [];
    this.resetGap();

    // captureStream only produces frames from a canvas that is visible and being
    // drawn, so switch the pipeline on before grabbing the stream.
    this.recording = true;
    this.autoWindow = interval;
    this.updateRender();
    this.fitCanvas();

    const fmt = pickMime();
    // Decided now: by the time the recorder hands over the file, a scheduled
    // recording has already had its window cleared.
    const zdroj = interval ? 'plan' : 'rucne';

    // If anything here throws, `recording` must not stay true: the button would
    // read as recording for ever and the scheduler would never start again.
    const fail = (e) => {
      this.recorder = null;
      this.recording = false;
      this.autoWindow = null;
      this.updateRender();
      this.setMsg(`Nahrávání se nepodařilo spustit: ${e.message}`, true);
    };

    let recorder;
    try {
      const stream = canvas.captureStream(30);
      recorder = fmt.mime
        ? new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 3500000 })
        : new MediaRecorder(stream);
    } catch (e) { fail(e); return; }

    this.recorder = recorder;
    const chunks = this.chunks;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const from = new Date();

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || fmt.mime || 'video/mp4' });
      this.hooks.onRecording({ blob, device: this.device, from, to: new Date(), ext: fmt.ext, zdroj });
      this.setMsg(`Nahrávka hotova (${(blob.size / 1024 / 1024).toFixed(1)} MB).`);
      if (this.recorder === recorder) { this.recorder = null; this.recording = false; }
      this.updateRender();
      // Only now is recording really over; the page lets the screen sleep again on this.
      this.hooks.onChange();
    };

    this.recStartedAt = Date.now();
    try { recorder.start(1000); } catch (e) { fail(e); return; }

    this.tickTimer();
    this.timerId = setInterval(() => this.tickTimer(), 250);
    this.el.record.textContent = '■ Zastavit nahrávání';
    this.el.recBar.classList.remove('hide');
    this.updateRender();
    this.hooks.onChange();
  }

  tickTimer() {
    this.el.timer.textContent = fmtTime((Date.now() - this.recStartedAt) / 1000);
  }

  stopRecording() {
    this.autoWindow = null;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else { this.recorder = null; this.recording = false; this.updateRender(); }
    clearInterval(this.timerId);
    this.el.record.textContent = '● Nahrávat';
    this.el.recBar.classList.add('hide');
    this.hooks.onChange();
  }

  /* ---------- live analysis ---------- */

  async startAnalysis() {
    const btn = this.el.analyze;
    btn.disabled = true;
    if (!(await this.ensureLandmarker('Načítám model pro analýzu…'))) {
      btn.disabled = false;
      return;
    }
    this.analyzer.reset();
    this.resetGap();
    this.detectFailures = 0;
    this.detectOff = false;
    this.analysisStartedAt = Date.now();
    this.analyzing = true;
    btn.textContent = 'Zastavit analýzu';
    btn.disabled = false;
    this.setMsg('Analýza běží.');
    this.updateRender();
    this.hooks.onChange();
  }

  analysisFailed(e) {
    const why = String(e?.message || e).slice(0, 200);
    this.log({ t: (Date.now() - this.analysisStartedAt) / 1000, kind: 'failed', level: 'warn',
               text: `Analýza se zastavila – snímky z kamery nejde vyhodnotit (${why}).` });
    this.stopAnalysis();
    this.setMsg(`Analýza se zastavila: snímky z kamery nejde vyhodnotit (${why}).`, true);
  }

  stopAnalysis() {
    if (!this.analyzing) return;
    this.analyzing = false;
    this.el.analyze.textContent = 'Spustit analýzu';
    this.setMsg('Analýza zastavena.');
    this.updateRender();
    this.hooks.onChange();
  }

  detectPose(video) {
    if (!this.landmarker) return;
    let result;
    try {
      result = this.landmarker.detectForVideo(video, performance.now());
      this.detectFailures = 0;
    } catch (e) {
      // One bad frame is noise; a run of them means nothing is being analysed.
      // A fall detector must never read as running then, so it stops and says so.
      if (++this.detectFailures >= DETECT_FAILURES_MAX) this.detectionFailed(e);
      return;
    }

    const lm = result.landmarks?.[0] || null;
    if (lm && this.showSkeleton()) drawSkeleton(this.cctx, this.el.canvas, lm, this.connections);
    if (this.analyzing) this.analyzer.push((Date.now() - this.analysisStartedAt) / 1000, lm);
  }

  /** The pose model keeps failing: stop using it rather than pretend. */
  detectionFailed(e) {
    this.detectOff = true;
    if (this.analyzing) { this.analysisFailed(e); return; }
    const why = String(e?.message || e).slice(0, 200);
    this.skeleton = false;
    this.renderSkeleton();
    this.updateRender();
    this.setMsg(`Drátěný model nejde kreslit: snímky z kamery nejde vyhodnotit (${why}).`, true);
  }
}
