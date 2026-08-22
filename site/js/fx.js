// Weather in the hero: rain, snow, drifting cloud and lightning drawn on one canvas behind the
// numbers. Pure decoration — every path here is allowed to do nothing.
import { ecoOn } from './app.js';

let ctx = null, parts = [], regime = '', raf = 0, flash = 0;

// Which particle regime an icon key means. Anything unlisted (clear, fog, wind) draws nothing.
function regimeFor(key = '') {
  if (key.includes('thunder')) return 'storm';
  if (key.includes('snow') || key.includes('sleet')) return 'snow';
  if (key.includes('rain')) return 'rain';
  if (key.includes('cloudy')) return 'cloud';
  return '';
}

const N = { rain: 60, storm: 60, snow: 45, cloud: 6 };

function seed(w, h) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  parts = Array.from({ length: N[regime] || 0 }, () => (regime === 'cloud'
    ? { x: rnd(-0.2, 1) * w, y: rnd(0.02, 0.45) * h, r: rnd(30, 70), vx: rnd(4, 12) }
    : { x: Math.random() * w, y: Math.random() * h, len: rnd(8, 18), vy: rnd(regime === 'snow' ? 25 : 320, regime === 'snow' ? 60 : 620), vx: rnd(-15, regime === 'snow' ? 25 : 60) }));
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  const c = ctx.canvas, w = c.width, h = c.height;
  const dt = Math.min(0.05, (t - (frame.last || t)) / 1000);
  frame.last = t;
  ctx.clearRect(0, 0, w, h);
  if (regime === 'cloud') {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (const p of parts) {
      p.x += p.vx * dt;
      if (p.x - p.r > w) p.x = -p.r;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fill();
    }
    return;
  }
  if (regime === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const p of parts) {
      p.y += p.vy * dt; p.x += Math.sin(p.y / 40) * p.vx * dt;
      if (p.y > h) { p.y = -4; p.x = Math.random() * w; }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, 7);
      ctx.fill();
    }
    return;
  }
  ctx.strokeStyle = 'rgba(190,220,255,0.45)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const p of parts) {
    p.y += p.vy * dt; p.x += p.vx * dt;
    if (p.y > h) { p.y = -p.len; p.x = Math.random() * w; }
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx * 0.03, p.y + p.len);
  }
  ctx.stroke();
  if (regime === 'storm') {
    // one flash every few seconds, two frames of white — cheaper and more convincing than a bolt
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.35 * flash})`; ctx.fillRect(0, 0, w, h); flash -= dt * 4; }
    else if (Math.random() < dt / 6) flash = 1;
  }
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (ctx) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function sizeTo(hero) {
  const c = ctx.canvas;
  c.width = hero.clientWidth;
  c.height = hero.clientHeight;
  seed(c.width, c.height);
}

// Called from the hero render with the current conditions icon key.
export function setScene(iconKey) {
  // Eco is a promise about the machine, not a preference about looks: the wall tablet gets none
  // of this. ponytail: no per-effect setting until someone asks for one.
  if (ecoOn()) return stop();
  const hero = document.getElementById('hero');
  if (!hero) return;
  if (!ctx) {
    const c = document.createElement('canvas');
    c.id = 'hero-fx';
    hero.prepend(c);
    ctx = c.getContext('2d');
    addEventListener('resize', () => ctx && sizeTo(hero));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (regime) { frame.last = 0; raf = raf || requestAnimationFrame(frame); }
    });
  }
  const r = regimeFor(iconKey);
  if (r === regime && raf) return;
  regime = r;
  if (!regime) return stop();
  sizeTo(hero);
  if (!raf && !document.hidden) { frame.last = 0; raf = requestAnimationFrame(frame); }
}

if (location.search.includes('selftest')) {
  console.assert(regimeFor('possibly-thunderstorm-day') === 'storm', 'fx: thunder is a storm');
  console.assert(regimeFor('rainy') === 'rain' && regimeFor('snow') === 'snow', 'fx: rain and snow');
  console.assert(regimeFor('clear-day') === '', 'fx: clear skies draw nothing');
}
