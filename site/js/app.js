// Shell: settings store, nav, refresh scheduler, notification banners.

const DEFAULTS = {
  token: '', stationId: '', deviceId: '', lat: null, lon: null, stationName: '',
  units: 'imperial', refreshSec: 60, places: [], activePlace: null,
  nearbyStations: [], notif: { severe: true, precip: true, lightning: true, wind: true, winter: true, changes: true },
  windGustAlert: 30,
};

let _settings = load('wd.settings', DEFAULTS);

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

const seen = new Set();

export function notify({ id, category = 'info', title, body }) {
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  if (category !== 'info' && _settings.notif[category] === false) return;
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
}

export function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
