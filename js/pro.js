// Desk layout matching myWeatherDesk: sky hero, signal ticker, trend strip,
// 48h combined chart, day cards, dial gauges. Driven by the wd:forecast event.
import * as api from './api.js';
import { settings, U, num, timeStr, deg2compass, every } from './app.js';
import { forecast as deskForecast } from './desk.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

let history = [];      // last 3h of device obs, for trends
let consensus = null;  // model temp at this hour

const I = api.OBS;

// ---------- hero ----------

// sky gradient keyed to sun position: night → dawn → day → dusk
function skyFor(now, sunrise, sunset) {
  const h = (t) => (t - sunrise) / (sunset - sunrise);
  const f = h(now);
  if (f < -0.06 || f > 1.06) return ['#050a14', '#0b1424'];
  if (f < 0.06) return ['#1b2a45', '#4a3a5a'];
  if (f > 0.94) return ['#3b2a45', '#8a4a3a'];
  if (f < 0.18 || f > 0.82) return ['#1e4a7a', '#5a86b8'];
  return ['#1f6fb8', '#7fb6e6'];
}

const SYNODIC = 29.530588853;
const NEW_MOON = 947182440000; // 2000-01-06 18:14 UTC
function moon() {
  const age = (((Date.now() - NEW_MOON) / 86400000) % SYNODIC + SYNODIC) % SYNODIC;
  const illum = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2) * 100);
  const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.floor(((age / SYNODIC) * 8 + 0.5) % 8)];
  return { age, illum, name };
}

function renderHero(fc) {
  const c = fc.current_conditions, d = fc.forecast.daily[0];
  const [a, b] = skyFor(Date.now() / 1000, d.sunrise, d.sunset);
  $('hero').style.background = `linear-gradient(160deg, ${a}, ${b})`;
  $('hero-place').textContent = settings().stationName || 'Station';
  $('hero-time').textContent = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('hero-temp').textContent = `${num(c.air_temperature)}°`;
  $('hero-cond').textContent = c.conditions || '';
  $('hero-hilo').textContent = `High ${num(d.air_temp_high)}° / Low ${num(d.air_temp_low)}°`;
  const muggy = c.dew_point >= 70 ? 'Very muggy' : c.dew_point >= 65 ? 'Muggy' : c.dew_point >= 55 ? 'Comfortable' : 'Dry';
  $('hero-feels').textContent = `Now · Feels like ${num(c.feels_like)}° · ${muggy}`;
  $('hero-sun').textContent = `Sunset ${timeStr(d.sunset)} · Sunrise ${timeStr(fc.forecast.daily[1]?.sunrise || d.sunrise)}`;
  const m = moon();
  $('hero-moon').textContent = `${m.name} · ${m.illum}%`;
  $('hero-icon').textContent = ({ 'clear-day': '☀️', 'clear-night': '🌙' }[c.icon]) || (c.icon?.includes('night') ? '🌙' : '⛅');
}

function renderStatus() {
  const last = history[history.length - 1];
  const v = last?.[I.battery];
  $('hero-batt').textContent = v ? `${num(v, 2)} V` : '';
  const ageMin = last ? (Date.now() / 1000 - last[I.time]) / 60 : 999;
  $('hero-live').className = ageMin < 10 ? 'live on' : 'live';
  $('hero-live').textContent = ageMin < 10 ? '● Live now' : `● ${Math.round(ageMin)}m old`;
}

// ---------- ticker ----------

function renderTicker(fc) {
  const items = [];
  const c = fc.current_conditions, hourly = fc.forecast.hourly.slice(0, 24);
  const maxPop = Math.max(...hourly.map((h) => h.precip_probability || 0));
  const firstWet = hourly.find((h) => (h.precip_probability || 0) >= 30);

  if (maxPop >= 20) items.push(['SIGNAL', `Rain chance peaks ${num(maxPop)}% in the next 24h`]);
  if (consensus != null) {
    const d = c.air_temperature - consensus;
    items.push(['REALITY', `Station running ${d >= 0 ? '+' : ''}${num(d, 1)}° vs model consensus`]);
  }
  const pTrend = trend(I.press, 3);
  if (pTrend != null) {
    items.push(['REALITY', `Pressure ${pTrend >= 0 ? 'rising' : 'falling'} ${num(Math.abs(pTrend), 2)} ${U.press()}/3h `
      + `${pTrend >= 0 ? 'favors drying' : 'supports the wetter short-range signal'}`]);
  }
  if (firstWet) items.push(['TIMING', `Storms are possible around ${timeStr(firstWet.time)}`]);
  const strikes = history.reduce((a, o) => a + (o[I.strikes] || 0), 0);
  if (strikes) items.push(['LIGHTNING', `${strikes} strikes detected in the last 3h`]);
  if (!items.length) items.push(['QUIET', 'No notable signals — steady conditions']);

  const html = items
    .map(([tag, text]) => `<span class="tick"><b>${tag}</b>${text}</span>`)
    .join('<span class="tick-sep">·</span>');
  const track = $('ticker-track');
  // two copies: the animation runs 0 → -50%, so the list wraps seamlessly instead of the first
  // item sliding off and never coming back.
  track.innerHTML = `${html}<span class="tick-sep">·</span>${html}`;
  // a short list on a wide screen already fits — scrolling it only hides text
  track.classList.toggle('still', track.scrollWidth / 2 <= track.clientWidth);
}

// ---------- trend strip ----------

// change per hour (or total over `hours` when perHour is false)
function trend(idx, hours, perHour = false) {
  if (history.length < 2) return null;
  const cutoff = Date.now() / 1000 - hours * 3600;
  const win = history.filter((o) => o[I.time] >= cutoff && o[idx] != null);
  if (win.length < 2) return null;
  const delta = win[win.length - 1][idx] - win[0][idx];
  const span = (win[win.length - 1][I.time] - win[0][I.time]) / 3600;
  return perHour ? delta / Math.max(span, 0.25) : delta;
}

function renderTrends(fc) {
  const c = fc.current_conditions;
  if (consensus != null) {
    const d = c.air_temperature - consensus;
    $('t-model').innerHTML = `<b>${num(c.air_temperature)}°</b> vs <b>${num(consensus)}°</b>`;
    $('t-model-sub').textContent = `${d >= 0 ? '+' : ''}${num(d)}° ${d >= 0 ? 'warmer' : 'cooler'} than models`;
  }
  const tph = trend(I.temp, 3, true);
  $('t-temp').textContent = tph == null ? '--' : `${tph >= 0 ? 'Warming' : 'Cooling'} ${num(Math.abs(tph), 1)}°/hr`;
  $('t-temp').className = tph >= 0 ? 'warm' : 'cool';
  const p = trend(I.press, 3);
  $('t-press').textContent = p == null ? '--' : `${p >= 0 ? 'Rising' : 'Falling'} ${num(Math.abs(p), 2)} ${U.press()} / 3h`;
  $('t-press').className = p >= 0 ? 'warm' : 'cool';
}

// ---------- 48h combined chart ----------

function render48(fc) {
  const hrs = fc.forecast.hourly.slice(0, 48);
  const temps = hrs.map((h) => h.air_temperature);
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const W = 1000, H = 90;
  const x = (i) => (i / (hrs.length - 1)) * (W - 20) + 10;
  const y = (t) => H - 12 - ((t - lo) / Math.max(hi - lo, 1)) * (H - 30);

  const path = hrs.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h.air_temperature).toFixed(1)}`).join('');
  // label every 6th hour
  const labels = hrs.map((h, i) => (i % 6 === 0
    ? `<text x="${x(i)}" y="${y(h.air_temperature) - 7}" class="c-lbl">${num(h.air_temperature)}°</text>` : '')).join('');
  $('c48-temp').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="#ff9d4f" stroke-width="2.5"/>${labels}</svg>`;

  const maxPop = Math.max(10, ...hrs.map((h) => h.precip_probability || 0));
  $('c48-rain').innerHTML = hrs.map((h, i) => {
    const pop = h.precip_probability || 0;
    return `<div class="rbar" title="${timeStr(h.time)} ${pop}%">
      <i style="height:${Math.max(3, (pop / maxPop) * 100)}%;opacity:${0.35 + 0.65 * (pop / maxPop)}"></i>
      ${i % 6 === 0 ? `<u>${num(pop)}%</u>` : ''}</div>`;
  }).join('');

  $('c48-wind').innerHTML = hrs.filter((_, i) => i % 2 === 0).map((h, j) => `<div class="wcell">
      <span class="warrow" style="transform:rotate(${(h.wind_direction || 0) + 180}deg)">↑</span>
      ${j % 3 === 0 ? `<u>${num(h.wind_avg)}</u>` : '<u></u>'}</div>`).join('');

  $('c48-axis').innerHTML = hrs.filter((_, i) => i % 6 === 0)
    .map((h, j) => `<span>${j === 0 ? 'Now' : new Date(h.time * 1000).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '')}</span>`).join('');

  const nextRain = hrs.find((h) => (h.precip_probability || 0) >= 30);
  $('c48-summary').innerHTML = `<div>48 hr forecast</div>
    <div class="big">${num(lo)}°–${num(hi)}°</div>
    <div>Peak rain ${num(Math.max(...hrs.map((h) => h.precip_probability || 0)))}%</div>
    <div>${nextRain ? `Next rain ${num(nextRain.precip_probability)}% ${timeStr(nextRain.time)}` : 'No rain signal'}</div>`;
}

// ---------- day cards ----------

// arc showing where the day's hi/lo sit inside a fixed temperature domain
function tempArc(lo, hi, domainLo = 0, domainHi = 110) {
  const f = (t) => Math.max(0, Math.min(1, (t - domainLo) / (domainHi - domainLo)));
  const R = 46, C = 2 * Math.PI * R;
  const start = f(lo), len = Math.max(0.04, f(hi) - f(lo));
  return `<svg class="daysvg" viewBox="0 0 110 110">
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="#253141" stroke-width="4"/>
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="#4fb8ff" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${(len * C).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-start * C).toFixed(1)}"
      transform="rotate(-90 55 55)"/></svg>`;
}

function renderDays(fc) {
  const days = fc.forecast.daily.slice(0, 6);
  const labels = ['Today', 'Tomorrow'];
  $('daycards').innerHTML = days.map((d, i) => {
    const date = new Date(d.day_start_local * 1000);
    const name = labels[i] || date.toLocaleDateString([], { weekday: 'short' });
    return `<div class="daycard">
      <div class="dc-head"><span>${name}</span><span class="muted">${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div>
      <div class="dc-body">
        ${tempArc(d.air_temp_low, d.air_temp_high)}
        <div class="dc-mid">
          <div class="dc-icon">${d.icon?.includes('thunder') ? '⛈️' : d.icon?.includes('rain') ? '🌧️' : d.icon?.includes('snow') ? '❄️' : d.icon?.includes('cloudy') ? '⛅' : '☀️'}</div>
          <div class="dc-temp"><b>${num(d.air_temp_high)}°</b><span>/${num(d.air_temp_low)}°</span></div>
          <div class="dc-cond">${d.conditions || ''}</div>
          <div class="dc-pop">${num(d.precip_probability)}%${d.precip_icon ? '' : ''}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ---------- dial gauges ----------

function ringSVG(frac, color, inner) {
  const R = 42, C = 2 * Math.PI * R;
  const f = Math.max(0, Math.min(1, frac || 0));
  return `<div class="gwrap"><svg viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="#253141" stroke-width="4"/>
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"
        stroke-dasharray="${(f * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/>
    </svg><div class="ginner">${inner}</div></div>`;
}

function renderGauges(fc) {
  const c = fc.current_conditions;
  const last = history[history.length - 1] || [];
  const metric = settings().units === 'metric';

  const windMax = metric ? 60 : 40;
  $('g-wind').innerHTML = ringSVG(c.wind_avg / windMax, '#4fdc8b',
    `<b>${num(c.wind_avg)}</b><small>${U.wind()}</small><span>1h gust ${num(c.wind_gust)} · ${deg2compass(c.wind_direction)}</span>`);

  const rain = c.precip_accum_local_day || 0;
  $('g-rain').innerHTML = ringSVG(rain / (metric ? 25 : 1), '#4fb8ff',
    `<b>${rain > 0 ? num(rain, 2) : 'Dry'}</b><span>${num(rain, 2)} ${U.precip()} today</span>`);

  const rhT = trend(I.rh, 3);
  $('g-hum').innerHTML = ringSVG(c.relative_humidity / 100, '#4fb8ff',
    `<b>${num(c.relative_humidity)}%</b><span>${rhT == null ? '' : `${rhT >= 0 ? '↑' : '↓'} ${num(Math.abs(rhT))} pts / 3h`}</span>`);

  const pLo = metric ? 970 : 28.5, pHi = metric ? 1040 : 31;
  const pT = trend(I.press, 3);
  $('g-press').innerHTML = ringSVG((c.sea_level_pressure - pLo) / (pHi - pLo), '#c9a6ff',
    `<b>${num(c.sea_level_pressure, 2)}</b><small>${U.press()}</small><span>${pT == null ? '' : `${pT >= 0 ? '↑' : '↓'} ${num(Math.abs(pT), 2)} / 3h`}</span>`);

  const dT = trend(I.temp, 3, true);
  $('g-dew').innerHTML = ringSVG(c.dew_point / (metric ? 30 : 85), '#4f8bff',
    `<b>${num(c.dew_point)}°</b><span>${dT == null ? '' : `${Math.abs(dT) < 0.3 ? '→ steady' : dT > 0 ? '↑ rising' : '↓ falling'} / 3h`}</span>`);

  $('g-uv').innerHTML = ringSVG(c.uv / 12, c.uv >= 8 ? '#ff5f56' : c.uv >= 6 ? '#ffb84f' : '#4fdc8b',
    `<b>UV ${num(c.uv)}</b><span>${uvWord(c.uv)}${c.solar_radiation ? ` · ${num(c.solar_radiation)} W/m²` : ''}</span>`);

  const strikes = history.reduce((a, o) => a + (o[I.strikes] || 0), 0);
  const dist = last[I.strikeDist];
  $('g-ltg').innerHTML = ringSVG(Math.min(strikes / 20, 1), '#ffb84f',
    `<b>${strikes || 'None'}</b><span>${strikes ? `nearest ${num(dist)} ${U.dist()} · 3h` : 'No strikes'}</span>`);

  const wb = c.wet_bulb_temperature;
  $('g-wet').innerHTML = ringSVG((wb - (metric ? 0 : 32)) / (metric ? 35 : 60), '#4fdc8b',
    `<b>${num(wb)}°</b><span>Air ${num(c.air_temperature)}°</span>`);
}

const uvWord = (v) => (v >= 11 ? 'Extreme' : v >= 8 ? 'Very high' : v >= 6 ? 'High' : v >= 3 ? 'Moderate' : 'Low');

// ---------- data plumbing ----------

async function loadHistory() {
  const s = settings();
  if (!s.deviceId || !/^\d+$/.test(s.deviceId)) return;
  const end = Math.floor(Date.now() / 1000);
  try {
    const j = await api.deviceObs(s.deviceId, end - 3 * 3600, end);
    history = j.obs || [];
    renderStatus();
  } catch { /* trends fall back to '--' */ }
}

async function loadConsensus() {
  try {
    const m = await api.multiModel();
    const now = Date.now();
    const times = m.hourly.time.map((t) => new Date(t).getTime());
    let i = 0;
    times.forEach((t, k) => { if (Math.abs(t - now) < Math.abs(times[i] - now)) i = k; });
    const vals = api.MODELS.split(',').map((k) => m.hourly[`temperature_2m_${k}`]?.[i]).filter((v) => v != null);
    consensus = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  } catch { consensus = null; }
}

export function renderPro(fc = deskForecast()) {
  if (!fc) return;
  renderHero(fc);
  renderTicker(fc);
  renderTrends(fc);
  render48(fc);
  renderDays(fc);
  renderGauges(fc);
}

export function initPro() {
  window.addEventListener('wd:forecast', (e) => renderPro(e.detail));
  every('pro-history', 300, async () => { await loadHistory(); renderPro(); });
  every('pro-consensus', 900, async () => { await loadConsensus(); renderPro(); });
  every('pro-clock', 60, () => { if (deskForecast()) renderHero(deskForecast()); });

  $('ticker-pause').onclick = () => {
    const t = $('ticker-track');
    const paused = t.style.animationPlayState === 'paused';
    t.style.animationPlayState = paused ? 'running' : 'paused';
    $('ticker-pause').textContent = paused ? '❚❚' : '▶';
  };
}
