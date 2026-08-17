// Wire the shell: settings drawer, diagnostics, nav, section modules.
import { settings, saveSettings, configured, initNav, applyTabs, fullscreen, refreshAll, notify, load, store, applyEco, initKiosk } from './app.js';
import * as api from './api.js';
import { initDesk, refreshDesk, refreshObs, refreshAlerts, refreshAqi } from './desk.js';
import { initIntel, refreshModels, refreshNowcast } from './intel.js';
import { initSignals, refreshSignals } from './signals.js';
import { initBoards } from './boards.js';
import { initAlmanac } from './almanac.js';
import { initRules, renderRules } from './rules.js';
import { initEnv } from './env.js';
import { initPlaces, renderPlaces } from './places.js';
import { initPro } from './pro.js';
import { initLayout, snapshot, restore, hiddenPanels, unhide } from './layout.js';
import { initUdp } from './udp.js';
import { initHome } from './home.js';

const $ = (id) => document.getElementById(id);

// ---------- config sync ----------
// The desktop app's LAN server keeps one settings+layout blob, so every browser in the house
// loads the host's configuration instead of being set up by hand. Static self-hosts have no
// /config route: the fetches fail and each browser keeps its own localStorage, as before.
const SRV = window.__WD_SRV || '';
let syncing = false;

// The /public dashboard: same page, injected flag, credential-free config. Everything that
// could change the host's settings — or read its token — is off from here on.
const PUBLIC = !!window.__WD_PUBLIC;

async function pullConfig() {
  syncing = true;
  try {
    const r = await fetch(`${SRV}/${PUBLIC ? 'config-public' : 'config'}`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return;
    const j = await r.json();
    if (j.settings) saveSettings(j.settings);
    if (j.layout) restore(j.layout);
  } catch {
    // no config server (static host, or app not running) — nothing to sync
  } finally {
    syncing = false;
  }
}

// ponytail: server wins on load, last writer wins on save. No merge — every save pushes the
// whole blob, so there is nothing to reconcile.
function pushConfig() {
  if (syncing || PUBLIC) return;
  fetch(`${SRV}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ at: Date.now(), settings: settings(), layout: load('wd.layout', {}) }),
  }).catch(() => {});
}

let pushTimer;
window.addEventListener('wd:layout', () => { clearTimeout(pushTimer); pushTimer = setTimeout(pushConfig, 2000); });


function fillDrawer() {
  const s = settings();
  $('set-token').value = s.token;
  $('set-station').value = s.stationId;
  $('set-device').value = s.deviceId;
  $('set-units').value = s.units;
  $('set-refresh').value = s.refreshSec;
  $('set-gust').value = s.windGustAlert;
  $('set-nearby-radius').value = s.nearbyRadius ?? 0;
  $('set-desk-radar').checked = !!s.deskRadar;
  $('set-eco').value = s.eco || 'auto';
  $('set-storm-auto').checked = !!s.stormAuto;
  $('set-theme').value = s.theme || 'dark';
  $('set-accent').value = s.accent || '#4fb8ff';
  $('set-font').value = String(s.fontScale || 1);
  $('set-density').value = s.density || 'normal';
  $('set-big-numbers').checked = !!s.bigNumbers;
  $('set-kiosk').value = s.kioskCycleSec || 0;
  $('set-night-dim').checked = !!s.nightDim;
  $('set-ntfy-topic').value = s.ntfyTopic || '';
  $('set-ntfy-url').value = s.ntfyUrl || '';
  $('set-webhook').value = s.webhookUrl || '';
  renderRules();
  $('set-mqtt-url').value = s.mqttUrl;
  $('set-mqtt-user').value = s.mqttUser;
  $('set-mqtt-pass').value = s.mqttPass;
  $('set-ha-url').value = s.haUrl;
  $('set-ha-token').value = s.haToken;
  $('set-ha-entities').value = s.haEntities;
  document.querySelectorAll('#tab-toggles input').forEach((c) => {
    c.checked = !(s.hiddenTabs || []).includes(c.dataset.tab);
  });
  renderHiddenPanels();
  renderStations();
  fillSites();
}

// Panels are hidden from their own grip; this is the only way back, so it lists them by id —
// short enough to recognise, and no second name to keep in sync with the markup.
function renderHiddenPanels() {
  const ids = hiddenPanels();
  $('hidden-list').innerHTML = ids.length
    ? ids.map((id, i) => `<button class="place-hit" data-hidden="${i}" style="flex:0 0 auto"></button>`).join('')
    : '<div class="muted" style="font-size:12px">No hidden panels</div>';
  $('hidden-list').querySelectorAll('[data-hidden]').forEach((b) => {
    b.textContent = `${ids[+b.dataset.hidden]} ×`;
    b.onclick = () => { unhide(ids[+b.dataset.hidden]); renderHiddenPanels(); };
  });
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
$('btn-close').onclick = () => { openDrawer(false); loadDeskRadar(); };
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
    nearbyRadius: +$('set-nearby-radius').value || 0,
    deskRadar: $('set-desk-radar').checked,
    eco: $('set-eco').value,
    stormAuto: $('set-storm-auto').checked,
    theme: $('set-theme').value,
    // The picker cannot express "no accent", so the default colour means the default.
    accent: $('set-accent').value === '#4fb8ff' ? '' : $('set-accent').value,
    fontScale: +$('set-font').value || 1,
    density: $('set-density').value,
    bigNumbers: $('set-big-numbers').checked,
    kioskCycleSec: +$('set-kiosk').value || 0,
    nightDim: $('set-night-dim').checked,
    ntfyTopic: $('set-ntfy-topic').value.trim(),
    ntfyUrl: $('set-ntfy-url').value.trim() || 'https://ntfy.sh',
    webhookUrl: $('set-webhook').value.trim(),
    mqttUrl: $('set-mqtt-url').value.trim(),
    mqttUser: $('set-mqtt-user').value.trim(),
    mqttPass: $('set-mqtt-pass').value,
    haUrl: $('set-ha-url').value.trim(),
    haToken: $('set-ha-token').value.trim(),
    haEntities: $('set-ha-entities').value.trim(),
    hiddenTabs: [...document.querySelectorAll('#tab-toggles input')].filter((c) => !c.checked).map((c) => c.dataset.tab),
  });
  applyTabs();
  initKiosk();
  if (!configured()) {
    notify({
      title: 'Setup incomplete',
      body: 'Token + station ID are needed for forecasts. Desktop with a Tempest hub on the LAN still shows live local data.',
    });
  }
  await hydrateStation();
  pushConfig();
  openDrawer(false);
  // Point the radars at whatever the settings now say (a changed site, or a first station fix).
  for (const id of ['desk-radar-frame', 'lab-frame']) {
    if ($(id).src) $(id).src = radarUrl(id === 'lab-frame' ? 8 : 6.5, id !== 'lab-frame');
  }
  loadDeskRadar();
  initDesk(); // idempotent: every() replaces existing jobs
  initIntel(); initSignals(); initBoards(); initAlmanac(); initEnv(); initPro(); initLayout(); initUdp(); initHome();
};

// station meta fills name/lat/lon and the Tempest device id when blank
async function hydrateStation() {
  if (!configured()) return;
  try {
    const j = await api.station();
    const st = j.stations?.[0];
    // A valid token for the wrong account answers 200 with an empty list, and the old silent
    // return left the whole dashboard blank with nothing to go on.
    if (!st) {
      notify({
        title: 'Station lookup failed',
        body: `Token works but has no access to station ${settings().stationId}. `
          + 'The station ID is the number in your tempestwx.com station URL.',
      });
      return;
    }
    const tempest = st.devices?.find((d) => d.device_type === 'ST') || st.devices?.find((d) => d.device_type === 'AR');
    // history API wants the numeric device_id; a pasted serial (ST-00176465) won't work — and
    // neither does a station ID pasted in the device box, which is numeric and used to sail
    // through this guard and 404 every history call in silence.
    const entered = settings().deviceId;
    const known = (st.devices || []).map((d) => String(d.device_id));
    let numeric = tempest ? String(tempest.device_id) : '';
    if (/^\d+$/.test(entered) && known.includes(entered)) numeric = entered;
    else if (/^\d+$/.test(entered) && entered !== numeric) {
      notify({ title: 'Device ID corrected', body: `${entered} isn't a device on this station — using ${numeric || 'none'}.` });
    }
    saveSettings({
      stationName: st.name,
      lat: st.latitude, lon: st.longitude,
      deviceId: numeric,
    });
    fillDrawer();
    renderPlaces();
    renderStations();
  } catch (e) {
    notify({ title: 'Station lookup failed', body: e.message });
  }
}

// --- first run ---
//
// The old first run opened the whole settings drawer at someone who had not yet decided to care.
// This asks for one thing, then lists the stations the token can actually see — which is also
// the fastest way to find out the token is wrong.
async function wizardFind() {
  const token = $('wiz-token').value.trim();
  if (!token) return;
  $('wiz-list').innerHTML = '<div class="muted">looking…</div>';
  // Saved first: api.station() reads the token out of settings, and a token that turns out to
  // be wrong is corrected in the same field a moment later.
  saveSettings({ token });
  try {
    const list = (await api.stations()).stations || [];
    if (!list.length) throw new Error('That token works but reaches no stations.');
    $('wiz-list').innerHTML = list
      .map((st, i) => `<button class="place-hit" data-wiz="${i}">${st.name} · ${st.location_item?.[0]?.name || st.station_id}</button>`)
      .join('');
    $('wiz-list').querySelectorAll('[data-wiz]').forEach((b) => {
      b.onclick = async () => {
        const st = list[+b.dataset.wiz];
        saveSettings({ stationId: String(st.station_id) });
        $('wizard').hidden = true;
        await hydrateStation();
        refreshAll();
        for (const el of ['tenday', 'alerts', 'story', 'agree-verdict', 'changes', 'verify']) {
          const node = $(el);
          if (node && node.textContent.includes('Needs a Tempest token')) node.innerHTML = '<div class="muted">loading…</div>';
        }
      };
    });
  } catch (e) {
    $('wiz-list').innerHTML = `<div class="fail">${e.message}</div>`;
  }
}

$('btn-wiz-find').onclick = () => wizardFind();
$('wiz-token').onkeydown = (e) => { if (e.key === 'Enter') wizardFind(); };
$('btn-wiz-close').onclick = () => { $('wizard').hidden = true; };
$('btn-wiz-demo').onclick = () => {
  // Demo mode is not a fixture: it is the real dashboard on the keyless sources, pointed at
  // whatever place the user searches for. Everything Tempest stays empty and says so.
  $('wizard').hidden = true;
  document.querySelector('.tab[data-section="signals"]')?.click();
  fillDrawer();
  openDrawer(true);
  $('place-q').focus();
  notify({ title: 'Demo mode', body: 'Search a city in Settings — forecasts, models and alerts work without a station.' });
};

// --- what's new ---
//
// A dashboard that gains a feature nobody notices has not gained a feature.
const APP_VERSION = '2.0.0';
function changelog() {
  // Raw string, not store(): this is compared to a literal, and a JSON-quoted one never matches.
  const seen = localStorage.getItem('wd.lastVersion');
  if (seen === APP_VERSION) return;
  try { localStorage.setItem('wd.lastVersion', APP_VERSION); } catch { /* full; nothing to do */ }
  if (!seen) return; // a fresh install has nothing to be new since
  notify({
    title: `WeatherDesk ${APP_VERSION}`,
    body: 'New: eco mode, observation log + almanac, custom alert rules with phone push, themes, '
      + 'kiosk cycling, sun/moon and garden cards, station health, and a read-only /public page.',
  });
}

// --- saved stations ---
//
// One token usually reaches several stations (a second house, a parent's Tempest, the club's).
// Switching swaps the four identity fields and refetches; everything else — units, layout,
// rules, broker — is the user's and stays put.
function renderStations() {
  const list = settings().savedStations || [];
  const sel = $('station-switch');
  sel.hidden = list.length < 2;
  sel.innerHTML = list.map((s, i) => `<option value="${i}">${s.name || s.id}</option>`).join('');
  const at = list.findIndex((s) => String(s.id) === String(settings().stationId));
  if (at >= 0) sel.value = String(at);

  $('station-list').innerHTML = list.length
    ? list.map((s, i) => `<div class="row" style="margin:0">
        <span class="place-hit" style="flex:1">${s.name || s.id}</span>
        <button class="sig-x" data-station="${i}">×</button></div>`).join('')
    : '<div class="muted" style="font-size:12px">No saved stations</div>';
  $('station-list').querySelectorAll('[data-station]').forEach((b) => {
    b.onclick = () => {
      const next = [...(settings().savedStations || [])];
      next.splice(+b.dataset.station, 1);
      saveSettings({ savedStations: next });
      renderStations();
    };
  });
}

async function switchStation(s) {
  saveSettings({ stationId: String(s.id), deviceId: s.deviceId || '', lat: s.lat, lon: s.lon, stationName: s.name });
  // The radar camera belongs to the station we just left.
  store('wd.radar', null);
  await hydrateStation();
  refreshAll();
}

$('station-switch').onchange = (e) => {
  const s = (settings().savedStations || [])[+e.target.value];
  if (s) switchStation(s);
};

$('btn-station-save').onclick = () => {
  const s = settings();
  if (!s.stationId) return;
  const list = (s.savedStations || []).filter((x) => String(x.id) !== String(s.stationId));
  list.push({ id: String(s.stationId), name: s.stationName || s.stationId, deviceId: s.deviceId, lat: s.lat, lon: s.lon });
  saveSettings({ savedStations: list });
  renderStations();
};

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

// --- backup / restore / raw history ---

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('btn-export').onclick = () => {
  // The export is the whole settings blob, and that includes the Tempest API token and any
  // broker password. Anyone the file is sent to can read the station. Say so before writing it.
  if (!confirm('This file contains your Tempest API token and any MQTT/Home Assistant passwords in plain text. Keep it private?')) return;
  download('weatherdesk-settings.json',
    new Blob([JSON.stringify({ at: Date.now(), settings: settings(), layout: load('wd.layout', {}) }, null, 2)],
      { type: 'application/json' }));
};

$('btn-import').onclick = () => $('import-file').click();

$('import-file').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // same file twice should still fire
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    // Merged, not replaced: a backup from an older version is missing every key added since,
    // and saveSettings over DEFAULTS is what fills those in.
    if (j.settings) saveSettings(j.settings);
    if (j.layout) restore(j.layout);
    fillDrawer();
    notify({ title: 'Settings imported', body: 'Reloading to apply.' });
    pushConfig();
    setTimeout(() => location.reload(), 800);
  } catch (err) {
    notify({ title: 'Import failed', body: err.message });
  }
};

$('btn-csv').onclick = async () => {
  try {
    const r = await fetch(`${SRV}/history.csv`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${r.status}`);
    download('weatherdesk-history.csv', await r.blob());
  } catch {
    notify({
      title: 'No observation log',
      body: 'The raw history is kept by the desktop app on the machine that hears the hub.',
    });
  }
};

$('btn-diag').onclick = async () => {
  $('diag').innerHTML = '<div class="muted">running…</div>';
  // Viewport first, because it is the one number that explains a dashboard drawn at the wrong
  // size: WebKitGTK on Wayland sometimes hands the page a viewport that doesn't match the window
  // it lives in, and there is otherwise no way to tell that from the inside.
  const view = `${window.innerWidth}×${window.innerHeight} @ ${window.devicePixelRatio}× DPR`;
  const rows = await api.diagnostics();
  $('diag').innerHTML = `<div><span>Viewport</span><span class="ok">${view}</span></div>`
    + rows.map((r) =>
    `<div><span>${r.name}</span><span class="${r.ok ? 'ok' : 'fail'}">${r.ok ? '✓ ' : '✗ '}${r.detail}</span></div>`
  ).join('');
};

window.addEventListener('wd:refresh', () => {
  refreshDesk().catch(() => {}); // refreshDesk owns the failure toast
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

// Storm mode: the one time the radar is worth its cost on a weak box is when a warning is out,
// and that is exactly when nobody is going to be at the machine to switch it on. Restores the
// user's own setting when the warning expires — a Desk that stayed changed after the storm
// would be the app deciding what the dashboard looks like.
let stormShowedRadar = false;
window.addEventListener('wd:storm', (e) => {
  if (!settings().stormAuto) return;
  const panel = $('desk-radar');
  if (!panel) return;
  if (e.detail && panel.hidden) {
    stormShowedRadar = true;
    saveSettings({ deskRadar: true });
    loadDeskRadar();
    panel.scrollIntoView({ block: 'nearest' });
  } else if (!e.detail && stormShowedRadar) {
    stormShowedRadar = false;
    saveSettings({ deskRadar: false });
    loadDeskRadar();
  }
});

// lazy-load the Lab iframe on first visit — full chrome there, it is the roomier view
window.addEventListener('wd:section', (e) => {
  const f = $('lab-frame');
  if (e.detail !== 'lab' || f.src) return;
  f.src = radarUrl(8);
});

// Inline radar strip on the Desk: embedded, so it holds one frame a minute until touched. A live
// radar loop otherwise costs the desktop app's WebKit webview a whole core.
//
// Loaded late, and never at boot. On Linux the iframe shares one WebKitWebProcess with the whole
// Desk, and the viewer is megabytes of wasm: on a weak iGPU (a Chromebook, Intel UHD 600) starting
// it with the page ate the same process the Settings drawer lives in — the window painted and then
// accepted no input at all, so the token could never be typed in. Wait for setup to be done, for
// the panel to actually be on screen, and for the main thread to go idle.
function loadDeskRadar() {
  const panel = $('desk-radar'), f = $('desk-radar-frame');
  if (!panel) return;
  // Off is off: hide the panel, and drop the document — a hidden iframe still runs its wasm.
  panel.hidden = !settings().deskRadar;
  if (panel.hidden) {
    if (f.src) { f.src = 'about:blank'; f.removeAttribute('src'); }
    loadDeskRadar.armed = false;
    return;
  }
  if (f.src || loadDeskRadar.armed) return;
  // First run: the drawer is open and typing the token matters more than the map. Closing the
  // drawer (by saving, or by hand — a hub-only install has no token to type) calls back here.
  if ($('drawer').classList.contains('open') || !$('wizard').hidden) return;
  loadDeskRadar.armed = true;

  const start = () => {
    if (!f.src) f.src = radarUrl(6.5);
    panel.classList.add('loaded');
  };
  const whenIdle = () => (window.requestIdleCallback
    ? requestIdleCallback(start, { timeout: 3000 })
    : setTimeout(start, 1200));
  // ponytail: visibility is the only gate. A panel dragged off screen and back re-arms nothing —
  // it has loaded by then — and a Desk that never scrolls past the radar never pays for it.
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    whenIdle();
  }, { rootMargin: '200px' });
  io.observe(panel);
}

await pullConfig();

// A viewer cannot open the drawer, so a viewer cannot see or change anything the owner set. The
// token is not in this page to begin with — the server never sent it.
if (PUBLIC) {
  document.body.classList.add('public');
  $('btn-settings').hidden = true;
  // Hidden, not removed: loadDeskRadar and the drawer helpers all reach for these nodes, and a
  // public page is not the place to find out which ones. The fields are empty anyway — the
  // server redacted every credential before it sent the config.
  $('drawer').hidden = true;
  $('btn-save').disabled = true;
}

applyEco();
initKiosk();
initRules();
initNav();

// --- keyboard ---
//
// A dashboard on a desk gets a keyboard, and the tabs are the only thing anyone reaches for.
// Never while typing: the token field is one keystroke from being a tab switch otherwise.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
    if (e.key === 'Escape') el.blur();
    return;
  }
  if (e.key >= '1' && e.key <= '9') {
    const tabs = [...document.querySelectorAll('.tab')].filter((t) => t.style.display !== 'none');
    tabs[+e.key - 1]?.click();
    return;
  }
  if (e.key === 'Escape') { openDrawer(false); $('shortcuts').hidden = true; loadDeskRadar(); return; }
  if (e.key === '?') { $('shortcuts').hidden = !$('shortcuts').hidden; return; }
  if (e.key === 'f') fullscreen();
  else if (e.key === 'r') refreshAll();
  else if (e.key === 's' && !PUBLIC) { fillDrawer(); openDrawer(true); }
});
initPlaces();
// panel chrome doesn't depend on a token — wire it before the data path so an unconfigured
// dashboard is still arrangeable
initLayout();
applyLock();
renderLayouts();

changelog();

if (!configured() && !PUBLIC) {
  $('wizard').hidden = false;
  $('wiz-token').focus();
  // UDP-only mode: a desktop install with a hub on the LAN has real local data with no token at
  // all, so the modules start either way. Every refresh job early-returns without a token, so an
  // unconfigured init is a handful of no-ops.
  for (const id of ['tenday', 'alerts', 'story', 'agree-verdict', 'changes', 'verify']) {
    const el = $(id);
    if (el) el.innerHTML = '<div class="muted">Needs a Tempest token — open ⚙ Settings</div>';
  }
}
// lat/lon must land before the open-meteo/NWS jobs start (resolves immediately when unconfigured)
hydrateStation().then(() => {
  loadDeskRadar();
  initDesk(); initIntel(); initSignals(); initBoards(); initAlmanac(); initEnv(); initPro(); initUdp(); initHome();
});

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
