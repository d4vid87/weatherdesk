// Wire the shell: settings drawer, diagnostics, nav, section modules.
import { settings, saveSettings, configured, initNav, fullscreen, refreshAll, notify, load, store } from './app.js';
import * as api from './api.js';
import { initDesk, refreshDesk, refreshObs, refreshAlerts, refreshAqi } from './desk.js';
import { initIntel, refreshModels, refreshNowcast } from './intel.js';
import { initSignals, refreshSignals } from './signals.js';
import { initBoards } from './boards.js';
import { initPlaces, renderPlaces } from './places.js';
import { initPro } from './pro.js';
import { initLayout, snapshot, restore } from './layout.js';
import { initUdp } from './udp.js';
import { initHome } from './home.js';

const $ = (id) => document.getElementById(id);

function fillDrawer() {
  const s = settings();
  $('set-token').value = s.token;
  $('set-station').value = s.stationId;
  $('set-device').value = s.deviceId;
  $('set-units').value = s.units;
  $('set-refresh').value = s.refreshSec;
  $('set-gust').value = s.windGustAlert;
  $('set-mqtt-url').value = s.mqttUrl;
  $('set-mqtt-user').value = s.mqttUser;
  $('set-mqtt-pass').value = s.mqttPass;
  $('set-ha-url').value = s.haUrl;
  $('set-ha-token').value = s.haToken;
  $('set-ha-entities').value = s.haEntities;
  fillSites();
}

// Radar site picker: every site, nearest first, so the one the user wants is at the top of the
// list rather than 200 rows down an alphabetical one.
function fillSites() {
  const el = $('set-radar-site');
  if (!el || !SITES.length) return;
  const s = settings();
  const rows = s.lat == null ? SITES.map((x) => [x, null])
    : SITES.map((x) => [x, milesBetween(s.lat, s.lon, x.lat, x.lon)]).sort((a, b) => a[1] - b[1]);
  el.innerHTML = '<option value="">Nearest to my station</option>'
    + rows.map(([x, d]) => `<option value="${x.id}">${x.id} — ${x.name}${d == null ? '' : ` (${Math.round(d)} mi)`}</option>`).join('');
  el.value = s.radarSite || '';
}

const openDrawer = (open) => $('drawer').classList.toggle('open', open);

$('btn-settings').onclick = () => { fillDrawer(); openDrawer(true); };
$('btn-close').onclick = () => openDrawer(false);
$('btn-full').onclick = fullscreen;
$('btn-refresh').onclick = refreshAll;

$('btn-save').onclick = async () => {
  // A new radar site means the saved camera belongs to the old one — drop it so the fresh
  // site-only link recenters.
  if ($('set-radar-site').value !== (settings().radarSite || '')) store('wd.radar', null);
  saveSettings({
    radarSite: $('set-radar-site').value,
    token: $('set-token').value.trim(),
    stationId: $('set-station').value.trim(),
    deviceId: $('set-device').value.trim(),
    units: $('set-units').value,
    refreshSec: +$('set-refresh').value || 60,
    windGustAlert: +$('set-gust').value || 30,
    mqttUrl: $('set-mqtt-url').value.trim(),
    mqttUser: $('set-mqtt-user').value.trim(),
    mqttPass: $('set-mqtt-pass').value,
    haUrl: $('set-ha-url').value.trim(),
    haToken: $('set-ha-token').value.trim(),
    haEntities: $('set-ha-entities').value.trim(),
  });
  await hydrateStation();
  openDrawer(false);
  // Point the radars at whatever the settings now say (a changed site, or a first station fix).
  for (const id of ['desk-radar-frame', 'lab-frame']) {
    if ($(id).src) $(id).src = radarUrl(id === 'lab-frame' ? 8 : 6.5, id !== 'lab-frame');
  }
  loadDeskRadar();
  initDesk(); // idempotent: every() replaces existing jobs
  initIntel(); initSignals(); initBoards(); initPro(); initLayout(); initUdp(); initHome();
};

// station meta fills name/lat/lon and the Tempest device id when blank
async function hydrateStation() {
  if (!configured()) return;
  try {
    const j = await api.station();
    const st = j.stations?.[0];
    if (!st) return;
    const tempest = st.devices?.find((d) => d.device_type === 'ST') || st.devices?.find((d) => d.device_type === 'AR');
    // history API wants the numeric device_id; a pasted serial (ST-00176465) won't work
    const numeric = /^\d+$/.test(settings().deviceId) ? settings().deviceId
      : (tempest ? String(tempest.device_id) : '');
    saveSettings({
      stationName: st.name,
      lat: st.latitude, lon: st.longitude,
      deviceId: numeric,
    });
    fillDrawer();
    renderPlaces();
  } catch (e) {
    notify({ title: 'Station lookup failed', body: e.message });
  }
}

// --- layout lock + presets ---
//
// Lock is CSS only: hiding the grips and resize handles takes the whole interaction out of reach,
// so layout.js needs no notion of it. A tablet mounted on a wall gets brushed past all day.
function applyLock() {
  const on = !!settings().layoutLocked;
  document.body.classList.toggle('layout-locked', on);
  $('btn-lock').textContent = on ? '🔒' : '🔓';
  $('btn-lock').title = on ? 'Panels locked — click to unlock' : 'Panels unlocked — click to lock';
}

$('btn-lock').onclick = () => { saveSettings({ layoutLocked: !settings().layoutLocked }); applyLock(); };

const layouts = () => load('wd.layouts', {});

function renderLayouts() {
  const map = layouts();
  const names = Object.keys(map);
  $('layout-list').innerHTML = names.length
    // index, not the name itself: a name is user text and has no business inside an attribute
    ? names.map((n, i) => `<div class="row" style="margin:0"><button class="place-hit" data-i="${i}"></button>`
      + `<button class="sig-x" data-del="${i}">×</button></div>`).join('')
    : '<div class="muted" style="font-size:12px">No saved layouts</div>';
  $('layout-list').querySelectorAll('[data-i]').forEach((b) => {
    b.textContent = names[+b.dataset.i];
    b.onclick = () => restore(layouts()[names[+b.dataset.i]]);
  });
  $('layout-list').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => { const m = layouts(); delete m[names[+b.dataset.del]]; store('wd.layouts', m); renderLayouts(); };
  });
}

$('btn-layout-save').onclick = () => {
  const name = $('layout-name').value.trim();
  if (!name) return;
  store('wd.layouts', { ...layouts(), [name]: snapshot() });
  $('layout-name').value = '';
  renderLayouts();
};

$('btn-diag').onclick = async () => {
  $('diag').innerHTML = '<div class="muted">running…</div>';
  const rows = await api.diagnostics();
  $('diag').innerHTML = rows.map((r) =>
    `<div><span>${r.name}</span><span class="${r.ok ? 'ok' : 'fail'}">${r.ok ? '✓ ' : '✗ '}${r.detail}</span></div>`
  ).join('');
};

window.addEventListener('wd:refresh', () => {
  refreshDesk().catch((e) => notify({ title: 'Forecast failed', body: e.message }));
  refreshObs().catch(() => {});
  refreshAlerts().catch(() => {});
  refreshAqi().catch(() => {});
  refreshModels().catch(() => {});
  refreshNowcast().catch(() => {});
  refreshSignals().catch(() => {});
});

// Hook Echo-WX (own NEXRAD viewer) instead of the weathermap build. Deep link is
// `#goto=SITE,lon,lat,zoom[,extras]` — note lon before lat, and unknown extras are ignored by
// older builds, so adding to this string can never break a deployed viewer.
const RADAR = 'https://hookecho.netlify.app/';

// The NEXRAD + TDWR registry, generated from Hook Echo's own site table
// (`cargo run -p wxdata --example sites_json`). Frozen data — a live endpoint would be coupling
// for nothing.
let SITES = [];
fetch('sites.json').then((r) => r.json()).then((j) => { SITES = j; fillSites(); }).catch(() => {});

// Great-circle distance in miles. Site spacing is ~100 mi, so a spherical earth is plenty.
export function milesBetween(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180, R = 3958.8;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearestSite(lat, lon, sites = SITES) {
  let best = null, bestD = Infinity;
  for (const s of sites) {
    const d = milesBetween(lat, lon, s.lat, s.lon);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// The site the radar should open on: the drawer pick, else the one nearest the station.
function radarSite() {
  const s = settings();
  if (s.radarSite) return s.radarSite;
  const n = s.lat == null ? null : nearestSite(s.lat, s.lon);
  return n ? n.id : '';
}

// Hook Echo's own localStorage is partitioned (or dropped) inside our cross-origin iframe, so it
// cannot remember anything for us — the saved view lives here and rides in on the deep link.
// That is what stops the site and the camera resetting on every launch.
export function radarUrl(zoom, embed = true) {
  const s = settings(), v = load('wd.radar', null);
  const site = v?.site || radarSite();
  const lon = v ? v.lon : s.lon, lat = v ? v.lat : s.lat;
  if (lat == null && !site) return RADAR;
  const extras = v
    ? [v.moment, v.tilt, `bm:${v.basemap}`, v.srv ? 'srv' : ''].filter(Boolean).join(',')
    : '';
  const q = embed ? '?embed' : '';
  return `${RADAR}${q}#goto=${site},${lon ?? ''},${lat ?? ''},${v ? v.zoom : zoom}${extras ? ',' + extras : ''}`;
}

// The embedded viewer posts its view back once a second; persist it, but deliberately not through
// saveSettings — a pan would fire `wd:settings` (and a full re-init) every second.
window.addEventListener('message', (e) => {
  if (e.origin !== new URL(RADAR).origin) return;
  let v = e.data;
  try { v = typeof v === 'string' ? JSON.parse(v) : v; } catch { return; }
  if (v && v.hookecho === 1) store('wd.radar', v);
});

// lazy-load the Lab iframe on first visit — full chrome there, it is the roomier view
window.addEventListener('wd:section', (e) => {
  const f = $('lab-frame');
  if (e.detail !== 'lab' || f.src) return;
  f.src = radarUrl(8, false);
});

// Inline radar strip on the Desk: embedded, so it holds one frame a minute until touched. A live
// radar loop otherwise costs the desktop app's WebKit webview a whole core.
function loadDeskRadar() {
  const f = $('desk-radar-frame');
  if (!f.src) f.src = radarUrl(6.5);
  $('desk-radar').classList.add('loaded');
}

initNav();
initPlaces();
// panel chrome doesn't depend on a token — wire it before the data path so an unconfigured
// dashboard is still arrangeable
initLayout();
applyLock();
renderLayouts();

if (!configured()) {
  fillDrawer();
  openDrawer(true);
} else {
  // lat/lon must land before the open-meteo/NWS jobs start
  hydrateStation().then(() => {
    loadDeskRadar();
    initDesk(); initIntel(); initSignals(); initBoards(); initPro(); initUdp(); initHome();
  });
}

// ponytail-lite self-check: `?selftest` asserts the site maths and the link the viewer is handed.
if (location.search.includes('selftest')) {
  const sites = [{ id: 'KTLX', name: 'Oklahoma City, OK', lat: 35.33, lon: -97.28 },
    { id: 'KFWS', name: 'Dallas, TX', lat: 32.57, lon: -97.30 }];
  console.assert(nearestSite(35.4, -97.5, sites).id === 'KTLX', 'nearest site');
  console.assert(Math.round(milesBetween(35.33, -97.28, 32.57, -97.30)) === 191, 'distance mi');
  store('wd.radar', { hookecho: 1, site: 'KFWS', moment: 'VEL', tilt: 2, srv: true, basemap: 'dark', lon: -97.3, lat: 32.6, zoom: 7 });
  const u = radarUrl(6.5);
  console.assert(u === `${RADAR}?embed#goto=KFWS,-97.3,32.6,7,VEL,2,bm:dark,srv`, 'radar url', u);
  store('wd.radar', null);
}
