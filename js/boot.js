// Wire the shell: settings drawer, diagnostics, nav, section modules.
import { settings, saveSettings, configured, initNav, fullscreen, refreshAll, notify } from './app.js';
import * as api from './api.js';
import { initDesk, refreshDesk, refreshObs, refreshAlerts, refreshAqi } from './desk.js';
import { initIntel, refreshModels, refreshNowcast } from './intel.js';
import { initSignals, refreshSignals } from './signals.js';
import { initBoards } from './boards.js';
import { initPlaces, renderPlaces } from './places.js';
import { initPro } from './pro.js';
import { initLayout } from './layout.js';

const $ = (id) => document.getElementById(id);

function fillDrawer() {
  const s = settings();
  $('set-token').value = s.token;
  $('set-station').value = s.stationId;
  $('set-device').value = s.deviceId;
  $('set-units').value = s.units;
  $('set-refresh').value = s.refreshSec;
  $('set-gust').value = s.windGustAlert;
}

const openDrawer = (open) => $('drawer').classList.toggle('open', open);

$('btn-settings').onclick = () => { fillDrawer(); openDrawer(true); };
$('btn-close').onclick = () => openDrawer(false);
$('btn-full').onclick = fullscreen;
$('btn-refresh').onclick = refreshAll;

$('btn-save').onclick = async () => {
  saveSettings({
    token: $('set-token').value.trim(),
    stationId: $('set-station').value.trim(),
    deviceId: $('set-device').value.trim(),
    units: $('set-units').value,
    refreshSec: +$('set-refresh').value || 60,
    windGustAlert: +$('set-gust').value || 30,
  });
  await hydrateStation();
  openDrawer(false);
  initDesk(); // idempotent: every() replaces existing jobs
  initIntel(); initSignals(); initBoards(); initPro(); initLayout();
};

// station meta fills name/lat/lon and the Tempest device id when blank
async function hydrateStation() {
  if (!configured()) return;
  try {
    const j = await api.station();
    const st = j.stations?.[0];
    if (!st) return;
    const tempest = st.devices?.find((d) => d.device_type === 'ST') || st.devices?.find((d) => d.device_type === 'AR');
    // history API wants the numeric device_id; a pasted serial (ST-00176465) won't work
    const numeric = /^\d+$/.test(settings().deviceId) ? settings().deviceId
      : (tempest ? String(tempest.device_id) : '');
    saveSettings({
      stationName: st.name,
      lat: st.latitude, lon: st.longitude,
      deviceId: numeric,
    });
    fillDrawer();
    renderPlaces();
  } catch (e) {
    notify({ title: 'Station lookup failed', body: e.message });
  }
}

$('btn-diag').onclick = async () => {
  $('diag').innerHTML = '<div class="muted">running…</div>';
  const rows = await api.diagnostics();
  $('diag').innerHTML = rows.map((r) =>
    `<div><span>${r.name}</span><span class="${r.ok ? 'ok' : 'fail'}">${r.ok ? '✓ ' : '✗ '}${r.detail}</span></div>`
  ).join('');
};

window.addEventListener('wd:refresh', () => {
  refreshDesk().catch((e) => notify({ title: 'Forecast failed', body: e.message }));
  refreshObs().catch(() => {});
  refreshAlerts().catch(() => {});
  refreshAqi().catch(() => {});
  refreshModels().catch(() => {});
  refreshNowcast().catch(() => {});
  refreshSignals().catch(() => {});
});

// Hook Echo-WX (own NEXRAD viewer) instead of the weathermap build. Deep link is
// `#goto=[SITE],lon,lat,zoom` — site-less form is legal, and note lon before lat.
const RADAR = 'https://hookecho.netlify.app/';
const radarUrl = (zoom) => {
  const s = settings();
  return s.lat == null ? RADAR : `${RADAR}#goto=,${s.lon},${s.lat},${zoom}`;
};

// lazy-load the Lab iframe on first visit, centered on the station
window.addEventListener('wd:section', (e) => {
  const f = $('lab-frame');
  if (e.detail !== 'lab' || f.src) return;
  f.src = radarUrl(8);
});

// inline radar strip on the Desk, same build, zoomed on the station
function loadDeskRadar() {
  const f = $('desk-radar-frame');
  if (f.src || settings().lat == null) return;
  f.src = radarUrl(6.5);
}
window.addEventListener('wd:settings', loadDeskRadar);

initNav();
initPlaces();

if (!configured()) {
  fillDrawer();
  openDrawer(true);
} else {
  // lat/lon must land before the open-meteo/NWS jobs start
  hydrateStation().then(() => { initDesk(); initIntel(); initSignals(); initBoards(); initPro(); initLayout(); loadDeskRadar(); });
}
