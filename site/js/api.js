// All remote endpoints live here. Single choke point for token + units.
import { settings, coords, expires, windUnit, msToWind, WIND_UNITS } from './app.js';

const SWD = 'https://swd.weatherflow.com/swd/rest';

function unitParams() {
  const s = settings();
  return {
    ...(s.units === 'metric'
      ? { units_temp: 'c', units_pressure: 'mb', units_precip: 'mm', units_distance: 'km' }
      : { units_temp: 'f', units_pressure: 'inhg', units_precip: 'in', units_distance: 'mi' }),
    units_wind: WIND_UNITS[windUnit()].tempest,
  };
}

function qs(obj) {
  return new URLSearchParams(obj).toString();
}

// What to do about it, in the message itself. "401 Unauthorized" told nobody where the token
// comes from. Tempest-only: a 404 from open-meteo is not a station-ID problem.
export function errHint(status, url) {
  if (!url.startsWith(SWD)) return '';
  if (status === 401 || status === 403) {
    // A token only reads its own account. A 401 for someone else's station ID means that station
    // isn't shared with the public API, not that the token is bad — issue #38.
    return foreignStation(url)
      ? " — that station isn't readable with your token: WeatherFlow only shares a station's data with its owner unless the owner has made it public"
      : ' — token rejected: create or check a personal use token at tempestwx.com → Settings → Data Authorizations';
  }
  if (status === 404) return ' — not found: check the station/device ID';
  return '';
}

// The station ID in an observations/stations URL, when it isn't the one this install is set up on.
function foreignStation(url) {
  const id = url.match(/\/(?:observations\/stn|stations)\/(\d+)/)?.[1];
  return !!id && id !== String(settings().stationId);
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
      signal: expires(15000),
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
      wind_avg: msToWind(w == null ? null : w / 3.6),   // NWS reports km/h
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
  siToDisplay(j.obs || []);
  return j;
}

// SI tuples to whatever the user reads. Its own function because the archive route
// (`/history/tuples`, every non-Tempest station) hands back the same SI tuples this endpoint
// does, and one copy of these factors is the difference between a chart being right and a
// chart being plausible.
export function siToDisplay(obs) {
  const metric = settings().units === 'metric';
  const conv = (o, i, f) => { if (o[i] != null) o[i] = o[i] * f; };
  for (const o of obs) {
    // wind is m/s on the wire whatever the system, and its unit is separately overridable
    for (const i of [OBS.windLull, OBS.windAvg, OBS.windGust]) conv(o, i, WIND_UNITS[windUnit()].fromMs);
    if (metric) continue;
    if (o[OBS.temp] != null) o[OBS.temp] = o[OBS.temp] * 9 / 5 + 32;
    conv(o, OBS.press, 0.02953);
    conv(o, OBS.rain, 1 / 25.4);
    conv(o, OBS.dayRain, 1 / 25.4);
    conv(o, OBS.strikeDist, 0.621371);
  }
  return obs;
}

// The same window of history for a station that has no cloud behind it: our own archive, which
// is where every ingested report lands whatever brand sent it. Shaped like `deviceObs` so
// `pro.js` reads one or the other without knowing which.
export async function localObs(hours = 3) {
  const j = await getJSON(`${window.__WD_SRV || ''}/history/tuples?${qs({ hours })}`);
  siToDisplay(j.obs || []);
  return j;
}

// The Desk, the hero, the day cards and the ticker are all driven by one better_forecast
// payload. A station that is not a Tempest has no such endpoint — so build the same payload out
// of open-meteo, which this app already leans on for six other panels, and every consumer stays
// unaware. See `shapeOm`.
export function betterForecast(stationId = settings().stationId) {
  if (!settings().token) return omForecast();
  return getJSON(`${SWD}/better_forecast?${qs({
    station_id: stationId, token: settings().token, ...unitParams(),
  })}`);
}

// The station's own last reading, kept so the forecast payload can be overlaid with it: a
// dashboard whose hero shows a model's guess at the temperature while a thermometer in the
// garden says otherwise is the wrong way round.
let lastTuple = null;
window.addEventListener('wd:ws-obs', (e) => { lastTuple = e.detail; });

// WMO code to the icon names `desk.js ICON` and `icons.js` already draw. Two variants where the
// sky matters and one where it doesn't — fog at night still looks like fog.
const WMO = {
  0: 'clear', 1: 'partly-cloudy', 2: 'partly-cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy',
  51: 'possibly-rainy', 53: 'possibly-rainy', 55: 'possibly-rainy',
  56: 'possibly-sleet', 57: 'possibly-sleet',
  61: 'rainy', 63: 'rainy', 65: 'rainy', 66: 'sleet', 67: 'sleet',
  71: 'possibly-snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'possibly-rainy', 81: 'rainy', 82: 'rainy', 85: 'snow', 86: 'snow',
  95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm',
};
const DAYNIGHT = new Set(['clear', 'partly-cloudy', 'possibly-rainy', 'possibly-sleet', 'possibly-snow', 'possibly-thunderstorm']);
const WORDS = {
  clear: 'Clear', 'partly-cloudy': 'Partly Cloudy', cloudy: 'Cloudy', foggy: 'Fog',
  'possibly-rainy': 'Chance of Rain', 'possibly-sleet': 'Chance of Sleet',
  'possibly-snow': 'Chance of Snow', rainy: 'Rain', sleet: 'Sleet', snow: 'Snow',
  thunderstorm: 'Thunderstorms',
};

export function omIcon(code, day = true) {
  const base = WMO[code] ?? 'cloudy';
  return DAYNIGHT.has(base) ? `${base}-${day ? 'day' : 'night'}` : base;
}
export const omWords = (code) => WORDS[WMO[code] ?? 'cloudy'] || '';

// One open-meteo response, in the shape Tempest's better_forecast has. Pure and exported so the
// self-check can feed it a canned payload — this is the one function where a mislabelled field
// would show up as a wrong hero rather than an error.
//
// `ownTuple` is the station's own SI reading. Where a sensor measured something, the sensor
// wins; the model keeps what no backyard station has (dew point, feels-like, sea-level
// pressure, wet bulb) rather than this file growing a second psychrometry.
// A backyard station measures the pressure where it stands; every console and every forecast
// quotes it reduced to sea level. Reporting the raw reading against a model's MSL is why a Davis
// on Long Island read 30.06 on the dashboard and 30.08 on its own display. Multiplicative, so it
// works in whatever unit the reading is already in; `elev` is metres, `tempC` the outside air.
export function toSeaLevel(p, elev, tempC = 15) {
  // No elevation, no honest reduction — the caller falls back to the model's MSL rather than
  // publishing a mountain station's raw reading as if it were sea level.
  if (p == null || elev == null) return null;
  if (!elev) return p;
  return p * (1 - (0.0065 * elev) / (tempC + 0.0065 * elev + 273.15)) ** -5.257;
}

// 15 °C is the standard-atmosphere fallback: a station with no thermometer still gets a
// reduction that is right to a hundredth of an inch at backyard elevations.
const tempC = (t, metric) => (t == null ? 15 : metric ? t : (t - 32) / 1.8);

export function shapeOm(j, ownTuple = null) {
  const metric = settings().units === 'metric';
  const cur = j.current || {};
  const H = j.hourly || {};
  const D = j.daily || {};
  const times = H.time || [];
  // The hourly arrays carry the readings open-meteo has no `current` field for; take the hour
  // we are standing in rather than hour zero of the run.
  const now = cur.time || Math.floor(Date.now() / 1000);
  // The hour we are standing in: the last one that has started. Past the end of the array
  // (a cached payload on a screen nobody reloaded) means the final hour, not the first.
  const next = times.findIndex((t) => t > now);
  const i0 = next < 0 ? Math.max(0, times.length - 1) : Math.max(0, next - 1);
  const at = (k) => (H[k] ? H[k][i0] : null);
  const inHg = (hpa) => (hpa == null ? null : metric ? hpa : hpa * 0.02953);

  const daily = (D.time || []).map((t, i) => {
    const code = D.weather_code?.[i];
    return {
      day_start_local: t,
      sunrise: D.sunrise?.[i],
      sunset: D.sunset?.[i],
      icon: omIcon(code, true),
      conditions: omWords(code),
      air_temp_high: D.temperature_2m_max?.[i],
      air_temp_low: D.temperature_2m_min?.[i],
      precip_probability: D.precipitation_probability_max?.[i],
    };
  });

  const hourly = times.map((t, i) => ({
    time: t,
    air_temperature: H.temperature_2m?.[i],
    precip_probability: H.precipitation_probability?.[i],
    wind_avg: H.wind_speed_10m?.[i],
    wind_gust: H.wind_gusts_10m?.[i],
    wind_direction: H.wind_direction_10m?.[i],
    icon: omIcon(H.weather_code?.[i], true),
    conditions: omWords(H.weather_code?.[i]),
    // The solar card reads the whole day out of these two, so they travel with the hour.
    uv: H.uv_index?.[i],
    solar_radiation: H.shortwave_radiation?.[i],
  }));

  const day = cur.is_day == null ? true : !!cur.is_day;
  const c = {
    time: now,
    air_temperature: cur.temperature_2m,
    relative_humidity: cur.relative_humidity_2m,
    dew_point: cur.dew_point_2m,
    feels_like: cur.apparent_temperature,
    wind_avg: cur.wind_speed_10m,
    wind_gust: cur.wind_gusts_10m,
    wind_direction: cur.wind_direction_10m,
    sea_level_pressure: inHg(cur.pressure_msl),
    station_pressure: inHg(cur.surface_pressure),
    precip_accum_local_day: D.precipitation_sum?.[0],
    uv: at('uv_index'),
    solar_radiation: at('shortwave_radiation'),
    wet_bulb_temperature: at('wet_bulb_temperature_2m'),
    // metres, whatever the unit params say — open-meteo doesn't convert this one. Hero converts.
    visibility: at('visibility'),
    icon: omIcon(cur.weather_code, day),
    conditions: omWords(cur.weather_code),
  };

  if (ownTuple) overlayStation(c, ownTuple, j.elevation);

  // Kept so a later observation can be overlaid on this same payload without refetching.
  return { current_conditions: c, forecast: { daily, hourly }, elevation: j.elevation };
}

// The station's reading painted over the model's guess. Exported because observations arrive
// far more often than forecasts do — a five-minute-old model wind is not "your" wind.
export function overlayStation(c, tuple, elevation) {
  const metric = settings().units === 'metric';
  const o = siToDisplay([[...tuple]])[0];
  const own = (v) => (v == null ? undefined : v);
  const overlay = {
    air_temperature: own(o[OBS.temp]),
    relative_humidity: own(o[OBS.rh]),
    wind_avg: own(o[OBS.windAvg]),
    wind_gust: own(o[OBS.windGust]),
    wind_direction: own(o[OBS.windDir]),
    uv: own(o[OBS.uv]),
    solar_radiation: own(o[OBS.solar]),
    precip_accum_local_day: own(o[OBS.dayRain]),
    station_pressure: own(o[OBS.press]),
    // The barometer gauge reads `sea_level_pressure`; without this line it showed the model's
    // MSL forever and a real barometer sat unused two fields away.
    sea_level_pressure: own(toSeaLevel(o[OBS.press], settings().elevationM ?? elevation,
      tempC(o[OBS.temp], metric))),
  };
  for (const k in overlay) if (overlay[k] !== undefined) c[k] = overlay[k];
  return c;
}

export async function omForecast(lat = coords().lat, lon = coords().lon) {
  const imperial = settings().units !== 'metric';
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: lat, longitude: lon,
    current: 'temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,is_day,'
      + 'weather_code,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,'
      + 'wind_direction_10m,uv_index,shortwave_radiation,wet_bulb_temperature_2m,visibility',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,'
      + 'precipitation_probability_max,precipitation_sum',
    forecast_days: 10, timezone: 'auto', timeformat: 'unixtime',
    wind_speed_unit: WIND_UNITS[windUnit()].om,
    ...(imperial ? { temperature_unit: 'fahrenheit', precipitation_unit: 'inch' } : {}),
  })}`);
  return shapeOm(j, lastTuple);
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
    wind_speed_unit: WIND_UNITS[windUnit()].om,
    ...(imperial ? { temperature_unit: 'fahrenheit', precipitation_unit: 'inch' } : {}),
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

// A ZIP hit comes back with name="06092" and the town only in `city`, so a label without it
// reads as a bare number among five countries' worth of matches.
export function placeLabel(p) {
  return [p.name, p.city && p.city !== p.name ? p.city : null, p.state, p.country]
    .filter(Boolean).join(', ');
}

export function geocode(q) {
  const c = coords();
  const lang = (navigator.language || 'en').slice(0, 2);
  return getJSON(`https://photon.komoot.io/api/?${qs({
    q, limit: 5,
    // Photon only speaks these three; anything else has to fall back or it 400s.
    lang: ['en', 'de', 'fr'].includes(lang) ? lang : 'en',
    ...(c.lat != null && c.lon != null ? { lat: c.lat, lon: c.lon } : {}),
  })}`);
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

  // 7 m of Long Island: the reduction is the ~0.02 inHg that made a Davis owner think the
  // dashboard was reading his barometer wrong.
  console.assert(Math.abs(toSeaLevel(30.06, 7, 19) - 30.085) < 0.005, 'api: pressure reduced to sea level');
  console.assert(toSeaLevel(30.06, 0) === 30.06, 'api: a station at sea level is already reduced');
  console.assert(toSeaLevel(null, 100) === null, 'api: no reading, no reduction');

  console.assert(normalFor({ '03-04': { hi: 60, lo: 40 } }, new Date(2020, 2, 4)).hi === 60, 'api: normals key is month-day');

  // The open-meteo forecast adapter: every non-Tempest station's hero, day cards and ticker
  // read this payload as if WeatherFlow had sent it, so a mislabelled field here is a
  // plausible-looking wrong dashboard rather than an error.
  const om = shapeOm({
    current: { time: 4000, temperature_2m: 70, relative_humidity_2m: 50, dew_point_2m: 50,
      apparent_temperature: 72, is_day: 0, weather_code: 95, pressure_msl: 1013.2,
      wind_speed_10m: 8, wind_direction_10m: 180, wind_gusts_10m: 15 },
    hourly: { time: [0, 3600], temperature_2m: [68, 70], precipitation_probability: [10, 40],
      weather_code: [0, 95], wind_speed_10m: [5, 8], wind_gusts_10m: [9, 15],
      wind_direction_10m: [170, 180], uv_index: [0, 3], shortwave_radiation: [0, 200],
      wet_bulb_temperature_2m: [60, 62] },
    daily: { time: [0], weather_code: [95], temperature_2m_max: [80], temperature_2m_min: [60],
      sunrise: [21600], sunset: [64800], precipitation_probability_max: [40], precipitation_sum: [0.2] },
  });
  console.assert(om.current_conditions.air_temperature === 70, 'api: shapeOm keeps the current temperature');
  console.assert(typeof om.forecast.daily[0].sunrise === 'number', 'api: day cards need a numeric sunrise');
  console.assert(om.forecast.daily[0].air_temp_high === 80, 'api: day card high');
  console.assert(om.forecast.hourly[1].precip_probability === 40, 'api: hourly precip probability');
  console.assert(om.current_conditions.icon === 'thunderstorm', 'api: WMO 95 is a thunderstorm');
  console.assert(omIcon(0, false) === 'clear-night', 'api: clear after sunset is the night icon');
  console.assert(omIcon(0, true) === 'clear-day' && omIcon(45, false) === 'foggy', 'api: fog has no night variant');
  // The hour it picks is the one we are standing in, not hour zero of the run.
  console.assert(om.current_conditions.uv === 3, 'api: current UV comes from the current hour');

  // A sensor in the garden beats a model every time — but only where a sensor reported.
  const own = []; own[OBS.temp] = 20; own[OBS.rh] = 88;
  const over = shapeOm({ current: { time: 1000, temperature_2m: 70, relative_humidity_2m: 50, dew_point_2m: 50 },
    hourly: { time: [0, 3600] }, daily: { time: [0] } }, own);
  console.assert(over.current_conditions.relative_humidity === 88, 'api: own humidity wins over the model');
  console.assert(over.current_conditions.dew_point === 50, 'api: the model keeps what no station measures');
}

// --- Diagnostics: ping each source, return [{name, ok, detail}] ---

export async function diagnostics() {
  // Issue #37: an Ambient or a Davis install has no Tempest account, so probing WeatherFlow
  // painted two red rows on every self-check and people read them as the app being broken.
  // Probe what this install actually uses — and name the forecast after where it comes from.
  const checks = [
    ...(settings().token ? [
      ['Tempest station', () => station()],
      ['Tempest obs', () => stationObs()],
      ['Tempest forecast', () => betterForecast()],
    ] : [
      ...(settings().stationSource ? [['Local station', async () => {
        // A reachable archive with nothing in it is the failure people actually hit: the console
        // was never pointed at /ingest. Green there would be a lie.
        const j = await localObs(1);
        if (!j.obs?.length) throw new Error('no reports in the last hour — check the console is uploading to this address');
      }]] : []),
      ['Open-Meteo forecast', () => betterForecast()],
    ]),
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
