// Pointer-based single-list sortable: vertical reorder within ONE list, never reparents.
// Purely-visual during the drag (lift the dragged item, shift siblings to open a gap); commit once on drop.
// Used by the composer entry lists (grip handle) and the task-list checklist rows (whole row).

// Scroll scrollEl toward the edge when clientY is within THRESH px. Returns velocity applied (0 = not in zone).
// With prefers-reduced-motion: constant velocity (no proximity ramp).
export function edgeScrollStep(scrollEl, clientY) {
  if (!scrollEl) return 0;
  const THRESH = 48, MAX = 12;
  const rect = scrollEl.getBoundingClientRect();
  const top = clientY - rect.top, bot = rect.bottom - clientY;
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let v = 0;
  if (top < THRESH && top >= 0) v = rm ? -MAX / 2 : -(1 - top / THRESH) * MAX;
  else if (bot < THRESH && bot >= 0) v = rm ? MAX / 2 : (1 - bot / THRESH) * MAX;
  if (v) scrollEl.scrollTop += v;
  return v;
}

function scrollParent(el) {
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    const { overflow, overflowY } = getComputedStyle(e);
    if (/auto|scroll/.test(overflow + overflowY) && e.scrollHeight > e.clientHeight + 1) return e;
  }
  return null;
}

// Pure: original item centers (px, top→bottom) + the dragged item's current center → the target slot index.
export function targetIndex(centers, from, draggedCenter) {
  let to = from;
  while (to < centers.length - 1 && draggedCenter > centers[to + 1]) to++;   // moved down past a neighbour's center
  while (to > 0 && draggedCenter < centers[to - 1]) to--;                     // moved up past a neighbour's center
  return to;
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SHIFT = 'transform 180ms var(--ease-out)';

// makeSortable(container, { itemSel, handleSel?, scopeSel?, mouseOnly?, onCommit(from,to,scope), enabled?() })
// handleSel omitted ⇒ the whole item is the grab target. scopeSel confines a drag to items inside the grabbed
// item's nearest scopeSel (e.g. one task's checklist) so one delegated listener serves many independent lists.
// Drag begins only past a small threshold, so taps still fire.
export function makeSortable(container, { itemSel, handleSel, scopeSel, mouseOnly, onCommit, enabled }) {
  let st = null;
  const THRESH = 4;

  container.addEventListener('pointerdown', e => {
    if (st || e.button) return;                           // one drag at a time — ignore extra pointers (emil §10)
    if (mouseOnly && e.pointerType === 'touch') return;   // leave touch to scroll the list
    if (enabled && !enabled()) return;
    const grab = e.target.closest(handleSel || itemSel);
    if (!grab || !container.contains(grab)) return;
    const item = e.target.closest(itemSel);
    if (!item || !container.contains(item)) return;
    const scope = scopeSel ? item.closest(scopeSel) : container;
    if (!scope) return;
    const items = [...scope.querySelectorAll(itemSel)];
    const from = items.indexOf(item);
    if (from < 0 || items.length < 2) return;
    st = { item, items, scope, from, to: from, startY: e.clientY, pid: e.pointerId, dragging: false };
    container.style.userSelect = 'none';
    st.move = onMove; st.up = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  });

  function begin() {
    st.dragging = true;
    const rects = st.items.map(el => el.getBoundingClientRect());
    st.centers = rects.map(r => r.top + r.height / 2);
    st.h = st.centers.length > 1 ? Math.abs(st.centers[1] - st.centers[0]) : rects[st.from].height;
    try { st.item.setPointerCapture(st.pid); } catch { }
    st.item.classList.add('sorting');
    st.item.style.transition = 'none';
    for (let i = 0; i < st.items.length; i++) if (i !== st.from) st.items[i].style.transition = reduced() ? 'none' : SHIFT;
    st.scrollEl = scrollParent(container);
  }

  function scrollFrame() {
    if (!st || !st._sRaf) return;
    st._sRaf = null;
    edgeScrollStep(st.scrollEl, st._cy);
    st._sRaf = requestAnimationFrame(scrollFrame);
  }

  function onMove(e) {
    if (!st) return;
    const dy = e.clientY - st.startY;
    if (!st.dragging) { if (Math.abs(dy) < THRESH) return; begin(); }
    e.preventDefault();
    st.item.style.transform = `translateY(${dy}px)`;
    const to = targetIndex(st.centers, st.from, st.centers[st.from] + dy);
    if (to !== st.to) { st.to = to; shift(); }
    st._cy = e.clientY;
    if (!st._sRaf) st._sRaf = requestAnimationFrame(scrollFrame);
  }

  function shift() {
    st.items.forEach((el, i) => {
      if (i === st.from) return;
      const d = (st.from < st.to && i > st.from && i <= st.to) ? -st.h
        : (st.from > st.to && i >= st.to && i < st.from) ? st.h : 0;
      el.style.transform = d ? `translateY(${d}px)` : '';
    });
  }

  function onUp() {
    if (!st) return;
    container.style.userSelect = '';
    window.removeEventListener('pointermove', st.move);
    const s = st; st = null;
    if (s._sRaf) cancelAnimationFrame(s._sRaf);
    if (!s.dragging) return;                       // never crossed the threshold → a tap; let the click through
    swallowNextClick(s.item);                       // ...but a real drag must not also toggle/open the row it grabbed
    s.items.forEach(el => { el.classList.remove('sorting'); el.style.transform = ''; el.style.transition = ''; });
    if (s.to !== s.from) onCommit(s.from, s.to, s.scope);
  }

  // swallow only the click that lands on the dragged item (the toggle/open), and only until the next click or a short timeout —
  // never a click elsewhere. Self-removes so it can't linger.
  function swallowNextClick(item) {
    const kill = ev => { if (item.contains(ev.target)) { ev.stopPropagation(); ev.preventDefault(); } done(); };
    const done = () => { clearTimeout(t); window.removeEventListener('click', kill, true); };
    window.addEventListener('click', kill, true);
    const t = setTimeout(done, 350);
  }
}
