import { isoDate } from './nlp.js';
import { makeFuzzy, buildSearchDocs, rankDocs, defaultDocs, matchQuery } from './search.js';

// Store framework: swap adapters to change backend (LocalStore now, Postgres later).
// Interface: requiresAuth; tasks.{list,create,update,remove,reorder,move,link,unlink,setCompleted}; areas.*

// Max nesting depth (root = 1; Backlog counts as a level). Shared by store guards + app.js drag guards.
export const MAX_DEPTH = 4;
// Canonical task record — single source of truth. Used by seed/create/normalize AND tests.
export const baseTask = () => {
  const ts = new Date().toISOString();
  return {
    id: crypto.randomUUID(), content: '', notes: null, priority: 4, due_at: null, available_from: null, deadline_at: null,
    scheduled_at: null, est_minutes: null, parent_id: null, area_ids: [], goal_ids: [], color: null, favorite: false, place: null,
    location: { mode: 'any', ids: [] }, milestone: false,
    position: 0, completed_at: null, archived_at: null, blocked_by: [], relates: [], sidebar: false, checklist: [], checklist_plain: false,
    recurrence: null, completions: [], created_at: ts, updated_at: ts,
  };
};
export function children(rows, id) { return rows.filter(r => r.parent_id === id); }
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

export function createLocalStore(opts = {}) {
  const storage = opts.storage || globalThis.localStorage;
  const TASKS_KEY = opts.key || 'adherod.tasks';
  const AREAS_KEY = 'adherod.areas';
  const LEGACY_AREAS_KEY = 'adherod.tags';   // pre-rebrand key (areas were "tags"); migrated on init
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
  const WINDOWS_KEY = 'adherod.windows';
  const TRAVEL_KEY = 'adherod.travel';
  const readLocations = () => readKey(LOCATIONS_KEY);
  const writeLocations = v => writeKey(LOCATIONS_KEY, v);   // no reindex
  const mkLocation = (name, region = 'Home', position = 0) => { const ts = now(); return { id: uuid(), name, icon: null, color: null, region, position, created_at: ts, updated_at: ts }; };
  const readWindows = () => readKey(WINDOWS_KEY);   // read-only: legacy presence windows, migrated into blocks
  const readTravel = () => JSON.parse(storage.getItem(TRAVEL_KEY) || '{}');
  const writeTravel = v => writeKey(TRAVEL_KEY, v);
  const mkCtx = (t, rows, byId) => ({ project_id: t.parent_id ?? null, area_ids: t.area_ids ?? [], place: t.place ?? null, priority: t.priority ?? 4, est_minutes: t.est_minutes ?? null, goal_ids: rows ? effectiveGoalIds(rows, t.id, byId) : (t.goal_ids ?? []), milestone: t.milestone ?? false });
  function pushActivity(type, task) {
    if (!task) return;
    const log = readActivity();
    log.push({ id: uuid(), type, ts: now(), subject_type: 'task', subject_id: task.id, ctx: mkCtx(task, readTasks()), void: false });
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

  // One-time: adherod.tags → adherod.areas (pre-rebrand).
  function migrateAreas() {
    if (storage.getItem(AREAS_KEY) == null && storage.getItem(LEGACY_AREAS_KEY) != null) {
      writeKey(AREAS_KEY, JSON.parse(storage.getItem(LEGACY_AREAS_KEY) || '[]'));
    }
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
    // tag_ids → area_ids (rebrand); preserve old caches.
    let migrated = false;
    for (const t of tasks) if (t.tag_ids !== undefined) { if (t.area_ids === undefined) t.area_ids = t.tag_ids; delete t.tag_ids; migrated = true; }
    const { id: _id, created_at: _c, updated_at: _u, ...taskDefaults } = baseTask();
    const filled = fill(tasks, { ...taskDefaults, parent_id: def, created_at: ts, updated_at: ts });
    const repaired = repairTree(tasks, def);
    if (filled || repaired || migrated) writeTasks(tasks);
    if (fill(areas, { color: null, icon: null, position: 0, favorite: false, created_at: ts, updated_at: ts })) writeAreas(areas);
    const goals = readGoals();
    let goalsChanged = fill(goals, { identity: null, identity_id: null, cue: null, log_default: null, color: null, icon: null, targets: [], target_date: null, favorite: false, archived: false, position: 0, sustained_at: null, sustain_snoozed_until: null, shape: 'process', shelved_at: null, finished_at: null, created_at: ts, updated_at: ts });
    // one-time: identity strings → entities (lossless, idempotent)
    const idents = readIdentities();
    const byStatement = new Map(idents.map(i => [i.statement, i]));
    let identsChanged = false, linksChanged = false;
    for (const g of goals) {
      const st = (g.identity || '').trim();
      if (!st || g.identity_id) continue;
      let ent = byStatement.get(st);
      if (!ent) { ent = mkIdentity({ statement: st, position: idents.length }); idents.push(ent); byStatement.set(st, ent); identsChanged = true; }
      g.identity_id = ent.id; linksChanged = true;
    }
    if (identsChanged) writeIdentities(idents);
    if (goalsChanged || linksChanged) writeGoals(goals);
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

  migrateAreas();
  ensureBacklog();
  normalize();
  reindex();

  // One-time (meta-flagged): rename Inbox→Backlog, seed default filters.
  {
    const meta = readMeta();
    if (!meta.default_filters_seeded) {
      const tasks = readTasks(), def = tasks.find(t => t.id === meta.default_project_id);
      if (def && def.content === 'Inbox') { def.content = 'Backlog'; writeTasks(tasks); }
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

  // one-time: synthesize completion history from legacy completed_at + recurring completions[]
  {
    const meta = readMeta();
    if (!meta.activity_backfilled) {
      if (readActivity().length === 0) {
        const log = [];
        const tasksList = readTasks();
        const byId = new Map(tasksList.map(t => [t.id, t]));   // build ONCE — mkCtx→effectiveGoalIds reuses it (was O(n²) rebuilding per task)
        for (const t of tasksList) {
          const ctx = mkCtx(t, tasksList, byId);
          if (t.completed_at && !t.recurrence) log.push({ id: uuid(), type: 'complete', ts: t.completed_at, subject_type: 'task', subject_id: t.id, ctx, void: false });
          for (const c of (t.completions || [])) log.push({ id: uuid(), type: 'complete', ts: c, subject_type: 'task', subject_id: t.id, ctx, void: false });
        }
        writeActivity(log);
      }
      meta.activity_backfilled = true; writeMeta(meta);
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
  // One-time: task.place → location with 'only' constraint.
  {
    const meta = readMeta();
    if (!meta.locations_migrated) {
      const tasks = readTasks(), locs = readLocations(); let changed = false;
      const findOrAdd = name => { let l = locs.find(x => x.name === name); if (!l) { l = mkLocation(name, 'Home', locs.length); locs.push(l); } return l.id; };
      for (const t of tasks) if (typeof t.place === 'string' && t.place.trim()) { t.location = { mode: 'only', ids: [findOrAdd(t.place.trim())] }; t.place = null; changed = true; }
      if (changed) { writeLocations(locs); writeTasks(tasks); }
      meta.locations_migrated = true; writeMeta(meta);
    }
  }
  // migrate presence windows → recurring blocks (one-time, idempotent)
  {
    const meta = readMeta();
    if (!meta.blocks_from_windows) {
      const ts = now();
      const blocks = readWindows().map(w => {
        const wds = (w.weekdays || []).slice().sort((a, b) => a - b);
        const anchor = '2024-01-' + String(7 + (wds[0] ?? 0)).padStart(2, '0');   // 2024-01-07 = Sunday; offset by weekday → anchor matches rule
        return {
          id: uuid(), title: '', starts_at: anchor + 'T' + (w.typical_start || '09:00'), ends_at: anchor + 'T' + (w.typical_end || '17:00'),
          all_day: false, recurrence: { freq: 'week', interval: 1, weekdays: wds },
          location_id: w.location_id, areas: [], energy: null, availability: 'busy',
          color: null, source: 'local', created_at: ts, updated_at: ts,
        };
      });
      if (blocks.length) writeBlocks([...readBlocks(), ...blocks]);
      meta.blocks_from_windows = true; writeMeta(meta);
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
        t = { id: uuid(), content: fields.project, notes: null, priority: 4, due_at: null, deadline_at: null,
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
    if (fields.area_ids) return fields.area_ids;
    if (fields.areas && fields.areas.length) {
      const areas = readAreas();
      const ts = now();
      const ids = fields.areas.map(name => {
        let l = areas.find(x => x.name === name);
        if (!l) {
          const pos = areas.length ? Math.max(...areas.map(x => x.position)) + 1 : 0;
          l = { id: uuid(), name, color: null, position: pos, favorite: false, created_at: ts, updated_at: ts };
          areas.push(l);
        }
        return l.id;
      });
      writeAreas(areas);
      return ids;
    }
    return [];
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

    // reversible undo: snapshot/restore tasks + activity + areas
    snapshot() { return { tasks: JSON.stringify(readTasks()), activity: JSON.stringify(readActivity()), areas: JSON.stringify(readAreas()) }; },
    restore(snap) { if (!snap) return false; writeTasks(JSON.parse(snap.tasks)); writeActivity(JSON.parse(snap.activity)); if (snap.areas !== undefined) writeAreas(JSON.parse(snap.areas)); return true; },

    defaultProject() { return readMeta().default_project_id || null; },
    search(query, limit = 50) {
      return (query || '').trim()
        ? rankDocs(uf, _search.haystack, _search.meta, query, limit)
        : defaultDocs(_search.meta, readMeta().recent || [], limit);
    },
    recordSearchPick(id) { const meta = readMeta(); meta.recent = [id, ...(meta.recent || []).filter(x => x !== id)].slice(0, 12); writeMeta(meta); },
    setDefaultProject(id) { const meta = readMeta(); meta.default_project_id = id; writeMeta(meta); reindex(); },
    globalTargets() { return readMeta().global_targets || []; },
    setGlobalTargets(targets) { const meta = readMeta(); meta.global_targets = targets || []; writeMeta(meta); },
    runFilter(query, limit = 200) {
      const tasks = readTasks(), areas = readAreas(), def = readMeta().default_project_id || null;
      const freeText = (term, scope) => {
        const [idxs] = uf.search(_search.haystack, term, 1, 1e4);
        const ids = new Set((idxs || []).map(i => _search.meta[i].id));
        if (!scope) return ids;
        return new Set([...ids].filter(id => {
          const t = tasks.find(x => x.id === id); if (!t) return false;
          const hay = scope === 'notes' ? (t.notes || '') : (t.content || '');
          return hay.toLowerCase().includes(term);
        }));
      };
      return matchQuery(query, tasks, { now: now(), areas, defaultProjectId: def, freeText }).slice(0, limit);
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
          if (recurrence && !fields.due_at) {
            const b = nextAcrossRules(recurrence, isoDate(new Date(now())), now(), { inclusive: true });
            if (b) { b.rule.gen_due = true; due_at = b.iso + (b.rule.at ? 'T' + b.rule.at : ''); }   // seeded due is rule-generated; a rule may carry its own time
          }
          const row = {
            ...baseTask(),
            id: uuid(),
            content: fields.content,
            notes: fields.notes ?? null,
            priority: fields.priority ?? 4,
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
        } catch { return null; }
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
        Object.assign(row, fields, resolved, { updated_at: now() });
        writeTasks(rows);
        if (fields.due_at !== undefined && prevDue && row.due_at && row.due_at.slice(0, 10) > prevDue.slice(0, 10)) pushActivity('postpone', row);
        return row;
      },
      async setChecklistItem(id, itemId, done) {
        const rows = readTasks();
        const row = rows.find(r => r.id === id); if (!row) return false;
        const it = (row.checklist || []).find(c => c.id === itemId); if (!it) return false;
        it.done = done; row.updated_at = now();
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
          t.parent_id = parentId ?? null; t.position = toIndex; t.updated_at = ts; _treeDirty = true;
          // Auto-complete old parent chain (ancestors whose remaining children are all done).
          if (oldParentId && oldParentId !== (parentId ?? null)) {
            for (const pid of movedOutParents(rows, id, oldParentId, ts)) {
              const p = rows.find(r => r.id === pid);
              if (p && !p.completed_at) { p.completed_at = ts; p.updated_at = ts; if (p.sidebar !== true) pushActivity('complete', p); }
            }
          }
          writeTasks(rows); return t;
        } catch { return null; }
      },
      async remove(id, targetId) {
        try {
          _treeDirty = true;
          const rows = readTasks();
          const kids = rows.filter(r => r.parent_id === id);
          if (kids.length) {
            if (!targetId || !rows.some(r => r.id === targetId)) return false;
            if (descendantIds(rows, id).includes(targetId)) return false;
            for (const k of kids) k.parent_id = targetId;
          }
          const meta = readMeta();
          if (meta.default_project_id === id && targetId) { meta.default_project_id = targetId; writeMeta(meta); }
          const remaining = rows.filter(r => r.id !== id);
          for (const r of remaining) {
            if (r.blocked_by?.includes(id)) r.blocked_by = r.blocked_by.filter(x => x !== id);
            if (r.relates?.includes(id)) r.relates = r.relates.filter(x => x !== id);
          }
          writeTasks(remaining);
          return true;
        } catch { return false; }
      },
      async setCompleted(id, done) {
        const rows = readTasks(); const ts = now();
        const voidComplete = sid => { const log = readActivity(); for (let i = log.length - 1; i >= 0; i--) if (log[i].subject_id === sid && log[i].type === 'complete' && !log[i].void) { log[i].void = true; writeActivity(log); break; } };
        const mark = (tid, val) => { const r = rows.find(x => x.id === tid); if (r) { const was = r.completed_at; r.completed_at = val; r.updated_at = ts; if (val && !was && r.sidebar !== true) pushActivity('complete', r); } };
        const target = rows.find(r => r.id === id);
        // Recurring: log + advance due_at unless every statement ends (all-paused falls through to permanent complete).
        const rules = recRules(target?.recurrence);
        if (done && rules.some(r => !r.paused) && !target.completed_at && !rows.some(r => r.parent_id === id)) {
          target.completions.push(ts); target.updated_at = ts;
          if (target.sidebar !== true) pushActivity('complete', target);
          const anchor = target.due_at || isoDate(new Date(ts));
          // The completed occurrence belongs to the rule that generated the current due (gen_due marker; legacy fallback: first active).
          const src = rules.find(r => r.gen_due && !r.paused) || rules.find(r => !r.paused);
          src.done_count = (src.done_count ?? 0) + 1;
          const srcNext = nextOccurrence(src, anchor, ts);
          // Per-rule ends (count reached, or next past "until"): PAUSE (never destroy) the exhausted statement.
          if ((src.ends?.count != null && src.done_count >= src.ends.count) || (src.ends?.date && srcNext > src.ends.date)) src.paused = true;
          rules.forEach(r => delete r.gen_due);
          const best = nextAcrossRules(target.recurrence, anchor, ts);
          if (!best) target.completed_at = ts;   // every statement ended → permanent complete (rules stay, paused)
          else { best.rule.gen_due = true; target.due_at = best.iso + (best.rule.at ? 'T' + best.rule.at : (target.due_at && target.due_at.length > 10 ? target.due_at.slice(10) : '')); }
          writeTasks(rows);
          return true;
        }
        if (done) {
          for (const x of pendingSweep(rows, id)) {
            const r = rows.find(row => row.id === x);
            if (r?.recurrence && recActive(r.recurrence)) r.recurrence = Array.isArray(r.recurrence) ? r.recurrence.map(x => ({ ...x, paused: true })) : { ...r.recurrence, paused: true };   // permanent completion pauses (never destroys) the rule(s)
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
        t.archived_at = val ? ts : null; t.updated_at = ts;
        if (val && recActive(t.recurrence)) t.recurrence = Array.isArray(t.recurrence) ? t.recurrence.map(x => ({ ...x, paused: true })) : { ...t.recurrence, paused: true };   // pause, never destroy
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
        if (!a[key].includes(otherId)) { a[key].push(otherId); a.updated_at = ts; }
        if (key === 'relates' && !b.relates.includes(id)) { b.relates.push(id); b.updated_at = ts; }
        writeTasks(rows);
        return true;
      },
      async unlink(id, otherId, type) {
        const rows = readTasks(); const ts = now();
        const a = rows.find(r => r.id === id), b = rows.find(r => r.id === otherId);
        const key = type === 'relates' ? 'relates' : 'blocked_by';
        if (a) { a[key] = a[key].filter(x => x !== otherId); a.updated_at = ts; }
        if (key === 'relates' && b) { b.relates = b.relates.filter(x => x !== id); b.updated_at = ts; }
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
        const ts = now();
        const pos = areas.length ? Math.max(...areas.map(l => l.position)) + 1 : 0;
        const area = { id: uuid(), name, color: color ?? null, icon: null, position: pos, favorite: false, created_at: ts, updated_at: ts };
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
      async get(from, to) { const tv = readTravel(); return tv[from + '>' + to] ?? tv[to + '>' + from] ?? (readMeta().default_travel_min ?? 20); },
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
    presenceActuals() { return readMeta().presence_actuals ?? {}; },
    setCurrentLocation(id) {
      const m = readMeta();
      if (m.current_location_id !== id) { const log = readActivity(); log.push({ id: uuid(), type: 'location', ts: now(), subject_type: 'location', subject_id: id, ctx: { from: m.current_location_id ?? null }, void: false }); writeActivity(log); }
      m.current_location_id = id;
      const today = isoDate(new Date(now()));
      m.presence_actuals = m.presence_actuals || {}; m.presence_actuals[today] = m.presence_actuals[today] || {};
      m.presence_actuals[today][id] = { ...(m.presence_actuals[today][id] || {}), start: m.presence_actuals[today][id]?.start || now().slice(11, 16) };
      writeMeta(m);
    },
    setCurrentRegion(name) {
      const m = readMeta();
      if (m.current_region !== name) { const log = readActivity(); log.push({ id: uuid(), type: 'region', ts: now(), subject_type: 'region', subject_id: name, ctx: { from: m.current_region ?? null }, void: false }); writeActivity(log); }
      m.current_region = name; writeMeta(m);
    },
    stampActual(dateIso, locId, bounds) { const m = readMeta(); m.presence_actuals = m.presence_actuals || {}; m.presence_actuals[dateIso] = m.presence_actuals[dateIso] || {}; m.presence_actuals[dateIso][locId] = { ...(m.presence_actuals[dateIso][locId] || {}), ...bounds }; writeMeta(m); },
    subscribe() {},   // no-op: local store needs no realtime subscription
  };
}
