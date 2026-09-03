// Motion: the one place that decides how much the dashboard is allowed to move, and the handful
// of primitives every panel animates through.
//
// Three levels, because the machines this runs on are three machines. `full` is a desktop with a
// GPU: a live sky, animated icons, particles, entrance choreography. `lite` is the wall tablet
// and the Chromebook — compositor-only transform/opacity work, no canvas, no SMIL. `off` is what
// eco mode used to be: nothing moves, ever.
//
// ponytail: Web Animations API rather than a class per effect. `animation: none` in the `off`
// stylesheet cannot accidentally kill an entrance, there is no reflow needed to retrigger one,
// and the level gate is a plain `if` instead of a selector.
import { settings, ecoOn, num } from './app.js';

const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)');

export function motionLevel() {
  const q = new URLSearchParams(location.search).get('motion');
  if (q === 'full' || q === 'lite' || q === 'off') return q;
  // Someone who asked the OS for less motion, or picked the e-ink palette (a screen that redraws
  // in half a second), gets none of this whatever the setting says.
  if (REDUCED?.matches || settings().palette === 'eink') return 'off';
  const m = settings().motion || 'auto';
  if (m !== 'auto') return m;
  return ecoOn() ? 'lite' : 'full';
}

export function applyMotion() {
  document.documentElement.dataset.motion = motionLevel();
}

window.addEventListener('wd:settings', applyMotion);
REDUCED?.addEventListener?.('change', applyMotion);

// --- value tweens ---
//
// WAAPI cannot animate textContent, so this is a shared rAF loop: one frame for every number on
// the page rather than a timer each. `tabular-nums` on the display font is what stops the width
// jitter a counting number would otherwise have.
const running = new Map();
let raf = 0;
const ease = (t) => 1 - (1 - t) ** 3;

function frame(now) {
  raf = 0;
  for (const [el, a] of running) {
    // Clamped both ways: the rAF timestamp and performance.now() are the same clock in a normal
    // page, but not under headless virtual time — a negative t ran the easing curve backwards and
    // the number drifted off to nonsense instead of landing.
    const t = Math.max(0, Math.min(1, (now - a.t0) / a.dur));
    el.textContent = a.fmt(a.from + (a.to - a.from) * ease(t));
    if (t >= 1) running.delete(el);
  }
  if (running.size) raf = requestAnimationFrame(frame);
}

export function tweenNumber(el, to, fmt = (v) => num(v), dur = 600) {
  if (!el) return;
  const level = motionLevel();
  const from = el._v;
  el._v = to;
  // First paint, a hidden tab, no motion, or a jump from nothing: write it and be done.
  if (level === 'off' || document.hidden || from == null || to == null || !Number.isFinite(to) || !Number.isFinite(from)) {
    running.delete(el);
    el.textContent = fmt(to);
    return;
  }
  if (from === to) return;
  running.set(el, { from, to, t0: null, dur, fmt });
  if (level === 'full') flash(el);
  if (!raf) raf = requestAnimationFrame(frame);
}

// The broadcast-graphics tell that a number is live: it blinks as it updates.
export function flash(el) {
  if (!el || motionLevel() !== 'full' || document.hidden) return;
  try { el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' }); }
  catch { /* no WAAPI: the value still changed */ }
}

// --- FLIP ---
//
// Measure, mutate, invert, play. Used for every reorder: a panel that jumps to a new slot reads
// as a glitch, the same panel sliding there reads as a decision.
export function flip(container, mutate) {
  const level = motionLevel();
  const kids = [...container.children].filter((c) => c.dataset?.panel && !c.classList.contains('dragging') && !c.classList.contains('ph'));
  if (level === 'off' || document.hidden) { mutate(); return; }
  const before = new Map(kids.map((k) => [k, k.getBoundingClientRect()]));
  mutate();
  // Painted pixels out of getBoundingClientRect, layout pixels into the transform — see the
  // zoom note in layout.js.
  const k = +getComputedStyle(document.documentElement).zoom || 1;
  for (const el of kids) {
    const a = before.get(el), b = el.getBoundingClientRect();
    const dx = (a.left - b.left) / k, dy = (a.top - b.top) / k;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    try {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    } catch { /* nothing moves; nothing breaks */ }
  }
}

// --- entrances ---
//
// Lite lifts things into place. Full swooshes them in from the left with a light sweep across
// them, which is the entrance every TV weather graphic has used since 1994.
export function enter(nodes, { stagger = 50 } = {}) {
  const level = motionLevel();
  if (level === 'off' || document.hidden) return;
  const list = [...nodes].filter(Boolean);
  list.forEach((el, i) => {
    const delay = Math.min(i, 12) * stagger;
    try {
      if (level === 'lite') {
        el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
          { duration: 300, delay, easing: 'ease-out', fill: 'backwards' });
      } else {
        el.animate([{ opacity: 0, transform: 'translateX(-32px) scale(.98)' }, { opacity: 1, transform: 'none' }],
          { duration: 420, delay, easing: 'cubic-bezier(.2,.9,.3,1.1)', fill: 'backwards' });
        el.classList.add('streak');
        el.addEventListener('animationend', () => el.classList.remove('streak'), { once: true });
        setTimeout(() => el.classList.remove('streak'), delay + 1200);
      }
    } catch { /* no WAAPI */ }
  });
}

// Arriving on a tab: its panels come in behind the page wipe app.js plays.
window.addEventListener('wd:section', (e) => {
  const sec = document.getElementById(e.detail);
  if (sec) enter(sec.querySelectorAll(':scope > [data-panel], :scope > * > [data-panel]'));
});

export function leave(el) {
  if (motionLevel() === 'off' || document.hidden || !el.animate) return Promise.resolve();
  try { return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished.catch(() => {}); }
  catch { return Promise.resolve(); }
}

if (location.search.includes('selftest')) {
  console.assert(['full', 'lite', 'off'].includes(motionLevel()), 'motion: level is one of the three');
  const box = document.createElement('div');
  const span = document.createElement('span');
  span._v = 1;
  tweenNumber(span, 5, (v) => String(Math.round(v)));
  if (motionLevel() === 'off') console.assert(span.textContent === '5', 'motion: off writes the value straight through');
  flip(box, () => {});
  console.assert(box.getAnimations?.().length === 0 ?? true, 'motion: flip over nothing animates nothing');
}
