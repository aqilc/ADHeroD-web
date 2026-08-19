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
    id: crypto.randomUUID(), content: '', notes: null, importance: 'none', recur_from: null, available_from: null, deadline_at: null,
    est_minutes: null, parent_id: null, area_ids: [], goal_ids: [], color: null, favorite: false, place: null, location: { mode: 'any', ids: [] }, milestone: false,
    position: 0, completed_at: null, archived_at: null, blocked_by: [], relates: [], sidebar: false, checklist: [], checklist_plain: false,
    recurrence: null, completions: [], created_at: ts, updated_at: ts,
    starts_at: null, ends_at: null, tz: null, claim: null, accepts: null,
  };
};
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
// Compute recurrence advance patch for a completed occurrence (non-mutating; returns {recurrence,recur_from,completed_at}).
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
  return { recurrence: rec, recur_from, completed_at };
}
// A placement is minted in a clock — stamp it (freeze §8 step 3) so day-boundary math survives travel. Explicit tz wins.
export const captureTz = f => { if ((f.starts_at || f.ends_at) && !f.tz) f.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; return f; };
// Pause all rules in a recurrence (non-mutating).
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
// Auto-complete moved-out parents — callback-parameterized for LocalStore (sync) and SupabaseStore (async).
export async function sweepMovedOut(toComplete, lookupRows, ts, markCompleted) {
  for (const pid of toComplete) {
    const p = lookupRows.find(r => r.id === pid);
    if (p && !p.completed_at) await markCompleted(p, ts);
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
  // Append a row: the caller supplies only the fields that make its namespace different — id and the two
  // timestamps are the same everywhere, so they live here (the cloud's collection().insert is the mirror).
  const addRow = (read, write, fields) => { const ts = now(), row = { id: uuid(), ...fields, created_at: ts, updated_at: ts }; write([...read(), row]); return row; };
  const patchRow = (read, write, id, fields) => { const rows = read(), r = rows.find(x => x.id === id); if (!r) return null; Object.assign(r, fields, { updated_at: now() }); write(rows); return r; };
  const dropRow = (read, write, id) => { write(read().filter(r => r.id !== id)); return true; };
  const reorderRows = (read, write, ids) => { const rows = read(); ids.forEach((id, i) => { const r = rows.find(x => x.id === id); if (r) r.position = i; }); write(rows); return true; };
  // Drop a row + scrub its id out of the tasks column that references it (parity with the DB's delete_area/delete_goal RPCs).
  const removeAndScrub = (read, write, id, key) => { dropRow(read, write, id); const tasks = readTasks(); for (const t of tasks) if (t[key]) t[key] = t[key].filter(x => x !== id); writeTasks(tasks); return true; };

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
  const BLOCK_DAYS_KEY = 'adherod.block_days';
  const readBlockDays = () => readKey(BLOCK_DAYS_KEY);
  const writeBlockDays = v => writeKey(BLOCK_DAYS_KEY, v);
  const GOALS_KEY = 'adherod.goals';
  const readGoals = () => readKey(GOALS_KEY);
  const writeGoals = v => writeKey(GOALS_KEY, v);   // no reindex
  const goalRow = f => ({ name: f.name || 'Goal', identity: f.identity ?? null, identity_id: f.identity_id ?? null, cue: f.cue ?? null, log_default: f.log_default ?? null, color: f.color ?? null, icon: f.icon ?? null, targets: f.targets ?? [], target_date: f.target_date ?? null, cadence: f.cadence ?? null, favorite: f.favorite ?? false, archived: f.archived ?? false, position: f.position ?? 0, sustained_at: f.sustained_at ?? null, sustain_snoozed_until: f.sustain_snoozed_until ?? null, shape: f.shape ?? 'process', shelved_at: f.shelved_at ?? null, finished_at: f.finished_at ?? null });

  const LOCATIONS_KEY = 'adherod.locations';
  const readLocations = () => readKey(LOCATIONS_KEY);
  const writeLocations = v => writeKey(LOCATIONS_KEY, v);   // no reindex
  const locationRow = (name, region = 'Home', position = 0) => ({ name, icon: null, color: null, region, position });
  const uf = makeFuzzy();
  let _search = { haystack: [], meta: [] }, _idxDirty = true;
  let _treeDirty = true;   // repairTree() only runs on list() after a parent_id-touching mutation (move/reparent/remove)
  function reindex() { _idxDirty = true; }   // U-18: lazy; built on first search/filter after mutation
  function ensureIdx() { if (_idxDirty) { _search = buildSearchDocs(readTasks(), readAreas(), readMeta().default_project_id || null); _idxDirty = false; } }

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
    const { name: _gn, ...goalDefaults } = goalRow({});   // defaults come from goalRow — a new goal field can't be missed here (cadence was)
    if (fill(goals, { ...goalDefaults, created_at: ts, updated_at: ts })) writeGoals(goals);
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
    // Notes is an ordinary root project whose NAME is the setting: everything under it reads as a note
    // (predicates.js inNotes). Seeded once — deletable, and re-creatable by name alone. Runs after
    // ensureBacklog so it can never be adopted as the default project.
    if (!meta.notes_seeded) {
      const tasks = readTasks();
      if (!tasks.some(t => t.parent_id === null && t.content === 'Notes')) {
        const ts = now();
        writeTasks([...tasks, { ...baseTask(), id: uuid(), content: 'Notes', sidebar: true, created_at: ts, updated_at: ts }]);
      }
      meta.notes_seeded = true; writeMeta(meta);
    }
  }

  // Seed Home location once (a block names a location by id; tasks use a location constraint object).
  {
    const meta = readMeta();
    if (!meta.home_seeded) {
      if (readLocations().length === 0) addRow(readLocations, writeLocations, locationRow('Home'));
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
        t = { id: uuid(), content: fields.project, notes: null, recur_from: null, deadline_at: null,
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
        filters: await this.filters.list(), locations: await this.locations.list(),
        events: await this.events.list(), blocks: await this.blocks.list(),
      };
    },

    // Trash restore: re-insert previously-deleted rows (dedup by id, order-preserving). Powers "Recently deleted".
    reinsert(kind, rows) {
      const rw = { task: [readTasks, writeTasks], area: [readAreas, writeAreas], goal: [readGoals, writeGoals],
        event: [readEvents, writeEvents], block: [readBlocks, writeBlocks], filter: [readFilters, writeFilters], location: [readLocations, writeLocations],
        scheduleItem: [readScheduleItems, writeScheduleItems], blockDay: [readBlockDays, writeBlockDays] }[kind];
      if (!rw || !rows?.length) return false;
      const [read, write] = rw, cur = read(), have = new Set(cur.map(r => r.id));
      write([...cur, ...rows.filter(r => !have.has(r.id))]);
      return true;
    },

    defaultProject() { return readMeta().default_project_id || null; },
    search(query, limit = 50) { ensureIdx(); return searchDocs(query, limit, uf, _search, readMeta().recent || []); },
    recordSearchPick(id) { const meta = readMeta(); meta.recent = updateRecent(id, meta.recent); writeMeta(meta); },
    setDefaultProject(id) { const meta = readMeta(); meta.default_project_id = id; writeMeta(meta); reindex(); },
    runFilter(query, limit = 200) {
      ensureIdx(); const tasks = readTasks(), areas = readAreas(), def = readMeta().default_project_id || null;
      return matchQuery(query, tasks, { now: now(), areas, defaultProjectId: def, placed: placedMap(readScheduleItems()), freeText: buildFreeText(uf, _search, tasks) }).slice(0, limit);
    },

    filters: {
      async list() { return readFilters().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async add({ name, query, color }) {
        return addRow(readFilters, writeFilters, { name: name || 'Filter', query: query || '', color: color ?? null, position: readFilters().length });
      },
      async update(id, fields) { return patchRow(readFilters, writeFilters, id, fields); },
      async remove(id) { return dropRow(readFilters, writeFilters, id); },
      async reorder(ids) { return reorderRows(readFilters, writeFilters, ids); },
    },

    events: {
      async list() { return readEvents(); },
      async add(fields) {
        return addRow(readEvents, writeEvents, {
          title: fields.title || '', notes: fields.notes ?? null,
          starts_at: fields.starts_at, ends_at: fields.ends_at, all_day: fields.all_day ?? false,
          recurrence: fields.recurrence ?? null, location: fields.location ?? null, color: fields.color ?? null,
          source: 'local', external_id: null,
        });
      },
      async update(id, fields) { return patchRow(readEvents, writeEvents, id, fields); },
      async remove(id) { return dropRow(readEvents, writeEvents, id); },
    },

    blocks: {
      async list() { return readBlocks(); },
      async add(fields) {
        return addRow(readBlocks, writeBlocks, {
          title: fields.title || '', starts_at: fields.starts_at, ends_at: fields.ends_at,
          all_day: fields.all_day ?? false, recurrence: fields.recurrence ?? null,
          location_id: fields.location_id ?? null, areas: fields.areas ?? [],
          energy: fields.energy ?? null, availability: fields.availability ?? null,
          color: fields.color ?? null, source: 'local', est_minutes: fields.est_minutes ?? null,
        });
      },
      async update(id, fields) { return patchRow(readBlocks, writeBlocks, id, fields); },
      // parity with the DB: schedule_items.block_id and block_days.block_id both cascade
      async remove(id) {
        writeScheduleItems(readScheduleItems().filter(x => x.block_id !== id));
        writeBlockDays(readBlockDays().filter(x => x.block_id !== id));
        return dropRow(readBlocks, writeBlocks, id);
      },
    },

    scheduleItems: {
      async list() { return readScheduleItems(); },
      async add({ task_id, block_id, role, position, date, start, duration_min }) {
        return addRow(readScheduleItems, writeScheduleItems, { task_id, block_id: block_id ?? null, role: role ?? 'during',
          position: position ?? 0, date: date ?? null, start: start ?? null, duration_min: duration_min ?? null });
      },
      async update(id, fields) { return patchRow(readScheduleItems, writeScheduleItems, id, fields); },
      async remove(id) { return dropRow(readScheduleItems, writeScheduleItems, id); },
      async setRole(id, role) { return patchRow(readScheduleItems, writeScheduleItems, id, { role }); },
    },

    blockDays: {
      async list() { return readBlockDays(); },
      async set({ block_id, date, status, actual_start, actual_end, ask_after, est_minutes }) {
        const ts = now(), rows = readBlockDays();
        const prev = rows.find(r => r.block_id === block_id && r.date === date);
        const next = { ...(prev || { id: uuid(), block_id, date, created_at: ts }),
          ...(status !== undefined && { status }), ...(actual_start !== undefined && { actual_start }),
          ...(actual_end !== undefined && { actual_end }), ...(ask_after !== undefined && { ask_after }),
          ...(est_minutes !== undefined && { est_minutes }), updated_at: ts };
        writeBlockDays(prev ? rows.map(r => (r === prev ? next : r)) : [...rows, next]);
        return next;
      },
      async remove(id) { return dropRow(readBlockDays, writeBlockDays, id); },
      async update(id, fields) { return patchRow(readBlockDays, writeBlockDays, id, fields); },
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
          captureTz(fields);
          const parent_id = resolveParent(fields);
          const area_ids = resolveAreas(fields);
          const goal_ids = resolveGoals(fields);
          if (parent_id) {
            const depth = projectDepth(readTasks(), parent_id);
            if (depth >= MAX_DEPTH) return null;
          }
          const rows = readTasks(); // read after resolveParent (may write a new root task)
          const recurrence = fields.recurrence ?? null;
          let recur_from = fields.recur_from || null;
          if (recurrence && !recur_from) { const seeded = seedRecurrenceDue(recurrence, now()); if (seeded) recur_from = seeded; }   // seeded due is rule-generated; a rule may carry its own time
          const row = {
            ...baseTask(),
            id: uuid(),
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
            position: rows.length ? Math.min(...rows.map(r => r.position ?? 0)) - 1 : 0,
            sidebar: fields.sidebar ?? false,
            checklist: fields.checklist ?? [],
            checklist_plain: fields.checklist_plain ?? false,
            milestone: fields.milestone ?? false,
            // substrate columns — Supabase create persists these via its post-insert update; parity demands the same here
            task_size: fields.task_size ?? null, anchor: fields.anchor ?? null, possible: fields.possible ?? null,
            starts_at: fields.starts_at ?? null, ends_at: fields.ends_at ?? null, tz: fields.tz ?? null,
            claim: fields.claim ?? null, accepts: fields.accepts ?? null,
            recurrence,
            created_at: ts,
            updated_at: ts,
          };
          rows.push(row);
          writeTasks(rows);
          return row;
        } catch (e) { console.error('[store] create failed', e); return null; }
      },
      async reorder(orderedIds) { return reorderRows(readTasks, writeTasks, orderedIds); },
      async update(id, fields) {
        captureTz(fields);
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
        const prevDue = row.recur_from;
        Object.assign(row, fields, resolved, { updated_at: nextTs(now(), row.updated_at) });
        writeTasks(rows);
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
              (p, t) => { p.completed_at = t; p.updated_at = nextTs(t, p.updated_at); });
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
          // Parity with the DB (schedule_items.task_id is ON DELETE CASCADE): a removed task takes its block
          // attachments with it. Without this the local store kept orphans that drew as phantom attachments.
          const si = readScheduleItems();
          if (si.some(x => x.task_id === id)) writeScheduleItems(si.filter(x => x.task_id !== id));
          // Auto-complete old parent chain after id is removed (same rule as move-out).
          // Guard: only await when toComplete is non-empty — parallel remove() calls (e.g. convertToChecklist)
          // must not yield before writeTasks or each write overwrites the previous one.
          if (oldParentId) {
            const toComplete = movedOutParents(rows, id, oldParentId, ts);
            if (toComplete.length) await sweepMovedOut(toComplete, remaining, ts,
              (p, t) => { p.completed_at = t; p.updated_at = nextTs(t, p.updated_at); });
          }
          writeTasks(remaining);
          return true;
        } catch (e) { console.error('[store] remove failed', e); return false; }
      },
      async setCompleted(id, done) {
        const rows = readTasks(); const ts = now();
        const mark = (tid, val) => { const r = rows.find(x => x.id === tid); if (r) { r.completed_at = val; r.updated_at = nextTs(ts, r.updated_at); } };
        const target = rows.find(r => r.id === id); if (!target) return false;
        // Recurring: advance recur_from unless every statement ends (all-paused falls through to permanent complete).
        if (done && recActive(target.recurrence) && !target.completed_at && !rows.some(r => r.parent_id === id)) {
          target.updated_at = nextTs(ts, target.updated_at);
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
        writeTasks(rows);
        return true;
      },
      async link(id, otherId, type) {
        if (id === otherId) return false;
        const rows = readTasks(); const ts = now();
        const a = rows.find(r => r.id === id), b = rows.find(r => r.id === otherId);
        if (!a || !b) return false;
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (!(a[key] ?? []).includes(otherId)) { (a[key] = a[key] ?? []).push(otherId); a.updated_at = nextTs(ts, a.updated_at); }
        if (key === 'relates' && !(b.relates ?? []).includes(id)) { (b.relates = b.relates ?? []).push(id); b.updated_at = nextTs(ts, b.updated_at); }
        writeTasks(rows);
        return true;
      },
      async unlink(id, otherId, type) {
        const rows = readTasks(); const ts = now();
        const a = rows.find(r => r.id === id), b = rows.find(r => r.id === otherId);
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (a) { a[key] = (a[key] ?? []).filter(x => x !== otherId); a.updated_at = nextTs(ts, a.updated_at); }
        if (key === 'relates' && b) { b.relates = (b.relates ?? []).filter(x => x !== id); b.updated_at = nextTs(ts, b.updated_at); }
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
        return addRow(readAreas, writeAreas, { name: nm, color: color ?? null, icon: null,
          position: areas.length ? Math.max(...areas.map(l => l.position)) + 1 : 0, favorite: false });
      },
      async update(id, fields) { return patchRow(readAreas, writeAreas, id, fields); },
      async reorder(orderedIds) { return reorderRows(readAreas, writeAreas, orderedIds); },
      async remove(id) { return removeAndScrub(readAreas, writeAreas, id, 'area_ids'); },
    },

    goals: {
      async list() { return readGoals().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async create(fields) { const goals = readGoals(); const pos = goals.length ? Math.max(...goals.map(g => g.position ?? 0)) + 1 : 0; return addRow(readGoals, writeGoals, goalRow({ ...fields, position: fields.position ?? pos })); },
      async update(id, fields) { return patchRow(readGoals, writeGoals, id, fields); },
      async reorder(orderedIds) { return reorderRows(readGoals, writeGoals, orderedIds); },
      async remove(id) { return removeAndScrub(readGoals, writeGoals, id, 'goal_ids'); },
    },

    locations: {
      async list() { return readLocations().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
      async add({ name, icon = null, color = null, region = 'Home' }) {
        return addRow(readLocations, writeLocations, { ...locationRow(name || 'Location', region, readLocations().length), icon, color });
      },
      async update(id, fields) { return patchRow(readLocations, writeLocations, id, fields); },
      async remove(id) {
        writeLocations(readLocations().filter(l => l.id !== id));
        const blks = readBlocks(); let bch = false; for (const b of blks) if (b.location_id === id) { b.location_id = null; bch = true; } if (bch) writeBlocks(blks);   // orphaned blocks become free
        const tasks = readTasks(); let tch = false; for (const t of tasks) if (t.location?.ids?.includes(id)) { t.location.ids = t.location.ids.filter(x => x !== id); tch = true; } if (tch) writeTasks(tasks);
        return true;
      },
      async reorder(ids) { return reorderRows(readLocations, writeLocations, ids); },
    },

    homeLocationId() { return readMeta().home_location_id ?? null; },   // user's designated "home" place ("at home" NLP)
    setHomeLocation(id) { const m = readMeta(); m.home_location_id = m.home_location_id === id ? null : id; writeMeta(m); },
    currentRegion() { return readMeta().current_region ?? 'Home'; },

  };
}
