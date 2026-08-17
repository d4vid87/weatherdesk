// 04b Almanac — all-time records, this day last year, month by month.
//
// Source is the desktop app's own observation log (`/history/daily`), not the Tempest REST API:
// the REST history is capped and paged, and the point of the log is to keep going once it ends.
// Nothing here backfills — the archive starts the day the app was first run, and the panel says
// so rather than pretending the record is older than it is.
import { settings, U, num, every } from './app.js';
import { chart } from './charts.js';

const $ = (id) => document.getElementById(id);
const SRV = window.__WD_SRV || '';

// The log is SI, exactly as the hub broadcast it — the same conversion deviceObs() does, in the
// one place the almanac needs it.
export function toDisplay(row) {
  const metric = settings().units === 'metric';
  const t = (c) => (c == null ? null : metric ? c : c * 9 / 5 + 32);
  const wind = (ms) => (ms == null ? null : ms * (metric ? 3.6 : 2.23694));
  const rain = (mm) => (mm == null ? null : mm * (metric ? 1 : 1 / 25.4));
  return {
    day: row.day,
    tempMin: t(row.tempMin), tempMax: t(row.tempMax),
    gustMax: wind(row.gustMax), rain: rain(row.rain),
    strikes: row.strikes, battMin: row.battMin,
  };
}

let days = [];

async function load() {
  // The browser's own offset, because the process has no timezone and "a day" has to mean the
  // day the user lived through.
  const tz = -new Date().getTimezoneOffset();
  const r = await fetch(`${SRV}/history/daily?tz=${tz}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${r.status}`);
  days = (await r.json()).map(toDisplay);
}

const note = (msg) => {
  $('almanac').innerHTML = `<div class="muted">${msg}</div>`;
  $('board-monthly').textContent = 'Month by month';
};

// Widest value of a column, and the day it happened on.
export function extreme(rows, key, cmp) {
  let best = null;
  for (const d of rows) {
    if (d[key] == null) continue;
    if (!best || cmp(d[key], best[key])) best = d;
  }
  return best;
}

const pretty = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export async function refreshAlmanac() {
  try {
    await load();
  } catch {
    // Browser and Android installs have no log server; say which app has the archive rather
    // than leaving an empty card.
    note('Records come from the desktop app’s observation log — open WeatherDesk on the machine with the hub.');
    return;
  }
  if (!days.length) {
    note('Collecting. Records appear after the first full day of observations.');
    return;
  }

  const hi = extreme(days, 'tempMax', (a, b) => a > b);
  const lo = extreme(days, 'tempMin', (a, b) => a < b);
  const gust = extreme(days, 'gustMax', (a, b) => a > b);
  const wet = extreme(days, 'rain', (a, b) => a > b);
  const zap = extreme(days, 'strikes', (a, b) => a > b);

  // Same calendar day, a year back. Missing is the normal case in year one.
  const now = new Date();
  const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const key = `${lastYear.getFullYear()}-${String(lastYear.getMonth() + 1).padStart(2, '0')}-${String(lastYear.getDate()).padStart(2, '0')}`;
  const then = days.find((d) => d.day === key);

  const row = (k, v, when) => `<div><span>${k}</span><span>${v}${when ? ` <span class="muted">${pretty(when)}</span>` : ''}</span></div>`;
  $('almanac').innerHTML = [
    hi && row('Hottest', `${num(hi.tempMax, 1)}${U.temp()}`, hi.day),
    lo && row('Coldest', `${num(lo.tempMin, 1)}${U.temp()}`, lo.day),
    gust && row('Peak gust', `${num(gust.gustMax, 1)} ${U.wind()}`, gust.day),
    wet && row('Wettest day', `${num(wet.rain, 2)} ${U.precip()}`, wet.day),
    zap && zap.strikes ? row('Most lightning', `${num(zap.strikes)} strikes`, zap.day) : '',
    row('This day last year', then
      ? `${num(then.tempMax, 0)}° / ${num(then.tempMin, 0)}°, ${num(then.rain, 2)} ${U.precip()}`
      : 'no record yet'),
    row('Collecting since', pretty(days[0].day)),
    row('Days on record', num(days.length)),
  ].filter(Boolean).join('');

  drawMonthly();
}

// Rain by month, because it is the number a year of logging actually answers.
function drawMonthly() {
  const months = new Map();
  for (const d of days) {
    const m = d.day.slice(0, 7);
    const acc = months.get(m) || { rain: 0, hi: null, lo: null };
    acc.rain += d.rain || 0;
    if (d.tempMax != null) acc.hi = acc.hi == null ? d.tempMax : Math.max(acc.hi, d.tempMax);
    if (d.tempMin != null) acc.lo = acc.lo == null ? d.tempMin : Math.min(acc.lo, d.tempMin);
    months.set(m, acc);
  }
  const data = [...months].map(([m, v]) => ({ x: new Date(`${m}-15T12:00:00`).getTime(), y: v.rain }));
  chart($('c-monthly'), [{ data, type: 'bar', color: '#4fb8ff' }], { yMin: 0, digits: 2 });
  $('board-monthly').textContent = `Rain by month (${U.precip()}) — ${months.size} month${months.size === 1 ? '' : 's'} on record`;
}

export function initAlmanac() {
  window.addEventListener('wd:section', (e) => { if (e.detail === 'data') refreshAlmanac(); });
  every('almanac', 3600, () => {
    if ($('data').classList.contains('active')) refreshAlmanac();
  });
}

// ponytail-lite self-check: the record picker and the SI conversion, the two places a wrong
// answer would read as a plausible record.
if (location.search.includes('selftest')) {
  const rows = [{ day: '2025-01-01', tempMax: 10 }, { day: '2025-01-02', tempMax: null }, { day: '2025-01-03', tempMax: 30 }];
  console.assert(extreme(rows, 'tempMax', (a, b) => a > b).day === '2025-01-03', 'almanac: hottest day');
  console.assert(extreme(rows, 'tempMax', (a, b) => a < b).day === '2025-01-01', 'almanac: coldest ignores nulls');
  console.assert(extreme([], 'tempMax', (a, b) => a > b) === null, 'almanac: empty log has no record');
  const d = toDisplay({ day: '2025-01-01', tempMax: 0, gustMax: 10, rain: 25.4, strikes: 1, battMin: 2.6 });
  const imperial = settings().units !== 'metric';
  console.assert(Math.abs(d.tempMax - (imperial ? 32 : 0)) < 0.01, 'almanac: temp conversion');
  console.assert(Math.abs(d.rain - (imperial ? 1 : 25.4)) < 0.01, 'almanac: rain conversion');
}
