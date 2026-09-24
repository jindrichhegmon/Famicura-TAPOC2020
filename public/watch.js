/*
 * Which analysis events are reported for each camera.
 *
 * The detector always sees everything; this decides what reaches the log and
 * CLB1. A bedroom camera, say, should report a fall at any hour but not lying
 * down at night. Shared by the page and by the /api/watch function, so what the
 * server accepts is exactly what the page applies. No DOM: unit tested in Node.
 */
import { toMinutes, isWithin } from './schedule.js';

/*
 * The events the pose detector can tell apart. `after` lists the durations a
 * caregiver can pick for events that are only worth reporting once they last;
 * the first value is what the detector did before this was configurable.
 */
export const WATCH_EVENTS = [
  { kind: 'fall',    label: 'Pád' },
  { kind: 'longlie', label: 'Dlouhé ležení',    after: [6, 30, 60, 120, 300, 600, 1800] },
  { kind: 'abrupt',  label: 'Prudký pohyb' },
  { kind: 'missing', label: 'Odchod ze záběru', after: [2, 10, 30, 60, 300] },
  { kind: 'state',   label: 'Změny polohy (stojí, sedí, leží)' },
];

const BY_KIND = Object.fromEntries(WATCH_EVENTS.map((e) => [e.kind, e]));

/*
 * An event can start a recording of the next few seconds (in the browser that
 * has the camera open). One length per camera, chosen on a slider.
 */
export const RECORD_S = { min: 5, max: 30, default: 15 };

/*
 * What the camera itself reports (ONVIF). Which of these a camera has, the
 * camera says (src/onvif.mjs); the server filters and writes them, so this
 * side only decides and describes. A kind outside the list is one the camera
 * declared under its own name: it keeps the label the camera gave it.
 */
export const CAMERA_EVENTS = [
  { kind: 'cam-motion',    label: 'Pohyb',                        level: 'info' },
  { kind: 'cam-person',    label: 'Osoba',                        level: 'info' },
  { kind: 'cam-vehicle',   label: 'Vozidlo',                      level: 'info' },
  { kind: 'cam-pet',       label: 'Zvíře',                        level: 'info' },
  { kind: 'cam-smart',     label: 'Chytrá detekce (vozidlo, zvíře…)', level: 'info' },
  { kind: 'cam-linecross', label: 'Překročení čáry',              level: 'warn' },
  { kind: 'cam-tamper',    label: 'Zakrytí nebo posunutí kamery', level: 'warn' },
];
const BY_CAM = Object.fromEntries(CAMERA_EVENTS.map((e) => [e.kind, e]));
export const CAMERA_KIND = /^cam-[a-z0-9]{1,30}$/;

export const isCameraKind = (kind) => CAMERA_KIND.test(String(kind || ''));
export const cameraEventLabel = (kind, label) => BY_CAM[kind]?.label || label || String(kind).slice(4);
export const cameraEventLevel = (kind) => BY_CAM[kind]?.level || 'info';

/** Everything on, all day, original durations – how analysis always behaved. */
export function defaultWatch() {
  const w = { recordS: RECORD_S.default };
  for (const e of WATCH_EVENTS) {
    w[e.kind] = { enabled: true, from: '', to: '', record: false };
    if (e.after) w[e.kind].after = e.after[0];
  }
  return w;
}

/** Seconds to record after an event of this kind, or 0 when it should not record. */
export function recordSeconds(watch, kind) {
  return watch?.[kind]?.record ? (Number(watch.recordS) || RECORD_S.default) : 0;
}

export function fmtAfter(s) {
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Accepts what the editor sends and returns what is safe to store. A missing
 * event falls back to its default and an unknown one is dropped, so a page
 * from before an event existed cannot break the settings.
 */
export function normalizeWatch(raw) {
  if (raw === undefined || raw === null) return { ok: true, watch: defaultWatch() };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Nastavení musí být objekt.' };

  const watch = defaultWatch();
  for (const e of WATCH_EVENTS) {
    const r = raw[e.kind];
    if (r === undefined || r === null) continue;
    if (typeof r !== 'object') return { ok: false, error: `${e.label}: neplatné nastavení.` };

    const from = String(r.from ?? '').trim();
    const to = String(r.to ?? '').trim();
    if (!!from !== !!to) return { ok: false, error: `${e.label}: vyplňte začátek i konec hodin, nebo ani jedno.` };
    if (from && (toMinutes(from) === null || toMinutes(to) === null)) {
      return { ok: false, error: `${e.label}: čas musí být ve tvaru HH:MM.` };
    }
    if (from && from === to) return { ok: false, error: `${e.label}: začátek a konec se nesmí rovnat.` };

    const out = { enabled: r.enabled !== false, from, to, record: r.record === true };
    if (e.after) {
      const after = r.after === undefined ? e.after[0] : Number(r.after);
      if (!e.after.includes(after)) return { ok: false, error: `${e.label}: nepodporovaná délka.` };
      out.after = after;
    }
    watch[e.kind] = out;
  }

  // Camera-reported events: only the ones the caller set, and only when they
  // differ from the default (on, all day), so an untouched camera stays default.
  for (const kind of Object.keys(raw)) {
    if (!isCameraKind(kind)) continue;
    const r = raw[kind];
    if (r === null || r === undefined) continue;
    const label = cameraEventLabel(kind);
    if (typeof r !== 'object') return { ok: false, error: `${label}: neplatné nastavení.` };
    const from = String(r.from ?? '').trim();
    const to = String(r.to ?? '').trim();
    if (!!from !== !!to) return { ok: false, error: `${label}: vyplňte začátek i konec hodin, nebo ani jedno.` };
    if (from && (toMinutes(from) === null || toMinutes(to) === null)) {
      return { ok: false, error: `${label}: čas musí být ve tvaru HH:MM.` };
    }
    if (from && from === to) return { ok: false, error: `${label}: začátek a konec se nesmí rovnat.` };
    const enabled = r.enabled !== false;
    const record = r.record === true;
    if (enabled && !from && !record) continue;
    watch[kind] = { enabled, from, to, record };
  }

  if (raw.recordS !== undefined && raw.recordS !== null) {
    const s = Number(raw.recordS);
    if (!Number.isInteger(s) || s < RECORD_S.min || s > RECORD_S.max) {
      return { ok: false, error: `Délka nahrávání události musí být ${RECORD_S.min}–${RECORD_S.max} s.` };
    }
    watch.recordS = s;
  }
  return { ok: true, watch };
}

/**
 * Whether a camera-reported event is wanted now. No setting means yes: the
 * camera's own detections are on until someone turns them off.
 */
export function cameraEventAllowed(watch, kind, date = new Date()) {
  const r = watch?.[kind];
  if (!r) return true;
  return r.enabled !== false && (!r.from || isWithin({ from: r.from, to: r.to }, date));
}

export function isDefaultWatch(w) {
  return JSON.stringify(normalizeWatch(w).watch) === JSON.stringify(defaultWatch());
}

/**
 * One line for the camera card: what this camera is watching for. cameraEvents
 * is what the camera itself can report ([{ kind, label }]); those are on
 * unless a setting says otherwise.
 */
export function describeWatch(w, cameraEvents = []) {
  const parts = [];
  for (const e of WATCH_EVENTS) {
    const r = w?.[e.kind];
    if (!r || !r.enabled) continue;
    let text = e.label;
    if (e.after && r.after !== e.after[0]) text += ` déle než ${fmtAfter(r.after)}`;
    if (r.from) text += ` (${r.from}–${r.to})`;
    parts.push(text);
  }
  const cam = [];
  for (const e of cameraEvents) {
    const r = w?.[e.kind];
    if (r && r.enabled === false) continue;
    cam.push(cameraEventLabel(e.kind, e.label).toLowerCase() + (r?.from ? ` (${r.from}–${r.to})` : ''));
  }
  let text = parts.length ? parts.join(' · ') : 'nic – analýza nic nehlásí';
  if (cam.length) text += ` · kamera hlásí: ${cam.join(', ')}`;
  const rec = [...WATCH_EVENTS.map((e) => [e.kind, e.label]), ...cameraEvents.map((e) => [e.kind, cameraEventLabel(e.kind, e.label)])]
    .filter(([kind]) => w?.[kind]?.record && w[kind].enabled !== false).map(([, label]) => label.toLowerCase());
  if (rec.length) text += ` · nahrává ${w.recordS || RECORD_S.default} s při: ${rec.join(', ')}`;
  return text;
}

/**
 * Decides, event by event, what gets reported. Events outside the catalogue –
 * a lost connection, say – always pass. "found" belongs to "missing": the
 * person reappearing is only news if their disappearance was reported.
 */
export class WatchFilter {
  constructor(watch) {
    this.set(watch);
  }

  set(watch) {
    this.watch = normalizeWatch(watch).watch;
    this.missingShown = false;
  }

  accept(ev, date = new Date()) {
    if (ev.kind === 'found') {
      const shown = this.missingShown;
      this.missingShown = false;
      return shown;
    }
    if (!BY_KIND[ev.kind]) return true;

    const r = this.watch[ev.kind];
    const ok = r.enabled && (!r.from || isWithin({ from: r.from, to: r.to }, date));
    if (ev.kind === 'missing') this.missingShown = ok;
    return ok;
  }

  /** Durations the detector itself needs to know. */
  detectorOptions() {
    return { longLieS: this.watch.longlie.after, missingS: this.watch.missing.after };
  }
}
