// Move and resize anything on the Desk.
//
// Reorder is HTML5 drag-and-drop between siblings; resize is three pointer-driven handles (right
// edge, bottom edge, corner). Both write to one localStorage blob keyed by panel id, so a tablet
// keeps its arrangement across reloads. No drag library: the whole interaction is four events and
// a rect comparison.
//
// The browser's own `resize: both` was the first cut and was wrong twice over: its grab target is
// a ~16px corner that is invisible on a dark panel, and it does not respond to touch at all, which
// is the input this dashboard is actually built for. Pointer events cover mouse, pen and finger
// with one code path.
//
// The Desk is one flat 12-column grid, so any panel can be dragged to any slot — the radar was
// previously boxed inside a two-column row and could not be lifted above it. A horizontal resize
// edits the panel's column span; a vertical one sets an explicit height.
//
// While a drag is in flight the panel is taken out of flow (position: fixed, following the
// pointer) and a placeholder holds the slot. Moving the panel itself through the grid on every
// pointermove was what made dragging feel glitchy: each insert reflowed the grid, which moved the
// panel under the pointer, which picked a different target, and the two fought each other.

const KEY = 'wd.layout';
const $ = (id) => document.getElementById(id);

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
let state = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(state));

const entry = (id) => (state[id] ||= {});

// Containers whose direct children are rearrangeable, in the order they appear on the Desk.
const CONTAINERS = ['desk-stack', 'daycards', 'gauges', 'desk-grid'];

let dragged = null;

// Grid children are sized in columns, not pixels: a `width` on a grid item is ignored by the
// track it sits in, so a resize has to be translated into a span.
const COLS = 12;

const isGridChild = (el) => getComputedStyle(el.parentElement).display === 'grid';

function colsFor(el, px) {
  const p = el.parentElement;
  const gap = parseFloat(getComputedStyle(p).columnGap) || 0;
  const track = (p.clientWidth - gap * (COLS - 1)) / COLS;
  return Math.max(2, Math.min(COLS, Math.round((px + gap) / (track + gap))));
}

function setWidth(el, px) {
  if (px == null) {
    el.style.width = '';
    el.style.gridColumn = '';
  } else if (isGridChild(el)) {
    el.style.gridColumn = `span ${colsFor(el, px)}`;
  } else {
    el.style.width = `${px}px`;
  }
}

const widthOf = (el) => (el.style.width || el.style.gridColumn
  ? Math.round(el.getBoundingClientRect().width) : null);

function applySaved(el) {
  const s = state[el.dataset.panel];
  if (!s) return;
  if (s.w) setWidth(el, s.w);
  if (s.h) el.style.height = `${s.h}px`;
  if (s.hidden) el.classList.add('panel-hidden');
}

// Children come back in the saved order; anything new (a panel added by an update) lands last.
//
// This only ever touches panels, and it reorders by appending — so a container holding anything
// that is not a panel would have every panel shoved past it on each render. Every direct child of
// a layout container is a panel for exactly that reason; the guard below keeps a stray one from
// silently rearranging the page.
function applyOrder(container) {
  if (dragged) return; // a background refresh must not yank panels out from under a live drag
  const kids = [...container.children].filter((c) => c.dataset.panel);
  if (kids.length !== container.children.length) {
    console.warn('layout: non-panel child in', container.id, '— leaving order alone');
    return;
  }
  kids
    .slice()
    .sort((a, b) => {
      const oa = state[a.dataset.panel]?.order, ob = state[b.dataset.panel]?.order;
      return (oa ?? kids.indexOf(a) + 1000) - (ob ?? kids.indexOf(b) + 1000);
    })
    .forEach((k) => container.appendChild(k));
}

function recordOrder(container) {
  [...container.children].filter((c) => c.dataset.panel)
    .forEach((c, i) => { entry(c.dataset.panel).order = i; });
  save();
}

// Where the dragged panel should land. The first cut guessed the container's flow by comparing
// two siblings' tops, which silently broke the two-panel radar row: excluding the dragged panel
// leaves a single candidate, the guess falls back to "vertical", and dragging sideways then never
// crosses a boundary. Nearest-centre needs no orientation at all, and it handles a wrapping grid
// of gauges as readily as a single row.
function insertPoint(container, x, y) {
  const kids = [...container.children].filter((c) => c.dataset.panel && c !== dragged);

  if (!kids.length) return null;

  let best = null, bestDist = Infinity, bestDx = 0, bestDy = 0;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = k; bestDx = dx; bestDy = dy; }
  }
  // Past the centre on whichever axis the pointer is furthest along means "drop after this one".
  const after = Math.abs(bestDx) > Math.abs(bestDy) ? bestDx > 0 : bestDy > 0;
  return after ? best.nextElementSibling : best;
}

// One handle per edge the panel can grow along. `e` widens, `s` heightens, `se` does both.
// Pointer capture means the drag survives the pointer leaving the handle — without it, a fast
// drag detaches after a few pixels, which is most of what made the old corner feel broken.
function resizeHandle(el, dir) {
  const h = document.createElement('div');
  h.className = `rz rz-${dir}`;
  h.title = 'Drag to resize · double-click to reset';

  let startX = 0, startY = 0, startW = 0, startH = 0;

  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    [startX, startY, startW, startH] = [e.clientX, e.clientY, r.width, r.height];
    h.setPointerCapture(e.pointerId);
    el.classList.add('resizing');
    // Pointer capture doesn't cross into an iframe's document, so a drag over the radar would
    // otherwise die the moment the pointer entered it.
    document.body.classList.add('resizing');
  });

  h.addEventListener('pointermove', (e) => {
    if (!h.hasPointerCapture(e.pointerId)) return;
    if (dir !== 's') setWidth(el, Math.max(160, startW + e.clientX - startX));
    if (dir !== 'e') el.style.height = `${Math.max(60, startH + e.clientY - startY)}px`;
  });

  const end = (e) => {
    if (!h.hasPointerCapture(e.pointerId)) return;
    h.releasePointerCapture(e.pointerId);
    el.classList.remove('resizing');
    document.body.classList.remove('resizing');
    const s = entry(el.dataset.panel);
    // Only remember a dimension the user actually dragged — anything still at its natural size
    // must stay fluid, or the first window resize leaves it stranded at a stale pixel width.
    const w = widthOf(el);
    if (w) s.w = w;
    if (el.style.height) s.h = Math.round(el.getBoundingClientRect().height);
    save();
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);

  h.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    setWidth(el, null); el.style.height = '';
    const s = entry(el.dataset.panel);
    delete s.w; delete s.h;
    save();
  });

  return h;
}

function wire(container) {
  [...container.children].filter((c) => c.dataset.panel).forEach((el) => {
    applySaved(el);
    if (el.querySelector(':scope > .grip')) return;

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move · edges to resize · double-click to reset this panel';
    grip.innerHTML = '<span>⠿</span>';

    // Pointer events rather than HTML5 drag-and-drop: DnD never fires for touch, and this
    // dashboard's home is a tablet. Only the grip starts a move — dragging from the panel body
    // would fight text selection and the radar iframe.
    let ph = null, offX = 0, offY = 0;

    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;

      // The placeholder inherits the panel's footprint so the grid doesn't collapse the moment
      // the panel leaves the flow.
      ph = document.createElement('div');
      ph.className = 'ph';
      ph.style.height = `${r.height}px`;
      ph.style.gridColumn = getComputedStyle(el).gridColumn;
      container.insertBefore(ph, el);

      Object.assign(el.style, {
        width: `${r.width}px`, height: `${r.height}px`,
        left: `${r.left}px`, top: `${r.top}px`,
      });
      el.classList.add('dragging');
      document.body.classList.add('resizing'); // same iframe/selection guard as a resize
      dragged = el;
      grip.setPointerCapture(e.pointerId);
    });

    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId) || dragged !== el) return;
      el.style.left = `${e.clientX - offX}px`;
      el.style.top = `${e.clientY - offY}px`;
      const before = insertPoint(container, e.clientX, e.clientY);
      if (before !== ph) container.insertBefore(ph, before);
    });

    const drop = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      grip.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      container.insertBefore(el, ph);
      ph.remove();
      ph = null;
      // Restore whatever the panel's own rules say; a saved size is reapplied on top.
      el.style.left = el.style.top = el.style.width = el.style.height = '';
      applySaved(el);
      dragged = null;
      recordOrder(container);
    };
    grip.addEventListener('pointerup', drop);
    grip.addEventListener('pointercancel', drop);

    grip.addEventListener('dblclick', () => {
      setWidth(el, null); el.style.height = '';
      const s = entry(el.dataset.panel);
      delete s.w; delete s.h;
      save();
    });
    el.appendChild(grip);
    ['e', 's', 'se'].forEach((dir) => el.appendChild(resizeHandle(el, dir)));
  });
}

export const snapshot = () => structuredClone(state);

// Swap the whole arrangement at once. Inline styles have to be stripped first: a panel the new
// state says nothing about would otherwise keep the old one's pixel height.
export function restore(next) {
  state = structuredClone(next) || {};
  save();
  document.querySelectorAll('[data-panel]').forEach((el) => {
    setWidth(el, null); el.style.height = '';
    el.classList.remove('panel-hidden');
  });
  CONTAINERS.map($).filter(Boolean).forEach((c) => {
    applyOrder(c);
    [...c.children].filter((k) => k.dataset.panel).forEach(applySaved);
  });
}

export function resetLayout() {
  restore({});
  localStorage.removeItem(KEY);
}

export function initLayout() {
  CONTAINERS.map($).filter(Boolean).forEach((c) => { applyOrder(c); wire(c); });
  const btn = $('btn-layout-reset');
  if (btn) btn.onclick = resetLayout;
}

// ponytail-lite self-check: `?selftest` in the URL asserts the ordering maths instead of shipping
// a test runner for a file this size.
if (location.search.includes('selftest')) {
  const before = JSON.stringify(state);
  state = { a: { order: 2 }, b: { order: 0 }, c: { order: 1 } };
  const box = document.createElement('div');
  ['a', 'b', 'c'].forEach((n) => {
    const d = document.createElement('div');
    d.dataset.panel = n;
    box.appendChild(d);
  });
  applyOrder(box);
  console.assert([...box.children].map((c) => c.dataset.panel).join('') === 'bca', 'layout order');

  // A two-panel row: dragging the left panel past the right one's centre must place it after.
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;width:400px;position:fixed;top:0;left:0';
  ['l', 'r'].forEach((n) => {
    const d = document.createElement('div');
    d.dataset.panel = n;
    d.style.cssText = 'flex:1 1 0;height:80px';
    row.appendChild(d);
  });
  document.body.appendChild(row);
  dragged = row.firstElementChild;
  console.assert(insertPoint(row, 380, 40) === null, 'drop after the right-hand panel');
  console.assert(insertPoint(row, 220, 40) === row.lastElementChild, 'drop before it');
  dragged = null;
  row.remove();
  state = JSON.parse(before);
}
