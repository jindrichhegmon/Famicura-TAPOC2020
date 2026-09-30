/*
 * Jeden skutečný obraz z kamery, kreslený do libovolného počtu pláten, každé
 * ve svém režimu (bez obrazu, drátěný model, rozostření, plný obraz, kombinace).
 * Obraz se sjednává jednou (WebRTC přes /api/stream), drátěný model se počítá
 * jednou (MediaPipe) a sdílí se. Když kamera není k dispozici (bez přihlášení,
 * kamera offline), kreslí se náhradní scéna s animovanou postavou, aby šlo
 * prostředí předvést i bez ní.
 */
import { drawBackground, drawSkeleton } from '/analyzer.js';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export const MODES = {
  none:     { label: 'Bez obrazu',              short: 'bez obrazu' },
  skeleton: { label: 'Drátěný model',           short: 'drátěný model' },
  blur:     { label: 'Rozostření',              short: 'rozostření' },
  blurskel: { label: 'Rozostření + model',      short: 'rozostření s modelem' },
  full:     { label: 'Plný obraz',              short: 'plný obraz' },
  fullskel: { label: 'Plný obraz + model',      short: 'plný obraz s modelem' },
};
export const MODE_ORDER = ['none', 'skeleton', 'blur', 'full'];

// MediaPipe body points used by the synthetic figure (the same indices as the real model).
const P = { nose: 0, ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16, lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28 };
const SYN_CONNECTIONS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]]
  .map(([start, end]) => ({ start, end }));

/** A figure that walks across the room and now and then sits or lies down; `pose` overrides it. */
function syntheticPose(t, pose) {
  const lm = Array.from({ length: 33 }, () => ({ x: -1, y: -1, visibility: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y, visibility: 1 }; };
  const walk = (t / 1000) % 16;
  let cx = 0.5 + 0.28 * Math.sin(t / 3200), top = 0.22, h = 0.55, lying = false;
  if (pose === 'lying' || (pose !== 'standing' && walk > 12)) lying = true;
  if (lying) {
    // horizontal on the floor, low in the frame
    const y = 0.78, x0 = 0.3;
    set(P.nose, x0, y - 0.03); set(P.ls, x0 + 0.06, y - 0.02); set(P.rs, x0 + 0.06, y + 0.02);
    set(P.le, x0 + 0.12, y - 0.06); set(P.re, x0 + 0.12, y + 0.05); set(P.lw, x0 + 0.18, y - 0.08); set(P.rw, x0 + 0.18, y + 0.06);
    set(P.lh, x0 + 0.24, y - 0.02); set(P.rh, x0 + 0.24, y + 0.02); set(P.lk, x0 + 0.34, y - 0.03); set(P.rk, x0 + 0.34, y + 0.03);
    set(P.la, x0 + 0.44, y - 0.03); set(P.ra, x0 + 0.44, y + 0.03);
    return lm;
  }
  const seated = pose === 'seated' || (pose !== 'standing' && walk > 8);
  if (seated) { top = 0.36; h = 0.42; cx = 0.62; }
  const sw = seated ? 0 : Math.sin(t / 260) * 0.05;   // leg swing while walking
  set(P.nose, cx, top);
  set(P.ls, cx - 0.06, top + 0.1); set(P.rs, cx + 0.06, top + 0.1);
  set(P.le, cx - 0.09, top + 0.24); set(P.re, cx + 0.09, top + 0.24);
  set(P.lw, cx - 0.1, top + 0.36); set(P.rw, cx + 0.1, top + 0.36);
  set(P.lh, cx - 0.045, top + 0.34); set(P.rh, cx + 0.045, top + 0.34);
  if (seated) {
    set(P.lk, cx - 0.12, top + 0.36); set(P.rk, cx + 0.03, top + 0.36);
    set(P.la, cx - 0.12, top + h); set(P.ra, cx + 0.03, top + h);
  } else {
    set(P.lk, cx - 0.04 + sw, top + 0.45); set(P.rk, cx + 0.04 - sw, top + 0.45);
    set(P.la, cx - 0.04 + sw * 1.6, top + h); set(P.ra, cx + 0.04 - sw * 1.6, top + h);
  }
  return lm;
}

async function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((r) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', on); r(); };
    const on = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', on);
    setTimeout(done, 2500);
  });
}

export function createSource({ deviceId = 'tapoc2020' } = {}) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px';
  document.body.appendChild(video);

  const st = { status: 'idle', error: null, landmarks: null, poseState: 'none', synthetic: true, syntheticPose: null, frames: 0 };
  const tiles = new Set();          // { canvas, ctx, small, sctx, getMode }
  const listeners = new Set();
  let pc = null, landmarker = null, connections = SYN_CONNECTIONS, poseTried = false, lastDetect = 0, raf = null;

  const notify = () => listeners.forEach((f) => f(st));

  async function connect() {
    if (pc) return;
    st.status = 'connecting'; st.error = null; notify();
    try {
      const c = new RTCPeerConnection({ iceServers: ICE });
      pc = c;
      c.addEventListener('track', (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        if (video.srcObject !== stream) { video.srcObject = stream; video.play().catch(() => {}); }
      });
      c.addEventListener('connectionstatechange', () => {
        if (pc !== c) return;
        if (c.connectionState === 'connected') { st.status = 'live'; st.synthetic = false; notify(); }
        if (c.connectionState === 'failed') { st.status = 'offline'; st.error = 'WebRTC spojení selhalo (síť blokuje UDP 8555?)'; st.synthetic = true; notify(); }
      });
      c.addTransceiver('audio', { direction: 'recvonly' });
      c.addTransceiver('video', { direction: 'recvonly' });
      await c.setLocalDescription(await c.createOffer());
      await waitForIce(c);
      const res = await fetch('/api/stream', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, sdpOffer: c.localDescription.sdp }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Nejste přihlášeni v aplikaci Famicura.');
      if (!res.ok) throw new Error(body.error || body.detail || ('HTTP ' + res.status));
      await c.setRemoteDescription({ type: 'answer', sdp: body.sdpAnswer });
      // No frame within 12 s: the network drops WebRTC; the synthetic scene stays.
      setTimeout(() => { if (pc === c && st.frames === 0) { st.status = 'offline'; st.error = 'Přes WebRTC nepřišel obraz (síť nejspíš blokuje UDP 8555).'; st.synthetic = true; notify(); } }, 12000);
    } catch (e) {
      st.status = 'offline'; st.error = e.message; st.synthetic = true; notify();
    }
  }

  async function ensurePose() {
    if (landmarker || poseTried) return;
    poseTried = true;
    st.poseState = 'loading'; notify();
    try {
      const mod = await import(MP);
      const vision = await mod.FilesetResolver.forVisionTasks(MP + '/wasm');
      landmarker = await mod.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', delegate: 'GPU' },
        runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5 });
      connections = mod.PoseLandmarker.POSE_CONNECTIONS;
      st.poseState = 'ready';
    } catch (e) {
      st.poseState = 'unavailable'; st.error = st.error || ('Drátěný model nejde spočítat: ' + e.message);
    }
    notify();
  }

  function needsPose() { for (const t of tiles) { const m = t.getMode(); if (m === 'skeleton' || m === 'blurskel' || m === 'fullskel') return true; } return false; }

  function drawPlaceholder(ctx, w, h, mode) {
    // a quiet room: floor, wall, a bed outline
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3a4652'); g.addColorStop(0.62, '#4b5865'); g.addColorStop(0.63, '#6b6257'); g.addColorStop(1, '#4e463e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = Math.max(2, w / 300);
    ctx.strokeRect(w * 0.08, h * 0.5, w * 0.34, h * 0.3);         // bed
    ctx.strokeRect(w * 0.7, h * 0.34, w * 0.14, h * 0.3);          // door
    if (mode === 'blur' || mode === 'blurskel') { ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, w, h); }
  }

  function render(now) {
    raf = requestAnimationFrame(render);
    const live = !st.synthetic && video.readyState >= 2;
    if (live) st.frames++;
    if (needsPose()) {
      if (live) {
        ensurePose();
        if (landmarker && now - lastDetect > 80) {
          lastDetect = now;
          try { const r = landmarker.detectForVideo(video, now); st.landmarks = r.landmarks?.[0] || null; } catch { /* a frame lost */ }
        }
      } else {
        st.landmarks = syntheticPose(now, st.syntheticPose); connections = SYN_CONNECTIONS;
      }
    }
    for (const t of tiles) {
      const mode = t.getMode();
      const cv = t.canvas;
      const w = live ? (video.videoWidth || 640) : 640, h = live ? (video.videoHeight || 360) : 360;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; t.small.width = 48; t.small.height = Math.max(24, Math.round(48 * h / w)); }
      const ctx = t.ctx;
      if (mode === 'none') {
        ctx.fillStyle = '#243040'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = `${Math.round(w / 26)}px sans-serif`; ctx.textAlign = 'center';
        ctx.fillText('bez obrazu', w / 2, h / 2 - w / 60);
        ctx.font = `${Math.round(w / 40)}px sans-serif`; ctx.fillText('rodina obraz nepovolila · jen události', w / 2, h / 2 + w / 32);
        continue;
      }
      const wantSkel = mode === 'skeleton' || mode === 'blurskel' || mode === 'fullskel';
      const base = mode === 'skeleton' ? 'black' : (mode === 'blur' || mode === 'blurskel') ? 'blur' : 'normal';
      if (base === 'black') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
      else if (live) drawBackground(ctx, cv, video, base, t.small, t.sctx);
      else drawPlaceholder(ctx, w, h, mode);
      if (wantSkel) {
        if (st.landmarks) drawSkeleton(ctx, cv, st.landmarks, connections);
        else {
          ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = `${Math.round(w / 34)}px sans-serif`; ctx.textAlign = 'center';
          ctx.fillText(st.poseState === 'unavailable' ? 'drátěný model není k dispozici (WebGL)' : st.poseState === 'loading' ? 'načítám model postavy…' : 'postava nerozpoznána', w / 2, h - w / 30);
        }
      }
      if (!live && base !== 'black') {
        ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = `${Math.round(w / 44)}px sans-serif`; ctx.textAlign = 'left';
        ctx.fillText('náhradní scéna – kamera nedostupná', 10, h - 10);
      }
    }
  }

  return {
    state: st, video,
    connect,
    /** Draws the picture into `canvas` in the mode `getMode()` returns, until unregistered. */
    register(canvas, getMode) {
      const small = document.createElement('canvas');
      const t = { canvas, ctx: canvas.getContext('2d'), small, sctx: small.getContext('2d'), getMode };
      tiles.add(t);
      if (raf === null) raf = requestAnimationFrame(render);
      return () => tiles.delete(t);
    },
    onChange(f) { listeners.add(f); f(st); return () => listeners.delete(f); },
    /** Synthetic scene only: force the figure's pose (standing, seated, lying) or null for its own rhythm. */
    setSyntheticPose(p) { st.syntheticPose = p; },
    stop() { if (raf !== null) cancelAnimationFrame(raf); raf = null; pc?.close(); pc = null; video.srcObject = null; },
  };
}
