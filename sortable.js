// Pointer drag-to-reorder within ONE list.
import { motion } from './motion.js';

// Pointer-based single-list sortable: vertical reorder within ONE list, never reparents.
// Purely-visual during the drag (lift the dragged item, shift siblings to open a gap); commit once on drop.
// Used by the composer entry lists, the task-list checklist rows and (touch only) the task-list rows.

// Scroll scrollEl toward the edge when clientY is within THRESH px. Returns the px applied (0 = not in zone).
// Distance = rate × ms since the previous step, so speed is the same however often steps come (per dragover, per
// 60/120Hz frame). One step covers at most MAX_DT: a stall, a drag off the window or a re-grab never jumps.
// Whole px only, the sub-px rest carried to the next step: an engine that rounds scrollTop (WebKit) would drop
// 120Hz's half-size steps. With prefers-reduced-motion: constant velocity (no proximity ramp).
let lastStep = 0, carry = 0;
export function edgeScrollStep(scrollEl, clientY, rm = false, inset = 0) {   // inset: px of pinned chrome over the top edge
  const now = performance.now(), gap = now - lastStep; lastStep = now;
  if (!scrollEl) return 0;
  // ceiling: a frame past MAX_DT scrolls slower (150ms → 2/3 speed) — raise MAX_DT if a target phone's drag frames run past it
  const MAX_DT = 100, dt = Math.min(gap, MAX_DT), v = edgeSpeed(scrollEl, clientY, rm, inset);
  if (!v) return carry = 0;
  const want = v * dt + carry, whole = Math.trunc(want);
  carry = want - whole; scrollEl.scrollTop += whole;
  return v * dt;   // U-12: let scrollFrame know whether we're in the edge zone
}

// The zone's px/ms at clientY, 0 outside it: no scroll, no clock
export function edgeSpeed(scrollEl, clientY, rm, inset = 0) {
  const THRESH = 48, MAX = 0.72, rect = scrollEl.getBoundingClientRect();   // MAX px/ms = 12px per 60Hz frame; a step ≤ 72px
  const top = clientY - rect.top - inset, bot = rect.bottom - clientY;
  if (top < THRESH && top >= 0) return rm ? -MAX / 2 : -(1 - top / THRESH) * MAX;
  if (bot < THRESH && bot >= 0) return rm ? MAX / 2 : (1 - bot / THRESH) * MAX;
  return 0;
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

const SHIFT = 'transform 180ms var(--ease-out)';
export const DWELL = 500;   // ms a pointer rests on a target to act on it: Peek edge-hold paging, a drag's "into"
const noPan = e => e.preventDefault();
export let sorting = false;   // an item is held/dragged — the surface swipe reads this instead of walking the DOM per move

// makeSortable(container, { itemSel, handleSel?, scopeSel?, touchOnly?, onCommit(from,to,scope,items,into,cut), enabled?(), fixed?(), pinned?(to,items,from,far), refused?(), onHold?(item), lift?(item,x0) → undo, span?(to,items) → last, above?(to,items,from) → to, redirect?(to,items,from,far) → b|null, far?(x), preview?(item,to,items,into,cut), dwell?(item,done) → ok })
// scopeSel confines a drag to items inside the grabbed item's nearest scopeSel (e.g. one task's checklist) so one
// delegated listener serves many independent lists. A MOUSE grabs handleSel (omitted ⇒ the whole item) and drags
// past a small threshold, so clicks still fire. Anything else (finger, pen) has no handle: holding the item HOLD ms
// within SLOP px arms it — it lifts — and only then does a move drag, so a swipe that doesn't wait scrolls and a
// pen fling never reorders. The handle still gates WHICH items may move (no handle rendered ⇒ not movable).
// onHold(item) → true claims a held item let go unmoved (its click is swallowed); fixed() → nothing may reorder, but holds still count.
// pinned(to, items, from, far) → true: the item keeps its place rather than take slot `to`; a dwell still nests. refused(): let go there.
// redirect(to, items, from, far) → b: the gap opens right before items[b] instead (no span), `cut` true in preview and onCommit; null keeps `to`.
// far(x) → true: the finger's x unindents (#97): pinned and redirect then judge the item's own slot too, and nothing nests.
// dwell(item, false) → may nest: as the finger enters an item's middle (null: none); dwell(item, true) after DWELL there → true makes it `into`.
export function makeSortable(container, { itemSel, handleSel, scopeSel, touchOnly, onCommit, enabled, fixed, pinned, refused, onHold, lift, span, above, redirect, preview, dwell, far }) {
  let st = null;
  const THRESH = 4, HOLD = 300, SLOP = 8;   // HOLD is real ms: motion.t would zero it under reduced motion

  container.addEventListener('pointerdown', e => {
    if (st || e.button || e._sorted) return;              // one drag at a time — ignore extra pointers (emil §10)
    const mouse = e.pointerType === 'mouse', a = document.activeElement;
    if ((touchOnly && mouse) || (enabled && !enabled())) return;
    if (e.target.closest('code, .md-code')) return;       // code owns native selection, never item reordering
    if (!mouse && a?.isContentEditable && a.contains(e.target)) return;   // text being edited: the platform's long-press select wins
    const item = e.target.closest(itemSel);
    if (!item || !container.contains(item)) return;
    if (handleSel && !(mouse ? e.target.closest(handleSel) : item.querySelector(handleSel))) return;
    const scope = scopeSel ? item.closest(scopeSel) : container;
    if (!scope) return;
    e._sorted = true;   // nested sortables share one bubbling press: the innermost owns it
    const ac = new AbortController(), o = { signal: ac.signal };
    st = { item, scope, ac, x0: e.clientX, _cx: e.clientX, startY: e.clientY, t0: e.timeStamp, pid: e.pointerId, dragging: false, hold: !mouse && setTimeout(begin, HOLD) };
    if (mouse) container.style.userSelect = 'none';   // a finger writes nothing until it holds: a swipe never touches the list
    window.addEventListener('pointermove', onMove, o);
    window.addEventListener('pointerup', onUp, o);
    window.addEventListener('pointercancel', onUp, o);
  });

  function begin() {
    if (!st.item.checkVisibility() || st.item.closest('[inert]')) return onUp();   // its list left the screen (inert: still drawn through its slide out)
    const still = () => { if (!onHold) return onUp(); st.still = true; st.item.classList.add('sorting'); };   // nothing to reorder: lifted only to be let go
    if (fixed?.()) return still();
    const unlift = lift?.(st.item, st.x0);   // before measuring: it may take rows out of the list
    const items = [...st.scope.querySelectorAll(itemSel)], from = items.indexOf(st.item);
    if (from < 0 || items.length < 2) { unlift?.(); return from < 0 ? onUp() : still(); }   // alone, its subtree aside
    Object.assign(st, { items, from, to: from, dragging: true, unlift }); sorting = true; container.style.userSelect = 'none';
    // A held item owns the finger: no pan under it. Only while held (Chrome re-hit-tests the first touchmove), so a
    // plain scroll never waits on the main thread; on the document, as Chrome's per-element region missed the composer.
    if (st.hold) document.addEventListener('touchmove', noPan, { passive: false, signal: st.ac.signal });
    const rects = st.items.map(el => el.getBoundingClientRect());
    st.rects = rects; st.centers = rects.map(r => r.top + r.height / 2);
    st.h = Math.abs(st.centers[1] - st.centers[0]);
    try { st.item.setPointerCapture(st.pid); } catch { }
    st.item.classList.add('sorting');
    st.item.style.transition = 'none';
    st.scrollEl = scrollParent(container);
    st.startScrollTop = st.scrollEl?.scrollTop ?? 0; st.off = st.item.offsetTop;   // U-13: baseline for scroll-adjusted dy
    st._rm = motion.scale === 0;                        // U-12: hoist the one dial (motion.js) out of the per-frame edgeScrollStep
    for (let i = 0; i < st.items.length; i++) if (i !== st.from) st.items[i].style.transition = st._rm ? 'none' : SHIFT;
    st.mo = new MutationObserver(recapture); st.mo.observe(st.item.parentElement, { childList: true });
  }

  // A windowed list swaps rows in and out as the drag scrolls it: re-read them, so the gap follows the finger past the rows there at
  // the press. offsetTop, which no shift's transform moves, from the held row's place at the press: the rows' coordinates stay the press's.
  function recapture() {
    const items = [...st.scope.querySelectorAll(itemSel)], from = items.indexOf(st.item), old = st.items;
    if (from < 0) return;   // the held row was redrawn: keep the rows it had
    const top0 = st.rects[st.from].top - st.item.offsetTop, re = i => i === false ? i : items.indexOf(old[i]);
    st.startScrollTop += st.item.offsetTop - st.off; st.off = st.item.offsetTop;   // rows above drawn at their real height, not the estimate, move the held row, and the scroll with it if anchored: neither is the finger's
    st.rects = items.map(el => ({ top: top0 + el.offsetTop, bottom: top0 + el.offsetTop + el.offsetHeight, height: el.offsetHeight }));
    st.centers = st.rects.map(r => r.top + r.height / 2);
    for (const el of items) if (el !== st.item) el.style.transition = st._rm ? 'none' : SHIFT;
    Object.assign(st, { items, from, to: Math.max(0, re(st.to)), at: re(st.at), cut: re(st.cut) });
    shift(); locate();
  }

  // driver step: alive only while in the edge zone (U-12); every onMove re-arms via motion.run. The rows it scrolls move under a still
  // finger, so the zone is no rest: dwellOn arms nothing while `scrolling`, and re-reads the row as the finger leaves.
  // ceiling: no row sits in a zone at a scroll end (header above, trailing space below) — gate on scrollTop's limit if one does
  const scrollFrame = () => {
    if (!st) return false;
    const top = st.scrollEl?.scrollTop, v = !!edgeScrollStep(st.scrollEl, st._cy, st._rm);
    if (st.scrollEl?.scrollTop !== top || v !== st.scrolling) { st.scrolling = v; locate(); }
    return v;
  };

  function onMove(e) {
    if (!st || e.pointerId !== st.pid) return;   // a second finger never drives the drag
    const dy = e.clientY - st.startY;
    // moved before the hold armed: a scroll — judged on the finger's clock too, as a busy page can run the timer before a move it already queued.
    // Per coalesced sample (none in an insecure context — a phone on http://<LAN-IP>): a busy frame's one batch can straddle the arm, and its latest sample alone misreads it either way.
    if (st.hold) { const pre = [...(e.getCoalescedEvents?.() ?? []), e].filter(s => !st.dragging || s.timeStamp - st.t0 < HOLD);
      if (pre.some(s => Math.hypot(s.clientX - st.x0, s.clientY - st.startY) > SLOP)) return onUp(); if (!st.dragging) return; }
    if (!st.dragging) { if (Math.abs(dy) < THRESH) return; begin(); if (!st?.dragging) return; }
    e.preventDefault(); st.moved = true;
    st._cx = e.clientX; st._cy = e.clientY;
    st.scrolling = !!st.scrollEl && !!edgeSpeed(st.scrollEl, st._cy, st._rm);   // before locate: the move into the zone marks no row
    locate();
    motion.run(container, scrollFrame);   // keyed on the container — supersede is a cheap re-set
  }

  // The finger's last point against the rows where they SETTLE, never as drawn (a 180ms shift slides them under a still finger).
  // Every change under the finger re-reads it here: a move, an edge-scroll step.
  function locate() {
    const scrolled = (st.scrollEl?.scrollTop ?? 0) - st.startScrollTop, dy = st._cy - st.startY + scrolled;   // U-13: scroll-adjusted, for the visual and the commit
    st.item.style.transform = `translateY(${dy}px)`;
    st.far = !!far?.(st._cx);
    let to = targetIndex(st.centers, st.from, st.centers[st.from] + dy);
    if (to < st.from && above && !st.far) to = above(to, st.items, st.from);   // far, the row under the finger unindents, not the one above() picks
    const own = to === st.from && !st.far;   // far, the item's own slot may still unindent it
    st.pinned = !own && !!pinned?.(to, st.items, st.from, st.far);
    const was = st.cut === st.to; st.cut = false;   // cut: the redirected slot; at the item's own (its parent changes), still a move
    if (st.pinned) to = st.from;
    else if (redirect && !own) { const b = redirect(to, st.items, st.from, st.far); if (b != null) st.cut = to = b > st.from ? b - 1 : b; }
    st.at = to;
    if (!st.into && (to !== st.to || was !== (st.cut === to))) { st.to = to; shift(); }   // `into` holds its gap
    else if (!st.into && st.cut === to) preview?.(st.item, to, st.items, null, true);   // one redirected gap, another landing row (#70): drawn at its depth
    if (dwell) dwellOn(st._cy + scrolled);
  }

  // A point on the rows where they settle → the same point on them as they sat at the drag's start, or null over the gap. Rows
  // between the lifted one and the gap settle a row toward its old place. ceiling: rows of one height (st.h, as shift() moves them) — measure each
  // row's shift once a list mixes heights (a wrapped title, a description line).
  function unshift(y) {
    const r = st.rects, h = st.h, down = st.from < st.to;
    if (st.to === st.from) return y >= r[st.from].top && y < r[st.from].bottom ? null : y;
    const gapTop = down ? r[st.end].bottom - h : r[st.to].top;
    if (y >= gapTop && y < gapTop + h) return null;
    return down ? (y >= r[st.from].top && y < gapTop ? y + h : y) : (y >= gapTop + h && y < r[st.from].bottom ? y - h : y);
  }

  // Resting DWELL ms in a row's middle 40% makes it `into`, and the gap moves to where that lands, after its subtree. Leaving the band
  // or the row undoes it, but not onto that gap or subtree: its own shift slid them under the finger.
  function dwellOn(fy, restart) {
    const y = unshift(fy), r = st.rects;
    let i = Math.min(st.to, r.length - 1);   // from the gap: a walk of a row or two
    if (y != null) { while (i > 0 && y < r[i].top) i--; while (i < r.length - 1 && y >= r[i].bottom) i++; }
    const row = y != null && i !== st.from && y >= r[i].top && y < r[i].bottom ? st.items[i] : null;
    if (st.into && !st.far && (!row || st.sub.has(row))) return;
    const mid = !st.scrolling && !st.far && row && y > r[i].top + r[i].height * .3 && y < r[i].bottom - r[i].height * .3 ? row : null;
    if (mid === st.over && !restart) return;
    clearTimeout(st.dwell); st.over = mid;
    if (st.into) { st.into = null; st.to = st.at; shift(); return dwellOn(fy, true); }   // the gap is back at the finger's slot: re-read
    if (dwell(mid, false)) st.dwell = setTimeout(() => {   // nothing under the finger moved meanwhile: every change re-reads it
      if (!dwell(mid, true)) return;
      const k = st.items.indexOf(mid), end = span?.(k, st.items) ?? k;
      st.into = mid; st.sub = new Set(st.items.slice(k + 1, end + 1)); st.to = end < st.from ? end + 1 : end; shift();
    }, DWELL);
  }

  function shift() {
    const end = st.end = st.from < st.to && st.to !== st.cut ? span?.(st.to, st.items) ?? st.to : st.to;   // the rows a drop below items[to] lands after; a redirected gap, none
    st.items.forEach((el, i) => {
      if (i === st.from) return;
      const d = (st.from < st.to && i > st.from && i <= end) ? -st.h
        : (st.from > st.to && i >= st.to && i < st.from) ? st.h : 0;
      el.style.transform = d ? `translateY(${d}px)` : '';
    });
    preview?.(st.item, st.to, st.items, st.into, st.cut === st.to);
  }

  function onUp(e) {
    if (!st || (e && e.pointerId !== st.pid)) return;   // nor does its lift end it
    const s = st; st = null; sorting = false;
    s.ac.abort(); s.mo?.disconnect(); clearTimeout(s.hold); clearTimeout(s.dwell); motion.stop(container); s.unlift?.();
    if (s.dragging || !s.hold) container.style.userSelect = '';
    if (s.still) s.item.classList.remove('sorting');
    if (!s.dragging && !s.still) return;           // never crossed the threshold → a tap; let the click through
    // a drag must not also toggle/open its row; a still hold let go is a (slow) tap unless onHold claims it
    if (s.moved || (e?.type === 'pointerup' && onHold?.(s.item))) swallowNextClick(s.item, e);
    if (!s.dragging) return;
    s.items.forEach(el => { el.classList.remove('sorting'); el.style.transform = ''; el.style.transition = ''; });
    if (e?.type === 'pointercancel') return;   // cancelled: the browser took it back
    if (s.to !== s.from || s.into || s.cut === s.from) onCommit(s.from, s.to, s.scope, s.items, s.into, s.cut === s.to);
    else if (s.pinned) refused?.();
  }

  // swallow only the click that lands on the dragged item (the toggle/open), and only until the next click or a short timeout —
  // never a click elsewhere. Self-removes so it can't linger. At the release point too: onHold may have re-rendered the item.
  function swallowNextClick(item, up) {
    const kill = ev => { if (item.contains(ev.target) || (up && Math.hypot(ev.clientX - up.clientX, ev.clientY - up.clientY) <= SLOP)) { ev.stopPropagation(); ev.preventDefault(); } done(); };
    const done = () => { clearTimeout(t); window.removeEventListener('click', kill, true); };
    window.addEventListener('click', kill, true);
    const t = setTimeout(done, 350);
  }
}
