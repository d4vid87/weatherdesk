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
  notif: { severe: true, precip: true, lightning: true, wind: true, winter: true, changes: true, rule: true, station: true },
  // User-built thresholds — see rules.js. [{ metric, op, value, durMin }]
  rules: [],
  // Push channels. All three dark until filled in, all three fire-and-forget: a dashboard must
  // not stall on a phone notification.
  ntfyUrl: 'https://ntfy.sh', ntfyTopic: '', webhookUrl: '',
  windGustAlert: 30, layoutLocked: false, hiddenTabs: [],
  // '' = whichever radar site is nearest the station. The camera itself lives in `wd.radar`,
  // written once a second by the embedded viewer — not here, where it would re-init the app.
  radarSite: '',
  // The inline viewer on the Desk. Heaviest thing the page loads, and on Linux it shares one
  // WebKit process with the whole Desk — see FIRST_RUN below.
  deskRadar: true,
  // Bring the radar back on screen by itself when NWS has something serious out.
  stormAuto: true,
  // Stations the user can flip between from the header. One token, one set of preferences —
  // only the identity fields change. [{ id, name, deviceId, lat, lon }]
  savedStations: [],
  // Smart home: an MQTT broker to publish to, and a Home Assistant to read back from. Both dark
  // until filled in.
  mqttUrl: '', mqttUser: '', mqttPass: '', haUrl: '', haToken: '', haEntities: '',
  // Look and feel. 'auto' theme follows the station's own sunrise/sunset, not the OS — a wall
  // panel in a dark hallway wants the room's light, not the laptop's setting.
  theme: 'dark', accent: '', fontScale: 1, density: 'normal', bigNumbers: false,
  // Kiosk: seconds per tab when cycling (0 = off), and dimming through the night window.
  kioskCycleSec: 0, nightDim: false,
  // 'auto' | 'on' | 'off' — see ecoOn(). Auto is the point of the setting: the tablet on the wall
  // should not need anyone to know it is the slow machine.
  eco: 'auto',
  // Quiet hours, 'HH:MM' each, both empty = off. Suppresses the chime and every push channel;
  // a Severe or Extreme alert still comes through, because that is what the setting is for.
  quietStart: '', quietEnd: '',
  // Kiosk speech: read severe alerts aloud. Off by default — a dashboard that talks without
  // being asked is a dashboard someone unplugs.
  speakAlerts: false,
  // Palette pack on top of the theme: '', 'oled', 'solarized', 'contrast', 'eink'.
  palette: '',
  // The LAN server's port. Empty means 8088. Desktop only, and a restart applies it.
  httpPort: '',
  // CWOP callsign to report to (empty = off). Not a secret: callsigns are public and the
  // network's passcode for stations like ours is the constant -1.
  cwopId: '',
  // Relay the station on to the two networks a console usually uploads to — pointing it at this
  // app takes it away from them, and most consoles only hold one address.
  wuId: '', wuKey: '', pwsId: '', pwsKey: '',
  // Broker topics to read back and show on the Home card. [{ topic, label, unit }]
  mqttSubs: [],
  // --- Other brands of station. Empty means a Tempest (or nothing yet). ---
  // '' | 'ecowitt' | 'ambient' | 'wu' | 'wll' | 'awn' | 'lacrosse' | 'rtl433'. The push
  // protocols need no setting beyond this one — the console is told where to report and the
  // server takes whatever arrives. The rest name what has to be polled.
  stationSource: '',
  wllHost: '',                          // Davis WeatherLink Live, LAN address
  awnApiKey: '', awnAppKey: '',         // Ambient Weather Network, which is also a KestrelMet
  lacrosseEmail: '', lacrossePass: '',  // La Crosse — unofficial API, expect it to break
  // Optional shared secret for the ingest path. Empty by default: this server already trusts
  // its LAN with /config, and a console that must be told a secret is one nobody sets up.
  ingestKey: '',
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

// Whether there is a station behind this dashboard at all — a Tempest with a token, or any other
// brand reporting into the LAN server. `configured()` still means "Tempest REST is usable" and
// still gates everything that talks to WeatherFlow; this gates what any station can drive.
export const hasSource = () => configured() || !!(_settings.stationSource && _settings.lat != null);

// Forecasts only need a point on the earth: open-meteo and the NWS are free and worldwide. An
// install with no station at all still gets a ten-day and a story out of a saved place.
export const hasLocation = () => coords().lat != null;

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

// Quiet hours: 'HH:MM' to 'HH:MM', wrapping midnight because that is the only interesting case.
// Both blank means always awake.
export function inQuiet(s = _settings, now = new Date()) {
  const [a, b] = [s.quietStart, s.quietEnd];
  if (!a || !b) return false;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const [from, to, at] = [mins(a), mins(b), now.getHours() * 60 + now.getMinutes()];
  return from <= to ? at >= from && at < to : at >= from || at < to;
}

export function notify({ id, category = 'info', title, body }) {
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  if (category !== 'info' && _settings.notif[category] === false) return;
  const entry = { t: Date.now(), id, category, title, body };
  notifLog.unshift(entry);
  notifLog.splice(100);
  store('wd.notifLog', notifLog);
  // detail is what home.js republishes to the broker — it needs no second copy of this logic
  window.dispatchEvent(new CustomEvent('wd:notif', { detail: entry }));
  // Asleep: the banner still goes up (it costs nothing and is there in the morning), but
  // nothing makes a sound or reaches a phone. Severe weather is the exception it exists for.
  const quiet = inQuiet() && category !== 'severe';
  if (category !== 'info' && !quiet) push(entry);
  const wrap = document.getElementById('notif-stack');
  const el = document.createElement('div');
  el.className = `notif notif-${category}`;
  el.innerHTML = `<div class="notif-title"></div><div class="notif-body"></div><button class="notif-x">×</button>`;
  el.querySelector('.notif-title').textContent = title;
  el.querySelector('.notif-body').textContent = body || '';
  el.querySelector('.notif-x').onclick = () => el.remove();
  wrap.prepend(el);
  // A dashboard is left running for days, and nothing here ever took a banner down: an overnight
  // run of forecast changes buried the screen. Severe alerts stay until dismissed by hand.
  if (category !== 'severe') setTimeout(() => el.remove(), 30000);
  // Cap the stack too — the oldest goes first, but never a severe one over a routine one.
  while (wrap.children.length > 4) {
    const drop = [...wrap.children].reverse().find((n) => !n.classList.contains('notif-severe'));
    if (!drop) break;
    drop.remove();
  }
  if (quiet) return;
  chime();
  speak(entry);
  native(entry);
}

// A wall panel across the room can't be read, and the person it matters to isn't holding it.
// Severe only, and only when asked: `speakAlerts`.
function speak({ category, title }) {
  if (!_settings.speakAlerts || category !== 'severe' || !('speechSynthesis' in window)) return;
  try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(title)); }
  catch { /* no voices installed; the banner is still there */ }
}

// An in-page banner is no use behind another window. Desktop only, and only when this window
// isn't the one being looked at — a visible dashboard already showed the banner.
function native({ category, title, body }) {
  const api = window.__TAURI__?.notification;
  if (!api || category === 'info' || !document.hidden) return;
  api.isPermissionGranted()
    .then((ok) => (ok ? true : api.requestPermission().then((p) => p === 'granted')))
    .then((ok) => ok && api.sendNotification({ title, body: body || '' }))
    .catch(() => {});
}

// Off the machine: a banner is no use to anyone who isn't looking at the dashboard.
//
// Security: the payloads carry the title, the body and the category and nothing else. The
// Tempest token, the broker password and the station ID are deliberately absent — ntfy.sh is a
// public relay by default and a webhook goes wherever the user pointed it.
function push({ category, title, body }) {
  const s = _settings;
  if (s.ntfyTopic) {
    fetch(`${s.ntfyUrl || 'https://ntfy.sh'}/${encodeURIComponent(s.ntfyTopic)}`, {
      method: 'POST',
      // ntfy takes the title as a header, and a header value cannot contain a line break —
      // NWS headlines do.
      headers: { Title: String(title).replace(/[\r\n]+/g, ' ').slice(0, 200), Tags: category },
      body: body || title,
    }).catch((e) => console.warn('ntfy:', e.message));
  }
  if (s.webhookUrl) {
    fetch(s.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookBody(s.webhookUrl, { category, title, body })),
    }).catch((e) => console.warn('webhook:', e.message));
  }
  // MQTT rides the wd:notif event — home.js already owns the one connection.
}

// Discord and Telegram are the two webhooks people actually paste in, and neither accepts the
// generic shape. Recognised from the URL itself — no extra setting, and no second place to
// store a bot token: whatever the user pasted is the whole credential and it is already
// redacted from the public config as `webhookUrl`.
export function webhookBody(url, { category, title, body }) {
  const text = body ? `${title}\n${body}` : title;
  if (/discord(app)?\.com\/api\/webhooks\//.test(url)) return { content: text };
  if (/api\.telegram\.org\/bot/.test(url)) {
    // The chat id rides in the URL the user pasted: .../sendMessage?chat_id=123
    return { text };
  }
  return { title, body, category, t: Date.now() };
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

// Jobs that pace themselves for a reason and must not be stretched: the clock is the display,
// the UDP poll is the only live data a hub-only install has, and alerts are the one thing worth
// a battery percent.
// 'pace' itself is exempt for an obvious reason: stretched to 45 minutes it would be the thing
// that never notices the night window closing.
const PACE_EXEMPT = ['clock', 'udp', 'desk-alerts', 'pace', 'stale-sweep', 'kiosk', 'appearance'];

// Set by desk.js when NWS has a Severe/Extreme alert out. Beats eco and night both.
let storm = false;
export function setStorm(on) {
  if (storm === !!on) return;
  storm = !!on;
  repace();
  window.dispatchEvent(new CustomEvent('wd:storm', { detail: storm }));
}
export const stormMode = () => storm;

// Sunrise/sunset for the night window, filled from whatever forecast the Desk last got. No
// import from desk.js — that would be a cycle, and the event is already on the wire.
let sunTimes = null;
window.addEventListener('wd:forecast', (e) => {
  const d = e.detail?.forecast?.daily?.[0];
  if (d?.sunrise && d?.sunset) sunTimes = { sunrise: d.sunrise, sunset: d.sunset };
  repace();
});

export function ecoOn() {
  if (_settings.eco === 'on') return true;
  if (_settings.eco === 'off') return false;
  // Two cores is a G Pad; four is an old Chromebook. Anything bigger can afford the full rate.
  return (navigator.hardwareConcurrency || 8) <= 4;
}

// Quiet hours: sunset+1h to sunrise−1h, so the dashboard is back at full rate before anyone
// looks at it. No forecast yet (or a station without sun times) falls back to the clock.
export function isNight(now = new Date()) {
  if (sunTimes) {
    const t = now.getTime() / 1000;
    return t > sunTimes.sunset + 3600 || t < sunTimes.sunrise - 3600;
  }
  const h = now.getHours();
  return h >= 21 || h < 6;
}

// Seconds this job should actually run at.
export function paceFor(name, base) {
  if (storm) return name === 'desk-obs' || name === 'desk-alerts' ? Math.max(30, base / 2) : base;
  if (PACE_EXEMPT.includes(name)) return base;
  if (isNight()) return base * 3;
  return ecoOn() ? base * 2 : base;
}

// Re-arm every job at its current pace. Deliberately does not run any of them: pacing is not a
// refresh, and a settings save that re-paced ten jobs would fire ten fetches.
function repace() {
  for (const [name, job] of jobs) {
    const secs = paceFor(name, job.base);
    if (secs === job.paced) continue;
    job.paced = secs;
    clearInterval(job.id);
    job.id = setInterval(job.run, secs * 1000);
  }
}

// A fetch deadline, the long way round. `AbortSignal.timeout` is Chrome 103 and Safari 16, and
// the wall tablets this dashboard is aimed at are older than both — on one of them the missing
// method threw before the request was made, so every timed fetch on the page died at once and
// the screen came up as an unconfigured install. AbortController has been everywhere since 2018.
export function expires(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Nothing here is worth a request or a repaint while the window is hidden — a wall tablet with
// its screen off would otherwise poll every source all night. Whatever came due in the meantime
// runs once on the way back.
export function every(name, seconds, fn) {
  const prev = jobs.get(name);
  if (prev) clearInterval(prev.id);
  const job = { due: false, base: seconds };
  job.run = async () => {
    if (document.hidden) { job.due = true; return; }
    try { await fn(); } catch (e) { console.warn(`job ${name}:`, e.message); }
  };
  job.paced = paceFor(name, seconds);
  job.id = setInterval(job.run, job.paced * 1000);
  jobs.set(name, job);
  job.run();
}

// The night window opens on its own; nothing else would notice.
every('pace', 900, repace);
window.addEventListener('wd:settings', () => { applyEco(); repace(); });

// Eco is a class, and everything it costs is in CSS (the ticker is a 60s composited transform,
// the transitions repaint on every hover).
export function applyEco() {
  document.body.classList.toggle('eco', ecoOn());
}

// --- appearance ---

export function applyTheme() {
  const s = _settings;
  const light = s.theme === 'light' || (s.theme === 'auto' && !isNight());
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.documentElement.dataset.density = s.density || 'normal';
  // Palette packs sit on top of the theme: each is a handful of variable overrides in
  // index.html, so nothing else on the page has to know they exist.
  if (s.palette) document.documentElement.dataset.palette = s.palette;
  else delete document.documentElement.dataset.palette;
  // A scale, not a size: everything on the page is already relative to the root font.
  // `zoom`, not a root font-size: the stylesheet is in px throughout (deliberately — panel sizes
  // are stored in px too), so a root font-size would scale almost nothing on screen. Zoom is
  // supported by every engine this runs on, WebKitGTK and the G Pad's WebView included.
  document.documentElement.style.zoom = Math.min(2, Math.max(0.7, +s.fontScale || 1));
  document.body.classList.toggle('big-numbers', !!s.bigNumbers);
  if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
  else document.documentElement.style.removeProperty('--accent');
  document.body.classList.toggle('dimmed', !!s.nightDim && isNight());
}

// --- kiosk ---
//
// Nobody is going to touch a panel on a wall, so the panel has to move on its own: cycle the
// visible tabs, and nudge the whole page a couple of pixels each hour so a static header does
// not etch itself into an OLED.
let kioskAt = 0;
function kioskStep() {
  const secs = +_settings.kioskCycleSec || 0;
  if (!secs) return;
  const tabs = [...document.querySelectorAll('.tab')].filter((t) => t.style.display !== 'none');
  if (tabs.length < 2) return;
  kioskAt = (kioskAt + 1) % tabs.length;
  tabs[kioskAt].click();
}

let burn = 0;
function burnInStep() {
  if (!+_settings.kioskCycleSec) { document.body.style.transform = ''; return; }
  burn = (burn + 1) % 4;
  document.body.style.transform = `translate(${[0, 2, 0, -2][burn]}px, ${[0, -2, 2, 0][burn]}px)`;
}

export function initKiosk() {
  applyTheme();
  // Re-registering replaces the old job, so a changed cycle time takes effect on save.
  const secs = +_settings.kioskCycleSec || 0;
  clearJob('kiosk');
  if (secs) every('kiosk', secs, kioskStep);
  every('appearance', 900, () => { applyTheme(); burnInStep(); });
}

// A job turned off in settings has to actually stop — every() only ever replaces.
export function clearJob(name) {
  const job = jobs.get(name);
  if (!job) return;
  clearInterval(job.id);
  jobs.delete(name);
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

// ponytail-lite self-check: the pace table, where a wrong branch means a dashboard that quietly
// stops updating.
if (location.search.includes('selftest')) {
  const save = { ..._settings };
  _settings.eco = 'on';
  const night = isNight();
  console.assert(paceFor('clock', 1) === 1, 'pace: exempt jobs untouched');
  console.assert(paceFor('desk-forecast', 300) === (night ? 900 : 600), 'pace: eco/night factor');
  setStorm(true);
  console.assert(paceFor('desk-forecast', 300) === 300, 'pace: storm restores full rate');
  console.assert(paceFor('desk-obs', 60) === 30, 'pace: storm halves obs');
  console.assert(paceFor('desk-obs', 30) === 30, 'pace: storm never goes below 30s');
  setStorm(false);
  _settings.eco = 'off';
  console.assert(paceFor('desk-forecast', 300) === (night ? 900 : 300), 'pace: eco off');
  _settings = save;

  // quiet hours: the window that wraps midnight is the one worth checking
  const q = { quietStart: '22:00', quietEnd: '07:00' };
  console.assert(inQuiet(q, new Date(2020, 0, 1, 23, 0)), 'quiet: 23:00 is inside a wrapped window');
  console.assert(inQuiet(q, new Date(2020, 0, 1, 3, 0)), 'quiet: 03:00 is inside a wrapped window');
  console.assert(!inQuiet(q, new Date(2020, 0, 1, 12, 0)), 'quiet: noon is outside');
  console.assert(!inQuiet(q, new Date(2020, 0, 1, 7, 0)), 'quiet: the end time is already awake');
  const day = { quietStart: '09:00', quietEnd: '17:00' };
  console.assert(inQuiet(day, new Date(2020, 0, 1, 12, 0)), 'quiet: a same-day window works too');
  console.assert(!inQuiet(day, new Date(2020, 0, 1, 20, 0)), 'quiet: outside a same-day window');
  console.assert(!inQuiet({ quietStart: '', quietEnd: '' }), 'quiet: unset means never quiet');

  // webhook shaping: the two services that reject the generic payload
  const alert = { category: 'severe', title: 'Tornado Warning', body: 'Take cover' };
  console.assert(webhookBody('https://discord.com/api/webhooks/1/abc', alert).content.includes('Tornado'),
    'webhook: discord takes content');
  console.assert(webhookBody('https://api.telegram.org/bot1:abc/sendMessage?chat_id=2', alert).text.includes('cover'),
    'webhook: telegram takes text');
  console.assert(webhookBody('https://example.com/hook', alert).category === 'severe',
    'webhook: anything else keeps the generic shape');
}

export function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
