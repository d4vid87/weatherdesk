// 01 Desk — current conditions, near-term forecast, alerts, AQI.
import * as api from './api.js';
import { settings, coords, configured, hasSource, hasLocation, U, num, timeStr, dayStr, notify, dismissStale, every, stamp, store, load, setStorm } from './app.js';

// Last-good copies of the two payloads the Desk can't render without. An outage that spans a
// reload would otherwise leave the whole page at `--`; in-session failures already keep the DOM.
async function cached(key, fetcher) {
  try {
    const j = await fetcher();
    store(key, j);
    return { j, fresh: true };
  } catch (e) {
    const j = load(key, null);
    if (!j) throw e;
    return { j, fresh: false, err: e };
  }
}

// One toast per outage, not one per refresh cycle: `every()` retries the forecast every 5
// minutes and a banner each time would bury the dashboard. Deliberately no `id` — notify()
// dedupes ids forever, so the first failure would silence every later one.
let toldFcFail = false;

let latestForecast = null;
export const forecast = () => latestForecast;

const $ = (id) => document.getElementById(id);

const ICON = {
  'clear-day': '☀️', 'clear-night': '🌙', 'cloudy': '☁️', 'foggy': '🌫️',
  'partly-cloudy-day': '⛅', 'partly-cloudy-night': '☁️', 'possibly-rainy-day': '🌦️',
  'possibly-rainy-night': '🌦️', 'possibly-sleet-day': '🌨️', 'possibly-sleet-night': '🌨️',
  'possibly-snow-day': '🌨️', 'possibly-snow-night': '🌨️', 'possibly-thunderstorm-day': '⛈️',
  'possibly-thunderstorm-night': '⛈️', 'rainy': '🌧️', 'sleet': '🌨️', 'snow': '❄️',
  'thunderstorm': '⛈️', 'windy': '💨',
};
export const icon = (k) => ICON[k] || '·';

export async function refreshDesk() {
  // Not `configured()`: an Ecowitt or a Davis has no Tempest forecast, and `api.betterForecast`
  // hands those installs the open-meteo payload in the same shape — which needs a location and
  // nothing else, so an install with only a saved place gets a forecast too.
  if (!hasSource() && !hasLocation()) return;
  let res;
  try {
    res = await cached('wd.cache.fc', api.betterForecast);
  } catch (e) {
    if (!toldFcFail) { toldFcFail = true; notify({ title: 'Forecast failed', body: e.message }); }
    throw e;
  }
  const { j: fc, fresh } = res;
  if (fresh) toldFcFail = false;
  else if (!toldFcFail) {
    toldFcFail = true;
    notify({ title: 'Forecast stale — showing cached copy', body: res.err.message });
  }
  latestForecast = fc;
  renderCurrent(fc.current_conditions);
  renderTenDay(fc.forecast.daily);
  if (fresh) stamp('tenday', 300);
  window.dispatchEvent(new CustomEvent('wd:forecast', { detail: fc }));
}

// A forecast is fetched every few minutes; the station reports every few seconds. Repaint the
// cached payload with the new reading so the gauges show the garden, not the model.
// A backgrounded tab still gets every 3-second websocket frame; repainting a page nobody is
// looking at is the whole cost. Hold the last one and replay it when the tab comes back.
let pendingObs = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !pendingObs) return;
  const o = pendingObs;
  pendingObs = null;
  window.dispatchEvent(new CustomEvent('wd:ws-obs', { detail: o }));
});

window.addEventListener('wd:ws-obs', (e) => {
  if (!latestForecast) return;
  if (document.hidden) { pendingObs = e.detail; return; }
  api.overlayStation(latestForecast.current_conditions, e.detail, latestForecast.elevation);
  renderCurrent(latestForecast.current_conditions);
  window.dispatchEvent(new CustomEvent('wd:forecast', { detail: latestForecast }));
});

function renderCurrent(c) {
  if (!c) return;
  document.title = `${num(c.air_temperature)}${U.temp()} · WeatherDesk`;
  if (c.wind_gust >= settings().windGustAlert) {
    notify({
      id: `gust-${Math.floor(c.time / 1800)}`, category: 'wind',
      title: 'High wind', body: `Gust ${num(c.wind_gust, 1)} ${U.wind()}`,
    });
  }
}

function renderTenDay(daily = []) {
  $('tenday').innerHTML = daily.slice(0, 10).map((d) => `<div class="tenday-row">
      <span class="td-day">${dayStr(d.day_start_local)}</span>
      <span class="td-icon">${icon(d.icon)}</span>
      <span class="td-cond">${d.conditions || ''}</span>
      <span class="td-pop">${num(d.precip_probability)}%</span>
      <span class="td-hi">${num(d.air_temp_high)}°</span>
      <span class="td-lo">${num(d.air_temp_low)}°</span>
    </div>`).join('');
}

export async function refreshAlerts() {
  if (coords().lat == null) return;
  const j = await api.alerts();
  const feats = j.features || [];
  $('alerts').innerHTML = feats.length
    ? feats.map((f) => {
        const p = f.properties;
        return `<div class="alert sev-${(p.severity || '').toLowerCase()}">
          <div class="alert-head">${p.event} <span>${p.severity}</span></div>
          <div class="alert-time">until ${new Date(p.ends || p.expires).toLocaleString()}</div>
          <details><summary>details</summary><p>${(p.description || '').replace(/</g, '&lt;')}</p></details>
        </div>`;
      }).join('')
    : '<div class="muted">No active alerts</div>';
  stamp('alerts', 300);
  // Storm mode: while something serious is out, every panel goes back to full rate whatever eco
  // and the hour say. This is the one time the dashboard is being watched.
  setStorm(feats.some((f) => ['Severe', 'Extreme'].includes(f.properties?.severity)));
  // NWS mints a fresh id for every continuation of the same warning, so keying the dedupe on it
  // re-chimed the same tornado warning every 5 minutes. Key on what the warning IS instead — a
  // severity change still gets through, which is the one update worth a second chime.
  const key = (p) => `${p.event}|${p.areaDesc}|${p.severity}`;
  feats.forEach((f) => notify({
    id: key(f.properties), category: 'severe',
    title: f.properties.event, body: f.properties.headline || '',
  }));
  dismissStale('severe', new Set(feats.map((f) => key(f.properties))));
}

export async function refreshAqi() {
  if (coords().lat == null) return;
  const j = await api.aqi();
  const i = j.hourly.time.findIndex((t) => new Date(t) > new Date()) - 1;
  const v = j.hourly.us_aqi[Math.max(i, 0)];
  $('aqi-val').textContent = num(v);
  $('aqi-label').textContent = aqiLabel(v);
  $('aqi-val').className = `aqi-${aqiBand(v)}`;
  $('aqi-detail').textContent = `PM2.5 ${num(j.hourly.pm2_5[Math.max(i, 0)], 1)} µg/m³`;
  stamp('aqi-val', 1800);
}

const aqiBand = (v) => (v <= 50 ? 'good' : v <= 100 ? 'mod' : v <= 150 ? 'usg' : v <= 200 ? 'bad' : 'vbad');
const aqiLabel = (v) => ({ good: 'Good', mod: 'Moderate', usg: 'Unhealthy (sensitive)', bad: 'Unhealthy', vbad: 'Very unhealthy' }[aqiBand(v)]);

export async function refreshObs() {
  if (!configured()) return;
  const { j, fresh } = await cached('wd.cache.obs', api.stationObs);
  const o = j.obs?.[0];
  if (!o) return;
  if (fresh) stamp('hero', settings().refreshSec);
  // stn obs has no conditions/icon — keep the ones from the last better_forecast
  const cc = latestForecast?.current_conditions;
  renderCurrent({ ...o, conditions: cc?.conditions, icon: cc?.icon, time: o.timestamp });
  window.dispatchEvent(new CustomEvent('wd:obs', { detail: o }));
}

export function initDesk() {
  every('desk-forecast', 300, refreshDesk);
  every('desk-obs', settings().refreshSec, refreshObs);
  every('desk-alerts', 300, refreshAlerts);
  every('desk-aqi', 1800, refreshAqi);
}
