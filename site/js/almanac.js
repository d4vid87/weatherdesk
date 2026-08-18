// 04b Almanac — all-time records, this day last year, month by month.
//
// Source is the desktop app's own observation log (`/history/daily`), not the Tempest REST API:
// the REST history is capped and paged, and the point of the log is to keep going once it ends.
// Nothing here backfills — the archive starts the day the app was first run, and the panel says
// so rather than pretending the record is older than it is.
import { settings, U, num, every } from './app.js';
import { chart } from './charts.js';
import { normals, normalFor } from './api.js';

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
    await Promise.all([load(), loadCoverage()]);
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
    row('Records since', pretty(days[0].day)),
    row('Days on record', num(days.length)),
    coverageNote(),
  ].filter(Boolean).join('');

  drawMonthly();
  drawExplore();
}

// The archive can reach back further than the app has been running — see the backfill in the
// desktop server. Saying which is the difference between "we have one week" and "we have eight
// years and are still fetching".
let coverage = null;
async function loadCoverage() {
  try {
    const r = await fetch(`${SRV}/history/coverage`, { signal: AbortSignal.timeout(5000) });
    coverage = r.ok ? await r.json() : null;
  } catch { coverage = null; }
}

function coverageNote() {
  if (!coverage) return '';
  const state = coverage.backfill === 'running'
    ? 'still fetching older observations from WeatherFlow'
    : coverage.backfill === 'done' ? 'backfilled from WeatherFlow' : 'from this app only';
  return `<div><span>Archive</span><span class="muted">${num(coverage.count)} observations · ${state}</span></div>`;
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
  // Last year's months on the same axis, shifted forward a year so they line up with this
  // year's — the comparison everybody makes by eye anyway, drawn.
  const prior = data.map((p) => {
    const d = new Date(p.x);
    const key = `${d.getFullYear() - 1}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const v = months.get(key);
    return v ? { x: p.x, y: v.rain } : { x: p.x, y: null };
  });
  const series = [{ data, type: 'bar', color: '#4fb8ff', name: 'this year' }];
  if (prior.some((p) => p.y != null)) series.push({ data: prior, color: 'var(--muted)', dash: [4, 3], name: 'last year' });
  chart($('c-monthly'), series, { yMin: 0, digits: 2, label: 'rain by month', unit: U.precip() });
  $('board-monthly').textContent = `Rain by month (${U.precip()}) — ${months.size} month${months.size === 1 ? '' : 's'} on record`;
}

// --- explorer: any date range, any column ---

function drawExplore() {
  const from = $('ex-from').value || days[0]?.day;
  const to = $('ex-to').value || days[days.length - 1]?.day;
  const key = $('ex-metric').value;
  const rows = days.filter((d) => d.day >= from && d.day <= to && d[key] != null);
  const digits = key === 'rain' ? 2 : key === 'strikes' ? 0 : 1;
  const unit = key === 'rain' ? U.precip() : key === 'gustMax' ? U.wind() : key === 'strikes' ? '' : U.temp();
  chart($('c-explore'), [{
    data: rows.map((d) => ({ x: new Date(`${d.day}T12:00:00`).getTime(), y: d[key] })),
    color: '#4fb8ff',
    type: key === 'rain' || key === 'strikes' ? 'bar' : 'line',
  }], { digits, unit, label: $('ex-metric').selectedOptions[0].textContent, yMin: key === 'rain' ? 0 : undefined });
  if (!rows.length) { $('ex-summary').textContent = 'No observations in that range.'; return; }
  const vals = rows.map((d) => d[key]);
  const total = vals.reduce((a, b) => a + b, 0);
  $('ex-summary').textContent = `${rows.length} days · min ${num(Math.min(...vals), digits)}${unit}`
    + ` · max ${num(Math.max(...vals), digits)}${unit}`
    + ` · ${key === 'rain' || key === 'strikes' ? `total ${num(total, digits)}${unit}` : `mean ${num(total / vals.length, digits)}${unit}`}`;
}

// --- normals: what the date usually looks like, from 30 years of ERA5 ---

let normalDays = null;

export async function normalToday() {
  const c = settings();
  if (c.lat == null) return null;
  normalDays ||= await normals().catch(() => null);
  return normalFor(normalDays);
}

export function initAlmanac() {
  $('btn-explore').onclick = drawExplore;
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
