// Weather and gauge artwork. Emoji render differently on every platform and can't be recoloured,
// so the dashboard draws its own: one set of condition glyphs keyed to the Tempest icon strings,
// and one set of gauge faces (compass, dial, droplet, thermometer).
//
// Everything is a plain SVG string sized by its container's font-size / CSS width, so a caller can
// drop one anywhere without knowing pixel dimensions.

const SUN = (cx, cy, r, glow) => `
  ${glow ? `<circle cx="${cx}" cy="${cy}" r="${r * 2.1}" fill="url(#sunGlow)"/>` : ''}
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#sunFill)"/>`;

const RAYS = (cx, cy, r) => Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  const x1 = cx + Math.cos(a) * (r + 3), y1 = cy + Math.sin(a) * (r + 3);
  const x2 = cx + Math.cos(a) * (r + 7), y2 = cy + Math.sin(a) * (r + 7);
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
    stroke="#ffd257" stroke-width="2.4" stroke-linecap="round"/>`;
}).join('');

const MOON = (cx, cy, r) => `
  <path d="M ${cx + r * 0.35} ${cy - r} a ${r} ${r} 0 1 0 ${r * 0.62} ${r * 1.5}
           a ${r * 0.95} ${r * 0.95} 0 1 1 ${-r * 0.62} ${-r * 1.5} z" fill="#e8eeff"/>`;

// One cloud, drawn from the bottom edge up so it sits on whatever is beneath it.
const CLOUD = (x, y, s, fill = 'url(#cloudFill)') => `
  <path transform="translate(${x} ${y}) scale(${s})" fill="${fill}" d="M 6 20
    a 7 7 0 0 1 1 -13.9 a 9.5 9.5 0 0 1 18 -1.4 a 6.5 6.5 0 0 1 1.6 12.8 z"/>`;

const DROPS = (x, y, n, color = '#5ec6ff') => Array.from({ length: n }, (_, i) => {
  const dx = x + i * 6.5;
  return `<line x1="${dx}" y1="${y}" x2="${dx - 2.5}" y2="${y + 6}" stroke="${color}"
    stroke-width="2.4" stroke-linecap="round"/>`;
}).join('');

const FLAKES = (x, y, n) => Array.from({ length: n }, (_, i) =>
  `<text x="${x + i * 7}" y="${y + 6}" fill="#cfe8ff" font-size="8">✳</text>`).join('');

const BOLT = (x, y, s = 1, color = '#ffd257') =>
  `<path transform="translate(${x} ${y}) scale(${s})" fill="${color}" d="M 5 0 L 0 9 L 3.6 9 L 1.4 17 L 8 7 L 4.4 7 z"/>`;

// Gradients every glyph shares. Injected once per SVG; ids are namespaced by the caller's markup
// living in the same document, which is fine because the definitions are identical.
const DEFS = `<defs>
  <radialGradient id="sunGlow"><stop offset="0" stop-color="#ffe9a8" stop-opacity=".55"/>
    <stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/></radialGradient>
  <linearGradient id="sunFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffe07a"/><stop offset="1" stop-color="#ffb43d"/></linearGradient>
  <linearGradient id="cloudFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f2f6fb"/><stop offset="1" stop-color="#c3ceda"/></linearGradient>
  <linearGradient id="darkCloud" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#9fb0c2"/><stop offset="1" stop-color="#6f8296"/></linearGradient>
</defs>`;

// Tempest's icon strings, grouped by what they should look like.
const has = (icon, ...words) => words.some((w) => (icon || '').includes(w));

// Meteocons (MIT, Bas Milius — see icons/LICENSE), keyed to the exact vocabulary the forecast
// payloads use. Vendored twice: `anim/` carries the SMIL animation, `static/` is the same file
// with the animation elements stripped.
//
// ponytail: loaded through <img>, not inlined. Every file reuses gradient ids `a`..`e`, so two
// inline copies on one page collide and the second draws with the first one's colours. SMIL runs
// inside <img> on every engine here, and sw.js already cache-firsts image requests.
const METEO = {
  'clear-day': 'clear-day', 'clear-night': 'clear-night',
  cloudy: 'overcast', foggy: 'fog',
  'partly-cloudy-day': 'partly-cloudy-day', 'partly-cloudy-night': 'partly-cloudy-night',
  'possibly-rainy-day': 'partly-cloudy-day-rain', 'possibly-rainy-night': 'partly-cloudy-night-rain',
  'possibly-sleet-day': 'partly-cloudy-day-sleet', 'possibly-sleet-night': 'partly-cloudy-night-sleet',
  'possibly-snow-day': 'partly-cloudy-day-snow', 'possibly-snow-night': 'partly-cloudy-night-snow',
  'possibly-thunderstorm-day': 'thunderstorms-day', 'possibly-thunderstorm-night': 'thunderstorms-night',
  rainy: 'rain', sleet: 'sleet', snow: 'snow', thunderstorm: 'thunderstorms-rain', windy: 'wind',
};

/** Path to the vendored glyph, animated only at Full motion. */
export function wxSrc(key, still = false) {
  const name = METEO[key];
  if (!name) return '';
  const dir = !still && document.documentElement.dataset.motion === 'full' ? 'anim' : 'static';
  return `icons/${dir}/${name}.svg`;
}

/**
 * Condition glyph. `icon` is a Tempest `better_forecast` icon string. Falls back to the
 * hand-drawn SVG below for anything the vendored set has no name for.
 */
export function wx(icon, size = 44, still = false) {
  const src = wxSrc(icon, still);
  if (src) return `<img class="wx" src="${src}" width="${size}" height="${size}" alt="" decoding="async">`;
  return wxDrawn(icon, size);
}

function wxDrawn(icon, size = 44) {
  const night = has(icon, 'night');
  const body = (() => {
    if (has(icon, 'thunder')) return CLOUD(3, 8, 1.2, 'url(#darkCloud)') + BOLT(16, 26, 1.1);
    if (has(icon, 'snow', 'sleet')) return CLOUD(3, 6, 1.2, 'url(#darkCloud)') + FLAKES(10, 30, 3);
    if (has(icon, 'rain', 'drizzle')) return CLOUD(3, 6, 1.2, 'url(#darkCloud)') + DROPS(12, 30, 3);
    if (has(icon, 'foggy', 'fog', 'haze')) {
      return CLOUD(3, 4, 1.2) + [0, 1, 2].map((i) =>
        `<line x1="8" y1="${30 + i * 5}" x2="${36 - i * 4}" y2="${30 + i * 5}" stroke="#aebccb"
          stroke-width="2.4" stroke-linecap="round"/>`).join('');
    }
    if (has(icon, 'cloudy') && !has(icon, 'partly')) return CLOUD(4, 10, 1.35, 'url(#darkCloud)');
    if (has(icon, 'partly', 'mostly-clear')) {
      return (night ? MOON(17, 15, 8) : SUN(17, 15, 9, true) + RAYS(17, 15, 9)) + CLOUD(10, 18, 1.05);
    }
    if (has(icon, 'wind')) {
      return SUN(16, 16, 8, true) + [0, 1, 2].map((i) =>
        `<line x1="6" y1="${28 + i * 5}" x2="${34 - i * 5}" y2="${28 + i * 5}" stroke="#9fe6c0"
          stroke-width="2.4" stroke-linecap="round"/>`).join('');
    }
    return night ? MOON(22, 22, 12) : SUN(22, 22, 12, true) + RAYS(22, 22, 12);
  })();
  return `<svg class="wx" width="${size}" height="${size}" viewBox="0 0 44 44">${DEFS}${body}</svg>`;
}

/** The oversized hero version: the same glyph on a bigger canvas. */
export const wxHero = (icon, size = 120) => wx(icon, size);

// ---------- gauge faces ----------
//
// Each returns the SVG for a 100x100 viewBox. The value text is layered over it in HTML rather
// than drawn as <text>, so it inherits the panel's font and stays selectable.

const RING_R = 42;
const CIRC = 2 * Math.PI * RING_R;
const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));

// Every face is built once and then updated through `update()` below: the `data-*` hooks mark
// the parts that carry the value, so a new reading is a couple of attribute writes (which the
// stylesheet transitions) instead of re-parsing the whole SVG on every observation.

/** Plain progress ring — humidity, rain, wet bulb. */
export function ring(frac, color, { track = '#253141', width = 5 } = {}) {
  const f = clamp01(frac);
  return `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="${track}" stroke-width="${width}"/>
    <circle data-arc="ring" data-tint cx="50" cy="50" r="${RING_R}" fill="none" stroke="${color}" stroke-width="${width}"
      stroke-linecap="round" stroke-dasharray="${(f * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"
      transform="rotate(-90 50 50)"/>
    <circle data-dot data-tint cx="50" cy="${50 - RING_R}" r="${width * 0.7}" fill="${color}"
      style="transform: rotate(${(f * 360).toFixed(1)}deg)"/>
  </svg>`;
}

/** Compass rose with a wind-direction needle. `deg` is the direction the wind comes FROM. */
export function compass(deg, frac, color = '#4fdc8b') {
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const major = i % 9 === 0;
    const a = (i * 10 * Math.PI) / 180;
    const r1 = major ? 33 : 37, r2 = 41;
    return `<line x1="${(50 + Math.sin(a) * r1).toFixed(1)}" y1="${(50 - Math.cos(a) * r1).toFixed(1)}"
      x2="${(50 + Math.sin(a) * r2).toFixed(1)}" y2="${(50 - Math.cos(a) * r2).toFixed(1)}"
      stroke="${major ? '#4a5a6c' : '#2b3745'}" stroke-width="${major ? 2 : 1}"/>`;
  }).join('');
  // Drawn at full length and scaled: the needle grows with the wind speed, and a scale animates
  // where a redrawn path cannot.
  const LEN = 34;
  const scale = (20 + clamp01(frac) * 14) / LEN;
  return `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="#253141" stroke-width="1.5"/>
    ${ticks}
    <text x="50" y="15" text-anchor="middle" font-size="8" fill="#7d8a99">N</text>
    <g data-needle style="transform: rotate(${((deg || 0) + 180).toFixed(1)}deg)">
      <g data-len style="transform: scale(${scale.toFixed(3)})">
        <path data-tint d="M 50 ${50 - LEN} L 45 50 L 55 50 z" fill="${color}" opacity=".95"/>
        <path data-tint d="M 45 50 L 55 50 L 50 ${50 + LEN * 0.4} z" fill="${color}" opacity=".35"/>
      </g>
    </g>
    <circle cx="50" cy="50" r="3" fill="#0d141c" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

/** Barometer dial: an arc plus a needle at the current pressure. */
export function dial(frac, color = '#c9a6ff') {
  const f = clamp01(frac);
  const a = (-120 + f * 240) * (Math.PI / 180);
  const arc = 240 / 360;
  return `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="#253141" stroke-width="5"
      stroke-linecap="round" stroke-dasharray="${(arc * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"
      transform="rotate(120 50 50)"/>
    <circle data-arc="dial" data-tint cx="50" cy="50" r="${RING_R}" fill="none" stroke="${color}" stroke-width="5"
      stroke-linecap="round" stroke-dasharray="${(f * arc * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"
      transform="rotate(120 50 50)"/>
    <line data-needle data-tint x1="50" y1="50" x2="50" y2="20" stroke="${color}" stroke-width="2.5"
      stroke-linecap="round" style="transform: rotate(${(a * 180 / Math.PI).toFixed(1)}deg)"/>
    <circle cx="50" cy="50" r="3" fill="#0d141c" stroke="${color}" stroke-width="1.5"/>
  </svg>`;
}

/** Dew point: a droplet that fills from the bottom. */
export function droplet(frac, color = '#4f8bff') {
  const f = clamp01(frac);
  const top = 88 - f * 62;
  return `<svg viewBox="0 0 100 100">
    <clipPath id="dropClip"><path d="M 50 12 C 66 34 78 48 78 62 a 28 28 0 0 1 -56 0 C 22 48 34 34 50 12 z"/></clipPath>
    <path d="M 50 12 C 66 34 78 48 78 62 a 28 28 0 0 1 -56 0 C 22 48 34 34 50 12 z"
      fill="none" stroke="#2b3745" stroke-width="3"/>
    <rect data-fill data-tint x="20" y="26" width="60" height="64"
      fill="${color}" opacity=".45" clip-path="url(#dropClip)" style="transform: scaleY(${f.toFixed(3)})"/>
    <path d="M 50 12 C 66 34 78 48 78 62 a 28 28 0 0 1 -56 0 C 22 48 34 34 50 12 z"
      fill="none" stroke="${color}" stroke-width="2"/>
  </svg>`;
}

/** UV: a banded ring coloured by exposure category, with a marker at the current index. */
export function uvRing(uv) {
  const f = clamp01(uv / 12);
  const bands = [[0, 3, '#4fdc8b'], [3, 6, '#ffd257'], [6, 8, '#ff9d4f'], [8, 11, '#ff5f56'], [11, 12, '#c86bff']];
  const segs = bands.map(([a, b, col]) => {
    const len = ((b - a) / 12) * CIRC;
    return `<circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="${col}" stroke-width="5"
      stroke-dasharray="${len.toFixed(1)} ${CIRC.toFixed(1)}"
      stroke-dashoffset="${(-(a / 12) * CIRC).toFixed(1)}" transform="rotate(-90 50 50)" opacity=".85"/>`;
  }).join('');
  return `<svg viewBox="0 0 100 100">${segs}
    <circle data-dot cx="50" cy="${50 - RING_R}" r="4.5" fill="#fff"
      style="transform: rotate(${(f * 360).toFixed(1)}deg)"/>
  </svg>`;
}

/** Lightning: dashed ring when quiet, solid and lit when strikes are landing. */
export function boltRing(frac, active) {
  const f = clamp01(frac);
  const col = active ? '#ffd257' : '#3a4655';
  return `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="#2b3745" stroke-width="5"
      stroke-dasharray="4 7"/>
    <circle data-arc="ring" cx="50" cy="50" r="${RING_R}" fill="none" stroke="#ffd257" stroke-width="5"
      stroke-linecap="round" stroke-dasharray="${(f * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"
      transform="rotate(-90 50 50)" opacity="${active ? 1 : 0}"/>
    <g data-bolt transform="translate(41 66) scale(1.05)" opacity="${active ? 1 : 0.35}">${BOLT(0, 0, 1, col)}</g>
  </svg>`;
}

/** Wet bulb: a thermometer whose column tracks the value. */
export function thermometer(frac, color = '#4fdc8b') {
  const f = clamp01(frac);
  const top = 74 - f * 52;
  // Drawn on the left of the box, not through the middle: the readout is centred over a ring face,
  // and a column up the centre is the one face it cannot be centred over. The class is what the
  // gauge CSS keys the right-aligned readout off.
  return `<svg class="therm" viewBox="0 0 100 100">
    <rect x="17" y="16" width="14" height="60" rx="7" fill="none" stroke="#2b3745" stroke-width="3"/>
    <rect data-fill data-tint x="20" y="22" width="8" height="54" rx="4" fill="${color}"
      style="transform: scaleY(${f.toFixed(3)})"/>
    <circle cx="24" cy="80" r="11" fill="${color}"/>
    <circle cx="24" cy="80" r="11" fill="none" stroke="#2b3745" stroke-width="3"/>
    ${[0, 1, 2, 3].map((i) => `<line x1="34" y1="${24 + i * 15}" x2="42" y2="${24 + i * 15}"
      stroke="#3a4655" stroke-width="2"/>`).join('')}
  </svg>`;
}

/** Rain: a ring with a droplet in the middle when it's actually raining. */
export function rainRing(frac, wet) {
  return ring(frac, wet ? '#4fb8ff' : '#33414f', { width: 5 });
}

// Repaint a face that is already on the page. `frac` is the 0..1 value, `deg` an absolute
// compass bearing, `on` the lit/unlit state a bolt ring has, `color` the tint.
//
// Rotations are kept cumulative: a needle going from 350° to 10° turns 20° forwards rather than
// unwinding 340° the long way round.
function rot(el, deg) {
  const prev = el._deg ?? deg;
  let d = ((deg - prev) % 360 + 540) % 360 - 180;
  el._deg = prev + d;
  el.style.transform = `rotate(${el._deg.toFixed(1)}deg)`;
}

export function update(svg, { frac, deg, on, color } = {}) {
  if (!svg) return;
  const f = clamp01(frac);
  const arc = svg.querySelector('[data-arc]');
  if (arc && frac != null) {
    const span = arc.dataset.arc === 'dial' ? 240 / 360 : 1;
    arc.setAttribute('stroke-dasharray', `${(f * span * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`);
  }
  const dot = svg.querySelector('[data-dot]');
  if (dot && frac != null) rot(dot, f * 360);
  const needle = svg.querySelector('[data-needle]');
  if (needle) {
    if (deg != null) rot(needle, deg + 180);            // compass bearing
    else if (frac != null) rot(needle, -120 + f * 240); // dial sweep
  }
  const len = svg.querySelector('[data-len]');
  if (len && frac != null) len.style.transform = `scale(${((20 + f * 14) / 34).toFixed(3)})`;
  for (const el of svg.querySelectorAll('[data-fill]')) {
    if (frac != null) el.style.transform = `scaleY(${f.toFixed(3)})`;
  }
  const bolt = svg.querySelector('[data-bolt]');
  if (bolt && on != null) {
    bolt.setAttribute('opacity', on ? '1' : '0.35');
    if (arc) arc.setAttribute('opacity', on ? '1' : '0');
  }
  if (color) for (const el of svg.querySelectorAll('[data-tint]')) {
    if (el.getAttribute('fill') && el.getAttribute('fill') !== 'none') el.setAttribute('fill', color);
    if (el.getAttribute('stroke') && el.getAttribute('stroke') !== 'none') el.setAttribute('stroke', color);
  }
}

if (location.search.includes('selftest')) {
  const box = document.createElement('div');
  box.innerHTML = compass(350, 0.5);
  const svg = box.firstElementChild;
  update(svg, { deg: 350 });
  update(svg, { deg: 10 });
  const n = svg.querySelector('[data-needle]');
  console.assert(Math.round(n._deg) === 350 + 180 + 20, `icons: shortest rotation 350→10 is +20 (got ${n._deg})`);
}
