// 06 Alert rules — user-built thresholds on live readings.
//
// The built-in alerts (NWS severe, high wind, rain start) answer the questions everyone has.
// This is for the ones only one household has: "tell me when the greenhouse hits 95", "tell me
// when the wind has been over 20 for a quarter of an hour".
//
// Fires through notify(), so a rule reaches every channel the banners already reach — the ntfy
// topic, the webhook, the broker — with no per-channel code here.
import { settings, saveSettings, notify, num, U, msToWind } from './app.js';
import { OBS } from './api.js';

const $ = (id) => document.getElementById(id);

// key -> [label, unit fn, digits]. The evaluator only ever sees this key set, so a saved rule
// naming a metric that no longer exists is skipped, not a crash.
export const METRICS = {
  temp: ['Temperature', U.temp, 1],
  dew: ['Dew point', U.temp, 1],
  gust: ['Wind gust', U.wind, 1],
  wind: ['Wind average', U.wind, 1],
  rh: ['Humidity', () => '%', 0],
  rain: ['Rain rate', () => `${U.precip()}/h`, 2],
  uv: ['UV index', () => '', 1],
  strikes3h: ['Lightning strikes · 3h', () => '', 0],
  press3h: ['Pressure change · 3h', U.press, 2],
};

export const OPS = { '>': 'above', '<': 'below' };

// --- reading the two obs shapes we get ---

const metric = () => settings().units === 'metric';
const toTemp = (c) => (c == null ? null : metric() ? c : c * 9 / 5 + 32);
const toWind = msToWind;
const toRain = (mm) => (mm == null ? null : mm * (metric() ? 1 : 1 / 25.4));
const toPress = (mb) => (mb == null ? null : mb * (metric() ? 1 : 0.02953));

// The REST station obs, already in display units.
function fromStation(o) {
  return {
    temp: o.air_temperature, dew: o.dew_point, gust: o.wind_gust, wind: o.wind_avg,
    rh: o.relative_humidity, rain: o.precip_accum_last_1hr, uv: o.uv,
    _press: o.station_pressure ?? o.barometric_pressure, _strikes: o.lightning_strike_count ?? 0,
    _t: o.timestamp || Math.floor(Date.now() / 1000),
  };
}

// The UDP/websocket obs_st tuple, SI. Rain there is the accumulation for one report interval —
// scale it to the hour so the threshold means what the label says.
function fromTuple(t) {
  const mins = t[OBS.reportInterval] || 1;
  return {
    temp: toTemp(t[OBS.temp]), dew: null, gust: toWind(t[OBS.windGust]), wind: toWind(t[OBS.windAvg]),
    rh: t[OBS.rh], rain: toRain(t[OBS.rain] == null ? null : t[OBS.rain] * (60 / mins)), uv: t[OBS.uv],
    _press: toPress(t[OBS.press]), _strikes: t[OBS.strikes] || 0,
    _t: t[OBS.time] || Math.floor(Date.now() / 1000),
  };
}

// Three hours of samples, for the two metrics that are a difference rather than a reading.
// Bounded by time, not count: a hub reporting every minute and a REST poll every ten both land
// here and neither should be able to grow it without limit.
const ring = [];
function derive(m) {
  ring.push({ t: m._t, press: m._press, strikes: m._strikes });
  const cutoff = m._t - 3 * 3600;
  while (ring.length && ring[0].t < cutoff) ring.shift();
  const first = ring.find((r) => r.press != null);
  m.press3h = first && m._press != null ? m._press - first.press : null;
  // Tempest reports strikes per interval, so 3h worth is a sum, not a difference.
  m.strikes3h = ring.reduce((a, r) => a + (r.strikes || 0), 0);
  return m;
}

// --- evaluation ---

// Per-rule state: when the condition first became true, and whether it has already fired.
const state = new Map();

const holds = (v, op, target) => (op === '>' ? v > target : v < target);

// Re-arm at 90% of the threshold (110% for a "below" rule): a gust hovering on 30 mph would
// otherwise notify on every single report. Same latch the gust alert in home.js uses.
const rearmed = (v, op, target) => (op === '>' ? v < target * 0.9 : v > target * 1.1);

// A rule may carry a second condition (`metric2`/`op2`/`value2`), and then both have to hold —
// "over 25 mph AND under 40% humidity" is a fire day, either half alone is a Tuesday. Rules
// saved before v3 have none of those keys and this returns true for them unchanged.
function second(m, r) {
  if (!r.metric2) return true;
  const v = m[r.metric2];
  if (!METRICS[r.metric2] || v == null || Number.isNaN(v)) return false;
  return holds(v, r.op2 || '>', r.value2);
}

export function evaluate(m, rules = settings().rules || [], nowSec = Math.floor(Date.now() / 1000)) {
  const fired = [];
  rules.forEach((r, i) => {
    const spec = METRICS[r.metric];
    const v = m[r.metric];
    if (!spec || v == null || Number.isNaN(v)) return;
    const st = state.get(i) || { since: null, latched: false };
    if (!holds(v, r.op, r.value) || !second(m, r)) {
      st.since = null;
      if (st.latched && rearmed(v, r.op, r.value)) st.latched = false;
      state.set(i, st);
      return;
    }
    st.since ??= nowSec;
    if (!st.latched && nowSec - st.since >= (r.durMin || 0) * 60) {
      st.latched = true;
      fired.push({ rule: r, value: v, index: i });
    }
    state.set(i, st);
  });
  return fired;
}

function run(m) {
  for (const { rule, value, index } of evaluate(derive(m))) {
    // home.js turns this into a per-rule binary sensor; the banner alone had no way to say
    // which rule it came from.
    window.dispatchEvent(new CustomEvent('wd:rule', { detail: { index, rule, value } }));
    const [label, unit, digits] = METRICS[rule.metric];
    notify({
      category: 'rule',
      title: `${label} ${OPS[rule.op]} ${num(rule.value, digits)}${unit()}`,
      body: `Now ${num(value, digits)}${unit()}${rule.durMin ? ` for ${rule.durMin} min` : ''}`,
    });
  }
}

window.addEventListener('wd:obs', (e) => run(fromStation(e.detail)));
window.addEventListener('wd:ws-obs', (e) => run(fromTuple(e.detail)));

// --- built-in: frost ---
//
// Not a rule the user has to think to write. The forecast low, not the reading: a warning that
// arrives when it is already freezing is not a warning.
window.addEventListener('wd:forecast', (e) => {
  const days = e.detail?.forecast?.daily?.slice(0, 2) || [];
  const limit = settings().units === 'metric' ? 1 : 34;
  for (const d of days) {
    if (d.air_temp_low == null || d.air_temp_low > limit) continue;
    notify({
      id: `frost-${d.day_start_local}`, category: 'winter',
      title: 'Frost expected',
      body: `Low ${num(d.air_temp_low)}${U.temp()} on ${new Date(d.day_start_local * 1000).toLocaleDateString([], { weekday: 'long' })}`,
    });
  }
});

// --- builder UI (settings drawer) ---

export function renderRules() {
  const rules = settings().rules || [];
  const opts = Object.entries(METRICS).map(([k, [label]]) => `<option value="${k}">${label}</option>`).join('');
  $('rule-metric').innerHTML = opts;
  $('rule-metric2').innerHTML = opts;
  const describe = (metric, op, value) => {
    const [label, unit, digits] = METRICS[metric] || ['(unknown metric)', () => '', 0];
    return `${label} ${OPS[op] || op} ${num(value, digits)}${unit()}`;
  };
  $('rule-list').innerHTML = rules.length
    ? rules.map((r, i) => {
        const text = describe(r.metric, r.op, r.value)
          + (r.metric2 ? ` AND ${describe(r.metric2, r.op2, r.value2)}` : '')
          + (r.durMin ? ` · ${r.durMin} min` : '');
        return `<div class="row" style="margin:0">
          <span class="place-hit" style="flex:1">${text}</span>
          <button class="sig-x" data-rule="${i}">×</button></div>`;
      }).join('')
    : '<div class="muted" style="font-size:12px">No rules yet</div>';
  $('rule-list').querySelectorAll('[data-rule]').forEach((b) => {
    b.onclick = () => {
      const next = [...(settings().rules || [])];
      next.splice(+b.dataset.rule, 1);
      state.clear(); // indices shift; stale latches would belong to the wrong rule
      saveSettings({ rules: next });
      renderRules();
    };
  });
}

export function initRules() {
  $('btn-rule-and').onclick = () => {
    const row = $('rule-and-row');
    row.style.display = row.style.display === 'none' ? '' : 'none';
    if (row.style.display === 'none') $('rule-value2').value = '';
  };
  $('btn-rule-add').onclick = () => {
    const value = parseFloat($('rule-value').value);
    if (Number.isNaN(value)) return;
    const value2 = parseFloat($('rule-value2').value);
    const and = $('rule-and-row').style.display !== 'none' && !Number.isNaN(value2);
    saveSettings({
      rules: [...(settings().rules || []), {
        metric: $('rule-metric').value,
        op: $('rule-op').value,
        value,
        durMin: +$('rule-dur').value || 0,
        // Absent, not null, when there is no second condition: an older client reading the same
        // /config blob has to see exactly the rule shape it wrote.
        ...(and ? { metric2: $('rule-metric2').value, op2: $('rule-op2').value, value2 } : {}),
      }],
    });
    $('rule-value').value = '';
    $('rule-value2').value = '';
    $('rule-and-row').style.display = 'none';
    renderRules();
  };
  renderRules();
}

// ponytail-lite self-check: the latch, which is the only part that can be wrong without being
// obvious — a rule that never fires and a rule that fires every minute look the same from here.
if (location.search.includes('selftest')) {
  state.clear();
  const r = [{ metric: 'gust', op: '>', value: 30, durMin: 0 }];
  console.assert(evaluate({ gust: 40 }, r, 0).length === 1, 'rules: fires over threshold');
  console.assert(evaluate({ gust: 40 }, r, 60).length === 0, 'rules: latched, no repeat');
  console.assert(evaluate({ gust: 29 }, r, 120).length === 0, 'rules: 29 is inside the re-arm band');
  console.assert(evaluate({ gust: 20 }, r, 180).length === 0, 'rules: re-arm is not a fire');
  console.assert(evaluate({ gust: 40 }, r, 240).length === 1, 'rules: fires again after re-arm');
  state.clear();
  const d = [{ metric: 'temp', op: '<', value: 32, durMin: 10 }];
  console.assert(evaluate({ temp: 30 }, d, 0).length === 0, 'rules: duration not yet met');
  console.assert(evaluate({ temp: 30 }, d, 599).length === 0, 'rules: still short');
  console.assert(evaluate({ temp: 30 }, d, 600).length === 1, 'rules: fires at the duration');
  state.clear();
  console.assert(evaluate({ temp: null }, d, 0).length === 0, 'rules: missing reading never fires');
  state.clear();

  // AND rules: both halves, and a pre-v3 rule with no second half unchanged
  const both = [{ metric: 'gust', op: '>', value: 25, durMin: 0, metric2: 'rh', op2: '<', value2: 40 }];
  console.assert(evaluate({ gust: 30, rh: 50 }, both, 0).length === 0, 'rules: AND needs both');
  console.assert(evaluate({ gust: 30, rh: 30 }, both, 60).length === 1, 'rules: AND fires when both hold');
  state.clear();
  console.assert(evaluate({ gust: 30 }, both, 0).length === 0, 'rules: AND with a missing second reading never fires');
  state.clear();
  console.assert(evaluate({ gust: 40 }, [{ metric: 'gust', op: '>', value: 30 }], 0).length === 1,
    'rules: a rule saved before v3 still fires');
  state.clear();
}
