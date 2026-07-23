// Supabase adapter — same interface as createLocalStore (see store.js). Mapping helpers exported for tests.

import { descendantIds, projectDepth, subtreeDepth, pendingSweep, ancestorIds, parentsToComplete, movedOutParents, nextOccurrence, nextAcrossRules, recRules, recActive, MAX_DEPTH } from './store.js';
import { makeFuzzy, buildSearchDocs, rankDocs, defaultDocs, matchQuery } from './search.js';
import { isoDate } from './nlp.js';

// ─── Pure row ↔ object mapping ───────────────────────────────────────────────

export function hydrateTask(row) {
  const rel = row.task_relations ?? [];   // sole embed; split by type into blocked_by/relates
  return {
    id: row.id,
    content: row.content,
    notes: row.notes ?? null,
    priority: row.priority ?? 4,
    due_at: row.due_at ?? null,
    deadline_at: row.deadline_at ?? null,
    scheduled_at: row.scheduled_at ?? null,
    est_minutes: row.est_minutes ?? null,
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
    blocked_by: rel.filter(r => r.type === 'blocks').map(r => r.related_id),
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
      priority: task.priority ?? 4,
      due_at: task.due_at ?? null,
      deadline_at: task.deadline_at ?? null,
      scheduled_at: task.scheduled_at ?? null,
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
      checklist: cleanChecklist(task.checklist),
      completions: task.completions ?? [],
      recurrence: task.recurrence ?? null,
    },
    // task↔task edges live in one table now, discriminated by `type`.
    task_relations: [
      ...(task.blocked_by ?? []).map(related_id => ({ related_id, type: 'blocks' })),
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
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// ─── Store factory ────────────────────────────────────────────────────────────

export function createSupabaseStore(client) {
  let _uid = null;
  async function userId() {
    if (!_uid) { const { data } = await client.auth.getUser(); _uid = data.user?.id; }
    return _uid;
  }

  // once warm, list() is a cache hit; mutations refetch only affected rows
  let _settings = {}, _cTasks = [], _cAreas = [], _cDef = null, _cActs = [];
  let _loaded = false, _areasLoaded = false, _settingsLoaded = false, _actsLoaded = false;
  const _uf = makeFuzzy();
  let _cIdx = buildSearchDocs([], [], null);
  const rebuildIdx = () => { _cIdx = buildSearchDocs(_cTasks, _cAreas, _cDef); };

  // Realtime: our own writes echo back through the channel — track their ids for ~2s and skip the refetch they trigger.
  let _channel = null, _onChange = null, _applyT = null, _needFull = false;
  const _echo = new Set(), _pendRefetch = new Set(), _pendDrop = new Set();   // area ids share _echo (uuids don't collide with task ids)
  const markEcho = (...ids) => { for (const id of ids) if (id) { _echo.add(id); setTimeout(() => _echo.delete(id), 2000); } };
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
    _onChange?.('tasks');
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

  // fields.areas (names) → area ids, mirroring LocalStore.resolveAreas: prefer explicit area_ids, else match
  // cached area names and auto-create any missing ones (inserting the area + syncing the cache).
  async function resolveAreaIds(fields) {
    if (fields.area_ids) return fields.area_ids;
    const names = fields.areas;
    if (!names || !names.length) return [];
    const uid = await userId();
    const ids = [];
    for (const name of names) {
      let a = _cAreas.find(x => x.name === name);
      if (!a) {
        const ts = new Date().toISOString();
        const pos = _cAreas.length ? Math.max(..._cAreas.map(x => x.position ?? 0)) + 1 : 0;
        const { data } = await client.from('areas').insert({ user_id: uid, name, color: null, icon: null, position: pos, favorite: false, created_at: ts, updated_at: ts }).select().single();
        a = data; if (a) { markEcho(a.id); _cAreas = [..._cAreas, a]; rebuildIdx(); }
      }
      if (a) ids.push(a.id);
    }
    return ids;
  }

  // cold-loaded once; sorted ascending to survive back-dated entries
  async function activityList() {
    if (!_actsLoaded) { const { data } = await client.from('activity').select('*').order('ts'); _cActs = data || []; _actsLoaded = true; }
    return [..._cActs].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  }
  // id assigned client-side so cache + DB agree (uncomplete voids a specific row by id)
  async function insertActivity(row) {
    const full = { id: crypto.randomUUID(), ...row };
    await client.from('activity').insert(full); _cActs.push({ ...full }); return full;
  }

  async function pushActivity(type, task) {
    if (!task) return;
    const uid = await userId();
    // TODO(parity): LocalStore uses effectiveGoalIds(rows, t.id) for ctx.goal_ids (inherited from ancestors).
    await insertActivity({
      user_id: uid, type, ts: new Date().toISOString(),
      subject_type: 'task', subject_id: task.id, void: false,
      ctx: { project_id: task.parent_id ?? null, area_ids: task.area_ids ?? [], place: task.place ?? null, priority: task.priority ?? 4, est_minutes: task.est_minutes ?? null, goal_ids: task.goal_ids ?? [], milestone: task.milestone ?? false },
    });
  }

  // replaces one edge-type in task_relations (the only junction write left)
  async function setRelationType(id, uid, type, ids) {
    await client.from('task_relations').delete().eq('task_id', id).eq('type', type);
    if (ids.length) await client.from('task_relations').insert(ids.map(related_id => ({ task_id: id, related_id, type, user_id: uid })));
  }

  // one-time: identity strings → entities; flag only on full success (DB error → retry)
  async function migrateIdentities(goals) {
    const s = await settings();
    if (s.identity_migrated) return;
    const uid = await userId(); const ts = new Date().toISOString();
    const { data: existing } = await client.from('identities').select('*');
    const byStatement = new Map((existing || []).map(i => [i.statement, i]));
    let maxPos = (existing || []).reduce((m, i) => Math.max(m, i.position ?? 0), -1);
    for (const g of goals) {
      const st = (g.identity || '').trim();
      if (!st || g.identity_id) continue;
      let ent = byStatement.get(st);
      if (!ent) {
        maxPos++;
        const { data: newEnt, error: insErr } = await client.from('identities').insert({ user_id: uid, statement: st, position: maxPos, created_at: ts, updated_at: ts }).select('*').single();
        if (insErr) throw insErr;   // abort so flag stays unset → retry
        ent = newEnt; byStatement.set(st, ent);
      }
      const { error: updErr } = await client.from('goals').update({ identity_id: ent.id, updated_at: ts }).eq('id', g.id).eq('user_id', uid);
      if (updErr) throw updErr;
      g.identity_id = ent.id;   // mutate in-place so bootstrap payload carries the new id
    }
    await patchSettings({ identity_migrated: true });
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
      const goals = (d.goals || []).map(hydrateGoal);
      try { await migrateIdentities(goals); } catch (e) { console.error('[goals] identity migration failed:', e); }   // awaited: first render sees identity_ids; flag stays unset on error
      return {
        tasks: [..._cTasks].sort(taskSort), areas: _cAreas,
        goals, filters: d.filters || [], locations: d.locations || [],
        travel: (d.travel_times || []).map(r => ({ from: r.from_location_id, to: r.to_location_id, minutes: r.minutes })),
        events: (d.events || []).map(hydrateEvent), blocks: (d.blocks || []).map(hydrateBlock),
      };
    },

    // sync reads from cache (matches LocalStore; called during render)
    defaultProject() { return _settings.default_project_id ?? null; },
    async setDefaultProject(id) { await patchSettings({ default_project_id: id }); },
    globalTargets() { return _settings.global_targets ?? []; },
    async setGlobalTargets(targets) { await patchSettings({ global_targets: targets ?? [] }); },

    search(query, limit = 50) {
      return (query || '').trim()
        ? rankDocs(_uf, _cIdx.haystack, _cIdx.meta, query, limit)
        : defaultDocs(_cIdx.meta, _settings.recent ?? [], limit);
    },
    recordSearchPick(id) {
      const recent = [id, ...(_settings.recent || []).filter(x => x !== id)].slice(0, 12);
      _settings = { ..._settings, recent }; patchSettings({ recent });   // sync cache update + fire-and-forget persist
    },
    runFilter(query, limit = 200) {
      const freeText = (term, scope) => {
        const [idxs] = _uf.search(_cIdx.haystack, term, 1, 1e4);
        const ids = new Set((idxs || []).map(i => _cIdx.meta[i].id));
        if (!scope) return ids;
        return new Set([...ids].filter(tid => { const t = _cTasks.find(x => x.id === tid); if (!t) return false; return ((scope === 'notes' ? t.notes : t.content) || '').toLowerCase().includes(term); }));
      };
      return matchQuery(query, _cTasks, { now: new Date().toISOString(), areas: _cAreas, defaultProjectId: _cDef, freeText }).slice(0, limit);
    },

    defaultTravel() { return _settings.default_travel_min ?? 20; },
    async setDefaultTravel(min) { await patchSettings({ default_travel_min: min }); },
    currentLocationId() { return _settings.current_location_id ?? null; },
    homeLocationId() { return _settings.home_location_id ?? null; },   // designated "home" place ("at home" NLP)
    async setHomeLocation(id) { await patchSettings({ home_location_id: _settings.home_location_id === id ? null : id }); },
    currentRegion() { return _settings.current_region ?? 'Home'; },
    presenceActuals() { return _settings.presence_actuals ?? {}; },

    async setCurrentLocation(id) {
      const uid = await userId();
      const s = await getSettings();
      const ts = new Date().toISOString();
      if (s.current_location_id !== id) {
        await insertActivity({ user_id: uid, type: 'location', ts, subject_type: 'location', subject_id: id, ctx: { from: s.current_location_id ?? null }, void: false });
      }
      const today = isoDate(new Date(ts));
      const actuals = s.presence_actuals || {};
      actuals[today] = actuals[today] || {};
      actuals[today][id] = { ...(actuals[today][id] || {}), start: actuals[today][id]?.start || ts.slice(11, 16) };
      await patchSettings({ current_location_id: id, presence_actuals: actuals });
    },
    async setCurrentRegion(name) {
      const uid = await userId();
      const s = await getSettings();
      const ts = new Date().toISOString();
      if (s.current_region !== name) {
        await insertActivity({ user_id: uid, type: 'region', ts, subject_type: 'region', subject_id: name, ctx: { from: s.current_region ?? null }, void: false });
      }
      await patchSettings({ current_region: name });
    },
    async stampActual(dateIso, locId, bounds) {
      const s = await getSettings();
      const actuals = s.presence_actuals || {};
      actuals[dateIso] = actuals[dateIso] || {};
      actuals[dateIso][locId] = { ...(actuals[dateIso][locId] || {}), ...bounds };
      await patchSettings({ presence_actuals: actuals });
    },

    // undo: snapshot serializes caches; restore reconciles DB (changed/added/removed tasks + activity + areas)
    snapshot() { return { tasks: JSON.stringify(_cTasks), activity: JSON.stringify(_cActs), actsLoaded: _actsLoaded, areas: JSON.stringify(_cAreas) }; },
    async restore(snap) {
      if (!snap) return false;
      const uid = await userId();
      const snapTasks = JSON.parse(snap.tasks);
      const snapIds = new Set(snapTasks.map(t => t.id));
      const curById = new Map(_cTasks.map(t => [t.id, t]));
      // missing/changed tasks → rewrite (re-create deleted, revert completed)
      for (const t of snapTasks) {
        const cur = curById.get(t.id);
        if (cur && JSON.stringify(cur) === JSON.stringify(t)) continue;
        const { row, task_relations } = dehydrateTask(t);
        const err = (await client.from('tasks').upsert({
          id: t.id, user_id: uid, milestone: t.milestone ?? false,
          created_at: t.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString(), ...row,
        }, { onConflict: 'id' })).error;
        if (err) return false;
        await client.from('task_relations').delete().eq('task_id', t.id);
        if (task_relations.length) await client.from('task_relations').insert(task_relations.map(r => ({ ...r, task_id: t.id, user_id: uid })));
      }
      // tasks added after snapshot → delete (undo of an add)
      const added = _cTasks.filter(t => !snapIds.has(t.id)).map(t => t.id);
      if (added.length) await client.from('tasks').delete().in('id', added).eq('user_id', uid);
      _cTasks = snapTasks; rebuildIdx();
      if (snap.actsLoaded) {
        const snapActs = JSON.parse(snap.activity);
        const snapActIds = new Set(snapActs.map(a => a.id)), curActIds = new Set(_cActs.map(a => a.id));
        const actsAdd = _cActs.filter(a => !snapActIds.has(a.id)).map(a => a.id);   // e.g. the 'complete' row this undoes
        const actsMissing = snapActs.filter(a => !curActIds.has(a.id));
        if (actsAdd.length) await client.from('activity').delete().in('id', actsAdd);
        if (actsMissing.length) await client.from('activity').insert(actsMissing.map(a => ({ ...a, user_id: uid })));
        _cActs = snapActs;
      }
      if (snap.areas !== undefined) {
        const snapAreas = JSON.parse(snap.areas);
        const snapAreaIds = new Set(snapAreas.map(a => a.id)), curAreaIds = new Set(_cAreas.map(a => a.id));
        const areasAdded = _cAreas.filter(a => !snapAreaIds.has(a.id)).map(a => a.id);
        const areasMissing = snapAreas.filter(a => !curAreaIds.has(a.id));
        if (areasAdded.length) await client.from('areas').delete().in('id', areasAdded).eq('user_id', uid);
        if (areasMissing.length) await client.from('areas').insert(areasMissing.map(a => ({ ...a, user_id: uid })));
        _cAreas = snapAreas; _areasLoaded = true; rebuildIdx();
      }
      return true;
    },

    activity: {
      async list() { return activityList(); },
      async note(goalId, text) {
        const uid = await userId();
        const row = { user_id: uid, type: 'note', ts: new Date().toISOString(), subject_type: 'goal', subject_id: goalId, text: text || '', void: false };
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async showUp(goalId, ts, note) {
        if (!goalId) return null;
        const uid = await userId();
        const row = { user_id: uid, type: 'show_up', ts: ts ?? new Date().toISOString(), subject_type: 'goal', subject_id: goalId, void: false };
        if (note) row.text = note;
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async graduate(goalId, ts) {
        if (!goalId) return null;
        const uid = await userId();
        const row = { user_id: uid, type: 'graduate', ts: ts ?? new Date().toISOString(), subject_type: 'goal', subject_id: goalId, void: false };
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async release(goalId, ts) {
        if (!goalId) return null;
        const uid = await userId();
        const row = { user_id: uid, type: 'release', ts: ts ?? new Date().toISOString(), subject_type: 'goal', subject_id: goalId, void: false };
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async finish(goalId, ts) {
        if (!goalId) return null;
        const uid = await userId();
        const row = { user_id: uid, type: 'finish', ts: ts ?? new Date().toISOString(), subject_type: 'goal', subject_id: goalId, void: false };
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async shelve(goalId, ts) {
        if (!goalId) return null;
        const uid = await userId();
        const row = { user_id: uid, type: 'shelve', ts: ts ?? new Date().toISOString(), subject_type: 'goal', subject_id: goalId, void: false };
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async unshelve(goalId, ts) {
        if (!goalId) return null;
        const uid = await userId();
        const row = { user_id: uid, type: 'unshelve', ts: ts ?? new Date().toISOString(), subject_type: 'goal', subject_id: goalId, void: false };
        const { data } = await client.from('activity').insert(row).select().single();
        if (data) _cActs.push(data);
        return data;
      },
      async remove(id) { await client.from('activity').delete().eq('id', id); _cActs = _cActs.filter(a => a.id !== id); return true; },
    },

    filters: {
      async list() { const { data } = await client.from('filters').select('*').order('position'); return data || []; },
      async add({ name, query, color }) {
        const uid = await userId();
        const { data: existing } = await client.from('filters').select('position').order('position', { ascending: false }).limit(1);
        const pos = existing?.length ? (existing[0].position ?? 0) + 1 : 0;
        const ts = new Date().toISOString();
        const { data } = await client.from('filters').insert({ user_id: uid, name: name || 'Filter', query: query || '', color: color ?? null, position: pos, created_at: ts, updated_at: ts }).select().single();
        return data;
      },
      async update(id, fields) {
        const uid = await userId();
        const { data } = await client.from('filters').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid).select().single();
        return data ?? null;
      },
      async remove(id) { const uid = await userId(); await client.from('filters').delete().eq('id', id).eq('user_id', uid); return true; },
      async reorder(ids) {
        const uid = await userId(), ts = new Date().toISOString();
        await Promise.all(ids.map((id, i) => client.from('filters').update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid)));
        return true;
      },
    },

    events: {
      async list() { const { data } = await client.from('events').select('*').order('starts_at'); return (data || []).map(hydrateEvent); },
      async add(fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const { data } = await client.from('events').insert({
          user_id: uid, title: fields.title || '', notes: fields.notes ?? null,
          starts_at: fields.starts_at, ends_at: fields.ends_at, all_day: fields.all_day ?? false,
          color: fields.color ?? null, source: 'local', external_id: null,
          location_mode: fields.location?.mode ?? 'any', location_ids: fields.location?.ids ?? [],
          recurrence: fields.recurrence ?? null,
          created_at: ts, updated_at: ts,
        }).select('*').single();
        return data ? hydrateEvent(data) : null;
      },
      async update(id, fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const upd = { updated_at: ts };
        for (const c of ['title', 'notes', 'starts_at', 'ends_at', 'all_day', 'color', 'source', 'external_id']) if (c in fields) upd[c] = fields[c] ?? null;
        if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;
        if ('location' in fields) { upd.location_mode = fields.location?.mode ?? 'any'; upd.location_ids = fields.location?.ids ?? []; }
        const { data } = await client.from('events').update(upd).eq('id', id).eq('user_id', uid).select('*').single();
        return data ? hydrateEvent(data) : null;
      },
      async remove(id) { const uid = await userId(); await client.from('events').delete().eq('id', id).eq('user_id', uid); return true; },
    },

    blocks: {
      async list() { const { data } = await client.from('blocks').select('*').order('starts_at'); return (data || []).map(hydrateBlock); },
      async add(fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const { data } = await client.from('blocks').insert({
          user_id: uid, title: fields.title || '', starts_at: fields.starts_at, ends_at: fields.ends_at,
          all_day: fields.all_day ?? false, location_id: fields.location_id ?? null,
          area_ids: fields.areas ?? [],
          energy: fields.energy ?? null, availability: fields.availability ?? null, color: fields.color ?? null, source: 'local',
          recurrence: fields.recurrence ?? null,
          created_at: ts, updated_at: ts,
        }).select('*').single();
        return data ? hydrateBlock(data) : null;
      },
      async update(id, fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const upd = { updated_at: ts };
        for (const c of ['title', 'starts_at', 'ends_at', 'all_day', 'location_id', 'energy', 'availability', 'color', 'source']) if (c in fields) upd[c] = fields[c] ?? null;
        if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;
        if ('areas' in fields) upd.area_ids = fields.areas ?? [];
        const { data } = await client.from('blocks').update(upd).eq('id', id).eq('user_id', uid).select('*').single();
        return data ? hydrateBlock(data) : null;
      },
      async remove(id) { const uid = await userId(); await client.from('blocks').delete().eq('id', id).eq('user_id', uid); return true; },
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
          const rows = await taskRows();   // depth + min-position off the cache, not two full-table scans
          // TODO(parity): no `fields.project` name-resolution (LocalStore auto-creates a root task)
          const parent_id = fields.parent_id !== undefined ? fields.parent_id : (await settings()).default_project_id ?? null;
          if (parent_id && projectDepth(rows, parent_id) >= MAX_DEPTH) return null;
          const position = rows.length ? Math.min(...rows.map(r => r.position ?? 0)) - 1 : 0;
          const rec = fields.recurrence ?? null;
          let due_at = fields.due_at || null;
          if (rec && !fields.due_at) {
            const b = nextAcrossRules(rec, isoDate(new Date(ts)), ts, { inclusive: true });
            if (b) { b.rule.gen_due = true; due_at = b.iso + (b.rule.at ? 'T' + b.rule.at : ''); }   // seeded due is rule-generated; a rule may carry its own time
          }
          const id = crypto.randomUUID();
          const { error } = await client.from('tasks').insert({
            id, user_id: uid, content: fields.content ?? '', notes: fields.notes ?? null,
            priority: fields.priority ?? 4, due_at, deadline_at: fields.deadline_at ?? null,
            scheduled_at: fields.scheduled_at ?? null, est_minutes: fields.est_minutes ?? null,
            parent_id, color: fields.color ?? null, favorite: fields.favorite ?? false,
            place: fields.place ?? null, location_mode: fields.location?.mode ?? 'any', location_ids: fields.location?.ids ?? [],
            area_ids: await resolveAreaIds(fields), goal_ids: fields.goal_ids ?? [],
            position, completed_at: null, archived_at: null, sidebar: fields.sidebar ?? false,
            milestone: fields.milestone ?? false,
            // checklist_plain deliberately NOT sent on create: the column may not exist before db:apply, and an
            // unknown column fails the WHOLE insert. New tasks default false server-side; the flag only writes on update.
            checklist: cleanChecklist(fields.checklist), completions: [], recurrence: rec,
            created_at: ts, updated_at: ts,
          });
          if (error) return null;
          markEcho(id);
          if (fields.blocked_by?.length) await setRelationType(id, uid, 'blocks', fields.blocked_by);
          if (fields.relates?.length) await setRelationType(id, uid, 'relates', fields.relates);
          const task = await fetchTask(id); putTask(task);
          if (task?.sidebar !== true) await pushActivity('create', task);
          return task;
        } catch { return null; }
      },

      async update(id, fields) {
        try {
          const uid = await userId(); const ts = new Date().toISOString();
          const upd = { updated_at: ts };
          for (const c of ['content', 'notes', 'priority', 'due_at', 'deadline_at', 'scheduled_at', 'est_minutes', 'parent_id', 'color', 'favorite', 'place', 'position', 'completed_at', 'sidebar', 'milestone', 'checklist_plain']) {
            if (c in fields) upd[c] = fields[c] ?? null;
          }
          if ('recurrence' in fields) upd.recurrence = fields.recurrence ?? null;   // one jsonb column now
          if ('areas' in fields || 'area_ids' in fields) upd.area_ids = await resolveAreaIds(fields);
          if ('goal_ids' in fields) upd.goal_ids = fields.goal_ids ?? [];
          if ('completions' in fields) upd.completions = fields.completions ?? [];
          if ('checklist' in fields) upd.checklist = cleanChecklist(fields.checklist);
          if ('location' in fields) { upd.location_mode = fields.location?.mode ?? 'any'; upd.location_ids = fields.location?.ids ?? []; }
          const { error } = await client.from('tasks').update(upd).eq('id', id).eq('user_id', uid);
          if (error) return null;
          markEcho(id);
          // edges in task_relations; replace per-type when key is present
          if ('blocked_by' in fields) await setRelationType(id, uid, 'blocks', fields.blocked_by ?? []);
          if ('relates' in fields) await setRelationType(id, uid, 'relates', fields.relates ?? []);
          const task = await fetchTask(id); putTask(task); return task;
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
              for (const pid of toComplete) {
                const p = updatedRows.find(r => r.id === pid);
                if (p?.sidebar !== true) await pushActivity('complete', p);
              }
              await refreshTasks(toComplete);
            }
          }
          return task;
        } catch { return null; }
      },

      async remove(id, targetId) {
        try {
          const uid = await userId();
          const rows = await taskRows();
          const kids = rows.filter(r => r.parent_id === id).map(r => r.id);
          if (kids.length) {
            if (!targetId) return false;
            if (descendantIds(rows, id).includes(targetId)) return false;
            await client.from('tasks').update({ parent_id: targetId, updated_at: new Date().toISOString() }).eq('parent_id', id).eq('user_id', uid);
          }
          if ((await settings()).default_project_id === id && targetId) await patchSettings({ default_project_id: targetId });
          markEcho(id, ...kids);
          await client.from('tasks').delete().eq('id', id).eq('user_id', uid);
          await refreshTasks(kids); dropTasks([id]);   // reparented kids changed; the removed row leaves the cache
          return true;
        } catch { return false; }
      },

      async setCompleted(id, done) {
        const uid = await userId(); const ts = new Date().toISOString();
        const rows = await taskRows();
        const target = rows.find(r => r.id === id); if (!target) return false;

        // Recurring: log + advance due_at unless every statement ends (all-paused falls through to permanent complete).
        if (done && recActive(target.recurrence) && !target.completed_at && !rows.some(r => r.parent_id === id)) {
          const wasArray = Array.isArray(target.recurrence);
          const rules = recRules(target.recurrence).map(r => ({ ...r }));
          const anchor = target.due_at || isoDate(new Date(ts));
          // The completed occurrence belongs to the rule that generated the current due (gen_due marker; legacy fallback: first active).
          const src = rules.find(r => r.gen_due && !r.paused) || rules.find(r => !r.paused);
          src.done_count = (src.done_count ?? 0) + 1;
          const srcNext = nextOccurrence(src, anchor, ts);
          // Per-rule ends (count reached, or next past "until"): PAUSE (never destroy) the exhausted statement.
          if ((src.ends?.count != null && src.done_count >= src.ends.count) || (src.ends?.date && srcNext > src.ends.date)) src.paused = true;
          rules.forEach(r => delete r.gen_due);
          const rec = wasArray ? rules : rules[0];
          let newCompletedAt = null, newDueAt = target.due_at;
          const best = nextAcrossRules(rec, anchor, ts);
          if (!best) newCompletedAt = ts;   // every statement ended → permanent complete (rules stay, paused)
          else { best.rule.gen_due = true; newDueAt = best.iso + (best.rule.at ? 'T' + best.rule.at : (target.due_at?.length > 10 ? target.due_at.slice(10) : '')); }
          const completions = [...(target.completions || []), ts];   // was a task_completions row, now a jsonb append
          markEcho(id);
          await client.from('tasks').update({ recurrence: rec, due_at: newDueAt, completed_at: newCompletedAt, completions, updated_at: ts }).eq('id', id).eq('user_id', uid);
          if (target.sidebar !== true) await pushActivity('complete', { ...target, recurrence: rec });
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
          for (const sid of recurringSwept) { const rr = rows.find(r => r.id === sid).recurrence;
            await client.from('tasks').update({ recurrence: Array.isArray(rr) ? rr.map(x => ({ ...x, paused: true })) : { ...rr, paused: true }, updated_at: ts }).eq('id', sid).eq('user_id', uid); }
          for (const tid of toMark) {
            const t = rows.find(r => r.id === tid);
            if (t && !t.completed_at && t.sidebar !== true) await pushActivity('complete', t);
          }
          const updatedRows = rows.map(r => toMark.includes(r.id) ? { ...r, completed_at: ts } : r);
          for (const pid of parentsToComplete(updatedRows, id)) {
            await client.from('tasks').update({ completed_at: ts, updated_at: ts }).eq('id', pid).eq('user_id', uid);
            const parent = rows.find(r => r.id === pid);
            if (parent?.sidebar !== true) await pushActivity('complete', parent);
            affected.push(pid);
          }
          markEcho(...affected);
          await refreshTasks(affected);
        } else {
          const ancestors = ancestorIds(rows, id);
          const toUnmark = [id, ...ancestors];
          markEcho(...toUnmark);
          await client.from('tasks').update({ completed_at: null, updated_at: ts }).in('id', toUnmark).eq('user_id', uid);
          const acts = await activityList();   // void the latest complete per row off the cache, not N reads
          for (const tid of toUnmark) {
            const last = [...acts].reverse().find(a => a.subject_id === tid && a.type === 'complete' && !a.void);
            if (last) { await client.from('activity').update({ void: true }).eq('id', last.id).eq('user_id', uid); last.void = true; }
          }
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
        if (val && recActive(t.recurrence)) upd.recurrence = Array.isArray(t.recurrence) ? t.recurrence.map(x => ({ ...x, paused: true })) : { ...t.recurrence, paused: true };   // pause, never destroy
        markEcho(id);
        await client.from('tasks').update(upd).eq('id', id).eq('user_id', uid);
        if (t.sidebar !== true && !!was !== !!val) await pushActivity(val ? 'archive' : 'unarchive', t);
        await refreshTasks([id]);
        return true;
      },
      async link(id, otherId, type) {
        if (id === otherId) return false;
        const uid = await userId();
        if (type === 'relates') {   // symmetric: write both directions with type 'relates'
          await Promise.all([
            client.from('task_relations').upsert({ task_id: id, related_id: otherId, type: 'relates', user_id: uid }, { onConflict: 'task_id,related_id,type' }),
            client.from('task_relations').upsert({ task_id: otherId, related_id: id, type: 'relates', user_id: uid }, { onConflict: 'task_id,related_id,type' }),
          ]);
          await refreshTasks([id, otherId]);
        } else {   // directional: id is blocked_by otherId
          await client.from('task_relations').upsert({ task_id: id, related_id: otherId, type: 'blocks', user_id: uid }, { onConflict: 'task_id,related_id,type' });
          await refreshTasks([id]);
        }
        return true;
      },

      async unlink(id, otherId, type) {
        const uid = await userId();
        if (type === 'relates') {
          await Promise.all([
            client.from('task_relations').delete().eq('task_id', id).eq('related_id', otherId).eq('type', 'relates').eq('user_id', uid),
            client.from('task_relations').delete().eq('task_id', otherId).eq('related_id', id).eq('type', 'relates').eq('user_id', uid),
          ]);
          await refreshTasks([id, otherId]);
        } else {
          await client.from('task_relations').delete().eq('task_id', id).eq('related_id', otherId).eq('type', 'blocks').eq('user_id', uid);
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
      async create({ name, color }) {
        const uid = await userId();
        const pos = _cAreas.length ? Math.max(..._cAreas.map(a => a.position ?? 0)) + 1 : 0;   // off the cache, no scan
        const ts = new Date().toISOString();
        const { data } = await client.from('areas').insert({ user_id: uid, name, color: color ?? null, icon: null, position: pos, favorite: false, created_at: ts, updated_at: ts }).select().single();
        if (data) { markEcho(data.id); _cAreas = [..._cAreas, data]; rebuildIdx(); }
        return data ?? null;
      },
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
        await client.rpc('delete_area', { p_id: id });   // scrubs tasks.area_ids + blocks.area_ids, then deletes
        _cTasks = _cTasks.map(t => t.area_ids?.includes(id) ? { ...t, area_ids: t.area_ids.filter(a => a !== id) } : t);
        _cAreas = _cAreas.filter(a => a.id !== id); rebuildIdx();
        return true;
      },
    },

    goals: {
      async list() { const { data } = await client.from('goals').select('*').order('position'); return (data || []).map(hydrateGoal); },
      async create(fields) {
        const uid = await userId();
        const { data: existing } = await client.from('goals').select('position').order('position', { ascending: false }).limit(1);
        const pos = fields.position ?? (existing?.length ? (existing[0].position ?? 0) + 1 : 0);
        const ts = new Date().toISOString();
        const { data, error } = await client.from('goals').insert({ user_id: uid, name: fields.name || 'Goal', identity: fields.identity ?? null, identity_id: fields.identity_id ?? null, cue: fields.cue ?? null, log_default: fields.log_default ?? null, color: fields.color ?? null, icon: fields.icon ?? null, target_date: fields.target_date ?? null, favorite: fields.favorite ?? false, archived: fields.archived ?? false, position: pos, cadence: fields.cadence ?? null, targets: fields.targets ?? [], sustained_at: fields.sustained_at ?? null, sustain_snoozed_until: fields.sustain_snoozed_until ?? null, shape: fields.shape ?? 'process', shelved_at: fields.shelved_at ?? null, finished_at: fields.finished_at ?? null, created_at: ts, updated_at: ts }).select('*').single();
        return error ? null : (data ? hydrateGoal(data) : null);
      },
      async update(id, fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const upd = { updated_at: ts };
        for (const c of ['name', 'identity', 'identity_id', 'cue', 'log_default', 'color', 'icon', 'target_date', 'favorite', 'archived', 'position', 'cadence', 'sustained_at', 'sustain_snoozed_until', 'shape', 'shelved_at', 'finished_at']) if (c in fields) upd[c] = fields[c] ?? null;
        if ('targets' in fields) upd.targets = fields.targets ?? [];   // jsonb column now
        const { data } = await client.from('goals').update(upd).eq('id', id).eq('user_id', uid).select('*').single();
        return data ? hydrateGoal(data) : null;
      },
      async reorder(orderedIds) {
        const uid = await userId(), ts = new Date().toISOString();
        await Promise.all(orderedIds.map((id, i) => client.from('goals').update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid)));
        return true;
      },
      async remove(id) {
        await client.rpc('delete_goal', { p_id: id });   // scrubs tasks.goal_ids, then deletes
        _cTasks = _cTasks.map(t => t.goal_ids?.includes(id) ? { ...t, goal_ids: t.goal_ids.filter(g => g !== id) } : t); rebuildIdx();
        return true;
      },
    },

    identities: {
      async list() {
        const { data } = await client.from('identities').select('*').order('position');
        return data || [];
      },
      async create(fields) {
        const uid = await userId();
        const { data: existing } = await client.from('identities').select('position').order('position', { ascending: false }).limit(1);
        const pos = fields.position ?? (existing?.length ? (existing[0].position ?? 0) + 1 : 0);
        const ts = new Date().toISOString();
        const { data } = await client.from('identities').insert({ user_id: uid, statement: (fields.statement || '').trim(), position: pos, created_at: ts, updated_at: ts }).select('*').single();
        return data ?? null;
      },
      async findOrCreate(statement) {
        const st = (statement || '').trim(); if (!st) return null;
        const uid = await userId();
        const { data: existing } = await client.from('identities').select('*').eq('statement', st).eq('user_id', uid).limit(1);
        if (existing?.length) return existing[0];
        const { data: pos_row } = await client.from('identities').select('position').order('position', { ascending: false }).limit(1);
        const pos = pos_row?.length ? (pos_row[0].position ?? 0) + 1 : 0;
        const ts = new Date().toISOString();
        const { data, error } = await client.from('identities').insert({ user_id: uid, statement: st, position: pos, created_at: ts, updated_at: ts }).select('*').single();
        if (error) {
          // unique constraint race (another tab) — re-select once before throwing
          const { data: retry } = await client.from('identities').select('*').eq('statement', st).eq('user_id', uid).limit(1);
          if (retry?.length) return retry[0];
          throw error;
        }
        return data ?? null;
      },
      async update(id, fields) {
        const uid = await userId(); const ts = new Date().toISOString();
        const upd = { updated_at: ts };
        for (const c of ['statement', 'position']) if (c in fields) upd[c] = c === 'statement' ? (fields[c] || '').trim() : (fields[c] ?? null);
        const { data } = await client.from('identities').update(upd).eq('id', id).eq('user_id', uid).select('*').single();
        if (data && 'statement' in upd) await client.from('goals').update({ identity: upd.statement, updated_at: ts }).eq('identity_id', id).eq('user_id', uid);
        return data ?? null;
      },
      async remove(id) {
        await client.rpc('delete_identity', { p_id: id });   // nulls goals.identity_id + identity string, then deletes
        return true;
      },
      async merge(fromId, toId) {
        if (!fromId || !toId || fromId === toId) return null;
        const uid = await userId(); const ts = new Date().toISOString();
        const { data: toIdent } = await client.from('identities').select('statement').eq('id', toId).eq('user_id', uid).single();
        await client.from('goals').update({ identity_id: toId, identity: toIdent?.statement ?? null, updated_at: ts }).eq('identity_id', fromId).eq('user_id', uid);
        await client.from('identities').delete().eq('id', fromId).eq('user_id', uid);
        return true;
      },
      async reorder(orderedIds) {
        const uid = await userId(), ts = new Date().toISOString();
        await Promise.all(orderedIds.map((id, i) => client.from('identities').update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid)));
        return true;
      },
    },

    locations: {
      async list() { const { data } = await client.from('locations').select('*').order('position'); return data || []; },
      async add({ name, icon = null, color = null, region = 'Home' }) {
        const uid = await userId();
        const { data: existing } = await client.from('locations').select('position').order('position', { ascending: false }).limit(1);
        const pos = existing?.length ? (existing[0].position ?? 0) + 1 : 0;
        const ts = new Date().toISOString();
        const { data } = await client.from('locations').insert({ user_id: uid, name: name || 'Location', icon, color, region, position: pos, created_at: ts, updated_at: ts }).select().single();
        return data ?? null;
      },
      async update(id, fields) {
        const uid = await userId();
        const { data } = await client.from('locations').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid).select().single();
        return data ?? null;
      },
      async remove(id) {
        const s = await getSettings();
        if (s.current_location_id === id) await patchSettings({ current_location_id: null });
        // RPC scrubs tasks/events location_ids; travel_times cascade; blocks.location_id set-null
        await client.rpc('delete_location', { p_id: id });
        _cTasks = _cTasks.map(t => t.location?.ids?.includes(id) ? { ...t, location: { ...t.location, ids: t.location.ids.filter(l => l !== id) } } : t); rebuildIdx();
        return true;
      },
      async reorder(ids) {
        const uid = await userId(), ts = new Date().toISOString();
        await Promise.all(ids.map((id, i) => client.from('locations').update({ position: i, updated_at: ts }).eq('id', id).eq('user_id', uid)));
        return true;
      },
    },

    // Subscribe to Supabase Realtime postgres_changes on tasks + areas. onChange(kind) fires after the cache
    // refreshes ('tasks' | 'areas') so the app can re-pull. Debounced; own-write echoes are suppressed via _echo.
    // Matches Android Sync.kt channel "realtime:tasks"; guards against test fakes with no .channel().
    subscribe(onChange) {
      _onChange = onChange ?? null;
      if (typeof client.channel !== 'function') return;
      userId().then(uid => {
        if (!uid) return;
        _channel = client.channel('tasks-sync')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${uid}` }, (payload) => {
            const rid = payload?.new?.id ?? payload?.old?.id;
            if (rid && _echo.has(rid)) return;   // our own write echoing back — the cache is already current
            if (!rid) _needFull = true;                                        // payload gap → fall back to a full refetch
            else if ((payload.eventType || payload.type) === 'DELETE') _pendDrop.add(rid);
            else _pendRefetch.add(rid);
            scheduleApply();
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'areas', filter: `user_id=eq.${uid}` }, (payload) => {
            const rid = payload?.new?.id ?? payload?.old?.id;
            if (rid && _echo.has(rid)) return;   // own area write echoing back — cache already current
            if (!rid) { client.from('areas').select('*').order('position').then(({ data }) => { if (data) { _cAreas = data; rebuildIdx(); _onChange?.('areas'); } }); return; }
            if ((payload.eventType || payload.type) === 'DELETE') _cAreas = _cAreas.filter(a => a.id !== rid);   // patch the single row from the payload — no refetch
            else _cAreas = _cAreas.some(a => a.id === rid) ? _cAreas.map(a => a.id === rid ? payload.new : a) : [..._cAreas, payload.new];
            rebuildIdx(); _onChange?.('areas');
          })
          .subscribe();
      });
    },
    unsubscribe() {
      clearTimeout(_applyT);
      if (_channel) { _channel.unsubscribe?.(); client.removeChannel?.(_channel); _channel = null; }
      _onChange = null;
    },

    travel: {
      async get(from, to) {
        const uid = await userId();
        const { data } = await client.from('travel_times').select('minutes')
          .or(`and(from_location_id.eq.${from},to_location_id.eq.${to}),and(from_location_id.eq.${to},to_location_id.eq.${from})`)
          .eq('user_id', uid).limit(1);
        return data?.[0]?.minutes ?? (await getSettings()).default_travel_min ?? 20;
      },
      async set(from, to, minutes) {
        const uid = await userId();
        await client.from('travel_times').upsert({ user_id: uid, from_location_id: from, to_location_id: to, minutes }, { onConflict: 'user_id,from_location_id,to_location_id' });
        return true;
      },
      async list() {
        const uid = await userId();
        const { data } = await client.from('travel_times').select('from_location_id, to_location_id, minutes').eq('user_id', uid);
        return (data || []).map(r => ({ from: r.from_location_id, to: r.to_location_id, minutes: r.minutes }));
      },
      async remove(from, to) {
        const uid = await userId();
        await client.from('travel_times').delete().eq('from_location_id', from).eq('to_location_id', to).eq('user_id', uid);
        return true;
      },
    },
  };
}
