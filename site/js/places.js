// Phase 6 — place search / saved places. Switching a place re-points every
// non-Tempest panel (alerts, AQI, models, nowcast, NWS) via app.js coords().
import * as api from './api.js';
import { settings, saveSettings, coords, refreshAll, notify } from './app.js';

const $ = (id) => document.getElementById(id);

export function renderPlaces() {
  const s = settings();
  const active = s.activePlace;
  const home = `<button class="place${active ? '' : ' on'}" data-id="">🏠 ${s.stationName || 'Station'}</button>`;
  $('places').innerHTML = home + s.places.map((p) =>
    `<button class="place${active === p.id ? ' on' : ''}" data-id="${p.id}">${p.name}<i data-del="${p.id}">×</i></button>`
  ).join('');

  $('places').querySelectorAll('.place').forEach((b) => {
    b.onclick = (e) => {
      if (e.target.dataset.del) {
        const id = e.target.dataset.del;
        saveSettings({
          places: settings().places.filter((p) => p.id !== id),
          activePlace: settings().activePlace === id ? null : settings().activePlace,
        });
        renderPlaces();
        refreshAll();
        return;
      }
      saveSettings({ activePlace: b.dataset.id || null });
      renderPlaces();
      updateHeader();
      refreshAll();
    };
  });
  updateHeader();
}

function updateHeader() {
  const c = coords();
  $('station-name').textContent = settings().activePlace ? `${c.name} (away)` : (c.name || '');
}

async function search() {
  const q = $('place-q').value.trim();
  if (!q) return;
  $('place-results').innerHTML = '<div class="muted">searching…</div>';
  try {
    const j = await api.geocode(q);
    $('place-results').innerHTML = (j.features || []).map((f, i) => {
      const p = f.properties;
      const label = api.placeLabel(p);
      return `<button class="place-hit" data-i="${i}">${label}</button>`;
    }).join('') || '<div class="muted">no matches</div>';
    $('place-results').querySelectorAll('.place-hit').forEach((b) => {
      b.onclick = () => {
        const f = j.features[+b.dataset.i];
        const p = f.properties;
        const place = {
          id: String(Date.now()),
          name: [p.city || p.name, p.state].filter(Boolean).join(', '),
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        };
        saveSettings({ places: [...settings().places, place], activePlace: place.id });
        $('place-results').innerHTML = '';
        $('place-q').value = '';
        renderPlaces();
        refreshAll();
      };
    });
  } catch (e) {
    $('place-results').innerHTML = `<div class="fail">${e.message}</div>`;
  }
}

export function initPlaces() {
  $('btn-place-search').onclick = search;
  $('place-q').onkeydown = (e) => { if (e.key === 'Enter') search(); };

  // notification category toggles
  $('notif-toggles').querySelectorAll('input[data-cat]').forEach((cb) => {
    cb.checked = settings().notif[cb.dataset.cat] !== false;
    cb.onchange = () => saveSettings({ notif: { ...settings().notif, [cb.dataset.cat]: cb.checked } });
  });

  $('btn-notif-test').onclick = () => {
    const cats = ['severe', 'precip', 'lightning', 'wind', 'winter', 'changes'];
    cats.forEach((c, i) => setTimeout(() => notify({
      id: `test-${c}-${Date.now()}`, category: c,
      title: `Test · ${c}`, body: 'Injected through the live notification pipe.',
    }), i * 400));
  };

  renderPlaces();
}
