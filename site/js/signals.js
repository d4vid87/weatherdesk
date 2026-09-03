// 03 Local Signals — nearby public Tempest stations vs yours, plus the live websocket feed.
import * as api from './api.js';
import { settings, saveSettings, configured, hasSource, U, num, deg2compass, every, notify, store, load, notifHistory, timeStr, msToWind } from './app.js';
import { milesBetween } from './boot.js';

const $ = (id) => document.getElementById(id);

// --- discovery: what is within nearbyRadius of the station ---

// Airports only. The Tempest map's own endpoint does list every neighbouring station inside a
// bounding box, with name, position and device ids — but observations for a station you don't own
// answer 404 on every path the map itself uses (`observations/location`, `observations/device`,
// `observations/stn`). Reading other people's stations is what WeatherFlow's commercial licence
// sells, so auto-discovered Tempest neighbours could only ever be a list of names. Add public
// station IDs by hand on the Signals tab; those work, because a shared station is readable.
//
// Failure keeps the last good list: a dead endpoint should cost freshness, not the panel.
// Radius 0 means "manual only" and clears what was discovered.
async function scanNearby() {
  const s = settings();
  const r = s.nearbyRadius;
  // An airport typed in by hand is not something a scan gets to take away — radius 0 is the
  // default, so a wholesale clear used to lose it on the next save.
  const manual = s.nearbyMetar.filter((m) => m.manual);
  if (!r || s.lat == null) {
    if (s.nearbyMetar.length !== manual.length) {
      saveSettings({ nearbyMetar: manual });
      refreshSignals();
    }
    return;
  }
  const near = (lat, lon) => milesBetween(s.lat, s.lon, lat, lon) <= r;

  try {
    const point = await api.nwsPoint(s.lat, s.lon);
    const list = await fetch(point.properties.observationStations).then((x) => x.json());
    // NWS returns these nearest-first. Past the closest few the airports are all reporting the
    // same air mass, half an hour late.
    const metar = (list.features || [])
      .map((f) => ({ id: f.properties.stationIdentifier, name: f.properties.name, c: f.geometry.coordinates }))
      .filter((x) => !s.nearbyExclude.includes(x.id) && !manual.some((m) => m.id === x.id) && near(x.c[1], x.c[0]))
      .slice(0, 3);
    saveSettings({ nearbyMetar: [...manual, ...metar.map(({ id, name }) => ({ id, name }))] });
  } catch (e) { console.warn('nearby METAR scan:', e.message); }
  refreshSignals();
}

// --- nearby station comparison ---

export async function refreshSignals() {
  const s = settings();
  const entries = [
    ...s.nearbyStations.map((id) => ({ id, type: 'wf' })),
    ...s.nearbyMetar.map((m) => ({ id: m.id, type: 'metar', name: m.name })),
  ];
  const mine = await api.stationObs().then((j) => j.obs?.[0]).catch(() => null);
  if (!entries.length) {
    const empty = '<div class="muted">No nearby sensors. Set a radius in Settings, or add a public station ID from tempestwx.com/map.</div>';
    for (const el of [$('signals-table'), $('nearby-table')]) if (el) el.innerHTML = empty;
    if ($('nearby-ltg')) $('nearby-ltg').textContent = '';
    return;
  }
  const rows = await Promise.all(entries.map(async (en) => {
    try {
      const j = en.type === 'metar' ? await api.metarObs(en.id) : await api.stationObs(en.id);
      const lat = en.lat ?? j.latitude, lon = en.lon ?? j.longitude;
      const dist = lat == null || s.lat == null ? null : milesBetween(s.lat, s.lon, lat, lon);
      return { ...en, name: en.name || j.station_name || j.location_name || `#${en.id}`, o: j.obs?.[0], dist };
    } catch (e) { return { ...en, name: en.name || `#${en.id}`, err: e.message }; }
  }));
  rows.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));

  const d = (a, b) => (a == null || b == null ? null : a - b);
  const sign = (v, digits = 1) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${num(v, digits)}`);
  const label = (r) => `${r.name}${r.dist == null ? '' : ` <small class="muted">${num(r.dist, 1)} ${U.dist()}</small>`}`;

  const html = `<div class="sig-row sig-head">
      <span>Station</span><span>Temp</span><span>Δ</span><span>Wind</span><span>Δ</span><span>Rain today</span><span>Age</span>
    </div>` + rows.map((r) => {
    // A private station answers the same way a wrong number does, and the bare status code sent
    // people looking for a bug that isn't there. One line per row, full message in the title —
    // several failing rows used to fill the panel with the same red paragraph.
    if (!r.o) return `<div class="sig-row"><span>${label(r)}</span><span class="fail" style="grid-column:span 6" title="${(r.err || '').replace(/"/g, '')}">${r.err ? `${(r.err.match(/^\d+/) || ['error'])[0]} · can't be read — only stations shared publicly answer` : 'no data'}</span>
      <button class="sig-x" data-id="${r.id}" data-type="${r.type}">×</button></div>`;
    const ageMin = Math.round((Date.now() / 1000 - r.o.timestamp) / 60);
    return `<div class="sig-row${ageMin > 20 ? ' stale' : ''}">
      <span>${label(r)}</span>
      <span>${num(r.o.air_temperature, 1)}${U.temp()}</span>
      <span>${sign(d(r.o.air_temperature, mine?.air_temperature))}</span>
      <span>${num(r.o.wind_avg, 1)} ${deg2compass(r.o.wind_direction)}</span>
      <span>${sign(d(r.o.wind_avg, mine?.wind_avg))}</span>
      <span>${num(r.o.precip_accum_local_day, 2)} ${U.precip()}</span>
      <span>${ageMin}m</span>
      <button class="sig-x" data-id="${r.id}" data-type="${r.type}">×</button>
    </div>`;
  }).join('');

  for (const el of [$('signals-table'), $('nearby-table')]) {
    if (!el) continue;
    el.innerHTML = html;
    el.querySelectorAll('.sig-x').forEach((b) => { b.onclick = () => dropRow(b.dataset); });
  }
  renderNearbyLightning(rows);
}

// A dismissed airport has to be remembered, or the next scan puts it straight back.
function dropRow({ id, type }) {
  const s = settings();
  if (type === 'metar') saveSettings({ nearbyMetar: s.nearbyMetar.filter((m) => m.id !== id), nearbyExclude: [...s.nearbyExclude, id] });
  else saveSettings({ nearbyStations: s.nearbyStations.filter((x) => x !== id) });
  refreshSignals();
}

// Lightning without a second network to pay for: the neighbours' own strike counters, summed.
function renderNearbyLightning(rows) {
  const el = $('nearby-ltg');
  if (!el) return;
  // Airports don't report strikes, so with no readable Tempest neighbour there is nothing to say.
  const obs = rows.filter((r) => r.type !== 'metar' && r.o).map((r) => r.o);
  if (!obs.length) { el.textContent = ''; return; }
  const total = obs.reduce((n, o) => n + (o.lightning_strike_count_last_3hr || 0), 0);
  if (!total) { el.textContent = '⚡ no strikes reported nearby (3h)'; return; }
  const dists = obs.map((o) => o.lightning_strike_last_distance).filter((x) => x != null);
  const last = Math.max(...obs.map((o) => o.lightning_strike_last_epoch || 0));
  el.textContent = `⚡ ${total} strikes/3h across ${obs.length} stations`
    + (dists.length ? ` · nearest ${num(Math.min(...dists), 1)} ${U.dist()}` : '')
    + (last ? ` · last ${timeStr(last)}` : '');
}

// --- live websocket: rapid wind (3s) + full obs ---

let ws = null, backoff = 1000, wantOpen = false, lastMsg = 0;

function setWsState(txt, ok) {
  const el = $('ws-state');
  if (el) { el.textContent = txt; el.className = ok ? 'ok' : 'muted'; }
}

export function connectWs() {
  const s = settings();
  if (!s.token || !s.deviceId) return;
  wantOpen = true;
  // Detach the old socket's handlers before closing it: its onclose would otherwise schedule a
  // second reconnect timer, and saving settings a few times left a socket per save.
  const old = ws;
  if (old) { old.onclose = old.onerror = old.onmessage = old.onopen = null; try { old.close(); } catch { /* already gone */ } }
  setWsState('connecting…', false);
  const sock = ws = new WebSocket(`wss://ws.weatherflow.com/swd/data?token=${encodeURIComponent(s.token)}`);

  sock.onopen = () => {
    backoff = 1000;
    setWsState('live', true);
    sock.send(JSON.stringify({ type: 'listen_start', device_id: +s.deviceId, id: 'wd' }));
    sock.send(JSON.stringify({ type: 'listen_rapid_start', device_id: +s.deviceId, id: 'wd-rapid' }));
  };

  sock.onmessage = (ev) => {
    lastMsg = Date.now();
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'rapid_wind' && m.ob) renderRapid(m.ob[1], m.ob[2]);
    else if (m.type === 'evt_strike' && m.evt) {
      onStrike(m.evt);
      window.dispatchEvent(new CustomEvent('wd:ws-strike', { detail: m.evt }));
    }
    else if (m.type === 'obs_st' && m.obs?.[0]) window.dispatchEvent(new CustomEvent('wd:ws-obs', { detail: m.obs[0] }));
  };

  sock.onclose = () => {
    if (ws !== sock || !wantOpen) return;
    setWsState('reconnecting…', false);
    setTimeout(connectWs, backoff);
    backoff = Math.min(backoff * 2, 60000);
  };
  sock.onerror = () => { try { sock.close(); } catch { /* onclose handles retry */ } };
}

export function disconnectWs() {
  wantOpen = false;
  try { ws?.close(); } catch { /* nothing open */ }
}

export function renderRapid(mps, dir) {
  if (document.hidden) return;   // 3-second frames into a tab nobody is watching
  const v = msToWind(mps);   // rapid_wind is always m/s
  $('live-wind').textContent = num(v, 1);
  $('live-wind-unit').textContent = U.wind();
  $('live-dir').textContent = `${deg2compass(dir)} ${num(dir)}°`;
  // Only a Tempest hub sends true 3-second wind. A polled brand's "rapid" packet is the
  // station's own 1-minute average resent every 10s; saying so beats implying a fast needle.
  $('live-rate').textContent = settings().stationSource ? '1-min avg · polled' : '3-second';
  const needle = $('live-needle');
  if (needle) needle.style.transform = `rotate(${dir}deg)`;
}

// --- strikes: one line was the whole record, so a storm overwrote itself ---

const strikes = load('wd.strikes', []);
const miles = (km) => (settings().units === 'metric' ? km : km * 0.621371);
const esc = (s) => String(s ?? '').replace(/</g, '&lt;');

// evt: [epoch, distance (km), energy]
export function onStrike([t, distKm]) {
  const dist = miles(distKm);
  $('live-strike').textContent = `Strike ${num(dist, 1)} ${U.dist()} away at ${new Date(t * 1000).toLocaleTimeString()}`;
  if (!strikes.some((x) => x.t === t)) {
    strikes.unshift({ t, km: distKm });
    strikes.splice(200);
    store('wd.strikes', strikes);
  }
  renderStrikes();
  notify({
    id: `strike-${t}`, category: 'lightning',
    title: 'Lightning nearby', body: `${num(dist, 1)} ${U.dist()} away`,
  });
}

function renderStrikes() {
  const el = $('strike-log');
  if (!el) return;
  const cut = Date.now() / 1000 - 86400;
  const recent = strikes.filter((x) => x.t >= cut);
  el.innerHTML = recent.length
    ? recent.map((x) => `<div data-metric="strikes" role="button" tabindex="0"><span>${new Date(x.t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`
      + `<span>${num(miles(x.km), 1)} ${U.dist()}</span></div>`).join('')
    : '<div class="muted">No strikes in the last 24h</div>';
}

function renderNotifLog() {
  const el = $('notif-log');
  if (!el) return;
  const rows = notifHistory();
  el.innerHTML = rows.length
    ? rows.map((n) => `<div><span>${new Date(n.t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      + ` · ${esc(n.category)}</span><span>${esc(n.title)}</span></div>`).join('')
    : '<div class="muted">Nothing yet</div>';
}

// module level: initSignals re-runs on every settings save, and a listener per save adds up
window.addEventListener('wd:notif', renderNotifLog);

export function initSignals() {
  renderStrikes();
  renderNotifLog();
  $('btn-add-station').onclick = () => {
    const raw = $('add-station-id').value.trim();
    // An airport code, for the parts of the country the radius scan reaches past — the NWS
    // station list is nearest-first and capped, so a neighbouring state's airport never appears
    // on its own. `api.metarObs()` reads any ICAO the NWS publishes.
    const icao = (raw.toUpperCase().match(/^[A-Z]{4}$/) || [])[0];
    if (icao) {
      const s = settings();
      saveSettings({
        nearbyMetar: [...s.nearbyMetar.filter((m) => m.id !== icao), { id: icao, name: icao, manual: true }],
        nearbyExclude: s.nearbyExclude.filter((x) => x !== icao),
      });
      $('add-station-id').value = '';
      refreshSignals();
      return;
    }
    // Pasting the map/station URL is what people actually have in hand. Station ids run 4+
    // digits, so the first such run is the id in every form of the link.
    const id = (raw.match(/\d{4,}/) || [])[0];
    if (!id) return;
    const list = settings().nearbyStations;
    if (!list.includes(id)) saveSettings({ nearbyStations: [...list, id] });
    $('add-station-id').value = '';
    refreshSignals();
  };
  // The × on a row is remembered forever, which is right until somebody wants one back.
  $('btn-nearby-reset').onclick = () => {
    saveSettings({ nearbyExclude: [] });
    scanNearby();
  };
  // connectWs() self-guards on the token, so a non-Tempest station gets the neighbour scan and
  // the comparison rows without one.
  if (hasSource()) {
    every('signals', 300, refreshSignals);
    // every() runs its job immediately, and Save re-runs initSignals — so this is a rescan on
    // boot, on every settings save, and once a day, with no change detection to keep in sync.
    every('nearby-scan', 86400, scanNearby);
    connectWs();
    // socket goes quiet without closing on some networks — force a reconnect
    every('ws-watchdog', 120, () => {
      if (wantOpen && lastMsg && Date.now() - lastMsg > 180000) connectWs();
    });
  }
}
