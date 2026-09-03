// Desk layout matching myWeatherDesk: sky hero, signal ticker, trend strip,
// 48h combined chart, day cards, dial gauges. Driven by the wd:forecast event.
import * as api from './api.js';
import { settings, coords, U, num, timeStr, deg2compass, every, ecoOn, msToWind, windToMs, stormMode } from './app.js';
import { forecast as deskForecast, severeAlerts } from './desk.js';
import * as icon from './icons.js';
import { initLayout } from './layout.js';
import { normalToday } from './almanac.js';
import { setScene } from './fx.js';
import { setSky, moon, moonGlyph } from './sky.js';
import { tweenNumber, flash, enter } from './motion.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

let history = [];      // last 3h of device obs, for trends
let consensus = null;  // model temp at this hour
let qpf = null;        // open-meteo daily precipitation totals, for the day cards

const I = api.OBS;

// ---------- hero ----------

// "Sunset 8:14 PM" is a fact; "Sunset in 1h 14m" is the one people read across a room.
export function until(epochSec, now = Date.now() / 1000) {
  const m = Math.round((epochSec - now) / 60);
  if (m < 0 || m > 24 * 60) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderHero(fc) {
  const c = fc.current_conditions, d = fc.forecast.daily[0];
  setSky(Date.now() / 1000, d, fc.forecast.daily[1]);
  setText($('hero-place'), settings().stationName || 'Station');
  tweenNumber($('hero-temp'), c.air_temperature, (v) => `${num(v)}°`);
  setText($('hero-cond'), c.conditions || '');
  setText($('hero-hilo'), `High ${num(d.air_temp_high)}° / Low ${num(d.air_temp_low)}°`);
  // Visibility only comes from open-meteo (Tempest has no such field), so it stays optional.
  const vis = c.visibility == null ? ''
    : ` · ${num(settings().units === 'metric' ? c.visibility / 1000 : c.visibility / 1609.34, 1)} ${U.dist()} vis`;
  setText($('hero-feels'), `Now · Feels like ${num(c.feels_like)}° · ${muggyWord(c.dew_point)}${vis}`);
  const nextSunrise = fc.forecast.daily[1]?.sunrise || d.sunrise;
  const [nextName, nextAt] = Date.now() / 1000 < d.sunset ? ['Sunset', d.sunset] : ['Sunrise', nextSunrise];
  const soon = until(nextAt);
  setText($('hero-sun'), (soon ? `${nextName} in ${soon} · ` : '')
    + `Sunset ${timeStr(d.sunset)} · Sunrise ${timeStr(nextSunrise)}`);
  const m = moon();
  const moonHtml = `${moonGlyph(m.age)} ${m.name} · ${m.illum}%`;
  if ($('hero-moon').innerHTML !== moonHtml) $('hero-moon').innerHTML = moonHtml;
  setText($('hero-moonset'), `${m.nextName} ${m.nextDate.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric' })}`);
  setWx($('hero-icon'), c.icon, 150);
  setScene(c.icon);
  renderNormal(d);
}

// Dew point in whatever the display unit is: the words are °F thresholds, and a metric install
// read "Dry" through a tropical night.
function muggyWord(dp) {
  const f = settings().units === 'metric' ? dp * 9 / 5 + 32 : dp;
  return f >= 70 ? 'Very muggy' : f >= 65 ? 'Muggy' : f >= 55 ? 'Comfortable' : 'Dry';
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

// Under a Severe or Extreme warning the ticker stops being a signal strip and becomes the red
// crawl along the bottom of the screen — same element, same animation, different job.
let lastTicker = '';

function renderTicker(fc = deskForecast()) {
  const track = $('ticker-track');
  const strip = $('ticker');
  if (!track) return;
  const alerts = stormMode() ? severeAlerts() : [];
  if (alerts.length) {
    strip?.classList.add('alert');
    writeTicker(alerts.map(([event, headline]) =>
      `<span class="tick"><b>${event.toUpperCase()}</b>${headline}</span>`)
      .join('<span class="tick-sep">•</span>'));
    return;
  }
  strip?.classList.remove('alert');
  if (!fc) return;
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

  writeTicker(items
    .map(([tag, text]) => `<span class="tick"><b>${tag}</b>${text}</span>`)
    .join('<span class="tick-sep">·</span>'));
}

function writeTicker(html) {
  const track = $('ticker-track');
  if (lastTicker === html) return;
  lastTicker = html;
  // two copies: the animation runs 0 → -50%, so the list wraps seamlessly instead of the first
  // item sliding off and never coming back.
  track.innerHTML = `${html}<span class="tick-sep">·</span>${html}`;
  flash($('ticker'));
  // scrollWidth forces layout — do it once per real change, off the render path. A short list on
  // a wide screen already fits, and scrolling it only hides text.
  requestAnimationFrame(() => track.classList.toggle('still', track.scrollWidth / 2 <= track.clientWidth));
}

window.addEventListener('wd:storm', () => renderTicker());
window.addEventListener('resize', () => {
  const track = $('ticker-track');
  if (track) track.classList.toggle('still', track.scrollWidth / 2 <= track.clientWidth);
});

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

// Held per target so an identical redraw (every observation re-renders the Desk) is skipped:
// re-parsing the same SVG string is both the cost and the thing that restarted the draw-on.
const last48 = new Map();
function put48(id, html, cls = '') {
  const el = $(id);
  if (!el || last48.get(id) === html) return false;
  last48.set(id, html);
  el.innerHTML = html;
  if (cls) el.firstElementChild?.classList.add(cls);
  return true;
}

function render48(fc) {
  const hrs = fc.forecast.hourly.slice(0, 48);
  const temps = hrs.map((h) => h.air_temperature).filter((t) => t != null && !Number.isNaN(t));
  if (!temps.length) return;
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

  // A missing hour breaks the line rather than dragging it to NaN and blanking the whole chart.
  let pen = 'M';
  const path = hrs.map((h, i) => {
    if (h.air_temperature == null || Number.isNaN(h.air_temperature)) { pen = 'M'; return ''; }
    const seg = `${pen}${x(i).toFixed(1)},${y(h.air_temperature).toFixed(1)}`;
    pen = 'L';
    return seg;
  }).join('');
  // a dot and a reading every 6th hour, so the line has anchors instead of floating
  const marks = hrs.map((h, i) => (i % 6 === 0 && h.air_temperature != null
    ? `<circle cx="${x(i).toFixed(1)}" cy="${y(h.air_temperature).toFixed(1)}" r="3.5" fill="#0d141c"
         stroke="#ff9d4f" stroke-width="2"/>`
      + `<text x="${x(i).toFixed(1)}" y="${(y(h.air_temperature) + 16).toFixed(1)}" class="c-lbl">${num(h.air_temperature)}°</text>`
    : '')).join('');
  // `pathLength="1"` makes the dash length unit-free, so the draw-on is one CSS transition
  // whatever shape the line is.
  put48('c48-temp', `<svg viewBox="0 0 ${W} ${H}">
    ${bandPath}
    <path class="draw" pathLength="1" d="${path}" fill="none" stroke="#ff9d4f" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    ${marks}</svg>`);

  // dots, not bars: diameter carries the chance and a 0% hour still leaves a visible baseline
  const maxPop = Math.max(10, ...hrs.map((h) => h.precip_probability || 0));
  put48('c48-rain', hrs.map((h, i) => {
    const pop = h.precip_probability || 0;
    const d = 4 + (pop / maxPop) * 16;
    return `<div class="rbar" title="${timeStr(h.time)} ${pop}%">
      <i style="width:${d.toFixed(1)}px;height:${d.toFixed(1)}px;opacity:${(0.4 + 0.6 * (pop / maxPop)).toFixed(2)}"></i>
      ${i % 6 === 0 ? `<u>${num(pop)}%</u>` : ''}</div>`;
  }).join(''));

  put48('c48-wind', hrs.filter((_, i) => i % 2 === 0).map((h, j) => `<div class="wcell">
      <span class="warrow" style="transform:rotate(${(h.wind_direction || 0) + 180}deg)">↑</span>
      ${j % 3 === 0 ? `<u>${num(h.wind_avg)}</u>` : '<u></u>'}</div>`).join(''));
  setText($('c48-unit'), `°${settings().units === 'metric' ? 'C' : 'F'}`);
  setText($('c48-wunit'), U.wind());

  put48('c48-axis', hrs.filter((_, i) => i % 6 === 0)
    .map((h, j) => `<span>${j === 0 ? 'Now' : new Date(h.time * 1000).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '')}</span>`).join(''));

  const nextRain = hrs.find((h) => (h.precip_probability || 0) >= 30);
  put48('c48-summary', `<span>48 hr forecast</span>
    <span class="big">${num(lo)}°–${num(hi)}°</span>
    <span>Peak rain ${num(Math.max(...hrs.map((h) => h.precip_probability || 0)))}%</span>
    <span>${nextRain ? `Next rain ${num(nextRain.precip_probability)}% ${timeStr(nextRain.time)}` : 'No rain signal'}</span>`);
}

// ---------- day cards ----------

// arc showing where the day's hi/lo sit inside a fixed temperature domain
const ARC_R = 46, ARC_C = 2 * Math.PI * ARC_R;

// The domain the arc spans. It has to follow the unit switch, or every metric day card pinned
// itself to the bottom of a 0–110 °F scale.
const arcDomain = () => (settings().units === 'metric' ? [-20, 45] : [0, 110]);

function tempArc() {
  return `<svg class="daysvg" viewBox="0 0 110 110">
    <circle cx="55" cy="55" r="${ARC_R}" fill="none" stroke="#22303f" stroke-width="5"/>
    <circle data-arc cx="55" cy="55" r="${ARC_R}" fill="none" stroke="#4fb8ff" stroke-width="5" stroke-linecap="round"
      stroke-dasharray="0 ${ARC_C.toFixed(1)}" stroke-dashoffset="0"
      transform="rotate(-90 55 55)"/></svg>`;
}

function setArc(el, lo, hi) {
  if (!el || lo == null || hi == null) return;
  const [dLo, dHi] = arcDomain();
  const f = (t) => Math.max(0, Math.min(1, (t - dLo) / (dHi - dLo)));
  const start = f(lo), len = Math.max(0.04, f(hi) - f(lo));
  el.setAttribute('stroke-dasharray', `${(len * ARC_C).toFixed(1)} ${ARC_C.toFixed(1)}`);
  el.setAttribute('stroke-dashoffset', `${(-start * ARC_C).toFixed(1)}`);
}

// Six shells, built once. Rebuilding them every render threw away the panel grips (see the
// initLayout() call in renderPro), restarted every icon animation, and made the numbers
// un-tweenable.
function renderDays(fc) {
  const days = fc.forecast.daily.slice(0, 6);
  const labels = ['Today', 'Tomorrow'];
  const wrap = $('daycards');
  const built = wrap.children.length !== days.length;
  if (built) {
    wrap.innerHTML = days.map((_, i) => `<div class="daycard" data-panel="day-${i}">
      <div class="dc-head"><span class="dc-name"></span><span class="dc-date"></span></div>
      <div class="dc-body">
        ${tempArc()}
        <div class="dc-mid">
          <div class="dc-icon"></div>
          <div class="dc-temp"><b></b><span></span></div>
          <div class="dc-cond"></div>
          <div class="dc-pop"></div>
        </div>
      </div>
    </div>`).join('');
  }
  days.forEach((d, i) => {
    const card = wrap.children[i];
    if (!card) return;
    const date = new Date(d.day_start_local * 1000);
    const amount = qpf?.[i];
    setText(card.querySelector('.dc-name'), labels[i] || date.toLocaleDateString([], { weekday: 'short' }));
    setText(card.querySelector('.dc-date'), date.toLocaleDateString([], { month: 'short', day: 'numeric' }));
    setArc(card.querySelector('[data-arc]'), d.air_temp_low, d.air_temp_high);
    setWx(card.querySelector('.dc-icon'), d.icon, 30);
    tweenNumber(card.querySelector('.dc-temp b'), d.air_temp_high, (v) => `${num(v)}°`);
    tweenNumber(card.querySelector('.dc-temp span'), d.air_temp_low, (v) => `/${num(v)}°`);
    setText(card.querySelector('.dc-cond'), d.conditions || '');
    setText(card.querySelector('.dc-pop'),
      `${num(d.precip_probability)}%${amount != null ? ` · ${num(amount, 2)} ${U.precip()}` : ''}`);
  });
  return built;
}

// An icon written only when the key actually changed: assigning the same markup (or the same
// <img src>) restarts the animation, and the hero used to do that once a minute.
function setWx(box, key, size) {
  const want = `${key}|${document.documentElement.dataset.motion}`;
  if (!box || box.dataset.wx === want) return;
  box.dataset.wx = want;
  box.innerHTML = icon.wx(key, size);
}

// ---------- dial gauges ----------

// A gauge is its face plus the readout layered over it; the face decides what the value looks
// like (compass needle, barometer dial, filling droplet) rather than every quantity being a ring.
// The dial is decoration; the number inside it is the reading. Marked up that way, a screen
// reader reads "Wind 12 mph" instead of announcing an unlabelled graphic and then the text.
//
// Built once per face and updated in place from then on: rebuilding the SVG on every observation
// meant nothing could animate (a brand-new needle has nowhere to swing from) and it was the
// single biggest repaint on the page.
const FACE = {
  compass: (s) => icon.compass(s.deg, s.frac, s.color),
  ring: (s) => icon.ring(s.frac, s.color || '#4fb8ff'),
  rain: (s) => icon.rainRing(s.frac, s.on),
  dial: (s) => icon.dial(s.frac),
  droplet: (s) => icon.droplet(s.frac),
  uv: (s) => icon.uvRing((s.frac || 0) * 12),
  bolt: (s) => icon.boltRing(s.frac, s.on),
  therm: (s) => icon.thermometer(s.frac),
};

const setText = (el, txt) => { if (el && el.textContent !== txt) el.textContent = txt; };

function gauge(id, spec) {
  const box = $(id);
  if (!box) return;
  if (box.dataset.face !== spec.face) {
    box.dataset.face = spec.face;
    box.innerHTML = '<div class="gwrap"><span aria-hidden="true">' + FACE[spec.face](spec) + '</span>'
      + '<div class="ginner"><b></b><small></small><span></span></div></div>';
  }
  icon.update(box.querySelector('svg'), spec);
  const b = box.querySelector('.ginner > b');
  if (typeof spec.value === 'number' && Number.isFinite(spec.value)) {
    tweenNumber(b, spec.value, spec.fmt || ((v) => num(v)));
  } else {
    b._v = null;
    setText(b, spec.text ?? '--');
  }
  setText(box.querySelector('.ginner > small'), spec.unit || '');
  setText(box.querySelector('.ginner > span'), spec.sub || '');
}

// Sea-level pressure from the station's own obs (every `refreshSec`, 60s by default) rather than
// the forecast payload, which is rounded to two decimals and only refreshes every five minutes —
// on a quiet day the gauge looked frozen.
let slp = null;

function renderPress(v, label = 'sea level') {
  const metric = settings().units === 'metric';
  const pLo = metric ? 970 : 28.5, pHi = metric ? 1040 : 31;
  const pT = trend(I.press, 3);
  gauge('g-press', {
    face: 'dial', frac: (v - pLo) / (pHi - pLo),
    value: v, fmt: (x) => num(x, 2), unit: U.press(),
    sub: pT == null ? label : `${pT >= 0 ? '↑' : '↓'} ${num(Math.abs(pT), 2)} / 3h · ${pressWord(pT)}`,
  });
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
  gauge('g-wind', {
    face: 'compass', deg: c.wind_direction, frac: c.wind_avg / windMax,
    value: c.wind_avg, unit: U.wind(),
    sub: `1h gust ${num(c.wind_gust)} · ${deg2compass(c.wind_direction)}`,
  });

  const rain = c.precip_accum_local_day || 0;
  gauge('g-rain', {
    face: 'rain', frac: rain / (metric ? 25 : 1), on: rain > 0, color: rain > 0 ? '#4fb8ff' : '#33414f',
    value: rain > 0 ? rain : null, text: 'Dry', fmt: (x) => num(x, 2),
    sub: `${num(rain, 2)} ${U.precip()} today`,
  });

  const rhT = trend(I.rh, 3);
  gauge('g-hum', {
    face: 'ring', frac: c.relative_humidity / 100, color: '#4fb8ff',
    value: c.relative_humidity, fmt: (x) => `${num(x)}%`,
    sub: rhT == null ? '' : `${rhT >= 0 ? '↑' : '↓'} ${num(Math.abs(rhT))} pts / 3h`,
  });

  renderPress(slp ?? c.sea_level_pressure);

  const dT = trend(I.temp, 3, true);
  gauge('g-dew', {
    face: 'droplet', frac: c.dew_point / (metric ? 30 : 85),
    value: c.dew_point, fmt: (x) => `${num(x)}°`,
    sub: dT == null ? '' : `${Math.abs(dT) < 0.3 ? '→ steady' : dT > 0 ? '↑ rising' : '↓ falling'} / 3h`,
  });

  gauge('g-uv', {
    face: 'uv', frac: (c.uv || 0) / 12,
    value: c.uv, fmt: (x) => `UV ${num(x)}`,
    sub: `${uvWord(c.uv)}${c.solar_radiation ? ` · ${num(c.solar_radiation)} W/m²` : ''}`,
  });

  const strikes = history.reduce((a, o) => a + (o[I.strikes] || 0), 0);
  const dist = last[I.strikeDist];
  gauge('g-ltg', {
    face: 'bolt', frac: Math.min(strikes / 20, 1), on: strikes > 0,
    value: strikes || null, text: 'None',
    sub: strikes ? `nearest ${num(dist)} ${U.dist()} · 3h` : 'No strikes',
  });

  const wb = c.wet_bulb_temperature;
  gauge('g-wet', {
    face: 'therm', frac: (wb - (metric ? 0 : 32)) / (metric ? 35 : 60),
    value: wb, fmt: (x) => `${num(x)}°`, sub: `Air ${num(c.air_temperature)}°`,
  });

  const taC = metric ? c.air_temperature : (c.air_temperature - 32) / 1.8;
  const windMps = windToMs(c.wind_avg);
  const wbgt = wbgtC(taC, c.relative_humidity, c.solar_radiation || 0, windMps);
  const shown = wbgt == null ? null : metric ? wbgt : wbgt * 1.8 + 32;
  gauge('g-wbgt', {
    face: 'therm', frac: ((shown ?? 0) - (metric ? 0 : 32)) / (metric ? 35 : 60),
    value: shown, fmt: (x) => `${num(x)}°`,
    sub: shown == null ? 'no humidity' : `estimated · ${wbgtWord(metric ? shown * 1.8 + 32 : shown)}`,
  });
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
  performance.mark?.('renderPro-start');
  renderHero(fc);
  renderTicker(fc);
  renderTrends(fc);
  render48(fc);
  const builtDays = renderDays(fc);
  renderGauges(fc);
  // Only when the day-card shells were just created: they need their grips and saved sizes
  // attached, and initLayout walks every container. Every other render leaves them alone.
  if (builtDays) {
    initLayout();
    enter([...$('daycards').children]);
  }
  performance.mark?.('renderPro-end');
  try { performance.measure?.('renderPro', 'renderPro-start', 'renderPro-end'); } catch { /* marks cleared */ }
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
  const w = msToWind;
  const p = (mb) => (mb == null ? null : metric ? mb : mb * 0.02953);
  const r = (mm) => (mm == null ? null : metric ? mm : mm / 25.4);

  const temp = t(o[I.temp]), rh = o[I.rh];
  $('hero-place').textContent = settings().stationName
    || (settings().stationSource ? 'Local station' : 'Local station · UDP');
  tweenNumber($('hero-temp'), temp, (v) => `${num(v)}°`);
  setText($('hero-cond'), settings().stationSource ? 'Live · station report' : 'Live · hub broadcast');
  $('hero-live').className = 'live on';
  $('hero-live').textContent = settings().stationSource ? '● Live' : '● Live · UDP';
  $('hero-batt').textContent = o[I.battery] ? `${num(o[I.battery], 2)} V` : '';

  const windMax = metric ? 60 : 40;
  const avg = w(o[I.windAvg]), gust = w(o[I.windGust]), dir = o[I.windDir];
  gauge('g-wind', {
    face: 'compass', deg: dir, frac: avg / windMax,
    value: avg, unit: U.wind(), sub: `gust ${num(gust)} · ${deg2compass(dir)}`,
  });

  const rain = r(o[I.dayRain]) || 0;
  gauge('g-rain', {
    face: 'rain', frac: rain / (metric ? 25 : 1), on: rain > 0, color: rain > 0 ? '#4fb8ff' : '#33414f',
    value: rain > 0 ? rain : null, text: 'Dry', fmt: (x) => num(x, 2),
    sub: `${num(rain, 2)} ${U.precip()} today`,
  });

  gauge('g-hum', {
    face: 'ring', frac: rh / 100, color: '#4fb8ff',
    value: rh, fmt: (x) => `${num(x)}%`, sub: 'relative humidity',
  });

  // index 6 is the pressure at the sensor, not reduced to sea level — say so rather than let it
  // read as a barometer reading that disagrees with everyone else's.
  renderPress(p(o[I.press]), 'station pressure');

  const dpC = dewPointC(o[I.temp], o[I.rh]);
  if (dpC != null) {
    const dp = t(dpC);
    gauge('g-dew', {
      face: 'droplet', frac: dp / (metric ? 30 : 85),
      value: dp, fmt: (x) => `${num(x)}°`, sub: 'dew point',
    });
  }

  gauge('g-uv', {
    face: 'uv', frac: (o[I.uv] || 0) / 12,
    value: o[I.uv], fmt: (x) => `UV ${num(x)}`,
    sub: `${uvWord(o[I.uv])}${o[I.solar] ? ` · ${num(o[I.solar])} W/m²` : ''}`,
  });
}

// Module level, not inside initPro: initPro re-runs on every settings save and a listener per
// save stacks up. Both the websocket and the UDP poller dispatch wd:ws-obs; with a forecast in
// hand the normal render owns the screen and this does nothing.
window.addEventListener('wd:ws-obs', (e) => { if (!document.hidden && !deskForecast()) renderLocal(e.detail); });
window.addEventListener('wd:forecast', (e) => renderPro(e.detail));

// One dot per station source the LAN server is holding, hover for the /diag line itself. Nothing
// at all on a static host or a desktop with no server — there is no source to be healthy.
async function renderHealth() {
  const el = $('src-health');
  try {
    const d = await api.getJSON(`${window.__WD_SRV || ''}/diag`);
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
