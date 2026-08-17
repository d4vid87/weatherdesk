// Shell: settings store, nav, refresh scheduler, notification banners.

const DEFAULTS = {
  token: '', stationId: '', deviceId: '', lat: null, lon: null, stationName: '',
  units: 'imperial', refreshSec: 60, places: [], activePlace: null,
  // nearbyStations stays bare id strings: an older client on the same /config reads it directly,
  // and anything object-shaped would land in its URLs as [object Object]. New keys are additive.
  nearbyStations: [],
  nearbyRadius: 0,   // miles; 0 = manual adds only, no airport scanning
  nearbyMetar: [],   // discovered airports, [{ id: 'KGVT', name }]
  nearbyExclude: [], // airports the user dismissed; the daily scan won't bring them back
  notif: { severe: true, precip: true, lightning: true, wind: true, winter: true, changes: true },
  windGustAlert: 30, layoutLocked: false, hiddenTabs: [],
  // '' = whichever radar site is nearest the station. The camera itself lives in `wd.radar`,
  // written once a second by the embedded viewer — not here, where it would re-init the app.
  radarSite: '',
  // The inline viewer on the Desk. Heaviest thing the page loads, and on Linux it shares one
  // WebKit process with the whole Desk — see FIRST_RUN below.
  deskRadar: true,
  // Smart home: an MQTT broker to publish to, and a Home Assistant to read back from. Both dark
  // until filled in.
  mqttUrl: '', mqttUser: '', mqttPass: '', haUrl: '', haToken: '', haEntities: '',
};

// A fresh install starts with the Desk radar off: it is megabytes of wasm in the same WebKit
// process as everything else, and on a weak Linux box loading it is what made the app look hung.
// Turn it on in Settings. An install that already has settings keeps the radar it has been showing.
const FIRST_RUN = localStorage.getItem('wd.settings') == null;
let _settings = load('wd.settings', { ...DEFAULTS, deskRadar: !FIRST_RUN });

export function settings() { return _settings; }

export function saveSettings(patch) {
  _settings = { ..._settings, ...patch };
  store('wd.settings', _settings);
  window.dispatchEvent(new CustomEvent('wd:settings'));
  return _settings;
}

export function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? structuredClone(fallback) : (Array.isArray(fallback) ? v : { ...structuredClone(fallback), ...v });
  } catch { return structuredClone(fallback); }
}

export function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { console.warn('localStorage full', key, e); }
}

export const configured = () => !!(_settings.token && _settings.stationId);

// Coordinates the non-Tempest panels point at: the active saved place, else the station.
export function coords() {
  const p = _settings.places.find((x) => x.id === _settings.activePlace);
  return p ? { lat: p.lat, lon: p.lon, name: p.name } : { lat: _settings.lat, lon: _settings.lon, name: _settings.stationName };
}

// --- formatting helpers ---

export const U = {
  temp: () => (_settings.units === 'metric' ? '°C' : '°F'),
  wind: () => (_settings.units === 'metric' ? 'km/h' : 'mph'),
  precip: () => (_settings.units === 'metric' ? 'mm' : 'in'),
  press: () => (_settings.units === 'metric' ? 'mb' : 'inHg'),
  dist: () => (_settings.units === 'metric' ? 'km' : 'mi'),
};

export function num(v, digits = 0) {
  return v == null || Number.isNaN(v) ? '--' : (+v).toFixed(digits);
}

export function timeStr(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dayStr(epochSec) {
  return new Date(epochSec * 1000).toLocaleDateString([], { weekday: 'short' });
}

export const deg2compass = (d) =>
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
    Math.round(((d ?? 0) % 360) / 22.5) % 16];

// --- notifications (in-page; no service worker on insecure LAN origin) ---

// The log doubles as the dedupe memory: without it every reload re-notified (and re-chimed) each
// still-active NWS alert.
const notifLog = load('wd.notifLog', []);
const seen = new Set(notifLog.map((n) => n.id).filter(Boolean));

export const notifHistory = () => notifLog;

export function notify({ id, category = 'info', title, body }) {
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  if (category !== 'info' && _settings.notif[category] === false) return;
  notifLog.unshift({ t: Date.now(), id, category, title, body });
  notifLog.splice(100);
  store('wd.notifLog', notifLog);
  window.dispatchEvent(new CustomEvent('wd:notif'));
  const wrap = document.getElementById('notif-stack');
  const el = document.createElement('div');
  el.className = `notif notif-${category}`;
  el.innerHTML = `<div class="notif-title"></div><div class="notif-body"></div><button class="notif-x">×</button>`;
  el.querySelector('.notif-title').textContent = title;
  el.querySelector('.notif-body').textContent = body || '';
  el.querySelector('.notif-x').onclick = () => el.remove();
  wrap.prepend(el);
  chime();
}

let audioCtx;
function chime() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.15);
  } catch { /* autoplay blocked until first tap; fine */ }
}

// --- refresh scheduler: named jobs, each with its own period ---

const jobs = new Map();

// Nothing here is worth a request or a repaint while the window is hidden — a wall tablet with
// its screen off would otherwise poll every source all night. Whatever came due in the meantime
// runs once on the way back.
export function every(name, seconds, fn) {
  const prev = jobs.get(name);
  if (prev) clearInterval(prev.id);
  const job = { due: false };
  job.run = async () => {
    if (document.hidden) { job.due = true; return; }
    try { await fn(); } catch (e) { console.warn(`job ${name}:`, e.message); }
  };
  job.id = setInterval(job.run, seconds * 1000);
  jobs.set(name, job);
  job.run();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const job of jobs.values()) {
    if (!job.due) continue;
    job.due = false;
    job.run();
  }
});

// --- freshness stamps ---
//
// Panels keep their last good contents when a source fails; without a mark, "yesterday's forecast"
// and "this minute's forecast" look identical. `maxAgeSec` is the panel's own refresh period —
// three missed cycles is late enough to say so.
export function stamp(id, maxAgeSec) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.ts = Date.now();
  el.dataset.maxAge = maxAgeSec;
  el.classList.remove('stale');
}

every('stale-sweep', 60, () => {
  document.querySelectorAll('[data-ts]').forEach((el) => {
    const age = (Date.now() - +el.dataset.ts) / 1000;
    el.dataset.age = age > 5400 ? `${Math.round(age / 3600)}h` : `${Math.round(age / 60)}m`;
    el.classList.toggle('stale', age > 3 * (+el.dataset.maxAge || 300));
  });
});

export function refreshAll() {
  window.dispatchEvent(new CustomEvent('wd:refresh'));
}

// --- nav ---

export function initNav() {
  const tabs = [...document.querySelectorAll('.tab')];
  const show = (id) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.section === id));
    document.querySelectorAll('section.page').forEach((s) => s.classList.toggle('active', s.id === id));
    location.hash = id;
    // The ticker is a 60s transform animation: composited every frame, forever. Only let it run
    // while the Desk is the section on screen.
    document.body.classList.toggle('ticker-live', id === 'desk');
    window.dispatchEvent(new CustomEvent('wd:section', { detail: id }));
  };
  tabs.forEach((t) => (t.onclick = () => show(t.dataset.section)));
  show(location.hash.slice(1) || 'desk');
  applyTabs();
}

// Desk has no checkbox in the drawer, so it can never be hidden — that is the guard against
// hiding every tab and stranding the user on a blank shell.
export function applyTabs() {
  const hidden = _settings.hiddenTabs || [];
  let bounce = false;
  document.querySelectorAll('.tab').forEach((t) => {
    const off = hidden.includes(t.dataset.section);
    t.style.display = off ? 'none' : '';
    if (off && t.classList.contains('active')) bounce = true;
  });
  if (bounce) document.querySelector('.tab[data-section="desk"]').click();
}

export function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
