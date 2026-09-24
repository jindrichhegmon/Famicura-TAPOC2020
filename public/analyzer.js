/*
 * Live pose analysis for the camera stream.
 *
 * The Fall Analyzer prototype collected a pose timeline while recording and
 * described it once, after the fact. Here the description has to appear while
 * the stream plays, so the same rules run as a streaming state machine that
 * emits an event the moment it can be decided.
 *
 * No DOM access at module scope - the detector is unit tested in Node.
 */

// MediaPipe PoseLandmarker indices.
const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24, L_ANKLE = 27, R_ANKLE = 28;

// Thresholds carried over from the prototype.
const STATE_HOLD_S   = 1.0;   // a posture must persist this long before it is reported
const LONG_LIE_S     = 6.0;   // defaults; each camera can ask for longer (see watch.js)
const MISSING_S      = 2.0;
const FALL_LYING_S   = 1.8;   // lying this long after a drop confirms a fall
const CANDIDATE_S    = 2.5;   // a drop that does not end lying down expires
const ABRUPT_GAP_S   = 2.0;   // debounce for abrupt-movement lines

export const STATE_UPRIGHT = "stojí nebo se pohybuje ve vzpřímené poloze";
export const STATE_SEATED  = "sedí nebo je v předklonu";
export const STATE_LYING   = "leží nízko / vodorovně";
export const STATE_MOVING  = "mění polohu / pohybuje se";

export function fmtTime(sec) {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.floor(Math.max(0, sec) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// "6 s", "5 min" – long-lie thresholds now reach half an hour.
function fmtDuration(sec) {
  return sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`;
}

function at(lm, i) { return lm?.[i] || null; }
function mid(a, b) { return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }

export function features(lm) {
  if (!lm) return null;
  const shoulder = mid(at(lm, L_SHOULDER), at(lm, R_SHOULDER));
  const hip = mid(at(lm, L_HIP), at(lm, R_HIP));
  const ankle = mid(at(lm, L_ANKLE), at(lm, R_ANKLE));
  if (!shoulder || !hip) return null;

  // 90 = upright, 0 = horizontal.
  const torsoAngle = Math.atan2(Math.abs(shoulder.y - hip.y), Math.abs(shoulder.x - hip.x)) * 180 / Math.PI;

  const visible = lm.filter((q) => (q.visibility ?? 1) > 0.45);
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const q of visible) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  const width = Math.max(0.001, maxX - minX);
  const height = Math.max(0.001, maxY - minY);

  return { shoulder, hip, ankle, torsoAngle, aspect: width / height,
           centerY: (minY + maxY) / 2, width, height };
}

export function stateFor(ft) {
  const upright = ft.torsoAngle > 55 && ft.aspect < 1.0;
  const horizontal = ft.torsoAngle < 38 || ft.aspect > 1.25;
  const low = ft.hip.y > 0.58 || ft.centerY > 0.62;

  if (horizontal && low) return STATE_LYING;
  if (upright && ft.hip.y < 0.70) return STATE_UPRIGHT;
  if (ft.hip.y > 0.50 && ft.torsoAngle > 40 && ft.torsoAngle < 75) return STATE_SEATED;
  return STATE_MOVING;
}

/**
 * Feed frames in with push(t, landmarks); landmarks null means the pose model
 * found nobody. Every emitted event is {t, kind, level, text}.
 */
export class LiveAnalyzer {
  constructor(onEvent, options) {
    this.onEvent = onEvent || (() => {});
    this.configure(options);
    this.reset();
  }

  /** How long lying still or being out of view has to last before it is reported. */
  configure({ longLieS = LONG_LIE_S, missingS = MISSING_S } = {}) {
    this.longLieS = longLieS;
    this.missingS = missingS;
  }

  reset() {
    this.prev = null;
    this.back2 = null;
    this.pendingState = null;
    this.pendingSince = 0;
    this.reportedState = null;
    this.lastStandingAt = null;
    this.candidate = null;
    this.fallLyingSince = null;
    this.lastFallAt = null;
    this.lyingSince = null;
    this.longLieReported = false;
    this.missingSince = null;
    this.missingReported = false;
    this.lastAbruptAt = null;
    this.count = 0;
  }

  /**
   * The stream dropped and came back. Motion is derived from the previous
   * frame, so comparing across the gap would invent a velocity; the reported
   * posture is kept so a reconnect does not re-announce what is already known.
   */
  notePause() {
    this.prev = null;
    this.back2 = null;
    this.candidate = null;
    this.fallLyingSince = null;
    this.lyingSince = null;
    this.missingSince = null;
    this.missingReported = false;
    this.pendingState = null;
  }

  emit(t, kind, level, text) {
    this.onEvent({ t, kind, level, text });
  }

  push(t, landmarks) {
    if (!landmarks) return this.pushMissing(t);

    if (this.missingSince !== null) {
      if (this.missingReported) this.emit(t, "found", "info", "Postava je opět rozpoznána.");
      this.missingSince = null;
      this.missingReported = false;
    }

    const ft = features(landmarks);
    if (!ft) return; // partial pose: neither a valid frame nor a lost one

    this.count++;
    const state = stateFor(ft);

    this.trackState(t, state);
    this.trackLongLie(t, state);
    this.trackFall(t, ft);
    this.trackAbrupt(t, ft);

    this.back2 = this.prev;
    this.prev = { t, ft };
  }

  pushMissing(t) {
    if (this.missingSince === null) this.missingSince = t;
    if (!this.missingReported && t - this.missingSince >= this.missingS) {
      this.missingReported = true;
      this.emit(t, "missing", "warn", "Ztráta detekce postavy – v obraze není nikdo rozpoznán.");
    }
    // A lost person cannot be confirmed as lying or falling.
    this.candidate = null;
    this.fallLyingSince = null;
    this.lyingSince = null;
    this.prev = null;
    this.back2 = null;
  }

  trackState(t, state) {
    if (state !== this.pendingState) {
      this.pendingState = state;
      this.pendingSince = t;
    }
    if (this.pendingState !== this.reportedState && t - this.pendingSince >= STATE_HOLD_S) {
      this.reportedState = this.pendingState;
      this.emit(t, "state", "info", `Osoba ${this.pendingState}.`);
    }
  }

  trackLongLie(t, state) {
    if (state !== STATE_LYING) {
      this.lyingSince = null;
      this.longLieReported = false;
      return;
    }
    if (this.lyingSince === null) this.lyingSince = t;
    if (!this.longLieReported && t - this.lyingSince >= this.longLieS) {
      this.longLieReported = true;
      this.emit(t, "longlie", "warn",
        `Dlouhé ležení – osoba je nízko u země už přibližně ${fmtDuration(t - this.lyingSince)}.`);
    }
  }

  trackFall(t, ft) {
    const prev = this.prev;
    if (!prev) return;

    const dt = Math.max(0.03, t - prev.t);
    const hipVy = (ft.hip.y - prev.ft.hip.y) / dt;
    const angleDrop = prev.ft.torsoAngle - ft.torsoAngle;

    const upright = ft.torsoAngle > 55 && ft.aspect < 1.0;
    const horizontal = ft.torsoAngle < 38 || ft.aspect > 1.25;
    const low = ft.hip.y > 0.58 || ft.centerY > 0.62;

    if (upright) this.lastStandingAt = t;

    if (!this.candidate && ((hipVy > 0.38 && low) || angleDrop > 28)) {
      this.candidate = { start: t, peakVy: hipVy, maxAngleDrop: angleDrop };
    }
    if (!this.candidate) return;

    this.candidate.peakVy = Math.max(this.candidate.peakVy, hipVy);
    this.candidate.maxAngleDrop = Math.max(this.candidate.maxAngleDrop, angleDrop);

    if (!(horizontal && low)) {
      this.fallLyingSince = null;
      if (t - this.candidate.start > CANDIDATE_S) this.candidate = null;
      return;
    }

    if (this.fallLyingSince === null) this.fallLyingSince = t;
    const lyingDuration = t - this.fallLyingSince;
    if (lyingDuration < FALL_LYING_S) return;

    const recentStand = this.lastStandingAt !== null && this.candidate.start - this.lastStandingAt < 2.5;
    let score = 0;
    if (this.candidate.peakVy > 0.45) score += 2; else if (this.candidate.peakVy > 0.30) score += 1;
    if (this.candidate.maxAngleDrop > 35) score += 2; else if (this.candidate.maxAngleDrop > 20) score += 1;
    if (recentStand) score += 2;
    score += lyingDuration >= 3 ? 2 : 1;

    const level = score >= 6 ? "VYSOKÉ" : score >= 4 ? "STŘEDNÍ" : "NIŽŠÍ";
    const why = [];
    if (recentStand) why.push("předtím byla zachycena vzpřímená poloha");
    if (this.candidate.peakVy > 0.30) why.push("rychlý pohyb kyčlí dolů");
    if (this.candidate.maxAngleDrop > 20) why.push("prudká změna orientace trupu");
    why.push(`následovala nízká poloha po dobu ${lyingDuration.toFixed(1)} s`);

    this.emit(this.candidate.start, "fall", "warn",
      `MOŽNÝ PÁD – ${level} PODEZŘENÍ. ${why.join(", ")}.`);

    this.lastFallAt = t;
    this.candidate = null;
    this.fallLyingSince = null;
  }

  trackAbrupt(t, ft) {
    const back = this.back2;
    if (!back) return;
    if (this.lastFallAt !== null && t - this.lastFallAt < CANDIDATE_S) return;
    if (this.lastAbruptAt !== null && t - this.lastAbruptAt < ABRUPT_GAP_S) return;

    const dt = Math.max(0.05, t - back.t);
    const angleChange = Math.abs(ft.torsoAngle - back.ft.torsoAngle);
    const centerSpeed = Math.abs(ft.centerY - back.ft.centerY) / dt;

    if (angleChange > 45 || centerSpeed > 0.55) {
      this.lastAbruptAt = t;
      this.emit(t, "abrupt", "warn", "Prudká změna polohy těla.");
    }
  }
}

/* ---------- rendering (browser only; never called from tests) ---------- */

export const DISPLAY_MODES = {
  normal: "Normální",
  blur: "Rozmazaný",
  black: "Černé pozadí"
};

/**
 * Paints the frame the camera is sending, in the chosen privacy mode. `blur` scales
 * the frame down to a handful of pixels and back up without smoothing, which
 * destroys identifying detail rather than just softening it.
 */
export function drawBackground(ctx, canvas, video, mode, small, sctx) {
  if (mode === "black") {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (mode !== "blur") {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return;
  }

  sctx.save();
  sctx.filter = "grayscale(100%) contrast(85%) brightness(70%)";
  sctx.drawImage(video, 0, 0, small.width, small.height);
  sctx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = "rgba(0,0,0,.22)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

export function drawSkeleton(ctx, canvas, lm, connections) {
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = Math.max(3, canvas.width / 230);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const c of connections) {
    const a = lm[c.start], b = lm[c.end];
    if (!a || !b || (a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    ctx.stroke();
  }

  const r = Math.max(3, canvas.width / 185);
  for (const q of lm) {
    if ((q.visibility ?? 1) < 0.35) continue;
    ctx.beginPath();
    ctx.arc(q.x * canvas.width, q.y * canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ---------- log entries and export ---------- */

function pad(n) { return String(n).padStart(2, "0"); }

/** Wall-clock time of day, which is what a carer reads off the log. */
export function fmtClock(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Builds one log row. Event text originates from this module, but it is still
 * written with textContent so a future source cannot inject markup.
 */
/** Where a log entry came from: the camera's own detector or the analysis in the browser. */
/** "312 kB" under a megabyte, "2.4 MB" above: a short event clip must not read as "0.0 MB". */
export function fmtSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function eventSource(ev) {
  return /^cam-/.test(ev.kind || "") ? "kamera" : "analýza";
}

export function createLogEntry(doc, ev) {
  const li = doc.createElement("li");
  li.className = (ev.level === "warn" ? "warn " : "") + (eventSource(ev) === "kamera" ? "src-cam" : "src-ai");

  const ts = doc.createElement("span");
  ts.className = "ts";
  const clock = doc.createElement("strong");
  clock.textContent = fmtClock(ev.at || new Date());
  const since = doc.createElement("small");
  since.textContent = `+${fmtTime(ev.t)}`;
  ts.append(clock, since);

  const body = doc.createElement("span");
  body.className = "msg";
  const msg = doc.createElement("span");
  msg.textContent = ev.text;
  body.append(msg);
  // The source tag tells a caregiver at a glance what wrote the line: the
  // camera writes on its own around the clock, the analysis only while open.
  const cam = doc.createElement("small");
  cam.className = "cam";
  const tag = doc.createElement("span");
  tag.className = "srcTag";
  tag.textContent = eventSource(ev);
  cam.append(tag);
  if (ev.device?.name) cam.append(" · " + ev.device.name);
  body.append(cam);

  li.append(ts, body);
  return li;
}

/**
 * Turns date and time inputs into a bound. Either part may be blank: with no
 * date there is no bound at all, and with no time the range opens at midnight
 * and closes just before the next one.
 */
export function boundFrom(dateStr, timeStr, isEnd) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return null;
  let hh = isEnd ? 23 : 0, mm = isEnd ? 59 : 0, ss = isEnd ? 59 : 0, ms = isEnd ? 999 : 0;
  if (timeStr) {
    const parts = timeStr.split(":").map(Number);
    if (Number.isFinite(parts[0])) hh = parts[0];
    if (Number.isFinite(parts[1])) mm = parts[1];
    ss = Number.isFinite(parts[2]) ? parts[2] : (isEnd ? 59 : 0);
    ms = isEnd ? 999 : 0;
  }
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

export function filterLog(entries, from, to) {
  return entries.filter((e) => {
    const at = e.at instanceof Date ? e.at : new Date(e.at);
    if (from && at < from) return false;
    if (to && at > to) return false;
    return true;
  });
}

function csvCell(value) {
  const v = String(value ?? "");
  return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const KIND_LABEL = {
  state: "poloha", fall: "možný pád", longlie: "dlouhé ležení",
  missing: "ztráta detekce", found: "návrat detekce", abrupt: "prudká změna",
  stream: "spojení",
  "cam-motion": "pohyb", "cam-person": "osoba", "cam-vehicle": "vozidlo", "cam-pet": "zvíře",
  "cam-smart": "chytrá detekce", "cam-linecross": "překročení čáry", "cam-tamper": "zakrytí kamery"
};

/**
 * Semicolon separated, which is what Czech Excel expects; the caller prepends
 * a BOM so diacritics survive the round trip.
 */
export function logToCsv(entries) {
  const head = ["Datum", "Čas", "Od začátku analýzy", "Kamera", "ID kamery", "Zdroj", "Typ", "Závažnost", "Popis"];
  const rows = entries.map((e) => {
    const at = e.at instanceof Date ? e.at : new Date(e.at);
    return [
      fmtDate(at), fmtClock(at), fmtTime(e.t),
      e.device?.name || "", e.device?.id || "",
      eventSource(e),
      KIND_LABEL[e.kind] || e.kind || "",
      e.level === "warn" ? "varování" : "informace",
      e.text
    ].map(csvCell).join(";");
  });
  return [head.join(";"), ...rows].join("\r\n");
}

/** Stable, sortable filename covering the exported range. */
export function csvFilename(from, to) {
  const stamp = (d) => {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}_${pad(x.getHours())}-${pad(x.getMinutes())}`;
  };
  const a = from ? stamp(from) : "od-zacatku";
  const b = to ? stamp(to) : "do-konce";
  return `famicura-log_${a}_${b}.csv`;
}
