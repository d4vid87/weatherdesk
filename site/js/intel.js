// Phase 2 — forecast intelligence: model agreement, timing anchor, live edge,
// nowcast, weather story, forecast changes, verification.
import * as api from './api.js';
import { settings, U, num, timeStr, every, notify, say } from './app.js';
import { snapshot, changes, recordForecast, scoreForecast, accuracy } from './track.js';
import { forecast as deskForecast, severeAlerts } from './desk.js';

const $ = (id) => document.getElementById(id);
const MODEL_LIST = api.MODELS.split(',');
const SHORT = { gfs_seamless: 'GFS', ecmwf_ifs025: 'ECMWF', icon_seamless: 'ICON', gem_seamless: 'GEM' };

let models = null;

export async function refreshModels() {
  if (settings().lat == null) return;
  models = await api.multiModel();
  renderAgreement();
  renderTiming();
  renderEdge();
}

function seriesFor(field, model) {
  return models.hourly[`${field}_${model}`] || [];
}

// index of the hour nearest now
function nowIndex() {
  const now = Date.now();
  const times = models.hourly.time.map((t) => new Date(t).getTime());
  let best = 0;
  times.forEach((t, i) => { if (Math.abs(t - now) < Math.abs(times[best] - now)) best = i; });
  return best;
}

// The three panels below this one already say everything; nobody reads three panels. This is the
// same numbers as one sentence — assembled, not computed.
function renderWhy({ worst, onsetMedian, onsetCount, edge }) {
  const parts = [];
  if (onsetMedian != null) {
    parts.push(`Precip around ${new Date(onsetMedian).toLocaleString([], { weekday: 'short', hour: 'numeric' })}`
      + ` in ${onsetCount} of ${MODEL_LIST.length} models`);
  } else parts.push('No model has precip in the next 48h');
  if (worst != null) {
    parts.push(worst < 3 ? `models agree within ${num(worst, 1)}${U.temp()}`
      : `models disagree by up to ${num(worst, 1)}${U.temp()}`);
  }
  if (edge != null && Math.abs(edge) >= 1) {
    parts.push(`your station is running ${num(Math.abs(edge), 1)}${U.temp()} ${edge > 0 ? 'warmer' : 'cooler'} than guidance`);
  }
  $('why').textContent = `${parts.join(', ')}.`;

  // How well this dashboard's own forecasts have actually verified — the only honest badge.
  const a = accuracy();
  const el = $('trust');
  el.textContent = a.mae == null ? '' : `${trustWord(a.mae)} · MAE ${num(a.mae, 1)}${U.temp()}`;
}

export const trustWord = (mae) => (mae <= 3 ? 'Good' : mae <= 5 ? 'Fair' : 'Watch closely');

// What the three renders below found, kept so the sentence can be written once from all of them.
const why = { worst: null, onsetMedian: null, onsetCount: 0, edge: null };

function renderAgreement() {
  const i0 = nowIndex();
  const rows = [];
  let worst = 0, worstHour = null;
  for (let i = i0; i < Math.min(i0 + 24, models.hourly.time.length); i++) {
    const vals = MODEL_LIST.map((m) => seriesFor('temperature_2m', m)[i]).filter((v) => v != null);
    if (vals.length < 2) continue;
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread > worst) { worst = spread; worstHour = models.hourly.time[i]; }
  }
  for (const m of MODEL_LIST) {
    const t = seriesFor('temperature_2m', m)[i0];
    const rainSum = seriesFor('precipitation', m).slice(i0, i0 + 24).reduce((a, b) => a + (b || 0), 0);
    rows.push(`<div><span>${SHORT[m]}</span><span>${num(t, 1)}${U.temp()} · ${num(rainSum, 2)} ${U.precip()}/24h</span></div>`);
  }
  why.worst = worst;
  renderWhy(why);
  const verdict = worst < 3 ? 'tight' : worst < 7 ? 'moderate' : 'wide';
  $('agree-verdict').textContent = `${verdict} (max spread ${num(worst, 1)}${U.temp()}${worstHour ? ` at ${timeStr(new Date(worstHour).getTime() / 1000)}` : ''})`;
  $('agree-rows').innerHTML = rows.join('');
}

function renderTiming() {
  const i0 = nowIndex();
  const onsets = [];
  for (const m of MODEL_LIST) {
    const p = seriesFor('precipitation', m);
    for (let i = i0; i < Math.min(i0 + 48, p.length); i++) {
      if ((p[i] || 0) > 0.01) { onsets.push(new Date(models.hourly.time[i]).getTime()); break; }
    }
  }
  if (!onsets.length) {
    why.onsetMedian = null; why.onsetCount = 0; renderWhy(why);
    $('timing').textContent = 'No precip in any model, next 48h';
    return;
  }
  onsets.sort((a, b) => a - b);
  const median = onsets[Math.floor(onsets.length / 2)];
  const spreadH = (onsets[onsets.length - 1] - onsets[0]) / 3600e3;
  why.onsetMedian = median; why.onsetCount = onsets.length; renderWhy(why);
  $('timing').innerHTML = `Consensus onset <b>${new Date(median).toLocaleString([], { weekday: 'short', hour: 'numeric' })}</b>`
    + ` · ${onsets.length}/${MODEL_LIST.length} models · spread ${num(spreadH, 1)}h`;
}

function renderEdge() {
  const cc = deskForecast()?.current_conditions;
  if (!cc || !models) return;
  const i0 = nowIndex();
  const vals = MODEL_LIST.map((m) => seriesFor('temperature_2m', m)[i0]).filter((v) => v != null);
  const consensus = vals.reduce((a, b) => a + b, 0) / vals.length;
  const d = cc.air_temperature - consensus;
  why.edge = d;
  renderWhy(why);
  $('edge').innerHTML = `Station <b>${num(cc.air_temperature, 1)}${U.temp()}</b> vs model consensus `
    + `${num(consensus, 1)}${U.temp()} — running <b>${d >= 0 ? '+' : ''}${num(d, 1)}${U.temp()}</b>`;
}

// --- 15-minute precip nowcast ---

export async function refreshNowcast() {
  if (settings().lat == null) return;
  const j = await api.nowcast();
  const t = j.minutely_15.time.map((x) => new Date(x).getTime());
  const p = j.minutely_15.precipitation;
  const now = Date.now();
  const i0 = t.findIndex((x) => x >= now);
  const raining = (p[i0] || 0) > 0;
  const idx = p.findIndex((v, i) => i >= i0 && (raining ? (v || 0) === 0 : (v || 0) > 0));
  const el = $('nowcast');
  if (idx < 0) {
    el.textContent = raining ? 'Precip continuing past forecast window' : 'Dry for the next 12 hours';
    return;
  }
  const mins = Math.round((t[idx] - now) / 60000);
  const msg = raining ? `Precip ends in ~${mins} min` : `Precip starts in ~${mins} min`;
  el.textContent = msg;
  if (mins <= 60) notify({ id: `precip-${t[idx]}`, category: 'precip', title: 'Precip nowcast', body: msg });
}

// --- weather story: derived 24h headlines ---

export function renderStory() {
  const fc = deskForecast();
  if (!fc) return;
  const hourly = (fc.forecast.hourly || []).slice(0, 24);
  const out = [];
  const maxGust = Math.max(...hourly.map((h) => h.wind_gust || 0));
  const maxT = Math.max(...hourly.map((h) => h.air_temperature));
  const minT = Math.min(...hourly.map((h) => h.air_temperature));
  const maxPop = Math.max(...hourly.map((h) => h.precip_probability || 0));
  const storm = hourly.find((h) => /thunder/i.test(h.conditions || ''));
  const wintry = hourly.find((h) => /snow|sleet|ice|freezing/i.test(h.conditions || ''));

  out.push(`Range ${num(minT)}–${num(maxT)}${U.temp()}, peak gust ${num(maxGust)} ${U.wind()}.`);
  if (maxPop >= 30) {
    const first = hourly.find((h) => (h.precip_probability || 0) >= 30);
    out.push(`Rain chance peaks ${num(maxPop)}%, first meaningful window ${timeStr(first.time)}.`);
  } else out.push('No meaningful rain chance in 24h.');
  if (storm) out.push(`Thunder possible around ${timeStr(storm.time)}.`);
  if (wintry) {
    out.push(`Wintry precip signalled around ${timeStr(wintry.time)}.`);
    notify({ id: `winter-${wintry.time}`, category: 'winter', title: 'Snow / ice in forecast', body: `${wintry.conditions} around ${timeStr(wintry.time)}` });
  }
  if (maxGust >= settings().windGustAlert) out.push('Wind advisory-level gusts in the period.');
  storyLines = out;
  $('story').innerHTML = out.map((s) => `<div>${s}</div>`).join('');
}

// --- spoken briefing ---

// The sentences the story panel is showing, so the briefing says the same thing the screen does
// rather than deriving a second opinion off the same forecast.
let storyLines = [];

// What a person across the room would want if they asked "what's it doing". Read off the hero
// rather than the forecast: the hero is already the station overlaid on the model, which is the
// number the dashboard is standing behind.
export function briefing() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  const t = (id) => ($(id)?.textContent || '').replace(/·/g, '.').trim();
  const alerts = severeAlerts();
  const parts = [
    greet,
    t('hero-temp') ? `It is ${t('hero-temp').replace('°', ' degrees')}.` : '',
    t('hero-cond') ? `${t('hero-cond')}.` : '',
    t('hero-feels'),
    t('hero-hilo') ? `${t('hero-hilo')}.` : '',
    ...storyLines,
    alerts.length ? `${alerts.length} active alert${alerts.length > 1 ? 's' : ''}: ${alerts.map((a) => a.title).join(', ')}.` : 'No active alerts.',
  ];
  return parts.filter(Boolean).join(' ');
}

// Module level for the same reason as the listeners below: initIntel() re-runs on every save.
document.addEventListener('click', (e) => {
  if (e.target.closest('#hero-icon')) say(briefing());
});
// It is a button, so it answers the keyboard like one.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('#hero-icon')) {
    e.preventDefault();
    say(briefing());
  }
});

// One briefing per day at the time in settings. A wall tablet nobody has touched since boot has
// no gesture yet, so the utterance lands in the replay hold and speaks on the first tap.
let briefedDay = '';
function briefTick() {
  const want = settings().briefTime;
  if (!want) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = now.toDateString();
  if (hhmm !== want || briefedDay === day) return;
  briefedDay = day;
  say(briefing());
}

// --- changes + verification panels ---

export function renderTrack() {
  const fc = deskForecast();
  if (!fc) return;
  snapshot(fc);
  recordForecast(fc);
  const ch = changes(fc);
  $('changes').innerHTML = ch.age == null
    ? '<div class="muted">No prior snapshot yet — needs ~20h of history.</div>'
    : (ch.items.length
        ? `<div class="muted" style="font-size:12px">vs ${ch.age}h ago</div>`
          + ch.items.map((i) => `<div><b>${i.day}</b> ${i.text}</div>`).join('')
        : `<div class="muted">Steady — no notable change vs ${ch.age}h ago.</div>`);

  // The diff reruns on every forecast fetch and the numbers wander by a degree between them, so
  // an id carrying the text announced the same change again and again — ten banners for one day.
  // One notification per day per comparison snapshot; the panel above still shows the live text.
  ch.items.forEach((i) => notify({
    id: `chg-${i.key}-${ch.base}`, category: 'changes',
    title: `Forecast change · ${i.day}`, body: i.text,
  }));

  const a = accuracy();
  $('verify').innerHTML = a.n
    ? `<div>24h-lead temp MAE <b>${num(a.mae, 1)}${U.temp()}</b> over ${a.n} checks</div>`
      + a.recent.map((v) => `<div class="muted" style="font-size:12px">${timeStr(v.targetHour)}: forecast ${num(v.fTemp)} / actual ${num(v.obsTemp)} (${(v.fTemp - v.obsTemp) >= 0 ? '+' : ''}${num(v.fTemp - v.obsTemp, 1)})</div>`).join('')
    : '<div class="muted">Collecting — first score lands 24h after setup.</div>';
}

if (location.search.includes('selftest')) {
  // The briefing has to say something even before a forecast has landed, and it must always end
  // with the alert sentence — silence about alerts reads as "no alerts" to someone listening.
  console.assert(/^Good (morning|afternoon|evening)\./.test(briefing()), 'intel: briefing opens with a greeting');
  console.assert(/alert/.test(briefing()), 'intel: briefing ends on the alert state');
  console.assert(trustWord(2) === 'Good' && trustWord(4) === 'Fair' && trustWord(9) === 'Watch closely',
    'intel: trust badge thresholds');
}

// Module level, not inside initIntel(): the settings wizard calls the init functions again
// after a save, and a second listener means a second render per event.
window.addEventListener('wd:forecast', () => { renderStory(); renderTrack(); renderEdge(); });
window.addEventListener('wd:obs', (e) => scoreForecast(e.detail));

export function initIntel() {
  every('intel-brief', 60, briefTick);
  every('intel-models', 900, refreshModels);
  every('intel-nowcast', 600, refreshNowcast);
}
