// Smart home: publish the station to an MQTT broker, and read a few Home Assistant entities back.
//
// Publishing goes out in SI, straight off the Tempest websocket — the REST endpoints return
// whatever display units the dashboard is set to, and mixing the two would quietly corrupt months
// of Home Assistant history the first time someone switches to metric. Home Assistant discovery
// is retained, so the device reappears after a restart without this page being open.
//
// HomeKit, Alexa and Google are reached through Home Assistant's own bridges — see README. There
// is no native code here for them, and there shouldn't be.

import { settings, every, stamp } from './app.js';
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
  // Rain start: the edge, not the state — an automation wants to be told once.
  const precip = obs[OBS.precipType] || 0;
  if (precip && !lastPrecip) event('rain', { event_type: 'start', precip_type: precip });
  lastPrecip = precip;
  // Gust threshold, in the units the setting is written in. Re-arms at 80% so a gust hovering on
  // the line doesn't fire every minute.
  const s = settings();
  const gust = obs[OBS.windGust];
  if (gust != null && s.windGustAlert > 0) {
    const shown = s.units === 'metric' ? gust * 3.6 : gust * 2.23694;
    if (!gustLatched && shown >= s.windGustAlert) {
      gustLatched = true;
      event('gust', { event_type: 'gust', speed: +shown.toFixed(1) });
    } else if (gustLatched && shown < s.windGustAlert * 0.8) {
      gustLatched = false;
    }
  }
}

// Events are never retained: replaying an hour-old lightning strike into an automation on every
// Home Assistant restart would be worse than losing it.
function event(name, payload) {
  client?.publish(`${base()}/event/${name}`, JSON.stringify(payload));
}

export function initHome() {
  client?.close();
  client = null;
  const s = settings();
  if (s.mqttUrl && s.stationId) {
    client = mqtt({
      url: s.mqttUrl, user: s.mqttUser, pass: s.mqttPass,
      clientId: `weatherdesk-${s.stationId}-${Math.random().toString(16).slice(2, 8)}`,
      // Last will: the broker marks us offline when this tab goes away, so Home Assistant shows
      // the sensors as unavailable rather than serving a frozen reading forever.
      will: { topic: availability(), payload: 'offline', retain: true },
      onConnect: announce,
      onState: (st) => { const el = $('mqtt-state'); if (el) { el.textContent = st; el.className = st === 'connected' ? 'ok' : 'muted'; } },
    });
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
window.addEventListener('wd:ws-strike', (e) => {
  // [epoch, distance km, energy]
  event('lightning', { event_type: 'strike', distance_km: e.detail[1] });
});

// --- Home Assistant read-back ---

// One GET per entity id. A picker would mean pulling the whole state list and rendering a tree;
// the ids are copy-paste from Home Assistant's own UI.
function initHaPanel() {
  const panel = $('ha-panel');
  if (!panel) return;
  const s = settings();
  const ids = s.haEntities.split(/[\s,]+/).filter(Boolean);
  panel.style.display = s.haUrl && ids.length ? '' : 'none';
  if (!s.haUrl || !ids.length) return;
  every('ha-states', 30, async () => {
    const url = s.haUrl.replace(/\/+$/, '');
    const rows = await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(`${url}/api/states/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${s.haToken}` },
        });
        if (!r.ok) throw new Error(`${r.status}`);
        const j = await r.json();
        return `<div><span>${j.attributes?.friendly_name || id}</span>`
          + `<span class="ok">${j.state}${j.attributes?.unit_of_measurement ? ' ' + j.attributes.unit_of_measurement : ''}</span></div>`;
      } catch (e) {
        return `<div><span>${id}</span><span class="fail">${e.message}</span></div>`;
      }
    }));
    $('ha-rows').innerHTML = rows.join('');
    stamp('ha-stamp', 90);
  });
}
