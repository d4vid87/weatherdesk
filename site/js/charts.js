// Minimal canvas chart helper.
// series: [{data:[{x,y}], color, type:'line'|'bar'|'band'}] — a band takes {x,lo,hi} instead
// and shades between them, which is what an ensemble spread is.
// Canvas can't read CSS variables, so the theme has to be handed to it. Read per draw: a chart
// is redrawn whenever anything changes, and a cached palette would be the one thing still dark
// after a switch to the light theme.
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function chart(canvas, series, opts = {}) {
  const MUTED = css('--muted', '#8ea0b5'), LINE = css('--line', '#253141');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 140;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  bindHover(canvas, series, opts);
  const pts = series
    .flatMap((s) => (s.type === 'band' ? s.data.flatMap((p) => [{ x: p.x, y: p.lo }, { x: p.x, y: p.hi }]) : s.data))
    .filter((p) => p.y != null && !Number.isNaN(p.y));
  if (!pts.length) {
    c.fillStyle = MUTED; c.font = '12px system-ui';
    c.fillText('no data', 8, h / 2);
    return;
  }
  const padL = 34, padB = 16, padT = 8, padR = 6;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = opts.yMin ?? Math.min(...ys), y1 = opts.yMax ?? Math.max(...ys);
  if (y1 === y0) y1 = y0 + 1;
  const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
  const px = (x) => padL + ((x - x0) / (x1 - x0 || 1)) * (w - padL - padR);
  const py = (y) => padT + (1 - (y - y0) / (y1 - y0)) * (h - padT - padB);

  // gridlines + y labels
  c.strokeStyle = LINE; c.fillStyle = MUTED; c.font = '10px system-ui'; c.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = y0 + ((y1 - y0) * i) / 3, yy = Math.round(py(y)) + 0.5;
    c.beginPath(); c.moveTo(padL, yy); c.lineTo(w - padR, yy); c.stroke();
    c.fillText(y.toFixed(opts.digits ?? 0), 2, yy + 3);
  }

  for (const s of series) {
    if (s.type === 'band') {
      const data = s.data.filter((p) => p.lo != null && p.hi != null);
      if (!data.length) continue;
      c.fillStyle = s.color;
      c.globalAlpha = s.alpha ?? 0.18;
      c.beginPath();
      data.forEach((p, i) => (i ? c.lineTo(px(p.x), py(p.hi)) : c.moveTo(px(p.x), py(p.hi))));
      for (let i = data.length - 1; i >= 0; i--) c.lineTo(px(data[i].x), py(data[i].lo));
      c.closePath();
      c.fill();
      c.globalAlpha = 1;
      continue;
    }
    const data = s.data.filter((p) => p.y != null && !Number.isNaN(p.y));
    if (!data.length) continue;
    if (s.dash) c.setLineDash(s.dash);
    if (s.type === 'bar') {
      const bw = Math.max(2, (w - padL - padR) / data.length - 2);
      c.fillStyle = s.color;
      for (const p of data) c.fillRect(px(p.x) - bw / 2, py(Math.max(p.y, 0)), bw, py(Math.min(y0, 0)) - py(Math.max(p.y, 0)));
    } else {
      c.strokeStyle = s.color; c.lineWidth = s.width || 1.6;
      c.beginPath();
      data.forEach((p, i) => (i ? c.lineTo(px(p.x), py(p.y)) : c.moveTo(px(p.x), py(p.y))));
      c.stroke();
    }
    c.setLineDash([]);
  }

  // x labels: first + last
  c.fillStyle = MUTED;
  const fmt = opts.xFormat || ((x) => new Date(x).toLocaleDateString([], { month: 'numeric', day: 'numeric' }));
  c.fillText(fmt(x0), padL, h - 4);
  const last = fmt(x1);
  c.fillText(last, w - padR - c.measureText(last).width, h - 4);

  // A chart is a picture to a screen reader unless it says so; the range is the part someone
  // listening actually wants.
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    `${opts.label || 'chart'}: ${Math.min(...ys).toFixed(opts.digits ?? 0)} to ${Math.max(...ys).toFixed(opts.digits ?? 0)}${
      opts.unit ? ` ${opts.unit}` : ''}, ${fmt(x0)} to ${fmt(x1)}`
  );

  if (canvas._wdHover != null) crosshair(c, canvas._wdHover);

  // The readout under the pointer: nearest real sample on each line, not an interpolation —
  // a chart that invents a value between two readings is a chart that lies.
  function crosshair(c, hx) {
    const marks = [];
    for (const s of series) {
      if (s.type === 'band') continue;
      let best = null;
      for (const p of s.data) {
        if (p.y == null || Number.isNaN(p.y)) continue;
        const d = Math.abs(px(p.x) - hx);
        if (!best || d < best.d) best = { d, p };
      }
      if (best && best.d < (w - padL - padR) / 4) marks.push({ p: best.p, color: s.color, name: s.name });
    }
    if (!marks.length) return;
    const gx = px(marks[0].p.x);
    c.strokeStyle = MUTED; c.lineWidth = 1;
    c.beginPath(); c.moveTo(gx + 0.5, padT); c.lineTo(gx + 0.5, h - padB); c.stroke();
    const lines = marks.map((m) => `${m.name ? `${m.name} ` : ''}${(+m.p.y).toFixed(opts.digits ?? 1)}${opts.unit || ''}`);
    const stamp = (opts.hoverFormat || fmt)(marks[0].p.x);
    for (const m of marks) {
      c.fillStyle = m.color;
      c.beginPath(); c.arc(px(m.p.x), py(m.p.y), 3, 0, Math.PI * 2); c.fill();
    }
    c.font = '11px system-ui';
    const text = `${stamp}  ${lines.join('  ')}`;
    const tw = c.measureText(text).width + 8;
    const tx = Math.min(Math.max(gx - tw / 2, padL), w - padR - tw);
    c.fillStyle = css('--bg-2', '#111820');
    c.fillRect(tx, padT, tw, 16);
    c.strokeStyle = LINE; c.strokeRect(tx + 0.5, padT + 0.5, tw, 16);
    c.fillStyle = css('--fg', '#e8eef6');
    c.fillText(text, tx + 4, padT + 12);
  }
}

/// Hover once, redraw forever: the listeners are attached to the canvas the first time it is
// drawn and just re-run the last draw with a pointer position on it. Pointer events rather than
// mouse events so a tablet gets the same readout from a fingertip.
function bindHover(canvas, series, opts) {
  canvas._wdDraw = () => chart(canvas, series, opts);
  if (canvas._wdBound || opts.hover === false) return;
  canvas._wdBound = true;
  const move = (e) => {
    canvas._wdHover = e.clientX - canvas.getBoundingClientRect().left;
    canvas._wdDraw();
  };
  const clear = () => {
    if (canvas._wdHover == null) return;
    canvas._wdHover = null;
    canvas._wdDraw();
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerdown', move);
  canvas.addEventListener('pointerleave', clear);
  canvas.addEventListener('pointercancel', clear);
}

if (typeof window !== 'undefined' && location.search.includes('selftest')) {
  const cv = document.createElement('canvas');
  cv.width = 200; cv.height = 100;
  chart(cv, [{ data: [{ x: 0, y: 1 }, { x: 1, y: 5 }], color: '#f00' }], { label: 'test', unit: '°' });
  console.assert(cv.toDataURL().length > 100, 'chart self-check failed');
  console.assert(/test: 1 to 5 °/.test(cv.getAttribute('aria-label')), 'chart: aria-label describes the range');
  const before = cv.toDataURL();
  // Over the first sample, which is at the left padding — far enough from the second that the
  // readout picks one.
  cv._wdHover = 36;
  chart(cv, [{ data: [{ x: 0, y: 1 }, { x: 1, y: 5 }], color: '#f00' }], { label: 'test' });
  console.assert(cv.toDataURL() !== before, 'chart: hover draws a crosshair');
  cv._wdHover = null;
  chart(cv, [{ type: 'band', data: [{ x: 0, lo: 1, hi: 9 }, { x: 1, lo: 2, hi: 8 }], color: '#0f0' }]);
  console.assert(/1 to 9/.test(cv.getAttribute('aria-label')), 'chart: a band sets the scale from lo and hi');
}
