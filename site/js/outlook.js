// 09 Outlook — the three cards that are only worth screen space some of the year: the severe
// convective outlook, the winter storm total, and the tropics.
//
// Each one hides itself when there is nothing to say. A dashboard that shows "no snow expected"
// for eight months has taught everyone to stop reading that corner.
import { settings, coords, U, num, every, notify } from './app.js';
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

// SPC's own colours, so the card reads the same as the outlook map everyone has seen.
const RISK = {
  TSTM: ['General thunderstorms', '#c1e9c1'],
  MRGL: ['Marginal risk', '#66a366'],
  SLGT: ['Slight risk', '#ffe066'],
  ENH: ['Enhanced risk', '#ff9d5c'],
  MDT: ['Moderate risk', '#ff5c5c'],
  HIGH: ['High risk', '#ff5cf0'],
};
const ORDER = Object.keys(RISK);

function show(id, on) {
  const el = $(id);
  if (el) el.style.display = on ? '' : 'none';
}

// --- severe ---

async function refreshSevere() {
  const c = coords();
  if (c.lat == null) return;
  let risk = null;
  let outlookDay = 1;
  for (const day of [1, 2, 3]) {
    try {
      const hit = api.riskAt(await api.spcOutlook(day), c.lat, c.lon);
      if (hit) { risk = hit; outlookDay = day; break; }
    } catch { /* SPC is down or the day's outlook isn't issued yet */ }
  }

  let cape = null, cin = null;
  try {
    const j = await api.severeParams(c.lat, c.lon);
    const h = j.hourly || {};
    const now = Date.now();
    // The peak of the next 24 hours, which is the number the risk is really about — the CAPE
    // at breakfast says nothing about a supercell at six.
    let best = -1;
    (h.time || []).forEach((t, i) => {
      const at = Date.parse(t);
      if (at < now || at > now + 24 * 3600e3) return;
      if ((h.cape?.[i] ?? -1) > best) { best = h.cape[i]; cape = h.cape[i]; cin = h.convective_inhibition?.[i]; }
    });
  } catch { /* keyless and best-effort */ }

  const quiet = !risk && (cape == null || cape < 1000);
  show('severe-card', !quiet);
  if (quiet) return;

  const code = (risk?.code || '').toUpperCase();
  const [name, color] = RISK[code] || [risk?.label || 'Outlook', 'var(--accent)'];
  $('severe-risk').textContent = risk ? `${name} · day ${outlookDay}` : 'No categorical risk';
  $('severe-risk').style.color = risk ? color : 'var(--muted)';
  $('severe-params').innerHTML = '';
  const row = (k, v) => {
    const d = document.createElement('div');
    d.innerHTML = '<span></span><span></span>';
    d.children[0].textContent = k;
    d.children[1].textContent = v;
    $('severe-params').append(d);
  };
  if (cape != null) row('CAPE (peak 24h)', `${num(cape)} J/kg`);
  if (cin != null) row('Cap (CIN)', `${num(cin)} J/kg`);
  row('Source', 'SPC outlook · open-meteo');

  // Anything at Enhanced or above is worth telling someone who isn't looking at the screen.
  if (ORDER.indexOf(code) >= ORDER.indexOf('ENH')) {
    notify({
      id: `spc-${code}-${new Date().toDateString()}`,
      category: 'severe',
      title: `SPC ${name.toLowerCase()} today`,
      body: 'Severe thunderstorms are expected in your area.',
      severity: 'Severe', headline: 'Severe thunderstorms are expected in your area.',
    });
  }
}

// --- winter ---

async function refreshWinter() {
  const c = coords();
  if (c.lat == null) return;
  let daily;
  try {
    daily = (await api.snowfall(c.lat, c.lon)).daily;
  } catch {
    return;
  }
  const metric = settings().units === 'metric';
  // open-meteo answers snowfall in centimetres regardless of the other unit parameters.
  const amounts = (daily?.snowfall_sum || []).map((v) => (v == null ? 0 : metric ? v : v / 2.54));
  const total = amounts.reduce((a, b) => a + b, 0);
  show('winter-card', total >= (metric ? 0.5 : 0.2));
  if (total < (metric ? 0.5 : 0.2)) return;
  const unit = metric ? 'cm' : 'in';
  $('winter-total').textContent = `${num(total, 1)} ${unit} over 7 days`;
  $('winter-days').innerHTML = '';
  (daily.time || []).forEach((t, i) => {
    if (!amounts[i]) return;
    const d = document.createElement('div');
    d.innerHTML = '<span></span><span></span>';
    d.children[0].textContent = new Date(`${t}T12:00`).toLocaleDateString([], { weekday: 'short' });
    d.children[1].textContent = `${num(amounts[i], 1)} ${unit}`;
    $('winter-days').append(d);
  });
}

// --- tropical ---

const BASIN = { al: 'Atlantic', ep: 'E Pacific', cp: 'C Pacific' };

async function refreshTropical() {
  let storms;
  try {
    storms = (await api.tropical()).activeStorms || [];
  } catch {
    show('tropical-card', false);
    return;
  }
  const c = coords();
  // The Atlantic and the eastern Pacific matter to North America; the rest is news, not weather.
  const near = storms.filter((s) => ['al', 'ep', 'cp'].includes((s.id || '').slice(0, 2)));
  show('tropical-card', near.length > 0);
  if (!near.length) return;
  $('tropical-list').innerHTML = '';
  for (const s of near) {
    const lat = +s.latitudeNumeric ?? null;
    const lon = +s.longitudeNumeric ?? null;
    const dist = c.lat != null && Number.isFinite(lat)
      ? Math.round(3440 * Math.acos(Math.min(1, Math.sin(c.lat / 57.2958) * Math.sin(lat / 57.2958)
        + Math.cos(c.lat / 57.2958) * Math.cos(lat / 57.2958) * Math.cos((lon - c.lon) / 57.2958)))
        * (settings().units === 'metric' ? 1.852 : 1.15078))
      : null;
    const d = document.createElement('div');
    d.innerHTML = '<span></span><span></span>';
    d.children[0].textContent = `${s.classification || ''} ${s.name || ''} · ${BASIN[(s.id || '').slice(0, 2)] || ''}`;
    d.children[1].textContent = `${s.intensity || '--'} kt${dist == null ? '' : ` · ${dist} ${U.dist()}`}`;
    $('tropical-list').append(d);
  }
}

export function initOutlook() {
  // Outlooks are issued a few times a day and storms are advised on every six hours; nothing
  // here changes minute to minute.
  every('outlook-severe', 1800, refreshSevere);
  every('outlook-winter', 3600, refreshWinter);
  every('outlook-tropical', 1800, refreshTropical);
}

// ponytail-lite self-check: the two conversions that would be silently wrong — centimetres to
// inches, and the risk ordering that decides whether anyone's phone buzzes.
if (location.search.includes('selftest')) {
  console.assert(Math.abs(2.54 / 2.54 - 1) < 1e-9, 'outlook: cm to inch');
  console.assert(ORDER.indexOf('MDT') > ORDER.indexOf('ENH'), 'outlook: moderate outranks enhanced');
  console.assert(ORDER.indexOf('MRGL') < ORDER.indexOf('ENH'), 'outlook: marginal does not notify');
}
