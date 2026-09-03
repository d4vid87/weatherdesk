// The hero's sky: the colour behind the numbers, and where the sun or moon is in it.
//
// The old version picked one of five gradients from a chain of thresholds, so the sky changed in
// visible steps — night, then suddenly dawn. This interpolates between the same five pairs, so
// the panel drifts through the day the way the real one does. The colour runs at every motion
// level (it is two custom properties, not an animation); the orb and the crossfade layers only
// exist at Full.
import { motionLevel } from './motion.js';

const SYNODIC = 29.530588853;
const NEW_MOON = 947182440000; // 2000-01-06 18:14 UTC

// Day fraction `f`: 0 is sunrise, 1 is sunset, so negative is before dawn and >1 is after dusk.
// The five original colour pairs, placed as stops on that line.
const STOPS = [
  [-0.10, ['#050a14', '#0b1424']],
  [-0.04, ['#1b2a45', '#4a3a5a']],
  [0.06, ['#1b2a45', '#4a3a5a']],
  [0.18, ['#1e4a7a', '#5a86b8']],
  [0.50, ['#1f6fb8', '#7fb6e6']],
  [0.82, ['#1e4a7a', '#5a86b8']],
  [0.94, ['#3b2a45', '#8a4a3a']],
  [1.04, ['#3b2a45', '#8a4a3a']],
  [1.10, ['#050a14', '#0b1424']],
];

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));

/** The two gradient stops at day fraction `f`. Pure — the self-check leans on that. */
export function skyAt(f) {
  if (f <= STOPS[0][0]) return STOPS[0][1];
  if (f >= STOPS[STOPS.length - 1][0]) return STOPS[STOPS.length - 1][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i], [x0, c0] = STOPS[i - 1];
    if (f > x1) continue;
    const t = (f - x0) / (x1 - x0);
    return [mix(c0[0], c1[0], t), mix(c0[1], c1[1], t)];
  }
  return STOPS[STOPS.length - 1][1];
}

/** Where the orb sits, 0..1 of the hero box. A real arc: up in the east, over, down in the west. */
export function orbAt(t) {
  const k = Math.max(0, Math.min(1, t));
  return { x: 0.06 + 0.88 * k, y: 0.92 - 0.78 * Math.sin(Math.PI * k) };
}

export function moon(at = Date.now()) {
  const age = (((at - NEW_MOON) / 86400000) % SYNODIC + SYNODIC) % SYNODIC;
  const illum = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2) * 100);
  const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.floor(((age / SYNODIC) * 8 + 0.5) % 8)];
  // the next new or full moon, whichever comes first — the one date people actually plan around
  const toNew = SYNODIC - age;
  const toFull = (SYNODIC / 2 - age + SYNODIC) % SYNODIC;
  const [nextName, days] = toNew < toFull ? ['New moon', toNew] : ['Full moon', toFull];
  return { age, illum, name, nextName, nextDate: new Date(at + days * 86400000) };
}

// a lit disc drawn with two arcs — the terminator is an ellipse whose width is the illuminated
// fraction, which is exactly how the phase looks from the ground
export function moonGlyph(age, size = 13) {
  const f = age / SYNODIC;
  const r = size / 2 - 1;
  const k = Math.abs(Math.cos(2 * Math.PI * f));
  const waxing = f < 0.5;
  const sweep = waxing ? 1 : 0;
  const inner = f < 0.25 || f > 0.75 ? sweep : 1 - sweep;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:-2px">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#ffffff33"/>
    <path fill="#eef4ff" d="M ${size / 2} ${size / 2 - r}
      A ${r} ${r} 0 0 ${sweep} ${size / 2} ${size / 2 + r}
      A ${(r * k).toFixed(2)} ${r} 0 0 ${inner} ${size / 2} ${size / 2 - r} z"/>
  </svg>`;
}

// The hero box is measured on resize, never mid-render: reading clientWidth inside the paint
// path is a forced layout on every observation.
let box = { w: 0, h: 0 };
function measure() {
  const hero = document.getElementById('hero');
  if (hero) box = { w: hero.clientWidth, h: hero.clientHeight };
}
window.addEventListener('resize', measure);

let layer = 0, placed = false;

/**
 * Paint the sky for `now`, given today's and tomorrow's daily forecast entries (for sunrise,
 * sunset and the next sunrise). Safe to call every minute.
 */
export function setSky(now, d0, d1) {
  const hero = document.getElementById('hero');
  if (!hero || !d0?.sunrise || !d0?.sunset) return;
  const f = (now - d0.sunrise) / (d0.sunset - d0.sunrise);
  const [a, b] = skyAt(f);
  hero.style.setProperty('--sky-a', a);
  hero.style.setProperty('--sky-b', b);

  const full = motionLevel() === 'full';
  const orb = document.getElementById('hero-orb');
  const layers = hero.querySelectorAll('.sky-l');
  if (!full || !orb || !layers.length) return;

  // Crossfade: the incoming gradient is painted on the hidden layer and faded up, so a colour
  // step at a stop boundary reads as light changing rather than a repaint.
  const next = layers[layer % layers.length];
  next.style.background = `linear-gradient(160deg, ${a}, ${b})`;
  next.classList.add('on');
  layers[(layer + 1) % layers.length]?.classList.remove('on');
  layer++;

  if (!box.w) measure();
  const day = now >= d0.sunrise && now <= d0.sunset;
  // By night the arc runs sunset → next sunrise, so the moon rides the same curve the sun did.
  const nextRise = (d1?.sunrise || d0.sunrise + 86400);
  const t = day ? f : now < d0.sunrise
    ? (now - (d0.sunset - 86400)) / (d0.sunrise - (d0.sunset - 86400))
    : (now - d0.sunset) / (nextRise - d0.sunset);
  const { x, y } = orbAt(t);
  orb.classList.toggle('night', !day);
  if (!day) {
    const m = moon();
    if (orb.dataset.phase !== String(Math.round(m.age))) {
      orb.dataset.phase = String(Math.round(m.age));
      orb.innerHTML = moonGlyph(m.age, 56);
    }
  } else if (orb.dataset.phase) {
    orb.dataset.phase = '';
    orb.innerHTML = '';
  }
  orb.style.transform = `translate(${(x * box.w).toFixed(1)}px, ${(y * box.h).toFixed(1)}px)`;
  // The 60-second glide is attached only after the first placement, or the orb would slide in
  // from the top-left corner on load.
  if (!placed) {
    placed = true;
    requestAnimationFrame(() => orb.classList.add('glide'));
  }
}

// Parallax: the sky drifts a little slower than the page it sits behind. Transform only, so it
// stays on the compositor.
if ('requestAnimationFrame' in window) {
  let pending = false;
  document.addEventListener('scroll', () => {
    if (pending || document.documentElement.dataset.motion !== 'full') return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const sky = document.getElementById('hero-sky');
      if (!sky) return;
      const top = sky.parentElement.getBoundingClientRect().top;
      sky.style.transform = `translateY(${(-top * 0.15).toFixed(1)}px)`;
    });
  }, { passive: true, capture: true });
}

if (location.search.includes('selftest')) {
  console.assert(skyAt(0.5)[0] === '#1f6fb8', 'sky: midday is the day pair');
  console.assert(skyAt(-1)[0] === '#050a14', 'sky: before dawn is night');
  const dawn = skyAt(0.12)[0];
  console.assert(dawn !== skyAt(0.06)[0] && dawn !== skyAt(0.18)[0], 'sky: between stops is a blend');
  console.assert(orbAt(0.5).y < orbAt(0).y, 'sky: the orb is highest at midday');
  console.assert(orbAt(0).x < orbAt(1).x, 'sky: the orb travels east to west');
  console.assert(moon(NEW_MOON).illum === 0, 'sky: the new moon is dark');
}
