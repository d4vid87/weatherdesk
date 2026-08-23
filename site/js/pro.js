// Desk layout matching myWeatherDesk: sky hero, signal ticker, trend strip,
// 48h combined chart, day cards, dial gauges. Driven by the wd:forecast event.
import * as api from './api.js';
import { settings, coords, U, num, timeStr, deg2compass, every, ecoOn } from './app.js';
import { forecast as deskForecast } from './desk.js';
import * as icon from './icons.js';
import { initLayout } from './layout.js';
import { normalToday } from './almanac.js';
import { setScene } from './fx.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

let history = [];      // last 3h of device obs, for trends
let consensus = null;  // model temp at this hour
let qpf = null;        // open-meteo daily precipitation totals, for the day cards

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
  // the next new or full moon, whichever comes first — the one date people actually plan around
  const toNew = SYNODIC - age;
  const toFull = (SYNODIC / 2 - age + SYNODIC) % SYNODIC;
  const [nextName, days] = toNew < toFull ? ['New moon', toNew] : ['Full moon', toFull];
  return { age, illum, name, nextName, nextDate: new Date(Date.now() + days * 86400000) };
}

// a lit disc drawn with two arcs — the terminator is an ellipse whose width is the illuminated
// fraction, which is exactly how the phase looks from the ground
function moonGlyph(age, size = 13) {
  const f = age / SYNODIC;
  const r = size / 2 - 1;
  const k = Math.abs(Math.cos(2 * Math.PI * f));
  const waxing = f < 0.5;
  const sweep = waxing ? 1 : 0;
  const inner = f < 0.25 || f > 0.75 ? sweep : 1 - sweep;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:-2px">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#ffffff33"/>
    <path fill="#eef4ff" d="M ${size / 2} ${size / 2 - r}
      A ${r} ${r} 0 0 ${sweep} ${size / 2} ${size / 2 + r}
      A ${(r * k).toFixed(2)} ${r} 0 0 ${inner} ${size / 2} ${size / 2 - r} z"/>
  </svg>`;
}

// "Sunset 8:14 PM" is a fact; "Sunset in 1h 14m" is the one people read across a room.
export function until(epochSec, now = Date.now() / 1000) {
  const m = Math.round((epochSec - now) / 60);
  if (m < 0 || m > 24 * 60) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderHero(fc) {
  const c = fc.current_conditions, d = fc.forecast.daily[0];
  const [a, b] = skyFor(Date.now() / 1000, d.sunrise, d.sunset);
  $('hero').style.background = `linear-gradient(160deg, ${a}, ${b})`;
  $('hero-place').textContent = settings().stationName || 'Station';
  $('hero-temp').textContent = `${num(c.air_temperature)}°`;
  $('hero-cond').textContent = c.conditions || '';
  $('hero-hilo').textContent = `High ${num(d.air_temp_high)}° / Low ${num(d.air_temp_low)}°`;
  const muggy = c.dew_point >= 70 ? 'Very muggy' : c.dew_point >= 65 ? 'Muggy' : c.dew_point >= 55 ? 'Comfortable' : 'Dry';
  // Visibility only comes from open-meteo (Tempest has no such field), so it stays optional.
  const vis = c.visibility == null ? ''
    : ` · ${num(settings().units === 'metric' ? c.visibility / 1000 : c.visibility / 1609.34, 1)} ${U.dist()} vis`;
  $('hero-feels').textContent = `Now · Feels like ${num(c.feels_like)}° · ${muggy}${vis}`;
  const nextSunrise = fc.forecast.daily[1]?.sunrise || d.sunrise;
  const [nextName, nextAt] = Date.now() / 1000 < d.sunset ? ['Sunset', d.sunset] : ['Sunrise', nextSunrise];
  const soon = until(nextAt);
  $('hero-sun').textContent = (soon ? `${nextName} in ${soon} · ` : '')
    + `Sunset ${timeStr(d.sunset)} · Sunrise ${timeStr(nextSunrise)}`;
  const m = moon();
  $('hero-moon').innerHTML = `${moonGlyph(m.age)} ${m.name} · ${m.illum}%`;
  $('hero-moonset').textContent = `${m.nextName} ${m.nextDate.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
  $('hero-icon').innerHTML = icon.wxHero(c.icon, 150);
  setScene(c.icon);
  renderNormal(d);
}

// "68°" is a number; "68°, five below normal for the date" is the sentence. Thirty years of
// reanalysis, fetched once and kept — see api.normals().
async function renderNormal(d) {
  const n = await normalToday().catch(() => null);
  const el = $('hero-normal');
  if (!n || d.air_temp_high == null) { el.textContent = ''; return; }
  const diff = d.air_temp_high - n.hi;
  const word = Math.abs(diff) < 1 ? 'right at normal'
    : `${num(Math.abs(diff))}° ${diff > 0 ? 'above' : 'below'} normal`;
  el.textContent = `Normal high ${num(n.hi)}° — today is ${word}`;
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

// NWS 3-hour tendency bands. A number alone doesn't say whether 0.03 inHg matters; the word does.
function pressWord(delta) {
  if (delta == null) return '';
  const metric = settings().units === 'metric';
  const a = Math.abs(delta);
  if (a < (metric ? 0.7 : 0.02)) return 'steady';
  const rate = a >= (metric ? 2.0 : 0.06) ? 'rapidly' : 'slowly';
  return `${delta > 0 ? 'rising' : 'falling'} ${rate}`;
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
  $('t-press').textContent = p == null ? '--' : `${pressWord(p).replace(/^./, (m) => m.toUpperCase())} · ${num(Math.abs(p), 2)} ${U.press()} / 3h`;
  $('t-press').className = p >= 0 ? 'warm' : 'cool';
}

// ---------- 48h combined chart ----------

// The spread of the GFS ensemble, shaded behind the deterministic line. A single line has always
// looked more certain than any forecast is; this is the honest version of the same picture.
let band = [];
async function loadEnsemble() {
  if (coords().lat == null) return; // no station yet — nothing to ask about
  try {
    band = api.ensembleBand(await api.ensemble());
  } catch {
    band = [];
  }
  if (deskForecast()) render48(deskForecast());
}

function render48(fc) {
  const hrs = fc.forecast.hourly.slice(0, 48);
  const temps = hrs.map((h) => h.air_temperature);
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const W = 1000, H = 90;
  const x = (i) => (i / (hrs.length - 1)) * (W - 20) + 10;
  const y = (t) => H - 12 - ((t - lo) / Math.max(hi - lo, 1)) * (H - 30);

  // The band is on its own hourly grid; line it up by timestamp and clamp to the drawn box, so
  // an outlying member widens the shading rather than rescaling the whole chart.
  const clamp = (v) => Math.max(0, Math.min(H, y(v)));
  const at = (t) => band.find((b) => Math.abs(b.x / 1000 - t) < 1800);
  const spread = hrs.map((h, i) => ({ i, b: at(h.time) })).filter((p) => p.b && p.b.lo != null);
  const bandPath = spread.length > 2
    ? `<path d="${spread.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${clamp(p.b.hi).toFixed(1)}`).join('')}`
      + `${spread.slice().reverse().map((p) => `L${x(p.i).toFixed(1)},${clamp(p.b.lo).toFixed(1)}`).join('')}Z"`
      + ' fill="#ff9d4f" opacity="0.18"/>'
    : '';

  const path = hrs.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h.air_temperature).toFixed(1)}`).join('');
  // a dot and a reading every 6th hour, so the line has anchors instead of floating
  const marks = hrs.map((h, i) => (i % 6 === 0
    ? `<circle cx="${x(i).toFixed(1)}" cy="${y(h.air_temperature).toFixed(1)}" r="3.5" fill="#0d141c"
         stroke="#ff9d4f" stroke-width="2"/>`
      + `<text x="${x(i).toFixed(1)}" y="${(y(h.air_temperature) + 16).toFixed(1)}" class="c-lbl">${num(h.air_temperature)}°</text>`
    : '')).join('');
  $('c48-temp').innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${bandPath}
    <path d="${path}" fill="none" stroke="#ff9d4f" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    ${marks}</svg>`;

  // dots, not bars: diameter carries the chance and a 0% hour still leaves a visible baseline
  const maxPop = Math.max(10, ...hrs.map((h) => h.precip_probability || 0));
  $('c48-rain').innerHTML = hrs.map((h, i) => {
    const pop = h.precip_probability || 0;
    const d = 4 + (pop / maxPop) * 16;
    return `<div class="rbar" title="${timeStr(h.time)} ${pop}%">
      <i style="width:${d.toFixed(1)}px;height:${d.toFixed(1)}px;opacity:${(0.4 + 0.6 * (pop / maxPop)).toFixed(2)}"></i>
      ${i % 6 === 0 ? `<u>${num(pop)}%</u>` : ''}</div>`;
  }).join('');

  $('c48-wind').innerHTML = hrs.filter((_, i) => i % 2 === 0).map((h, j) => `<div class="wcell">
      <span class="warrow" style="transform:rotate(${(h.wind_direction || 0) + 180}deg)">↑</span>
      ${j % 3 === 0 ? `<u>${num(h.wind_avg)}</u>` : '<u></u>'}</div>`).join('');
  $('c48-unit').textContent = `°${settings().units === 'metric' ? 'C' : 'F'}`;
  $('c48-wunit').textContent = U.wind();

  $('c48-axis').innerHTML = hrs.filter((_, i) => i % 6 === 0)
    .map((h, j) => `<span>${j === 0 ? 'Now' : new Date(h.time * 1000).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '')}</span>`).join('');

  const nextRain = hrs.find((h) => (h.precip_probability || 0) >= 30);
  $('c48-summary').innerHTML = `<span>48 hr forecast</span>
    <span class="big">${num(lo)}°–${num(hi)}°</span>
    <span>Peak rain ${num(Math.max(...hrs.map((h) => h.precip_probability || 0)))}%</span>
    <span>${nextRain ? `Next rain ${num(nextRain.precip_probability)}% ${timeStr(nextRain.time)}` : 'No rain signal'}</span>`;
}

// ---------- day cards ----------

// arc showing where the day's hi/lo sit inside a fixed temperature domain
function tempArc(lo, hi, domainLo = 0, domainHi = 110) {
  const f = (t) => Math.max(0, Math.min(1, (t - domainLo) / (domainHi - domainLo)));
  const R = 46, C = 2 * Math.PI * R;
  const start = f(lo), len = Math.max(0.04, f(hi) - f(lo));
  return `<svg class="daysvg" viewBox="0 0 110 110">
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="#22303f" stroke-width="5"/>
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="#4fb8ff" stroke-width="5" stroke-linecap="round"
      stroke-dasharray="${(len * C).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-start * C).toFixed(1)}"
      transform="rotate(-90 55 55)"/></svg>`;
}

function renderDays(fc) {
  const days = fc.forecast.daily.slice(0, 6);
  const labels = ['Today', 'Tomorrow'];
  $('daycards').innerHTML = days.map((d, i) => {
    const date = new Date(d.day_start_local * 1000);
    const name = labels[i] || date.toLocaleDateString([], { weekday: 'short' });
    const amount = qpf?.[i];
    return `<div class="daycard" data-panel="day-${i}">
      <div class="dc-head"><span>${name}</span><span>${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></div>
      <div class="dc-body">
        ${tempArc(d.air_temp_low, d.air_temp_high)}
        <div class="dc-mid">
          <div class="dc-icon">${icon.wx(d.icon, 30)}</div>
          <div class="dc-temp"><b>${num(d.air_temp_high)}°</b><span>/${num(d.air_temp_low)}°</span></div>
          <div class="dc-cond">${d.conditions || ''}</div>
          <div class="dc-pop">${num(d.precip_probability)}%${amount != null ? ` · ${num(amount, 2)} ${U.precip()}` : ''}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ---------- dial gauges ----------

// A gauge is its face plus the readout layered over it; the face decides what the value looks
// like (compass needle, barometer dial, filling droplet) rather than every quantity being a ring.
// The dial is decoration; the number inside it is the reading. Marked up that way, a screen
// reader reads "Wind 12 mph" instead of announcing an unlabelled graphic and then the text.
const gauge = (face, inner) => `<div class="gwrap">`
  + `<span aria-hidden="true">${face}</span><div class="ginner">${inner}</div></div>`;

// Sea-level pressure from the station's own obs (every `refreshSec`, 60s by default) rather than
// the forecast payload, which is rounded to two decimals and only refreshes every five minutes —
// on a quiet day the gauge looked frozen.
let slp = null;

function renderPress(v, label = 'sea level') {
  const metric = settings().units === 'metric';
  const pLo = metric ? 970 : 28.5, pHi = metric ? 1040 : 31;
  const pT = trend(I.press, 3);
  $('g-press').innerHTML = gauge(icon.dial((v - pLo) / (pHi - pLo)),
    `<b>${num(v, 2)}</b><small>${U.press()}</small><span>${pT == null ? label : `${pT >= 0 ? '↑' : '↓'} ${num(Math.abs(pT), 2)} / 3h · ${pressWord(pT)}`}</span>`);
}

window.addEventListener('wd:obs', (e) => {
  const v = e.detail?.sea_level_pressure;
  if (v == null) return;
  slp = v;
  if (deskForecast()) renderPress(v);
});

function renderGauges(fc) {
  const c = fc.current_conditions;
  const last = history[history.length - 1] || [];
  const metric = settings().units === 'metric';

  const windMax = metric ? 60 : 40;
  $('g-wind').innerHTML = gauge(icon.compass(c.wind_direction, c.wind_avg / windMax),
    `<b>${num(c.wind_avg)}</b><small>${U.wind()}</small><span>1h gust ${num(c.wind_gust)} · ${deg2compass(c.wind_direction)}</span>`);

  const rain = c.precip_accum_local_day || 0;
  $('g-rain').innerHTML = gauge(icon.rainRing(rain / (metric ? 25 : 1), rain > 0),
    `<b>${rain > 0 ? num(rain, 2) : 'Dry'}</b><span>${num(rain, 2)} ${U.precip()} today</span>`);

  const rhT = trend(I.rh, 3);
  $('g-hum').innerHTML = gauge(icon.ring(c.relative_humidity / 100, '#4fb8ff'),
    `<b>${num(c.relative_humidity)}%</b><span>${rhT == null ? '' : `${rhT >= 0 ? '↑' : '↓'} ${num(Math.abs(rhT))} pts / 3h`}</span>`);

  renderPress(slp ?? c.sea_level_pressure);

  const dT = trend(I.temp, 3, true);
  $('g-dew').innerHTML = gauge(icon.droplet(c.dew_point / (metric ? 30 : 85)),
    `<b>${num(c.dew_point)}°</b><span>${dT == null ? '' : `${Math.abs(dT) < 0.3 ? '→ steady' : dT > 0 ? '↑ rising' : '↓ falling'} / 3h`}</span>`);

  $('g-uv').innerHTML = gauge(icon.uvRing(c.uv),
    `<b>UV ${num(c.uv)}</b><span>${uvWord(c.uv)}${c.solar_radiation ? ` · ${num(c.solar_radiation)} W/m²` : ''}</span>`);

  const strikes = history.reduce((a, o) => a + (o[I.strikes] || 0), 0);
  const dist = last[I.strikeDist];
  $('g-ltg').innerHTML = gauge(icon.boltRing(Math.min(strikes / 20, 1), strikes > 0),
    `<b>${strikes || 'None'}</b><span>${strikes ? `nearest ${num(dist)} ${U.dist()} · 3h` : 'No strikes'}</span>`);

  const wb = c.wet_bulb_temperature;
  $('g-wet').innerHTML = gauge(icon.thermometer((wb - (metric ? 0 : 32)) / (metric ? 35 : 60)),
    `<b>${num(wb)}°</b><span>Air ${num(c.air_temperature)}°</span>`);

  const taC = metric ? c.air_temperature : (c.air_temperature - 32) / 1.8;
  const windMps = c.wind_avg / (metric ? 3.6 : 2.23694);
  const wbgt = wbgtC(taC, c.relative_humidity, c.solar_radiation || 0, windMps);
  const shown = wbgt == null ? null : metric ? wbgt : wbgt * 1.8 + 32;
  $('g-wbgt').innerHTML = gauge(icon.thermometer(((shown ?? 0) - (metric ? 0 : 32)) / (metric ? 35 : 60)),
    `<b>${shown == null ? '--' : num(shown)}°</b><span>${shown == null ? 'no humidity' : `estimated · ${wbgtWord(metric ? shown * 1.8 + 32 : shown)}`}</span>`);
}

const uvWord = (v) => (v >= 11 ? 'Extreme' : v >= 8 ? 'Very high' : v >= 6 ? 'High' : v >= 3 ? 'Moderate' : 'Low');

// ---------- data plumbing ----------

async function loadHistory() {
  const s = settings();
  const end = Math.floor(Date.now() / 1000);
  try {
    // A Tempest reads its own three hours back out of WeatherFlow; every other brand reads them
    // out of this server's archive, which is where its reports were stored on the way in. Same
    // tuples either way, so the trends, the arrows and the ticker don't know the difference.
    let j = null;
    // stationSource first: a leftover Tempest deviceId from an earlier setup would otherwise
    // send a Davis owner to WeatherFlow for history and every row would come back empty.
    if (s.stationSource) j = await api.localObs(3);
    else if (s.deviceId && /^\d+$/.test(s.deviceId)) j = await api.deviceObs(s.deviceId, end - 3 * 3600, end);
    if (!j) return;
    history = j.obs || [];
    renderStatus();
  } catch { /* trends fall back to '--' */ }
}

async function loadConsensus() {
  if (coords().lat == null) return;
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

async function loadQpf() {
  if (coords().lat == null) return;
  try {
    const j = await api.dailyPrecip();
    qpf = j.daily?.precipitation_sum || null;
  } catch { qpf = null; }
}

export function renderPro(fc = deskForecast()) {
  if (!fc) return;
  renderHero(fc);
  renderTicker(fc);
  renderTrends(fc);
  render48(fc);
  renderDays(fc);
  renderGauges(fc);
  // the day cards are rebuilt from scratch each render, so their grips and saved sizes have to
  // be reattached; initLayout skips anything already wired.
  initLayout();
}

// ---------- UDP-only mode ----------
//
// With a hub on the LAN and no token there is no forecast at all, but the hub still broadcasts
// everything the sensors measure. Fill the parts of the hero and the gauges that come straight
// off the sensor and leave the rest alone — hi/lo, sun, moon and feels-like are forecast data
// and there is nothing honest to put there.
//
// obs_st is SI on the wire by design (MQTT depends on it), so convert here.
// Magnus formula — the hub sends temperature and humidity, not dew point. °C in, °C out.
function dewPointC(c, rh) {
  if (c == null || !(rh > 0)) return null;
  const g = (17.625 * c) / (243.04 + c) + Math.log(rh / 100);
  return (243.04 * g) / (17.625 - g);
}

// Wet-bulb temperature from air temperature and humidity, Stull (2011). Within a few tenths of
// a degree over the range a weather station sees.
function wetBulbC(c, rh) {
  if (c == null || !(rh > 0)) return null;
  return c * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
    + Math.atan(c + rh) - Math.atan(rh - 1.676331)
    + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
}

// Wet Bulb Globe Temperature — the heat-stress number the military, athletics and OSHA use,
// because it accounts for sun and wind where the heat index doesn't.
//
// ponytail: an estimate, because the real instrument is a 15 cm black globe nobody has in their
// garden. The ISO weighting is exact; what is estimated is the globe temperature, from solar and
// wind (Hunter & Minyard) — sun heats the globe, wind carries it away, which is the whole reason
// WBGT says something the heat index doesn't. Out of the sun the globe reads air temperature and
// the weighting collapses to the indoor form. Swap in Liljegren if somebody turns up with a real
// globe to compare against.
export function wbgtC(taC, rh, solar = 0, windMps = 1) {
  if (taC == null || !(rh > 0)) return null;
  const tw = wetBulbC(taC, rh);
  if (tw == null) return null;
  if (!(solar >= 100)) return 0.7 * tw + 0.3 * taC;
  const tg = taC + 0.021 * solar - 0.42 * Math.max(windMps, 0) + 3.6;
  return 0.7 * tw + 0.2 * tg + 0.1 * taC;
}

// The NWS flag categories, in °F.
const wbgtWord = (f) => (f >= 90 ? 'Extreme' : f >= 88 ? 'Very high' : f >= 85 ? 'High' : f >= 80 ? 'Moderate' : 'Low');

function renderLocal(o) {
  const metric = settings().units === 'metric';
  const t = (c) => (c == null ? null : metric ? c : c * 9 / 5 + 32);
  const w = (mps) => (mps == null ? null : mps * (metric ? 3.6 : 2.23694));
  const p = (mb) => (mb == null ? null : metric ? mb : mb * 0.02953);
  const r = (mm) => (mm == null ? null : metric ? mm : mm / 25.4);

  const temp = t(o[I.temp]), rh = o[I.rh];
  $('hero-place').textContent = settings().stationName
    || (settings().stationSource ? 'Local station' : 'Local station · UDP');
  $('hero-temp').textContent = `${num(temp)}°`;
  $('hero-cond').textContent = settings().stationSource ? 'Live · station report' : 'Live · hub broadcast';
  $('hero-live').className = 'live on';
  $('hero-live').textContent = settings().stationSource ? '● Live' : '● Live · UDP';
  $('hero-batt').textContent = o[I.battery] ? `${num(o[I.battery], 2)} V` : '';

  const windMax = metric ? 60 : 40;
  const avg = w(o[I.windAvg]), gust = w(o[I.windGust]), dir = o[I.windDir];
  $('g-wind').innerHTML = gauge(icon.compass(dir, avg / windMax),
    `<b>${num(avg)}</b><small>${U.wind()}</small><span>gust ${num(gust)} · ${deg2compass(dir)}</span>`);

  const rain = r(o[I.dayRain]) || 0;
  $('g-rain').innerHTML = gauge(icon.rainRing(rain / (metric ? 25 : 1), rain > 0),
    `<b>${rain > 0 ? num(rain, 2) : 'Dry'}</b><span>${num(rain, 2)} ${U.precip()} today</span>`);

  $('g-hum').innerHTML = gauge(icon.ring(rh / 100, '#4fb8ff'), `<b>${num(rh)}%</b><span>relative humidity</span>`);

  // index 6 is the pressure at the sensor, not reduced to sea level — say so rather than let it
  // read as a barometer reading that disagrees with everyone else's.
  renderPress(p(o[I.press]), 'station pressure');

  const dpC = dewPointC(o[I.temp], o[I.rh]);
  if (dpC != null) {
    const dp = t(dpC);
    $('g-dew').innerHTML = gauge(icon.droplet(dp / (metric ? 30 : 85)), `<b>${num(dp)}°</b><span>dew point</span>`);
  }

  $('g-uv').innerHTML = gauge(icon.uvRing(o[I.uv]),
    `<b>UV ${num(o[I.uv])}</b><span>${uvWord(o[I.uv])}${o[I.solar] ? ` · ${num(o[I.solar])} W/m²` : ''}</span>`);
}

// Module level, not inside initPro: initPro re-runs on every settings save and a listener per
// save stacks up. Both the websocket and the UDP poller dispatch wd:ws-obs; with a forecast in
// hand the normal render owns the screen and this does nothing.
window.addEventListener('wd:ws-obs', (e) => { if (!deskForecast()) renderLocal(e.detail); });
window.addEventListener('wd:forecast', (e) => renderPro(e.detail));

// One dot per station source the LAN server is holding, hover for the /diag line itself. Nothing
// at all on a static host or a desktop with no server — there is no source to be healthy.
async function renderHealth() {
  const el = $('src-health');
  try {
    const d = await (await fetch(`${window.__WD_SRV || ''}/diag`)).json();
    el.innerHTML = Object.entries(d).map(([src, v]) => {
      const ago = Math.max(0, Math.round(Date.now() / 1000 - v.at));
      const cls = !v.ok ? 'bad' : ago > 600 ? 'stale' : '';
      return `<i class="${cls}" title="${src} · ${v.rows} rows · ${v.what} · ${ago}s ago"></i>`;
    }).join('');
  } catch { el.innerHTML = ''; }
}

// Re-registered on every settings change: `every` keys by name, so the eco pace and the seconds
// format both follow the toggle without a reload.
export function registerClock() {
  const eco = ecoOn();
  every('clock', eco ? 30 : 1, () => {
    const d = new Date();
    const h12 = settings().clock24 === 'auto' || !settings().clock24 ? {} : { hour12: settings().clock24 === '12' };
    $('clock-time').textContent = d.toLocaleTimeString([], eco
      ? { hour: 'numeric', minute: '2-digit', ...h12 }
      : { hour: 'numeric', minute: '2-digit', second: '2-digit', ...h12 });
    $('clock-date').textContent = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  });
}

export function initPro() {
  every('pro-health', 300, renderHealth);
  every('pro-history', 300, async () => { await loadHistory(); renderPro(); });
  every('pro-consensus', 900, async () => { await loadConsensus(); renderPro(); });
  every('pro-qpf', 1800, async () => { await loadQpf(); renderPro(); });
  every('pro-ensemble', 1800, loadEnsemble);
  // A second hand is a repaint a second, forever — the single most expensive idle thing on the
  // page. In eco the seconds go and so does 29 of every 30 repaints.
  registerClock();
  // The eco toggle changes both the pace and the seconds format; re-register instead of reloading.
  window.addEventListener('wd:settings', registerClock);
  every('pro-clock', 60, () => { if (deskForecast()) renderHero(deskForecast()); });

  // A class, not an inline style: inline would outrank the rule that stops the animation whenever
  // the Desk isn't the section on screen.
  $('ticker-pause').onclick = () => {
    const paused = $('ticker-track').classList.toggle('paused');
    $('ticker-pause').textContent = paused ? '▶' : '❚❚';
  };
}

// ponytail-lite self-check: the only arithmetic here that isn't a straight unit multiply.
if (location.search.includes('selftest')) {
  console.assert(until(Date.now() / 1000 + 5400) === '1h 30m', 'pro: 90 minutes reads as 1h 30m');
  console.assert(until(Date.now() / 1000 - 60) === '', 'pro: a past event has no countdown');
  console.assert(Math.abs(dewPointC(20, 100) - 20) < 0.1, 'pro: saturated air dews at the air temperature');
  console.assert(Math.abs(dewPointC(20, 50) - 9.3) < 0.3, 'pro: 20°C at 50% dews near 9.3°C');
  console.assert(dewPointC(20, 0) === null, 'pro: no humidity, no dew point');
  console.assert(Math.abs(wetBulbC(20, 50) - 13.7) < 0.5, 'pro: 20°C at 50% wet-bulbs near 13.7°C');
  const sun = wbgtC(35, 50, 800, 1);
  console.assert(sun > 31 && sun < 35, 'pro: 35°C/50% in full sun is an extreme WBGT', sun);
  console.assert(wbgtC(35, 50, 0, 1) < sun, 'pro: shade must read cooler than sun');
  console.assert(wbgtC(35, 50, 800, 8) < sun, 'pro: wind must carry heat off the globe');
  console.assert(wbgtC(20, 0, 500, 1) === null, 'pro: no humidity, no WBGT');
}
