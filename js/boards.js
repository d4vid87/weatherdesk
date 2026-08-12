// 04 Data — nine boards. Station history from observations/device, forecast
// intelligence from open-meteo + wd.verify, official context from NWS.
import * as api from './api.js';
import { settings, coords, configured, U, num, every } from './app.js';
import { chart } from './charts.js';
import { accuracy } from './track.js';
import { forecast as deskForecast } from './desk.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400;
const I = api.OBS;

let history = [];

const note = (id, msg) => { $(id).innerHTML = `<div class="muted">${msg}</div>`; };

export async function refreshBoards() {
  if (!configured() || !settings().deviceId) {
    note('board-temp', 'Set a numeric device ID in settings to load history.');
    return;
  }
  const end = Math.floor(Date.now() / 1000);
  try {
    const j = await api.deviceObs(settings().deviceId, end - 7 * DAY, end);
    history = j.obs || [];
  } catch (e) {
    note('board-temp', `History unavailable: ${e.message}`);
    return;
  }
  if (!history.length) { note('board-temp', 'No history returned for this device.'); return; }

  drawTemp();
  drawRain();
  drawWind();
  drawPressure();
  drawExtremes();
  drawModels();
  drawAccuracy();
  drawOfficial();
  drawOutlook();
}

const pts = (idx, from = 0) =>
  history.filter((o) => o[I.time] >= from).map((o) => ({ x: o[I.time] * 1000, y: o[idx] }));

function drawTemp() {
  chart($('c-temp'), [{ data: pts(I.temp), color: '#4fb8ff' }], { digits: 0 });
  $('board-temp').textContent = `7-day air temperature (${U.temp()})`;
}

// daily rain totals from the per-minute accumulation column
function dailyRain() {
  const byDay = new Map();
  for (const o of history) {
    const k = new Date(o[I.time] * 1000).setHours(0, 0, 0, 0);
    byDay.set(k, (byDay.get(k) || 0) + (o[I.rain] || 0));
  }
  return [...byDay].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

function drawRain() {
  const d = dailyRain();
  chart($('c-rain'), [{ data: d, type: 'bar', color: '#4fdc8b' }], { yMin: 0, digits: 2 });
  const total = d.reduce((a, b) => a + b.y, 0);
  $('board-rain').textContent = `7-day rain — ${num(total, 2)} ${U.precip()} total`;
}

function drawWind() {
  const from = Math.floor(Date.now() / 1000) - DAY;
  chart($('c-wind'), [
    { data: pts(I.windGust, from), color: '#ffb84f' },
    { data: pts(I.windAvg, from), color: '#4fb8ff' },
  ], { yMin: 0, digits: 0 });
  $('board-wind').textContent = `24h wind (${U.wind()}) — gust amber, average blue`;
}

function drawPressure() {
  const from = Math.floor(Date.now() / 1000) - 2 * DAY;
  chart($('c-press'), [{ data: pts(I.press, from), color: '#e6edf5' }], { digits: 2 });
  const p = pts(I.press, from);
  const delta = p.length > 1 ? p[p.length - 1].y - p[0].y : 0;
  $('board-press').textContent = `48h pressure (${U.press()}) — net ${delta >= 0 ? '+' : ''}${num(delta, 2)}`;
}

function drawExtremes() {
  const col = (i) => history.map((o) => o[i]).filter((v) => v != null);
  const t = col(I.temp), g = col(I.windGust);
  const strikes = col(I.strikes).reduce((a, b) => a + b, 0);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  $('extremes').innerHTML = [
    ['High', `${num(Math.max(...t), 1)}${U.temp()}`],
    ['Low', `${num(Math.min(...t), 1)}${U.temp()}`],
    ['Mean', `${num(avg(t), 1)}${U.temp()}`],
    ['Peak gust', `${num(Math.max(...g), 1)} ${U.wind()}`],
    ['Lightning strikes', num(strikes)],
    ['Samples', num(history.length)],
  ].map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
}

async function drawModels() {
  const m = await api.multiModel().catch(() => null);
  if (!m) return note('board-models', 'Open-Meteo unavailable.');
  const colors = { gfs_seamless: '#4fb8ff', ecmwf_ifs025: '#4fdc8b', icon_seamless: '#ffb84f', gem_seamless: '#ff5f56' };
  const series = api.MODELS.split(',').map((k) => ({
    color: colors[k],
    data: (m.hourly[`temperature_2m_${k}`] || []).map((y, i) => ({ x: new Date(m.hourly.time[i]).getTime(), y })),
  }));
  chart($('c-models'), series, { digits: 0, xFormat: (x) => new Date(x).toLocaleString([], { weekday: 'short', hour: 'numeric' }) });
  $('board-models').innerHTML = 'Model temps · <span style="color:#4fb8ff">GFS</span> '
    + '<span style="color:#4fdc8b">ECMWF</span> <span style="color:#ffb84f">ICON</span> <span style="color:#ff5f56">GEM</span>';
}

function drawAccuracy() {
  const a = accuracy();
  chart($('c-accuracy'), [{
    type: 'bar', color: '#4fb8ff',
    data: a.recent.map((v) => ({ x: v.targetHour * 1000, y: v.fTemp - v.obsTemp })),
  }], { digits: 1 });
  $('board-accuracy').textContent = a.n
    ? `24h-lead temp error — MAE ${num(a.mae, 1)}${U.temp()} over ${a.n} checks`
    : '24h-lead temp error — collecting, first score lands 24h after setup';
}

async function drawOfficial() {
  const fc = deskForecast();
  try {
    const p = await api.nwsPoint();
    const nws = await (await fetch(p.properties.forecast)).json();
    const periods = nws.properties.periods.slice(0, 6);
    const tempestDaily = fc?.forecast?.daily || [];
    $('official').innerHTML = periods.map((pd, i) => {
      const mine = tempestDaily[Math.floor(i / 2)];
      const ref = pd.isDaytime ? mine?.air_temp_high : mine?.air_temp_low;
      const d = ref == null ? null : pd.temperature - ref;
      return `<div><span>${pd.name}</span><span>NWS ${pd.temperature}° · Tempest ${num(ref)}°`
        + `${d == null ? '' : ` (${d >= 0 ? '+' : ''}${num(d)})`}</span></div>`;
    }).join('');
  } catch (e) {
    note('official', `NWS gridpoint unavailable: ${e.message}`);
  }
}

async function drawOutlook() {
  const s = coords();
  const imperial = settings().units !== 'metric';
  try {
    const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}`
      + `&daily=precipitation_sum,precipitation_probability_max&forecast_days=7&timezone=auto`
      + (imperial ? '&precipitation_unit=inch' : ''))).json();
    const data = j.daily.time.map((t, i) => ({ x: new Date(t).getTime(), y: j.daily.precipitation_sum[i] }));
    chart($('c-qpf'), [{ data, type: 'bar', color: '#4fb8ff' }], { yMin: 0, digits: 2 });
    const total = data.reduce((a, b) => a + (b.y || 0), 0);
    $('board-qpf').textContent = `7-day precip outlook — ${num(total, 2)} ${U.precip()} total`;
  } catch (e) {
    note('board-qpf', `Outlook unavailable: ${e.message}`);
  }
}

export function initBoards() {
  // history is heavy; refresh on tab entry and hourly, not on the desk cadence
  window.addEventListener('wd:section', (e) => { if (e.detail === 'data') refreshBoards().catch(() => {}); });
  every('boards', 3600, () => {
    if (document.getElementById('data').classList.contains('active')) refreshBoards();
  });
}
