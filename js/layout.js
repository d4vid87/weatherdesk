// Move and resize anything on the Desk.
//
// Reorder is HTML5 drag-and-drop between siblings; resize is the browser's own `resize: both`
// handle, watched by a ResizeObserver. Both write to one localStorage blob keyed by panel id, so a
// tablet keeps its arrangement across reloads. No drag library: the whole interaction is four
// events and a rect comparison.
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

function applySaved(el) {
  const s = state[el.dataset.panel];
  if (!s) return;
  if (s.w) el.style.width = `${s.w}px`;
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

function wire(container) {
  [...container.children].filter((c) => c.dataset.panel).forEach((el) => {
    applySaved(el);
    if (el.querySelector(':scope > .grip')) return;

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move · corner to resize · double-click to reset this panel';
    grip.innerHTML = '<span>⠿</span>';
    // Only the grip starts a drag: an iframe or a chart would otherwise swallow the gesture, and
    // text selection inside a panel would keep tripping it.
    grip.draggable = true;
    grip.addEventListener('dragstart', (e) => {
      dragged = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.panel);
      e.dataTransfer.setDragImage(el, 30, 20);
    });
    grip.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragged = null;
      recordOrder(container);
    });
    grip.addEventListener('dblclick', () => {
      el.style.width = ''; el.style.height = '';
      const s = entry(el.dataset.panel);
      delete s.w; delete s.h;
      save();
    });
    el.appendChild(grip);

    new ResizeObserver(() => {
      // Only remember a size the user actually dragged to — an element still at its natural size
      // must stay fluid, or the first window resize leaves it stranded.
      if (!el.style.width && !el.style.height) return;
      const s = entry(el.dataset.panel);
      if (el.style.width) s.w = Math.round(el.getBoundingClientRect().width);
      if (el.style.height) s.h = Math.round(el.getBoundingClientRect().height);
      save();
    }).observe(el);
  });

  container.addEventListener('dragover', (e) => {
    if (!dragged || !container.contains(dragged)) return;
    e.preventDefault();
    const before = insertPoint(container, e.clientX, e.clientY);
    if (before !== dragged) container.insertBefore(dragged, before);
  });
  container.addEventListener('drop', (e) => e.preventDefault());
}

export function resetLayout() {
  state = {};
  localStorage.removeItem(KEY);
  document.querySelectorAll('[data-panel]').forEach((el) => {
    el.style.width = ''; el.style.height = '';
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
