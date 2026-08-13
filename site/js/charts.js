// Minimal canvas chart helper. series: [{data:[{x,y}], color, type:'line'|'bar'}]
export function chart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 140;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  const pts = series.flatMap((s) => s.data).filter((p) => p.y != null && !Number.isNaN(p.y));
  if (!pts.length) {
    c.fillStyle = '#8ea0b5'; c.font = '12px system-ui';
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
  c.strokeStyle = '#253141'; c.fillStyle = '#8ea0b5'; c.font = '10px system-ui'; c.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = y0 + ((y1 - y0) * i) / 3, yy = Math.round(py(y)) + 0.5;
    c.beginPath(); c.moveTo(padL, yy); c.lineTo(w - padR, yy); c.stroke();
    c.fillText(y.toFixed(opts.digits ?? 0), 2, yy + 3);
  }

  for (const s of series) {
    const data = s.data.filter((p) => p.y != null && !Number.isNaN(p.y));
    if (!data.length) continue;
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
  }

  // x labels: first + last
  c.fillStyle = '#8ea0b5';
  const fmt = opts.xFormat || ((x) => new Date(x).toLocaleDateString([], { month: 'numeric', day: 'numeric' }));
  c.fillText(fmt(x0), padL, h - 4);
  const last = fmt(x1);
  c.fillText(last, w - padR - c.measureText(last).width, h - 4);
}

if (typeof window !== 'undefined' && location.search.includes('selftest')) {
  const cv = document.createElement('canvas');
  cv.width = 200; cv.height = 100;
  chart(cv, [{ data: [{ x: 0, y: 1 }, { x: 1, y: 5 }], color: '#f00' }]);
  console.assert(cv.toDataURL().length > 100, 'chart self-check failed');
}
