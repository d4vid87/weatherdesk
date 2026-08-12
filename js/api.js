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

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url.split('?')[0]}`);
  return r.json();
}

// --- WeatherFlow Tempest ---

export function station(id = settings().stationId) {
  return getJSON(`${SWD}/stations/${id}?${qs({ token: settings().token })}`);
}

export function stationObs(id = settings().stationId) {
  return getJSON(`${SWD}/observations/stn/${id}?${qs({ token: settings().token, ...unitParams() })}`);
}

// history: epoch seconds range, device-level (1min buckets)
export function deviceObs(deviceId, timeStart, timeEnd) {
  return getJSON(`${SWD}/observations/device/${deviceId}?${qs({
    token: settings().token, time_start: timeStart, time_end: timeEnd, ...unitParams(),
  })}`);
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
