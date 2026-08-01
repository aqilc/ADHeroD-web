import { isoDate } from './nlp.js';
import { makeFuzzy, buildSearchDocs, rankDocs, defaultDocs, matchQuery } from './search.js';
import { nextTs } from './recovery.js';

// Store framework: swap adapters to change backend (LocalStore now, Postgres later).
// Interface: requiresAuth; tasks.{list,create,update,remove,reorder,move,link,unlink,setCompleted}; areas.*

// Max nesting depth (root = 1; Backlog counts as a level). Shared by store guards + app.js drag guards.
export const MAX_DEPTH = 4;
// Canonical task record — single source of truth. Used by seed/create/normalize AND tests.
export const baseTask = () => {
  const ts = new Date().toISOString();
  return {
    id: crypto.randomUUID(), content: '', notes: null, importance: 'none', due_at: null, available_from: null, deadline_at: null,
    scheduled_at: null, est_minutes: null, parent_id: null, area_ids: [], goal_ids: [], color: null, favorite: false, place: null,
    location: { mode: 'any', ids: [] }, milestone: false,
    position: 0, completed_at: null, archived_at: null, blocked_by: [], relates: [], sidebar: false, checklist: [], checklist_plain: false,
    recurrence: null, completions: [], created_at: ts, updated_at: ts,
  };
};
function children(rows, id) { return rows.filter(r => r.parent_id === id); }
// Depth of the subtree rooted at id (id alone = 1). Cycle-safe.
export function subtreeDepth(rows, id, seen = new Set()) {
  if (seen.has(id)) return 1;
  seen.add(id);
  let max = 1;
  for (const child of rows.filter(r => r.parent_id === id)) max = Math.max(max, 1 + subtreeDepth(rows, child.id, seen));
  return max;
}

// [id, ...all descendant ids]. Cycle-safe.
export function descendantIds(projects, id) {
  const result = [id], seen = new Set([id]);
  for (let i = 0; i < result.length; i++) {
    for (const p of projects) {
      if (p.parent_id === result[i] && !seen.has(p.id)) { seen.add(p.id); result.push(p.id); }
    }
  }
  return result;
}

// Depth in the tree (root = 1). Cycle-safe.
export function projectDepth(projects, id) {
  let depth = 1, cur = projects.find(p => p.id === id);
  const seen = new Set();
  while (cur && cur.parent_id && !seen.has(cur.id)) { seen.add(cur.id); depth++; cur = projects.find(p => p.id === cur.parent_id); }
  return depth;
}

// Own goal_ids ∪ every ancestor's goal_ids (goals ladder down the parent chain). Cycle-safe.
export function effectiveGoalIds(rows, id, byId = new Map(rows.map(t => [t.id, t]))) {
  const out = new Set(); let cur = byId.get(id); const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); for (const gid of (cur.goal_ids || [])) out.add(gid); cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
  return [...out];
}

// planner: not yet wired
// Hard deadline a task is bound by: its own if set, else the nearest ancestor's (own-or-inherit, NO min()).
export function effectiveDeadline(rows, id, byId = new Map(rows.map(t => [t.id, t]))) {
  let cur = byId.get(id); const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); if (cur.deadline_at) return cur.deadline_at; cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
  return null;
}

export function isBlocked(rows, id) {
  const t = rows.find(r => r.id === id);
  return !!t && (t.blocked_by || []).some(bid => { const b = rows.find(r => r.id === bid); return b && !b.completed_at && !b.archived_at; });   // archived blocker (can't be completed) no longer blocks
}
// Incomplete descendants + incomplete blockers that a completion of `id` would sweep (archived rows excluded — never force-completed).
export function pendingSweep(rows, id) {
  const t = rows.find(r => r.id === id); if (!t) return [];
  const descs = descendantIds(rows, id).slice(1);
  const blockers = (t.blocked_by || []);
  return [...new Set([...descs, ...blockers])].filter(x => { const r = rows.find(r => r.id === x); return r && !r.completed_at && !r.archived_at; });
}
export function ancestorIds(rows, id) {
  const out = [], seen = new Set([id]); let cur = rows.find(r => r.id === id);
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) { seen.add(cur.parent_id); out.push(cur.parent_id); cur = rows.find(r => r.id === cur.parent_id); }
  return out;
}
// Parent ids (bottom-up) to auto-complete after id is marked done — stops when a sibling is still open.
export function parentsToComplete(rows, id) {
  const out = [], marked = new Set(); let cur = rows.find(r => r.id === id);
  while (cur?.parent_id) {
    const parent = rows.find(r => r.id === cur.parent_id); if (!parent) break;
    const kids = rows.filter(r => r.parent_id === parent.id);
    // archived children count as satisfied (like completed) so a parent can close when its remaining work is done/abandoned.
    if (kids.length && kids.every(k => k.completed_at || k.archived_at || marked.has(k.id))) { if (!parent.completed_at && !parent.archived_at) { out.push(parent.id); marked.add(parent.id); } cur = parent; }
    else break;
  }
  return out;
}
// Which old-parent-chain ids should auto-complete after `id` moves out from `oldParentId`:
// view `id` as if still under oldParent AND done, then ask which ancestors would close. Pure; both stores apply the result.
export function movedOutParents(rows, id, oldParentId, ts) {
  const tempRows = rows.map(r => r.id === id ? { ...r, parent_id: oldParentId, completed_at: ts } : r);
  return parentsToComplete(tempRows, id);
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

// Advance a UTC-midnight date by one step of the recurrence rule. Shared by nextOccurrence + calendar.js.
export const recurStep = (r, d) => {
  if (r.freq === 'day') return addDays(d, r.interval);
  if (r.freq === 'week') {
    if (r.weekdays?.length) { let x = addDays(d, 1); while (!r.weekdays.includes(x.getUTCDay())) x = addDays(x, 1); return x; }
    return addDays(d, r.interval * 7);
  }
  if (r.freq === 'month') {
    // month_day: clamp to month-end ("31st" → Feb 28/29 etc.).
    if (r.month_day != null) return monthDayStep(d, r.month_day, 1);
    return addMonths(d, r.interval);
  }
  return addMonths(d, r.interval * 12);   // year
};
// month_day also matches on month-end when it overshoots.
export const recurMatches = (r, d) => r.freq === 'week' && r.weekdays?.length ? r.weekdays.includes(d.getUTCDay())
  : r.freq === 'month' && r.month_day != null
    ? d.getUTCDate() === Math.min(r.month_day, _daysInMonth(d.getUTCFullYear(), d.getUTCMonth())) : true;

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
// Build activity context — walks the parent chain for goal_ids (effectiveGoalIds). byId optional for batch efficiency.
export function buildCtx(t, rows, byId) {
  const bid = byId || (rows?.length ? new Map(rows.map(x => [x.id, x])) : null);
  return { project_id: t.parent_id ?? null, area_ids: t.area_ids ?? [], place: t.place ?? null, importance: t.importance ?? 'none', est_minutes: t.est_minutes ?? null, goal_ids: bid ? effectiveGoalIds(rows, t.id, bid) : (t.goal_ids ?? []), milestone: t.milestone ?? false };
}
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
export function buildFreeText(uf, idx, tasks) {
  return (term, scope) => {
    const [idxs] = uf.search(idx.haystack, term, 1, 1e4);
    const ids = new Set((idxs || []).map(i => idx.meta[i].id));
    if (!scope) return ids;
    return new Set([...ids].filter(id => { const t = tasks.find(x => x.id === id); if (!t) return false; return ((scope === 'notes' ? t.notes : t.content) || '').toLowerCase().includes(term); }));
  };
}
// Prepend id to a recent list, dedup, cap at 12.
export const updateRecent = (id, recent) => [id, ...(recent || []).filter(x => x !== id)].slice(0, 12);
// Compute recurrence advance patch for a completed occurrence (non-mutating; returns {recurrence,due_at,completed_at}).
export function advanceRecurrence(target, ts) {
  const wasArray = Array.isArray(target.recurrence);
  const rules = recRules(target.recurrence).map(r => ({ ...r }));
  const anchor = target.due_at || isoDate(new Date(ts));
  const src = rules.find(r => r.gen_due && !r.paused) || rules.find(r => !r.paused);
  src.done_count = (src.done_count ?? 0) + 1;
  const srcNext = nextOccurrence(src, anchor, ts);
  if ((src.ends?.count != null && src.done_count >= src.ends.count) || (src.ends?.date && srcNext > src.ends.date)) src.paused = true;
  rules.forEach(r => delete r.gen_due);
  const rec = wasArray ? rules : rules[0];
  const best = nextAcrossRules(rec, anchor, ts);
  let completed_at = null, due_at = target.due_at;
  if (!best) completed_at = ts;
  else { best.rule.gen_due = true; due_at = best.iso + (best.rule.at ? 'T' + best.rule.at : (target.due_at?.length > 10 ? target.due_at.slice(10) : '')); }
  return { recurrence: rec, due_at, completed_at };
}
// Pause all rules in a recurrence (non-mutating).
export const pauseRecurrence = rec => Array.isArray(rec) ? rec.map(x => ({ ...x, paused: true })) : { ...rec, paused: true };
// Seed initial due_at for a new recurring task (mutates rec's rule to mark gen_due). Returns due_at string or null.
export function seedRecurrenceDue(rec, ts) {
  const b = nextAcrossRules(rec, isoDate(new Date(ts)), ts, { inclusive: true });
  if (!b) return null;
  b.rule.gen_due = true;
  return b.iso + (b.rule.at ? 'T' + b.rule.at : '');
}
// Auto-complete moved-out parents — callback-parameterized for LocalStore (sync) and SupabaseStore (async).
// markCompleted(p, ts): set completed state. onActivity(type, p): log the event.
export async function sweepMovedOut(toComplete, lookupRows, ts, markCompleted, onActivity) {
  for (const pid of toComplete) {
    const p = lookupRows.find(r => r.id === pid);
    if (p && !p.completed_at) { await markCompleted(p, ts); if (p.sidebar !== true) await onActivity('complete', p); }
  }
}

export function createLocalStore(opts = {}) {
  const storage = opts.storage || globalThis.localStorage;
  const TASKS_KEY = opts.key || 'adherod.tasks';
  const AREAS_KEY = 'adherod.areas';
  const META_KEY = 'adherod.meta';
  const FILTERS_KEY = 'adherod.filters';
  const uuid = opts.uuid || (() => crypto.randomUUID());
  const now = opts.now || (() => new Date().toISOString());

  const readKey = k => JSON.parse(storage.getItem(k) || (k === META_KEY ? '{}' : '[]'));
  const writeKey = (k, v) => storage.setItem(k, JSON.stringify(v));
  const patchRow = (read, write, id, fields) => { const rows = read(), r = rows.find(x => x.id === id); if (!r) return null; Object.assign(r, fields, { updated_at: now() }); write(rows); return r; };
  const dropRow = (read, write, id) => { write(read().filter(r => r.id !== id)); return true; };

  const readTasks = () => readKey(TASKS_KEY);
  const writeTasks = v => { writeKey(TASKS_KEY, v); reindex(); };
  const readAreas = () => readKey(AREAS_KEY);
  const writeAreas = v => { writeKey(AREAS_KEY, v); reindex(); };
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
  const ACTIVITY_KEY = 'adherod.activity';
  const readActivity = () => readKey(ACTIVITY_KEY);
  const writeActivity = v => writeKey(ACTIVITY_KEY, v);   // no reindex
  const GOALS_KEY = 'adherod.goals';
  const readGoals = () => readKey(GOALS_KEY);
  const writeGoals = v => writeKey(GOALS_KEY, v);   // no reindex
  const mkGoal = f => { const ts = now(); return { id: uuid(), name: f.name || 'Goal', identity: f.identity ?? null, identity_id: f.identity_id ?? null, cue: f.cue ?? null, log_default: f.log_default ?? null, color: f.color ?? null, icon: f.icon ?? null, targets: f.targets ?? [], target_date: f.target_date ?? null, cadence: f.cadence ?? null, favorite: f.favorite ?? false, archived: f.archived ?? false, position: f.position ?? 0, sustained_at: f.sustained_at ?? null, sustain_snoozed_until: f.sustain_snoozed_until ?? null, shape: f.shape ?? 'process', shelved_at: f.shelved_at ?? null, finished_at: f.finished_at ?? null, created_at: ts, updated_at: ts }; };
  const IDENTITIES_KEY = 'adherod.identities';
  const readIdentities = () => readKey(IDENTITIES_KEY);
  const writeIdentities = v => writeKey(IDENTITIES_KEY, v);
  const mkIdentity = f => { const ts = now(); return { id: uuid(), statement: (f.statement || '').trim(), position: f.position ?? 0, created_at: ts, updated_at: ts }; };
  const LOCATIONS_KEY = 'adherod.locations';
  const TRAVEL_KEY = 'adherod.travel';
  const readLocations = () => readKey(LOCATIONS_KEY);
  const writeLocations = v => writeKey(LOCATIONS_KEY, v);   // no reindex
  const mkLocation = (name, region = 'Home', position = 0) => { const ts = now(); return { id: uuid(), name, icon: null, color: null, region, position, created_at: ts, updated_at: ts }; };
  const readTravel = () => JSON.parse(storage.getItem(TRAVEL_KEY) || '{}');
  const writeTravel = v => writeKey(TRAVEL_KEY, v);
  function pushActivity(type, task) {
    if (!task) return;
    const log = readActivity();
    log.push({ id: uuid(), type, ts: now(), subject_type: 'task', subject_id: task.id, ctx: buildCtx(task, readTasks()), void: false });
    writeActivity(log);
  }

  const uf = makeFuzzy();
  let _search = { haystack: [], meta: [] };
  let _treeDirty = true;   // repairTree() only runs on list() after a parent_id-touching mutation (move/reparent/remove)
  function reindex() { _search = buildSearchDocs(readTasks(), readAreas(), readMeta().default_project_id || null); }

  // --- seed: ensure a default root project ("Backlog") exists ---
  function ensureBacklog() {
    const tasks = readTasks();
    const meta = readMeta();
    if (meta.default_project_id && tasks.some(t => t.id === meta.default_project_id)) return;
    const root = tasks.find(t => t.parent_id === null);
    if (root) { meta.default_project_id = root.id; writeMeta(meta); return; }   // adopt existing root as default
    const ts = now();
    const backlog = { ...baseTask(), id: uuid(), content: 'Backlog', created_at: ts, updated_at: ts };
    writeTasks([...tasks, backlog]);
    meta.default_project_id = backlog.id; writeMeta(meta);
  }

  // --- initialization ---
  function normalize() {
    const ts = now();
    const fill = (rows, defaults) => {
      let changed = false;
      for (const r of rows) for (const k in defaults) if (r[k] === undefined) { r[k] = defaults[k]; changed = true; }
      return changed;
    };
    const tasks = readTasks(), areas = readAreas();
    const def = readMeta().default_project_id;
    const { id: _id, created_at: _c, updated_at: _u, ...taskDefaults } = baseTask();
    const filled = fill(tasks, { ...taskDefaults, parent_id: def, created_at: ts, updated_at: ts });
    const repaired = repairTree(tasks, def);
    if (filled || repaired) writeTasks(tasks);
    if (fill(areas, { color: null, icon: null, position: 0, favorite: false, created_at: ts, updated_at: ts })) writeAreas(areas);
    const goals = readGoals();
    if (fill(goals, { identity: null, identity_id: null, cue: null, log_default: null, color: null, icon: null, targets: [], target_date: null, favorite: false, archived: false, position: 0, sustained_at: null, sustain_snoozed_until: null, shape: 'process', shelved_at: null, finished_at: null, created_at: ts, updated_at: ts })) writeGoals(goals);
  }

  // Repair broken parent links (self-parent, dangling, cycles).
  function repairTree(tasks, def) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    let changed = false;
    for (const t of tasks) {
      if (t.parent_id === t.id) { t.parent_id = null; changed = true; }                              // self → root
      else if (t.parent_id && !byId.has(t.parent_id)) { t.parent_id = t.id === def ? null : def; changed = true; }  // dangling → backlog
    }
    for (const t of tasks) {                                                                          // cut any remaining cycle
      const seen = new Set(); let cur = t;
      while (cur && cur.parent_id) {
        if (seen.has(cur.id)) { cur.parent_id = null; changed = true; break; }
        seen.add(cur.id); cur = byId.get(cur.parent_id);
      }
    }
    return changed;
  }

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

  // Seed Home location + travel once.
  {
    const meta = readMeta();
    if (!meta.home_seeded) {
      if (readLocations().length === 0) {
        const home = mkLocation('Home');
        writeLocations([home]);
        meta.current_location_id = meta.current_location_id || home.id;
      }
      meta.current_region = meta.current_region || 'Home';
      meta.default_travel_min = meta.default_travel_min ?? 20;
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
      let t = tasks.find(x => x.parent_id === null && x.content === fields.project);
      if (!t) {
        const pos = tasks.length ? Math.min(...tasks.map(x => x.position ?? 0)) - 1 : 0;
        t = { id: uuid(), content: fields.project, notes: null, due_at: null, deadline_at: null,
          est_minutes: null, parent_id: null, area_ids: [], color: null, favorite: false, place: null,
          position: pos, completed_at: null, blocked_by: [], relates: [], sidebar: true, created_at: ts, updated_at: ts };
        tasks.push(t);
        writeTasks(tasks);
      }
      return t.id;
    }
    return readMeta().default_project_id;
  }

  function resolveAreas(fields) {
    const { ids, names } = resolveAreaNames(fields);
    if (ids) return ids;
    if (!names.length) return [];
    const areas = readAreas(); const ts = now();
    const result = names.map(nm => {   // trim so "Work " reuses "Work" (mirrors the DB unique index) — done by resolveAreaNames
      let l = areas.find(x => x.name === nm);
      if (!l) { const pos = areas.length ? Math.max(...areas.map(x => x.position)) + 1 : 0; l = { id: uuid(), name: nm, color: null, position: pos, favorite: false, created_at: ts, updated_at: ts }; areas.push(l); }
      return l.id;
    });
    writeAreas(areas); return result;
  }

  function resolveGoals(fields) { return Array.isArray(fields.goal_ids) ? fields.goal_ids : []; }

  return {
    requiresAuth: false,
    subscribe() {}, unsubscribe() {},   // no realtime for local storage; keeps onAuth store-swap symmetric

    // parity with SupabaseStore.bootstrap — one call, whole account
    async bootstrap() {
      return {
        tasks: await this.tasks.list(), areas: await this.areas.list(), goals: await this.goals.list(),
        filters: await this.filters.list(), locations: await this.locations.list(), travel: await this.travel.list(),
        events: await this.events.list(), blocks: await this.blocks.list(),
      };
    },

    // Trash restore: re-insert previously-deleted rows (dedup by id, order-preserving). Powers "Recently deleted".
    reinsert(kind, rows) {
      const rw = { task: [readTasks, writeTasks], area: [readAreas, writeAreas], goal: [readGoals, writeGoals],
        event: [readEvents, writeEvents], block: [readBlocks, writeBlocks], filter: [readFilters, writeFilters], location: [readLocations, writeLocations] }[kind];
      if (!rw || !rows?.length) return false;
      const [read, write] = rw, cur = read(), have = new Set(cur.map(r => r.id));
      write([...cur, ...rows.filter(r => !have.has(r.id))]);
      return true;
    },

    defaultProject() { return readMeta().default_project_id || null; },
    search(query, limit = 50) { return searchDocs(query, limit, uf, _search, readMeta().recent || []); },
    recordSearchPick(id) { const meta = readMeta(); meta.recent = updateRecent(id, meta.recent); writeMeta(meta); },
    setDefaultProject(id) { const meta = readMeta(); meta.default_project_id = id; writeMeta(meta); reindex(); },
    runFilter(query, limit = 200) {
      const tasks = readTasks(), areas = readAreas(), def = readMeta().default_project_id || null;
      return matchQuery(query, tasks, { now: now(), areas, defaultProjectId: def, freeText: buildFreeText(uf, _search, tasks) }).slice(0, limit);
    },

    activity: {
      async list() { return readActivity(); },
      async note(goalId, text) { const log = readActivity(); const row = { id: uuid(), type: 'note', ts: now(), subject_type: 'goal', subject_id: goalId, text: text || '', void: false }; log.push(row); writeActivity(log); return row; },
      async showUp(goalId, ts, note) { if (!goalId) return null; const log = readActivity(); const row = { id: uuid(), type: 'show_up', ts: ts ?? now(), subject_type: 'goal', subject_id: goalId, void: false }; if (note) row.text = note; log.push(row); writeActivity(log); return row; },
      async graduate(goalId, ts) { if (!goalId) return null; const log = readActivity(); const row = { id: uuid(), type: 'graduate', ts: ts ?? now(), subject_type: 'goal', subject_id: goalId, void: false }; log.push(row); writeActivity(log); return row; },
      async release(goalId, ts) { if (!goalId) return null; const log = readActivity(); const row = { id: uuid(), type: 'release', ts: ts ?? now(), subject_type: 'goal', subject_id: goalId, void: false }; log.push(row); writeActivity(log); return row; },
      async finish(goalId, ts) { if (!goalId) return null; const log = readActivity(); const row = { id: uuid(), type: 'finish', ts: ts ?? now(), subject_type: 'goal', subject_id: goalId, void: false }; log.push(row); writeActivity(log); return row; },
      async shelve(goalId, ts) { if (!goalId) return null; const log = readActivity(); const row = { id: uuid(), type: 'shelve', ts: ts ?? now(), subject_type: 'goal', subject_id: goalId, void: false }; log.push(row); writeActivity(log); return row; },
      async unshelve(goalId, ts) { if (!goalId) return null; const log = readActivity(); const row = { id: uuid(), type: 'unshelve', ts: ts ?? now(), subject_type: 'goal', subject_id: goalId, void: false }; log.push(row); writeActivity(log); return row; },
      async remove(id) { const log = readActivity().filter(a => a.id !== id); writeActivity(log); return true; },
    },

    filters: {
      async list() { return readFilters().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async add({ name, query, color }) {
        const ts = now();
        const f = { id: uuid(), name: name || 'Filter', query: query || '', color: color ?? null, position: readFilters().length, created_at: ts, updated_at: ts };
        writeFilters([...readFilters(), f]);
        return f;
      },
      async update(id, fields) { return patchRow(readFilters, writeFilters, id, fields); },
      async remove(id) { return dropRow(readFilters, writeFilters, id); },
      async reorder(ids) {
        const rows = readFilters();
        ids.forEach((id, i) => { const f = rows.find(x => x.id === id); if (f) f.position = i; });
        writeFilters(rows);
        return true;
      },
    },

    events: {
      async list() { return readEvents(); },
      async add(fields) {
        const ts = now();
        const e = {
          id: uuid(), title: fields.title || '', notes: fields.notes ?? null,
          starts_at: fields.starts_at, ends_at: fields.ends_at, all_day: fields.all_day ?? false,
          recurrence: fields.recurrence ?? null, location: fields.location ?? null, color: fields.color ?? null,
          source: 'local', external_id: null, created_at: ts, updated_at: ts,
        };
        writeEvents([...readEvents(), e]);
        return e;
      },
      async update(id, fields) { return patchRow(readEvents, writeEvents, id, fields); },
      async remove(id) { return dropRow(readEvents, writeEvents, id); },
    },

    blocks: {
      async list() { return readBlocks(); },
      async add(fields) {
        const ts = now();
        const b = {
          id: uuid(), title: fields.title || '', starts_at: fields.starts_at, ends_at: fields.ends_at,
          all_day: fields.all_day ?? false, recurrence: fields.recurrence ?? null,
          location_id: fields.location_id ?? null, areas: fields.areas ?? [],
          energy: fields.energy ?? null, availability: fields.availability ?? null,
          color: fields.color ?? null, source: 'local', created_at: ts, updated_at: ts,
        };
        writeBlocks([...readBlocks(), b]);
        return b;
      },
      async update(id, fields) { return patchRow(readBlocks, writeBlocks, id, fields); },
      async remove(id) { return dropRow(readBlocks, writeBlocks, id); },
    },

    scheduleItems: {
      async list() { return readScheduleItems(); },
      async add({ task_id, block_id, role, position }) {
        const ts = now();
        const item = { id: uuid(), task_id, block_id, role: role ?? 'during', position: position ?? 0, created_at: ts, updated_at: ts };
        writeScheduleItems([...readScheduleItems(), item]);
        return item;
      },
      async remove(id) { return dropRow(readScheduleItems, writeScheduleItems, id); },
      async setRole(id, role) { return patchRow(readScheduleItems, writeScheduleItems, id, { role }); },
    },

    tasks: {
      async list() {
        const tasks = readTasks(), def = readMeta().default_project_id || null;
        if (_treeDirty) { if (repairTree(tasks, def)) writeTasks(tasks); _treeDirty = false; }
        return tasks.sort((x, y) => (x.position ?? 0) - (y.position ?? 0) || y.created_at.localeCompare(x.created_at));
      },
      async create(fields) {
        try {
          const ts = now();
          const parent_id = resolveParent(fields);
          const area_ids = resolveAreas(fields);
          const goal_ids = resolveGoals(fields);
          if (parent_id) {
            const depth = projectDepth(readTasks(), parent_id);
            if (depth >= MAX_DEPTH) return null;
          }
          const rows = readTasks(); // read after resolveParent (may write a new root task)
          const recurrence = fields.recurrence ?? null;
          let due_at = fields.due_at || null;
          if (recurrence && !due_at) { const seeded = seedRecurrenceDue(recurrence, now()); if (seeded) due_at = seeded; }   // seeded due is rule-generated; a rule may carry its own time
          const row = {
            ...baseTask(),
            id: uuid(),
            content: fields.content,
            notes: fields.notes ?? null,
            importance: fields.importance ?? 'none',
            due_at,
            available_from: fields.available_from ?? null,
            deadline_at: fields.deadline_at || null,
            scheduled_at: fields.scheduled_at ?? null,
            est_minutes: fields.est_minutes || null,
            parent_id,
            area_ids,
            goal_ids,
            color: fields.color ?? null,
            favorite: fields.favorite ?? false,
            place: fields.place ?? null,
            location: fields.location ?? { mode: 'any', ids: [] },
            position: rows.length ? Math.min(...rows.map(r => r.position ?? 0)) - 1 : 0,
            sidebar: fields.sidebar ?? false,
            checklist: fields.checklist ?? [],
            checklist_plain: fields.checklist_plain ?? false,
            milestone: fields.milestone ?? false,
            recurrence,
            created_at: ts,
            updated_at: ts,
          };
          rows.push(row);
          writeTasks(rows);
          if (row.sidebar !== true) pushActivity('create', row);
          return row;
        } catch (e) { console.error('[store] create failed', e); return null; }
      },
      async reorder(orderedIds) {
        const rows = readTasks();
        orderedIds.forEach((id, i) => { const r = rows.find(x => x.id === id); if (r) r.position = i; });
        writeTasks(rows);
        return true;
      },
      async update(id, fields) {
        const rows = readTasks();
        const row = rows.find(r => r.id === id);
        if (!row) return null;
        const resolved = {};
        if (fields.project !== undefined || fields.parent_id !== undefined) {
          resolved.parent_id = resolveParent(fields);
          delete fields.project;
          _treeDirty = true;
        }
        if (fields.areas !== undefined || fields.area_ids !== undefined) {
          resolved.area_ids = resolveAreas(fields);
          delete fields.areas;
        }
        if (fields.goal_ids !== undefined) { resolved.goal_ids = resolveGoals(fields); delete fields.goal_ids; }
        const prevDue = row.due_at;
        Object.assign(row, fields, resolved, { updated_at: nextTs(now(), row.updated_at) });
        writeTasks(rows);
        if (fields.due_at !== undefined && prevDue && row.due_at && row.due_at.slice(0, 10) > prevDue.slice(0, 10)) pushActivity('postpone', row);
        return row;
      },
      async setChecklistItem(id, itemId, done) {
        const rows = readTasks();
        const row = rows.find(r => r.id === id); if (!row) return false;
        const it = (row.checklist || []).find(c => c.id === itemId); if (!it) return false;
        it.done = done; row.updated_at = nextTs(now(), row.updated_at);
        writeTasks(rows);
        return true;
      },
      async move(id, parentId, toIndex) {
        try {
          const rows = readTasks();
          const t = rows.find(x => x.id === id);
          if (!t) return null;
          if (parentId && (parentId === id || descendantIds(rows, id).includes(parentId))) return null;
          if (parentId) {
            const parentDepth = projectDepth(rows, parentId);
            if (parentDepth + subtreeDepth(rows, id) > MAX_DEPTH) return null;
          }
          const oldParentId = t.parent_id;
          const ts = now();
          t.parent_id = parentId ?? null; t.position = toIndex; t.updated_at = nextTs(ts, t.updated_at); _treeDirty = true;
          // Auto-complete old parent chain (ancestors whose remaining children are all done).
          if (oldParentId && oldParentId !== (parentId ?? null)) {
            const toComplete = movedOutParents(rows, id, oldParentId, ts);   // same non-empty guard as remove(): no yield before writeTasks
            if (toComplete.length) await sweepMovedOut(toComplete, rows, ts,
              (p, t) => { p.completed_at = t; p.updated_at = nextTs(t, p.updated_at); }, pushActivity);
          }
          writeTasks(rows); return t;
        } catch (e) { console.error('[store] move failed', e); return null; }
      },
      async remove(id, targetId) {
        try {
          _treeDirty = true;
          const rows = readTasks();
          const task = rows.find(r => r.id === id); if (!task) return false;
          const oldParentId = task.parent_id;
          const kids = rows.filter(r => r.parent_id === id);
          if (kids.length) {
            if (!targetId || !rows.some(r => r.id === targetId)) return false;
            if (descendantIds(rows, id).includes(targetId)) return false;
            for (const k of kids) k.parent_id = targetId;
          }
          const ts = now();
          const meta = readMeta();
          if (meta.default_project_id === id && targetId) { meta.default_project_id = targetId; writeMeta(meta); }
          const remaining = rows.filter(r => r.id !== id);
          for (const r of remaining) {
            if (r.blocked_by?.includes(id)) r.blocked_by = r.blocked_by.filter(x => x !== id);
            if (r.relates?.includes(id)) r.relates = r.relates.filter(x => x !== id);
          }
          // Auto-complete old parent chain after id is removed (same rule as move-out).
          // Guard: only await when toComplete is non-empty — parallel remove() calls (e.g. convertToChecklist)
          // must not yield before writeTasks or each write overwrites the previous one.
          if (oldParentId) {
            const toComplete = movedOutParents(rows, id, oldParentId, ts);
            if (toComplete.length) await sweepMovedOut(toComplete, remaining, ts,
              (p, t) => { p.completed_at = t; p.updated_at = nextTs(t, p.updated_at); }, pushActivity);
          }
          writeTasks(remaining);
          return true;
        } catch (e) { console.error('[store] remove failed', e); return false; }
      },
      async setCompleted(id, done) {
        const rows = readTasks(); const ts = now();
        const voidComplete = sid => { const log = readActivity(); for (let i = log.length - 1; i >= 0; i--) if (log[i].subject_id === sid && log[i].type === 'complete' && !log[i].void) { log[i].void = true; writeActivity(log); break; } };
        const mark = (tid, val) => { const r = rows.find(x => x.id === tid); if (r) { const was = r.completed_at; r.completed_at = val; r.updated_at = nextTs(ts, r.updated_at); if (val && !was && r.sidebar !== true) pushActivity('complete', r); } };
        const target = rows.find(r => r.id === id); if (!target) return false;
        // Recurring: log + advance due_at unless every statement ends (all-paused falls through to permanent complete).
        if (done && recActive(target.recurrence) && !target.completed_at && !rows.some(r => r.parent_id === id)) {
          target.completions.push(ts); target.updated_at = nextTs(ts, target.updated_at);
          if (target.sidebar !== true) pushActivity('complete', target);
          Object.assign(target, advanceRecurrence(target, ts));
          writeTasks(rows); return true;
        }
        if (done) {
          for (const x of pendingSweep(rows, id)) {
            const r = rows.find(row => row.id === x);
            if (r?.recurrence && recActive(r.recurrence)) r.recurrence = pauseRecurrence(r.recurrence);   // permanent completion pauses (never destroys) the rule(s)
            mark(x, ts);
          }
          mark(id, ts);
          for (const pid of parentsToComplete(rows, id)) mark(pid, ts);
        } else {
          voidComplete(id);
          for (const a of ancestorIds(rows, id)) voidComplete(a);
          mark(id, null);
          for (const a of ancestorIds(rows, id)) mark(a, null);
        }
        writeTasks(rows);
        return true;
      },
      // Archive: a task that can't be completed anymore. Non-destructive — pauses recurrence (never destroys the rule),
      // logs archive/unarchive (guarded like complete). Excluded from sweeps/parent-walks (see pendingSweep/parentsToComplete).
      async setArchived(id, val) {
        const rows = readTasks(); const ts = now();
        const t = rows.find(r => r.id === id); if (!t) return false;
        const was = t.archived_at;
        t.archived_at = val ? ts : null; t.updated_at = nextTs(ts, t.updated_at);
        if (val && recActive(t.recurrence)) t.recurrence = pauseRecurrence(t.recurrence);   // pause, never destroy
        if (t.sidebar !== true && !!was !== !!val) pushActivity(val ? 'archive' : 'unarchive', t);
        writeTasks(rows);
        return true;
      },
      async link(id, otherId, type) {
        if (id === otherId) return false;
        const rows = readTasks(); const ts = now();
        const a = rows.find(r => r.id === id), b = rows.find(r => r.id === otherId);
        if (!a || !b) return false;
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (!a[key].includes(otherId)) { a[key].push(otherId); a.updated_at = nextTs(ts, a.updated_at); }
        if (key === 'relates' && !b.relates.includes(id)) { b.relates.push(id); b.updated_at = nextTs(ts, b.updated_at); }
        writeTasks(rows);
        return true;
      },
      async unlink(id, otherId, type) {
        const rows = readTasks(); const ts = now();
        const a = rows.find(r => r.id === id), b = rows.find(r => r.id === otherId);
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (a) { a[key] = a[key].filter(x => x !== otherId); a.updated_at = nextTs(ts, a.updated_at); }
        if (key === 'relates' && b) { b.relates = b.relates.filter(x => x !== id); b.updated_at = nextTs(ts, b.updated_at); }
        writeTasks(rows);
        return true;
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
        const ts = now();
        const pos = areas.length ? Math.max(...areas.map(l => l.position)) + 1 : 0;
        const area = { id: uuid(), name: nm, color: color ?? null, icon: null, position: pos, favorite: false, created_at: ts, updated_at: ts };
        areas.push(area);
        writeAreas(areas);
        return area;
      },
      async update(id, fields) {
        const areas = readAreas();
        const area = areas.find(x => x.id === id);
        if (!area) return null;
        Object.assign(area, fields, { updated_at: now() });
        writeAreas(areas);
        return area;
      },
      async reorder(orderedIds) {
        const areas = readAreas();
        orderedIds.forEach((id, i) => { const area = areas.find(x => x.id === id); if (area) area.position = i; });
        writeAreas(areas);
        return true;
      },
      async remove(id) {
        writeAreas(readAreas().filter(area => area.id !== id));
        const tasks = readTasks();
        for (const t of tasks) {
          if (t.area_ids) t.area_ids = t.area_ids.filter(aid => aid !== id);
        }
        writeTasks(tasks);
        return true;
      },
    },

    goals: {
      async list() { return readGoals().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async create(fields) { const goals = readGoals(); const pos = goals.length ? Math.max(...goals.map(g => g.position ?? 0)) + 1 : 0; const g = mkGoal({ ...fields, position: fields.position ?? pos }); goals.push(g); writeGoals(goals); return g; },
      async update(id, fields) { const goals = readGoals(); const g = goals.find(x => x.id === id); if (!g) return null; Object.assign(g, fields, { updated_at: now() }); writeGoals(goals); return g; },
      async reorder(orderedIds) { const goals = readGoals(); orderedIds.forEach((id, i) => { const g = goals.find(x => x.id === id); if (g) g.position = i; }); writeGoals(goals); return true; },
      async remove(id) { writeGoals(readGoals().filter(g => g.id !== id)); const tasks = readTasks(); for (const t of tasks) if (t.goal_ids) t.goal_ids = t.goal_ids.filter(gid => gid !== id); writeTasks(tasks); return true; },
    },

    identities: {
      async list() { return readIdentities().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async create(fields) { const all = readIdentities(); const pos = all.length ? Math.max(...all.map(i => i.position ?? 0)) + 1 : 0; const i = mkIdentity({ ...fields, position: fields.position ?? pos }); all.push(i); writeIdentities(all); return i; },
      async findOrCreate(statement) { const st = (statement || '').trim(); if (!st) return null; const all = readIdentities(); const hit = all.find(i => i.statement === st); if (hit) return hit; const pos = all.length ? Math.max(...all.map(i => i.position ?? 0)) + 1 : 0; const i = mkIdentity({ statement: st, position: pos }); all.push(i); writeIdentities(all); return i; },
      async update(id, fields) { const all = readIdentities(); const i = all.find(x => x.id === id); if (!i) return null; if ('statement' in fields) fields = { ...fields, statement: (fields.statement || '').trim() }; Object.assign(i, fields, { updated_at: now() }); writeIdentities(all); if ('statement' in fields) { const goals = readGoals(); let ch = false; for (const g of goals) if (g.identity_id === id) { g.identity = i.statement; ch = true; } if (ch) writeGoals(goals); } return i; },
      async remove(id) { writeIdentities(readIdentities().filter(i => i.id !== id)); const goals = readGoals(); let ch = false; for (const g of goals) if (g.identity_id === id) { g.identity_id = null; g.identity = null; ch = true; } if (ch) writeGoals(goals); return true; },
      async merge(fromId, toId) { if (!fromId || !toId || fromId === toId) return null; const toIdent = readIdentities().find(i => i.id === toId); const goals = readGoals(); let ch = false; for (const g of goals) if (g.identity_id === fromId) { g.identity_id = toId; if (toIdent) g.identity = toIdent.statement; ch = true; } if (ch) writeGoals(goals); writeIdentities(readIdentities().filter(i => i.id !== fromId)); return true; },
      async reorder(orderedIds) { const all = readIdentities(); orderedIds.forEach((id, i) => { const x = all.find(y => y.id === id); if (x) x.position = i; }); writeIdentities(all); return true; },
    },

    locations: {
      async list() { return readLocations().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async add({ name, icon = null, color = null, region = 'Home' }) {
        const rows = readLocations();
        const loc = Object.assign(mkLocation(name || 'Location', region, rows.length), { icon, color });
        writeLocations([...rows, loc]); return loc;
      },
      async update(id, fields) { return patchRow(readLocations, writeLocations, id, fields); },
      async remove(id) {
        writeLocations(readLocations().filter(l => l.id !== id));
        const blks = readBlocks(); let bch = false; for (const b of blks) if (b.location_id === id) { b.location_id = null; bch = true; } if (bch) writeBlocks(blks);   // orphaned blocks become free
        const tv = readTravel(); for (const k of Object.keys(tv)) if (k.split('>').includes(id)) delete tv[k]; writeTravel(tv);
        const tasks = readTasks(); let ch = false; for (const t of tasks) if (t.location?.ids?.includes(id)) { t.location.ids = t.location.ids.filter(x => x !== id); ch = true; } if (ch) writeTasks(tasks);
        const meta = readMeta(); if (meta.current_location_id === id) { meta.current_location_id = null; writeMeta(meta); }
        return true;
      },
      async reorder(ids) { const rows = readLocations(); ids.forEach((id, i) => { const l = rows.find(x => x.id === id); if (l) l.position = i; }); writeLocations(rows); return true; },
    },

    travel: {
      async set(from, to, minutes) { const tv = readTravel(); tv[from + '>' + to] = minutes; writeTravel(tv); return true; },
      async list() { return Object.entries(readTravel()).map(([k, minutes]) => { const [from, to] = k.split('>'); return { from, to, minutes }; }); },
      async remove(from, to) { const tv = readTravel(); delete tv[from + '>' + to]; writeTravel(tv); return true; },
    },
    defaultTravel() { return readMeta().default_travel_min ?? 20; },
    setDefaultTravel(min) { const m = readMeta(); m.default_travel_min = min; writeMeta(m); },
    currentLocationId() { return readMeta().current_location_id ?? null; },
    homeLocationId() { return readMeta().home_location_id ?? null; },   // user's designated "home" place ("at home" NLP)
    setHomeLocation(id) { const m = readMeta(); m.home_location_id = m.home_location_id === id ? null : id; writeMeta(m); },
    currentRegion() { return readMeta().current_region ?? 'Home'; },
    setCurrentLocation(id) {
      const m = readMeta();
      if (m.current_location_id !== id) { const log = readActivity(); log.push({ id: uuid(), type: 'location', ts: now(), subject_type: 'location', subject_id: id, ctx: { from: m.current_location_id ?? null }, void: false }); writeActivity(log); }
      m.current_location_id = id;
      writeMeta(m);
    },
    setCurrentRegion(name) {
      const m = readMeta();
      if (m.current_region !== name) { const log = readActivity(); log.push({ id: uuid(), type: 'region', ts: now(), subject_type: 'region', subject_id: name, ctx: { from: m.current_region ?? null }, void: false }); writeActivity(log); }
      m.current_region = name; writeMeta(m);
    },
  };
}
