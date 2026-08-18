// All remote endpoints live here. Single choke point for token + units.
import { settings, coords } from './app.js';

const SWD = 'https://swd.weatherflow.com/swd/rest';

function unitParams() {
  const s = settings();
  return s.units === 'metric'
    ? { units_temp: 'c', units_wind: 'kph', units_pressure: 'mb', units_precip: 'mm', units_distance: 'km' }
    : { units_temp: 'f', units_wind: 'mph', units_pressure: 'inhg', units_precip: 'in', units_distance: 'mi' };
}

function qs(obj) {
  return new URLSearchParams(obj).toString();
}

// What to do about it, in the message itself. "401 Unauthorized" told nobody where the token
// comes from. Tempest-only: a 404 from open-meteo is not a station-ID problem.
export function errHint(status, url) {
  if (!url.startsWith(SWD)) return '';
  if (status === 401 || status === 403) {
    return ' — token rejected: create or check a personal use token at tempestwx.com → Settings → Data Authorizations';
  }
  if (status === 404) return ' — not found: check the station/device ID';
  return '';
}

// NWS answers every request with an ETag and honours If-None-Match, and the alert feed is polled
// every 5 minutes to say "no active alerts" over and over. A 304 is a few hundred bytes and no
// JSON parse. Bounded on purpose: only api.weather.gov URLs land here, and there are a handful.
const etags = new Map();
const cacheable = (url) => url.startsWith('https://api.weather.gov/');

async function getJSON(url, opts) {
  // A wall tablet on a dropped Wi-Fi link otherwise leaves a fetch hanging for minutes and the
  // panel's next refresh never fires.
  let r;
  const hit = cacheable(url) ? etags.get(url) : null;
  try {
    r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      ...opts,
      ...(hit ? { headers: { 'If-None-Match': hit.etag, ...(opts?.headers || {}) } } : {}),
    });
  } catch (e) {
    // the token rides in the query string — never let it into a notification body
    const where = url.split('?')[0];
    throw new Error(e.name === 'TimeoutError' ? `timed out (15s) — ${where}` : `network unreachable — ${where}`);
  }
  if (r.status === 304 && hit) return structuredClone(hit.body);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url.split('?')[0]}${errHint(r.status, url)}`);
  const body = await r.json();
  const tag = cacheable(url) && r.headers.get('ETag');
  // Callers mutate what they get back (deviceObs converts in place), so the cache keeps its own
  // copy and hands out clones.
  if (tag) etags.set(url, { etag: tag, body: structuredClone(body) });
  return body;
}

// --- WeatherFlow Tempest ---

export function station(id = settings().stationId) {
  return getJSON(`${SWD}/stations/${id}?${qs({ token: settings().token })}`);
}

// Every station the token can see. The setup wizard's whole job: a station ID is a number
// nobody has memorised, and it is right there in the account.
export function stations() {
  return getJSON(`${SWD}/stations?${qs({ token: settings().token })}`);
}

export function stationObs(id = settings().stationId) {
  return getJSON(`${SWD}/observations/stn/${id}?${qs({ token: settings().token, ...unitParams() })}`);
}

// --- METAR via NWS, shaped like a Tempest station obs so the comparison rows need no branches ---

export async function metarObs(id) {
  const j = await getJSON(`https://api.weather.gov/stations/${id}/observations/latest`);
  const p = j.properties || {};
  const metric = settings().units === 'metric';
  const c = p.temperature?.value;       // degC
  const w = p.windSpeed?.value;         // km_h-1
  return {
    latitude: j.geometry?.coordinates?.[1],
    longitude: j.geometry?.coordinates?.[0],
    obs: [{
      timestamp: p.timestamp ? Date.parse(p.timestamp) / 1000 : null,
      air_temperature: c == null ? null : (metric ? c : c * 9 / 5 + 32),
      wind_avg: w == null ? null : (metric ? w : w * 0.621371),
      wind_direction: p.windDirection?.value,
      precip_accum_local_day: null, // airports report precip on their own schedule; not comparable
    }],
  };
}

// obs_st tuple layout, per the Tempest UDP/REST reference. One copy: two drifting
// copies of a positional index map is a silently-wrong chart.
export const OBS = {
  time: 0, windLull: 1, windAvg: 2, windGust: 3, windDir: 4, windInterval: 5,
  press: 6, temp: 7, rh: 8, lux: 9, uv: 10, solar: 11, rain: 12, precipType: 13,
  strikeDist: 14, strikes: 15, battery: 16, reportInterval: 17, dayRain: 18,
};

// history: epoch seconds range, device-level (1min buckets)
//
// This endpoint ignores the unit params and always answers in SI (m/s, °C, mb, mm, km) — charts
// and trends were reading metric numbers under imperial labels, and a 0.30 *mb* 3h pressure delta
// tripped the inHg "rising rapidly" band forever. Convert here, once, and every consumer
// (boards.js, pro.js trends) is right without knowing about it.
export async function deviceObs(deviceId, timeStart, timeEnd) {
  const j = await getJSON(`${SWD}/observations/device/${deviceId}?${qs({
    token: settings().token, time_start: timeStart, time_end: timeEnd,
  })}`);
  const metric = settings().units === 'metric';
  const conv = (o, i, f) => { if (o[i] != null) o[i] = o[i] * f; };
  for (const o of j.obs || []) {
    // wind is m/s in both systems — even metric needs km/h
    for (const i of [OBS.windLull, OBS.windAvg, OBS.windGust]) conv(o, i, metric ? 3.6 : 2.23694);
    if (metric) continue;
    if (o[OBS.temp] != null) o[OBS.temp] = o[OBS.temp] * 9 / 5 + 32;
    conv(o, OBS.press, 0.02953);
    conv(o, OBS.rain, 1 / 25.4);
    conv(o, OBS.dayRain, 1 / 25.4);
    conv(o, OBS.strikeDist, 0.621371);
  }
  return j;
}

export function betterForecast(stationId = settings().stationId) {
  return getJSON(`${SWD}/better_forecast?${qs({
    station_id: stationId, token: settings().token, ...unitParams(),
  })}`);
}

// --- NWS ---

export function alerts(lat = coords().lat, lon = coords().lon) {
  return getJSON(`https://api.weather.gov/alerts/active?${qs({ point: `${lat},${lon}` })}`);
}

export function nwsPoint(lat = coords().lat, lon = coords().lon) {
  return getJSON(`https://api.weather.gov/points/${(+lat).toFixed(4)},${(+lon).toFixed(4)}`);
}

// --- Open-Meteo ---

// HRRR is the short-range storm-scale model — three kilometres and hourly runs, which is the
// one that knows about the thunderstorm this afternoon. It only reaches 48 hours, so it drops
// out of the far end of the agreement panel on its own.
export const MODELS = 'gfs_seamless,ecmwf_ifs025,icon_seamless,gem_seamless,gfs_hrrr';

export function multiModel(lat = coords().lat, lon = coords().lon) {
  const imperial = settings().units !== 'metric';
  return getJSON(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: lat, longitude: lon, models: MODELS,
    hourly: 'temperature_2m,precipitation,wind_speed_10m',
    forecast_days: 3, timezone: 'auto',
    ...(imperial ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
  })}`);
}

export function nowcast(lat = coords().lat, lon = coords().lon) {
  const imperial = settings().units !== 'metric';
  return getJSON(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: lat, longitude: lon,
    minutely_15: 'precipitation,precipitation_probability',
    forecast_hours: 12, timezone: 'auto',
    ...(imperial ? { precipitation_unit: 'inch' } : {}),
  })}`);
}

// Tempest's daily block carries a precip probability but no amount, and the day cards want both.
export function dailyPrecip(lat = coords().lat, lon = coords().lon) {
  const imperial = settings().units !== 'metric';
  return getJSON(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: lat, longitude: lon, daily: 'precipitation_sum', forecast_days: 7, timezone: 'auto',
    ...(imperial ? { precipitation_unit: 'inch' } : {}),
  })}`);
}

export function aqi(lat = coords().lat, lon = coords().lon) {
  return getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${qs({
    latitude: lat, longitude: lon, hourly: 'us_aqi,pm2_5,ozone', forecast_days: 1, timezone: 'auto',
  })}`);
}

export function geocode(q) {
  return getJSON(`https://photon.komoot.io/api/?${qs({ q, limit: 5 })}`);
}

// 31 members of the GFS ensemble, which between them are an honest answer to "how sure is
// this?" — a single deterministic line never was.
export function ensemble(lat = coords().lat, lon = coords().lon) {
  const imperial = settings().units !== 'metric';
  return getJSON(`https://ensemble-api.open-meteo.com/v1/ensemble?${qs({
    latitude: lat, longitude: lon, models: 'gfs025',
    hourly: 'temperature_2m', forecast_days: 3, timezone: 'auto',
    ...(imperial ? { temperature_unit: 'fahrenheit' } : {}),
  })}`);
}

// Percentile across the ensemble members at each hour. 10-90 rather than the full spread: one
// runaway member should not make the band look like the weather could do anything at all.
export function ensembleBand(j, lo = 0.1, hi = 0.9) {
  const h = j?.hourly || {};
  const members = Object.keys(h).filter((k) => k.startsWith('temperature_2m_member'));
  if (!members.length) return [];
  return (h.time || []).map((t, i) => {
    const vals = members.map((m) => h[m][i]).filter((v) => v != null).sort((a, b) => a - b);
    if (!vals.length) return { x: Date.parse(t), lo: null, hi: null };
    const at = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    return { x: Date.parse(t), lo: at(lo), hi: at(hi) };
  });
}

// Instability and the cap holding it down. The numbers a severe-weather day is actually read
// from, next to the outlook that summarises them.
export function severeParams(lat = coords().lat, lon = coords().lon) {
  return getJSON(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: lat, longitude: lon,
    hourly: 'cape,convective_inhibition,lifted_index',
    forecast_days: 2, timezone: 'auto',
  })}`);
}

// Snowfall for the week. Reported in cm by open-meteo whatever else is asked for, so the panel
// converts; asking for `snowfall_sum` in inches would silently be liquid-equivalent elsewhere.
export function snowfall(lat = coords().lat, lon = coords().lon) {
  return getJSON(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: lat, longitude: lon, daily: 'snowfall_sum', forecast_days: 7, timezone: 'auto',
  })}`);
}

// --- SPC convective outlook ---

// Categorical risk polygons for the day. SPC serves these with CORS open, so the page can read
// them directly.
export function spcOutlook(day = 1) {
  return getJSON(`https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.lyr.geojson`);
}

// Ray casting, the textbook version: count the edges a ray east of the point crosses. Odd means
// inside. Holes in a polygon fall out of it for free — a hole is just more edges to cross.
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/// The strongest category whose polygon contains the point, or null. SPC ships the outlook
// smallest-risk-first, so the last match is the highest risk.
export function riskAt(geojson, lat, lon) {
  let found = null;
  for (const f of geojson?.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      if (poly[0] && pointInRing(lon, lat, poly[0])) {
        found = { label: f.properties?.LABEL2 || f.properties?.LABEL || '', code: f.properties?.LABEL || '' };
      }
    }
  }
  return found;
}

// --- Tropical ---

// NHC serves CurrentStorms.json without CORS headers, so the page cannot read it directly. The
// desktop app's own server fetches it instead; a static self-host has no such route and the card
// links out rather than pretending.
export function tropical() {
  const srv = window.__WD_SRV ?? (window.location.protocol.startsWith('http') ? '' : null);
  if (srv == null) return Promise.reject(new Error('no server to proxy NHC'));
  return getJSON(`${srv}/proxy/nhc`);
}

// --- Climate normals (ERA5 reanalysis via open-meteo, keyless) ---

// "68°" means nothing on its own; "68°, five above normal for the date" is the sentence people
// actually want. Thirty years of daily reanalysis is one request and about 200 KB, so it is
// fetched once and kept — normals do not change, and the alternative was 365 requests.
const NORMALS_KEY = 'wd.normals';

export async function normals(lat = coords().lat, lon = coords().lon) {
  const place = `${(+lat).toFixed(2)},${(+lon).toFixed(2)},${settings().units}`;
  try {
    const cached = JSON.parse(localStorage.getItem(NORMALS_KEY) || 'null');
    if (cached?.place === place) return cached.days;
  } catch { /* cache is a nicety */ }
  const imperial = settings().units !== 'metric';
  const j = await getJSON(`https://archive-api.open-meteo.com/v1/archive?${qs({
    latitude: lat, longitude: lon, start_date: '1991-01-01', end_date: '2020-12-31',
    daily: 'temperature_2m_max,temperature_2m_min', timezone: 'auto',
    ...(imperial ? { temperature_unit: 'fahrenheit' } : {}),
  })}`);
  const acc = {};
  const d = j.daily || {};
  (d.time || []).forEach((t, i) => {
    const key = t.slice(5); // MM-DD
    const a = (acc[key] ||= { hi: 0, lo: 0, n: 0 });
    if (d.temperature_2m_max[i] == null || d.temperature_2m_min[i] == null) return;
    a.hi += d.temperature_2m_max[i];
    a.lo += d.temperature_2m_min[i];
    a.n++;
  });
  const days = {};
  for (const [k, a] of Object.entries(acc)) {
    if (a.n) days[k] = { hi: a.hi / a.n, lo: a.lo / a.n };
  }
  try { localStorage.setItem(NORMALS_KEY, JSON.stringify({ place, days })); } catch { /* full; recompute next time */ }
  return days;
}

export const normalFor = (days, date = new Date()) =>
  days?.[`${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`] || null;

// --- Storm reports ---

export function stormReports(hours = 24) {
  return getJSON(`https://mesonet.agron.iastate.edu/geojson/lsr.geojson?${qs({ hours })}`);
}

// ponytail-lite self-check: the error hints and the SI conversion, the two places a silent
// wrong answer would look plausible.
if (location.search.includes('selftest')) {
  console.assert(errHint(401, `${SWD}/stations/1`).includes('token'), 'api: 401 names the token');
  console.assert(errHint(404, `${SWD}/stations/1`).includes('station'), 'api: 404 names the ID');
  console.assert(errHint(404, 'https://api.open-meteo.com/v1/forecast') === '', 'api: no station hint off Tempest');

  // point-in-polygon: a unit square, and a point outside it that is due east of an edge
  const square = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  console.assert(pointInRing(0, 0, square), 'api: centre is inside the polygon');
  console.assert(!pointInRing(2, 0, square), 'api: a point east of the polygon is outside');
  console.assert(!pointInRing(0, 2, square), 'api: a point north of the polygon is outside');
  console.assert(!pointInRing(-2, 0, square), 'api: a point west of the polygon is outside');

  const band = ensembleBand({ hourly: { time: ['1970-01-01T00:00'], temperature_2m_member01: [1], temperature_2m_member02: [9] } });
  console.assert(band[0].lo === 1 && band[0].hi === 9, 'api: ensemble band spans the members');

  console.assert(normalFor({ '03-04': { hi: 60, lo: 40 } }, new Date(2020, 2, 4)).hi === 60, 'api: normals key is month-day');
}

// --- Diagnostics: ping each source, return [{name, ok, detail}] ---

export async function diagnostics() {
  const checks = [
    ['Tempest station', () => station()],
    ['Tempest obs', () => stationObs()],
    ['Tempest forecast', () => betterForecast()],
    ['NWS alerts', () => alerts()],
    ['Open-Meteo models', () => multiModel()],
    ['Open-Meteo AQI', () => aqi()],
    ['RainViewer', () => getJSON('https://api.rainviewer.com/public/weather-maps.json')],
    ['IEM storm reports', () => stormReports(1)],
  ];
  return Promise.all(checks.map(async ([name, fn]) => {
    const t0 = performance.now();
    try {
      await fn();
      return { name, ok: true, detail: `${Math.round(performance.now() - t0)}ms` };
    } catch (e) {
      return { name, ok: false, detail: e.message };
    }
  }));
}
