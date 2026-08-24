// Smart home: publish the station to an MQTT broker, and read a few Home Assistant entities back.
//
// Publishing goes out in SI, straight off the Tempest websocket — the REST endpoints return
// whatever display units the dashboard is set to, and mixing the two would quietly corrupt months
// of Home Assistant history the first time someone switches to metric. Home Assistant discovery
// is retained, so the device reappears after a restart without this page being open.
//
// HomeKit, Alexa and Google are reached through Home Assistant's own bridges — see README. There
// is no native code here for them, and there shouldn't be.

import { settings, every, stamp, stormMode, expires, msToWind } from './app.js';
import { OBS } from './api.js';
import { mqtt } from './mqtt.js';

const $ = (id) => document.getElementById(id);

let client = null;
let lastPrecip = 0, gustLatched = false;

const base = () => `weatherdesk/${settings().stationId}`;
const availability = () => `${base()}/status`;

// field -> [obs_st index, HA device_class, HA unit, state_class]
const FIELDS = {
  temp: [OBS.temp, 'temperature', '°C', 'measurement'],
  rh: [OBS.rh, 'humidity', '%', 'measurement'],
  pressure: [OBS.press, 'atmospheric_pressure', 'hPa', 'measurement'],
  wind: [OBS.windAvg, 'wind_speed', 'm/s', 'measurement'],
  gust: [OBS.windGust, 'wind_speed', 'm/s', 'measurement'],
  wind_dir: [OBS.windDir, null, '°', 'measurement'],
  uv: [OBS.uv, null, 'UV index', 'measurement'],
  solar: [OBS.solar, 'irradiance', 'W/m²', 'measurement'],
  lux: [OBS.lux, 'illuminance', 'lx', 'measurement'],
  rain: [OBS.rain, 'precipitation', 'mm', 'measurement'],
  day_rain: [OBS.dayRain, 'precipitation', 'mm', 'total_increasing'],
  battery: [OBS.battery, 'voltage', 'V', 'measurement'],
  strikes: [OBS.strikes, null, 'strikes', 'measurement'],
};

// Derived values Home Assistant can't work out for itself from the raw topics: what the air
// actually feels like, which way the barometer is going, and whether the dashboard has decided
// there is a storm on. Published on the same cadence as everything else.
const DERIVED = {
  feels_like: ['temperature', '°C', 'measurement'],
  pressure_trend: [null, null, null],
};

// Retained config topics: Home Assistant materializes the device from these the moment it (re)starts,
// with no help from this page. One shared `device` block keeps them under a single device.
function announce() {
  const s = settings();
  const device = {
    identifiers: [`weatherdesk_${s.stationId}`],
    name: s.stationName || `Tempest ${s.stationId}`,
    manufacturer: 'WeatherFlow',
    model: 'Tempest (via WeatherDesk)',
  };
  for (const [field, [, dc, unit, sc]] of Object.entries(FIELDS)) {
    const cfg = {
      name: field.replace(/_/g, ' '),
      unique_id: `wd_${s.stationId}_${field}`,
      state_topic: `${base()}/${field}`,
      availability_topic: availability(),
      unit_of_measurement: unit,
      state_class: sc,
      device,
    };
    if (dc) cfg.device_class = dc;
    client.publish(`homeassistant/sensor/wd_${s.stationId}_${field}/config`, JSON.stringify(cfg), true);
  }
  for (const [field, [dc, unit, sc]] of Object.entries(DERIVED)) {
    const cfg = {
      name: field.replace(/_/g, ' '),
      unique_id: `wd_${s.stationId}_${field}`,
      state_topic: `${base()}/${field}`,
      availability_topic: availability(),
      device,
    };
    if (unit) cfg.unit_of_measurement = unit;
    if (sc) cfg.state_class = sc;
    if (dc) cfg.device_class = dc;
    client.publish(`homeassistant/sensor/wd_${s.stationId}_${field}/config`, JSON.stringify(cfg), true);
  }
  // Binary sensors: the storm flag, and one per user rule so an automation can hang off a
  // threshold the user already wrote in the drawer instead of a second copy of it in YAML.
  const binaries = [['storm', 'safety'], ...(s.rules || []).map((r, i) => [`rule_${i + 1}`, null])];
  for (const [field, dc] of binaries) {
    const cfg = {
      name: field.replace(/_/g, ' '),
      unique_id: `wd_${s.stationId}_${field}`,
      state_topic: `${base()}/${field}`,
      payload_on: 'ON', payload_off: 'OFF',
      availability_topic: availability(),
      device,
    };
    if (dc) cfg.device_class = dc;
    client.publish(`homeassistant/binary_sensor/wd_${s.stationId}_${field}/config`, JSON.stringify(cfg), true);
    client.publish(`${base()}/${field}`, 'OFF', true);
  }
  for (const [name, types] of [['lightning', ['strike']], ['rain', ['start']], ['gust', ['gust']]]) {
    client.publish(`homeassistant/event/wd_${s.stationId}_${name}/config`, JSON.stringify({
      name, unique_id: `wd_${s.stationId}_${name}_evt`,
      state_topic: `${base()}/event/${name}`,
      availability_topic: availability(), event_types: types, device,
    }), true);
  }
  client.publish(availability(), 'online', true);
}

// One websocket observation -> one retained value per topic. Retained so a Home Assistant that
// restarts between reports shows the last reading instead of "unknown".
function publishObs(obs) {
  if (!client) return;
  for (const [field, [i]] of Object.entries(FIELDS)) {
    const v = obs[i];
    if (v != null) client.publish(`${base()}/${field}`, v, true);
  }
  // Feels-like: the same apparent temperature the hero shows, in SI so the history stays one
  // unit system forever. Heat index above 27 °C, wind chill below 10 °C, the reading between.
  const t = obs[OBS.temp], rh = obs[OBS.rh], w = obs[OBS.windAvg];
  if (t != null) client.publish(`${base()}/feels_like`, +feelsLike(t, rh, w).toFixed(1), true);
  const p = obs[OBS.press];
  if (p != null) client.publish(`${base()}/pressure_trend`, pressTrend(p, obs[OBS.time]), true);
  client.publish(`${base()}/storm`, stormMode() ? 'ON' : 'OFF', true);

  // Rain start: the edge, not the state — an automation wants to be told once.
  const precip = obs[OBS.precipType] || 0;
  if (precip && !lastPrecip) event('rain', { event_type: 'start', precip_type: precip });
  lastPrecip = precip;
  // Gust threshold, in the units the setting is written in. Re-arms at 80% so a gust hovering on
  // the line doesn't fire every minute.
  const s = settings();
  const gust = obs[OBS.windGust];
  if (gust != null && s.windGustAlert > 0) {
    const shown = msToWind(gust);
    if (!gustLatched && shown >= s.windGustAlert) {
      gustLatched = true;
      event('gust', { event_type: 'gust', speed: +shown.toFixed(1) });
    } else if (gustLatched && shown < s.windGustAlert * 0.8) {
      gustLatched = false;
    }
  }
}

// Apparent temperature, SI in and SI out. Two standard formulas and the plain reading between
// them, which is what every weather service does — anything cleverer here would disagree with
// the number on the hero for no reason.
export function feelsLike(c, rh, ms) {
  if (c >= 27 && rh != null) {
    const f = c * 9 / 5 + 32;
    const hi = -42.379 + 2.04901523 * f + 10.14333127 * rh - 0.22475541 * f * rh
      - 6.83783e-3 * f * f - 5.481717e-2 * rh * rh + 1.22874e-3 * f * f * rh
      + 8.5282e-4 * f * rh * rh - 1.99e-6 * f * f * rh * rh;
    return (hi - 32) * 5 / 9;
  }
  if (c <= 10 && ms != null && ms > 1.34) {
    const kph = ms * 3.6;
    return 13.12 + 0.6215 * c - 11.37 * kph ** 0.16 + 0.3965 * c * kph ** 0.16;
  }
  return c;
}

// Three hours of pressure in one word — the reading Home Assistant automations actually branch
// on, and the same bands the Desk's trend strip uses.
const pressRing = [];
export function pressTrend(mb, tSec = Math.floor(Date.now() / 1000)) {
  pressRing.push({ t: tSec, mb });
  while (pressRing.length && pressRing[0].t < tSec - 3 * 3600) pressRing.shift();
  const d = mb - pressRing[0].mb;
  if (d <= -2) return 'falling rapidly';
  if (d <= -0.5) return 'falling';
  if (d >= 2) return 'rising rapidly';
  if (d >= 0.5) return 'rising';
  return 'steady';
}

// Events are never retained: replaying an hour-old lightning strike into an automation on every
// Home Assistant restart would be worse than losing it.
function event(name, payload) {
  client?.publish(`${base()}/event/${name}`, JSON.stringify(payload));
}

// The LAN server publishes over plain MQTT and keeps doing it with every tab shut, which is the
// only way Home Assistant sensors stay available overnight. When it is, this page stays off the
// topics entirely — two publishers on one topic set is a fight nobody wins. The in-page
// publisher remains for a static host, a phone build, or a broker that only has a websocket
// listener open.
async function serverPublishing() {
  try {
    const d = await (await fetch(`${window.__WD_SRV || ''}/diag`, { signal: expires(4000) })).json();
    return !!d.mqtt?.ok;
  } catch { return false; }
}

export async function initHome() {
  client?.close();
  client = null;
  const s = settings();
  if (s.mqttUrl && s.stationId && !(await serverPublishing())) {
    client = mqtt({
      url: s.mqttUrl, user: s.mqttUser, pass: s.mqttPass,
      clientId: `weatherdesk-${s.stationId}-${Math.random().toString(16).slice(2, 8)}`,
      // Last will: the broker marks us offline when this tab goes away, so Home Assistant shows
      // the sensors as unavailable rather than serving a frozen reading forever.
      will: { topic: availability(), payload: 'offline', retain: true },
      onConnect: () => {
        announce();
        // Read-back from the broker itself, for the sensors that never went near Home
        // Assistant — a greenhouse probe publishing straight to mosquitto is the common case.
        client.subscribe((settings().mqttSubs || []).map((x) => x.topic));
      },
      onMessage: (topic, payload) => { subValues.set(topic, payload); renderSubs(); },
      onState: (st) => { const el = $('mqtt-state'); if (el) { el.textContent = st; el.className = st === 'connected' ? 'ok' : 'muted'; } },
    });
  } else if (s.mqttUrl && s.stationId) {
    const el = $('mqtt-state');
    if (el) { el.textContent = 'published by the server'; el.className = 'ok'; }
  }
  initHaPanel();
}

window.addEventListener('wd:ws-obs', (e) => publishObs(e.detail));

// Every banner the dashboard raises, on one topic, for automations to hang off. Not retained:
// an alert replayed on every broker reconnect would fire the same automation forever.
window.addEventListener('wd:notif', (e) => {
  const n = e.detail;
  if (!n || n.category === 'info') return;
  client?.publish(`${base()}/alert`, JSON.stringify({ title: n.title, body: n.body, category: n.category, t: n.t }));
});
// A rule that fired is a binary sensor going ON, and back OFF five minutes later — the rules
// engine reports edges, not levels, and an automation needs something to trigger on.
window.addEventListener('wd:rule', (e) => {
  if (!client) return;
  const field = `rule_${(e.detail?.index ?? 0) + 1}`;
  client.publish(`${base()}/${field}`, 'ON', true);
  setTimeout(() => client?.publish(`${base()}/${field}`, 'OFF', true), 5 * 60000);
});

window.addEventListener('wd:ws-strike', (e) => {
  // [epoch, distance km, energy]
  event('lightning', { event_type: 'strike', distance_km: e.detail[1] });
});

// --- broker read-back ---

const subValues = new Map();

function renderSubs() {
  const el = $('mqtt-subs');
  if (!el) return;
  const subs = settings().mqttSubs || [];
  el.innerHTML = subs
    .filter((x) => subValues.has(x.topic))
    .map((x) => `<div><span></span><span class="ok"></span></div>`)
    .join('');
  let i = 0;
  for (const x of subs) {
    if (!subValues.has(x.topic)) continue;
    const row = el.children[i++];
    row.children[0].textContent = x.label || x.topic;
    row.children[1].textContent = `${subValues.get(x.topic)}${x.unit ? ` ${x.unit}` : ''}`;
  }
  const panel = $('ha-panel');
  if (panel && el.children.length) panel.style.display = '';
}

// --- Home Assistant read-back ---

// The server reads Home Assistant when there is a server: one request for the whole state list
// instead of one per entity, the long-lived token stays out of the browser, and the CORS block
// most installs never edited their YAML for stops mattering — the fetch is same-origin.
//
// A static self-host has no server to ask, so the direct path stays as the fallback. That one
// does need `cors_allowed_origins` in Home Assistant's configuration.yaml, and always did.
async function haRows(ids) {
  try {
    const j = await (await fetch(`${window.__WD_SRV || ''}/ha/states`, { signal: expires(20000) })).json();
    if (j.error) throw new Error(j.error);
    const by = new Map(j.entities.map((e) => [e.id, e]));
    return ids.map((id) => {
      const e = by.get(id);
      return e
        ? { id, name: e.name, value: `${e.state}${e.unit ? ` ${e.unit}` : ''}`, ok: true }
        : { id, name: id, value: 'not in Home Assistant', ok: false };
    });
  } catch {
    const s = settings();
    const url = s.haUrl.replace(/\/+$/, '');
    return Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(`${url}/api/states/${encodeURIComponent(id)}`, {
          signal: expires(15000),
          headers: { Authorization: `Bearer ${s.haToken}` },
        });
        if (!r.ok) throw new Error(`${r.status}`);
        const j = await r.json();
        const u = j.attributes?.unit_of_measurement;
        return { id, name: j.attributes?.friendly_name || id, value: `${j.state}${u ? ` ${u}` : ''}`, ok: true };
      } catch (e) {
        return { id, name: id, value: e.message, ok: false };
      }
    }));
  }
}

function initHaPanel() {
  const panel = $('ha-panel');
  if (!panel) return;
  const s = settings();
  const ids = s.haEntities.split(/[\s,]+/).filter(Boolean);
  panel.style.display = s.haUrl && ids.length ? '' : 'none';
  if (!s.haUrl || !ids.length) return;
  every('ha-states', 30, async () => {
    const rows = await haRows(ids);
    // Home Assistant's own text, written in rather than interpolated: a friendly name is
    // whatever somebody typed into another application.
    $('ha-rows').innerHTML = rows.map(() => '<div><span></span><span></span></div>').join('');
    [...$('ha-rows').children].forEach((el, i) => {
      const [name, value] = el.querySelectorAll('span');
      name.textContent = rows[i].name;
      value.textContent = rows[i].value;
      value.className = rows[i].ok ? 'ok' : 'fail';
    });
    stamp('ha-stamp', 90);
  });
}
