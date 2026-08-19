// Forecast snapshots, change diffs, and forecast-vs-actual verification.
// All localStorage; no server, no history API needed.
import { load, store, U, num } from './app.js';

const SNAP_KEY = 'wd.snap', VERIFY_KEY = 'wd.verify';
const SNAP_MIN_GAP_H = 3, SNAP_CAP = 60, VERIFY_CAP = 200;
const COMPARE_MIN_AGE_H = 20;
const H = 3600e3;

const snaps = () => load(SNAP_KEY, []);
const verifies = () => load(VERIFY_KEY, []);

// --- snapshots ---

function condense(fc) {
  return {
    t: Date.now(),
    daily: (fc.forecast.daily || []).slice(0, 7).map((d) => ({
      key: new Date(d.day_start_local * 1000).toDateString(),
      label: new Date(d.day_start_local * 1000).toLocaleDateString([], { weekday: 'short' }),
      hi: d.air_temp_high, lo: d.air_temp_low, pop: d.precip_probability, cond: d.conditions,
    })),
  };
}

export function snapshot(fc) {
  const list = snaps();
  const last = list[list.length - 1];
  if (last && Date.now() - last.t < SNAP_MIN_GAP_H * H) return list;
  list.push(condense(fc));
  while (list.length > SNAP_CAP) list.shift();
  store(SNAP_KEY, list);
  return list;
}

// Diff current forecast against the newest snapshot at least COMPARE_MIN_AGE_H old.
export function changes(fc) {
  const list = snaps();
  const cutoff = Date.now() - COMPARE_MIN_AGE_H * H;
  const old = [...list].reverse().find((s) => s.t <= cutoff);
  if (!old) return { age: null, items: [] };

  const now = condense(fc);
  const items = [];
  for (const d of now.daily) {
    const o = old.daily.find((x) => x.key === d.key);
    if (!o) continue;
    const bits = [];
    if (Math.abs(d.hi - o.hi) >= 3) bits.push(`hi ${num(o.hi)}→${num(d.hi)}${U.temp()}`);
    if (Math.abs(d.lo - o.lo) >= 3) bits.push(`lo ${num(o.lo)}→${num(d.lo)}${U.temp()}`);
    if (Math.abs((d.pop || 0) - (o.pop || 0)) >= 20) bits.push(`rain ${num(o.pop)}%→${num(d.pop)}%`);
    if (d.cond !== o.cond) bits.push(`${o.cond}→${d.cond}`);
    // key is the calendar day, not the weekday label: 'Wed' comes round again every week, and a
    // notification id built from the label would collide with last week's.
    if (bits.length) items.push({ key: d.key, day: d.label, text: bits.join(', ') });
  }
  return { age: Math.round((Date.now() - old.t) / H), base: old.t, items };
}

// --- verification: record what was forecast for a future hour, score it when that hour arrives ---

export function recordForecast(fc) {
  const hourly = fc.forecast.hourly || [];
  const list = verifies();
  // one prediction per fetch: the hour 24h out
  const target = hourly.find((h) => h.time * 1000 > Date.now() + 24 * H);
  if (target && !list.some((v) => v.targetHour === target.time)) {
    list.push({
      targetHour: target.time, leadH: 24,
      fTemp: target.air_temperature, fPop: target.precip_probability,
      obsTemp: null, obsPrecip: null,
    });
  }
  while (list.length > VERIFY_CAP) list.shift();
  store(VERIFY_KEY, list);
}

// Called with current station obs; fills in any prediction whose target hour is now.
export function scoreForecast(obs) {
  if (!obs) return;
  const now = Date.now();
  const list = verifies();
  let dirty = false;
  for (const v of list) {
    if (v.obsTemp != null) continue;
    if (Math.abs(v.targetHour * 1000 - now) < 30 * 60e3) {
      v.obsTemp = obs.air_temperature;
      v.obsPrecip = (obs.precip_accum_last_1hr || 0) > 0;
      dirty = true;
    }
  }
  if (dirty) store(VERIFY_KEY, list);
}

export function accuracy() {
  const scored = verifies().filter((v) => v.obsTemp != null);
  const errs = scored.map((v) => Math.abs(v.fTemp - v.obsTemp));
  return {
    n: scored.length,
    mae: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
    recent: scored.slice(-8).reverse(),
  };
}

export function clearAll() {
  localStorage.removeItem(SNAP_KEY);
  localStorage.removeItem(VERIFY_KEY);
}
