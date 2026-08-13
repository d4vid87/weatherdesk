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
// ponytail: panels reorder within their own container, not across containers. Dragging a gauge
// into the day-card row would need a shared grid and a placeholder; upgrade path if it's ever
// wanted is one flat container with explicit grid spans.

const KEY = 'wd.layout';
const $ = (id) => document.getElementById(id);

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
let state = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(state));

const entry = (id) => (state[id] ||= {});

// Containers whose direct children are rearrangeable, in the order they appear on the Desk.
const CONTAINERS = ['desk-stack', 'mid', 'mid-right', 'daycards', 'gauges', 'desk-grid'];

let dragged = null;

// A flex item's width is decided by its basis, not by `width`, so setting one on a child of the
// radar row did nothing at all. Write whichever property the parent actually honours.
const inFlexRow = (el) => {
  const p = getComputedStyle(el.parentElement);
  return p.display === 'flex' && !p.flexDirection.startsWith('column');
};

function setWidth(el, px) {
  if (px == null) {
    el.style.width = '';
    el.style.flex = '';
  } else if (inFlexRow(el)) {
    el.style.flex = `0 0 ${px}px`;
  } else {
    el.style.width = `${px}px`;
  }
}

const widthOf = (el) => (el.style.width || el.style.flex ? Math.round(el.getBoundingClientRect().width) : null);

function applySaved(el) {
  const s = state[el.dataset.panel];
  if (!s) return;
  if (s.w) setWidth(el, s.w);
  if (s.h) el.style.height = `${s.h}px`;
  if (s.hidden) el.classList.add('panel-hidden');
}

// Children come back in the saved order; anything new (a panel added by an update) lands last.
function applyOrder(container) {
  const kids = [...container.children].filter((c) => c.dataset.panel);
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

// Insert before the first sibling whose midpoint is past the pointer. Works for both a row and a
// column because it compares on whichever axis the container actually flows.
function insertPoint(container, x, y) {
  const kids = [...container.children].filter((c) => c.dataset.panel && c !== dragged);
  const horizontal = kids.length > 1
    && Math.abs(kids[1].getBoundingClientRect().top - kids[0].getBoundingClientRect().top) < 20;
  return kids.find((k) => {
    const r = k.getBoundingClientRect();
    return horizontal ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
  }) || null;
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
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragged = el;
      el.classList.add('dragging');
      document.body.classList.add('resizing'); // same iframe/selection guard as a resize
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId) || dragged !== el) return;
      const before = insertPoint(container, e.clientX, e.clientY);
      if (before !== el) container.insertBefore(el, before);
    });
    const drop = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      grip.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
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

export function resetLayout() {
  state = {};
  localStorage.removeItem(KEY);
  document.querySelectorAll('[data-panel]').forEach((el) => {
    setWidth(el, null); el.style.height = '';
    el.classList.remove('panel-hidden');
  });
  CONTAINERS.map($).filter(Boolean).forEach(applyOrder);
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
  state = JSON.parse(before);
}
