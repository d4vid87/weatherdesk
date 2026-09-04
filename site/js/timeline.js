// One answer to “what happens when?” Past events come from the station archive; future events
// come from the same forecast, alerts and model guidance the rest of the Desk already uses.
import * as api from './api.js';
import { settings, U, num, every, msToWind } from './app.js';
import { forecast as deskForecast } from './desk.js';
import { openDetail } from './detail.js';

const $ = (id) => document.getElementById(id);
const HOUR = 3600;
const DEFAULT_CATS = ['precip', 'storm', 'winter', 'freeze', 'heat', 'wind', 'aqi', 'change', 'sun', 'alert'];
let history = [], alerts = [], aqi = null, models = null, events = [];
let filter = 'all';

export const timelineSettings = (s = settings()) => ({
  precip: 30,
  freezeC: 0,
  heatC: 35,
  gustMs: 13.4112, // 30 mph
  aqi: 101,
  categories: DEFAULT_CATS,
  ...(s.timeline || {}),
});

const metric = (v, imperial) => imperial ? v * 9 / 5 + 32 : v;
const wind = (v) => v == null ? null : msToWind(v);
const stamp = (t) => new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const eventId = (kind, start) => `${kind}-${Math.floor(start / HOUR)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function heatIndex(temp, rh, imperial = settings().units !== 'metric') {
  if (temp == null) return null;
  const f = imperial ? temp : temp * 9 / 5 + 32;
  if (f < 80 || rh == null || rh < 40) return temp;
  const hi = -42.379 + 2.04901523 * f + 10.14333127 * rh - 0.22475541 * f * rh
    - 0.00683783 * f * f - 0.05481717 * rh * rh + 0.00122874 * f * f * rh
    + 0.00085282 * f * rh * rh - 0.00000199 * f * f * rh * rh;
  return imperial ? hi : (hi - 32) / 1.8;
}

function candidate(kind, start, title, summary, metrics = {}, severity = 'info', source = 'forecast') {
  return { id: eventId(kind, start), kind, start, end: start + HOUR, severity, title, summary,
    confidence: 'Unavailable', confidenceReason: 'Only one usable forecast source', observed: source === 'station', metrics, source };
}

// Merge consecutive hours of the same condition. A one-hour threshold wobble should not make
// three cards for what is plainly one weather window.
export function mergeEvents(input, gap = 90 * 60) {
  const out = [];
  for (const e of [...input].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind))) {
    const prev = [...out].reverse().find((x) => x.kind === e.kind && e.start <= x.end + gap);
    if (prev) {
      prev.end = Math.max(prev.end, e.end);
      prev.severity = ['info', 'watch', 'warning'].indexOf(e.severity) > ['info', 'watch', 'warning'].indexOf(prev.severity)
        ? e.severity : prev.severity;
      Object.assign(prev.metrics, e.metrics);
    } else out.push({ ...e, metrics: { ...e.metrics } });
  }
  return out.filter((e) => e.end - e.start >= 2 * HOUR || e.observed || e.severity === 'warning'
    || e.kind === 'sun' || e.source === 'Open-Meteo nowcast').sort((a, b) => a.start - b.start);
}

export function modelConfidence(modelData, event) {
  const M = api.MODELS.split(',');
  const h = modelData?.hourly;
  if (!h?.time) return ['Unavailable', 'Only one usable forecast source', ''];
  const i = h.time.findIndex((t) => Math.abs(new Date(t).getTime() / 1000 - event.start) <= 1800);
  if (i < 0) return ['Unavailable', 'No model guidance for this hour', ''];
  const field = event.kind === 'precip' || event.kind === 'storm' || event.kind === 'winter'
    ? 'precipitation' : event.kind === 'wind' ? 'wind_speed_10m' : 'temperature_2m';
  const pairs = M.map((m) => [m.replace('_seamless', '').toUpperCase(), h[`${field}_${m}`]?.[i]]).filter(([, v]) => Number.isFinite(v));
  const vals = pairs.map(([, v]) => v);
  if (vals.length < 2) return ['Unavailable', 'Only one usable model', pairs.map(([n, v]) => `${n} ${num(v, 1)}`).join(' · ')];
  const spread = Math.max(...vals) - Math.min(...vals);
  const age = Date.now() / 1000 - (modelData._fetchedAt || Date.now() / 1000);
  const detail = `${pairs.map(([n, v]) => `${n} ${num(v, 1)}`).join(' · ')} · fetched ${Math.max(0, Math.round(age / 60))} min ago`;
  const precip = ['precip', 'storm', 'winter'].includes(event.kind);
  const imperial = settings().units !== 'metric';
  const low = event.kind === 'wind' ? msToWind(8) : precip ? (imperial ? 0.25 : 6) : (imperial ? 7 : 4);
  const medium = event.kind === 'wind' ? msToWind(3.5) : precip ? (imperial ? 0.08 : 2) : (imperial ? 3 : 1.7);
  if (precip && vals.some((v) => v <= 0) && vals.some((v) => v > 0)) return ['Low', 'Models disagree whether precipitation occurs', detail];
  if (age > 12 * HOUR || spread > low) return ['Low', age > 12 * HOUR ? 'Model guidance is aging' : 'Models disagree widely', detail];
  if (spread > medium) return ['Medium', 'Models differ on intensity or timing', detail];
  return ['High', `Models agree closely (${num(spread, 1)} spread)`, detail];
}

export function buildTimeline({ forecast, observations = [], nws = [], air = null, nowcast = null, modelData = null, now = Date.now() / 1000, prefs = timelineSettings() }) {
  const enabled = new Set(prefs.categories || DEFAULT_CATS);
  const imperial = settings().units !== 'metric';
  const raw = [];
  for (const o of observations) {
    const t = o[api.OBS.time], temp = o[api.OBS.temp], gust = o[api.OBS.windGust];
    if (!t || t < now - 24 * HOUR || t > now) continue;
    if (enabled.has('freeze') && temp != null && temp <= metric(prefs.freezeC, imperial)) raw.push(candidate('freeze', t, 'Freezing conditions', `${num(temp)}${U.temp()} observed`, { temp }, 'watch', 'station'));
    const hi = heatIndex(temp, o[api.OBS.rh], imperial);
    if (enabled.has('heat') && hi != null && hi >= metric(prefs.heatC, imperial)) raw.push(candidate('heat', t, 'Dangerous heat', `Heat index ${num(hi)}${U.temp()} observed`, { temp, heatIndex: hi }, 'warning', 'station'));
    if (enabled.has('wind') && gust != null && gust >= wind(prefs.gustMs)) raw.push(candidate('wind', t, 'Strong wind', `Gust ${num(gust)} ${U.wind()} observed`, { gust }, 'watch', 'station'));
    if (enabled.has('precip') && (o[api.OBS.rain] || 0) > 0) raw.push(candidate('precip', t, 'Rain observed', `${num(o[api.OBS.rain], 2)} ${U.precip()}`, { rain: o[api.OBS.rain] }, 'info', 'station'));
    if (enabled.has('change')) {
      const old = observations.find((x) => x[api.OBS.time] >= t - 3900 && x[api.OBS.time] <= t - 3300);
      const td = old?.[api.OBS.temp] == null || temp == null ? 0 : temp - old[api.OBS.temp];
      const pd = old?.[api.OBS.press] == null || o[api.OBS.press] == null ? 0 : o[api.OBS.press] - old[api.OBS.press];
      if (Math.abs(td) >= (imperial ? 5 : 3)) raw.push(candidate('change', t, 'Temperature changing quickly', `${td > 0 ? 'Up' : 'Down'} ${num(Math.abs(td), 1)}${U.temp()} in an hour`, { tempChange: td }, 'watch', 'station'));
      if (Math.abs(pd) >= (imperial ? 0.06 : 2)) raw.push(candidate('change', t, 'Pressure changing quickly', `${pd > 0 ? 'Up' : 'Down'} ${num(Math.abs(pd), 2)} ${U.press()} in an hour`, { pressureChange: pd }, 'watch', 'station'));
    }
  }
  const hourly = forecast?.forecast?.hourly || [];
  for (const h of hourly) {
    if (!h.time || h.time < now || h.time > now + 48 * HOUR) continue;
    const text = h.conditions || '';
    if (enabled.has('precip') && (h.precip_probability || 0) >= prefs.precip) raw.push(candidate('precip', h.time, 'Precipitation window', `${num(h.precip_probability)}% chance`, { pop: h.precip_probability }));
    if (enabled.has('storm') && /thunder/i.test(text)) raw.push(candidate('storm', h.time, 'Thunderstorms possible', text, {}, 'warning'));
    if (enabled.has('winter') && /snow|sleet|ice|freezing/i.test(text)) raw.push(candidate('winter', h.time, 'Wintry weather possible', text, {}, 'warning'));
    if (enabled.has('freeze') && h.air_temperature != null && h.air_temperature <= metric(prefs.freezeC, imperial)) raw.push(candidate('freeze', h.time, 'Freeze possible', `${num(h.air_temperature)}${U.temp()} forecast`, { temp: h.air_temperature }, 'watch'));
    const hi = heatIndex(h.air_temperature, h.relative_humidity, imperial);
    if (enabled.has('heat') && hi != null && hi >= metric(prefs.heatC, imperial)) raw.push(candidate('heat', h.time, 'Dangerous heat possible', `Heat index near ${num(hi)}${U.temp()}`, { temp: h.air_temperature, heatIndex: hi }, 'warning'));
    if (enabled.has('wind') && h.wind_gust != null && h.wind_gust >= wind(prefs.gustMs)) raw.push(candidate('wind', h.time, 'Strong wind possible', `Gusts near ${num(h.wind_gust)} ${U.wind()}`, { gust: h.wind_gust }, 'watch'));
  }
  if (enabled.has('sun')) for (const d of forecast?.forecast?.daily || []) {
    for (const [kind, t, title] of [['sunrise', d.sunrise, 'Sunrise'], ['sunset', d.sunset, 'Sunset']]) {
      if (t >= now - 24 * HOUR && t <= now + 48 * HOUR) raw.push(candidate('sun', t, title, stamp(t), { phase: kind }, 'info', 'astronomy'));
    }
  }
  if (enabled.has('alert')) for (const f of nws) {
    const p = f.properties || f;
    const rawStart = new Date(p.onset || p.effective || Date.now()).getTime() / 1000;
    const start = Math.max(now - 24 * HOUR, rawStart);
    const end = new Date(p.ends || p.expires || (start + HOUR) * 1000).getTime() / 1000;
    if (end >= now - 24 * HOUR && start <= now + 48 * HOUR) {
      raw.push({ ...candidate('alert', start, p.event || 'Weather alert', p.headline || p.areaDesc || '', {}, 'warning', 'NWS'), end: Math.min(end, now + 48 * HOUR) });
    }
  }
  const aq = air?.hourly;
  if (enabled.has('aqi') && aq?.time) aq.time.forEach((t, i) => {
    const v = aq.us_aqi?.[i]; const at = new Date(t).getTime() / 1000;
    if (v >= prefs.aqi && at >= now && at <= now + 48 * HOUR) raw.push(candidate('aqi', at, 'Unhealthy air quality', `AQI near ${num(v)}`, { aqi: v }, 'warning', 'Open-Meteo'));
  });
  const nc = nowcast?.minutely_15;
  if (enabled.has('precip') && nc?.time) nc.time.forEach((t, i) => {
    const pop = nc.precipitation_probability?.[i] || 0, amount = nc.precipitation?.[i] || 0;
    const at = new Date(t).getTime() / 1000;
    if ((pop >= prefs.precip || amount > 0) && at >= now && at <= now + 12 * HOUR) {
      raw.push({ ...candidate('precip', at, 'Near-term precipitation', `${num(pop)}% chance in the 15-minute nowcast`, { pop }, 'watch', 'Open-Meteo nowcast'), end: at + 900 });
    }
  });
  const merged = mergeEvents(raw);
  for (const e of merged) {
    [e.confidence, e.confidenceReason, e.modelDetail] = e.observed
      ? ['Observed', 'Measured by this station', '']
      : e.kind === 'sun' ? ['High', 'Calculated from the station location and date', '']
        : e.kind === 'alert' ? ['Official', 'Issued by the National Weather Service', '']
          : e.source === 'Open-Meteo nowcast' ? ['Medium', 'High-resolution near-term guidance', '']
            : e.kind === 'aqi' ? ['Unavailable', 'Air-quality guidance has one provider', '']
            : modelConfidence(modelData, e);
  }
  return merged;
}

function eventMetric(e) {
  return e.kind === 'wind' ? 'windGust' : e.kind === 'precip' ? 'rain' : e.kind === 'freeze' || e.kind === 'heat' ? 'temp' : null;
}

function card(e, compact = false) {
  const when = e.end - e.start > HOUR ? `${stamp(e.start)}–${stamp(e.end)}` : stamp(e.start);
  return `<article class="tl-event sev-${esc(e.severity)}" tabindex="0" data-event="${esc(e.id)}" aria-label="${esc(`${e.title}, ${when}`)}">
    <div class="tl-when">${esc(when)}</div><b>${esc(e.title)}</b><span>${esc(e.summary)}</span>
    ${compact ? '' : `<details><summary>${esc(e.confidence)} confidence</summary><p>${esc(e.confidenceReason)}</p>${e.modelDetail ? `<p class="muted">${esc(e.modelDetail)}</p>` : ''}<p class="muted">Source: ${esc(e.source)}</p></details>`}
  </article>`;
}

function render() {
  const now = Date.now() / 1000;
  const future = events.filter((e) => e.end >= now).slice(0, 3);
  const strip = $('timeline-strip');
  if (strip) strip.innerHTML = future.length ? future.map((e) => card(e, true)).join('') : '<div class="muted">Quiet weather in the next 48 hours</div>';
  const list = $('timeline-list');
  const shown = filter === 'all' ? events : events.filter((e) => e.kind === filter);
  if (list) list.innerHTML = shown.length ? shown.map((e) => card(e)).join('') : '<div class="muted">No matching timeline events</div>';
  const range = $('timeline-range');
  if (range) range.textContent = 'Past 24 hours  ·  NOW  ·  Next 48 hours';
}

async function refresh() {
  const fc = deskForecast();
  if (!fc) return;
  const settled = await Promise.allSettled([api.localObs(24), api.alerts(), api.aqi(), api.nowcast()]);
  history = settled[0].status === 'fulfilled' ? settled[0].value.obs || [] : history;
  alerts = settled[1].status === 'fulfilled' ? settled[1].value.features || [] : alerts;
  aqi = settled[2].status === 'fulfilled' ? settled[2].value : aqi;
  const near = settled[3].status === 'fulfilled' ? settled[3].value : null;
  events = buildTimeline({ forecast: fc, observations: history, nws: alerts, air: aqi, nowcast: near, modelData: models });
  render();
}

function activate(e) {
  const el = e.target.closest?.('[data-event]');
  if (!el) return;
  const item = events.find((x) => x.id === el.dataset.event);
  const metric = item && eventMetric(item);
  if (metric && item.observed) openDetail(metric, item.start * 1000);
  else document.querySelector('.tab[data-section="timeline"]')?.click();
}
document.addEventListener('click', activate);
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-tl-filter]');
  if (!b) return;
  filter = b.dataset.tlFilter;
  document.querySelectorAll('[data-tl-filter]').forEach((x) => x.classList.toggle('active', x === b));
  render();
});
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-event]')) { e.preventDefault(); activate(e); } });
window.addEventListener('wd:forecast', refresh);
window.addEventListener('wd:models', (e) => { models = e.detail; refresh(); });
window.addEventListener('wd:settings', () => { if (deskForecast()) refresh(); });

export function initTimeline() {
  every('timeline', 900, refresh);
}

if (location.search.includes('selftest')) {
  const a = candidate('wind', 1000, 'a', 'a'), b = candidate('wind', 4600, 'b', 'b');
  console.assert(mergeEvents([a, b]).length === 1, 'timeline: adjacent hours merge');
  console.assert(eventId('wind', 3601) === eventId('wind', 7199), 'timeline: ids are stable within an hour');
  console.assert(modelConfidence(null, a)[0] === 'Unavailable', 'timeline: missing models are honest');
  const mixed = { _fetchedAt: Date.now() / 1000, hourly: { time: [new Date(1000 * 1000).toISOString()] } };
  api.MODELS.split(',').forEach((m, i) => { mixed.hourly[`precipitation_${m}`] = [i ? 0.1 : 0]; });
  console.assert(modelConfidence(mixed, candidate('precip', 1000, 'rain', 'rain'))[0] === 'Low',
    'timeline: occurrence disagreement lowers confidence');
  console.assert(Math.round(heatIndex(95, 60, true)) === 113, 'timeline: heat index uses humidity');
  console.assert(Math.abs(heatIndex(35, 60, false) * 1.8 + 32 - heatIndex(95, 60, true)) < 0.01,
    'timeline: heat index agrees across units');
  const fc = { forecast: { hourly: [
    { time: 10_000, precip_probability: 40, conditions: 'Rain' },
    { time: 13_600, precip_probability: 50, conditions: 'Rain' },
  ], daily: [] } };
  const built = buildTimeline({ forecast: fc, now: 9_000, prefs: { ...timelineSettings(), categories: ['precip'] } });
  console.assert(built.length === 1 && built[0].start === 10_000 && built[0].end === 17_200,
    'timeline: threshold hours become one stable window');
}
