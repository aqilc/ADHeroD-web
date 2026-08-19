// Supabase adapter — same interface as createLocalStore (see store.js). Mapping helpers exported for tests.

import { descendantIds, projectDepth, subtreeDepth, pendingSweep, ancestorIds, parentsToComplete, movedOutParents, recActive, MAX_DEPTH, resolveAreaNames, searchDocs, buildFreeText, updateRecent, advanceRecurrence, pauseRecurrence, seedRecurrenceDue, sweepMovedOut, captureTz, placedMap } from './store.js';
import { makeFuzzy, buildSearchDocs, matchQuery } from './search.js';
import { nextTs } from './recovery.js';
import { isoDate } from './nlp.js';

// ─── Pure row ↔ object mapping ───────────────────────────────────────────────

export function hydrateTask(row) {
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
    claim: row.claim ?? null,
    accepts: row.accepts ?? null,
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
    sidebar: row.sidebar ?? false,
    milestone: row.milestone ?? false,
    checklist: (row.checklist ?? []).map(({ id, text, done }) => ({ id, text, done })),   // array order IS the order
    checklist_plain: row.checklist_plain ?? false,
    recurrence: row.recurrence ?? null,
    completions: row.completions ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// array order IS position; backfill missing ids
const cleanChecklist = list => (list ?? []).map(it => ({ id: it.id || crypto.randomUUID(), text: it.text, done: it.done ?? false }));

export function dehydrateTask(task) {
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
      sidebar: task.sidebar ?? false,
      milestone: task.milestone ?? false,
      checklist_plain: task.checklist_plain ?? false,
      checklist: cleanChecklist(task.checklist),
      completions: task.completions ?? [],
      recurrence: task.recurrence ?? null,
      starts_at: task.starts_at ?? null, ends_at: task.ends_at ?? null, tz: task.tz ?? null,
      claim: task.claim ?? null, accepts: task.accepts ?? null,
    },
    // task↔task edges live in one table now, discriminated by `type`.
    task_relations: [
      ...(task.blocked_by ?? []).map(related_id => ({ related_id, type: 'needs' })),
      ...(task.relates ?? []).map(related_id => ({ related_id, type: 'relates' })),
    ],
  };
}

function hydrateGoal(row) {
  return {
    id: row.id, name: row.name, identity: row.identity ?? null, identity_id: row.identity_id ?? null, cue: row.cue ?? null, log_default: row.log_default ?? null,
    color: row.color ?? null, icon: row.icon ?? null,
    targets: row.targets ?? [],
    target_date: row.target_date ?? null, favorite: row.favorite ?? false,
    archived: row.archived ?? false, position: row.position ?? 0,
    cadence: row.cadence ?? null, sustained_at: row.sustained_at ?? null, sustain_snoozed_until: row.sustain_snoozed_until ?? null,
    shape: row.shape ?? 'process', shelved_at: row.shelved_at ?? null, finished_at: row.finished_at ?? null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function hydrateEvent(row) {
  return {
    id: row.id, title: row.title, notes: row.notes ?? null,
    starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null,
    all_day: row.all_day ?? false,
    recurrence: row.recurrence ?? null,
    location: { mode: row.location_mode ?? 'any', ids: row.location_ids ?? [] },
    color: row.color ?? null, source: row.source ?? 'local', external_id: row.external_id ?? null,
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
    energy: row.energy ?? null, availability: row.availability ?? null,
    color: row.color ?? null, source: row.source ?? 'local',
    est_minutes: row.est_minutes ?? null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

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
  let _loaded = false, _areasLoaded = false, _settingsLoaded = false;
  const _uf = makeFuzzy();
  let _cIdx = buildSearchDocs([], [], null), _idxDirty = false;
  const rebuildIdx = () => { _idxDirty = true; };   // U-18: mark dirty; built lazily in search()/runFilter()
  const ensureIdx = () => { if (_idxDirty) { _cIdx = buildSearchDocs(_cTasks, _cAreas, _cDef); _idxDirty = false; } };

  // Realtime: our own writes echo back through the channel — track their ids for ~2s and skip the refetch they trigger.
  let _channel = null, _onChange = null, _applyT = null, _needFull = false, _dropped = false;
  const _echo = new Set(), _pendRefetch = new Set(), _pendDrop = new Set();   // area ids share _echo (uuids don't collide with task ids)
  const markEcho = (...ids) => { for (const id of ids) if (id) { _echo.add(id); setTimeout(() => _echo.delete(id), 2000); } };
  // ── Warm caches for the side lists ────────────────────────────────────────
  // tasks and areas have had one since the start; these seven re-read the whole table on EVERY list(), which
  // is why a "narrow" reload was still a round-trip. One collection gives them the same contract: the first
  // list() fetches, every later one is free, our own writes patch the row in place (and mark the echo so the
  // realtime bounce is a no-op), and a remote change patches from its payload — no refetch either way.
  function collection(table, { order, hydrate = r => r } = {}) {
    let rows = null;   // null = cold
    const cmp = order ? (a, b) => { const x = a[order] ?? 0, y = b[order] ?? 0; return x < y ? -1 : x > y ? 1 : 0; } : null;
    const put = (row) => {
      const h = hydrate(row);
      if (rows) { rows = rows.some(r => r.id === h.id) ? rows.map(r => r.id === h.id ? h : r) : [...rows, h]; if (cmp) rows.sort(cmp); }
      return h;
    };
    const drop = (id) => { if (rows) rows = rows.filter(r => r.id !== id); };
    return {
      async list() {
        if (rows) return rows.slice();   // warm: the cache is authoritative (own writes + realtime keep it so)
        let q = client.from(table).select('*'); if (order) q = q.order(order);
        const { data, error } = await q; if (error) throw error;
        rows = (data || []).map(hydrate); return rows.slice();
      },
      prime(list) { rows = list; },       // bootstrap already carried these — never fetch them twice
      cached() { return rows || []; },    // sync peek for render-time reads (runFilter); warm after the app's first list()
      invalidate() { rows = null; },      // a payload with no id, or a bulk write with no single row to patch
      put, drop,
      mine(row) { if (!row) return null; markEcho(row.id); return put(row); },   // our write: patch + suppress the echo
      mineDrop(id) { markEcho(id); drop(id); return true; },
      // ── The writes every side list does identically. Only the row's own columns differ, so callers pass
      // just those; user scoping, the timestamps and the cache patch belong to the collection.
      async insert(row) {
        const uid = await userId(), ts = new Date().toISOString();
        const { data, error } = await client.from(table).insert({ user_id: uid, ...row, created_at: ts, updated_at: ts }).select('*').single();
        return error ? null : this.mine(data);
      },
      async patch(id, upd) {
        const uid = await userId();
        const { data } = await client.from(table).update({ ...upd, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid).select('*').single();
        return this.mine(data);
      },
      async del(id) {
        const uid = await userId();
        const { error } = await client.from(table).delete().eq('id', id).eq('user_id', uid);
        return !error && this.mineDrop(id);
      },
      async reorder(ids) {
        const uid = await userId(), ts = new Date().toISOString();
        await Promise.all(ids.map((id, i) => { markEcho(id); return client.from(table).update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid); }));
        this.invalidate();   // a bulk position rewrite is not one row to patch
        return true;
      },
      // Next free `position`, read from the table (not the cache — it may be cold).
      async nextPos() {
        const { data } = await client.from(table).select('position').order('position', { ascending: false }).limit(1);
        return data?.length ? (data[0].position ?? 0) + 1 : 0;
      },
    };
  }
  const COLL = {
    events: collection('events', { order: 'starts_at', hydrate: hydrateEvent }),
    blocks: collection('blocks', { order: 'starts_at', hydrate: hydrateBlock }),
    goals: collection('goals', { order: 'position', hydrate: hydrateGoal }),
    filters: collection('filters', { order: 'position' }),
    locations: collection('locations', { order: 'position' }),
    schedule_items: collection('schedule_items', { order: 'position' }),
    block_days: collection('block_days'),
  };

  // table → the app-side list a change to it invalidates. tasks/areas are handled apart (they own caches).
  const SYNC_KINDS = { events: 'event', blocks: 'block', goals: 'goal', filters: 'filter',
    locations: 'location', schedule_items: 'scheduleItem', block_days: 'blockDay' };
  // Columns that may not exist before db:apply — an unknown column rejects the WHOLE update (PostgREST), so
  // strip them on that error, retry once, and remember for this session: a missing column costs its fields, never the row.
  const NEW_COLS = [];   // db:apply verified in sync; kept for error-retry shape only
  let _newColsLive = true;
  async function taskUpdateTolerant(id, uid, payload) {
    if (!_newColsLive) for (const k of NEW_COLS) delete payload[k];
    if (!Object.keys(payload).length) return { error: null };
    let res = await client.from('tasks').update(payload).eq('id', id).eq('user_id', uid);
    if (res.error && NEW_COLS.some(k => k in payload) && /column|schema/i.test(res.error.message || '')) {
      _newColsLive = false;
      for (const k of NEW_COLS) delete payload[k];
      if (!Object.keys(payload).length) return { error: null };
      res = await client.from('tasks').update(payload).eq('id', id).eq('user_id', uid);
    }
    return res;
  }
  // Debounce a burst of remote task events, then patch ONLY the touched rows (bounded refetch with the relations embed) —
  // never a full-table scan. Full refetch is the fallback for a payload with no id.
  const scheduleApply = () => { clearTimeout(_applyT); _applyT = setTimeout(async () => {
    if (_needFull) { _needFull = false; _pendRefetch.clear(); _pendDrop.clear(); await fetchAllTasks(); }
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
    const { data } = await client.from('user_settings').select('*').eq('user_id', uid).maybeSingle();
    _settings = data || {}; _cDef = _settings.default_project_id ?? null; _settingsLoaded = true;
    return _settings;
  }
  const settings = async () => _settingsLoaded ? _settings : getSettings();   // hits the network once, then cached
  async function patchSettings(fields) {
    const uid = await userId();
    _settings = { ..._settings, ...fields }; _cDef = _settings.default_project_id ?? null; _settingsLoaded = true; rebuildIdx();
    await client.from('user_settings').upsert({ user_id: uid, ...fields }, { onConflict: 'user_id' });
  }

  // task_relations is the only junction left; its two FKs to tasks need the FK hint to disambiguate.
  const TASK_SELECT = '*, task_relations!task_relations_task_id_fkey(related_id, type)';

  const taskSort = (x, y) => (x.position ?? 0) - (y.position ?? 0) || (y.created_at || '').localeCompare(x.created_at || '');
  async function fetchTask(id) {
    const { data } = await client.from('tasks').select(TASK_SELECT).eq('id', id).single();
    return data ? hydrateTask(data) : null;
  }
  async function fetchAllTasks() {
    const { data } = await client.from('tasks').select(TASK_SELECT).order('position');
    _cTasks = (data || []).map(hydrateTask); _loaded = true; return _cTasks;
  }
  const taskRows = async () => _loaded ? _cTasks : await fetchAllTasks();
  // splice into cache (replace by id, else append) — avoids a second full fetch
  const putTask = (task) => {
    if (!task) return;
    _cTasks = _cTasks.some(t => t.id === task.id) ? _cTasks.map(t => t.id === task.id ? task : t) : [..._cTasks, task];
    rebuildIdx();
  };
  // one bounded round-trip — for cascade mutations
  async function refreshTasks(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return;
    const { data } = await client.from('tasks').select(TASK_SELECT).in('id', uniq);
    for (const r of data || []) putTask(hydrateTask(r));
  }
  const dropTasks = (ids) => { const s = new Set(ids); _cTasks = _cTasks.filter(t => !s.has(t.id)); rebuildIdx(); };

  // Find-or-create an area by TRIMMED name, reusing an existing one instead of ever inserting a duplicate.
  // Cache hit wins; on a stale-cache unique clash (another device already created it — the DB's
  // areas_user_name_idx forbids same-owner dupes) refetch that row and reuse it.
  async function ensureArea(name, color = null) {
    const nm = (name ?? '').trim();
    const cached = _cAreas.find(a => a.name === nm);
    if (cached) return cached;
    const uid = await userId();
    const pos = _cAreas.length ? Math.max(..._cAreas.map(a => a.position ?? 0)) + 1 : 0;
    const ts = new Date().toISOString();
    const { data, error } = await client.from('areas').insert({ user_id: uid, name: nm, color: color ?? null, icon: null, position: pos, favorite: false, created_at: ts, updated_at: ts }).select().single();
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

  // replaces one edge-type in task_relations; 'relates' is symmetric so mirrors are written/deleted too
  async function setRelationType(id, uid, type, ids) {
    if (type === 'relates') {
      await Promise.all([
        client.from('task_relations').delete().eq('task_id', id).eq('type', 'relates').eq('user_id', uid),
        client.from('task_relations').delete().eq('related_id', id).eq('type', 'relates').eq('user_id', uid),
      ]);
      if (ids.length) await client.from('task_relations').insert([
        ...ids.map(related_id => ({ task_id: id, related_id, type: 'relates', user_id: uid })),
        ...ids.map(related_id => ({ task_id: related_id, related_id: id, type: 'relates', user_id: uid })),
      ]);
    } else {
      await client.from('task_relations').delete().eq('task_id', id).eq('type', type);
      if (ids.length) await client.from('task_relations').insert(ids.map(related_id => ({ task_id: id, related_id, type, user_id: uid })));
    }
  }

  return {
    requiresAuth: true,

    // one round-trip via bootstrap RPC; primes caches
    async bootstrap() {
      const { data } = await client.rpc('bootstrap');
      const d = data || {};
      _settings = d.settings || {}; _cDef = _settings.default_project_id ?? null; _settingsLoaded = true;
      const relByTask = {};
      for (const r of d.task_relations || []) (relByTask[r.task_id] ||= []).push(r);
      _cTasks = (d.tasks || []).map(t => hydrateTask({ ...t, task_relations: relByTask[t.id] || [] }));
      _cAreas = d.areas || []; _loaded = true; _areasLoaded = true; rebuildIdx();
      // The RPC already carried these — prime the caches from it rather than letting the first list() refetch
      // what we are holding in our hand. This is what makes bootstrap a COLD START instead of a poll.
      const out = { goals: (d.goals || []).map(hydrateGoal), filters: d.filters || [], locations: d.locations || [],
        events: (d.events || []).map(hydrateEvent), blocks: (d.blocks || []).map(hydrateBlock) };
      for (const k of ['goals', 'filters', 'locations', 'events', 'blocks']) COLL[k].prime(out[k].slice());
      return { ...out, tasks: [..._cTasks].sort(taskSort), areas: _cAreas };
    },

    // sync reads from cache (matches LocalStore; called during render)
    defaultProject() { return _settings.default_project_id ?? null; },
    async setDefaultProject(id) { await patchSettings({ default_project_id: id }); },
    search(query, limit = 50) { ensureIdx(); return searchDocs(query, limit, _uf, _cIdx, _settings.recent ?? []); },
    recordSearchPick(id) {
      const recent = updateRecent(id, _settings.recent);
      _settings = { ..._settings, recent }; patchSettings({ recent });   // sync cache update + fire-and-forget persist
    },
    runFilter(query, limit = 200) {
      ensureIdx(); return matchQuery(query, _cTasks, { now: new Date().toISOString(), areas: _cAreas, defaultProjectId: _cDef, placed: placedMap(COLL.schedule_items.cached()), freeText: buildFreeText(_uf, _cIdx, _cTasks) }).slice(0, limit);
    },

    homeLocationId() { return _settings.home_location_id ?? null; },   // designated "home" place ("at home" NLP)
    async setHomeLocation(id) { await patchSettings({ home_location_id: _settings.home_location_id === id ? null : id }); },
    currentRegion() { return _settings.current_region ?? 'Home'; },

    // Trash restore: re-insert previously-deleted rows (upsert on id → deduped/idempotent). Powers "Recently deleted".
    async reinsert(kind, rows) {
      if (!rows?.length) return false;
      const uid = await userId();
      if (kind === 'task') {
        for (const t of rows) {
          const { row, task_relations } = dehydrateTask(t);
          if ((await client.from('tasks').upsert({ id: t.id, user_id: uid, created_at: t.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString(), ...row }, { onConflict: 'id' })).error) return false;
          if (task_relations.length) await client.from('task_relations').upsert(task_relations.map(r => ({ ...r, task_id: t.id, user_id: uid })), { onConflict: 'task_id,related_id,type' });
        }
        await fetchAllTasks(); return true;
      }
      const table = { area: 'areas', goal: 'goals', event: 'events', block: 'blocks', filter: 'filters', location: 'locations', scheduleItem: 'schedule_items', blockDay: 'block_days' }[kind];
      if (!table) return false;
      const { error } = await client.from(table).upsert(rows.map(r => ({ ...r, user_id: uid })), { onConflict: 'id' });
      if (!error) { markEcho(...rows.map(r => r.id)); COLL[table]?.invalidate(); }   // a restore is a bulk re-insert — refetch once, don't patch N rows
      return !error;
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
      add: fields => COLL.events.insert({
        title: fields.title || '', notes: fields.notes ?? null,
        starts_at: fields.starts_at, ends_at: fields.ends_at, all_day: fields.all_day ?? false,
        color: fields.color ?? null, source: 'local', external_id: null,
        location_mode: fields.location?.mode ?? 'any', location_ids: fields.location?.ids ?? [],
        recurrence: fields.recurrence ?? null,
      }),
      update(id, fields) {
        const upd = pick(fields, ['title', 'notes', 'starts_at', 'ends_at', 'all_day', 'color', 'source', 'external_id']);
        if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;
        if ('location' in fields) { upd.location_mode = fields.location?.mode ?? 'any'; upd.location_ids = fields.location?.ids ?? []; }
        return COLL.events.patch(id, upd);
      },
      remove: id => COLL.events.del(id),
    },

    blocks: {
      list: () => COLL.blocks.list(),
      add: fields => COLL.blocks.insert({
        title: fields.title || '', starts_at: fields.starts_at, ends_at: fields.ends_at,
        all_day: fields.all_day ?? false, location_id: fields.location_id ?? null,
        area_ids: fields.areas ?? [],
        energy: fields.energy ?? null, availability: fields.availability ?? null, color: fields.color ?? null, source: 'local',
        recurrence: fields.recurrence ?? null,
      }),
      update(id, fields) {
        const upd = pick(fields, ['title', 'starts_at', 'ends_at', 'all_day', 'location_id', 'energy', 'availability', 'color', 'source', 'est_minutes']);
        if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;
        if ('areas' in fields) upd.area_ids = fields.areas ?? [];
        return COLL.blocks.patch(id, upd);
      },
      remove: id => COLL.blocks.del(id),
    },

    scheduleItems: {
      list: () => COLL.schedule_items.list(),
      add: ({ task_id, block_id, role, position, date, start, duration_min }) => COLL.schedule_items.insert({
        task_id, block_id: block_id ?? null, role: role ?? 'during', position: position ?? 0,
        date: date ?? null, start: start ?? null, duration_min: duration_min ?? null,
      }),
      update: (id, fields) => COLL.schedule_items.patch(id, pick(fields, ['date', 'start', 'duration_min', 'role', 'position'])),
      remove: id => COLL.schedule_items.del(id),
      setRole: (id, role) => COLL.schedule_items.patch(id, { role }),
    },

    // Per-block-per-day actuals: upsert on (user_id, block_id, date) — answering twice must not 409.
    blockDays: {
      list: () => COLL.block_days.list(),
      async set(fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const { data, error } = await client.from('block_days')
          .upsert({ user_id: uid, ...fields, updated_at: ts }, { onConflict: 'user_id,block_id,date' })
          .select('*').single();
        if (error) throw error;
        return COLL.block_days.mine(data);
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

      async create(fields) {
        try {
          const uid = await userId(); const ts = new Date().toISOString();
          captureTz(fields);
          const rows = await taskRows();   // depth + min-position off the cache, not two full-table scans
          // TODO(parity): no `fields.project` name-resolution (LocalStore auto-creates a root task)
          const parent_id = fields.parent_id !== undefined ? fields.parent_id : (await settings()).default_project_id ?? null;
          if (parent_id && projectDepth(rows, parent_id) >= MAX_DEPTH) return null;
          const position = rows.length ? Math.min(...rows.map(r => r.position ?? 0)) - 1 : 0;
          const rec = fields.recurrence ?? null;
          let recur_from = fields.recur_from || null;
          if (rec && !recur_from) { const seeded = seedRecurrenceDue(rec, ts); if (seeded) recur_from = seeded; }   // seeded due is rule-generated; a rule may carry its own time
          const id = crypto.randomUUID();
          const { error } = await client.from('tasks').insert({
            id, user_id: uid, content: fields.content ?? '', notes: fields.notes ?? null,
            recur_from, deadline_at: fields.deadline_at ?? null,
            est_minutes: fields.est_minutes ?? null,
            parent_id, color: fields.color ?? null, favorite: fields.favorite ?? false,
            place: fields.place ?? null,
            location_mode: fields.location?.mode ?? 'any', location_ids: fields.location?.ids ?? [],
            area_ids: await resolveAreaIds(fields), goal_ids: fields.goal_ids ?? [],
            position, completed_at: null, archived_at: null, sidebar: fields.sidebar ?? false,
            milestone: fields.milestone ?? false,
            available_from: fields.available_from ?? null, task_size: fields.task_size ?? null,
            anchor: fields.anchor ?? null, possible: fields.possible ?? null,
            starts_at: fields.starts_at ?? null, ends_at: fields.ends_at ?? null, tz: fields.tz ?? null,
            claim: fields.claim ?? null, accepts: fields.accepts ?? null,
            // checklist_plain / importance sent via follow-up update (may be missing on older DBs; keeps the row safe)
            checklist: cleanChecklist(fields.checklist), completions: [], recurrence: rec,
            created_at: ts, updated_at: ts,
          });
          if (error) return null;
          // …and they MUST still be written, or a signed-in user's importance chip is set in the composer and
          // silently gone on Save. Separate statement so a pre-migration column costs these fields, not the task.
          const post = {};
          if (fields.importance && fields.importance !== 'none') post.importance = fields.importance;
          if (fields.checklist_plain) post.checklist_plain = true;
          if (Object.keys(post).length) await taskUpdateTolerant(id, uid, post);
          markEcho(id);
          if (fields.blocked_by?.length) await setRelationType(id, uid, 'needs', fields.blocked_by);
          if (fields.relates?.length) await setRelationType(id, uid, 'relates', fields.relates);
          const task = await fetchTask(id); putTask(task);
          return task;
        } catch (e) { console.error('[sb] create failed', e); return null; }
      },

      async update(id, fields) {
        try {
          const uid = await userId(); const ts = new Date().toISOString();
          captureTz(fields);
          const curr = _cTasks.find(x => x.id === id);
          const upd = { updated_at: nextTs(ts, curr?.updated_at), ...pick(fields, ['content', 'notes', 'importance', 'recur_from', 'available_from', 'deadline_at', 'est_minutes', 'task_size', 'anchor', 'possible', 'starts_at', 'ends_at', 'tz', 'claim', 'accepts', 'parent_id', 'color', 'favorite', 'place', 'position', 'completed_at', 'sidebar', 'milestone', 'checklist_plain']) };
          if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;   // one jsonb column now
          if ('location' in fields) { upd.location_mode = fields.location?.mode ?? 'any'; upd.location_ids = fields.location?.ids ?? []; }
          if ('areas' in fields || 'area_ids' in fields) upd.area_ids = await resolveAreaIds(fields);
          if ('goal_ids' in fields) upd.goal_ids = fields.goal_ids ?? [];
          if ('completions' in fields) upd.completions = fields.completions ?? [];
          if ('checklist' in fields) upd.checklist = cleanChecklist(fields.checklist);
          const { error } = await taskUpdateTolerant(id, uid, upd);
          if (error) return null;
          markEcho(id);
          // edges in task_relations; replace per-type when key is present
          if ('blocked_by' in fields) await setRelationType(id, uid, 'needs', fields.blocked_by ?? []);
          if ('relates' in fields) await setRelationType(id, uid, 'relates', fields.relates ?? []);
          const task = await fetchTask(id); putTask(task);
          return task;
        } catch { return null; }
      },

      async setChecklistItem(id, itemId, done) {
        const uid = await userId();
        const t = _cTasks.find(x => x.id === id); if (!t) return false;
        const checklist = (t.checklist || []).map(c => c.id === itemId ? { ...c, done } : c);
        markEcho(id);
        await client.from('tasks').update({ checklist, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid);
        const it = (t.checklist || []).find(c => c.id === itemId); if (it) { it.done = done; rebuildIdx(); }
        return true;
      },

      async reorder(orderedIds) {
        const uid = await userId(), ts = new Date().toISOString();
        markEcho(...orderedIds);
        await Promise.all(orderedIds.map((id, i) => client.from('tasks').update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid)));
        const pos = new Map(orderedIds.map((id, i) => [id, i]));   // positions known → patch the cache, no read
        _cTasks = _cTasks.map(t => pos.has(t.id) ? { ...t, position: pos.get(t.id) } : t); rebuildIdx();
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
          await client.from('tasks').update({ parent_id: parentId ?? null, position: toIndex, updated_at: ts }).eq('id', id).eq('user_id', uid);
          markEcho(id);
          const task = await fetchTask(id); putTask(task);
          // Auto-complete old parent chain after move-out.
          if (oldParentId && oldParentId !== (parentId ?? null)) {
            const updatedRows = await taskRows();
            const toComplete = movedOutParents(updatedRows, id, oldParentId, ts);
            if (toComplete.length) {
              markEcho(...toComplete);
              await client.from('tasks').update({ completed_at: ts, updated_at: ts }).in('id', toComplete).eq('user_id', uid);
              await sweepMovedOut(toComplete, updatedRows, ts, async () => {});
              await refreshTasks(toComplete);
            }
          }
          return task;
        } catch (e) { console.error('[sb] move failed', e); return null; }
      },

      async remove(id, targetId) {
        try {
          const uid = await userId();
          const rows = await taskRows();
          const task = rows.find(r => r.id === id); if (!task) return false;
          const oldParentId = task.parent_id;
          const kids = rows.filter(r => r.parent_id === id).map(r => r.id);
          if (kids.length) {
            if (!targetId || !rows.some(r => r.id === targetId)) return false;
            if (descendantIds(rows, id).includes(targetId)) return false;
            const { error: repErr } = await client.from('tasks').update({ parent_id: targetId, updated_at: new Date().toISOString() }).eq('parent_id', id).eq('user_id', uid);
            if (repErr) return false;
          }
          if ((await settings()).default_project_id === id && targetId) await patchSettings({ default_project_id: targetId });
          markEcho(id, ...kids);
          const { error: delErr } = await client.from('tasks').delete().eq('id', id).eq('user_id', uid);
          if (delErr) return false;
          await refreshTasks(kids); dropTasks([id]);   // reparented kids changed; the removed row leaves the cache
          // Auto-complete old parent chain after id is removed (same rule as move-out).
          // Use rows with kids virtually reparented; id still present for movedOutParents logic.
          const ts = new Date().toISOString();
          if (oldParentId) {
            const preRows = kids.length ? rows.map(r => kids.includes(r.id) ? { ...r, parent_id: targetId } : r) : rows;
            const toComplete = movedOutParents(preRows, id, oldParentId, ts);
            if (toComplete.length) {
              markEcho(...toComplete);
              await client.from('tasks').update({ completed_at: ts, updated_at: ts }).in('id', toComplete).eq('user_id', uid);
              await sweepMovedOut(toComplete, preRows, ts, async () => {});
              await refreshTasks(toComplete);
            }
          }
          return true;
        } catch (e) { console.error('[sb] remove failed', e); return false; }
      },

      async setCompleted(id, done) {
        const uid = await userId(); const ts = new Date().toISOString();
        const rows = await taskRows();
        const target = rows.find(r => r.id === id); if (!target) return false;

        // Recurring: advance recur_from unless every statement ends (all-paused falls through to permanent complete).
        if (done && recActive(target.recurrence) && !target.completed_at && !rows.some(r => r.parent_id === id)) {
          const { recurrence: rec, recur_from: newDueAt, completed_at: newCompletedAt } = advanceRecurrence(target, ts);
          markEcho(id);
          await client.from('tasks').update({ recurrence: rec, recur_from: newDueAt, completed_at: newCompletedAt, updated_at: ts }).eq('id', id).eq('user_id', uid);
          await refreshTasks([id]);
          return true;
        }

        if (done) {
          const sweepIds = pendingSweep(rows, id);
          const toMark = [...new Set([...sweepIds, id])];
          const affected = [...toMark];
          // Recurring tasks swept by a parent completion are permanently completed — the rule is PAUSED, never destroyed.
          const recurringSwept = sweepIds.filter(sid => recActive(rows.find(x => x.id === sid)?.recurrence));
          await client.from('tasks').update({ completed_at: ts, updated_at: ts }).in('id', toMark).eq('user_id', uid);
          // Independent writes fan out in parallel — a sweep of N tasks was N+ sequential RTTs (the felt save lag on cloud).
          if (recurringSwept.length) await Promise.all(recurringSwept.map(sid => client.from('tasks').update({ recurrence: pauseRecurrence(rows.find(r => r.id === sid).recurrence), updated_at: ts }).eq('id', sid).eq('user_id', uid)));
          const updatedRows = rows.map(r => toMark.includes(r.id) ? { ...r, completed_at: ts } : r);
          const pids = parentsToComplete(updatedRows, id);
          if (pids.length) {
            await client.from('tasks').update({ completed_at: ts, updated_at: ts }).in('id', pids).eq('user_id', uid);
            affected.push(...pids);
          }
          markEcho(...affected);
          await refreshTasks(affected);
        } else {
          const ancestors = ancestorIds(rows, id);
          const toUnmark = [id, ...ancestors];
          markEcho(...toUnmark);
          await client.from('tasks').update({ completed_at: null, updated_at: ts }).in('id', toUnmark).eq('user_id', uid);
          await refreshTasks(toUnmark);
        }
        return true;
      },

      // Archive: a task that can't be completed anymore. Non-destructive — pauses recurrence, logs archive/unarchive
      // (guarded like complete), echo-marked, single-row patch. Excluded from sweeps/parent-walks (see store.js).
      async setArchived(id, val) {
        const uid = await userId(); const ts = new Date().toISOString();
        const rows = await taskRows();
        const t = rows.find(r => r.id === id); if (!t) return false;
        const was = t.archived_at;
        const upd = { archived_at: val ? ts : null, updated_at: ts };
        if (val && recActive(t.recurrence)) upd.recurrence = pauseRecurrence(t.recurrence);   // pause, never destroy
        markEcho(id);
        await client.from('tasks').update(upd).eq('id', id).eq('user_id', uid);
        await refreshTasks([id]);
        return true;
      },
      async link(id, otherId, type) {
        if (id === otherId) return false;
        const uid = await userId();
        if (type === 'relates') {
          await Promise.all([
            client.from('task_relations').upsert({ task_id: id, related_id: otherId, type: 'relates', user_id: uid }, { onConflict: 'task_id,related_id,type' }),
            client.from('task_relations').upsert({ task_id: otherId, related_id: id, type: 'relates', user_id: uid }, { onConflict: 'task_id,related_id,type' }),
          ]);
          await refreshTasks([id, otherId]);
        } else {
          await client.from('task_relations').upsert({ task_id: id, related_id: otherId, type: 'needs', user_id: uid }, { onConflict: 'task_id,related_id,type' });
          await refreshTasks([id]);
        }
        return true;
      },

      async unlink(id, otherId, type) {
        const uid = await userId();
        if (type === 'relates') {
          const [r1, r2] = await Promise.all([
            client.from('task_relations').delete().eq('task_id', id).eq('related_id', otherId).eq('type', 'relates').eq('user_id', uid),
            client.from('task_relations').delete().eq('task_id', otherId).eq('related_id', id).eq('type', 'relates').eq('user_id', uid),
          ]);
          if (r1.error || r2.error) return false;
          await refreshTasks([id, otherId]);
        } else {
          const { error } = await client.from('task_relations').delete().eq('task_id', id).eq('related_id', otherId).eq('type', 'needs').eq('user_id', uid);
          if (error) return false;
          await refreshTasks([id]);
        }
        return true;
      },
    },

    areas: {
      // warm: the cache is authoritative (realtime + own writes keep it current) — no network read
      async list() {
        if (_areasLoaded) return [..._cAreas].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const { data } = await client.from('areas').select('*').order('position'); _cAreas = data || []; _areasLoaded = true; rebuildIdx(); return _cAreas;
      },
      async create({ name, color }) { return ensureArea(name, color); },   // find-or-create — never a duplicate
      async update(id, fields) {
        const uid = await userId();
        const { data } = await client.from('areas').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid).select().single();
        if (data) { markEcho(id); _cAreas = _cAreas.map(a => a.id === id ? data : a); rebuildIdx(); }
        return data ?? null;
      },
      async reorder(orderedIds) {
        const uid = await userId(), ts = new Date().toISOString();
        markEcho(...orderedIds);
        await Promise.all(orderedIds.map((id, i) => client.from('areas').update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid)));
        const pos = new Map(orderedIds.map((id, i) => [id, i]));
        _cAreas = _cAreas.map(a => pos.has(a.id) ? { ...a, position: pos.get(a.id) } : a); rebuildIdx();
        return true;
      },
      async remove(id) {
        markEcho(id);
        const { error } = await client.rpc('delete_area', { p_id: id });   // scrubs tasks.area_ids + blocks.area_ids, then deletes
        if (!error) { _cTasks = _cTasks.map(t => t.area_ids?.includes(id) ? { ...t, area_ids: t.area_ids.filter(a => a !== id) } : t); _cAreas = _cAreas.filter(a => a.id !== id); rebuildIdx(); }
        return !error;
      },
    },

    goals: {
      list: () => COLL.goals.list(),
      async create(fields) {
        return COLL.goals.insert({ name: fields.name || 'Goal', identity: fields.identity ?? null, identity_id: fields.identity_id ?? null, cue: fields.cue ?? null, log_default: fields.log_default ?? null, color: fields.color ?? null, icon: fields.icon ?? null, target_date: fields.target_date ?? null, favorite: fields.favorite ?? false, archived: fields.archived ?? false, position: fields.position ?? await COLL.goals.nextPos(), cadence: fields.cadence ?? null, targets: fields.targets ?? [], sustained_at: fields.sustained_at ?? null, sustain_snoozed_until: fields.sustain_snoozed_until ?? null, shape: fields.shape ?? 'process', shelved_at: fields.shelved_at ?? null, finished_at: fields.finished_at ?? null });
      },
      update(id, fields) {
        const upd = pick(fields, ['name', 'identity', 'identity_id', 'cue', 'log_default', 'color', 'icon', 'target_date', 'favorite', 'archived', 'position', 'cadence', 'sustained_at', 'sustain_snoozed_until', 'shape', 'shelved_at', 'finished_at']);
        if ('targets' in fields) upd.targets = fields.targets ?? [];   // jsonb column now
        return COLL.goals.patch(id, upd);
      },
      reorder: ids => COLL.goals.reorder(ids),
      async remove(id) {
        const { error } = await client.rpc('delete_goal', { p_id: id });   // scrubs tasks.goal_ids, then deletes
        if (!error) { COLL.goals.mineDrop(id); _cTasks = _cTasks.map(t => t.goal_ids?.includes(id) ? { ...t, goal_ids: t.goal_ids.filter(g => g !== id) } : t); rebuildIdx(); }
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
        if (!error) { COLL.locations.mineDrop(id); _cTasks = _cTasks.map(t => t.location?.ids?.includes(id) ? { ...t, location: { ...t.location, ids: t.location.ids.filter(l => l !== id) } } : t); rebuildIdx(); }
        return !error;
      },
      reorder: ids => COLL.locations.reorder(ids),
    },

    // ONE channel over EVERY user-scoped table. It used to carry tasks and areas only — which is exactly why a
    // delete still had to re-pull the whole account: nothing told the client that its schedule items had gone
    // with the task. onChange(kind) names the list to re-read; own-write echoes are suppressed via _echo.
    // tasks and areas patch their caches here (the two the app reads on the hot path); the rest have no cache
    // yet, so their event just names the kind — still the point, since the change TELLS us instead of us asking.
    // Matches Android Sync.kt channel "realtime:tasks"; guards against test fakes with no .channel().
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
        // The seven side lists: patch the cache straight from the payload, exactly as areas does. A remote
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
    unsubscribe() {
      clearTimeout(_applyT);
      if (_channel) { _channel.unsubscribe?.(); client.removeChannel?.(_channel); _channel = null; }
      _onChange = null;
    },
  };
}
