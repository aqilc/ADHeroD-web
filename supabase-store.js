// Supabase adapter — same interface as createLocalStore (see store.js). Mapping helpers exported for tests.

import { chkIds, childIndex, descendantIds, projectDepth, subtreeDepth, pendingSweep, ancestorsToReopen, parentsToComplete, movedOutParents, removedOutParents, recActive, MAX_DEPTH, resolveAreaNames, searchDocs, buildFreeText, updateRecent, advanceRecurrence, pauseRecurrence, seedRecurrenceDue, captureTz, placedMap, REFS, liveRefs, overviewFields } from './store.js';
import { makeFuzzy, buildSearchDocs, matchQuery } from './search.js';
import { isoDate } from './nlp.js';
import { inNotes } from './predicates.js';

// ─── Pure row ↔ object mapping ───────────────────────────────────────────────

export function hydrateTask(row) {
  row = overviewFields(row);
  const rel = row.task_relations ?? [];   // sole embed; split by type into blocked_by/relates
  return {
    id: row.id,
    content: row.content,
    notes: row.notes ?? null,
    importance: row.importance ?? 'none',
    recur_from: row.recur_from ?? null,
    available_from: row.available_from ?? null,
    deadline_at: row.deadline_at ?? null,
    est_minutes: row.est_minutes ?? null,
    task_size: row.task_size ?? null,
    anchor: row.anchor ?? null,
    possible: row.possible ?? null,
    starts_at: row.starts_at ?? null,
    ends_at: row.ends_at ?? null,
    tz: row.tz ?? null,
    parent_id: row.parent_id ?? null,
    area_ids: row.area_ids ?? [],
    goal_ids: row.goal_ids ?? [],
    color: row.color ?? null,
    favorite: row.favorite ?? false,
    place: row.place ?? null,
    location: { mode: row.location_mode ?? 'any', ids: row.location_ids ?? [] },
    position: row.position ?? 0,
    completed_at: row.completed_at ?? null,
    archived_at: row.archived_at ?? null,
    blocked_by: rel.filter(r => r.type === 'needs').map(r => r.related_id),
    relates: rel.filter(r => r.type === 'relates').map(r => r.related_id),
    overview: row.overview ?? false,
    milestone: row.milestone ?? false,
    checklist: chkIds((row.checklist ?? []).map(({ id, text, done }) => ({ id, text, done }))),   // array order IS the order
    checklist_plain: row.checklist_plain ?? false,
    task_type: row.task_type ?? null,
    recurrence: row.recurrence ?? null,
    completions: row.completions ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// array order IS position; backfill missing ids
const cleanChecklist = list => (list ?? []).map(it => ({ id: it.id || crypto.randomUUID(), text: it.text, done: it.done ?? false }));

export function dehydrateTask(task) {
  task = overviewFields(task);
  return {
    row: {
      content: task.content,
      notes: task.notes ?? null,
      importance: task.importance ?? 'none',
      recur_from: task.recur_from ?? null,
      available_from: task.available_from ?? null,
      deadline_at: task.deadline_at ?? null,
      est_minutes: task.est_minutes ?? null,
      parent_id: task.parent_id ?? null,
      color: task.color ?? null,
      favorite: task.favorite ?? false,
      place: task.place ?? null,
      location_mode: task.location?.mode ?? 'any',
      location_ids: task.location?.ids ?? [],
      area_ids: task.area_ids ?? [],
      goal_ids: task.goal_ids ?? [],
      position: task.position ?? 0,
      completed_at: task.completed_at ?? null,
      archived_at: task.archived_at ?? null,
      overview: task.overview ?? false,
      milestone: task.milestone ?? false,
      checklist_plain: task.checklist_plain ?? false,
      task_type: task.task_type ?? null,
      checklist: cleanChecklist(task.checklist),
      completions: task.completions ?? [],
      recurrence: task.recurrence ?? null,
      starts_at: task.starts_at ?? null, ends_at: task.ends_at ?? null, tz: task.tz ?? null,
      task_size: task.task_size ?? null, anchor: task.anchor ?? null, possible: task.possible ?? null,
    },
    // task↔task edges live in one table now, discriminated by `type`.
    task_relations: [
      ...(task.blocked_by ?? []).map(related_id => ({ related_id, type: 'needs' })),
      ...(task.relates ?? []).map(related_id => ({ related_id, type: 'relates' })),
    ],
  };
}

function hydrateEvent(row) {
  return {
    id: row.id, title: row.title, notes: row.notes ?? null,
    starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null,
    all_day: row.all_day ?? false,
    recurrence: row.recurrence ?? null,
    location: { mode: row.location_mode ?? 'any', ids: row.location_ids ?? [] },
    color: row.color ?? null, source: row.source ?? 'local', external_id: row.external_id ?? null, ics_seq: row.ics_seq ?? null,
    countdown: row.countdown ?? false,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function hydrateBlock(row) {
  return {
    id: row.id, title: row.title ?? '',
    starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null,
    all_day: row.all_day ?? false,
    recurrence: row.recurrence ?? null,
    location_id: row.location_id ?? null,
    areas: row.area_ids ?? [],
    color: row.color ?? null, source: row.source ?? 'local',
    est_minutes: row.est_minutes ?? null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// hydrateEvent/hydrateBlock's inverse for the fields present: the app's shape back to columns.
const eventCols = ({ location, ...f }) => ({ ...f, ...location !== undefined && { location_mode: location?.mode ?? 'any', location_ids: location?.ids ?? [] } });
const blockCols = ({ areas, ...f }) => ({ ...f, ...areas !== undefined && { area_ids: areas ?? [] } });

// The update payload every table builds: the named columns the caller actually passed, nulled rather than dropped.
const pick = (fields, cols) => Object.fromEntries(cols.filter(c => c in fields).map(c => [c, fields[c] ?? null]));

// ─── Store factory ────────────────────────────────────────────────────────────

export function createSupabaseStore(client) {
  let _uid = null;
  async function userId() {
    if (!_uid) { const { data } = await client.auth.getUser(); _uid = data.user?.id; }
    return _uid;
  }

  // once warm, list() is a cache hit; mutations refetch only affected rows
  let _settings = {}, _cTasks = [], _cAreas = [], _cDef = null;
  let themeWrite = Promise.resolve();   // slow earlier selections must not overwrite the latest one
  let _loaded = false, _areasLoaded = false, _settingsLoaded = false;
  let _cacheV = 0, _bootGen = 0;   // _cacheV: bumped by every cache write/invalidation — a bootstrap answering after one must not write over it
  const _uf = makeFuzzy();
  let _cIdx = buildSearchDocs([], [], null), _idxDirty = false;
  const rebuildIdx = () => { _idxDirty = true; _cacheV++; };   // U-18: mark dirty; built lazily in search()/runFilter()
  let _idxLocs = [];   // the locations rows indexed: every write replaces the collection's array, so a rename re-indexes
  const ensureIdx = () => {
    const locs = COLL.locations.cached();   // a cold cache answers a fresh [] per call — empty-vs-empty isn't a change
    if (_idxDirty || (locs !== _idxLocs && (locs.length || _idxLocs.length))) { _cIdx = buildSearchDocs(_cTasks, _cAreas, _cDef, locs); _idxLocs = locs; _idxDirty = false; }
  };

  // Realtime: our own writes echo back through the channel — track their ids for ~2s and skip the refetch they trigger.
  // ceiling: another device's change to a row this one wrote under 2s ago is skipped too — match echoes by updated_at if a
  // user reports a remote edit that only shows after a reload.
  let _channel = null, _onChange = null, _applyT = null, _needFull = false, _dropped = false;
  const _echo = new Map(), _pendRefetch = new Set(), _pendDrop = new Set();   // _echo: id → its expiry timer; area ids share it (uuids don't collide with task ids)
  const markEcho = (...ids) => { for (const id of ids) if (id) { clearTimeout(_echo.get(id)); _echo.set(id, setTimeout(() => _echo.delete(id), 2000)); } };
  // ── Warm caches for the side lists ────────────────────────────────────────
  // tasks and areas have had one since the start; these seven re-read the whole table on EVERY list(), which
  // is why a "narrow" reload was still a round-trip. One collection gives them the same contract: the first
  // list() fetches, every later one is free, our own writes patch the row in place (and mark the echo so the
  // realtime bounce is a no-op), and a remote change patches from its payload — no refetch either way.
  function collection(table, { order, hydrate = r => r, boot = false } = {}) {   // boot: bootstrap primes it, so a refill under one must win over its answer
    let rows = null, gen = 0;   // null = cold · gen: bumped by invalidate or a write while cold, so a list answering after one is dropped
    const cmp = order ? (a, b) => { const x = a[order] ?? 0, y = b[order] ?? 0; return x < y ? -1 : x > y ? 1 : 0; } : null;
    const put = (row) => {
      const h = hydrate(row);
      if (rows) { rows = rows.some(r => r.id === h.id) ? rows.map(r => r.id === h.id ? h : r) : [...rows, h]; if (cmp) rows.sort(cmp); _cacheV++; } else gen++;
      return h;
    };
    const drop = (id) => { if (rows) { rows = rows.filter(r => r.id !== id); _cacheV++; } else gen++; };
    return {
      async list() {
        if (rows) return rows.slice();   // warm: the cache is authoritative (own writes + realtime keep it so)
        const seen = gen;
        let q = client.from(table).select('*'); if (order) q = q.order(order);
        const { data, error } = await q; if (error) throw error;
        const fresh = (data || []).map(hydrate);
        if (seen !== gen) return fresh;   // invalidated meanwhile: serve this caller, leave the cache cold
        rows = fresh; if (boot) _cacheV++; return rows.slice();
      },
      prime(list) { rows = list; },       // bootstrap already carried these — never fetch them twice
      cached() { return rows || []; },    // sync peek for render-time reads (runFilter); warm after the app's first list()
      invalidate() { rows = null; gen++; _cacheV++; },      // a payload with no id, or a bulk write with no single row to patch
      put, drop,
      mine(row) { if (!row) return null; markEcho(row.id); return put(row); },   // our write: patch + suppress the echo
      mineDrop(id) { markEcho(id); drop(id); return true; },
      // ── The writes every side list does identically. Only the row's own columns differ, so callers pass
      // just those; user scoping and the cache patch belong to the collection, the timestamps to the DB (default now(), set_updated_at).
      async insert(row) {
        const uid = await userId();
        const { data, error } = await client.from(table).insert({ user_id: uid, ...row }).select('*').single();
        return error ? null : this.mine(data);
      },
      // a FRESH read of one row, past the cache — for when a write's response was lost and whether it landed matters
      async one(id) {
        const uid = await userId();
        const { data, error } = await client.from(table).select('*').eq('id', id).eq('user_id', uid).maybeSingle(); if (error) throw error;
        return data ? put(data) : (drop(id), null);
      },
      async patch(id, upd) {
        if (!Object.keys(upd).length) return this.one(id).catch(() => null);   // nothing to write: an empty PATCH returns no row, which .single() fails
        const uid = await userId();
        const { data } = await client.from(table).update(upd).eq('id', id).eq('user_id', uid).select('*').single();
        return this.mine(data);
      },
      async del(id) {
        const uid = await userId();
        const { error } = await client.from(table).delete().eq('id', id).eq('user_id', uid);
        return !error && this.mineDrop(id);
      },
      async reorder(ids) {
        const uid = await userId();
        const res = await Promise.all(ids.map((id, i) => { markEcho(id); return client.from(table).update({ position: i }).eq('id', id).eq('user_id', uid); }));
        this.invalidate();   // a bulk position rewrite is not one row to patch
        return !res.some(r => r.error);
      },
      // Next free `position`, read from the table (not the cache — it may be cold).
      async nextPos() {
        const { data } = await client.from(table).select('position').order('position', { ascending: false }).limit(1);
        return data?.length ? (data[0].position ?? 0) + 1 : 0;
      },
    };
  }
  const COLL = {
    reminders: collection('reminders', { order: 'created_at' }),
    events: collection('events', { order: 'starts_at', hydrate: hydrateEvent, boot: true }),
    blocks: collection('blocks', { order: 'starts_at', hydrate: hydrateBlock, boot: true }),
    filters: collection('filters', { order: 'position', boot: true }),
    locations: collection('locations', { order: 'position', boot: true }),
    schedule_items: collection('schedule_items', { order: 'position' }),
    block_days: collection('block_days'),
    day_notes: collection('day_notes'),
  };

  // table → the app-side list a change to it invalidates. tasks/areas are handled apart (they own caches).
  const SYNC_KINDS = { events: 'event', blocks: 'block', filters: 'filter',
    locations: 'location', schedule_items: 'scheduleItem', block_days: 'blockDay', reminders: 'reminder', day_notes: 'dayNote' };
  const taskUpdate = async (id, uid, payload) => Object.keys(payload).length ? client.from('tasks').update(payload).eq('id', id).eq('user_id', uid) : { error: null };
  // Debounce a burst of remote task events, then patch ONLY the touched rows (bounded refetch with the relations embed) —
  // never a full-table scan. Full refetch is the fallback for a payload with no id.
  const scheduleApply = () => { clearTimeout(_applyT); _applyT = setTimeout(async () => {
    if (_needFull) { _pendRefetch.clear(); _pendDrop.clear(); try { await fetchAllTasks(); } catch { return; } _needFull = false; }   // failed: the next change retries
    else {
      const drop = [..._pendDrop], refetch = [..._pendRefetch].filter(id => !_pendDrop.has(id));
      _pendDrop.clear(); _pendRefetch.clear();
      if (drop.length) dropTasks(drop);
      await refreshTasks(refetch);
    }
    _onChange?.('task');
  }, 250); };

  async function getSettings() {
    const uid = await userId();
    const { data, error } = await client.from('user_settings').select('*').eq('user_id', uid).maybeSingle(); if (error) throw error;
    _settings = data || {}; _cDef = _settings.default_project_id ?? null; _settingsLoaded = true;
    return _settings;
  }
  const settings = async () => _settingsLoaded ? _settings : getSettings();   // hits the network once, then cached
  // Upsert merges: only the named columns change, and a first write creates the row. The cache takes it once it landed.
  async function patchSettings(fields) {
    try {
      const uid = await userId();
      if ((await client.from('user_settings').upsert({ user_id: uid, ...fields }, { onConflict: 'user_id' })).error) return false;
      _settings = { ..._settings, ...fields }; _cDef = _settings.default_project_id ?? null; rebuildIdx();
      return true;
    } catch { return false; }
  }

  // task_relations is the only junction left; its two FKs to tasks need the FK hint to disambiguate.
  const TASK_SELECT = '*, task_relations!task_relations_task_id_fkey(related_id, type)';

  const URL_IDS = 150;   // ids per request URL: ~40 B each, and proxies cap near 8 KB ≈ 200
  const taskSort = (x, y) => (x.position ?? 0) - (y.position ?? 0) || (y.created_at || '').localeCompare(x.created_at || '');
  // A write's row (`patch`: the columns it wrote), read back into the cache. The write landed even when the read fails ("didn't
  // save" invites a duplicate retry): the cached row takes what it wrote, and the cache goes cold so the next list re-pulls.
  // `wrote`: the write's response was lost, so only a row holding every written column proves it landed.
  // Postgres answers jsonb with its object keys re-sorted and timestamptz as "+00:00" for a written "Z": equal by value, not text.
  const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
  const sameValue = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' ? STAMP.test(a) && STAMP.test(b) && Date.parse(a) === Date.parse(b)
    : !!a && !!b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)
      && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => sameValue(a[k], b[k])));
  async function readBack(id, patch, wrote = null) {
    const { data, error } = await client.from('tasks').select(TASK_SELECT).eq('id', id).single();
    if (data) { const task = hydrateTask(data); putTask(task); return !wrote || Object.keys(wrote).every(k => sameValue(data[k], wrote[k])) ? task : null; }
    if (error?.code === 'PGRST116') return null;   // no such row: the write matched nothing
    _loaded = false; _cacheV++;
    if (wrote) return null;
    const cur = _cTasks.find(x => x.id === id), { row, task_relations } = cur ? dehydrateTask(cur) : {};
    const task = hydrateTask({ id, ...row, task_relations, created_at: cur?.created_at, updated_at: cur?.updated_at, ...patch });
    if (cur) putTask(task);   // search and filters read the cache without a list
    return task;
  }
  async function fetchAllTasks() {
    const { data, error } = await client.from('tasks').select(TASK_SELECT).order('position'); if (error) throw error;   // a failed load is not an empty account
    _cTasks = (data || []).map(hydrateTask); _loaded = true; _cacheV++; return _cTasks;
  }
  const taskRows = async () => _loaded ? _cTasks : await fetchAllTasks();
  // splice into cache (replace by id, else append) — avoids a second full fetch
  const putTask = (task) => {
    if (!task) return;
    _cTasks = _cTasks.some(t => t.id === task.id) ? _cTasks.map(t => t.id === task.id ? task : t) : [..._cTasks, task];
    rebuildIdx();
  };
  // Bounded reads of just these rows — for cascade mutations — spliced into the cache in one pass. → whether every read answered
  async function refreshTasks(ids) {
    const uniq = [...new Set(ids.filter(Boolean))], chunks = [];
    for (let i = 0; i < uniq.length; i += URL_IDS) chunks.push(uniq.slice(i, i + URL_IDS));
    const res = await Promise.all(chunks.map(c => client.from('tasks').select(TASK_SELECT).in('id', c)));
    const got = new Map(res.flatMap(r => r.data ?? []).map(r => [r.id, hydrateTask(r)]));
    if (got.size) { _cTasks = _cTasks.map(t => { const fresh = got.get(t.id); got.delete(t.id); return fresh ?? t; }).concat([...got.values()]); rebuildIdx(); }   // replaced in place; new rows append
    return !res.some(r => r.error);
  }
  // one write over many rows (our own: its echo is suppressed); the columns it returns, as the DB stored them, patch the cache — no read
  async function patchTasks(uid, ids, upd) {
    markEcho(...ids);
    const { data } = await client.from('tasks').update(upd).in('id', ids).eq('user_id', uid).select(['id', 'updated_at', ...Object.keys(upd)].join());
    const got = new Map((data ?? []).map(r => [r.id, r]));
    if (got.size) { _cTasks = _cTasks.map(t => got.has(t.id) ? { ...t, ...got.get(t.id) } : t); rebuildIdx(); }
  }
  // links changed outside update(): native realtime hears only tasks (Sync.kt TABLES), so touch their rows — once per
  // burst (a link loop, an import), after its last link. ceiling: fire-and-forget; a failed touch leaves native stale
  // until its next pull — retry it if a lost link edit is ever reported there.
  let _touch = new Set(), _touchT;
  const touchTasks = (uid, ids) => { ids.forEach(id => _touch.add(id)); clearTimeout(_touchT);
    _touchT = setTimeout(() => { const ids = [..._touch]; _touch = new Set(); patchTasks(uid, ids, { updated_at: new Date().toISOString() }); }, 250); };
  const dropTasks = (ids) => { const s = new Set(ids); _cTasks = _cTasks.filter(t => !s.has(t.id)); rebuildIdx(); };
  // Task resolver (store.js ancestorsToReopen) — client-side so it holds before the reopen_ancestors trigger lands; idempotent after.
  async function reopenAncestors(id, uid) {
    const ids = ancestorsToReopen(await taskRows(), id); if (ids.length) await patchTasks(uid, ids, { completed_at: null });
  }
  // …and close the parents id's move/removal left finished. The move/remove already landed: this can't fail it.
  async function closeMovedOut(rows, id, oldParentId, ts, uid) {
    const ids = movedOutParents(rows, id, oldParentId, ts, (await settings()).default_project_id); if (ids.length) await patchTasks(uid, ids, { completed_at: ts });
  }

  // Find-or-create an area by TRIMMED name, reusing an existing one instead of ever inserting a duplicate.
  // Cache hit wins; on a stale-cache unique clash (another device already created it — the DB's
  // areas_user_name_idx forbids same-owner dupes) refetch that row and reuse it.
  async function ensureArea(name, color = null) {
    const nm = (name ?? '').trim();
    const cached = _cAreas.find(a => a.name === nm);
    if (cached) return cached;
    const uid = await userId();
    const pos = _cAreas.length ? Math.max(..._cAreas.map(a => a.position ?? 0)) + 1 : 0;
    const { data, error } = await client.from('areas').insert({ user_id: uid, name: nm, color: color ?? null, icon: null, position: pos, favorite: false }).select().single();
    if (data) { markEcho(data.id); _cAreas = [..._cAreas, data]; rebuildIdx(); return data; }
    if (error) {
      const { data: found } = await client.from('areas').select('*').eq('user_id', uid).eq('name', nm).limit(1).maybeSingle();
      if (found) { if (!_cAreas.some(a => a.id === found.id)) { _cAreas = [..._cAreas, found]; rebuildIdx(); } return found; }
    }
    return null;
  }

  // fields.areas (names) → area ids, mirroring LocalStore.resolveAreas: prefer explicit area_ids, else
  // find-or-create each name (reusing existing rows — never a duplicate).
  async function resolveAreaIds(fields) {
    const { ids, names } = resolveAreaNames(fields);
    if (ids) return ids;
    if (!names.length) return [];
    const result = [];
    for (const nm of names) { const a = await ensureArea(nm); if (a) result.push(a.id); }
    return result;
  }

  // A project named, not picked (the # pill) → its root task, made an overview project if new: LocalStore's resolveParent.
  // A failed create throws here (null.id), so the caller's save fails rather than filing the task somewhere else.
  async function projectId(name, create) {
    return ((await taskRows()).find(t => t.parent_id === null && t.content === name) ?? await create({ content: name, parent_id: null, overview: true })).id;
  }

  // Replaces one edge-type in task_relations ('relates' is symmetric: mirrors too). The new set lands first, only
  // then do the edges outside it go — a failed write never loses one. false = not (fully) replaced.
  // A dead id is dropped only when the DB says so (upsertLive): the cache can lag a task another device just added.
  async function setRelationType(id, uid, type, ids) {
    const rows = ids.map(related_id => ({ task_id: id, related_id, type, user_id: uid }));
    if (type === 'relates') rows.push(...ids.map(related_id => ({ task_id: related_id, related_id: id, type, user_id: uid })));
    const put = await upsertLive('relation', 'task_relations', rows, 'task_id,related_id,type'); if (!put) return false;
    ids = put.filter(r => r.task_id === id).map(r => r.related_id);
    const stale = (col, other) => { const q = client.from('task_relations').delete().eq(col, id).eq('type', type).eq('user_id', uid); return ids.length ? q.not(other, 'in', `(${ids})`) : q; };
    const res = await Promise.all(type === 'relates' ? [stale('task_id', 'related_id'), stale('related_id', 'task_id')] : [stale('task_id', 'related_id')]);
    return !res.some(r => r.error);
  }
  // Upsert; on an FK reject (23503: a parent deleted since) look the referenced ids up IN THE DB — never the cache, which can
  // lag another device — drop/null the dead ones (liveRefs) and retry once. → the rows stored (a live one kept as it is, its id
  // added to `live`), or null on failure.
  async function upsertLive(kind, table, rows, onConflict = 'id', live = null) {
    const put = () => { const q = client.from(table).upsert(rows, { onConflict, ignoreDuplicates: true }); return !rows.length ? { data: [], error: null } : live ? q.select('id') : q; };
    let { data, error } = await put();
    if (error?.code === '23503') {
      const want = {}, ids = {};
      for (const [col, p] of REFS[kind] || []) for (const r of rows) if (r[col] != null) (want[p] ||= new Set()).add(r[col]);
      for (const [p, s] of Object.entries(want)) {
        const { data, error: e } = await client.from({ task: 'tasks', block: 'blocks', location: 'locations' }[p]).select('id').in('id', [...s]); if (e) return null;
        ids[p] = new Set(data.map(r => r.id));
      }
      rows = liveRefs(kind, rows, ids); ({ data, error } = await put());
    }
    if (error) return null;
    if (live) { const landed = new Set(data.map(r => r.id)); for (const r of rows) if (!landed.has(r.id)) live.add(r.id); }
    return rows;
  }

  return {
    // one round-trip via bootstrap RPC; primes caches
    // ceiling: a write landing mid-flight re-pulls; a write storm outlasting every round-trip keeps it pulling — cap re-pulls if an account pull passes ~1s
    async bootstrap() {
      const gen = ++_bootGen, v = _cacheV;
      const { data, error } = await client.rpc('bootstrap'); if (error) throw error;
      if (gen !== _bootGen) throw new Error('superseded');   // a newer bootstrap owns the caches (the app's reloadAll already bailed)
      if (v !== _cacheV) return this.bootstrap();             // a write or invalidation landed meanwhile: the server has it, this answer doesn't
      const d = data || {};
      _settings = d.settings || {}; _cDef = _settings.default_project_id ?? null; _settingsLoaded = true;
      const relByTask = {};
      for (const r of d.task_relations || []) (relByTask[r.task_id] ||= []).push(r);
      _cTasks = (d.tasks || []).map(t => hydrateTask({ ...t, task_relations: relByTask[t.id] || [] }));
      _cAreas = d.areas || []; _loaded = true; _areasLoaded = true; rebuildIdx();
      // The RPC already carried these — prime the caches from it rather than letting the first list() refetch
      // what we are holding in our hand. This is what makes bootstrap a COLD START instead of a poll.
      const out = { filters: d.filters || [], locations: d.locations || [],
        events: (d.events || []).map(hydrateEvent), blocks: (d.blocks || []).map(hydrateBlock) };
      for (const k of ['filters', 'locations', 'events', 'blocks']) COLL[k].prime(out[k].slice());
      return { ...out, tasks: [..._cTasks].sort(taskSort), areas: _cAreas };
    },

    // sync reads from cache (matches LocalStore; called during render)
    defaultProject() { return _settings.default_project_id ?? null; },
    theme() { return _settings.theme ?? null; },
    setTheme(theme) { return themeWrite = themeWrite.then(() => patchSettings({ theme })); },
    search(query, limit = 50) { ensureIdx(); return searchDocs(query, limit, _uf, _cIdx, _settings.recent ?? []); },
    recordSearchPick(id) {
      const recent = updateRecent(id, _settings.recent);
      _settings = { ..._settings, recent }; return patchSettings({ recent });   // sync cache update; the persist reports
    },
    runFilter(query) {   // a view: every match
      return matchQuery(query, _cTasks, { now: new Date().toISOString(), areas: _cAreas, defaultProjectId: _cDef, placed: placedMap(COLL.schedule_items.cached()), freeText: buildFreeText(_uf, () => (ensureIdx(), _cIdx), _cTasks) });
    },

    homeLocationId() { return _settings.home_location_id ?? null; },   // designated "home" place ("at home" NLP)
    setHomeLocation: id => patchSettings({ home_location_id: _settings.home_location_id === id ? null : id }),
    currentRegion() { return _settings.current_region ?? 'Home'; },

    // Trash restore: re-insert previously-deleted rows. Powers "Recently deleted". A row already live stays as it is (ON CONFLICT DO NOTHING):
    // the cache can miss one another device brought back and edited since, which the Bin's older copy must never overwrite.
    // `live` gets those rows' ids: the Bin keeps their copy.
    async reinsert(kind, rows, live = null) {
      if (!rows?.length) return false;
      const uid = await userId();
      if (kind === 'task') {
        const ts = new Date().toISOString(), out = rows.map(dehydrateTask), ids = rows.map(t => t.id);
        const tasks = out.map(({ row }, i) => ({ id: ids[i], user_id: uid, created_at: rows[i].created_at ?? ts, ...row }));
        // one statement: every row lands or none does, so a failure leaves the Bin entry whole
        markEcho(...ids);
        const { data, error } = await client.from('tasks').upsert(tasks, { onConflict: 'id', ignoreDuplicates: true }).select('id');
        if (error) return false;
        // after every row, as an edge can point at a later one; an edge to a task deleted since can't come back, and a live row keeps its own
        const landed = new Set(data.map(r => r.id)), rels = out.flatMap(({ task_relations }, i) => landed.has(ids[i]) ? task_relations.map(r => ({ ...r, task_id: ids[i], user_id: uid })) : []);
        for (const id of ids) if (!landed.has(id)) live?.add(id);
        if (!await upsertLive('relation', 'task_relations', rels, 'task_id,related_id,type')) return false;
        if (!await refreshTasks(ids)) { _loaded = false; _cacheV++; }   // landed; a failed refetch leaves the cache cold, so the next read re-pulls
        // a landed open subtree root reopens its done ancestors (a live one is as it was left); a failed reopen can't fail the restore
        const back = new Set(ids);
        for (const t of rows) if (landed.has(t.id) && !back.has(t.parent_id) && !t.completed_at && !t.archived_at) await reopenAncestors(t.id, uid).catch(() => {});
        return true;
      }
      const table = { area: 'areas', event: 'events', block: 'blocks', filter: 'filters', location: 'locations', scheduleItem: 'schedule_items', blockDay: 'block_days', dayNote: 'day_notes', reminder: 'reminders' }[kind];
      if (!table) return false;
      // reject_past_reminder refuses an unpaused user reminder over 26h past, reading its floating `at` as UTC: that one can't come back
      if (table === 'reminders' && !(rows = rows.filter(r => !(r.kind === 'user' && !r.paused && Date.parse(r.at + 'Z') < Date.now() - 936e5))).length) return true;
      const cols = { events: eventCols, blocks: blockCols }[table] ?? (r => r);   // the rows come from the app's lists
      const put = await upsertLive(kind, table, rows.map(r => ({ ...cols(r), user_id: uid })), 'id', live);   // a row whose parent went since stays out
      if (put?.length) { markEcho(...put.map(r => r.id)); COLL[table]?.invalidate(); if (table === 'areas') { _areasLoaded = false; _cacheV++; } }   // a restore is a bulk re-insert — refetch once, don't patch N rows
      return !!put;
    },
    filters: {
      list: () => COLL.filters.list(),
      async add({ name, query, color }) {
        return COLL.filters.insert({ name: name || 'Filter', query: query || '', color: color ?? null, position: await COLL.filters.nextPos() });
      },
      update: (id, fields) => COLL.filters.patch(id, fields),
      remove: id => COLL.filters.del(id),
      reorder: ids => COLL.filters.reorder(ids),
    },

    events: {
      list: () => COLL.events.list(),
      get: id => COLL.events.one(id),
      add: fields => COLL.events.insert({
        title: fields.title || '', notes: fields.notes ?? null,
        starts_at: fields.starts_at, ends_at: fields.ends_at, all_day: fields.all_day ?? false,
        color: fields.color ?? null, source: 'local', external_id: fields.external_id ?? null, ics_seq: fields.ics_seq ?? null,
        location_mode: fields.location?.mode ?? 'any', location_ids: fields.location?.ids ?? [],
        recurrence: fields.recurrence ?? null, countdown: !!fields.countdown,
      }),
      update: (id, fields) => COLL.events.patch(id, eventCols(pick(fields, ['title', 'notes', 'starts_at', 'ends_at', 'all_day', 'color', 'source', 'external_id', 'ics_seq', 'recurrence', 'location', 'countdown']))),
      remove: id => COLL.events.del(id),
    },

    blocks: {
      list: () => COLL.blocks.list(),
      add: fields => COLL.blocks.insert({
        title: fields.title || '', starts_at: fields.starts_at, ends_at: fields.ends_at,
        all_day: fields.all_day ?? false, location_id: fields.location_id ?? null,
        area_ids: fields.areas ?? [],
        color: fields.color ?? null, source: 'local', est_minutes: fields.est_minutes ?? null,
        recurrence: fields.recurrence ?? null,
      }),
      update: (id, fields) => COLL.blocks.patch(id, blockCols(pick(fields, ['title', 'starts_at', 'ends_at', 'all_day', 'location_id', 'color', 'source', 'est_minutes', 'recurrence', 'areas']))),
      remove: async id => { const ok = await COLL.blocks.del(id); if (ok) { COLL.schedule_items.invalidate(); COLL.reminders.invalidate(); COLL.block_days.invalidate(); } return ok; },   // and their FK cascade took these
    },

    // User-authored reminders.
    reminders: {
      list: () => COLL.reminders.list(),
      async add({ task_id, anchor, offset_minutes, at, severity, repeat, times, message }) {
        const anc = anchor || 'absolute';
        return COLL.reminders.insert({ ref_type: 'task', ref_id: task_id, kind: 'user', anchor: anc,
          offset_minutes: anc === 'absolute' ? null : (offset_minutes ?? 0), at: anc === 'absolute' ? (at ?? null) : null,
          severity: severity ?? 'ping', repeat: repeat ?? null, times: times ?? null, message: message ?? null, paused: false });
      },
      update: (id, fields) => COLL.reminders.patch(id, fields),
      remove: id => COLL.reminders.del(id),
    },

  scheduleItems: {
      list: () => COLL.schedule_items.list(),
      add: ({ task_id, block_id, role, position, date, start, duration_min }) => COLL.schedule_items.insert({
        task_id, block_id: block_id ?? null, role: role ?? 'during', position: position ?? 0,
        date: date ?? null, start: start ?? null, duration_min: duration_min ?? null,
      }),
      update: (id, fields) => COLL.schedule_items.patch(id, pick(fields, ['date', 'start', 'duration_min', 'role', 'position'])),
      remove: id => COLL.schedule_items.del(id),
      get: id => COLL.schedule_items.one(id),   // fresh, past the cache: did a remove whose answer was lost land?
    },

    dayNotes: {
      list: () => COLL.day_notes.list(),
      add: ({ date, label }) => COLL.day_notes.insert({ date, label }),
      update: (id, fields) => COLL.day_notes.patch(id, pick(fields, ['label'])),
      remove: id => COLL.day_notes.del(id),
    },

    // Per-block-per-day actuals: upsert on (user_id, block_id, date) — answering twice must not 409.
    blockDays: {
      list: () => COLL.block_days.list(),
      async set(fields) {
        const uid = await userId();
        const { data, error } = await client.from('block_days')
          .upsert({ user_id: uid, ...fields }, { onConflict: 'user_id,block_id,date' }).select('*').single();
        if (error) COLL.block_days.invalidate();   // a lost response can hide a row that landed: the next list() reads the table
        return error ? null : COLL.block_days.mine(data);
      },
      remove: id => COLL.block_days.del(id),
      update: (id, fields) => COLL.block_days.patch(id, fields),
    },

    tasks: {
      async list() {
        if (_loaded) return [..._cTasks].sort(taskSort);   // warm: the cache is authoritative — no network read
        const rows = await fetchAllTasks();
        await getSettings(); rebuildIdx();   // prime _cDef + search index for search()/runFilter()
        return [...rows].sort(taskSort);
      },
      // fresh, past the cache: the row as another device may have left it (a realtime gap). The app reads then writes.
      // ceiling: an edit landing between the read and the write is still lost — move to a conditional write
      // (.eq('updated_at', read stamp), as setChecklistItem) if users report multi-device contention.
      async get(id) {
        const { data, error } = await client.from('tasks').select(TASK_SELECT).eq('id', id).maybeSingle(); if (error) throw error;
        if (!data) { dropTasks([id]); return null; }
        const task = hydrateTask(data); putTask(task); return task;
      },

      async create(fields) {
        fields = overviewFields(fields);
        try {
          const uid = await userId(); const ts = new Date().toISOString();
          captureTz(fields);
          const rows = await taskRows();   // depth + min-position off the cache, not two full-table scans
          const parent_id = fields.parent_id !== undefined ? fields.parent_id : fields.project ? await projectId(fields.project, f => this.create(f)) : (await settings()).default_project_id ?? null;
          if (parent_id && projectDepth(rows, parent_id) >= MAX_DEPTH) return null;
          const position = fields.position ?? (rows.length ? Math.min(...rows.map(r => r.position ?? 0)) - 1 : 0);
          const rec = fields.recurrence ?? null;
          let recur_from = fields.recur_from || null;
          if (rec && !recur_from) { const seeded = seedRecurrenceDue(rec, ts); if (seeded) recur_from = seeded; }   // seeded due is rule-generated; a rule may carry its own time
          const id = fields.id ?? crypto.randomUUID();
          const row = dehydrateTask({ ...fields, content: fields.content ?? '', recur_from, parent_id, area_ids: await resolveAreaIds(fields),
            position, completed_at: null, archived_at: null, completions: [], recurrence: rec }).row;
          const { error } = await client.from('tasks').insert({ id, user_id: uid, ...row });
          if (error) return null;
          markEcho(id);
          const lost = [], linked = [fields.blocked_by?.length && await setRelationType(id, uid, 'needs', fields.blocked_by), fields.relates?.length && await setRelationType(id, uid, 'relates', fields.relates)];
          if (linked.includes(false)) lost.push('links');   // ceiling: a failed stale-edge delete reads as lost though the links landed — split setRelationType's result if users see it
          await refreshTasks([id, ...fields.relates ?? []]); await reopenAncestors(id, uid);   // the partners setRelationType mirrored onto
          let task = _cTasks.find(t => t.id === id);
          if (!task) { _loaded = false; _cacheV++; task = hydrateTask({ id, ...row, created_at: ts, updated_at: ts }); }   // stored, read back failed: the next list() re-pulls
          return lost.length ? { ...task, lost } : task;   // the caller tells the user which field didn't land
        } catch (e) { console.error('[sb] create failed', e); return null; }
      },

      async update(id, fields) {
        fields = overviewFields(fields);
        try {
          // project: null (every composer save of a root) names no project; a missing id must not leave a stray one
          if (fields.project && fields.parent_id === undefined && (await taskRows()).some(x => x.id === id)) fields.parent_id = await projectId(fields.project, f => this.create(f));
          if (fields.parent_id) { const rows = await taskRows(); if (fields.parent_id !== rows.find(x => x.id === id)?.parent_id && descendantIds(rows, id).includes(fields.parent_id)) return null; }   // unchanged parent: no cycle walk
          const uid = await userId();
          captureTz(fields);
          const curr = _cTasks.find(x => x.id === id);
          const upd = { ...pick(fields, ['content', 'notes', 'importance', 'recur_from', 'available_from', 'deadline_at', 'est_minutes', 'task_size', 'anchor', 'possible', 'starts_at', 'ends_at', 'tz', 'parent_id', 'color', 'favorite', 'place', 'position', 'completed_at', 'overview', 'milestone', 'checklist_plain', 'task_type']) };
          if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;   // one jsonb column now
          if ('location' in fields) { upd.location_mode = fields.location?.mode ?? 'any'; upd.location_ids = fields.location?.ids ?? []; }
          if ('areas' in fields || 'area_ids' in fields) upd.area_ids = await resolveAreaIds(fields);
          if ('goal_ids' in fields) upd.goal_ids = fields.goal_ids ?? [];
          if ('completions' in fields) upd.completions = fields.completions ?? [];
          if ('checklist' in fields) upd.checklist = cleanChecklist(fields.checklist);
          // edges in task_relations first: native realtime hears only tasks (Sync.kt TABLES), so the one UPDATE after them
          // (a bare touch when only links changed) makes its refetch see them. Replaced per-type when the key is present.
          const links = 'blocked_by' in fields || 'relates' in fields;
          markEcho(id);
          const rels = (!('blocked_by' in fields) || await setRelationType(id, uid, 'needs', fields.blocked_by ?? []))
            && (!('relates' in fields) || await setRelationType(id, uid, 'relates', fields.relates ?? []));
          const { error } = await taskUpdate(id, uid, links && !Object.keys(upd).length ? { updated_at: new Date().toISOString() } : upd);
          if (error) console.error('[sb] task update failed', id, error);   // a bare touch (links only) is best-effort, as touchTasks
          const failed = error && Object.keys(upd).length;
          if (failed && error.code && !links) return null;   // a PostgREST code: the server answered, and rejected it
          const verify = failed && !error.code ? upd : null;   // no code: the response, not the write, may be what failed
          // a failed part fails the save; the cache still takes what landed
          const task = await readBack(id, { ...!failed && upd, ...links && rels && { task_relations: dehydrateTask({ ...curr, ...fields }).task_relations } }, verify);
          if (verify && !task) return null;
          if (!error || verify) await reopenAncestors(id, uid).catch(e => console.error('[sb] reopen after update failed', id, e));   // landed: a follow-up can't fail it
          if ('relates' in fields) await refreshTasks([...curr?.relates ?? [], ...fields.relates ?? []]);   // setRelationType mirrored onto these partners: old and new
          return rels && (!failed || verify) ? task : null;
        } catch { return null; }
      },

      async setChecklistItem(id, itemId, done) {
        const uid = await userId(), flip = t => (t?.checklist || []).some(c => c.id === itemId) && t.checklist.map(c => c.id === itemId ? { ...c, done } : c);
        // only over the row as read: another device's edit since (the cache can miss it) matches nothing, so the flip goes
        // into the stored list — one read, and only then
        const put = t => { markEcho(id); return client.from('tasks').update({ checklist: flip(t) }).eq('id', id).eq('user_id', uid).eq('updated_at', t.updated_at).select('updated_at'); };
        let t = _cTasks.find(x => x.id === id); if (!flip(t)) return false;
        let res = await put(t);
        if (!res.error && !res.data?.length) { t = await this.get(id).catch(() => null); if (!flip(t)) return false; res = await put(t); }
        const at = !res.error && res.data?.[0]?.updated_at; if (!at) return false;
        // a new row (the app holds the old one and diffs its patch against it), from the cache as it is now: an edit landed meanwhile stays
        const now = _cTasks.find(x => x.id === id); if (now) putTask({ ...now, checklist: now.checklist.map(c => c.id === itemId ? { ...c, done } : c), updated_at: at });
        return at;   // the trigger's stamp: the caller patches its row with it
      },

      async reorder(orderedIds, at = orderedIds.map((_, i) => i)) {   // at: each id's position
        const uid = await userId();
        markEcho(...orderedIds);
        const results = await Promise.all(orderedIds.map((id, i) => client.from('tasks').update({ position: at[i] }).eq('id', id).eq('user_id', uid).select('id, updated_at')));
        if (results.some(r => r.error)) { await refreshTasks(orderedIds); return false; }   // earlier writes may have succeeded; show the server's actual order
        const pos = new Map(orderedIds.map((id, i) => [id, at[i]])), stamps = new Map(results.flatMap(r => r.data ?? []).map(r => [r.id, r.updated_at]));   // positions known, stamps returned → patch the cache, no read
        _cTasks = _cTasks.map(t => pos.has(t.id) ? { ...t, position: pos.get(t.id), updated_at: stamps.get(t.id) ?? t.updated_at } : t); rebuildIdx();
        return true;
      },

      async move(id, parentId, toIndex) {
        try {
          const uid = await userId();
          const rows = await taskRows();   // depth/cycle checks off the cache, not two full-table scans
          const t = rows.find(x => x.id === id); if (!t) return null;
          if (parentId && (parentId === id || descendantIds(rows, id).includes(parentId))) return null;
          if (parentId && projectDepth(rows, parentId) + subtreeDepth(rows, id) > MAX_DEPTH) return null;
          const oldParentId = t.parent_id;
          const ts = new Date().toISOString();
          const { error } = await client.from('tasks').update({ parent_id: parentId ?? null, position: toIndex }).eq('id', id).eq('user_id', uid);
          if (error) return null;
          markEcho(id);
          const task = await readBack(id, { parent_id: parentId ?? null, position: toIndex });
          try {   // landed: a follow-up can't fail it
            await reopenAncestors(id, uid);
            if (oldParentId && oldParentId !== (parentId ?? null)) await closeMovedOut(await taskRows(), id, oldParentId, ts, uid);
          } catch (e) { console.error('[sb] move follow-up failed', id, e); }
          return task;
        } catch (e) { console.error('[sb] move failed', e); return null; }
      },

      // id, [id, ...every row the caller journaled], or a list of those (a bulk delete): each id's subtree as cached goes, never a
      // row the caller didn't list. A group whose id is gone is skipped, and the answer is false.
      async remove(id, targetId) {
        try {
          const uid = await userId();
          const rows = await taskRows(), byId = new Map(rows.map(r => [r.id, r])), kidsOf = childIndex(rows), lists = Array.isArray(id?.[0]) ? id : [[id].flat()], groups = [], kids = [];
          for (const list of lists) {
            if (!byId.has(list[0])) continue;
            const listed = new Set(list), sub = descendantIds(rows, list[0], kidsOf), g = new Set(sub.filter(x => listed.has(x)));
            const own = [...g].flatMap(x => kidsOf.get(x) || []).filter(x => !g.has(x));
            if (own.length && (!byId.has(targetId) || sub.includes(targetId))) return false;
            groups.push([list[0], g]); kids.push(...own);
          }
          if (!groups.length) return false;
          for (const [root] of groups) if (kids.some(k => byId.get(k).parent_id === root)) {
            const { error: repErr } = await client.from('tasks').update({ parent_id: targetId }).eq('parent_id', root).eq('user_id', uid);
            if (repErr) return false;
          }
          const def = (await settings()).default_project_id;
          if (targetId && groups.some(([root]) => root === def)) await patchSettings({ default_project_id: targetId });
          const gone = groups.flatMap(([, g]) => [...g]); markEcho(...gone, ...kids);
          // The ids ride the URL: groups pack into DELETEs of ≤URL_IDS, a group never split —
          // its rows go whole or not at all. ceiling: one group past ~200 ids fails whole — an RPC taking uuid[] once a project that big fails to delete
          for (let i = 0, batch = []; i < groups.length; i++) {
            batch.push(...groups[i][1]);
            if (i < groups.length - 1 && batch.length + groups[i + 1][1].size <= URL_IDS) continue;
            const { error: delErr } = await client.from('tasks').delete().in('id', batch).eq('user_id', uid); batch = [];
            // e.g. a subtask from another device (parent_id FK is RESTRICT): the retry must read it, and a batch before it may have cascaded
            if (delErr) { _loaded = false; _cacheV++; COLL.schedule_items.invalidate(); COLL.reminders.invalidate(); return false; }
          }
          await refreshTasks(kids); dropTasks(gone);   // reparented kids changed; the removed rows leave the cache
          COLL.schedule_items.invalidate(); COLL.reminders.invalidate();   // and their FK cascade took these
          // the reopen_ancestors trigger reopened a done target under an open kid: the cache follows, as move's does (one kid: they share the target)
          const openKid = kids.find(k => !byId.get(k).completed_at && !byId.get(k).archived_at);
          if (openKid) await reopenAncestors(openKid, uid).catch(e => console.error('[sb] reopen after remove failed', openKid, e));   // landed: can't fail it
          // Same rule as move-out, over the pre-delete rows (every root still present) with the kids reparented.
          const ts = new Date().toISOString(), close = removedOutParents(kids.length ? rows.map(r => kids.includes(r.id) ? { ...r, parent_id: targetId } : r) : rows, groups, ts, def);
          if (close.length) await patchTasks(uid, close, { completed_at: ts });
          return groups.length === lists.length;
        } catch (e) { console.error('[sb] remove failed', e); return false; }
      },

      async setCompleted(id, done) {
        const uid = await userId(); const ts = new Date().toISOString();
        const rows = await taskRows().catch(() => null); if (!rows) return false;   // unloaded and unreachable: not saved
        const target = rows.find(r => r.id === id); if (!target) return false;
        if (done && inNotes(target)) return true;   // a note is reference, never done: every completing path lands here

        // Recurring: advance recur_from unless every statement ends (all-paused falls through to permanent complete).
        if (done && recActive(target.recurrence) && !target.completed_at && !rows.some(r => r.parent_id === id)) {
          const { recurrence: rec, recur_from: newDueAt, completed_at: newCompletedAt } = advanceRecurrence(target, ts);
          markEcho(id);
          const { error } = await client.from('tasks').update({ recurrence: rec, recur_from: newDueAt, completed_at: newCompletedAt }).eq('id', id).eq('user_id', uid);
          await refreshTasks([id]);
          return !error;
        }

        if (done) {
          const sweepIds = pendingSweep(rows, id);
          const toMark = [...new Set([...sweepIds, id])];
          const affected = [...toMark];
          // Recurring tasks swept by a parent completion are permanently completed — the rule is PAUSED, never destroyed.
          const recurringSwept = sweepIds.filter(sid => recActive(rows.find(x => x.id === sid)?.recurrence));
          if ((await client.from('tasks').update({ completed_at: ts }).in('id', toMark).eq('user_id', uid)).error) return false;
          // Independent writes fan out in parallel — a sweep of N tasks was N+ sequential RTTs (the felt save lag on cloud).
          const res = recurringSwept.length ? await Promise.all(recurringSwept.map(sid => client.from('tasks').update({ recurrence: pauseRecurrence(rows.find(r => r.id === sid).recurrence) }).eq('id', sid).eq('user_id', uid))) : [];
          const updatedRows = rows.map(r => toMark.includes(r.id) ? { ...r, completed_at: ts } : r);
          const pids = parentsToComplete(updatedRows, id, (await settings()).default_project_id);
          if (pids.length) {
            res.push(await client.from('tasks').update({ completed_at: ts }).in('id', pids).eq('user_id', uid));
            affected.push(...pids);
          }
          markEcho(...affected);
          await refreshTasks(affected);   // a part that failed: the cache shows what did land
          if (res.some(r => r.error)) return false;
        } else {
          markEcho(id);
          const { error } = await client.from('tasks').update({ completed_at: null }).eq('id', id).eq('user_id', uid);
          await refreshTasks([id]); if (error) return false;
          await reopenAncestors(id, uid);
        }
        return true;
      },

      // Archive: a task that can't be completed anymore. Non-destructive — pauses recurrence; echo-marked, single-row patch.
      // Excluded from sweeps/parent-walks (see store.js).
      async setArchived(id, val) {
        const uid = await userId(); const ts = new Date().toISOString();
        const rows = await taskRows().catch(() => null); if (!rows) return false;
        const t = rows.find(r => r.id === id); if (!t) return false;
        const upd = { archived_at: val ? ts : null };
        if (val && recActive(t.recurrence)) upd.recurrence = pauseRecurrence(t.recurrence);   // pause, never destroy
        markEcho(id);
        const { error } = await client.from('tasks').update(upd).eq('id', id).eq('user_id', uid);
        if (error) return false;
        await refreshTasks([id]); await reopenAncestors(id, uid);
        return true;
      },
      async link(id, otherId, type) {
        if (id === otherId) return false;
        const uid = await userId(); markEcho(id, otherId);
        if (type === 'relates') {
          const rs = await Promise.all([
            client.from('task_relations').upsert({ task_id: id, related_id: otherId, type: 'relates', user_id: uid }, { onConflict: 'task_id,related_id,type' }),
            client.from('task_relations').upsert({ task_id: otherId, related_id: id, type: 'relates', user_id: uid }, { onConflict: 'task_id,related_id,type' }),
          ]);
          await refreshTasks([id, otherId]); touchTasks(uid, [id, otherId]); if (rs.some(r => r.error)) return false;   // a half that landed still shows
        } else {
          if ((await client.from('task_relations').upsert({ task_id: id, related_id: otherId, type: 'needs', user_id: uid }, { onConflict: 'task_id,related_id,type' })).error) return false;
          await refreshTasks([id]); touchTasks(uid, [id]);
        }
        return true;
      },

      async unlink(id, otherId, type) {
        const uid = await userId(); markEcho(id, otherId);
        if (type === 'relates') {
          const [r1, r2] = await Promise.all([
            client.from('task_relations').delete().eq('task_id', id).eq('related_id', otherId).eq('type', 'relates').eq('user_id', uid),
            client.from('task_relations').delete().eq('task_id', otherId).eq('related_id', id).eq('type', 'relates').eq('user_id', uid),
          ]);
          await refreshTasks([id, otherId]); touchTasks(uid, [id, otherId]); if (r1.error || r2.error) return false;   // a half that landed still shows
        } else {
          const { error } = await client.from('task_relations').delete().eq('task_id', id).eq('related_id', otherId).eq('type', 'needs').eq('user_id', uid);
          if (error) return false;
          await refreshTasks([id]); touchTasks(uid, [id]);
        }
        return true;
      },
    },

    areas: {
      // warm: the cache is authoritative (realtime + own writes keep it current) — no network read
      async list() {
        if (_areasLoaded) return [..._cAreas].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const { data, error } = await client.from('areas').select('*').order('position'); if (error) throw error;
        _cAreas = data || []; _areasLoaded = true; rebuildIdx(); return _cAreas;
      },
      async create({ name, color }) { return ensureArea(name, color); },   // find-or-create — never a duplicate
      async update(id, fields) {
        const uid = await userId();
        if (!Object.keys(fields).length) return _cAreas.find(a => a.id === id) ?? null;   // nothing to write (an empty PATCH returns no row)
        const { data } = await client.from('areas').update(fields).eq('id', id).eq('user_id', uid).select().single();
        if (data) { markEcho(id); _cAreas = _cAreas.map(a => a.id === id ? data : a); rebuildIdx(); }
        return data ?? null;
      },
      async reorder(orderedIds) {
        const uid = await userId();
        markEcho(...orderedIds);
        const res = await Promise.all(orderedIds.map((id, i) => client.from('areas').update({ position: i }).eq('id', id).eq('user_id', uid)));
        if (res.some(r => r.error)) { _areasLoaded = false; _cacheV++; return false; }   // some may have landed: the next list() reads the real order
        const pos = new Map(orderedIds.map((id, i) => [id, i]));
        _cAreas = _cAreas.map(a => pos.has(a.id) ? { ...a, position: pos.get(a.id) } : a); rebuildIdx();
        return true;
      },
      async remove(id) {
        markEcho(id);
        const { error } = await client.rpc('delete_area', { p_id: id });   // scrubs tasks.area_ids + blocks.area_ids, then deletes
        if (!error) { _cTasks = _cTasks.map(t => t.area_ids?.includes(id) ? { ...t, area_ids: t.area_ids.filter(a => a !== id) } : t); _cAreas = _cAreas.filter(a => a.id !== id); rebuildIdx(); COLL.blocks.invalidate(); }
        return !error;
      },
    },

    locations: {
      list: () => COLL.locations.list(),
      async add({ name, icon = null, color = null, region = 'Home' }) {
        return COLL.locations.insert({ name: name || 'Location', icon, color, region, position: await COLL.locations.nextPos() });
      },
      update: (id, fields) => COLL.locations.patch(id, fields),
      async remove(id) {
        // RPC scrubs events/tasks location_ids; blocks.location_id set-null
        const { error } = await client.rpc('delete_location', { p_id: id });
        if (!error) { COLL.locations.mineDrop(id); COLL.blocks.invalidate(); COLL.events.invalidate(); _cTasks = _cTasks.map(t => t.location?.ids?.includes(id) ? { ...t, location: { ...t.location, ids: t.location.ids.filter(l => l !== id) } } : t); rebuildIdx(); }
        return !error;
      },
      reorder: ids => COLL.locations.reorder(ids),
    },

    // ONE channel over every user-scoped table: tasks refetch the changed rows, every other list patches its cache from
    // the payload. onChange(kind) names the list to re-read; own-write echoes are dropped via _echo.
    subscribe(onChange) {
      _onChange = onChange ?? null;
      if (typeof client.channel !== 'function') return;
      userId().then(uid => {
        if (!uid) return;
        const rowId = p => p?.new?.id ?? p?.old?.id;
        const isDel = p => (p.eventType || p.type) === 'DELETE';
        const on = (table, cb) => { _channel = _channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${uid}` }, cb); };
        _channel = client.channel('tasks-sync');
        on('tasks', p => {
          const rid = rowId(p);
          if (rid && _echo.has(rid)) return;   // our own write echoing back — the cache is already current
          if (!rid) _needFull = true;          // payload gap → fall back to a full refetch
          else if (isDel(p)) _pendDrop.add(rid);
          else _pendRefetch.add(rid);
          scheduleApply();
        });
        // A relation write never touches the tasks ROW, so the tasks listener above cannot see it — refetch
        // both ends (blocked_by/relates are derived from this junction).
        on('task_relations', p => {
          const r = p?.new ?? p?.old;
          if (!r) { _needFull = true; return scheduleApply(); }
          if (_echo.has(r.task_id)) return;
          _pendRefetch.add(r.task_id); _pendRefetch.add(r.related_id);
          scheduleApply();
        });
        on('areas', p => {
          const rid = rowId(p);
          if (rid && _echo.has(rid)) return;   // own area write echoing back — cache already current
          if (!rid) { client.from('areas').select('*').order('position').then(({ data }) => { if (data) { _cAreas = data; rebuildIdx(); _onChange?.('area'); } }); return; }
          if (isDel(p)) _cAreas = _cAreas.filter(a => a.id !== rid);   // patch the single row from the payload — no refetch
          else _cAreas = _cAreas.some(a => a.id === rid) ? _cAreas.map(a => a.id === rid ? p.new : a) : [..._cAreas, p.new];
          rebuildIdx(); _onChange?.('area');
        });
        // The side lists: patch the cache straight from the payload, exactly as areas does. A remote
        // change costs zero round-trips, and our own echo costs nothing at all.
        for (const [table, kind] of Object.entries(SYNC_KINDS)) {
          const c = COLL[table];
          on(table, p => {
            const rid = rowId(p);
            if (rid && _echo.has(rid)) return;    // our own write — the cache is already current
            if (!rid) c.invalidate(); else if (isDel(p)) c.drop(rid); else c.put(p.new);
            _onChange?.(kind);
          });
        }
        // Realtime is NOT a replay log: a channel that drops (sleep, tunnel, flaky wifi) resumes from NOW, so
        // anything that changed while we were gone is simply missing. A re-SUBSCRIBE after a drop therefore
        // means "you may have missed something" — drop every cache and ask for ONE re-pull. This is the only
        // scheduled reload in the app; there is no polling timer anywhere.
        _channel.subscribe(status => {
          if (status === 'SUBSCRIBED') {
            if (!_dropped) return;               // first connect — bootstrap already left us current
            _dropped = false;
            for (const c of Object.values(COLL)) c.invalidate();
            _loaded = _areasLoaded = false;      // tasks/areas too: nothing may serve a pre-gap row
            _onChange?.('all');                  // no loader owns 'all' → the app falls back to reloadAll()
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') _dropped = true;
        });
      });
    },
  };
}
