// Click a value, see the detail behind it.
//
// One mechanism, several entry points: any element carrying `data-metric` opens a slide-over
// with the last 48 h of that metric out of the app's own archive, the window's range and mean,
// and one plain line on what the number means. The panel is a dialog in everything but element
// name, the same contract as the settings drawer: it takes focus when it opens, gives it back
// when it closes, and Escape shuts it.
//
// A click on a point in any of the dashboard's own charts lands here too, with the time that was
// clicked: same panel, windowed on that moment instead of on now.

import { U, num, expires } from './app.js';
import * as api from './api.js';
import { chart } from './charts.js';

const $ = (id) => document.getElementById(id);
const I = api.OBS;

// What each clickable metric is: where it lives in an observation tuple, how it is labelled,
// and why it moves. Values from localObs() are already in display units.
export const METRICS = {
  temp: { label: 'Temperature', idx: I.temp, unit: () => U.temp(), digits: 1,
    blurb: 'Air temperature in the shade. It swings with the sun, the wind direction and what the sky is doing — a steady fall with rising humidity usually means weather on the way.' },
  rh: { label: 'Humidity', idx: I.rh, unit: () => '%', digits: 0,
    blurb: 'How much of the water the air could hold, it is holding. High overnight and falling through the morning is a normal day; high and staying high feeds fog, dew and storms.' },
  press: { label: 'Pressure', idx: I.press, unit: () => ` ${U.press()}`, digits: 2,
    blurb: 'The weight of the atmosphere overhead. The number matters less than the direction: steadily falling means unsettled weather approaching, rising means clearing.' },
  windAvg: { label: 'Wind', idx: I.windAvg, unit: () => ` ${U.wind()}`, digits: 1,
    blurb: 'Sustained wind, averaged over the report interval. Compare with the gust line — a big gap between them is what makes a day feel rougher than the average suggests.' },
  windGust: { label: 'Wind gust', idx: I.windGust, unit: () => ` ${U.wind()}`, digits: 1,
    blurb: 'The strongest burst in each interval. Gusts are what take branches and patio umbrellas; the sustained wind is what the forecast quotes.' },
  rain: { label: 'Rain', idx: I.rain, unit: () => ` ${U.precip()}`, digits: 2, bar: true, sum: true,
    blurb: 'Rain per interval as it fell. The bars show when it rained and how hard, which a daily total flattens away.' },
  uv: { label: 'UV index', idx: I.uv, unit: () => '', digits: 1,
    blurb: 'Sunburn strength, not brightness. It peaks at solar noon whatever the temperature says, and a thin overcast takes off less of it than it feels like it should.' },
  solar: { label: 'Solar radiation', idx: I.solar, unit: () => ' W/m²', digits: 0,
    blurb: 'Sunlight power landing on the station. The clean daily arc is a clear day; bites out of it are clouds passing over.' },
  strikes: { label: 'Lightning', idx: I.strikes, unit: () => '', digits: 0, bar: true, sum: true,
    blurb: 'Strikes detected per interval, out to roughly 25 miles. The station hears the radio crack of a strike — counts rise before a storm is overhead.' },
};

let returnTo = null;

function build() {
  if ($('detail')) return;
  const el = document.createElement('div');
  el.id = 'detail';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<button class="iconbtn" id="detail-close" title="Close">✕</button>'
    + '<h2 id="detail-title"></h2><div id="detail-now"></div>'
    + '<canvas id="detail-chart" class="chart" style="height:180px"></canvas>'
    + '<div id="detail-stats" class="kv-rows"></div><p id="detail-blurb" class="muted"></p>';
  document.body.appendChild(el);
  $('detail-close').onclick = close;
}

function close() {
  const el = $('detail');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  returnTo?.focus?.();
  returnTo = null;
}

// Click two metrics quickly and the slower archive read used to land last, painting the first
// metric's chart under the second one's title.
let gen = 0;

export async function openDetail(metric, at = null) {
  const m = METRICS[metric];
  if (!m) return;
  const mine = ++gen;
  build();
  const el = $('detail');
  returnTo = document.activeElement;
  $('detail-title').textContent = at
    ? `${m.label} · ${new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric' })}`
    : m.label;
  $('detail-blurb').textContent = m.blurb;
  $('detail-now').textContent = 'loading…';
  $('detail-stats').innerHTML = '';
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  $('detail-close').focus();
  try {
    const obs = (await api.localObs(48, at)).obs || [];
    if (mine !== gen) return;
    const pts = obs.map((o) => ({ x: o[I.time] * 1000, y: o[m.idx] })).filter((p) => p.y != null);
    if (!pts.length) {
      $('detail-now').textContent = at ? 'nothing in the archive around that time' : 'nothing in the archive for the last 48 h';
      return;
    }
    const ys = pts.map((p) => p.y);
    const fmt = (v) => `${num(v, m.digits)}${m.unit()}`;
    $('detail-now').textContent = at ? `${fmt(pts[pts.length - 1].y)} at the end of the window` : `${fmt(ys[ys.length - 1])} now`;
    chart($('detail-chart'), [{ data: pts, color: '#4fb8ff', type: m.bar ? 'bar' : 'line' }],
      { label: m.label, unit: m.unit().trim(), digits: m.digits, markX: at,
        xFormat: (x) => new Date(x).toLocaleTimeString([], at ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric' }) });
    const rows = m.sum
      ? [['Total · 48 h', fmt(ys.reduce((a, b) => a + b, 0))]]
      : [['High · 48 h', fmt(Math.max(...ys))], ['Low · 48 h', fmt(Math.min(...ys))],
         ['Mean · 48 h', fmt(ys.reduce((a, b) => a + b, 0) / ys.length)]];
    $('detail-stats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
  } catch (e) {
    if (mine !== gen) return;
    $('detail-now').textContent = `no archive to read — ${e.message}`;
  }
}

const hit = (e) => e.target.closest?.('[data-metric]');
// Module level: initDetail() runs again after a settings save, and duplicated delegates opened
// the slide-over twice per click.
document.addEventListener('click', (e) => { const t = hit(e); if (t) openDetail(t.dataset.metric); });
document.addEventListener('keydown', (e) => {
  const open = $('detail')?.classList.contains('open');
  // boot.js's shortcut handler skips Escape while this is open, so one press closes one thing.
  if (e.key === 'Escape') { if (open) close(); return; }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = hit(e);
  if (t) { e.preventDefault(); openDetail(t.dataset.metric); }
});

export function initDetail() {
  // One delegated listener, not one per value. A clickable value is a real keyboard target.
  for (const el of document.querySelectorAll('[data-metric]')) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.title = 'Click for the last 48 hours';
  }
}

// ponytail-lite self-check: every data-metric in the page resolves, so a typo fails loudly
// instead of opening an empty panel.
if (location.search.includes('selftest')) {
  for (const el of document.querySelectorAll('[data-metric]')) {
    console.assert(METRICS[el.dataset.metric], `detail: unknown metric ${el.dataset.metric}`);
  }
}
