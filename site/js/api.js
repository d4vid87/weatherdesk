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

async function getJSON(url, opts) {
  // A wall tablet on a dropped Wi-Fi link otherwise leaves a fetch hanging for minutes and the
  // panel's next refresh never fires.
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
  } catch (e) {
    // the token rides in the query string — never let it into a notification body
    const where = url.split('?')[0];
    throw new Error(e.name === 'TimeoutError' ? `timed out (15s) — ${where}` : `network unreachable — ${where}`);
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url.split('?')[0]}${errHint(r.status, url)}`);
  return r.json();
}

// --- WeatherFlow Tempest ---

export function station(id = settings().stationId) {
  return getJSON(`${SWD}/stations/${id}?${qs({ token: settings().token })}`);
}

export function stationObs(id = settings().stationId) {
  return getJSON(`${SWD}/observations/stn/${id}?${qs({ token: settings().token, ...unitParams() })}`);
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

export const MODELS = 'gfs_seamless,ecmwf_ifs025,icon_seamless,gem_seamless';

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
