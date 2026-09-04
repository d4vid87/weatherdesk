// Wire the shell: settings drawer, diagnostics, nav, section modules.
import { settings, saveSettings, configured, hasSource, hasLocation, initNav, applyTabs, fullscreen, holdScreen, refreshAll, notify, load, store, applyEco, ecoOn, initKiosk, expires, num, U, msToWind, windToMs, setServerAlerts, alertsAreServerSide, every, clearJob } from './app.js';
import * as api from './api.js';
import { motionLevel } from './motion.js';
import { initDesk, refreshDesk, refreshObs, refreshAlerts, refreshAqi } from './desk.js';
import { initIntel, refreshModels, refreshNowcast } from './intel.js';
import { initSignals, refreshSignals } from './signals.js';
import { initBoards } from './boards.js';
import { initAlmanac } from './almanac.js';
import { initRules, renderRules } from './rules.js';
import { initEnv } from './env.js';
import { initPlaces, renderPlaces } from './places.js';
import { initPro } from './pro.js';
import { initLayout, snapshot, restore, hiddenPanels, unhide, panelIds, tabOf, setTab, TABS, NEVER_HIDE } from './layout.js';
import { initUdp } from './udp.js';
import { initHome } from './home.js';
import { initOutlook } from './outlook.js';
import { initDetail } from './detail.js';
import { applyMotion } from './motion.js';

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

let rev = null;

async function pullConfig() {
  syncing = true;
  try {
    const r = await fetch(`${SRV}/${PUBLIC ? 'config-public' : 'config'}`, { signal: expires(2000) });
    if (!r.ok) return;
    const j = await r.json();
    if (typeof j._rev === 'number') rev = j._rev;
    if (j.settings) saveSettings(j.settings);
    if (j.layout) restore(j.layout);
  } catch {
    // no config server (static host, or app not running) — nothing to sync
  } finally {
    syncing = false;
  }
}

// Server wins on load; on save this screen sends what it holds tagged with the revision it last
// saw, and the server merges it and hands the result back. Whole-blob writes still work (that is
// what a v2 client does), but tagging keeps a key only another screen knows about from being
// dropped by this one.

// A screen that has never heard back from the server has nothing to tell it. Before this, a
// tablet whose pull failed kept its blank defaults and then pushed them — and the host's token
// and station were gone, replaced by the empty strings of a browser that had just been opened.
export function mayPush(pulled = rev !== null) {
  return pulled || configured() || !!settings().stationSource;
}

// Returns the write, so a caller that needs the server to have the new settings before it asks
// the server anything (the Home Assistant test button) can wait for it.
function pushConfig() {
  if (syncing || PUBLIC || !mayPush()) return Promise.resolve();
  return fetch(`${SRV}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _rev: rev ?? 0, at: Date.now(), settings: settings(), layout: load('wd.layout', {}) }),
  }).then((r) => (r.ok && r.status === 200 ? r.json() : null))
    .then((j) => { if (typeof j?._rev === 'number') rev = j._rev; })
    .catch(() => {});
}

let pushTimer;
// A layout event raised while a pull is applying is the server's own layout coming back, not an
// edit — scheduling a push for it is how this screen used to answer every broadcast with a write.
window.addEventListener('wd:layout', () => {
  if (syncing) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushConfig, 2000);
});

// Someone changed a setting on another screen. Before this, a tablet kept showing yesterday's
// units until it was reloaded by hand.
//
// Not our own write, though: the server broadcasts every revision, including the one this screen
// just PUT. Pulling that back calls restore(), restore() dispatches wd:layout, and the debounced
// push sends it again — a loop that bumped the revision once a second and held the webview at a
// full core. A missing rev (older server) still pulls, as it always did.
export function shouldPull(evRev) {
  return typeof evRev !== 'number' || evRev !== rev;
}
window.addEventListener('wd:config-rev', (e) => { if (shouldPull(e.detail?.rev)) pullConfig(); });


// Where a console is told to report. Same origin as this page, because a console on the LAN
// reaches this server the same way the browser just did — and an ingest key, if one is set, has
// to ride in the path: a Wittboy can be given a path and nothing else.
export function ingestUrl(key = settings().ingestKey) {
  // The app window runs on tauri://localhost, which nothing on the LAN can reach; the desktop
  // build injects the real server URL, and a browser install is already on it.
  return `${window.__WD_SRV || location.origin}/ingest${key ? `/${key}` : ''}`;
}

// The Android build has no LAN server behind it — `__TAURI__` without `__WD_SRV` — so there is
// no address a WS-2902 console could ever upload to. Saying "point the console at
// tauri://localhost" is how two people spent an evening trying.
export const canIngest = (env = window) => !(env.__TAURI__ && env.__WD_SRV === undefined);

// Only the fields the chosen brand needs. The push brands need none at all, which is the point
// of showing them the address instead.
function showSourceFields() {
  const v = $('set-source').value;
  const push = ['ecowitt', 'ambient', 'wu', 'rtl433'].includes(v);
  $('src-push').hidden = !push;
  $('src-wll').hidden = v !== 'wll';
  $('src-awn').hidden = v !== 'awn';
  $('src-lax').hidden = v !== 'lacrosse';
  $('src-nopush').hidden = !(push && !canIngest());
  if (push) $('src-url').value = canIngest() ? ingestUrl($('set-ingest-key').value.trim()) : '';
}

// Blank means "no override" — a null, not a zero. Zero is a real elevation at the coast.
function elevMetres() {
  const raw = $('set-elev').value.trim();
  if (!raw) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return settings().units === 'metric' ? v : v * 0.3048;
}

function fillDrawer() {
  const s = settings();
  $('set-token').value = s.token;
  $('set-station').value = s.stationId;
  $('set-device').value = s.deviceId;
  $('set-units').value = s.units;
  $('set-clock').value = s.clock24 || 'auto';
  $('set-refresh').value = s.refreshSec;
  $('set-gust').value = s.windGustAlert;
  $('set-wind-unit').value = s.windUnit || '';
  // The threshold is a bare number in whatever wind unit is showing, so name that unit next to
  // it — 30 means something different in knots.
  $('gust-unit').textContent = U.wind();
  $('set-nearby-radius').value = s.nearbyRadius ?? 0;
  $('set-desk-radar').checked = !!s.deskRadar;
  $('set-eco').value = s.eco || 'auto';
  $('set-motion').value = s.motion || 'auto';
  $('set-render').value = s.render || 'auto';
  $('set-retention').value = String(s.retentionYears || 0);
  $('set-storm-auto').checked = !!s.stormAuto;
  $('set-theme').value = s.theme || 'dark';
  $('set-accent').value = s.accent || '#4fb8ff';
  $('set-font').value = String(s.fontScale || 1);
  $('set-density').value = s.density || 'normal';
  $('set-big-numbers').checked = !!s.bigNumbers;
  $('set-kiosk').value = s.kioskCycleSec || 0;
  $('set-night-dim').checked = !!s.nightDim;
  $('set-speak').checked = !!s.speakAlerts;
  $('set-brief-time').value = s.briefTime || '';
  $('set-web-notif').checked = !!s.webNotif;
  $('set-palette').value = s.palette || '';
  $('set-quiet-start').value = s.quietStart || '';
  $('set-quiet-end').value = s.quietEnd || '';
  $('set-http-port').value = s.httpPort || '';
  $('set-cwop').value = s.cwopId || '';
  $('set-wu-id').value = s.wuId || '';
  $('set-wu-key').value = s.wuKey || '';
  $('set-pws-id').value = s.pwsId || '';
  $('set-pws-key').value = s.pwsKey || '';
  // Stored in metres; shown in whatever the rest of the app is speaking.
  const feet = s.units !== 'metric';
  $('set-elev-unit').textContent = feet ? '(ft)' : '(m)';
  $('set-elev').value = s.elevationM == null ? ''
    : String(Math.round(feet ? s.elevationM / 0.3048 : s.elevationM));
  $('set-source').value = s.stationSource || '';
  $('set-wll').value = s.wllHost || '';
  $('set-awn-api').value = s.awnApiKey || '';
  $('set-awn-app').value = s.awnAppKey || '';
  $('set-lax-email').value = s.lacrosseEmail || '';
  $('set-lax-pass').value = s.lacrossePass || '';
  $('set-ingest-key').value = s.ingestKey || '';
  showSourceFields();
  $('set-ntfy-topic').value = s.ntfyTopic || '';
  $('set-ntfy-url').value = s.ntfyUrl || '';
  $('set-webhook').value = s.webhookUrl || '';
  renderRules();
  $('set-mqtt-url').value = s.mqttUrl;
  $('set-ha-prefix').value = s.haDiscoveryPrefix || '';
  $('set-mqtt-user').value = s.mqttUser;
  $('set-mqtt-pass').value = s.mqttPass;
  $('set-mqtt-subs').value = (s.mqttSubs || []).map((x) => [x.topic, x.label, x.unit].filter(Boolean).join(' | ')).join('\n');
  $('set-ha-url').value = s.haUrl;
  $('set-ha-token').value = s.haToken;
  $('set-ha-entities').value = s.haEntities;
  document.querySelectorAll('#tab-toggles input').forEach((c) => {
    c.checked = !(s.hiddenTabs || []).includes(c.dataset.tab);
  });
  renderHiddenPanels();
  renderCatalog();
  renderStations();
  fillSites();
  $('app-version').textContent = APP_VERSION ? `v${APP_VERSION}` : '';
  renderDiag();
}

// What each station source last did. A snapshot each time the drawer opens is enough — this is
// read by someone who is already looking at it, or screenshotting it into a bug report.
function renderDiag() {
  const el = $('ingest-diag');
  if (!el) return;
  api.getJSON(`${SRV}/diag`)
    .then((d) => {
      const rows = Object.entries(d).map(([src, v]) => {
        const ago = Math.max(0, Math.round(Date.now() / 1000 - v.at));
        return `<div>${src} · ${v.rows} rows · ${v.ok ? '' : 'error: '}${v.what} · ${ago}s ago</div>`;
      });
      // One archive, one timeline: two consoles reporting without an ingest key interleave
      // their rows and the trends read as noise. The real fix is per-station rows (3.3.0).
      const writing = Object.values(d).filter((v) => v.rows > 0).length;
      if (writing > 1) rows.push('<div class="warn">two stations are reporting here — their rows '
        + 'interleave into one archive. Set an ingest key so only yours is stored.</div>');
      el.innerHTML = rows.join('') || 'No station has reported here yet.';
    })
    .catch(() => { el.innerHTML = ''; });
}

// Does this install have a server running the alert engine? Asked here rather than in app.js
// because /diag is a LAN-server route and app.js has no idea whether it is talking to one.
async function probeServerAlerts() {
  try {
    const d = await api.getJSON(`${SRV}/diag`);
    setServerAlerts(!!d.alerts?.ok);
  } catch {
    setServerAlerts(false);
  }
  const el = $('rule-server');
  if (el) {
    el.textContent = alertsAreServerSide()
      ? 'The server is evaluating these rules and sending the pushes, so they keep working with every window closed.'
      : 'These rules are evaluated by this page, so they only fire while it is open. The desktop app and the Docker image evaluate them on the server instead.';
  }
}

// The banner test above exercises the page's own pipe. This one asks the server to send a real
// notification down every channel that is configured — the credentials never leave it, and what
// arrives on the phone took exactly the path a 3am wind warning will take.
$('btn-alert-test').onclick = async () => {
  const out = $('alert-test-out');
  out.textContent = 'sending…';
  try {
    const r = await (await fetch(`${SRV}/alerts/test`, { signal: expires(30000) })).json();
    out.textContent = r.sent
      ? `sent to ${r.channels.join(', ')} — check the phone`
      : 'nothing to send to: set an ntfy topic, a webhook or a broker above';
  } catch {
    out.textContent = 'this build has no server to send from — the page pushes while it is open';
  }
};

// The entity picker. Home Assistant ids are typed by hand today, which means a typo shows up
// three days later as a row that says 404 — and it means opening Home Assistant in another tab
// to go and read them. The list comes from the server, which is the only thing here holding a
// token that can ask for it.
//
// Read-only, deliberately: this picks what to display. Turning things on and off is Home
// Assistant's job, and the moment a dashboard on a LAN with no auth can switch a socket, the
// LAN-trust model this app documents stops being defensible.
let haEntities = null;

function renderHaPick() {
  const box = $('ha-pick-list');
  if (!haEntities) return;
  const q = $('ha-pick-q').value.trim().toLowerCase();
  const chosen = new Set($('set-ha-entities').value.split(/[\s,]+/).filter(Boolean));
  const hits = haEntities
    .filter((e) => !q || e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
    .slice(0, 200);
  box.innerHTML = hits.length
    ? hits.map((e, i) => `<label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0">
        <input type="checkbox" data-ent="${i}"${chosen.has(e.id) ? ' checked' : ''}>
        <span style="flex:1"></span><span class="muted"></span></label>`).join('')
    : '<div class="muted" style="font-size:12px">nothing matches</div>';
  // Names and states are Home Assistant's text, not ours: written in, never interpolated into
  // markup.
  box.querySelectorAll('[data-ent]').forEach((cb) => {
    const e = hits[+cb.dataset.ent];
    const [name, state] = cb.parentElement.querySelectorAll('span');
    name.textContent = `${e.name} · ${e.id}`;
    state.textContent = `${e.state}${e.unit ? ` ${e.unit}` : ''}`;
    cb.onchange = () => {
      const set = new Set($('set-ha-entities').value.split(/[\s,]+/).filter(Boolean));
      if (cb.checked) set.add(e.id); else set.delete(e.id);
      $('set-ha-entities').value = [...set].join(', ');
    };
  });
}

$('btn-ha-pick').onclick = async () => {
  const box = $('ha-pick-list');
  box.innerHTML = '<div class="muted" style="font-size:12px">asking Home Assistant…</div>';
  // The URL and token have to be on disk before the server can use them.
  saveSettings({ haUrl: $('set-ha-url').value.trim(), haToken: $('set-ha-token').value.trim() });
  await pushConfig();
  try {
    const j = await (await fetch(`${SRV}/ha/states`, { signal: expires(30000) })).json();
    if (j.error) { box.innerHTML = `<div class="fail" style="font-size:12px">${j.error}</div>`; return; }
    haEntities = j.entities;
    renderHaPick();
  } catch {
    box.innerHTML = '<div class="muted" style="font-size:12px">this build has no server to ask — '
      + 'type the ids from Home Assistant\'s own developer tools</div>';
  }
};
$('ha-pick-q').oninput = renderHaPick;

// A panel's own heading, so the lists read the way the page does. Falls back to the id for a
// panel that has no heading — better than a blank button.
function panelTitle(id) {
  const el = document.querySelector(`[data-panel="${id}"]`);
  return el?.querySelector('h1,h2,h3')?.textContent.trim() || id;
}

// Panels are hidden from their own grip, and this is the only way back — people who close one by
// accident have to be able to find it, so it lives under its own heading and names the panel.
function renderHiddenPanels() {
  const ids = hiddenPanels();
  $('hidden-list').innerHTML = ids.length
    ? ids.map((id, i) => `<button class="place-hit" data-hidden="${i}" style="flex:0 0 auto"></button>`).join('')
    : '<div class="muted" style="font-size:12px">No hidden panels</div>';
  $('hidden-list').querySelectorAll('[data-hidden]').forEach((b) => {
    b.textContent = `${panelTitle(ids[+b.dataset.hidden])} ×`;
    b.onclick = () => { unhide(ids[+b.dataset.hidden]); renderHiddenPanels(); };
  });
}

// One row per panel: its heading and the tab it lives on.
function renderCatalog() {
  const el = $('panel-catalog');
  if (!el) return;
  const opts = Object.keys(TABS).map((t) => `<option value="${t}">${t}</option>`).join('');
  el.innerHTML = panelIds().map((id) => `<div class="row" style="margin:4px 0">
      <span class="place-hit" style="flex:1" data-name="${id}"></span>
      <select data-panel-tab="${id}" style="flex:0 0 110px">${opts}</select>
    </div>`).join('');
  el.querySelectorAll('[data-name]').forEach((s) => { s.textContent = panelTitle(s.dataset.name); });
  el.querySelectorAll('[data-panel-tab]').forEach((sel) => {
    sel.value = tabOf(sel.dataset.panelTab);
    sel.onchange = () => setTab(sel.dataset.panelTab, sel.value);
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

// The drawer is a dialog in everything but element name: it takes focus when it opens, gives it
// back when it closes, and Escape shuts it. Without that, a keyboard user tabbed straight past
// it into the page behind.
let drawerReturn = null;
const openDrawer = (open) => {
  const el = $('drawer');
  el.classList.toggle('open', open);
  el.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) {
    drawerReturn = document.activeElement;
    el.querySelector('input, select, button')?.focus();
  } else {
    drawerReturn?.focus?.();
    drawerReturn = null;
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('drawer').classList.contains('open')) openDrawer(false);
});

$('btn-settings').onclick = () => { fillDrawer(); openDrawer(true); };
$('set-source').onchange = showSourceFields;
$('set-ingest-key').oninput = showSourceFields;
$('btn-close').onclick = () => { openDrawer(false); loadDeskRadar(); };
// A preset is two dropdowns someone would otherwise have to know to change together. It only
// fills the fields — Save is still Save.
const REGIONS = {
  US: ['imperial', '12'], UK: ['metric', '24'], EU: ['metric', '24'],
  CA: ['metric', '12'], AU: ['metric', '12'],
};
$('region-presets').onclick = (e) => {
  const r = REGIONS[e.target.dataset.region];
  if (!r) return;
  [$('set-units').value, $('set-clock').value] = r;
};

// The permission prompt has to come off a click, and Save is the only click there is.
$('set-web-notif').onchange = (e) => {
  if (e.target.checked && window.Notification?.permission === 'default') Notification.requestPermission().catch(() => {});
};

$('btn-full').onclick = fullscreen;
$('btn-refresh').onclick = refreshAll;

$('btn-save').onclick = async () => {
  // Retention deletes readings for good and there is no undo, so a shorter window is confirmed
  // once, here, rather than discovered as a hole in the archive.
  const keep = +$('set-retention').value || 0;
  const kept = +settings().retentionYears || 0;
  if (keep && (!kept || keep < kept)
      && !confirm(`Delete every reading older than ${keep} year${keep > 1 ? 's' : ''}? This cannot be undone.`)) {
    $('set-retention').value = String(kept);
    return;
  }
  // A new radar site means the saved camera belongs to the old one — drop it so the fresh
  // site-only link recenters.
  if ($('set-radar-site').value !== (settings().radarSite || '')) { radarView = null; store('wd.radar', null); }
  saveSettings({
    radarSite: $('set-radar-site').value,
    token: $('set-token').value.trim(),
    stationId: $('set-station').value.trim(),
    deviceId: $('set-device').value.trim(),
    units: $('set-units').value,
    clock24: $('set-clock').value,
    refreshSec: Math.min(3600, Math.max(5, +$('set-refresh').value || 60)),
    windGustAlert: +$('set-gust').value || 30,
    windUnit: $('set-wind-unit').value,
    nearbyRadius: +$('set-nearby-radius').value || 0,
    deskRadar: $('set-desk-radar').checked,
    eco: $('set-eco').value,
    motion: $('set-motion').value,
    render: $('set-render').value,
    retentionYears: +$('set-retention').value || 0,
    stormAuto: $('set-storm-auto').checked,
    theme: $('set-theme').value,
    // The picker cannot express "no accent", so the default colour means the default.
    accent: $('set-accent').value === '#4fb8ff' ? '' : $('set-accent').value,
    fontScale: +$('set-font').value || 1,
    density: $('set-density').value,
    bigNumbers: $('set-big-numbers').checked,
    kioskCycleSec: Math.max(0, Math.min(3600, +$('set-kiosk').value || 0)),
    nightDim: $('set-night-dim').checked,
    speakAlerts: $('set-speak').checked,
    briefTime: $('set-brief-time').value,
    webNotif: $('set-web-notif').checked,
    palette: $('set-palette').value,
    quietStart: $('set-quiet-start').value,
    quietEnd: $('set-quiet-end').value,
    httpPort: $('set-http-port').value.trim(),
    cwopId: $('set-cwop').value.trim().toUpperCase(),
    wuId: $('set-wu-id').value.trim(),
    wuKey: $('set-wu-key').value.trim(),
    pwsId: $('set-pws-id').value.trim(),
    pwsKey: $('set-pws-key').value.trim(),
    elevationM: elevMetres(),
    stationSource: $('set-source').value,
    // Switching to a non-Tempest brand: the old WeatherFlow device id, token and station id all
    // have to go with it, or the forecast and history keep asking WeatherFlow about a station
    // that isn't there (#37).
    ...($('set-source').value ? { deviceId: '', token: '', stationId: '' } : {}),
    wllHost: $('set-wll').value.trim(),
    awnApiKey: $('set-awn-api').value.trim(),
    awnAppKey: $('set-awn-app').value.trim(),
    lacrosseEmail: $('set-lax-email').value.trim(),
    lacrossePass: $('set-lax-pass').value,
    ingestKey: $('set-ingest-key').value.trim(),
    ntfyTopic: $('set-ntfy-topic').value.trim(),
    ntfyUrl: $('set-ntfy-url').value.trim() || 'https://ntfy.sh',
    webhookUrl: $('set-webhook').value.trim(),
    mqttUrl: $('set-mqtt-url').value.trim(),
    haDiscoveryPrefix: $('set-ha-prefix').value.trim(),
    mqttUser: $('set-mqtt-user').value.trim(),
    mqttPass: $('set-mqtt-pass').value,
    mqttSubs: $('set-mqtt-subs').value.split('\n').map((line) => {
      const [topic, label, unit] = line.split('|').map((x) => x.trim());
      return topic ? { topic, label: label || topic, unit: unit || '' } : null;
    }).filter(Boolean),
    haUrl: $('set-ha-url').value.trim(),
    haToken: $('set-ha-token').value.trim(),
    haEntities: $('set-ha-entities').value.trim(),
    hiddenTabs: [...document.querySelectorAll('#tab-toggles input')].filter((c) => !c.checked).map((c) => c.dataset.tab),
  });
  applyTabs();
  initKiosk();
  if (!hasSource()) {
    notify({
      title: 'Setup incomplete',
      body: 'A Tempest token + station ID, or another brand of station reporting to this server. '
        + 'Desktop with a hub on the LAN still shows live local data.',
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
  initIntel(); initSignals(); initBoards(); initAlmanac(); initEnv(); initPro(); initLayout(); initDetail(); initUdp(); initHome(); initOutlook();
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

// The wizard has always closed on a saved setting, which is not the same thing as a working
// station: a console pointed at the wrong address looks identical until the dashboard is empty.
// Wait for one real number instead, and say what it was.
async function firstReading(fetcher) {
  const out = $('wiz-first');
  out.className = 'muted';
  out.textContent = 'waiting for the first reading…';
  for (let i = 0; i < 15; i++) {
    try {
      const t = await fetcher();
      if (t != null) {
        out.className = 'ok';
        out.textContent = `${num(t, 1)}${U.temp()} received ✓`;
        setTimeout(() => { $('wizard').hidden = true; }, 1500);
        return;
      }
    } catch { /* the console may still be mid-upload; the loop is the retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  out.className = 'fail';
  out.textContent = 'no reading yet — the dashboard is open behind this; check the console is uploading to the address above';
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
        firstReading(async () => (await api.stationObs()).obs?.[0]?.air_temperature);
        await hydrateStation();
        refreshAll();
        for (const el of ['tenday', 'alerts', 'story', 'agree-verdict', 'changes', 'verify']) {
          const node = $(el);
          if (node && node.textContent.includes('Needs a station')) node.innerHTML = '<div class="muted">loading…</div>';
        }
      };
    });
  } catch (e) {
    $('wiz-list').innerHTML = `<div class="fail">${e.message}</div>`;
  }
}

// The other-brand route through the wizard: a brand and a place is everything a non-Tempest
// install needs — no token, no account, and the forecast comes from open-meteo.
{
  const sel = $('wiz-source');
  sel.innerHTML = $('set-source').innerHTML;
  const target = () => {
    const v = sel.value;
    $('wiz-wll').hidden = v !== 'wll';
    $('wiz-target').textContent = ['ecowitt', 'ambient', 'wu', 'rtl433'].includes(v)
      ? `Point the console at ${ingestUrl()}`
      : v ? 'Fill in the address or keys under ⚙ Settings once this is closed.' : '';
  };
  sel.onchange = target;
  const find = async () => {
    const q = $('wiz-place').value.trim();
    if (!q) return;
    $('wiz-place-list').innerHTML = '<div class="muted">looking…</div>';
    try {
      const hits = (await api.geocode(q)).features || [];
      $('wiz-place-list').innerHTML = hits
        .map((h, i) => `<button class="place-hit" data-hit="${i}">${api.placeLabel(h.properties)}</button>`)
        .join('') || '<div class="muted">no matches</div>';
      // The wizard box scrolls; results land below the fold and read as "the button did nothing".
      $('wiz-place-list').scrollIntoView({ block: 'nearest' });
      $('wiz-place-list').querySelectorAll('[data-hit]').forEach((b) => {
        b.onclick = () => {
          const h = hits[+b.dataset.hit];
          const [lon, lat] = h.geometry.coordinates;
          saveSettings({
            stationSource: sel.value || 'ecowitt', lat, lon,
            stationName: h.properties.city || h.properties.name || q,
            ...($('wiz-wll-host').value.trim() ? { wllHost: $('wiz-wll-host').value.trim() } : {}),
          });
          fillDrawer();
          firstReading(async () => (await api.localObs(1)).obs?.at(-1)?.[api.OBS.temp]);
          refreshAll();
          for (const el of ['tenday', 'alerts', 'story', 'agree-verdict', 'changes', 'verify']) {
            const node = $(el);
            if (node && node.textContent.includes('Needs a station')) node.innerHTML = '<div class="muted">loading…</div>';
          }
        };
      });
    } catch (e) {
      $('wiz-place-list').innerHTML = `<div class="fail">${e.message}</div>`;
    }
  };
  $('btn-wiz-wll').onclick = () => findWll($('wiz-wll-host'), $('wiz-target'));
  $('btn-wiz-place').onclick = find;
  $('wiz-place').onkeydown = (e) => { if (e.key === 'Enter') find(); };
  target();
}

// The console announces itself over mDNS, and the server is already listening for it — so the
// address nobody can find on a router page is one button away. Both the wizard and the settings
// drawer ask the same question, so they ask it through one function.
async function findWll(input, out) {
  out.textContent = 'looking…';
  try {
    const hits = await (await fetch(`${SRV}/discover/wll`, { signal: expires(6000) })).json();
    if (!hits.length) {
      out.textContent = 'nothing announced itself — type the address from the WeatherLink app';
      return;
    }
    input.value = hits[0].host;
    out.textContent = hits.length === 1 ? `found ${hits[0].name}` : `found ${hits.length}, using ${hits[0].name}`;
  } catch {
    out.textContent = 'this build has no server to ask — type the address instead';
  }
}
$('btn-find-wll').onclick = () => findWll($('set-wll'), $('wll-found'));

// Save first, then ask the server to try both for real: the credentials it tests are the ones
// on disk, and a password typed with a trailing space is otherwise a silent nothing found days
// later when an automation doesn't fire. The token never comes back to this page.
$('btn-ha-test').onclick = async () => {
  const out = $('ha-test-out');
  out.textContent = 'saving and testing…';
  // The server tests what is on disk, so these five boxes have to get there first. Save proper
  // would close the drawer, which is where the answer is about to appear.
  saveSettings({
    mqttUrl: $('set-mqtt-url').value.trim(),
    mqttUser: $('set-mqtt-user').value.trim(),
    mqttPass: $('set-mqtt-pass').value,
    haDiscoveryPrefix: $('set-ha-prefix').value.trim(),
    haUrl: $('set-ha-url').value.trim(),
    haToken: $('set-ha-token').value.trim(),
  });
  await pushConfig();
  try {
    const r = await (await fetch(`${SRV}/ha/test`, { signal: expires(30000) })).json();
    const line = (name, x) => `<div class="${x.ok ? 'ok' : 'fail'}">${name}: ${x.what}</div>`;
    out.innerHTML = line('broker', r.mqtt) + line('Home Assistant', r.ha);
  } catch {
    out.textContent = 'this build has no server to test with — publishing runs in the page instead';
  }
};

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
// The binary injects this (`server::ver_script`, and `gui.rs` for the desktop window) so there is
// one version in the build, not a literal here that goes stale the first release nobody edits it.
const APP_VERSION = window.__WD_VER || '';

// A dashboard on a wall is exactly the thing that should still draw its own shell when the wifi
// drops — desk.js already keeps the last forecast and obs, so all that was missing was the files.
// Not in the desktop or Android app (they ship their own assets), and not on a plain-http LAN
// origin, which cannot register one at all.
export function shouldRegisterSW(env = window) {
  return 'serviceWorker' in navigator && env.isSecureContext
    && !env.__TAURI__ && env.__WD_SRV === undefined;
}
if (location.search.includes('selftest')) {
  const env = (o) => ({ isSecureContext: true, __WD_SRV: undefined, ...o });
  console.assert(shouldRegisterSW(env({})), 'sw: https browser registers');
  console.assert(!shouldRegisterSW(env({ isSecureContext: false })), 'sw: plain-http LAN does not');
  console.assert(!shouldRegisterSW(env({ __TAURI__: {}, __WD_SRV: '' })), 'sw: desktop app does not');
  console.assert(!shouldRegisterSW(env({ __TAURI__: {} })), 'sw: the Android app does not either');
  console.assert(!shouldRegisterSW(env({ __WD_SRV: 'http://x' })), 'sw: a page served by the app does not');
  console.assert(canIngest(env({})), 'ingest: a browser is already on a reachable address');
  console.assert(canIngest(env({ __TAURI__: {}, __WD_SRV: 'http://x' })), 'ingest: the desktop app carries a LAN address');
  console.assert(!canIngest(env({ __TAURI__: {} })), 'ingest: the phone app has nowhere for a console to report');
}
if (shouldRegisterSW()) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
}
function changelog() {
  if (!APP_VERSION) return; // served from a static host: no version to be honest about
  // Raw string, not store(): this is compared to a literal, and a JSON-quoted one never matches.
  const seen = localStorage.getItem('wd.lastVersion');
  if (seen === APP_VERSION) return;
  try { localStorage.setItem('wd.lastVersion', APP_VERSION); } catch { /* full; nothing to do */ }
  if (!seen) return; // a fresh install has nothing to be new since
  notify({
    title: `WeatherDesk ${APP_VERSION}`,
    body: 'New: tap the hero to hear the day, forecast and rate-of-change alert rules, clickable '
      + 'charts, drought on the Fire card, archive retention — and a fix for the blank window on Linux.',
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
  radarView = null;
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

// --- kiosk mode: fullscreen + locked + no chrome + screen held awake, as one switch ---
function applyKiosk() {
  const on = !!settings().kiosk;
  document.body.classList.toggle('kiosk', on);
  holdScreen(on);
}
function setKiosk(on) {
  saveSettings({ kiosk: on, layoutLocked: on || settings().layoutLocked });
  applyKiosk();
  applyLock();
  if (on !== !!document.fullscreenElement) fullscreen();
}
$('btn-kiosk').onclick = () => setKiosk(!settings().kiosk);
// With the header hidden there is no button left, and a wall tablet has no Escape key.
let taps = [];
$('hero-clock').addEventListener('click', () => {
  taps = [...taps, Date.now()].filter((t) => Date.now() - t < 1500);
  if (taps.length >= 3) { taps = []; if (settings().kiosk) setKiosk(false); }
});
applyKiosk();

// Phone rearrange mode. At phone width the grips and the × are hidden, because left on they cover
// the panel titles and eat taps meant for the panel — so the Android app and a phone browser had
// no way to move or hide a panel at all. This turns them on for one device: the layout itself is
// synced house-wide, but "I am rearranging right now" is not, and it should not survive being
// picked up tomorrow either, which is why it is sessionStorage.
const editing = () => sessionStorage.getItem('wd.edit') === '1';
function applyEdit() {
  document.body.classList.toggle('editing', editing());
  $('btn-edit').textContent = editing() ? 'Done rearranging' : 'Rearrange panels';
}
$('btn-edit').onclick = () => {
  sessionStorage.setItem('wd.edit', editing() ? '0' : '1');
  applyEdit();
  // The grips are in the panels behind the drawer, so leaving it open would hide the thing the
  // button just turned on.
  if (editing()) { openDrawer(false); loadDeskRadar(); }
};
applyEdit();

// Shipped starting points. A preset is not a saved layout: it says which panels a screen is for
// and in what order, and deliberately carries no widths or heights — those belong to the screen
// they were dragged on, not to a name shipped in the source.
const PRESETS = {
  'Wall landscape': ['hero', 'radar', 'gauges', 'daycards', 'alerts', 'ticker'],
  'Kitchen portrait': ['hero', 'daycards', 'alerts', 'tenday'],
  'E-ink': ['hero', 'tenday', 'alerts', 'changes'],
};

// Gauge faces, and the Data and Signals cards, are inside panels of their own — a preset that
// hid them would empty the gauges block and both other tabs along with it.
const isDeskPanel = (id) => !/^(g-|data-|sig-)/.test(id);

function applyPreset(name) {
  const keep = PRESETS[name].slice();
  // The Desk grid is a panel holding panels: keeping a card inside it while hiding it would show
  // nothing at all.
  if (keep.some((id) => document.querySelector(`#desk-grid > [data-panel="${id}"]`))) keep.push('desk-grid');
  const st = {};
  for (const id of panelIds().filter(isDeskPanel)) {
    const i = keep.indexOf(id);
    if (NEVER_HIDE.includes(id)) continue;
    if (i === -1) st[id] = { hidden: true };
    else st[id] = { order: i };
  }
  restore(st);
  renderHiddenPanels();
  notify({ title: `${name} layout applied`, body: 'Everything else is under Hidden panels in Settings.' });
}

$('preset-row').innerHTML = Object.keys(PRESETS).map((n, i) => `<button data-preset="${i}"></button>`).join('');
$('preset-row').querySelectorAll('[data-preset]').forEach((b) => {
  const n = Object.keys(PRESETS)[+b.dataset.preset];
  b.textContent = n;
  b.onclick = () => applyPreset(n);
});

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

// The whole archive as a database file, snapshotted server-side so a copy taken mid-write is
// still a valid database. Restoring is a file copy and a restart — see the README; a restore
// button would be a second code path for something done once in a lifetime.
$('btn-backup').onclick = async () => {
  try {
    const r = await fetch(`${SRV}/backup.db`, { signal: expires(120000) });
    if (!r.ok) throw new Error(`${r.status}`);
    download('weatherdesk.db', await r.blob());
  } catch {
    notify({
      title: 'No archive to back up',
      body: 'The observation archive lives on the machine running the desktop app.',
    });
  }
};

// Desktop only: the browser and Android builds have no invoke bridge, so the button says so
// rather than sitting there doing nothing.
$('btn-update').onclick = async () => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    notify({ title: 'Updates', body: 'This build updates through wherever you installed it.' });
    return;
  }
  try {
    const version = await invoke('updater_check');
    if (!version) { notify({ title: 'Up to date', body: 'You are on the newest release.' }); return; }
    if (!confirm(`WeatherDesk ${version} is available. Download and install now?`)) return;
    notify({ title: `Installing ${version}`, body: 'The app will restart when it is done.' });
    await invoke('updater_install');
  } catch (e) {
    notify({ title: 'Update check failed', body: String(e) });
  }
};

$('btn-csv').onclick = async () => {
  try {
    const r = await fetch(`${SRV}/history.csv`, { signal: expires(60000) });
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

// HookEcho (own NEXRAD viewer) instead of the weathermap build. Deep link is
// `#goto=SITE,lon,lat,zoom[,extras]` — note lon before lat, and unknown extras are ignored by
// older builds, so adding to this string can never break a deployed viewer.
const RADAR = 'https://hookecho.pages.dev/';

// The NEXRAD + TDWR registry, generated from HookEcho's own site table
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

// HookEcho's own localStorage is partitioned (or dropped) inside our cross-origin iframe, so it
// cannot remember anything for us — the saved view lives here and rides in on the deep link.
// That is what stops the site and the camera resetting on every launch.
export function radarUrl(zoom, embed = true) {
  const s = settings(), v = radarView ?? load('wd.radar', null);
  const site = v?.site || radarSite();
  const lon = v ? v.lon : s.lon, lat = v ? v.lat : s.lat;
  if (lat == null && !site) return RADAR;
  const extras = v
    ? [v.moment, v.tilt, `bm:${v.basemap}`, v.srv ? 'srv' : ''].filter(Boolean).join(',')
    // First load, before the viewer has posted a camera back: HookEcho's localStorage is
    // partitioned in our iframe (see above), so without this it opens on whatever its compiled-in
    // default is. Streets orients a first-time viewer fastest; any pick they make sticks via
    // wd.radar and wins from then on.
    : 'bm:esri-streets';
  const q = embed ? '?embed' : '';
  return `${RADAR}${q}#goto=${site},${lon ?? ''},${lat ?? ''},${v ? v.zoom : zoom}${extras ? ',' + extras : ''}`;
}

// The embedded viewer posts its view back once a second; persist it, but deliberately not through
// saveSettings — a pan would fire `wd:settings` (and a full re-init) every second.
// Held in memory and flushed every few seconds: a pan posts once a second, and a localStorage
// write per frame is the panning stutter.
let radarView = null, radarFlush = 0;

window.addEventListener('message', (e) => {
  if (e.origin !== new URL(RADAR).origin) return;
  let v = e.data;
  try { v = typeof v === 'string' ? JSON.parse(v) : v; } catch { return; }
  if (!v || v.hookecho !== 1) return;
  radarView = v;
  radarAlive();
  if (radarFlush) return;
  radarFlush = setTimeout(() => { radarFlush = 0; store('wd.radar', radarView); }, 5000);
});
window.addEventListener('pagehide', () => { if (radarView) store('wd.radar', radarView); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && radarView) store('wd.radar', radarView);
});

// The viewer is a third-party origin behind a tunnel: when it is down the iframe just stays blank
// and the panel looks broken. No camera message within 20 s of loading it means unreachable.
let radarWatch = 0;
function radarAlive() {
  clearTimeout(radarWatch);
  radarWatch = 0;
  $('desk-radar')?.classList.remove('unreachable');
}
function radarWatchdog() {
  clearTimeout(radarWatch);
  radarWatch = setTimeout(() => $('desk-radar')?.classList.add('unreachable'), 20000);
}

// Storm mode: a warning out is the one time the radar earns its cost, and exactly when nobody is
// at the machine to switch it on. In-memory override only — never written to settings. It used to
// saveSettings({deskRadar:true}) with the restore flag in memory: a hang or force-quit mid-storm
// lost the flag, the restore never ran, and a temporary override became the permanent setting
// (radar at every launch on the one machine it hangs). Now the user's saved choice is never
// touched, and a crash costs nothing.
let stormOverride = false;
window.addEventListener('wd:storm', (e) => {
  if (!settings().stormAuto) return;
  const panel = $('desk-radar');
  if (!panel) return;
  // An eco box (weak hardware) is the machine the radar wasm hangs — never force it there.
  stormOverride = !!e.detail && !ecoOn();
  const reveal = stormOverride && panel.hidden;
  loadDeskRadar();
  if (reveal) panel.scrollIntoView({ block: 'nearest' });
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
// A live radar is megabytes of wasm repainting itself; on the boxes that already run Lite (a
// wall tablet, a Celeron Chromebook) that is the single most expensive thing on the page. They
// get a picture instead — same map, five minutes stale, one PNG. Motion=Full puts the live map
// back on any box, which is why this needs no setting of its own.
function stillRadar() {
  return ecoOn() || motionLevel() !== 'full';
}

// HookEcho's snapshot renderer. `t` is a five-minute bucket: Cloudflare rewrites the browser TTL
// to four hours, so without a changing URL the panel would show one frame all afternoon.
function stillUrl() {
  const v = radarView ?? load('wd.radar', null);
  const q = new URLSearchParams({
    site: v?.site || radarSite(), size: '768', zoom: String(v?.zoom ?? 6.5),
    t: String(Math.floor(Date.now() / 300000)),
  });
  if (v?.basemap) q.set('basemap', v.basemap);
  return `https://img.hookecho.io/snapshot.png?${q}`;
}

function showStill(panel) {
  const img = $('desk-radar-still'), f = $('desk-radar-frame');
  if (f.src) { f.src = 'about:blank'; f.removeAttribute('src'); }
  img.hidden = false;
  $('desk-radar-caption').hidden = false;
  panel.classList.add('loaded');
  const refresh = () => { img.src = stillUrl(); };
  img.onerror = () => panel.classList.add('unreachable');
  img.onload = () => panel.classList.remove('unreachable');
  img.onclick = () => document.querySelector('.tab[data-section="lab"]')?.click();
  refresh();
  every('radar-still', 300, refresh);
}

function loadDeskRadar() {
  const panel = $('desk-radar'), f = $('desk-radar-frame');
  if (!panel) return;
  // Off is off: hide the panel, and drop the document — a hidden iframe still runs its wasm.
  // stormAuto re-checked here so switching it off mid-storm hides the radar on drawer close —
  // the wd:storm event that set the override will not fire again until the alert state changes.
  panel.hidden = !(settings().deskRadar || (stormOverride && settings().stormAuto));
  if (panel.hidden) {
    if (f.src) { f.src = 'about:blank'; f.removeAttribute('src'); }
    $('desk-radar-still').hidden = true;
    $('desk-radar-caption').hidden = true;
    clearJob('radar-still');
    loadDeskRadar.armed = false;
    return;
  }
  // Motion changed while the panel was up: swap whichever one is showing for the other.
  if (stillRadar()) {
    if (!$('desk-radar-still').hidden) return;
    return showStill(panel);
  }
  $('desk-radar-still').hidden = true;
  $('desk-radar-caption').hidden = true;
  clearJob('radar-still');
  if (f.src || loadDeskRadar.armed) return;
  // First run: the drawer is open and typing the token matters more than the map. Closing the
  // drawer (by saving, or by hand — a hub-only install has no token to type) calls back here.
  if ($('drawer').classList.contains('open') || !$('wizard').hidden) return;
  loadDeskRadar.armed = true;

  const start = () => {
    if (!f.src) { f.src = radarUrl(6.5); radarWatchdog(); }
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

// Not awaited at the top level: the whole module graph used to stall behind a 2-second config
// fetch before a single pixel was painted. Wire the chrome now, re-run the parts the config can
// change once it lands.
const pulled = pullConfig();

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
applyMotion();
initKiosk();
initRules();
initNav();

// --- keyboard ---
//
// A dashboard on a desk gets a keyboard, and the tabs are the only thing anyone reaches for.
// Never while typing: the token field is one keystroke from being a tab switch otherwise.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  // The detail slide-over owns Escape while it is open, or one press closed it and left kiosk.
  if (e.key === 'Escape' && document.getElementById('detail')?.classList.contains('open')) return;
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
  if (e.key === 'Escape') {
    if (settings().kiosk) setKiosk(false);
    openDrawer(false); $('shortcuts').hidden = true; loadDeskRadar(); return;
  }
  if (e.key === '?') { $('shortcuts').hidden = !$('shortcuts').hidden; return; }
  if (e.key === 'f') fullscreen();
  else if (e.key === 'k') setKiosk(!settings().kiosk);
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

// Anything the pulled config decides: the wizard (showing it before the pull flashed it on an
// install that is configured on the server), and the settings-driven chrome.
pulled.then(() => {
  applyEco();
  applyMotion();
  initKiosk();
  applyLock();
  showWizard();
  hydrateStation().then(() => {
    loadDeskRadar();
    initDesk(); initIntel(); initSignals(); initBoards(); initAlmanac(); initEnv(); initPro(); initDetail(); initUdp(); initHome();
    every('server-alerts', 300, probeServerAlerts);
  });
});

function showWizard() {
if (!hasSource() && !PUBLIC) {
  $('wizard').hidden = false;
  // No autofocus on the token field: it put a cursor in a Tempest-only box for people who own
  // an Ambient, and they reported the app as demanding an account they can't have.
  // UDP-only mode: a desktop install with a hub on the LAN has real local data with no token at
  // all, so the modules start either way. Every refresh job early-returns without a token, so an
  // unconfigured init is a handful of no-ops.
  // Only blank them when there is nowhere to point a forecast at. A Tempest token is one way in,
  // not the only one — saying otherwise sent people off to open accounts they never needed.
  if (!hasLocation()) {
    const body = settings().stationSource
      ? 'Needs a station location — open ⚙ Settings and search a city under Places'
      : 'Needs a station — open ⚙ Settings';
    for (const id of ['tenday', 'alerts', 'story', 'agree-verdict', 'changes', 'verify']) {
      const el = $(id);
      if (el) el.innerHTML = `<div class="muted">${body}</div>`;
    }
  }
}
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
  // (unconfigured profile returns the bare viewer URL with no #goto — nothing to assert on)
  const u2 = radarUrl(6.5);
  console.assert(!u2.includes('#goto=') || u2.endsWith(',bm:esri-streets'), 'first-load default basemap', u2);

  // The push guard. A blank screen that has heard nothing from the host must stay quiet, or it
  // overwrites what the host knew with its own empty defaults.
  console.assert(mayPush(true), 'config: a screen that has pulled may push');
  console.assert(mayPush(false) === (configured() || !!settings().stationSource),
    'config: without a pull, only a screen that knows its station pushes');

  // The bug that read as "the Find button does nothing": a ZIP match's town is in `city`, so
  // without it the list showed five bare numbers and none of them looked like home.
  console.assert(api.placeLabel({ name: '06092', city: 'Simsbury', state: 'Connecticut', country: 'United States' })
    === '06092, Simsbury, Connecticut, United States', 'geocode label keeps the town');
  console.assert(api.placeLabel({ name: 'Simsbury', city: 'Simsbury', state: 'Connecticut' })
    === 'Simsbury, Connecticut', 'geocode label does not repeat the town');

  // Wind override: six files used to carry their own m/s factor. One knot is 1.94384 m/s, and
  // the label has to move with the number or the dashboard lies twice.
  {
    const held = settings().windUnit;
    saveSettings({ windUnit: 'kt' });
    console.assert(U.wind() === 'kt', 'wind override: label follows the setting');
    console.assert(Math.abs(msToWind(10) - 19.4384) < 1e-3, 'wind override: m/s to knots');
    console.assert(Math.abs(windToMs(msToWind(7)) - 7) < 1e-9, 'wind override: round trip');
    saveSettings({ windUnit: '' });
    console.assert(U.wind() === (settings().units === 'metric' ? 'km/h' : 'mph'),
      'wind override: empty follows the master switch');
    saveSettings({ windUnit: held });
  }

  // The fetch deadline every screen depends on, on the browsers that have no AbortSignal.timeout.
  const sig = expires(50);
  console.assert(sig.aborted === false, 'expires: not aborted yet');
  console.assert(typeof sig.addEventListener === 'function', 'expires: returns a real signal');

  // The radar still: which boxes get it, and a URL that actually changes.
  console.assert(stillRadar() === (motionLevel() !== 'full' || ecoOn()), 'radar: still follows motion and eco');
  console.assert(/[?&]site=/.test(stillUrl()) && /[?&]t=\d/.test(stillUrl()),
    'radar: the still URL carries a site and a cache-buster');

  // The config echo, the one bug here that costs a whole CPU core rather than a wrong number.
  const held = rev;
  rev = 7;
  console.assert(!shouldPull(7), 'config: our own revision is not pulled back');
  console.assert(shouldPull(8), 'config: a newer revision from another screen is pulled');
  console.assert(shouldPull(undefined), 'config: a server that sends no revision still pulls');
  rev = held;
}

// Reached only if every module parsed and boot ran to the end — CI greps for it, which is the
// closest thing a bundler-free site has to a compile check.
if (location.search.includes('selftest')) document.documentElement.dataset.selftest = 'ok';
