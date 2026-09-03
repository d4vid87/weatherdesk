import { flip, enter, leave } from './motion.js';
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

// The font-size setting is `html { zoom }` (see app.js applySize), and zoom is the one thing that
// splits the two coordinate systems apart: `getBoundingClientRect()` and pointer coordinates come
// back in painted pixels, while `style.height`, `offsetHeight` and every length in the stylesheet
// are in layout pixels. Measuring a panel with a rect and writing that number back as a style
// therefore multiplied it by the zoom — on every drag, and again on every reload, until a panel
// was taller than the window it lived in and whatever sat at its bottom (the radar's play
// controls) could not be reached at all. Sizes are read with `offsetWidth`/`offsetHeight` from
// here on, and pointer deltas are divided back into layout pixels.
const zoom = () => +getComputedStyle(document.documentElement).zoom || 1;

// The designed first-run arrangement, tuned for a desktop window (~1400x900): now (hero), the
// detail behind now (gauges), the next few days (daycards), then the map. The desk grid keeps
// the core four visible; everything speculative starts hidden, one grip-click away. `severe`,
// `winter` and `tropical` are absent on purpose: their cards are display:none until their
// weather exists, and a hidden flag here would keep them hidden when it does. `alerts` stays
// visible, so nothing safety-relevant is off-screen.
// DEFAULT is data, not code: to redesign it, drag the dashboard into shape and copy
// `snapshot()` out of the console.
// Their cards are display:none until the weather that fills them exists — a hidden flag would
// keep them hidden when it does, which is the one thing safety panels must not do.
export const NEVER_HIDE = ['severe', 'winter', 'tropical', 'alerts'];

export const DEFAULT = {
  hero: { order: 0 },
  gauges: { order: 1 },
  daycards: { order: 2 },
  radar: { order: 3 },
  'desk-grid': { order: 4 },
  ticker: { order: 5 },
  ha: { order: 6 },
  tenday: { order: 0 },
  alerts: { order: 1 },
  sky: { order: 2 },
  nearby: { order: 3 },
  story: { hidden: true },
  agree: { hidden: true },
  changes: { hidden: true },
  verify: { hidden: true },
  solar: { hidden: true },
  fire: { hidden: true },
  health: { hidden: true },
  aqi: { hidden: true },
  lastyear: { hidden: true },
};

// A missing key seeds DEFAULT; a corrupt blob heals through dropImpossibleHeights instead of
// silently discarding a working arrangement.
const load = () => {
  if (localStorage.getItem(KEY) == null) return structuredClone(DEFAULT);
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
};

// A height taller than the window can only have come from the bug above — a drag that grew a
// panel past the bottom of the screen would have had to leave the window to do it. Dropping those
// lets a dashboard that already has one heal itself instead of needing a per-panel reset, and it
// runs on whatever arrives from the server too, not just on what this browser saved.
function dropImpossibleHeights(st) {
  for (const s of Object.values(st || {})) {
    if (s && s.h > window.innerHeight) delete s.h;
  }
  return st;
}

let state = dropImpossibleHeights(load());
const save = () => {
  localStorage.setItem(KEY, JSON.stringify(state));
  // boot.js debounces this into a config-server push; a drag fires save() per frame batch.
  window.dispatchEvent(new CustomEvent('wd:layout'));
};

const entry = (id) => (state[id] ||= {});

// Containers whose direct children are rearrangeable, in the order they appear on the Desk.
// The Data and Signals grids were placement targets only — a panel could be sent to them but
// their own cards were fixed in markup order, which is the wrong way round for the two tabs that
// hold the most cards.
const CONTAINERS = ['desk-stack', 'daycards', 'gauges', 'desk-grid', 'data-grid', 'signals-grid'];

// Tabs a panel can be sent to, and the container it lands in. The Desk entry is where a panel
// goes home to.
export const TABS = { desk: 'desk-grid', data: 'data-grid', signals: 'signals-grid' };

// Every panel's home, captured before anything is moved — otherwise sending a panel to the Data
// tab and back would leave it in whichever grid it happened to be in at reload.
const home = new Map();

export function panelIds() {
  return [...document.querySelectorAll('[data-panel]')].map((el) => el.dataset.panel);
}

export const tabOf = (id) => state[id]?.tab || 'desk';

// Put each panel where the settings say. Called on load and whenever the catalog changes; moving
// a live node keeps its listeners and its rendered contents, so nothing has to re-render.
export function applyPlacement() {
  for (const el of document.querySelectorAll('[data-panel]')) {
    const id = el.dataset.panel;
    if (!home.has(id)) home.set(id, el.parentElement);
    const want = state[id]?.tab;
    const target = want && want !== 'desk'
      ? $(TABS[want])
      : ($(state[id]?.box) || home.get(id));
    if (target && el.parentElement !== target) target.appendChild(el);
  }
}

export function setTab(id, tab) {
  // A tab move overrides a container move: the panel is going to that tab's grid, and coming back
  // sends it to its markup home rather than to whichever Desk container it was last dropped in.
  delete entry(id).box;
  if (tab === 'desk') delete entry(id).tab;
  else entry(id).tab = tab;
  save();
  applyPlacement();
}

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

const widthOf = (el) => (el.style.width || el.style.gridColumn ? el.offsetWidth : null);

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
  // A container that is itself a panel carries its own grip and resize handles as children —
  // they are furniture, not panels, and counting them made every reorder after wire() bail out
  // with a warning (so a restored layout silently kept the markup order).
  const others = [...container.children].filter((c) => !c.dataset.panel && !c.classList.contains('grip') && !c.classList.contains('rz'));
  if (others.length) {
    console.warn('layout: non-panel child in', container.id, '— leaving order alone');
    return;
  }
  const sorted = kids
    .slice()
    .sort((a, b) => {
      const oa = state[a.dataset.panel]?.order, ob = state[b.dataset.panel]?.order;
      return (oa ?? kids.indexOf(a) + 1000) - (ob ?? kids.indexOf(b) + 1000);
    });
  // Already in this order: appending every panel to reassert it costs a full relayout of the
  // container, and this runs on every render.
  if (sorted.every((k, i) => k === kids[i])) return;
  flip(container, () => sorted.forEach((k) => container.appendChild(k)));
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

// Which container a drop lands in. Panels used to be trapped in the container they were wired in
// — a card in the Desk grid could reorder among its neighbours but could never be lifted above the
// gauges or up next to the hero, because both the closure and `insertPoint` only ever saw one
// container's children. Every wired container is a candidate on every pointermove instead.
//
// Deepest-first: the containers nest (the gauges block is itself a panel sitting in the stack), so
// a pointer inside the gauges is inside the stack too, and the innermost hit is the one the user is
// actually pointing at. Pointing at a panel that is not a container (the hero) finds the stack,
// which is how a panel reaches the top of the Desk.
function containerAt(x, y) {
  let best = null, bestDepth = -1;
  for (const c of CONTAINERS.map($)) {
    // A container on a hidden tab measures 0x0; dragging on the Data tab must not fling the panel
    // into an invisible Desk container.
    if (!c || !c.offsetWidth || !c.offsetHeight) continue;
    // Dropping a group inside itself would detach the very node being dragged.
    if (dragged && dragged.contains(c)) continue;
    const r = c.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    let depth = 0;
    for (let n = c.parentElement; n; n = n.parentElement) depth++;
    if (depth > bestDepth) { bestDepth = depth; best = c; }
  }
  return best;
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
    [startX, startY, startW, startH] = [e.clientX, e.clientY, el.offsetWidth, el.offsetHeight];
    h.setPointerCapture(e.pointerId);
    el.classList.add('resizing');
    // Pointer capture doesn't cross into an iframe's document, so a drag over the radar would
    // otherwise die the moment the pointer entered it.
    document.body.classList.add('resizing');
  });

  h.addEventListener('pointermove', (e) => {
    if (!h.hasPointerCapture(e.pointerId)) return;
    const k = zoom();
    if (dir !== 's') setWidth(el, Math.max(160, startW + (e.clientX - startX) / k));
    if (dir !== 'e') el.style.height = `${Math.max(60, startH + (e.clientY - startY) / k)}px`;
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
    if (el.style.height) s.h = el.offsetHeight;
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
    // Below the grip check: a panel that is already wired had its saved size applied when it was,
    // and restore()/drop() re-apply explicitly. Re-reading and re-writing every panel's inline
    // size on each wire() pass was a layout thrash for nothing.
    if (el.querySelector(':scope > .grip')) return;
    applySaved(el);

    // A panel that holds other panels (the gauges block, the Desk grid, the day cards) is dragged
    // as a unit by its own grip — but that grip sat at the top right, exactly where the last panel
    // in the group's first row puts its own, and the child's won every time. The group's furniture
    // goes on the left instead, where nothing else lands.
    const group = !!el.querySelector('[data-panel]');

    const grip = document.createElement('div');
    grip.className = group ? 'grip grip-group' : 'grip';
    grip.title = group
      ? 'Drag to move this whole group · edges to resize'
      : 'Drag to move · edges to resize · double-click to reset this panel';
    grip.innerHTML = '<span>⠿</span>';

    // Pointer events rather than HTML5 drag-and-drop: DnD never fires for touch, and this
    // dashboard's home is a tablet. Only the grip starts a move — dragging from the panel body
    // would fight text selection and the radar iframe.
    // `from` is read at pointerdown, not closed over: a panel keeps its handlers when it moves to
    // another container, so the container it was wired in goes stale after the first cross-container
    // drop.
    let ph = null, offX = 0, offY = 0, from = null;

    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      from = el.parentElement;
      const r = el.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      const k = zoom();

      // The placeholder inherits the panel's footprint so the grid doesn't collapse the moment
      // the panel leaves the flow.
      ph = document.createElement('div');
      ph.className = 'ph';
      ph.style.height = `${el.offsetHeight}px`;
      ph.style.gridColumn = getComputedStyle(el).gridColumn;
      from.insertBefore(ph, el);

      // The dragged panel is `position: fixed`, so its left/top are layout pixels while the rect
      // it came from is painted ones.
      Object.assign(el.style, {
        width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px`,
        left: `${r.left / k}px`, top: `${r.top / k}px`,
      });
      el.classList.add('dragging');
      document.body.classList.add('resizing'); // same iframe/selection guard as a resize
      dragged = el;
      grip.setPointerCapture(e.pointerId);
    });

    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId) || dragged !== el) return;
      const k = zoom();
      el.style.left = `${(e.clientX - offX) / k}px`;
      el.style.top = `${(e.clientY - offY) / k}px`;
      const box = containerAt(e.clientX, e.clientY) || ph.parentElement;
      if (box !== ph.parentElement) ph.style.gridColumn = ''; // the old span means nothing in a new grid
      const before = insertPoint(box, e.clientX, e.clientY);
      if (before !== ph || box !== ph.parentElement) flip(box, () => box.insertBefore(ph, before));
    });

    const drop = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return;
      grip.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      const to = ph.parentElement;
      to.insertBefore(el, ph);
      ph.remove();
      ph = null;
      // Restore whatever the panel's own rules say; a saved size is reapplied on top.
      el.style.left = el.style.top = el.style.width = el.style.height = '';
      if (to !== from) {
        const s = entry(el.dataset.panel);
        // A width is a column span, and a span drawn against a 12-column Desk grid overflows a
        // two-column gauge block. The panel goes back to its natural size in its new home.
        delete s.w;
        setWidth(el, null);
        if (to === home.get(el.dataset.panel)) delete s.box; else s.box = to.id;
      }
      applySaved(el);
      dragged = null;
      if (to !== from) recordOrder(from);
      recordOrder(to);
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

    // Hide sits on the grip rather than in a drawer checklist: 29 panels make an unreadable list,
    // and `.layout-locked .grip` already puts it out of reach when the layout is locked.
    const hide = document.createElement('button');
    hide.className = group ? 'grip grip-hide grip-group' : 'grip grip-hide';
    hide.textContent = '×';
    hide.title = 'Hide this panel — restore it under Settings';
    hide.onclick = () => {
      entry(el.dataset.panel).hidden = true;
      Promise.resolve(leave(el)).then(() => el.classList.add('panel-hidden'));
      save();
    };
    el.appendChild(hide);
  });
}

if (location.search.includes('selftest')) {
  const box = document.createElement('div');
  box.innerHTML = '<div data-panel="a"></div><div data-panel="b"></div>';
  let moves = 0;
  const real = box.appendChild.bind(box);
  box.appendChild = (n) => { moves++; return real(n); };
  state.a = { order: 0 }; state.b = { order: 1 };
  applyOrder(box);
  console.assert(moves === 0, `layout: an already-sorted container is not rebuilt (got ${moves} moves)`);
  delete state.a; delete state.b;
}

export const snapshot = () => structuredClone(state);

export const hiddenPanels = () => Object.keys(state).filter((id) => state[id].hidden);

export function unhide(id) {
  delete entry(id).hidden;
  const el = document.querySelector(`[data-panel="${id}"]`);
  if (el) { el.classList.remove('panel-hidden'); enter([el]); }
  save();
}

// Swap the whole arrangement at once. Inline styles have to be stripped first: a panel the new
// state says nothing about would otherwise keep the old one's pixel height.
export function restore(next) {
  state = dropImpossibleHeights(structuredClone(next) || {});
  save();
  document.querySelectorAll('[data-panel]').forEach((el) => {
    setWidth(el, null); el.style.height = '';
    el.classList.remove('panel-hidden');
  });
  applyPlacement();
  CONTAINERS.map($).filter(Boolean).forEach((c) => {
    applyOrder(c);
    [...c.children].filter((k) => k.dataset.panel).forEach(applySaved);
  });
}

export function resetLayout() {
  // The designed arrangement, not raw markup order.
  restore(DEFAULT);
}

export function initLayout() {
  applyPlacement();
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

  // hide → applySaved paints it out; unhide takes the class and the flag back off
  const p = document.createElement('div');
  p.dataset.panel = 'sel-hide';
  document.body.appendChild(p);
  state = { 'sel-hide': { hidden: true } };
  applySaved(p);
  console.assert(p.classList.contains('panel-hidden'), 'layout: hidden panel painted out');
  console.assert(hiddenPanels().join() === 'sel-hide', 'layout: hiddenPanels lists it');
  unhide('sel-hide');
  console.assert(!p.classList.contains('panel-hidden') && !hiddenPanels().length, 'layout: unhide restores');
  p.remove();

  // the catalog: a panel with no tab is on the Desk, and setTab writes the one field
  state = {};
  console.assert(tabOf('anything') === 'desk', 'layout: a panel with no tab lives on the Desk');
  state = { hero: { tab: 'data' } };
  console.assert(tabOf('hero') === 'data', 'layout: the catalog records the tab');

  // Cross-container drops, against the real Desk: the gauges block is inside the stack, so a
  // pointer in the gauges must find the gauges (the inner one), while a pointer over a panel that
  // is not a container must find the stack — that is the path a card takes to the top of the Desk.
  const gaugesBox = $('gauges'), stackBox = $('desk-stack'), heroBox = $('hero');
  if (gaugesBox?.offsetWidth && stackBox?.offsetWidth && heroBox?.offsetWidth) {
    const mid = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    console.assert(containerAt(...mid(gaugesBox)) === gaugesBox, 'layout: the innermost container wins');
    console.assert(containerAt(...mid(heroBox)) === stackBox, 'layout: a plain panel drops into its stack');
    // A group cannot be dropped inside itself.
    dragged = gaugesBox;
    console.assert(containerAt(...mid(gaugesBox)) === stackBox, 'layout: a group skips its own inside');
    dragged = null;
  }

  // Painted pixels against layout pixels — the assumption the whole resize path now rests on.
  // Under `html { zoom }` a rect is scaled and `offsetHeight` is not, and reading the wrong one
  // is what grew panels by the zoom factor on every drag until their contents were unreachable.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;width:200px;height:100px';
  document.body.appendChild(probe);
  const was = document.documentElement.style.zoom;
  document.documentElement.style.zoom = '1.5';
  console.assert(probe.offsetHeight === 100, 'layout: offsetHeight is the layout pixel, whatever the zoom');
  console.assert(Math.round(probe.getBoundingClientRect().height) === 150, 'layout: a rect is painted pixels');
  console.assert(Math.abs(zoom() - 1.5) < 1e-6, 'layout: zoom() reads the root zoom');
  document.documentElement.style.zoom = was;
  probe.remove();

  // every DEFAULT key is a real panel, so a rename cannot silently drop out of the default
  const ids = new Set(panelIds());
  for (const k of Object.keys(DEFAULT)) {
    console.assert(ids.size === 0 || ids.has(k), `layout: DEFAULT names a real panel (${k})`);
  }

  state = JSON.parse(before);
  save(); // the hide/unhide asserts wrote through to storage — put the real layout back
}
