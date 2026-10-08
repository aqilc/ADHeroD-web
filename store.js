// Pure tree/recurrence helpers + LocalStore, the offline default adapter (same interface as supabase-store.js; api-surface.test locks it).
import { isoDate } from './nlp.js';
import { makeFuzzy, buildSearchDocs, rankDocs, defaultDocs, matchQuery } from './search.js';
import { nextTs } from './recovery.js';
import { inNotes } from './predicates.js';

// Max nesting depth (root = 1; Backlog counts as a level). Shared by store guards + app.js drag guards.
export const MAX_DEPTH = 4;
// Legacy storage/undo/bin payloads: explicit overview wins, including false.
export const overviewFields = fields => {
  if (!('sidebar' in fields)) return fields;
  const { sidebar, ...rest } = fields;
  return { ...rest, overview: rest.overview ?? sidebar };
};
// Checklist item ids key the composer's rows and every by-id toggle, but stored lists can carry missing/duplicate
// ids (Android mints `c${size}`, reused after a delete; imports carry none) — rows then vanish and the zebra doubles
// up. Both stores apply this on READ; deterministic, so every read agrees until the next save persists it.
export const chkIds = list => { const seen = new Set();
  if (list.every(c => c.id && !seen.has(c.id) && seen.add(c.id))) return list;
  seen.clear();
  return list.map((c, i) => { let id = c.id && !seen.has(c.id) ? c.id : `${c.id || 'chk'}-${i}`; while (seen.has(id)) id += `-${i}`; seen.add(id); return id === c.id ? c : { ...c, id }; });   // until unused: one pass is a fixed point
};
// Canonical task record — single source of truth. Used by seed/create/normalize AND tests.
export const baseTask = () => {
  const ts = new Date().toISOString();
  return {
    id: crypto.randomUUID(), content: '', notes: null, importance: 'none', recur_from: null, available_from: null, deadline_at: null,
    est_minutes: null, parent_id: null, area_ids: [], goal_ids: [], color: null, favorite: false, place: null, location: { mode: 'any', ids: [] }, milestone: false,
    position: 0, completed_at: null, archived_at: null, blocked_by: [], relates: [], attachments: [], overview: false, checklist: [], checklist_plain: false, task_type: null,
    recurrence: null, completions: [], created_at: ts, updated_at: ts,
    starts_at: null, ends_at: null, tz: null, task_size: null, anchor: null, possible: null,
  };
};
// parent_id → child ids, in row order: built once, it serves every subtree walk of a batch.
export const childIndex = rows => { const m = new Map(); for (const r of rows) { const l = m.get(r.parent_id); if (l) l.push(r.id); else m.set(r.parent_id, [r.id]); } return m; };
// Depth of the subtree rooted at id (id alone = 1), a level at a time. Cycle-safe.
export function subtreeDepth(rows, id, kids = childIndex(rows)) {
  const seen = new Set([id]); let depth = 0;
  for (let level = [id]; level.length; depth++) level = level.flatMap(x => (kids.get(x) || []).filter(c => !seen.has(c) && seen.add(c)));
  return depth;
}
// [id, ...all descendant ids], breadth-first in kids' order. Cycle-safe. kids: parent → ids, or → rows (the app's _taskIdx).
// skip: a descendant it's true for is left out with its subtree.
export function descendantIds(projects, id, kids = childIndex(projects), skip = null) {
  const result = [id], seen = new Set([id]);
  for (let i = 0; i < result.length; i++) for (const c of kids.get(result[i]) || []) { const k = c.id ?? c; if (!seen.has(k) && !skip?.(k)) { seen.add(k); result.push(k); } }
  return result;
}

// n strictly rising positions for a reordered child list, from the ones its rows hold (sorted; a tie bumps up, a row moving in
// gets one past the last): a row whose slot equals its position needs no write.
export const orderSlots = (held, n) => {
  const slots = [...held].sort((a, b) => a - b);
  while (slots.length < n) slots.push(slots.at(-1) ?? 0);   // the tie bump below lifts it past the last
  let last = -Infinity;
  return slots.map(p => last = Math.max(p, last + 1));
};

// Depth in the tree (root = 1). Cycle-safe.
export function projectDepth(projects, id) {
  let depth = 1, cur = projects.find(p => p.id === id);
  const seen = new Set();
  while (cur && cur.parent_id && !seen.has(cur.id)) { seen.add(cur.id); depth++; cur = projects.find(p => p.id === cur.parent_id); }
  return depth;
}

// Incomplete descendants + incomplete blockers that a completion of `id` would sweep (archived rows and notes excluded — never force-completed).
// A repeating parent's occurrence leaves the subtasks with their own repeat alone. byId/kids: the app passes the indexes it holds — two O(n) builds per call otherwise.
export function pendingSweep(rows, id, byId = new Map(rows.map(r => [r.id, r])), kids = childIndex(rows), ts = new Date().toISOString()) {
  const t = byId.get(id); if (!t || inNotes(t)) return [];   // a note never completes, so it sweeps nothing
  const own = occursAgain(t, ts) ? k => recActive(byId.get(k)?.recurrence) : null;
  return [...new Set([...descendantIds(rows, id, kids, own).slice(1), ...(t.blocked_by || [])])].filter(x => { const r = byId.get(x); return r && !r.completed_at && !r.archived_at && !inNotes(r); });
}
export function ancestorIds(rows, id) {
  const out = [], seen = new Set([id]); let cur = rows.find(r => r.id === id);
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) { seen.add(cur.parent_id); out.push(cur.parent_id); cur = rows.find(r => r.id === cur.parent_id); }
  return out;
}
// Task resolver: a parent is never complete while it has an open descendant. Completed ancestors of `id` to reopen
// once it lands open (create, reparent, un-complete, undo, unarchive). Pure; both stores apply it (pg twin: reopen_ancestors).
export const ancestorsToReopen = (rows, id) => { const t = rows.find(r => r.id === id);
  return t && !t.completed_at && !t.archived_at ? ancestorIds(rows, id).filter(a => rows.find(r => r.id === a)?.completed_at) : []; };
// Parent ids (bottom-up) to auto-complete after id is marked done — stops when a sibling is still open, at a note (never
// done, so an open child of its own parent), or at the default project, which never auto-completes (pg twin: auto_complete_parent).
// ts: a completion — a repeating parent whose rule goes on ends the list (its occurrence advances, so it stays open).
export function parentsToComplete(rows, id, defaultId, ts = null) {
  const out = [], marked = new Set(); let cur = rows.find(r => r.id === id);
  while (cur?.parent_id) {
    const parent = rows.find(r => r.id === cur.parent_id); if (!parent) break;
    const kids = rows.filter(r => r.parent_id === parent.id), occurs = ts && occursAgain(parent, ts);
    // archived children count as satisfied (like completed) so a parent can close when its remaining work is done/abandoned;
    // under an occurrence, so does a subtask with its own repeat (left alone).
    const done = kids.length && kids.every(k => k.completed_at || k.archived_at || marked.has(k.id) || occurs && recActive(k.recurrence));
    if (done && parent.id !== defaultId && !inNotes(parent)) { if (!parent.completed_at && !parent.archived_at) { out.push(parent.id); marked.add(parent.id); } if (occurs) break; cur = parent; }
    else break;
  }
  return out;
}
// Which old-parent-chain ids should auto-complete after `id` moves out from `oldParentId`:
// view `id` as if still under oldParent AND done, then ask which ancestors would close. Pure; both stores apply the result.
export function movedOutParents(rows, id, oldParentId, ts, defaultId) {
  if (!rows.some(r => r.parent_id === oldParentId && r.id !== id)) return [];   // its only child left — nothing finished the parent
  const tempRows = rows.map(r => r.id === id ? { ...r, parent_id: oldParentId, completed_at: ts } : r);
  return parentsToComplete(tempRows, id, defaultId);
}
// …for a removal of several [root, Set of the ids it takes] groups: each as its own remove would close them, over the rows
// the groups before it left, their closes applied. ceiling: O(groups·n) — group the roots by parent past ~1000 selected.
export function removedOutParents(rows, groups, ts, defaultId) {
  const out = []; let left = rows;
  for (const [root, gone] of groups) {
    const p = left.find(r => r.id === root)?.parent_id, ids = p ? movedOutParents(left, root, p, ts, defaultId) : [];
    if (ids.length) { out.push(...ids); left = left.map(r => ids.includes(r.id) ? { ...r, completed_at: ts } : r); }
    if (groups.length > 1) left = left.filter(r => !gone.has(r.id));
  }
  return out;
}

// --- recurrence engine ---
export const _d = iso => new Date(iso.slice(0, 10) + 'T00:00:00Z'); // YYYY-MM-DD → UTC midnight
export const _iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const _daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // m: 0-based
// Advance n months, clamping to the target month's last day.
const addMonths = (d, n) => {
  const day = d.getUTCDate(), x = new Date(d);
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  x.setUTCDate(Math.min(day, _daysInMonth(x.getUTCFullYear(), x.getUTCMonth())));
  return x;
};
// Day-of-month md, n months forward, clamped to month-end.
const monthDayStep = (d, md, n) => { const x = addMonths(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), n);
  x.setUTCDate(Math.min(md, _daysInMonth(x.getUTCFullYear(), x.getUTCMonth()))); return x; };

// month_day is a scalar (legacy) or a list (ICS BYMONTHDAY) — always read as a sorted list.
const mdays = r => (Array.isArray(r.month_day) ? r.month_day : [r.month_day]).filter(n => n != null).sort((a, b) => a - b);
// The nth (1-5, or -1 = last) weekday `wd` of month `m` (0-based) — ICS BYDAY ordinals, "3rd Thursday".
const nthWeekday = (y, m, n, wd) => {
  if (n < 0) { const last = new Date(Date.UTC(y, m, _daysInMonth(y, m))); return addDays(last, -((last.getUTCDay() - wd + 7) % 7)); }
  const first = new Date(Date.UTC(y, m, 1));
  return addDays(first, ((wd - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
};
const weekStart = d => addDays(d, -((d.getUTCDay() + 6) % 7));   // Monday-start week (ICS WKST default)

// Advance a UTC-midnight date by one step of the recurrence rule. Shared by nextOccurrence + calendar.js.
export const recurStep = (r, d) => {
  const iv = r.interval || 1;
  if (r.freq === 'day') return addDays(d, iv);
  if (r.freq === 'week') {
    if (r.weekdays?.length) {
      let x = addDays(d, 1);
      while (!r.weekdays.includes(x.getUTCDay())) x = addDays(x, 1);
      // interval counts WEEKS, not steps: skip ahead only once the walk crosses into a new week, so
      // "every 2 weeks on Mon+Wed" stays biweekly instead of collapsing to weekly.
      return iv > 1 && +weekStart(x) !== +weekStart(d) ? addDays(x, (iv - 1) * 7) : x;
    }
    return addDays(d, iv * 7);
  }
  if (r.freq === 'month') {
    if (r.nth != null && r.weekdays?.length) {
      const here = nthWeekday(d.getUTCFullYear(), d.getUTCMonth(), r.nth, r.weekdays[0]);
      if (here > d) return here;   // this month's instance is still ahead of us
      const nx = addMonths(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), iv);
      return nthWeekday(nx.getUTCFullYear(), nx.getUTCMonth(), r.nth, r.weekdays[0]);
    }
    const md = mdays(r);
    if (md.length) {
      // another listed day later this month, else roll `interval` months to the first one. Clamped to month-end.
      const next = md.find(n => n > d.getUTCDate());
      if (next != null) { const x = new Date(d); x.setUTCDate(Math.min(next, _daysInMonth(d.getUTCFullYear(), d.getUTCMonth()))); if (x > d) return x; }
      return monthDayStep(d, md[0], iv);
    }
    return addMonths(d, iv);
  }
  if (r.months?.length) {   // yearly BYMONTH: walk the listed months, rolling the year every `interval`
    const ms = [...r.months].sort((a, b) => a - b), next = ms.find(n => n > d.getUTCMonth() + 1);
    const ty = next != null ? d.getUTCFullYear() : d.getUTCFullYear() + iv, tm = (next ?? ms[0]) - 1;
    const x = new Date(d); x.setUTCDate(1); x.setUTCFullYear(ty); x.setUTCMonth(tm);
    x.setUTCDate(Math.min(d.getUTCDate(), _daysInMonth(ty, tm)));
    return x;
  }
  return addMonths(d, iv * 12);   // year
};
// month_day also matches on month-end when it overshoots.
export const recurMatches = (r, d) => {
  if (r.freq === 'week' && r.weekdays?.length) return r.weekdays.includes(d.getUTCDay());
  if (r.freq === 'month') {
    if (r.nth != null && r.weekdays?.length) return +d === +nthWeekday(d.getUTCFullYear(), d.getUTCMonth(), r.nth, r.weekdays[0]);
    const md = mdays(r);
    if (md.length) { const dim = _daysInMonth(d.getUTCFullYear(), d.getUTCMonth()); return md.some(n => d.getUTCDate() === Math.min(n, dim)); }
  }
  if (r.freq === 'year' && r.months?.length) return r.months.includes(d.getUTCMonth() + 1);
  return true;
};

// --- multiple repeat statements (V3 phase 2): recurrence = one rule object (legacy) or an array of rules ---
export const recRules = rec => !rec ? [] : Array.isArray(rec) ? rec : [rec];
export const recActive = rec => recRules(rec).some(r => !r.paused);
// Earliest next occurrence across active rules (per-rule count/date ends respected) → { iso, rule } | null.
export function nextAcrossRules(rec, fromIso, now, opts) {
  let best = null;
  for (const r of recRules(rec)) {
    if (r.paused) continue;
    if (r.ends?.count != null && (r.done_count ?? 0) >= r.ends.count) continue;
    const iso = nextOccurrence(r, fromIso, now, opts);
    if (r.ends?.date && iso > r.ends.date) continue;
    if (!best || iso < best.iso) best = { iso, rule: r };
  }
  return best;
}

// fixed: advance from fromIso past today (inclusive = today eligible); from_completion: advance once from today
export function nextOccurrence(recurrence, fromIso, now, { inclusive = false } = {}) {
  const r = recurrence, today = isoDate(new Date(now));
  if (r.from_completion) return _iso(recurStep(r, _d(today)));
  let cur = _d(fromIso);
  if (inclusive && _iso(cur) >= today && recurMatches(r, cur)) return _iso(cur);   // today eligible as first due only if it matches
  do { cur = recurStep(r, cur); } while (_iso(cur) <= today);
  return _iso(cur);
}

// --- shared helpers (imported by supabase-store.js) ---
// Normalize area field shorthand: explicit ids win; else return trimmed names for per-store create.
export function resolveAreaNames(fields) {
  if (fields.area_ids) return { ids: fields.area_ids };
  return { ids: null, names: (fields.areas ?? []).map(n => (n ?? '').trim()) };
}
// Unified search: fuzzy when query, recency-first default otherwise.
export function searchDocs(query, limit, uf, idx, recent) {
  return (query || '').trim() ? rankDocs(uf, idx.haystack, idx.meta, query, limit) : defaultDocs(idx.meta, recent, limit);
}
// Build the freeText closure for matchQuery: fuzzy ids + optional scope-aware substring filter.
export function buildFreeText(uf, getIdx, tasks) {   // getIdx: the index is built only when a query has free text
  return (term, scope) => {
    const idx = getIdx(), [idxs] = uf.search(idx.haystack, term, 1, 1e4);
    const ids = new Set((idxs || []).map(i => idx.meta[i].id));
    if (!scope) return ids;
    return new Set([...ids].filter(id => { const t = tasks.find(x => x.id === id); if (!t) return false; return ((scope === 'description' || scope === 'notes' ? t.notes : t.content) || '').toLowerCase().includes(term); }));
  };
}
// Prepend id to a recent list, dedup, cap at 12.
export const updateRecent = (id, recent) => [id, ...(recent || []).filter(x => x !== id)].slice(0, 12);
// Compute recurrence advance patch for a completed occurrence (non-mutating; returns {recurrence,recur_from,completed_at[,checklist]}).
export function advanceRecurrence(target, ts) {
  const wasArray = Array.isArray(target.recurrence);
  const rules = recRules(target.recurrence).map(r => ({ ...r }));
  const anchor = target.recur_from || isoDate(new Date(ts));
  const src = rules.find(r => r.gen_due && !r.paused) || rules.find(r => !r.paused);
  src.done_count = (src.done_count ?? 0) + 1;
  const srcNext = nextOccurrence(src, anchor, ts);
  if ((src.ends?.count != null && src.done_count >= src.ends.count) || (src.ends?.date && srcNext > src.ends.date)) src.paused = true;
  rules.forEach(r => delete r.gen_due);
  const rec = wasArray ? rules : rules[0];
  const best = nextAcrossRules(rec, anchor, ts);
  let completed_at = null, recur_from = target.recur_from;
  if (!best) completed_at = ts;
  else { best.rule.gen_due = true; recur_from = best.iso + (best.rule.at ? 'T' + best.rule.at : (target.recur_from?.length > 10 ? target.recur_from.slice(10) : '')); }
  return { recurrence: rec, recur_from, completed_at, ...!completed_at && untick(target) };   // the next occurrence starts unticked
}
const untick = t => !t.checklist_plain && t.checklist?.some(c => c.done) && { checklist: t.checklist.map(c => ({ ...c, done: false })) };   // a plain list has no ticks
// A completion of t now is an occurrence: its rule goes on, so it advances instead of closing.
const occursAgain = (t, ts) => recActive(t?.recurrence) && !t.completed_at && !advanceRecurrence(t, ts).completed_at;
// What completing `id` writes, net per row (both stores apply it). A repeating task advances instead of closing; a repeating
// parent's occurrence (the target, or the top of the walk) also reopens the subtasks that follow its date, unticked: no date, deadline or
// repeat of their own, not archived (a dated one stays done, an own repeat is left alone). placed: placedMap.
export function completionPatches(rows, id, ts, defaultId, placed) {
  const byId = new Map(rows.map(r => [r.id, r])), kids = childIndex(rows), t = byId.get(id), out = new Map();
  const set = (x, patch) => out.set(x, { ...out.get(x), ...patch });
  const adv = recActive(t.recurrence) && !t.completed_at ? advanceRecurrence(t, ts) : null;
  if (!adv || kids.has(id)) {
    for (const x of pendingSweep(rows, id, byId, kids, ts)) {
      const r = byId.get(x);
      set(x, { completed_at: ts, ...recActive(r.recurrence) && { recurrence: pauseRecurrence(r.recurrence) } });   // pause, never destroy
    }
  }
  set(id, adv ?? { completed_at: ts });
  const after = rows.map(r => out.has(r.id) ? { ...r, ...out.get(r.id) } : r), walk = out.get(id).completed_at ? parentsToComplete(after, id, defaultId, ts) : [];
  for (const x of walk) set(x, { completed_at: ts });
  const top = walk.at(-1), occ = adv && !adv.completed_at ? kids.has(id) && id : top && occursAgain(byId.get(top), ts) && top;
  if (!occ) return out;
  if (occ !== id) set(occ, advanceRecurrence(byId.get(occ), ts));
  const own = k => { const r = byId.get(k); return r.archived_at || r.recurrence || r.deadline_at || placed.has(k); };   // a repeat's anchor and a deadline are its own date (a start date alone isn't)
  for (const x of descendantIds(rows, occ, kids, own).slice(1)) {
    const r = byId.get(x), patch = { ...r.completed_at && { completed_at: null }, ...!inNotes(r) && untick(r) };
    if (Object.keys(patch).length) out.set(x, patch); else out.delete(x);   // swept open: it ends where it began
  }
  return out;
}
// A placement is minted in a clock — stamp it (freeze §8 step 3) so day-boundary math survives travel. Explicit tz wins.
export const captureTz = f => { if ((f.starts_at || f.ends_at) && !f.tz) f.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; return f; };
// Pause all rules in a recurrence (non-mutating).
// An archive takes the open tasks under its root; an Unarchive brings back only those at the root's instant, never one archived on its own
export const cascades = (root, t, val) => val ? !t.completed_at && !t.archived_at : Date.parse(t.archived_at) === Date.parse(root.archived_at);
export const pauseRecurrence = rec => Array.isArray(rec) ? rec.map(x => ({ ...x, paused: true })) : { ...rec, paused: true };
// Seed initial recur_from for a new recurring task (mutates rec's rule to mark gen_due). Returns recur_from string or null.
export function seedRecurrenceDue(rec, ts) {
  const b = nextAcrossRules(rec, isoDate(new Date(ts)), ts, { inclusive: true });
  if (!b) return null;
  b.rule.gen_due = true;
  return b.iso + (b.rule.at ? 'T' + b.rule.at : '');
}
// THE placement fact: task_id → the date-item's ISO ("YYYY-MM-DD" or "…THH:MM"). A date-item is a schedule
// item with a date and no block. recur_from is NOT consulted — it survives only as a recurrence anchor.
export const placedMap = items => {
  const m = new Map();
  for (const x of items || []) if (!x.block_id && x.date) m.set(x.task_id, x.date + (x.start ? 'T' + x.start : ''));
  return m;
};
// The FKs a restored row carries (pg_mail/schema.js:243,282,299,318,349): a gone cascade parent means the DB
// rejects the row (and its whole batch), so it stays out; a gone location is ON DELETE SET NULL, so the block just loses it.
export const REFS = { scheduleItem: [['task_id', 'task'], ['block_id', 'block']], blockDay: [['block_id', 'block']],
  reminder: [['ref_id', 'task'], ['block_id', 'block']], block: [['location_id', 'location']], relation: [['task_id', 'task'], ['related_id', 'task']] };
// ids: parent kind → Set of live ids, or null when unreadable (keep the row: the write decides)
export const liveRefs = (kind, rows, ids) => (REFS[kind] || []).reduce((out, [col, p]) => {
  const ok = r => r[col] == null || !ids[p] || ids[p].has(r[col]);
  return p === 'location' ? out.map(r => ok(r) ? r : { ...r, [col]: null }) : out.filter(ok);
}, rows);

export function createLocalStore(opts = {}) {
  const storage = opts.storage || globalThis.localStorage;
  const TASKS_KEY = opts.key || 'adherod.tasks';
  const AREAS_KEY = 'adherod.areas';
  const META_KEY = 'adherod.meta';
  const FILTERS_KEY = 'adherod.filters';
  const uuid = opts.uuid || (() => crypto.randomUUID());
  const now = opts.now || (() => new Date().toISOString());

  // Parsed rows per key, trusted only while storage holds the very string they came from: another tab's write replaces
  // it, so a stale cache is never read nor written back over that write. Readers that write get shallow row copies.
  // Tasks parse normalized (chkIds, overviewFields): deterministic, so every read agrees until a save persists it.
  const _parsed = new Map();   // key → { raw, value, rows: id → [json | null until a write serializes it, row, its index in value] }
  const fixTask = t => overviewFields((t.checklist = chkIds(t.checklist ?? []), t));
  const parse = (k, s) => k === TASKS_KEY ? fixTask(JSON.parse(s)) : JSON.parse(s);
  const view = k => {
    const raw = storage.getItem(k) || (k === META_KEY ? '{}' : '[]'), hit = _parsed.get(k);
    if (hit?.raw === raw) { hit.raw = raw; return hit.value; }   // keep storage's own string: the next compare is by reference
    let value = JSON.parse(raw), dropped = false;
    // A null row holds no data: dropped (boot's healTasks writes tasks back without it); the rows are handed out uncopied.
    if (Array.isArray(value)) { const n = value.length; value = value.filter(r => r != null).map(r => k === TASKS_KEY ? fixTask(r) : r); dropped = value.length < n; }
    _parsed.set(k, { raw, value, dropped, rows: new Map(Array.isArray(value) ? value.map((r, i) => [r.id, [null, r, i]]) : []) }); return value;
  };
  const readKey = k => { const v = view(k); return Array.isArray(v) ? v.map(r => ({ ...r })) : { ...v }; };
  // Copy-on-write rows for a writer: its own array of the cached rows, whose JSON the write reuses; edit(id) swaps in a
  // shallow copy of an original row, once, and returns it (null: no such row); a row the writer appended is its own. Edit before filtering or inserting rows: an original past n is edited in place.
  // get(id): the original row a Map over the array would hold (the last of a shared id).
  const cow = k => {
    const rows = [...view(k)], n = rows.length, mine = new Set(), cached = _parsed.get(k).rows;
    const from = cached.size === n ? n : 0;   // ceiling: O(n) scan per edit while any id repeats (the cache holds an id's last row; edit wants its first); dedupe on load if that shows in a trace
    const index = id => {
      const hit = from && cached.get(id); if (hit && rows[hit[2]]?.id === id) return hit[2];
      for (let i = hit ? 0 : from; i < rows.length; i++) if (rows[i].id === id) return i;   // hit elsewhere: the writer moved rows before this edit
      return -1;
    };
    return [rows, id => {
      const i = index(id); if (i < 0) return null;
      if (i < n && !mine.has(rows[i])) mine.add(rows[i] = { ...rows[i] });
      return rows[i];
    }, id => cached.get(id)?.[1]];
  };
  // A full or blocked storage fails the write, never the caller: every write reports whether it landed. A row whose JSON
  // didn't change keeps its object (the app's reload diff skips it); a changed one is parsed back, sharing nothing with the writer.
  // A row passed as the cached object itself is unedited (copy-on-write writers copy what they edit): its JSON is reused.
  // An in-place edit to a held row would be lost: tests set __storeCheck (the e2e harness, store.test) to fail that write.
  const writeKey = (k, v) => {
    try {
      if (!Array.isArray(v)) { storage.setItem(k, JSON.stringify(v)); return true; }
      const prev = _parsed.get(k)?.rows, rows = new Map(), value = [];
      const json = v.map(r => {
        const o = prev?.get(r.id);
        if (o?.[1] !== r && k === TASKS_KEY) r = fixTask(r);   // normalized as parse is, so an unchanged copy's JSON matches its cached row
        const s = (o?.[1] === r && o[0]) || JSON.stringify(r);
        if (globalThis.__storeCheck && o?.[1] === r && o[0] && o[0] !== JSON.stringify(r)) throw new Error(`row ${r.id} edited in place`);
        const row = o && (o[1] === r || (o[0] ?? JSON.stringify(o[1])) === s) ? o[1] : parse(k, s);   // ceiling: a row parsed but never written (o[0] null) serializes here, so a load's first write costs every row once; revisit if it shows in a trace
        rows.set(r.id, [s, row, value.length]); value.push(row); return s;
      });
      const raw = `[${json.join(',')}]`;
      storage.setItem(k, raw);
      _parsed.set(k, { raw, value, rows });
      return true;
    } catch (e) { console.error('[store] write failed', k, e); return false; }
  };
  // Append a row: the caller supplies only the fields that make its namespace different — id and the two
  // timestamps are the same everywhere, so they live here (the cloud's collection().insert is the mirror).
  const addRow = (k, write, fields) => { const ts = now(), row = { id: uuid(), ...fields, created_at: ts, updated_at: ts }; return write([...view(k), row]) ? row : null; };
  const patchRow = (k, write, id, fields) => { const [rows, edit] = cow(k), r = edit(id); if (!r) return null; Object.assign(r, fields, { updated_at: now() }); return write(rows) ? r : null; };
  const dropRow = (k, write, id) => write(view(k).filter(r => r.id !== id));
  const reorderRows = (k, write, ids, at) => { const [rows, edit] = cow(k), ts = now(); ids.forEach((id, i) => { const r = edit(id); if (r) { r.position = at ? at[i] : i; r.updated_at = nextTs(ts, r.updated_at); } }); return write(rows); };
  // Replace the rows hit() matches with fix(row) copies; no match, no write.
  const scrubRows = (k, write, hit, fix) => { const rows = view(k); if (rows.some(hit)) write(rows.map(r => hit(r) ? fix(r) : r)); };
  // Drop a row + scrub its id out of each [read, write, column] that references it (parity with the DB's delete_area RPC).
  // The row goes first: a failed scrub leaves a dangling id (the row's restore re-attaches it), never a task stripped of a live one.
  const removeAndScrub = (k, write, id, refs) => { if (!dropRow(k, write, id)) return false;
    for (const [refKey, writeRefs, col] of refs) scrubRows(refKey, writeRefs, r => r[col]?.includes(id), r => ({ ...r, [col]: r[col].filter(x => x !== id) }));
    return true; };
  // task_relations FKs both ends to tasks (pg_mail/schema.js:282): no blocked_by/relates id outlives its task.
  const dropEdges = (r, dead, edit = () => r) => { for (const k of ['blocked_by', 'relates']) if (r[k]?.some(dead)) { r = edit(r.id); r[k] = r[k].filter(x => !dead(x)); } };

  const readTasks = () => view(TASKS_KEY);   // the cached rows: a writer edits through cow
  const writeTasks = v => { reindex(); return writeKey(TASKS_KEY, v); };
  // Task resolver: reopen id's completed ancestors once it lands open. Edits cow rows; the caller writes them.
  const reopen = (rows, edit, id, ts = now()) => { for (const a of ancestorsToReopen(rows, id)) { const r = edit(a); r.completed_at = null; r.updated_at = nextTs(ts, r.updated_at); } };
  // …and close the parents id's move/removal left finished (movedOutParents: open, all in rows). Sync: nothing yields before the write.
  const closeMovedOut = (rows, edit, id, oldParentId, ts) => { for (const a of movedOutParents(rows, id, oldParentId, ts, readMeta().default_project_id)) { const r = edit(a); r.completed_at = ts; r.updated_at = nextTs(ts, r.updated_at); } };
  const readAreas = () => readKey(AREAS_KEY);
  const writeAreas = v => { reindex(); return writeKey(AREAS_KEY, v); };
  const readMeta = () => readKey(META_KEY);
  const writeMeta = v => writeKey(META_KEY, v);
  const readFilters = () => readKey(FILTERS_KEY);
  const writeFilters = v => writeKey(FILTERS_KEY, v);   // no reindex: filters aren't part of the search corpus
  const EVENTS_KEY = 'adherod.events';
  const readEvents = () => readKey(EVENTS_KEY);
  const writeEvents = v => writeKey(EVENTS_KEY, v);   // no reindex
  const BLOCKS_KEY = 'adherod.blocks';                // condition-bearing time regions (subsume presence windows)
  const readBlocks = () => readKey(BLOCKS_KEY);
  const writeBlocks = v => writeKey(BLOCKS_KEY, v);
  const SCHEDULE_ITEMS_KEY = 'adherod.schedule_items';
  const readScheduleItems = () => readKey(SCHEDULE_ITEMS_KEY);
  const writeScheduleItems = v => writeKey(SCHEDULE_ITEMS_KEY, v);
  const BLOCK_DAYS_KEY = 'adherod.block_days';
  const readBlockDays = () => readKey(BLOCK_DAYS_KEY);
  const writeBlockDays = v => writeKey(BLOCK_DAYS_KEY, v);
  const DAY_NOTES_KEY = 'adherod.day_notes';
  const readDayNotes = () => readKey(DAY_NOTES_KEY);
  const writeDayNotes = v => writeKey(DAY_NOTES_KEY, v);
  const REMINDERS_KEY = 'adherod.reminders';
  const readReminders = () => readKey(REMINDERS_KEY);
  const writeReminders = v => writeKey(REMINDERS_KEY, v);

  const LOCATIONS_KEY = 'adherod.locations';
  const readLocations = () => readKey(LOCATIONS_KEY);
  const writeLocations = v => { reindex(); return writeKey(LOCATIONS_KEY, v); };   // a task's place names are indexed
  const locationRow = (name, region = 'Home', position = 0) => ({ name, icon: null, color: null, region, position });
  const uf = makeFuzzy();
  let _search = { haystack: [], meta: [] }, _idxDirty = true;
  let _treeDirty = true;   // repairTree() only runs on list() after a parent_id-touching mutation (move/reparent/remove)
  function reindex() { _idxDirty = true; }   // U-18: lazy; built on first search/filter after mutation
  function ensureIdx() { if (_idxDirty) { _search = buildSearchDocs(readTasks(), readAreas(), readMeta().default_project_id || null, readLocations()); _idxDirty = false; } }

  // Storage keeps no null task row (read drops it) nor an id-less one (it may hold data: it gets an id), before ensureBacklog adopts a root by id.
  function healTasks() {
    const [tasks] = cow(TASKS_KEY); let healed = _parsed.get(TASKS_KEY).dropped;
    tasks.forEach((r, i) => { if (r.id == null) { tasks[i] = { ...r, id: uuid() }; healed = true; } });
    if (healed) writeTasks(tasks);
  }
  // --- seed: ensure a default root project ("Backlog") exists ---
  function ensureBacklog() {
    const tasks = readTasks();
    const meta = readMeta();
    if (meta.default_project_id && tasks.some(t => t.id === meta.default_project_id)) return;
    const root = tasks.find(t => t.parent_id === null);
    if (root) { meta.default_project_id = root.id; writeMeta(meta); return; }   // adopt existing root as default
    const ts = now();
    const backlog = { ...baseTask(), id: uuid(), content: 'Backlog', created_at: ts, updated_at: ts };
    if (writeTasks([...tasks, backlog])) { meta.default_project_id = backlog.id; writeMeta(meta); }   // never a default pointing at no task
  }

  // --- initialization ---
  function normalize() {
    const ts = now();
    const fill = (rows, defaults) => {
      let changed = false;
      rows.forEach((r, i) => { for (const k in defaults) if (r[k] === undefined) { if (rows[i] === r) rows[i] = { ...r }; rows[i][k] = defaults[k]; changed = true; } });
      return changed;
    };
    const [tasks, edit] = cow(TASKS_KEY), [areas] = cow(AREAS_KEY);
    const def = readMeta().default_project_id;
    const { id: _id, created_at: _c, updated_at: _u, ...taskDefaults } = baseTask();
    const filled = fill(tasks, { ...taskDefaults, parent_id: def, created_at: ts, updated_at: ts });
    const repaired = repairTree(tasks, def, edit);
    if (filled || repaired) writeTasks(tasks);
    if (fill(areas, { color: null, icon: null, position: 0, favorite: false, created_at: ts, updated_at: ts })) writeAreas(areas);
  }

  // Repair broken parent links (self-parent, dangling, cycles) through edit(id), the cow row to change.
  function repairTree(tasks, def, edit) {
    const byId = new Map(tasks.map(t => [t.id, t])), fix = new Map();   // id → repaired parent_id
    const parent = t => fix.has(t.id) ? fix.get(t.id) : t.parent_id;
    for (const t of tasks) {
      if (t.parent_id === t.id) fix.set(t.id, null);                                                  // self → root
      else if (t.parent_id && !byId.has(t.parent_id)) fix.set(t.id, t.id === def ? null : def);       // dangling → backlog
    }
    for (const t of tasks) {                                                                          // cut any remaining cycle
      const seen = new Set(); let cur = t;
      while (cur && parent(cur)) {
        if (seen.has(cur.id)) { fix.set(cur.id, null); break; }
        seen.add(cur.id); cur = byId.get(parent(cur));
      }
    }
    for (const [id, p] of fix) edit(id).parent_id = p;
    return fix.size > 0;
  }

  healTasks();
  ensureBacklog();
  normalize();
  reindex();

  // One-time (meta-flagged): seed default filters.
  {
    const meta = readMeta();
    if (!meta.default_filters_seeded) {
      if (readFilters().length === 0) {
        const ts = now();
        writeFilters([
          { id: uuid(), name: 'Weekly', query: 'is:weekly', color: null, position: 0, created_at: ts, updated_at: ts },
          { id: uuid(), name: 'Monthly', query: 'is:monthly', color: null, position: 1, created_at: ts, updated_at: ts },
        ]);
      }
      meta.default_filters_seeded = true; writeMeta(meta);
    }
    // "All tasks" is a removable default filter (a null filter — is:any → every task incl. completed/archived),
    // seeded at the top of the Filters list. Deletable like any filter; the old special roller 'all' item is gone.
    if (!meta.all_tasks_filter_seeded) {
      const fs = readFilters();
      if (!fs.some(f => f.name === 'All tasks' && f.query === 'is:any')) {
        const ts = now();
        writeFilters([{ id: uuid(), name: 'All tasks', query: 'is:any', color: null, position: -1, created_at: ts, updated_at: ts }, ...fs]);
      }
      meta.all_tasks_filter_seeded = true; writeMeta(meta);
    }
  }

  // Seed Home location once (a block names a location by id; tasks use a location constraint object).
  {
    const meta = readMeta();
    if (!meta.home_seeded) {
      if (readLocations().length === 0) addRow(LOCATIONS_KEY, writeLocations, locationRow('Home'));
      meta.home_seeded = true; writeMeta(meta);
    }
  }
  // --- name resolution helpers (used in tasks.create/update) ---
  function resolveParent(fields) {
    if (fields.parent_id !== undefined && fields.parent_id !== null) return fields.parent_id;
    if (fields.parent_id === null) return null;  // explicit null = root-level task
    if (fields.project) {
      const tasks = readTasks();
      const ts = now();
      let t = tasks.find(x => x.parent_id === null && x.content === fields.project && !x.archived_at);   // an archived one is retired: the name starts a new project
      if (!t) {
        const pos = tasks.length ? Math.min(...tasks.map(x => x.position ?? 0)) - 1 : 0;
        t = { ...baseTask(), id: uuid(), content: fields.project, position: pos, overview: true, created_at: ts, updated_at: ts };
        writeTasks([...tasks, t]);
      }
      return t.id;
    }
    return readMeta().default_project_id;
  }

  // Not unified with supabase-store's resolveAreaIds on purpose: the shared prefix is resolveAreaNames; the rest really differs (sync find-or-create + one batched writeAreas here, async ensureArea per name there). Don't re-flag.
  function resolveAreas(fields) {
    const { ids, names } = resolveAreaNames(fields);
    if (ids) return ids;
    if (!names.length) return [];
    const areas = [...view(AREAS_KEY)]; const ts = now();
    const result = names.map(nm => {   // trim so "Work " reuses "Work" (mirrors the DB unique index) — done by resolveAreaNames
      let l = areas.find(x => x.name === nm);
      if (!l) { const pos = areas.length ? Math.max(...areas.map(x => x.position)) + 1 : 0; l = { id: uuid(), name: nm, color: null, position: pos, favorite: false, created_at: ts, updated_at: ts }; areas.push(l); }
      return l.id;
    });
    writeAreas(areas); return result;
  }

  function resolveGoals(fields) { return Array.isArray(fields.goal_ids) ? fields.goal_ids : []; }

  return {
    // Another tab's write: `storage` fires in every other same-origin document — local storage's realtime. A null key: it cleared storage.
    subscribe(onChange) {
      const kinds = { [TASKS_KEY]: 'task', [AREAS_KEY]: 'area', [FILTERS_KEY]: 'filter', [EVENTS_KEY]: 'event', [BLOCKS_KEY]: 'block', [SCHEDULE_ITEMS_KEY]: 'scheduleItem',
        [BLOCK_DAYS_KEY]: 'blockDay', [DAY_NOTES_KEY]: 'dayNote', [REMINDERS_KEY]: 'reminder', [LOCATIONS_KEY]: 'location', [META_KEY]: 'location' };   // meta: the home place, which the places loader reads
      addEventListener('storage', e => { const kind = e.key === null ? 'all' : kinds[e.key]; if (kind && e.storageArea === storage) { reindex(); onChange(kind); } });
    },

    // parity with SupabaseStore.bootstrap — one call, whole account
    async bootstrap() {
      return {
        tasks: await this.tasks.list(), areas: await this.areas.list(),
        filters: await this.filters.list(), locations: await this.locations.list(),
        events: await this.events.list(), blocks: await this.blocks.list(),
      };
    },

    // Trash restore: re-insert previously-deleted rows (dedup by id, order-preserving). Powers "Recently deleted".
    // A row already live stays as it is, its id added to `live`: the Bin keeps its copy.
    reinsert(kind, rows, live = null) {
      const rw = { task: [TASKS_KEY, writeTasks], area: [AREAS_KEY, writeAreas],
        event: [EVENTS_KEY, writeEvents], block: [BLOCKS_KEY, writeBlocks], filter: [FILTERS_KEY, writeFilters], location: [LOCATIONS_KEY, writeLocations],
        scheduleItem: [SCHEDULE_ITEMS_KEY, writeScheduleItems], blockDay: [BLOCK_DAYS_KEY, writeBlockDays], dayNote: [DAY_NOTES_KEY, writeDayNotes],
        reminder: [REMINDERS_KEY, writeReminders] }[kind];
      if (!rw || !rows?.length) return false;
      const ids = Object.fromEntries((REFS[kind] || []).map(([, p]) => [p, new Set(view({ task: TASKS_KEY, block: BLOCKS_KEY, location: LOCATIONS_KEY }[p]).map(r => r.id))]));
      const [key, write] = rw, [cur, edit] = cow(key), have = new Set(cur.map(r => r.id)), add = liveRefs(kind, rows.filter(r => !have.has(r.id)), ids).map(r => ({ ...r }));
      for (const r of rows) if (have.has(r.id)) live?.add(r.id);
      // an edge to a task deleted since can't come back; a parent: repairTree re-homes the row; an open row reopens its done ancestors (pg twin: tasks_reopen_ancestors)
      if (kind === 'task') {
        const byId = new Map([...cur, ...add].map(r => [r.id, r])), ts = now();   // one index: a per-row reopen() scan is O(depth·n) per row
        for (const r of add) {
          dropEdges(r, x => !byId.has(x));
          if (!r.completed_at && !r.archived_at) for (let a = byId.get(r.parent_id), seen = new Set([r.id]); a && !seen.has(a.id); seen.add(a.id), a = byId.get(a.parent_id))
            if (a.completed_at) { byId.set(a.id, a = edit(a.id) ?? a); a.completed_at = null; a.updated_at = nextTs(ts, a.updated_at); }   // ?? a: an added row is already a copy
        }
        _treeDirty = true;
      }
      return write([...cur, ...add]);
    },

    defaultProject() { return readMeta().default_project_id || null; },
    search(query, limit = 50) { ensureIdx(); return searchDocs(query, limit, uf, _search, readMeta().recent || []); },
    recordSearchPick(id) { const meta = readMeta(); meta.recent = updateRecent(id, meta.recent); return writeMeta(meta); },
    runFilter(query) {   // a view: every match
      const tasks = readTasks(), areas = readAreas(), def = readMeta().default_project_id || null;
      return matchQuery(query, tasks, { now: now(), areas, defaultProjectId: def, placed: placedMap(readScheduleItems()), freeText: buildFreeText(uf, () => (ensureIdx(), _search), tasks) });
    },

    filters: {
      async list() { return readFilters().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async add({ name, query, color }) {
        return addRow(FILTERS_KEY, writeFilters, { name: name || 'Filter', query: query || '', color: color ?? null, position: readFilters().length });
      },
      async update(id, fields) { return patchRow(FILTERS_KEY, writeFilters, id, fields); },
      async remove(id) { return dropRow(FILTERS_KEY, writeFilters, id); },
      async reorder(ids) { return reorderRows(FILTERS_KEY, writeFilters, ids); },
    },

    events: {
      async list() { return readEvents(); },
      async get(id) { return readEvents().find(r => r.id === id) || null; },
      async add(fields) {
        return addRow(EVENTS_KEY, writeEvents, {
          title: fields.title || '', notes: fields.notes ?? null,
          starts_at: fields.starts_at, ends_at: fields.ends_at, all_day: fields.all_day ?? false,
          recurrence: fields.recurrence ?? null, location: fields.location ?? null, color: fields.color ?? null,
          // source stays 'local' — the enum has no other member; an .ics import's provenance is external_id,
          // which is also what a re-drop dedups on. ics_seq gates whether a re-drop may overwrite.
          source: 'local', external_id: fields.external_id ?? null, ics_seq: fields.ics_seq ?? null, countdown: !!fields.countdown,
        });
      },
      async update(id, fields) { return patchRow(EVENTS_KEY, writeEvents, id, fields); },
      async remove(id) { return dropRow(EVENTS_KEY, writeEvents, id); },
    },

    blocks: {
      async list() { return readBlocks(); },
      async add(fields) {
        return addRow(BLOCKS_KEY, writeBlocks, {
          title: fields.title || '', starts_at: fields.starts_at, ends_at: fields.ends_at,
          all_day: fields.all_day ?? false, recurrence: fields.recurrence ?? null,
          location_id: fields.location_id ?? null, areas: fields.areas ?? [],
          color: fields.color ?? null, source: 'local', est_minutes: fields.est_minutes ?? null,
        });
      },
      async update(id, fields) { return patchRow(BLOCKS_KEY, writeBlocks, id, fields); },
      // parity with the DB: schedule_items/block_days/reminders .block_id all cascade (pg_mail/schema.js:299,318,349).
      // The block goes first: a failed cascade leaves orphans its restore re-attaches, never a block stripped of them.
      async remove(id) {
        if (!dropRow(BLOCKS_KEY, writeBlocks, id)) return false;
        writeScheduleItems(view(SCHEDULE_ITEMS_KEY).filter(x => x.block_id !== id));
        writeBlockDays(view(BLOCK_DAYS_KEY).filter(x => x.block_id !== id));
        writeReminders(view(REMINDERS_KEY).filter(x => x.block_id !== id));
        return true;
      },
    },

    scheduleItems: {
      async list() { return readScheduleItems(); },
      async add({ task_id, block_id, role, position, date, start, duration_min }) {
        return addRow(SCHEDULE_ITEMS_KEY, writeScheduleItems, { task_id, block_id: block_id ?? null, role: role ?? 'during',
          position: position ?? 0, date: date ?? null, start: start ?? null, duration_min: duration_min ?? null });
      },
      async update(id, fields) { return patchRow(SCHEDULE_ITEMS_KEY, writeScheduleItems, id, fields); },
      async remove(id) { return dropRow(SCHEDULE_ITEMS_KEY, writeScheduleItems, id); },
      async get(id) { return readScheduleItems().find(r => r.id === id) || null; },
    },

    // User-authored reminders (kind:'user'). The server brain owns fire_at/level; the client owns the
    // sentence — when + severity + repetition + message. Anchored rows carry no absolute `at`, and vice versa.
    reminders: {
      async list() { return readReminders(); },
      async add({ task_id, anchor, offset_minutes, at, severity, repeat, times, message }) {
        const anc = anchor || 'absolute';
        return addRow(REMINDERS_KEY, writeReminders, {
          ref_type: 'task', ref_id: task_id, kind: 'user', anchor: anc,
          offset_minutes: anc === 'absolute' ? null : (offset_minutes ?? 0),
          at: anc === 'absolute' ? (at ?? null) : null,
          severity: severity ?? 'ping', repeat: repeat ?? null, times: times ?? null,
          message: message ?? null, paused: false,
        });
      },
      async update(id, fields) { return patchRow(REMINDERS_KEY, writeReminders, id, fields); },
      async remove(id) { return dropRow(REMINDERS_KEY, writeReminders, id); },
    },

    dayNotes: {
      async list() { return readDayNotes(); },
      async add({ date, label }) { return addRow(DAY_NOTES_KEY, writeDayNotes, { date, label }); },
      async update(id, fields) { return patchRow(DAY_NOTES_KEY, writeDayNotes, id, fields); },
      async remove(id) { return dropRow(DAY_NOTES_KEY, writeDayNotes, id); },
    },

    blockDays: {
      async list() { return readBlockDays(); },
      async set({ block_id, date, ...fields }) {
        const ts = now(), rows = view(BLOCK_DAYS_KEY);   // prev is replaced by a copy, never edited
        const prev = rows.find(r => r.block_id === block_id && r.date === date);
        const next = { ...(prev || { id: uuid(), block_id, date, created_at: ts }),
          ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updated_at: ts };
        return writeBlockDays(prev ? rows.map(r => (r === prev ? next : r)) : [...rows, next]) ? next : null;
      },
      async remove(id) { return dropRow(BLOCK_DAYS_KEY, writeBlockDays, id); },
      async update(id, fields) { return patchRow(BLOCK_DAYS_KEY, writeBlockDays, id, fields); },
    },

    tasks: {
      async list() {
        if (_treeDirty) { const [tasks, edit] = cow(TASKS_KEY); if (repairTree(tasks, readMeta().default_project_id || null, edit)) writeTasks(tasks); _treeDirty = false; }
        return [...readTasks()].sort((x, y) => (x.position ?? 0) - (y.position ?? 0) || y.created_at.localeCompare(x.created_at));
      },
      async get(id) { const t = view(TASKS_KEY).find(r => r.id === id); return t ? { ...t } : null; },   // a shallow copy: the holder may edit its top-level fields
      async create(fields) {
        fields = overviewFields(fields);
        try {
          const ts = now();
          captureTz(fields);
          const parent_id = resolveParent(fields);
          const area_ids = resolveAreas(fields);
          const goal_ids = resolveGoals(fields);
          if (parent_id) {
            const depth = projectDepth(readTasks(), parent_id);
            if (depth >= MAX_DEPTH) return null;
          }
          const [rows, edit] = cow(TASKS_KEY); // read after resolveParent (may write a new root task)
          const recurrence = fields.recurrence ?? null;
          let recur_from = fields.recur_from || null;
          if (recurrence && !recur_from) { const seeded = seedRecurrenceDue(recurrence, now()); if (seeded) recur_from = seeded; }   // seeded due is rule-generated; a rule may carry its own time
          const row = {
            ...baseTask(),
            id: fields.id ?? uuid(),   // a caller-minted id: a composer draft names its new subtasks before Save
            content: fields.content,
            notes: fields.notes ?? null,
            importance: fields.importance ?? 'none',
            recur_from,
            available_from: fields.available_from ?? null,
            deadline_at: fields.deadline_at || null,
            est_minutes: fields.est_minutes || null,
            parent_id,
            area_ids,
            goal_ids,
            color: fields.color ?? null,
            favorite: fields.favorite ?? false,
            place: fields.place ?? null,
            location: fields.location ?? { mode: 'any', ids: [] },
            position: fields.position ?? (rows.length ? Math.min(...rows.map(r => r.position ?? 0)) - 1 : 0),
            overview: fields.overview ?? false,
            checklist: fields.checklist ?? [],
            checklist_plain: fields.checklist_plain ?? false,
            task_type: fields.task_type ?? null,
            milestone: fields.milestone ?? false,
            blocked_by: fields.blocked_by ?? [], relates: fields.relates ?? [], attachments: fields.attachments ?? [],
            // substrate columns — Supabase create persists these via its post-insert update; parity demands the same here
            task_size: fields.task_size ?? null, anchor: fields.anchor ?? null, possible: fields.possible ?? null,
            starts_at: fields.starts_at ?? null, ends_at: fields.ends_at ?? null, tz: fields.tz ?? null,
            recurrence,
            created_at: ts,
            updated_at: ts,
          };
          rows.push(row); reopen(rows, edit, row.id, ts);
          if (row.blocked_by.length || row.relates.length) {   // Supabase create: setRelationType
            const live = new Set(rows.map(r => r.id)); dropEdges(row, x => !live.has(x));
            for (const { id } of rows) if (row.relates.includes(id)) { const r = edit(id); r.relates = [...(r.relates ?? []), row.id]; r.updated_at = nextTs(ts, r.updated_at); }
          }
          return writeTasks(rows) ? row : null;
        } catch (e) { console.error('[store] create failed', e); return null; }
      },
      async reorder(orderedIds, at) { return reorderRows(TASKS_KEY, writeTasks, orderedIds, at); },   // at: each id's position, default its index
      async update(id, fields) {
        fields = overviewFields(fields);
        captureTz(fields);
        let [rows, edit] = cow(TASKS_KEY);
        if (!rows.some(r => r.id === id)) return null;   // before resolveParent: a missing id must not leave a stray project
        const resolved = {};
        // project: null (every composer save of a root) is "no project named", not "move to the default"
        if (fields.parent_id !== undefined) resolved.parent_id = fields.parent_id;
        else if (fields.project) { resolved.parent_id = resolveParent(fields); [rows, edit] = cow(TASKS_KEY); }   // re-read: a project it creates is a write this one must not overwrite
        delete fields.project;
        const row = edit(id);
        if (resolved.parent_id === row.parent_id) delete resolved.parent_id;   // unchanged (every composer save sends it): no cycle walk, no tree repair — future-guard: nothing observable reds without it
        else if ('parent_id' in resolved) {
          if (resolved.parent_id && descendantIds(rows, id).includes(resolved.parent_id)) return null;
          _treeDirty = true;
        }
        if (fields.areas !== undefined || fields.area_ids !== undefined) {
          resolved.area_ids = resolveAreas(fields);
          delete fields.areas;
        }
        if (fields.goal_ids !== undefined) { resolved.goal_ids = resolveGoals(fields); delete fields.goal_ids; }
        if ('blocked_by' in fields || 'relates' in fields) { const live = new Set(rows.map(r => r.id)); dropEdges(fields, x => !live.has(x)); }
        Object.assign(row, fields, resolved, { updated_at: nextTs(now(), row.updated_at) });
        // 'relates' is symmetric (Supabase setRelationType): partners in the new set gain id, the rest lose it
        if ('relates' in fields) {
          const rel = new Set(fields.relates ?? []);
          for (const { id: rid, relates } of rows) if (rid !== id && rel.has(rid) !== !!relates?.includes(id)) {
            const r = edit(rid);
            r.relates = rel.has(r.id) ? [...(r.relates ?? []), id] : r.relates.filter(x => x !== id); r.updated_at = nextTs(now(), r.updated_at);
          }
        }
        reopen(rows, edit, id); return writeTasks(rows) ? row : null;
      },
      async setChecklistItem(id, itemId, done) {
        const [rows, edit] = cow(TASKS_KEY), row = edit(id); if (!row) return false;
        const it = (row.checklist || []).find(c => c.id === itemId); if (!it) return false;
        row.checklist = row.checklist.map(c => c === it ? { ...c, done } : c); row.updated_at = nextTs(now(), row.updated_at);
        return writeTasks(rows) && row.updated_at;   // the write's stamp: the caller patches its row with it
      },
      async move(id, parentId, toIndex) {
        try {
          const [rows, edit] = cow(TASKS_KEY), t = edit(id);
          if (!t) return null;
          if (parentId && (parentId === id || descendantIds(rows, id).includes(parentId))) return null;
          if (parentId) {
            const parentDepth = projectDepth(rows, parentId);
            if (parentDepth + subtreeDepth(rows, id) > MAX_DEPTH) return null;
          }
          const oldParentId = t.parent_id;
          const ts = now();
          t.parent_id = parentId ?? null; t.position = toIndex; t.updated_at = nextTs(ts, t.updated_at); _treeDirty = true; reopen(rows, edit, id, ts);
          // Auto-complete old parent chain (ancestors whose remaining children are all done).
          if (oldParentId && oldParentId !== (parentId ?? null)) closeMovedOut(rows, edit, id, oldParentId, ts);
          return writeTasks(rows) ? t : null;
        } catch (e) { console.error('[store] move failed', e); return null; }
      },
      // id, [id, ...every row the caller journaled], or a list of those (a bulk delete, one write): each id's subtree AS STORED
      // goes, never a row the caller didn't list. A group whose id is gone is skipped, and the answer is false.
      async remove(id, targetId) {
        try {
          _treeDirty = true;
          const [rows, edit] = cow(TASKS_KEY), byId = new Map(rows.map(r => [r.id, r])), kidsOf = childIndex(rows), lists = Array.isArray(id?.[0]) ? id : [[id].flat()], groups = [], gone = new Set();
          for (const list of lists) {
            if (!byId.has(list[0])) continue;
            const listed = new Set(list), sub = descendantIds(rows, list[0], kidsOf), g = new Set(sub.filter(x => listed.has(x)));
            const kids = [...g].flatMap(x => kidsOf.get(x) || []).filter(x => !g.has(x));   // unlisted subtasks: moved to targetId, else nothing goes
            if (kids.length && (!byId.has(targetId) || sub.includes(targetId))) return false;
            for (const k of kids) { const r = edit(k); r.parent_id = targetId; r.updated_at = nextTs(now(), r.updated_at); reopen(rows, edit, k); }   // an open one reopens a done target (pg twin: reopen_ancestors)
            groups.push([list[0], g]); for (const x of g) gone.add(x);
          }
          if (!groups.length) return false;
          const ts = now();
          for (const r of rows) if (!gone.has(r.id)) dropEdges(r, x => gone.has(x), edit);
          for (const a of removedOutParents(rows, groups, ts, readMeta().default_project_id)) { const r = edit(a); r.completed_at = ts; r.updated_at = nextTs(ts, r.updated_at); }   // same rule as move-out
          const remaining = rows.filter(r => !gone.has(r.id));   // after the edits: edit() finds rows in `rows`
          if (!writeTasks(remaining)) return false;
          const meta = readMeta();
          if (targetId && groups.some(([root]) => root === meta.default_project_id)) { meta.default_project_id = targetId; writeMeta(meta); }
          // Parity with the DB (schedule_items.task_id, reminders.ref_id ON DELETE CASCADE, pg_mail/schema.js:299,349): a
          // removed task takes its block attachments and reminders with it — after the tasks write, so a failed delete keeps
          // them. Schedule items key on the tasks that remain, not `gone`, so an orphan an earlier failed write left goes too.
          const live = new Set(remaining.map(r => r.id)), si = view(SCHEDULE_ITEMS_KEY), rem = view(REMINDERS_KEY);
          if (si.some(x => !live.has(x.task_id))) writeScheduleItems(si.filter(x => live.has(x.task_id)));
          if (rem.some(x => gone.has(x.ref_id))) writeReminders(rem.filter(x => !gone.has(x.ref_id)));   // only the deleted tasks' rows: a reminder of an already-missing task may be a Bin entry's only copy
          return groups.length === lists.length;
        } catch (e) { console.error('[store] remove failed', e); return false; }
      },
      async setCompleted(id, done) {
        const [rows, edit] = cow(TASKS_KEY), ts = now();
        const target = rows.find(r => r.id === id); if (!target) return false;
        if (done && inNotes(target)) return true;   // a note is reference, never done: every completing path lands here
        const patches = done ? completionPatches(rows, id, ts, readMeta().default_project_id, placedMap(view(SCHEDULE_ITEMS_KEY))) : new Map([[id, { completed_at: null }]]);
        for (const [x, patch] of patches) { const r = edit(x); Object.assign(r, patch); r.updated_at = nextTs(ts, r.updated_at); }
        if (!done) reopen(rows, edit, id, ts);
        return writeTasks(rows);
      },
      // Archive: a task that can't be completed anymore. Non-destructive — pauses recurrence (never destroys the rule).
      // Excluded from sweeps/parent-walks (see pendingSweep/parentsToComplete). ids: one id, or a cascade's set — one write, one instant.
      async setArchived(ids, val) {
        const [rows, edit] = cow(TASKS_KEY), ts = now(), asked = [ids].flat(), byId = new Map(rows.map(r => [r.id, r])), root = byId.get(asked[0]);
        if (!asked.every(id => byId.has(id))) return false;
        // as the stored rows stand, not another tab's view: a root another tab archived since keeps its instant, as signed in
        const list = asked.filter(id => id === asked[0] ? !val || !root.archived_at : cascades(root, byId.get(id), val));
        for (const id of list) {
          const t = edit(id);
          t.archived_at = val ? ts : null; t.updated_at = nextTs(ts, t.updated_at);
          if (val && recActive(t.recurrence)) t.recurrence = pauseRecurrence(t.recurrence);   // pause, never destroy
        }
        for (const id of list) reopen(rows, edit, id, ts);
        return writeTasks(rows) && list;   // the ids written: the caller's undo takes back only those
      },
      async link(id, otherId, type) {
        if (id === otherId) return false;
        const [rows, edit] = cow(TASKS_KEY), ts = now(), a = edit(id), b = edit(otherId);
        if (!a || !b) return false;
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (!(a[key] ?? []).includes(otherId)) { a[key] = [...a[key] ?? [], otherId]; a.updated_at = nextTs(ts, a.updated_at); }
        if (key === 'relates' && !(b.relates ?? []).includes(id)) { b.relates = [...b.relates ?? [], id]; b.updated_at = nextTs(ts, b.updated_at); }
        return writeTasks(rows);
      },
      async unlink(id, otherId, type) {
        const [rows, edit] = cow(TASKS_KEY), ts = now(), a = edit(id), b = edit(otherId);
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (a) { a[key] = (a[key] ?? []).filter(x => x !== otherId); a.updated_at = nextTs(ts, a.updated_at); }
        if (key === 'relates' && b) { b.relates = (b.relates ?? []).filter(x => x !== id); b.updated_at = nextTs(ts, b.updated_at); }
        return writeTasks(rows);
      },
    },

    areas: {
      async list() {
        return readAreas().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      },
      async create({ name, color }) {
        const areas = readAreas();
        const nm = (name ?? '').trim();
        const existing = areas.find(a => a.name === nm);   // reuse — no local equivalent of the DB unique index (areas_user_name_idx)
        if (existing) return existing;
        return addRow(AREAS_KEY, writeAreas, { name: nm, color: color ?? null, icon: null,
          position: areas.length ? Math.max(...areas.map(l => l.position)) + 1 : 0, favorite: false });
      },
      async update(id, fields) { return patchRow(AREAS_KEY, writeAreas, id, fields); },
      async reorder(orderedIds) { return reorderRows(AREAS_KEY, writeAreas, orderedIds); },
      async remove(id) { return removeAndScrub(AREAS_KEY, writeAreas, id, [[TASKS_KEY, writeTasks, 'area_ids'], [BLOCKS_KEY, writeBlocks, 'areas']]); },
    },

    locations: {
      async list() { return readLocations().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async add({ name, icon = null, color = null, region = 'Home' }) {
        return addRow(LOCATIONS_KEY, writeLocations, { ...locationRow(name || 'Location', region, readLocations().length), icon, color });
      },
      async update(id, fields) { return patchRow(LOCATIONS_KEY, writeLocations, id, fields); },
      async remove(id) {
        if (!dropRow(LOCATIONS_KEY, writeLocations, id)) return false;   // the row first: a failed scrub leaves a dangling id, never a lost one
        scrubRows(BLOCKS_KEY, writeBlocks, b => b.location_id === id, b => ({ ...b, location_id: null }));   // orphaned blocks become free
        for (const [k, write] of [[TASKS_KEY, writeTasks], [EVENTS_KEY, writeEvents]])   // parity with delete_location.sql: tasks and events lose it
          scrubRows(k, write, r => r.location?.ids?.includes(id), r => ({ ...r, location: { ...r.location, ids: r.location.ids.filter(x => x !== id) } }));
        return true;
      },
      async reorder(ids) { return reorderRows(LOCATIONS_KEY, writeLocations, ids); },
    },

    homeLocationId() { return readMeta().home_location_id ?? null; },   // user's designated "home" place ("at home" NLP)
    setHomeLocation(id) { const m = readMeta(); m.home_location_id = m.home_location_id === id ? null : id; return writeMeta(m); },
    currentRegion() { return readMeta().current_region ?? 'Home'; },
    theme() { return readMeta().theme ?? null; },
    setTheme(theme) { return writeMeta({ ...readMeta(), theme }); },

  };
}
