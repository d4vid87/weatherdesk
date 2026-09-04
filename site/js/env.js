// 07 Environment — sun and moon detail, fire/dryness, the garden, and the station's own health.
//
// Everything here is either arithmetic on numbers the dashboard already has, or a keyless
// endpoint. No new token, no new account: the point of these cards is that they cost nothing to
// keep on screen all day.
import { settings, coords, U, num, notify, every, stamp, expires } from './app.js';
import { forecast as deskForecast } from './desk.js';
import * as api from './api.js';
import { OBS, getJSON } from './api.js';
import { toDisplay } from './almanac.js';

const $ = (id) => document.getElementById(id);
const rad = Math.PI / 180;

// --- solar position (NOAA low-precision equations, good to about a minute) ---

// Sun altitude in degrees, for a moment and a place. Golden hour and blue hour are just two
// bands of this number, so one function answers both and neither needs a table.
export function solarAltitude(date, lat, lon) {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const L = (280.460 + 0.9856474 * d) % 360;
  const g = ((357.528 + 0.9856003 * d) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * d) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon - ra + 540) % 360 - 180) * rad;
  const phi = lat * rad;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) / rad;
}

// When the sun last crossed `deg` on its way through `hours` either side of `around`. Scanned a
// minute at a time rather than solved: the inverse has three special cases (polar day, polar
// night, an altitude the sun never reaches) and the scan has none.
export function crossing(around, lat, lon, deg, rising) {
  const step = 60000;
  let prev = null;
  for (let t = around.getTime() - 3 * 3600000; t <= around.getTime() + 3 * 3600000; t += step) {
    const alt = solarAltitude(new Date(t), lat, lon);
    if (prev != null) {
      const up = alt > prev;
      if (up === rising && (prev - deg) * (alt - deg) <= 0) return new Date(t);
    }
    prev = alt;
  }
  return null;
}

const hhmm = (d) => (d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--');

function renderSky() {
  const fc = deskForecast();
  const c = coords();
  if (!fc || c.lat == null) return;
  const [today, tomorrow] = fc.forecast.daily;
  if (!today?.sunrise) return;

  const sunrise = new Date(today.sunrise * 1000);
  const sunset = new Date(today.sunset * 1000);
  // Golden hour ends at 6° up in the morning and starts at 6° up in the evening; below the
  // horizon to -4° is the blue hour on either side.
  const morningGolden = crossing(sunrise, c.lat, c.lon, 6, true);
  const eveningGolden = crossing(sunset, c.lat, c.lon, 6, false);

  const len = today.sunset - today.sunrise;
  const nextLen = tomorrow?.sunset ? tomorrow.sunset - tomorrow.sunrise : null;
  const delta = nextLen == null ? null : nextLen - len;
  const mins = (s) => `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;

  const rows = [
    ['Sunrise', hhmm(sunrise)],
    ['Golden hour ends', hhmm(morningGolden)],
    ['Golden hour starts', hhmm(eveningGolden)],
    ['Sunset', hhmm(sunset)],
    ['Daylight', mins(len)],
    delta == null ? null
      : ['Tomorrow', `${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(delta / 60))} min`],
    moonTimes ? ['Moonrise', hhmm(moonTimes.rise)] : null,
    moonTimes ? ['Moonset', hhmm(moonTimes.set)] : null,
  ].filter(Boolean);
  $('sky').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
  stamp('sky', 3600);
}

// --- moon rise/set: MET Norway, keyless, once a day ---
//
// The phase and illumination are already worked out locally in pro.js; only the rise and set
// times want ephemerides, and one request a day is cheaper than carrying Meeus.
let moonTimes = null;
async function loadMoon() {
  const c = coords();
  if (c.lat == null) return;
  const day = new Date().toISOString().slice(0, 10);
  const off = -new Date().getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  const url = `https://api.met.no/weatherapi/sunrise/3.0/moon?lat=${(+c.lat).toFixed(4)}&lon=${(+c.lon).toFixed(4)}&date=${day}&offset=${encodeURIComponent(offset)}`;
  const r = await fetch(url, { signal: expires(15000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const p = (await r.json()).properties || {};
  moonTimes = {
    rise: p.moonrise?.time ? new Date(p.moonrise.time) : null,
    set: p.moonset?.time ? new Date(p.moonset.time) : null,
  };
  renderSky();
}

// --- sun strength: UV and solar radiation, for the whole day rather than this minute ---
//
// The gauge shows what the sensor reads now, which answers "should I go out" and nothing else.
// The questions people actually ask of a UV number are when it peaks and how long skin lasts,
// and both are arithmetic on hours the forecast already carries.
//
// Burn time is the standard erythema estimate — roughly 200/(3 × UV) minutes for fair skin that
// has not been out yet this year. It is a rule of thumb, labelled as one; anything more precise
// would need a skin type and a sunscreen factor this dashboard has no business asking for.
const uvBand = (v) => (v < 3 ? 'low' : v < 6 ? 'moderate' : v < 8 ? 'high' : v < 11 ? 'very high' : 'extreme');

export function renderSolar() {
  const fc = deskForecast();
  if (!fc) return;
  const c = fc.current_conditions;
  const today = new Date().toDateString();
  const hours = (fc.forecast?.hourly || []).filter((h) => new Date(h.time * 1000).toDateString() === today);

  let peak = null;
  for (const h of hours) if (h.uv != null && (!peak || h.uv > peak.uv)) peak = h;
  // Hourly W/m² held for an hour is Wh/m²; the day's total is what a panel or a tomato sees.
  const energy = hours.reduce((a, h) => a + (h.solar_radiation || 0), 0) / 1000;

  const uv = c.uv;
  const burn = uv >= 1 ? Math.round(200 / (3 * uv)) : null;
  const rows = [
    uv == null ? null : ['UV now', `${num(uv, 1)} · ${uvBand(uv)}`],
    burn == null ? null : ['Burn time', burn >= 120 ? '2h+' : `${burn} min`],
    peak ? ['Peak UV today', `${num(peak.uv, 1)} at ${hhmm(new Date(peak.time * 1000))}`] : null,
    c.solar_radiation == null ? null : ['Solar now', `${num(c.solar_radiation)} W/m²`],
    energy > 0 ? ['Solar today', `${num(energy, 2)} kWh/m²`] : null,
  ].filter(Boolean);
  $('solar').innerHTML = rows.length
    ? rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')
    : '<div class="muted">No UV or solar data from this source</div>';
  stamp('solar', 900);
}

// --- this day, other years ---
//
// The archive already answers this: /history/daily is every day this install has ever recorded,
// and the almanac downloads all of it anyway. Matching on month and day is the whole feature —
// no new endpoint, no new query parameter, and it works for a station that has been up for
// thirteen months as well as one that has been up for ten years.
async function renderLastYear() {
  const tz = -new Date().getTimezoneOffset();
  const daily = await getJSON(`${window.__WD_SRV || ''}/history/daily?tz=${tz}`);
  const now = new Date();
  const md = `-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rows = daily
    .filter((d) => d.day.endsWith(md) && d.day.slice(0, 4) !== String(now.getFullYear()))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, 6)
    .map(toDisplay);
  $('lastyear').innerHTML = rows.length
    ? rows.map((d) => `<div><span>${d.day.slice(0, 4)}</span><span>${num(d.tempMax)}° / ${num(d.tempMin)}°`
        + `${d.rain ? ` · ${num(d.rain, 2)} ${U.precip()}` : ''}</span></div>`).join('')
    : '<div class="muted">Nothing recorded on this date yet — come back next year.</div>';
  stamp('lastyear', 3600);
}

// --- fire weather and dryness ---
//
// Red flag comes out of the NWS alert feed the Desk already polls — a second request for the
// same JSON would be a second chance to be rate-limited.
//
// The US Drought Monitor's county API sends no Access-Control-Allow-Origin, so it comes through
// the app's own server (api::drought) and only appears on an install that has one. Dryness is
// still measured from this station's own rain log alongside it — that is the number that applies
// to this garden, where the county class is the one everyone else is quoting.
let dryness = null;
export function drynessFrom(days) {
  if (!days.length) return null;
  const last30 = days.slice(-30);
  const total = last30.reduce((a, d) => a + (d.rain || 0), 0);
  let since = 0;
  for (let i = days.length - 1; i >= 0 && !(days[i].rain > 0); i--) since++;
  return { total, since, days: last30.length };
}

// The worst class with any of the county in it, which is how the Monitor itself is quoted. The
// percentages are cumulative — d1 includes everything in d2 — so d0 alone means "abnormally dry".
const DROUGHT_WORDS = [
  ['d4', 'D4 exceptional'], ['d3', 'D3 extreme'], ['d2', 'D2 severe'],
  ['d1', 'D1 moderate'], ['d0', 'D0 abnormally dry'],
];
export function droughtWord(d) {
  const hit = DROUGHT_WORDS.find(([k]) => (d[k] || 0) > 0);
  if (!hit) return 'none · county is clear';
  const [key, word] = hit;
  // The service dates a map either "9/1/2026" or as a full ISO stamp, depending on the endpoint's
  // mood. Both parse; anything that doesn't is printed as it came.
  const at = new Date(d.date);
  const when = Number.isNaN(at.getTime())
    ? d.date || ''
    : at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${word} · ${num(d[key], 0)}% of county · ${when}`;
}

let drought = null;

function renderFire() {
  const alerts = [...document.querySelectorAll('#alerts .alert-head')]
    .map((el) => el.textContent)
    .filter((t) => /red flag|fire weather/i.test(t));
  const rows = [];
  if (alerts.length) rows.push(['Fire weather', `<span class="fail">${alerts[0].split(' ')[0]} active</span>`]);
  else rows.push(['Fire weather', 'no watches or warnings']);
  if (dryness) {
    rows.push([`Rain · last ${dryness.days} days`, `${num(dryness.total, 2)} ${U.precip()}`]);
    rows.push(['Days since rain', num(dryness.since)]);
  }
  if (drought) rows.push(['Drought (USDM)', droughtWord(drought)]);
  $('fire').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
}

// --- garden ---

// Growing degree days, base 50°F / 10°C — the standard for corn, tomatoes and most of what
// anyone with a Tempest is actually growing. Capped at 86°F the same way the model is: plants
// stop gaining above it, and an August heatwave would otherwise invent a month of growth.
export function gdd(dailyC) {
  const base = 10, cap = 30;
  let sum = 0;
  for (const d of dailyC) {
    if (d.tempMin == null || d.tempMax == null) continue;
    const hi = Math.min(d.tempMax, cap), lo = Math.max(Math.min(d.tempMin, cap), 0);
    sum += Math.max(0, (hi + lo) / 2 - base);
  }
  return sum;
}

let garden = { gddC: null, et0: null, rain7: null };

function renderGarden() {
  const metric = settings().units === 'metric';
  const rows = [];
  if (garden.gddC != null) {
    // GDD is quoted in whatever degree the user reads; the Fahrenheit scale is 1.8× the Celsius one.
    rows.push([`Growing degree days · base ${metric ? '10°C' : '50°F'}`, num(garden.gddC * (metric ? 1 : 1.8))]);
  }
  if (garden.et0 != null) {
    const et = garden.et0 * (metric ? 1 : 1 / 25.4);
    const rain = (garden.rain7 || 0) * (metric ? 1 : 1 / 25.4);
    const need = Math.max(0, et - rain);
    rows.push(['Evaporation · 7 days', `${num(et, 2)} ${U.precip()}`]);
    rows.push(['Rain · 7 days', `${num(rain, 2)} ${U.precip()}`]);
    rows.push(['Watering shortfall', need > 0.01
      ? `<span class="warn">${num(need, 2)} ${U.precip()}</span>`
      : '<span class="ok">none — rain covered it</span>']);
  }
  $('garden').innerHTML = rows.length
    ? rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')
    : '<div class="muted">Collecting.</div>';
  stamp('garden', 3600);
}

async function loadGarden() {
  const c = coords();
  if (c.lat == null) return;
  // ET₀ is the FAO reference evapotranspiration — how much water the last week took out of the
  // ground. Paired with the rain that went in, it is the whole of "does the lawn need watering".
  const r = await fetch('https://api.open-meteo.com/v1/forecast'
    + `?latitude=${c.lat}&longitude=${c.lon}&daily=et0_fao_evapotranspiration,precipitation_sum`
    + '&past_days=7&forecast_days=1&timezone=auto', { signal: expires(15000) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  const sum = (a) => (a || []).slice(0, 7).reduce((x, y) => x + (y || 0), 0);
  garden.et0 = sum(j.daily?.et0_fao_evapotranspiration);
  garden.rain7 = sum(j.daily?.precipitation_sum);
  renderGarden();
}

// The season's growing degree days come out of the app's own log, which is the only record that
// goes back to spring. No log (browser or Android install) simply leaves the row off.
async function loadSeason() {
  const tz = -new Date().getTimezoneOffset();
  const daysSI = await getJSON(`${window.__WD_SRV || ''}/history/daily?tz=${tz}`);
  const yearStart = `${new Date().getFullYear()}-01-01`;
  // Growing degree days are defined in °C, so they read the archive as it is stored…
  garden.gddC = gdd(daysSI.filter((d) => d.day >= yearStart));
  // …while the Fire card prints rain next to U.precip(), so it needs the display units.
  dryness = drynessFrom(daysSI.map(toDisplay));
  // No server (static host, Android) simply leaves the row off, the same way the tropical card
  // does — see api.droughtMonitor.
  drought = await api.droughtMonitor().catch(() => null);
  if (drought?.error) drought = null;
  renderGarden();
  renderFire();
}

// --- device health ---

// sensor_status is a bitfield; the hub reports it every minute and nothing else in the app looks
// at it. A failed haptic rain sensor is otherwise a rain total that quietly stays at zero.
const FAULTS = [
  [0x00000001, 'lightning sensor failed'],
  [0x00000002, 'lightning noise'],
  [0x00000004, 'lightning disturber'],
  [0x00000008, 'pressure sensor failed'],
  [0x00000010, 'temperature sensor failed'],
  [0x00000020, 'humidity sensor failed'],
  [0x00000040, 'wind sensor failed'],
  [0x00000080, 'rain sensor failed'],
  [0x00000100, 'light/UV sensor failed'],
];

export const faults = (bits) => FAULTS.filter(([m]) => bits & m).map(([, name]) => name);

// Below this the Tempest starts shedding sensors to save itself — the wind and lightning go
// first, and the readings simply stop rather than erroring.
const LOW_VOLTS = 2.355;

let lastObsAt = 0;
window.addEventListener('wd:ws-obs', (e) => { lastObsAt = (e.detail[OBS.time] || 0) * 1000; });
window.addEventListener('wd:obs', (e) => { lastObsAt = (e.detail.timestamp || 0) * 1000; });

function renderHealth(st) {
  const rows = [];
  const v = st?.voltage;
  if (v != null) {
    rows.push(['Battery', `<span class="${v < LOW_VOLTS ? 'fail' : 'ok'}">${num(v, 2)} V</span>`]);
  }
  if (st?.rssi != null) rows.push(['Sensor signal', `${num(st.rssi)} dBm`]);
  if (st?.hub_rssi != null) rows.push(['Hub signal', `${num(st.hub_rssi)} dBm`]);
  if (st?.uptime != null) rows.push(['Uptime', `${num(st.uptime / 86400, 1)} days`]);
  // Sensor faults are a Tempest hub's status word. Without one there is nothing to report on,
  // and an "all reporting" row derived from a default zero would be a reassurance nobody earned.
  if (st) {
    const bad = faults(st.sensor_status || 0);
    rows.push(['Sensors', bad.length ? `<span class="fail">${bad.join(', ')}</span>` : '<span class="ok">all reporting</span>']);
  }
  if (lastObsAt) {
    const mins = (Date.now() - lastObsAt) / 60000;
    rows.push(['Last report', mins > 30 ? `<span class="fail">${num(mins)} min ago</span>` : `${num(mins)} min ago`]);
  }
  $('health').innerHTML = rows.length
    ? rows.map(([k, val]) => `<div><span>${k}</span><span>${val}</span></div>`).join('')
    : `<div class="muted">${settings().stationSource
        ? 'No reports yet — check the station is uploading to this server.'
        : 'Needs the desktop app and a hub on the same network.'}</div>`;
  stamp('health', 300);
}

// One warning per condition per day: a flat battery is not news every minute, and the whole
// point of the category toggle is that someone chose to hear about it.
function healthAlerts(st) {
  const day = new Date().toDateString();
  if (st?.voltage != null && st.voltage < LOW_VOLTS) {
    notify({
      id: `batt-${day}`, category: 'station',
      title: 'Station battery low',
      body: `${num(st.voltage, 2)} V — the Tempest starts switching sensors off below ${LOW_VOLTS} V.`,
    });
  }
  for (const f of faults(st?.sensor_status || 0)) {
    if (/noise|disturber/.test(f)) continue; // normal weather, not a fault
    notify({ id: `fault-${f}-${day}`, category: 'station', title: 'Station sensor fault', body: f });
  }
}

let lastStatus = null;
window.addEventListener('wd:device-status', (e) => {
  lastStatus = e.detail;
  renderHealth(lastStatus);
  healthAlerts(lastStatus);
});

window.addEventListener('wd:forecast', renderSky);
window.addEventListener('wd:forecast', renderSolar);

export function initEnv() {
  renderHealth(lastStatus);
  renderSky();
  renderSolar();
  every('env-lastyear', 21600, () => renderLastYear().catch(() => {}));
  every('env-moon', 21600, () => loadMoon().catch(() => {}));
  every('env-garden', 21600, () => loadGarden().catch(() => {}));
  every('env-season', 3600, () => loadSeason().catch(() => {}));
  every('env-fire', 900, renderFire);
  every('env-health', 300, () => {
    // Station offline is the one health check that has to run without a packet arriving.
    if (!lastObsAt) return;
    renderHealth(lastStatus);
    if ((Date.now() - lastObsAt) / 60000 > 30) {
      notify({
        id: `offline-${Math.floor(Date.now() / 3600000)}`, category: 'station',
        title: 'Station has stopped reporting',
        body: `No observation for ${num((Date.now() - lastObsAt) / 60000)} minutes.`,
      });
    }
  });
}

// ponytail-lite self-check: the solar maths and the two aggregates. A golden hour an hour out
// looks perfectly reasonable on screen, which is exactly why it needs an assert.
if (location.search.includes('selftest')) {
  // Greenwich, equinox noon UTC: the sun is about 90° − latitude up.
  const alt = solarAltitude(new Date(Date.UTC(2025, 2, 20, 12, 0)), 51.48, 0);
  console.assert(Math.abs(alt - 38.5) < 1.5, 'env: solar altitude at Greenwich noon', alt);
  const night = solarAltitude(new Date(Date.UTC(2025, 2, 20, 0, 0)), 51.48, 0);
  console.assert(night < 0, 'env: sun is down at midnight');
  const cross = crossing(new Date(Date.UTC(2025, 2, 20, 6, 0)), 51.48, 0, 6, true);
  console.assert(cross && cross.getTime() > Date.UTC(2025, 2, 20, 6, 0), 'env: morning 6° crossing found');
  // 20/30°C day = mean 25, base 10 => 15 GDD; a freezing day contributes nothing.
  console.assert(gdd([{ tempMin: 20, tempMax: 30 }]) === 15, 'env: gdd base 10');
  console.assert(gdd([{ tempMin: -5, tempMax: 5 }]) === 0, 'env: cold day earns no gdd');
  console.assert(gdd([{ tempMin: 20, tempMax: 40 }]) === 15, 'env: gdd caps the high at 30');
  console.assert(gdd([{ tempMin: null, tempMax: 30 }]) === 0, 'env: partial day skipped');
  const dry = drynessFrom([{ rain: 5 }, { rain: 0 }, { rain: 0 }]);
  console.assert(dry.since === 2 && dry.total === 5, 'env: dryness counts back to the last rain');
  // Drought classes are cumulative, so the worst one with any county in it is the headline.
  console.assert(/D2 severe · 19% of county · Sep 2/.test(
    droughtWord({ d0: 19, d1: 19, d2: 18.6, d3: 0, d4: 0, date: '2025-09-02T00:00:00' })),
    'env: drought reports the worst class present');
  console.assert(/^none/.test(droughtWord({ d0: 0, d1: 0, d2: 0, d3: 0, d4: 0 })), 'env: a clear county says so');
  console.assert(faults(0) .length === 0, 'env: clean status has no faults');
  console.assert(faults(0x40).includes('wind sensor failed'), 'env: wind fault decoded');
}
