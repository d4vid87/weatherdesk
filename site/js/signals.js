// 03 Local Signals — nearby public Tempest stations vs yours, plus the live websocket feed.
import * as api from './api.js';
import { settings, saveSettings, configured, U, num, deg2compass, every, notify, store, load, notifHistory } from './app.js';

const $ = (id) => document.getElementById(id);
const MPS = { imperial: 2.23694, metric: 3.6 }; // rapid_wind is always m/s

// --- nearby station comparison ---

export async function refreshSignals() {
  const ids = settings().nearbyStations;
  const mine = await api.stationObs().then((j) => j.obs?.[0]).catch(() => null);
  if (!ids.length) {
    $('signals-table').innerHTML = '<div class="muted">No nearby stations added. Find public station IDs at tempestwx.com/map.</div>';
    return;
  }
  const rows = await Promise.all(ids.map(async (id) => {
    try {
      const j = await api.stationObs(id);
      return { id, name: j.station_name || `#${id}`, o: j.obs?.[0] };
    } catch (e) { return { id, name: `#${id}`, err: e.message }; }
  }));

  const d = (a, b) => (a == null || b == null ? null : a - b);
  const sign = (v, digits = 1) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${num(v, digits)}`);

  $('signals-table').innerHTML = `<div class="sig-row sig-head">
      <span>Station</span><span>Temp</span><span>Δ</span><span>Wind</span><span>Δ</span><span>Rain today</span><span>Age</span>
    </div>` + rows.map((r) => {
    // A private station answers the same way a wrong number does, and the bare status code sent
    // people looking for a bug that isn't there.
    if (!r.o) return `<div class="sig-row"><span>${r.name}</span><span class="fail" style="grid-column:span 6">${r.err ? `${r.err} · private stations can't be read — use a public station's ID from tempestwx.com/map` : 'no data'}</span>
      <button class="sig-x" data-id="${r.id}">×</button></div>`;
    const ageMin = Math.round((Date.now() / 1000 - r.o.timestamp) / 60);
    return `<div class="sig-row${ageMin > 20 ? ' stale' : ''}">
      <span>${r.name}</span>
      <span>${num(r.o.air_temperature, 1)}${U.temp()}</span>
      <span>${sign(d(r.o.air_temperature, mine?.air_temperature))}</span>
      <span>${num(r.o.wind_avg, 1)} ${deg2compass(r.o.wind_direction)}</span>
      <span>${sign(d(r.o.wind_avg, mine?.wind_avg))}</span>
      <span>${num(r.o.precip_accum_local_day, 2)} ${U.precip()}</span>
      <span>${ageMin}m</span>
      <button class="sig-x" data-id="${r.id}">×</button>
    </div>`;
  }).join('');

  $('signals-table').querySelectorAll('.sig-x').forEach((b) => {
    b.onclick = () => {
      saveSettings({ nearbyStations: settings().nearbyStations.filter((x) => x !== b.dataset.id) });
      refreshSignals();
    };
  });
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
  try { ws?.close(); } catch { /* already gone */ }
  setWsState('connecting…', false);
  ws = new WebSocket(`wss://ws.weatherflow.com/swd/data?token=${encodeURIComponent(s.token)}`);

  ws.onopen = () => {
    backoff = 1000;
    setWsState('live', true);
    ws.send(JSON.stringify({ type: 'listen_start', device_id: +s.deviceId, id: 'wd' }));
    ws.send(JSON.stringify({ type: 'listen_rapid_start', device_id: +s.deviceId, id: 'wd-rapid' }));
  };

  ws.onmessage = (ev) => {
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

  ws.onclose = () => {
    setWsState('reconnecting…', false);
    if (!wantOpen) return;
    setTimeout(connectWs, backoff);
    backoff = Math.min(backoff * 2, 60000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* onclose handles retry */ } };
}

export function disconnectWs() {
  wantOpen = false;
  try { ws?.close(); } catch { /* nothing open */ }
}

export function renderRapid(mps, dir) {
  const f = MPS[settings().units] || MPS.imperial;
  const v = mps * f;
  $('live-wind').textContent = num(v, 1);
  $('live-wind-unit').textContent = U.wind();
  $('live-dir').textContent = `${deg2compass(dir)} ${num(dir)}°`;
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
    ? recent.map((x) => `<div><span>${new Date(x.t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`
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
    const id = $('add-station-id').value.trim();
    if (!/^\d+$/.test(id)) return;
    const list = settings().nearbyStations;
    if (!list.includes(id)) saveSettings({ nearbyStations: [...list, id] });
    $('add-station-id').value = '';
    refreshSignals();
  };
  if (configured()) {
    every('signals', 300, refreshSignals);
    connectWs();
    // socket goes quiet without closing on some networks — force a reconnect
    every('ws-watchdog', 120, () => {
      if (wantOpen && lastMsg && Date.now() - lastMsg > 180000) connectWs();
    });
  }
}
