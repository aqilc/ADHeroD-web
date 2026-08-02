import DESIGN from './design.json' with { type: 'json' };

// design.json → CSS custom properties, injected before Alpine boots. styles.css holds no token values.
const _vars = (m) => Object.entries(m).map(([k, v]) => `--${k}:${v}`).join(';');
const _scale = (d) => [
  d.space.map((n) => `--sp-${n}:${n}px`), d.type.map((n) => `--fs-${n}:${n}px`),
  Object.entries(d.radius).map(([k, v]) => `--r${k === 'r' ? '' : '-' + k}:${v}`),
  Object.entries(d.ease).map(([k, v]) => `--ease-${k}:${v}`),
  Object.entries(d.font).map(([k, v]) => `--font-${k}:${v}`),
  Object.entries(d.priority).map(([k, v]) => `--p${k}:${v}`),
  Object.entries(d.quick).map(([k, v]) => `--q-${k}:${v}`),
].flat().join(';');
document.head.insertAdjacentHTML('beforeend',
  `<style id="design-tokens">:root{${_scale(DESIGN)};${_vars(DESIGN.light)}}@media (prefers-color-scheme: dark){:root{${_vars(DESIGN.dark)}}}</style>`);

import { createLocalStore, descendantIds, ancestorIds, projectDepth, subtreeDepth, nextOccurrence, nextAcrossRules, recRules, effectiveGoalIds, isBlocked, MAX_DEPTH } from './store.js';
import { guardedFields, trashView, pruneJournal, JOURNAL_MAX } from './recovery.js';
import { goalProgress, goalWarmth, homeWarmth, firstShowUpDay, HEARTH, goalLaneFull, laneComparator, goalArc, finishReady } from './stats.js';
import { parseDateText, parseRecurrence, quickDate, quickRange, isoDate, dueBadge, windowBadge, deadlineLeft, matchTrailingToken, classifyToken, tokenizeAll, parseImportanceWords, parseLogNote, recurrenceLabel, logDayLabel, impRank } from './nlp.js';
import { markTitle, makeFuzzy, fuzzyRank } from './search.js';
import { calendarItems, blocksInRange, daypartOf, eventsFirst, occurrencesInRange, timeOf } from './calendar.js';
import { esc as escHtml, mdLive as mdLiveRender, chkLive as chkLiveRender, byDone, chkVisible, raw, taskRowHtml, taskListHtml as taskListMarkup, dotStripHtml as dotStripMarkup, rollerBoxHtml as rollerBoxMarkup, rowBodyHtml, mdTitle as mdTitleFn, areaChipHtml } from './ui.js';
import { makeSortable, edgeScrollStep } from './sortable.js';
import { SUPABASE, SURFACES } from './config.js';
// landing surface: now when present (local default), else lists, else the leftmost of the trimmed set
const SURF_HOME = !SURFACES || SURFACES.includes('now') ? 'now' : SURFACES.includes('lists') ? 'lists' : SURFACES[0];
import { createSupabaseStore } from './supabase-store.js';

// null when unconfigured → stays on LocalStore (UMD bundle sets globalThis.supabase at init).
let _sb;
const sbClient = () => { if (_sb === undefined) _sb = (globalThis.supabase && SUPABASE.url) ? globalThis.supabase.createClient(SUPABASE.url, SUPABASE.anonKey) : null; return _sb; };

// Module-scope: kept outside Alpine state so render reads/writes don't loop. _calDataV busts on any task/event change.
const CL_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SURF_META = { now: { label: 'Now', icon: 'i-clock' }, plan: { label: 'Plan', icon: 'i-cal' }, lists: { label: 'Lists', icon: 'i-all' }, goals: { label: 'Goals', icon: 'i-target' } };
const CL_HOURS = Array.from({ length: 24 }, (_, h) => h);
const CL_WAKING_START = 8;   // default waking day start (h); future: from sleep data
const CL_WAKING_END = 24;    // waking day end (h)
const CL_EPOCH = new Date(2000, 0, 2);   // a (local) Sunday — week 0 of the virtual timeline
const CL_TOTAL_WEEKS = 5217;             // ~100 years: a fixed scroll height (no reflow) ⇒ effectively infinite
const CL_BUFFER = 10;                     // weeks rendered beyond the viewport each side (blank-free on fast flings)
const CL_HOLD_MS = 3000;                  // hold ↑/↓ this long and the step escalates from a nudge to a PERIOD
const CL_HOLD_STEP = 220;                 // ...then one period per this, so a held key travels at a readable rate
const CL_AD_FIELDS = 2;                 // Terrain: presence fields a column can carry before it turns to mud.
                                          // The rest become a count — the fill is the one channel the calendar
                                          // already spends on blocks, elapsed time and the cleared-day glow.
const CL_FOOT = 56;                       // bottom nav strip the timeline stops short of (must match --foot in CSS)
const CL_TITLE_PX = 15;                   // one title strip. Two events starting closer than this leave nothing of
                                          // the lower one to read, so they split the width instead of cascading.
// The timeline spacer is WINDOWED, unlike month's: a period is ~1150px (vs a ~113px week row), so the full
// 100-year range would be 42M px in day view — past Chrome's 33,554,428px scroll cap, which silently clamps
// scrollTop (zoom 4× put TODAY out of reach). 4001 periods = ±5.5y (day) / ±38y (week), 18M px even at 4× zoom.
// Blocks sit at (idx − clTLBase)·ph; the base only re-centers on a programmatic jump, never mid-scroll.
const CL_TL_SPAN = 4001;
const CL_GESTURE_GAP = 140;               // ms of quiet that ends a scroll gesture (trackpad momentum fires continuously, so this only trips when the fingers are done)
const CL_AG_ROW = 46;                     // agenda row height (full tier); rows FLOW — proportion is the rail's job
const CL_AG_GAP = 30;                     // a hole in the day big enough to be worth naming ("1h free")
const CL_BAR = 90, CL_HEAD = 32;          // overlaid toolbar + weekday-header heights (must match --bar/--head in CSS)
const _groupMemo = new Map();   // byDay cache; busts on any task/event change
const _clListMemo = new Map();   // keyed on kind|_rowV|range — Map hit on scroll/nav instead of rebuild
let _clBlocksSig = null, _clBlocksCache = [];   // clBlocks() single-entry memo — a view switch/scroll settle re-fires it ~100×; returning the SAME array ref lets Alpine's x-for no-op instead of re-diffing 500+ nodes
let _calDataV = 0, _clScrollT;
const _goalStepsMemo = new Map();   // per-goal id; same _calDataV bust
const _goalMilestonesMemo = new Map();   // all milestone tasks incl. completed
const ARC_LATE = 0.67;   // project arc threshold: above this pct, status line foregrounds the goal/why
const IDENTITY_WHO_RE = /^i(?:'m| am)\s+someone who\s+/i;   // shared strip prefix for identity statements
// visibleRows() memo: O(n) tree walk called many times per render; cache on _rowV+navSel+listQ so drag/animation don't recompute per frame.
let _visMemo = null, _visKey = '', _doneMemo = [];   // _doneMemo: completed rows for the section below the add-task button
// Raw DOM refs — kept outside Alpine state so they're never proxied.
let _hoverEls = [], _fitQ = 0, _dropEl = null, _kbEl = null, _selSet = new Set();
// The pill-NLP engine runs on an ACTIVE target: { el, draft } = the editor + the draft its pills write to.
// Null = the title (the default: $refs.content → this.draft); a focused subtask row swaps in its own editor +
// sub-draft so the SAME engine drives NLP there. Kept OUT of Alpine's reactive data (holds a live DOM node).
let _nlpFocus = null;
// Every field kind the pill engine can commit — used to rebuild a draft wholesale from an editor's DOM pills.
const PILL_KINDS = ['imp', 'dur', 'proj', 'area', 'goal', 'loc', 'rec', 'deadline', 'date'];
// Per-kind spec: json flag (value stored as JSON in dataset), optional num (cast raw to number),
// and the four draft operations — all receive (self, draft, ...) so helpers like setDur/refreshRecurrenceDue are reachable.
const PILL_SPEC = {
  imp:      { json: 0, label: (s, v) => s.impName(v, 'Importance'),
              commit: (s, d, v) => { d.importance = v; }, clear: (s, d) => { d.importance = 'none'; }, snapshot: (s, d) => d.importance, restore: (s, d, x) => { d.importance = x ?? 'none'; } },
  dur:      { json: 0, num: 1, label: (s, v) => s.durFmt(v),
              commit: (s, d, v) => s.setDur(v), clear: (s, d) => { d.durH = 0; d.durM = 0; }, snapshot: (s, d) => ({ durH: d.durH, durM: d.durM }), restore: (s, d, x) => { d.durH = x?.durH || 0; d.durM = x?.durM || 0; } },
  proj:     { json: 0, label: (s, v) => '#' + v,
              commit: (s, d, v) => { d.project = v; d.project_id = null; s.projRequired = false; }, clear: (s, d) => { d.project = null; }, snapshot: (s, d) => ({ project: d.project, project_id: d.project_id }), restore: (s, d, x) => { d.project = x?.project ?? null; d.project_id = x?.project_id ?? null; } },
  area:     { json: 0, multi: 'areas', label: (s, v) => '@' + (s.areaById(v)?.name ?? v),
              commit: (s, d, v) => { if (!d.areas.includes(v)) d.areas.push(v); }, clear: (s, d, r) => { const i = d.areas.indexOf(r); if (i >= 0) d.areas.splice(i, 1); }, snapshot: (s, d) => [...d.areas], restore: (s, d, x) => { d.areas = x || []; } },
  goal:     { json: 0, multi: 'goal_ids', label: (s, v) => '🔥 ' + (s.goalById(v)?.name || ''),
              commit: (s, d, v) => { if (!d.goal_ids.includes(v)) d.goal_ids.push(v); }, clear: (s, d, r) => { const i = d.goal_ids.indexOf(r); if (i >= 0) d.goal_ids.splice(i, 1); }, snapshot: (s, d) => [...d.goal_ids], restore: (s, d, x) => { d.goal_ids = x || []; } },
  loc:      { json: 0, label: (s, v) => '📍 ' + v,
              commit: (s, d, v) => { const neg = /^away from /i.test(v), nm = String(v).replace(/^away from /i, ''); const l = s.locByName(nm); d.location = { mode: neg ? 'except' : 'only', ids: l ? [l.id] : [] }; }, clear: (s, d) => { d.location = { mode: 'any', ids: [] }; }, snapshot: (s, d) => ({ mode: d.location.mode, ids: [...d.location.ids] }), restore: (s, d, x) => { d.location = x ? { mode: x.mode, ids: [...x.ids] } : { mode: 'any', ids: [] }; } },
  rec:      { json: 1, label: (s, v) => s.recurrenceLabel(v),
              commit: (s, d, v) => { d.recurrence = v; s.refreshRecurrenceDue(); }, clear: (s, d) => { d.recurrence = null; }, snapshot: (s, d) => d.recurrence ? JSON.parse(JSON.stringify(d.recurrence)) : null, restore: (s, d, x) => { d.recurrence = x || null; if (d.recurrence) s.refreshRecurrenceDue(); } },
  deadline: { json: 1, label: (s, v) => { const b = dueBadge(v.iso); return '⚑ ' + b.label; },
              commit: (s, d, v) => { d.deadline_at = v.iso; }, clear: (s, d) => { d.deadline_at = ''; }, snapshot: (s, d) => d.deadline_at, restore: (s, d, x) => { d.deadline_at = x || ''; } },
  date:     { json: 1, label: (s, v) => { if (v.iso) { const b = dueBadge(v.iso); return b.label + (v.time ? ' ' + s.fmtTime(v.time) : ''); } return s.fmtTime(v.time); },
              commit: (s, d, v) => { d.due_at = v.iso || d.due_at || isoDate(new Date()); if (v.iso) d.available_from = v.from ?? null; if (v.time) d.dueTime = v.time; }, clear: (s, d) => { d.due_at = ''; d.available_from = ''; d.dueTime = ''; }, snapshot: (s, d) => ({ due_at: d.due_at, available_from: d.available_from, dueTime: d.dueTime }), restore: (s, d, x) => { d.due_at = x?.due_at || ''; d.available_from = x?.available_from || ''; d.dueTime = x?.dueTime || ''; } },
};
// Decode a pill's dataset.value back to its typed JS value (JSON-encoded kinds vs string vs number).
function pillValue(kind, raw) { const sp = PILL_SPEC[kind]; return sp.json ? JSON.parse(raw) : sp.num ? +raw : raw; }
const DIALOG_KEYS = ['shortcutsOpen', 'trashOpen', 'locMgr', 'filterEdit', 'eventEdit', 'blockEdit', 'delAsk', 'goalOffer'];
// Completion-relevant fields for undo/redo fx diff — shared across _captureCompletionFx and _performOne task-delete path.
const FX_FIELDS = t => ({ completed_at: t.completed_at ?? null, due_at: t.due_at ?? null, completions: t.completions, recurrence: t.recurrence });
// Picker specs — drives openPicker/refreshPicker/pickPill/pickerKeydown generically.
const PICKERS = {
  area: { key: 'areaPicker', char: '@', sel: '.area-autocomplete', kind: 'area', name: (s, id) => s.areaById(id)?.name,
          onCreate: s => s.areaPicker.frag.trim() ? (s.createAreaFromPicker(), true) : false },
  goal: { key: 'goalPicker', char: '^', sel: '.goal-autocomplete', kind: 'goal', name: (s, id) => s.goalById(id)?.name },
};
// The composer draft's empty shape — one source of truth for the title draft, resetDraft, and subtask sub-drafts.
const emptyDraft = () => ({ content: '', notes: '', importance: 'none', due_at: '', available_from: '', deadline_at: '', durH: 0, durM: 0, dateText: '', dueTime: '', project: null, project_id: null, areas: [], goal_ids: [], checklist: [], recurrence: null, location: { mode: 'any', ids: [] } });
const QF_DUE = { today: { verb: 'due', label: 'today', col: 'var(--q-today)' }, overdue: { verb: '', label: 'overdue', col: 'var(--p1)' }, has: { verb: 'that', label: 'has a date', col: 'var(--accent)' }, none: { verb: 'with', label: 'no date', col: 'var(--faint)' } };
let _nowFocusEl = null;   // refocused on back/Escape

// Activity memo keyed on _activityV (bumped by every loadStats call) — logGoal/addGoalNote refresh via loadStats alone, so _calDataV would go stale.
let _activityV = 0;
const _goalLogMemo = new Map(), _goalLastActiveMemo = new Map();
const _recentMemo = new Map();   // home-wide, keyed on _activityV alone
const _identVotesMemo = new Map();   // keyed on ident.id+'|'+_activityV

// Memoize fn() keyed on sig; cap>0 bounds cache size (clear on overflow — stale-version entries never hit).
// Uses undefined-not-truthy so callers that legitimately cache null (e.g. goalLastActive) get real hits.
// DEP-TOUCH invariant: callers must read reactive deps BEFORE calling _memo so they run on every call.
const _memo = (map, sig, fn, cap = 0) => { const hit = map.get(sig); if (hit !== undefined) return hit; const out = fn(); if (cap && map.size >= cap) map.clear(); map.set(sig, out); return out; };

// local HH:MM — shared by log-when-popover defaults
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
// Extract "HH:MM" from a stored ISO string; returns fb (default '') for date-only

// shared by goalLog + arriving goal-stream
const groupByDay = (rows, dayLabel) => {
  const out = [];
  for (const r of rows) {
    if (!out.length || out[out.length - 1].dayKey !== r.dayKey) out.push({ dayKey: r.dayKey, day: dayLabel(r.dayKey), rows: [] });
    out[out.length - 1].rows.push(r);
  }
  return out;
};
const buildByParent = (tasks, sort = true) => {
  const m = new Map(); for (const t of tasks) { const a = m.get(t.parent_id); a ? a.push(t) : m.set(t.parent_id, [t]); }
  if (sort) for (const a of m.values()) a.sort((x, y) => (x.position ?? 0) - (y.position ?? 0)); return m;
};

// Fire component (locked design, ported from fire-css.html): shared filters/paths live in index.html #fire-defs; stage lives on the wrapping .fire class.
const FIRE_BURST = [[26, 0], [19, -19], [0, -27], [-19, -19], [-26, 0], [-19, 19], [0, 27], [19, 19]]
  .map(([tx, ty]) => `<span class="fx burst-spark" style="--tx:${tx}px;--ty:${ty}px"></span>`).join('');
// x-html string — reused by list + goal-detail
const FIRE_INNER = '<em></em><svg class="flame" viewBox="0 0 100 130" preserveAspectRatio="xMidYMax meet"><use href="#flA"/></svg><b></b><b></b><span class="coals"></span>' +
  '<span class="fx bloom"></span><span class="fx flash"></span>' +
  '<span class="fx corona"></span><span class="fx corona c2"></span><span class="fx corona c3"></span>' +
  '<span class="fx spark"></span><span class="fx ember-p p1"></span><span class="fx ember-p p2"></span>' +
  '<span class="rise-p" style="--dx:-3px;left:23px;animation-delay:0s"></span><span class="rise-p" style="--dx:4px;left:28px;animation-delay:1s"></span><span class="rise-p" style="--dx:-1px;left:25px;animation-delay:1.9s"></span>' +
  '<span class="log-ember" style="--dx:-9px;left:20px"></span><span class="log-ember" style="--dx:1px;left:25px;animation-delay:.04s"></span><span class="log-ember" style="--dx:9px;left:31px;animation-delay:.02s"></span><span class="log-ember" style="--dx:3px;left:26px;animation-delay:.09s"></span>' + FIRE_BURST;

// Alpine rejects x-transition promises with { isFromCancelledTransition: true } on interrupt (toast/undo routinely cut short) — swallow to keep the no-console-errors contract.
window.addEventListener('unhandledrejection', e => { if (e.reason?.isFromCancelledTransition) e.preventDefault(); });

document.addEventListener('alpine:init', () => {
  Alpine.data('adherod', () => ({
    store: createLocalStore(),
    session: null,
    authEmail: '', authCode: '', authSent: false, authMsg: '', authPass: '', authErr: false,   // inline sign-in (settings popup)
    tasks: [],
    byId: new Map(),        // id → task, rebuilt in loadTasks → O(1) lookups (projName/blocked) instead of tasks.find
    parentIds: new Set(),   // ids that have children, rebuilt with byId — hasChildren was O(n) per call and rode every flush via the Now getters (stage-4 profile: 12,800 calls = 2.1s of a 2.2s save)
    areas: [],
    goals: [],              // all goals, loaded from store (mirrors areas)
    identities: [],         // identity entities, kept in sync alongside goals
    goalStats: {},          // {[goalId]: goalProgress + goalWarmth} for ACTIVE goals, cached alongside EXP stats
    homeW: 8,               // ambient home warmth (HEARTH.ember=8..100), cached in loadStats — see homeBand()
    homeDots: [],           // 14-day rhythm dots: any active goal showed up that day, cached in loadStats
    goalsView: 'fires',     // Goals surface tab: 'fires' (goal board) | 'identities' (GR7, stub for now)
    pulseGoal: null,        // transient: id of the goal currently pulsing after a Log tap (~600ms)
    _pulseT: null,          // pulse timeout id, reset on each Log so a rapid re-log doesn't clear early
    ignitingGoal: null,     // transient: id of the goal whose fire just caught (unlit/undefined→kindling), ~950ms
    _ignitingT: null,       // igniting timeout id, reset each time so a rapid re-catch doesn't clear early
    goalOffer: null,         // { kind: 'graduate'|'finish'|'reflect', id } of open offer dialog; null = closed
    graduatingGoal: null,   // transient: id of the goal playing the graduation celebration (~2050ms, full .graduating choreography)
    _graduatingT: null,     // graduating timeout id, reset each time so a rapid re-graduate doesn't clear early
    msBeatGid: null,        // transient: id of the goal showing the milestone reorientation line (~1400ms)
    _msBeatT: null,         // msBeat timeout id
    logWhenOpen: null,      // GS13: id of the goal whose "log at a specific time" pop is open; null = closed
    logWhenT1: '', logWhenT2: '', logWhenDT: '',   // pop inputs: earlier-today time, yesterday time, pick datetime-local
    notifs: [],   // bottom-right notification stack: [{ id, msg, actions:[{label, fn}], leaving }]
    journal: [], cursor: 0, _jV: 0,   // inverse-op recovery engine (⌘Z/⌘⇧Z drive undo()/redo())
    draftRestored: false,   // an unsaved composer draft was recovered on open → show the restore banner
    _draftBase: '',         // pristine draft serialization at open — dirty = current !== this; drives persist/keep-on-close
    trashOpen: false,   // "Recently deleted" popup (keybound like ?) — trashItems() reads the journal, reactive on _jV
    chipGlintId: null, _chipGlintT: null,   // GS9: task id whose goal chip briefly glints warm on completion
    chkOpen: new Set(),     // task ids whose collapsed "…N more" done checklist items are expanded in the list
    goalOpenId: null,       // inline-expand: ID of the goal whose composer is currently open; null = all collapsed
    _newGoalId: null,       // FIX6: id of a just-created goal via newGoalComposer; removed on Cancel if left untouched
    logWhenNote: '',        // FIX8: optional "what did you do" note for a show-up log; cleared after logging
    goalDraft: null,        // {name,identity,targets,target_date,favorite,color,icon} while a goal composer is open
    identSug: { open: false, sel: -1 },   // identity suggestion pop state
    identMenuId: null,      // ID5: identity ⋯ menu pop currently open; null = all closed
    identEditId: null,      // ID5: identity block currently in inline-edit mode; null = none
    goalDetailId: null,     // inline-expand: ID of the goal whose READ detail is open; mutually exclusive with goalOpenId
    filters: [],            // saved filters (sidebar), loaded from store
    filterEdit: null,       // filter being edited in the modal: {id?, name, query, color}; null = closed
    feTab: 'examples',      // filter editor: active reference tab (the reference is always open, never a dropdown)
    locations: [],          // all locations, loaded from store
    pendingRegions: [],     // region names created in the manager but not yet holding a location (string model has no empty regions)
    dragLocId: null,        // location being dragged between region headers
    dragOverRegion: null,   // region currently hovered as a drop target
    events: [],             // calendar events, loaded from store
    blocks: [],             // condition-bearing blocks (environment per span), loaded from store
    scheduleItems: [],      // task↔block attachments; [] before migration is applied
    blockDays: [],          // block_day answer rows (start/skip/undo written here and on Android)
    clView: 'month',        // calendar view: day | week | month | year
    clSideOpen: false, clDropHint: null,   // Plan side-panel (scheduled + unscheduled + composer) toggle + drop-hover day iso
    clDropPreview: null,   // { iso, min, h, label } — live ghost of where a drag will land in a week/day column
    clAnchor: isoDate(new Date()),   // calendar anchor date (YYYY-MM-DD); drives the visible period
    clRowH: 0,              // month week-row height in px = (viewport − bar − header) / 6 (macOS: 6 weeks fill the page)
    clVisStart: 0,          // index of the first virtualized week row currently rendered
    clVisCount: 0,          // number of week rows rendered (visible + buffer); the rest is empty spacer
    clTopMonth: '',         // scroll-driven month label for the toolbar period (month view)
    clScrolling: false,     // true briefly during/after scroll → month bands visible; idle → they fade out
    clVT: false,            // a view transition is capturing — see .calendar.vt (view-transition-name is layer-promoting, so it may not linger)
    clSettling: false, clPlaced: null,   // E3 arrival stagger · E4/F4 the block that just landed springs into place
    clPVisStart: 0, clPVisCount: 3, clTLBase: 0, clTLView: '',   // virtualization window + spacer origin (and the view it belongs to) over the continuous day/week timeline
    clTopPeriod: '',        // scroll-driven day/week heading (mirrors clTopMonth)
    clScrollTop: 0,         // drives band rise/fade in clMonthBands
    clFocusYM: null,        // dominant month at center — others dim when idle
    clZoom: 1,              // 1 = whole day fits; >1 scrolls
    clHourH: 0,             // px per hour when zoomed (0 = fit)
    eventEdit: null,        // null = closed
    blockEdit: null,        // null = closed
    clDragBand: null,       // preview while drag-creating a block
    homeLocationId: null,   // designated home place (mirror of store)
    currentRegion: 'Home',
    locMgr: false,
    travelPair: { from: '', to: '', min: 20 },
    travel: [],
    navSel: { type: 'all', id: null },
    // --- Spatial-canvas spine: top-level surface ∈ surfaceOrder; navSel keeps the Lists inner selection ---
    ...(() => {   // settings popup persists surface order + struck-off set (adherod.surfaces) over the config default
      const all = SURFACES ?? ['lists', 'plan', 'now', 'goals'];   // Now centered (index 2), flanked by Plan/Goals; SURFACES trims the deployed shell
      let p = {}; try { p = JSON.parse(localStorage.getItem('adherod.surfaces')) || {}; } catch {}
      const ord = Array.isArray(p.order) ? p.order : [];
      const surfAll = ord.filter(s => all.includes(s)).concat(all.filter(s => !ord.includes(s)));   // full known set, user order first
      let surfOff = (Array.isArray(p.off) ? p.off : []).filter(s => surfAll.includes(s));
      let surfaceOrder = surfAll.filter(s => !surfOff.includes(s));
      if (!surfaceOrder.length) { surfOff = []; surfaceOrder = surfAll.slice(); }   // never zero lit surfaces
      const home = surfaceOrder.includes(SURF_HOME) ? SURF_HOME : surfaceOrder.includes('lists') ? 'lists' : surfaceOrder[0];
      return { surfAll, surfOff, surfaceOrder, surface: home,
        visited: { [home]: true } };   // lazy-mount memory — heavy surfaces (Plan) mount on first visit, stay mounted
    })(),
    nowFocusId: null,        // VIEW state only — never mutates data
    _nowTickV: 0,            // keeps now-window clock honest
    drag: { active: false, x0: 0, y0: 0, w: 0, t0: 0, id: null, axis: null },
    dragDx: 0,
    dragging: false,
    overview: false,
    ovSel: 0,
    rollerSel: 0,
    navPopXY: null,                   // escapes overflow clip
    collapsed: {},
    draft: emptyDraft(),
    subDraft: emptyDraft(),           // scratch draft the focused subtask editor's pills write to (rebuilt from that row's DOM on focus)
    composer: { open: false },
    palette: { open: false, q: '', sel: 0 },
    listQ: '',          // ⌘K escalates to palette
    showCompleted: false,   // view-controls toggle; completed tasks hidden by default, persisted to localStorage
    sortBy: 'manual',   // Lists sort: manual|due|importance|alpha|created|deadline (manual = drag/position order); persisted
    sortDir: 'asc',     // asc|desc — ignored for manual
    listMenu: null,     // open toolbar dropdown: 'add'|'sort'|null (kept separate from the composer's `pop`)
    listSearchOpen: false,   // Hearthsay search: icon at rest, input unfolds on click or `/`
    qfImp: [],          // quick-filter: importance values to keep (must/focus/none/someday); empty = all
    qfAreas: [],        // quick-filter: area ids to keep; empty = all
    qfDue: null,        // quick-filter: 'today'|'overdue'|'has'|'none'|null
    qfArchived: false,  // quick-filter: when on, show ONLY archived tasks (a flat "Archived" view)
    editing: null,
    confirm: null,
    shortcutsOpen: false,
    grown: false,
    clip: false,
    growH: null,        // null = auto; pre-set to avoid auto-height flash on first render
    startH: 0,          // drives crossfade overlap
    blockH: 0,
    subGhost: '',
    chkGhost: '',
    hoverId: null,      // highlights row + direct subtasks as one block
    focusId: null,      // keyboard-focused list row (j/k/↑↓); Enter/e opens it, x/Space completes it
    sel: [],            // multi-select: ids of selected task rows (drives the edit bar; the row .selected class is painted imperatively, never a per-row reactive :class — list-perf)
    selAnchor: null,    // range anchor for Shift-click / Shift+↑↓
    selMenu: null,      // open edit-bar sub-menu: 'move'|'prio'|'due'|null
    _rowV: 0,           // visibleRows() memo key — bump on any task/area/goal/collapse change
    dragId: null,
    railList: [],           // move-rail drop targets, populated while a task row is dragged
    railHot: null,          // rail target currently under the drag (kind+id), for the tint highlight
    _t: null,
    pop: null, popXY: { left: 0, top: 0 },
    titleEmpty: true,
    areaPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
    goalPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
    _areaFuzzy: null,
    cal: { y: 0, m: 0 },
    projRequired: false,
    pickerQ: '',
    newAreaName: '',
    // Nav management state
    navPop: null,
    navRename: null,
    delAsk: null,   // null | { kind:'project'|'task', id, mode:'move'|'delete', target, name, count, source? }
    // Global color list (user-extendable via settings later) + the gray default for areas with no color.
    colors: DESIGN.palette,
    L: DESIGN.lang.labels,
    areaDefault: '#9aa0a6',
    areaIcons: ['i-tag-tag','i-tag-home','i-tag-briefcase','i-tag-star','i-tag-heart','i-tag-book','i-tag-cart','i-tag-dollar','i-tag-code','i-tag-dumbbell','i-tag-plane','i-tag-bell','i-tag-flame','i-tag-leaf','i-tag-music','i-tag-map','i-tag-zap','i-tag-globe','i-tag-camera','i-tag-gift'],
    relSel: null,             // clicked relation candidate (overrides the top hit)
    relWarm: '', _relWarmT: 0, // well flashing amber as a link lands
    relDragOver: '',          // which well is being dragged over (drag-over affordance)
    // Task-list drag state
    taskDropHint: null,
    _dragX0: 0, _dragDepth: 0,
    _dragDescs: null,            // hidden during drag so the whole subtree moves
    _editDescs: null,            // precomputed so hiddenInEdit is O(1)/row
    durPresets: [
      { min: 5, label: '5m' }, { min: 15, label: '15m' }, { min: 30, label: '30m' },
      { min: 60, label: '1h' }, { min: 90, label: '1h 30m' }, { min: 120, label: '2h' },
    ],

    // LocalStore needs no auth; cloud adopts the existing session before loading.
    async init() {
      try { this.collapsed = JSON.parse(localStorage.getItem('adherod.nav.collapsed') || '{}'); } catch { this.collapsed = {}; }
      this.showCompleted = localStorage.getItem('adherod.list.showCompleted') === '1';   // persists the view setting across sessions
      try { Object.assign(this, JSON.parse(localStorage.getItem('adherod.list.view') || '{}')); } catch {}   // restore sort + quick-filters
      if (this.sortBy === 'priority') this.sortBy = 'importance';   // legacy sort key → importance cutover
      if (!Array.isArray(this.qfImp)) this.qfImp = [];              // legacy qfPri (numeric) doesn't map — clears
      const sb = sbClient();
      if (sb) {
        const { data } = await sb.auth.getSession();
        if (data.session) { this.session = data.session; this.store = createSupabaseStore(sb); }
        sb.auth.onAuthStateChange((e, session) => { if (e !== 'INITIAL_SESSION') this.onAuth(session); });
      }
      await this.reloadAll();
      this._journalLoad();
      this._subscribeStore();     // activate realtime sync (no-op on LocalStore/tests)
      setInterval(() => { this._nowTickV++; }, 60000);   // keeps the Now-window's now-line/leave-by honest with the real clock
      document.addEventListener('selectionchange', () => this._chkSelTint());   // checklist cross-row selection tint
      // defer-to-blur decoration: desc and checklist items show raw text while focused, decorated on blur.
      // chk handlers use item.text (authoritative) not el.textContent (potentially stale on reused elements).
      const chkItem = (el) => {
        const id = el.closest?.('.entry.chk')?.dataset.id;
        return id ? this.draft.checklist.find(c => c.id === id) : null;
      };
      document.addEventListener('focus', (e) => {
        const el = e.target;
        if (el === this.$refs.desc) { this.onDescFocus(el); return; }
        if (el.matches?.('.composer-entries .entry.chk:not(.ghost) .entry-txt')) {
          const item = chkItem(el);
          if (item) el.textContent = item.text;   // restore raw text from authoritative item
        }
      }, true);
      document.addEventListener('blur', (e) => {
        const el = e.target;
        if (el === this.$refs.desc) { this.onDescBlur(el); return; }
        if (el.matches?.('.composer-entries .entry.chk:not(.ghost) .entry-txt')) {
          const item = chkItem(el);
          if (item) el.innerHTML = chkLiveRender(item.text);   // decorate from authoritative item.text
        }
      }, true);
      this.$nextTick(() => {
        const list = document.querySelector('.list');
        if (list) new ResizeObserver(() => this.fitRows()).observe(list);
        // content-visibility skips offscreen layout — re-fit on scroll so revealed rows collapse correctly.
        const app = document.querySelector('.app');
        if (app) app.addEventListener('scroll', () => this.fitRows(), { passive: true });
      });
    },
    // Things-style: title squeezed by areas → icons only; still squeezed → roll extras into "+N".
    fitRows() {
      // rAF-throttle: ResizeObserver fires ~28× per composer-grow open; undebounced each call forces a full-list layout (~1s freeze at 1k rows).
      if (_fitQ) return;
      _fitQ = requestAnimationFrame(() => {
        _fitQ = 0;
        // Batch: interleaving classList writes with scrollWidth reads forces a reflow per row (O(n) freeze at ~1k rows).
        const rows = [...document.querySelectorAll('.list .item .r1l')];
        for (const r1l of rows) r1l.classList.remove('icons-only', 'rolled');
        const plan = rows.map(r1l => {
          const title = r1l.querySelector('.title'), areas = r1l.querySelector('.areas');
          if (!title || !areas) return null;
          if (areas.querySelectorAll('.area').length > 3) return { r1l, cls: ['icons-only', 'rolled'] };
          const cap = parseFloat(getComputedStyle(title).maxWidth) || Infinity;
          return (title.scrollWidth > title.clientWidth + 1 && title.clientWidth < cap - 1) ? { r1l, cls: ['icons-only'] } : null;
        });
        for (const p of plan) if (p) p.r1l.classList.add(...p.cls);
      });
    },

    // --- Nav ---
    setNav(type, id = null) {
      const SURF = { now: 'now', calendar: 'plan', stats: 'goals', goals: 'goals' };   // legacy type → surface
      if (this.composer.open && (type !== this.navSel.type || id !== this.navSel.id)) this.closeComposer();
      this.nowFocusId = null;                      // leaving/re-entering Now always starts back at the choices
      this.navSel = { type, id };                 // unchanged: legacy navSel.type gates keep working
      this.surface = SURF[type] || 'lists';       // mirror into the surface layer (list-types → Lists)
      this.visited[this.surface] = true;
      this.navPop = null;
    },
    surfaceIndex() { return this.surfaceOrder.indexOf(this.surface); },
    surfaceStyle(name) { const i = this.surfaceOrder.indexOf(name); return i < 0 ? 'display:none' : 'order:' + i; },   // visual order follows surfaceOrder; trimmed surfaces vanish
    mounted(name) { return this.surface === name || !!this.visited[name]; },   // gate lazy-mounted heavy surfaces
    goSurface(name) {
      if (!this.surfaceOrder.includes(name)) return;
      if (this.composer.open) this.closeComposer();
      this.nowFocusId = null;                      // leaving/re-entering Now always starts back at the choices
      this.visited[name] = true;
      this.surface = name; this.navPop = null;
    },
    openOverview() {
      // Only close the composer if it's empty — non-empty content is kept behind the overview so the user doesn't lose work.
      if (this.composer.open && !this.draft.content.trim() && !this.draft.notes && !this.draft.due_at) this.closeComposer();
      this.ovSel = this.surfaceIndex(); this.rollerSel = 0; this.overview = true; this.rollerCenter();
    },
    closeOverview() { this.overview = false; },
    surfaceLabel(s) { return SURF_META[s]?.label || s; },
    dotStripHtml(surfaces, idx) { return dotStripMarkup(surfaces, idx); },
    rollerBoxHtml(it) { return rollerBoxMarkup(it); },
    dotStripClick(e) { const b = e.target.closest('[data-idx]'); if (!b) return; const i = +b.dataset.idx; if (i === this.surfaceIndex()) this.openOverview(); else this.goSurface(this.surfaceOrder[i]); },
    diveTo(name) { this.overview = false; this.goSurface(name); },
    ovMove(d) { const n = this.surfaceOrder.length; this.ovSel = (this.ovSel + d + n) % n; if (this.ovSel === 0) this.rollerCenter(); },
    // Deliberate up-scroll at top → true (shared by list/calendar). Swallows the leading edge on arrival and after idle gaps to avoid inertia false-triggers.
    _pullUp(s, deltaY, atTop) {
      const now = performance.now();
      if (!atTop) { s.belowT = now; s.accum = 0; return false; }                       // below the top → note when, reset
      if (deltaY >= 0) { s.accum = 0; return false; }                                  // scrolling down while at the top → reset
      if (s.belowT != null && now - s.belowT < 400) { s.accum = 0; return false; }     // within the momentum tail after arriving from below → ignore (kills the accidental pull-up), but a fresh up-scroll at the top counts immediately
      s.accum = (s.accum || 0) - deltaY;                                               // deliberate up-scroll begun at the top
      if (s.accum > 220) { s.accum = 0; return true; }   // deliberate threshold — mirrored by onOverviewWheel's dismiss
      return false;
    },
    // Mirror of the pull-up: down-scroll past threshold dismisses the overview.
    // Walk from→to checking overflow on axis; if delta given, also checks current scroll position (canvas only)
    _ownedByScroller(from, to, axis, delta = 0) {
      const [ov, sz, cl, pos] = axis === 'x'
        ? ['overflowX', 'scrollWidth', 'clientWidth', 'scrollLeft']
        : ['overflowY', 'scrollHeight', 'clientHeight', 'scrollTop'];
      for (let n = from; n && n !== to; n = n.parentElement) {
        if (n.nodeType !== 1) continue;
        const o = getComputedStyle(n)[ov];
        if ((o === 'auto' || o === 'scroll') && n[sz] - n[cl] > 1) {
          if (!delta) return true;
          const max = n[sz] - n[cl];
          if ((delta < 0 && n[pos] > 0) || (delta > 0 && n[pos] < max)) return true;
        }
      }
      return false;
    },
    onOverviewWheel(e) {
      const s = this._ovd = this._ovd || {};
      const now = performance.now(), gap = now - (s.t || 0); s.t = now;
      if (e.deltaY <= 0) { s.accum = 0; return; }          // scrolling up → reset
      // A nested list (the project/area/location roller) owns the gesture whenever it is scrollable — you
      // over-scroll a short roller constantly, and that bounce must never dismiss the overview. Dismiss only
      // fires from a down-scroll over the non-scrollable overview background.
      if (this._ownedByScroller(e.target, e.currentTarget, 'y')) { s.accum = 0; return; }
      if (gap > 500) { s.accum = 0; return; }              // fresh after idle → swallow the leading edge (inertial tail)
      s.accum = (s.accum || 0) + e.deltaY;
      if (s.accum > 220) { s.accum = 0; this.closeOverview(); }
    },
    onOverscroll(e) {   // pull up the overview by over-scrolling UP at the top of the surface
      if (this.overview || this.surface === 'plan' || this.dragId || this.composer.open) return;   // never pull up the overview mid drag-to-move, nor over an open composer (an up-scroll while composing must not yank you away)
      const ct = e.currentTarget;
      const sc = ct.scrollHeight > ct.clientHeight + 1 ? ct : (ct.querySelector('.app, .goals-view, .now-home') || ct);   // the actual scroller (handler may sit on the full-width surface)
      if (sc !== ct && !sc.contains(e.target)) sc.scrollTop += e.deltaY;   // wheel over the surface margins (outside the centered scroller) → forward it so the list still scrolls
      // Bail if gesture originates inside an inner scrollable (dropdown, popup) — never let those bleed to the overview.
      if (e.deltaY < 0 && this._ownedByScroller(e.target, sc, 'y')) return;
      if (this._pullUp(this._os = this._os || {}, e.deltaY, sc.scrollTop <= 0)) this.openOverview();
    },
    onCalTitleWheel(e) {   // deliberate up-scroll over the calendar TITLE bar pulls up the overview (onOverscroll bails on 'plan')
      if (this.overview) return;
      if (this._pullUp(this._ct = this._ct || {}, e.deltaY, true)) this.openOverview();   // the title bar is always the "top"
    },
    onCanvasWheel(e) {   // horizontal trackpad scroll switches surfaces (like a swipe); one move per gesture
      if (this.overview || this.anyDialog() || this.dragging) return;
      if (e.target.closest('input, textarea, [contenteditable], .inp')) return;                      // don't hijack scroll started over an editable field
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;                                          // horizontal-dominant gestures only
      if (this._ownedByScroller(e.target, e.currentTarget, 'x', e.deltaX)) return;                   // defer to a real horizontal scroller that can still scroll
      // One page per swipe: after a switch, stay locked through the inertial tail. Release when deltaX ≈0, user pauses, or deltaX doubles back (only a genuine new flick reverses).
      const adx = Math.abs(e.deltaX), prev = this._whPrev || 0; this._whPrev = adx;
      const gap = e.timeStamp - (this._whT || 0); this._whT = e.timeStamp;
      if (gap > 120 || adx <= 4 || (this._whLock && adx > prev * 2 && adx > 30)) { this._whLock = false; this._whAccum = 0; }
      if (this._whLock) return;                                      // still the decaying inertial tail → ignore
      this._whAccum = (this._whAccum || 0) + e.deltaX;
      if (Math.abs(this._whAccum) > 50) {
        const dir = this._whAccum > 0 ? 1 : -1, i = this.surfaceIndex();
        this._whAccum = 0; this._whLock = true;
        this.goSurface(this.surfaceOrder[Math.max(0, Math.min(this.surfaceOrder.length - 1, i + dir))]);
      }
    },
    // Where a drag lands: a velocity flick steps one neighbour; else cross the half-way line; clamp to ends. (emil §10)
    snapTarget(dx, w, vx, idx, n) {
      const flick = Math.abs(vx) > 0.5 && Math.abs(dx) > 8;   // px/ms
      let next = flick ? idx + (vx < 0 ? 1 : -1) : (Math.abs(dx) > w / 2 ? idx + (dx < 0 ? 1 : -1) : idx);
      return Math.max(0, Math.min(n - 1, next));
    },
    canvasDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('input, textarea, [contenteditable], .inp')) return;   // let text selection start inside a field, don't begin a surface swipe
      if (this.drag.active) return;   // ignore extra touch points once a drag owns the pointer
      this.drag = { active: true, x0: e.clientX, y0: e.clientY, w: this.$refs.canvas.offsetWidth, t0: performance.now(), id: e.pointerId, axis: null };
    },
    canvasMove(e) {
      if (!this.drag.active || e.pointerId !== this.drag.id) return;
      const dx = e.clientX - this.drag.x0, dy = e.clientY - this.drag.y0;
      if (!this.drag.axis && Math.hypot(dx, dy) > 8) {       // lock the axis once past the threshold
        this.drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (this.drag.axis === 'x') { this.dragging = true; document.body.classList.add('swiping'); try { this.$refs.canvas.setPointerCapture(e.pointerId); } catch {} }
      }
      if (this.drag.axis !== 'x') return;                     // vertical → let the surface scroll natively
      e.preventDefault();
      let d = dx;
      const i = this.surfaceIndex(), n = this.surfaceOrder.length;
      if ((i === 0 && d > 0) || (i === n - 1 && d < 0)) d *= 0.3;   // rising resistance past the ends (emil §10)
      this.dragDx = d;   // reactive → the track's :style follows the finger (no manual transform clearing → no snap-to-Lists glitch)
    },
    canvasUp(e) {
      if (!this.drag.active || e.pointerId !== this.drag.id) return;
      this.drag.active = false; this.dragging = false; document.body.classList.remove('swiping');   // re-enable the transition + text selection
      const dx = this.dragDx, wasX = this.drag.axis === 'x';
      this.dragDx = 0;                                        // reactive → :style snaps back / to the new surface; tap (no move) is a no-op
      if (!wasX) return;                                      // a tap or a vertical scroll — stay put
      const vx = dx / Math.max(1, performance.now() - this.drag.t0);
      this.goSurface(this.surfaceOrder[this.snapTarget(dx, this.drag.w, vx, this.surfaceIndex(), this.surfaceOrder.length)]);
    },
    navHeading() {
      if (this.surface === 'now') return this.nowGreeting();
      if (this.navSel.type === 'all') return 'All';
      if (this.navSel.type === 'backlog') return 'Backlog';
      if (this.navSel.type === 'project') return this.byId.get(this.navSel.id)?.content ?? 'All';
      if (this.navSel.type === 'area') return this.areas.find(x => x.id === this.navSel.id)?.name ?? 'Area';
      if (this.navSel.type === 'filter') return this.activeFilter()?.name ?? 'Filter';
      if (this.surface === 'plan') return 'Calendar';
      if (this.surface === 'goals') return 'Goals';
      return 'All';
    },
    hasChildren(id) { return this.parentIds.has(id); },
    isSidebar(t) { return !!t.sidebar; },
    // Filter view: runFilter's ordered ids mapped to live task objects (order preserved).
    filterTasks() {
      const f = this.activeFilter(); if (!f) return [];
      return this.store.runFilter(f.query).map(id => this.tasks.find(t => t.id === id)).filter(Boolean);
    },
    scopeRoots() {
      const { type, id } = this.navSel, def = this.store.defaultProject();
      if (type === 'filter') return this.filterTasks();
      if (type === 'project') return this.childTasks(id);
      if (type === 'backlog') return this.childTasks(def);
      if (type === 'area') return this.tasks.filter(t => t.area_ids?.includes(id));
      // All: tasks whose parent is a container (root, backlog, sidebar project). byId keeps this O(n) — tasks.find per task melted at ~1k rows.
      const byId = this.byId;
      const inProject = pid => pid === null || pid === def || !!byId.get(pid)?.sidebar;
      return this.tasks.filter(t => !t.sidebar && t.id !== def && inProject(t.parent_id));
    },
    listHit(t) {
      const q = this.listQ.trim().toLowerCase(); if (!q) return true;
      return (t.content || '').toLowerCase().includes(q) || this.areaObjs(t.area_ids).some(l => (l.name || '').toLowerCase().includes(q));
    },
    // Quick-filters (Priority / Area / Due) layer on top of any view; ANDed with the search hit.
    qfActive() { return this.qfImp.length > 0 || this.qfAreas.length > 0 || !!this.qfDue; },   // narrowing filters only; done/archived are additive LENSES (like showCompleted), not narrowers
    filtering() { return !!this.listQ.trim() || this.qfActive(); },   // narrowing active → show matches + ancestor context
    qfPass(t) {
      if (this.qfImp.length && !this.qfImp.includes(t.importance || 'none')) return false;   // unset importance reads as 'none'
      if (this.qfAreas.length && !(t.area_ids || []).some(id => this.qfAreas.includes(id))) return false;
      if (this.qfDue) {
        const d = (t.due_at || '').slice(0, 10), today = isoDate(new Date());
        if (this.qfDue === 'has' && !d) return false;
        if (this.qfDue === 'none' && d) return false;
        if (this.qfDue === 'today' && d !== today) return false;
        if (this.qfDue === 'overdue' && !(d && d < today && !t.completed_at && !t.archived_at)) return false;
      }
      return true;
    },
    rowPass(t) { return this.listHit(t) && this.qfPass(t); },
    // Sibling/root comparator for the tree walk — null = manual (keep drag/position order). Ties fall back to position (stable).
    sibCmp() {
      const by = this.sortBy; if (by === 'manual') return null;
      const dir = this.sortDir === 'desc' ? -1 : 1, FAR = '\uffff';
      const base =
        by === 'due'      ? (a, b) => (a.due_at || FAR).localeCompare(b.due_at || FAR)
      : by === 'deadline' ? (a, b) => (a.deadline_at || FAR).localeCompare(b.deadline_at || FAR)
      : by === 'importance' ? (a, b) => impRank(a.importance) - impRank(b.importance) || (a.due_at || FAR).localeCompare(b.due_at || FAR)
      : by === 'created'  ? (a, b) => (a.created_at || '').localeCompare(b.created_at || '')
      :                     (a, b) => (a.content || '').localeCompare(b.content || '', undefined, { sensitivity: 'base' });   // alpha
      return (a, b) => dir * base(a, b) || (a.position ?? 0) - (b.position ?? 0);
    },
    _saveView() { localStorage.setItem('adherod.list.view', JSON.stringify({ sortBy: this.sortBy, sortDir: this.sortDir, qfImp: this.qfImp, qfAreas: this.qfAreas, qfDue: this.qfDue, qfArchived: this.qfArchived })); },
    setSort(key) { if (this.sortBy === key && key !== 'manual') this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'; else { this.sortBy = key; this.sortDir = 'asc'; } this._saveView(); },
    toggleQfImp(v) { const i = this.qfImp.indexOf(v); i < 0 ? this.qfImp.push(v) : this.qfImp.splice(i, 1); this._saveView(); },
    toggleQfArea(id) { const i = this.qfAreas.indexOf(id); i < 0 ? this.qfAreas.push(id) : this.qfAreas.splice(i, 1); this._saveView(); },
    setQfDue(v) { this.qfDue = this.qfDue === v ? null : v; this._saveView(); },
    toggleQfArchived() { this.qfArchived = !this.qfArchived; this._saveView(); },
    clearQf() { this.qfImp = []; this.qfAreas = []; this.qfDue = null; this.qfArchived = false; this._saveView(); },
    // ---- Hearthsay sentence labels (design: filters-ui-explorations.html A) ----
    qfImpLabel() { return [...this.qfImp].sort((a, b) => impRank(a) - impRank(b)).map(v => this.impName(v)).join('·'); },   // e.g. Must·Focus, importance order
    _qfArea() { return this.areas.find(a => a.id === this.qfAreas[0]); },
    qfAreaCol() { return this._qfArea()?.color || this.areaDefault; },
    qfAreaLabel() { const n = this.qfAreas.length; return (this._qfArea()?.name || '?') + (n > 1 ? ` +${n - 1}` : ''); },
    qfDueVerb()  { return QF_DUE[this.qfDue]?.verb ?? ''; },   // connective before the token; '' for overdue
    qfDueLabel() { return QF_DUE[this.qfDue]?.label; },
    qfDueCol()   { return QF_DUE[this.qfDue]?.col; },
    qfFacets() { return (this.qfImp.length ? 1 : 0) + (this.qfAreas.length ? 1 : 0) + (this.qfDue ? 1 : 0); },
    sortWord() { return ({ manual: 'hand', due: 'due date', importance: 'importance', deadline: 'deadline', alpha: 'a-z', created: 'date added' })[this.sortBy]; },   // follows the "· sorted by" verb
    // Escalate the ad-hoc sentence into a saved filter: prefill the editor with the equivalent query.
    lsSaveFilter() {
      const or = xs => xs.length > 1 ? `(${xs.join(' OR ')})` : xs[0];
      const aq = id => { const n = this.areas.find(a => a.id === id)?.name || ''; return '@' + (/\s/.test(n) ? `"${n}"` : n); };
      const parts = [];
      if (this.qfImp.length) parts.push(or([...this.qfImp].sort((a, b) => impRank(a) - impRank(b)).map(v => 'importance:' + v)));
      if (this.qfAreas.length) parts.push(or(this.qfAreas.map(aq)));
      if (this.qfDue) parts.push('due:' + ({ has: 'any' }[this.qfDue] || this.qfDue));
      this.listMenu = null; this.filterEdit = { name: '', query: parts.join(' '), color: null };
    },
    // All values, always — a filter you can't reach reads as missing, not tidy (user 2026-07-23). Importance order.
    availImp() { return ['must', 'focus', 'none', 'someday']; },
    // Children index (O(n) tree walk) + mkRow closure — shared by visibleRows and nowRows. Hot path: no per-row work added.
    _mkRowFn(sort, cmp) {
      const byId = this.byId, def = this.store.defaultProject(), now = new Date(), byParent = buildByParent(this.tasks, sort);
      if (cmp) for (const a of byParent.values()) a.sort(cmp);
      const edMemo = new Map();
      return { mkRow: (t, depth) => this.mkRow(t, depth, byParent, byId, def, now, edMemo), byParent, now, byId };
    },
    visibleRows() {
      // Reads here register Alpine deps so the x-for re-runs on change. Completed rows split into _doneMemo (rendered below the add button).
      const key = this._rowV + '|' + this.navSel.type + '|' + this.navSel.id + '|' + this.listQ + '|' + this.showCompleted
        + '|' + this.sortBy + this.sortDir + '|' + this.qfImp + '|' + this.qfAreas + '|' + this.qfDue + '|' + this.qfArchived;
      if (_visKey === key) return _visMemo;
      const filtering = this.filtering(), cmp = this.sibCmp();
      const { mkRow, byParent, now, byId } = this._mkRowFn(true, cmp);
      const out = [], done = [];   // active rows (main list) + below-the-line (completed via 'done' lens, archived via 'archived' lens)
      // Additive lenses: OPEN tasks always fill the main list; the 'done' lens adds completed tasks and the
      // 'archived' lens adds archived tasks to the below-the-line section (both, when both are on).
      const sink = (r) => {
        if (r.t.archived_at) { if (this.qfArchived) done.push(r); }
        else if (r.t.completed_at) { if (this.showCompleted) done.push(r); }
        else out.push(r);
      };
      // Filter view is a FLAT list (depth 0) — runFilter's order is the base; a chosen sort overrides it.
      if (this.navSel.type === 'filter') {
        let rows = filtering ? this.filterTasks().filter(t => this.rowPass(t)) : this.filterTasks();
        if (cmp) rows = rows.slice().sort(cmp);
        rows.forEach(t => sink(mkRow(t, 0)));
      } else {
        // When narrowing (search or quick-filters), keep only scope roots that pass + their full subtrees.
        // Subtask matches do NOT pull ancestors in — filters apply to top-level tasks only.
        let keep = null;
        if (filtering) {
          keep = new Set();
          const addSubtree = (id) => { keep.add(id); for (const c of (byParent.get(id) || [])) addSubtree(c.id); };
          for (const r of this.scopeRoots()) if (this.rowPass(r)) addSubtree(r.id);
          // Text search (not quick-filters) also surfaces matching SUBTASKS: add each text-matched task that
          // clears the quick-filter gates, plus its ancestor chain for context. Quick-filters stay top-level-only.
          if (this.listQ.trim()) for (const t of this.tasks) {
            if (keep.has(t.id) || !this.listHit(t) || !this.qfPass(t)) continue;
            keep.add(t.id);
            const seen = new Set([t.id]);
            for (let a = byId.get(t.parent_id); a && !seen.has(a.id); a = byId.get(a.parent_id)) { keep.add(a.id); seen.add(a.id); }
          }
        }
        // a completed (non-archived) root + its whole subtree → the Done list, tree-structured
        const visitDone = (t, depth) => { done.push(mkRow(t, depth)); for (const c of (byParent.get(t.id) || [])) visitDone(c, depth + 1); };
        const visit = (t, depth) => {
          if (keep && !keep.has(t.id)) return;
          // A completed/archived ROOT (+ its subtree) goes to the Done section or is hidden. A completed/archived
          // SUBTASK under an ACTIVE parent stays inline (struck / dashed) so it keeps its place in the tree.
          if (t.archived_at && depth === 0) { if (this.qfArchived) visitDone(t, 0); return; }   // archived lens → below-the-line section
          if (t.completed_at && depth === 0) { if (this.showCompleted) visitDone(t, 0); return; }
          out.push(mkRow(t, depth));
          if (this.isSidebar(t) && depth > 0) return;
          if (!filtering && this.collapsed[t.id]) return;   // searching/filtering reveals matches regardless of collapse
          for (const c of (byParent.get(t.id) || [])) visit(c, depth + 1);
        };
        let roots = this.scopeRoots();
        if (cmp) roots = roots.slice().sort(cmp);
        for (const r of roots) visit(r, 0);
      }
      const doneAll = done;
      // Neighbor ids so itemBlock (the hover "block" highlight) is O(1)/row — for both the active and Done lists.
      for (const arr of [out, doneAll]) for (let k = 0; k < arr.length; k++) {
        arr[k].prevId = arr[k - 1]?.t.id; arr[k].prevPid = arr[k - 1]?.t.parent_id;
        arr[k].nextId = arr[k + 1]?.t.id; arr[k].nextPid = arr[k + 1]?.t.parent_id;
      }
      _visKey = key; _visMemo = out; _doneMemo = doneAll;
      return out;
    },
    completedRows() { this.visibleRows(); return _doneMemo; },   // computed alongside visibleRows; the Done list below the add button
    // Same pure row markup as listHtml (order + depth padding so it aligns with the active list), so the single
    // composer can relocate into the Done list and open inline on a completed task. Edit styling via applyEditDom().
    // Shared <li> builder — used by _rowsHtml (list/done, with depth style + drag) and _clRowsHtml (tray, draggable always).
    _itemLi(r, { style = '', drag = '', schedTime = null } = {}) {
      const t = r.t;
      return '<li class="item' + (t.completed_at ? ' done' : t.archived_at ? ' archived' : '') + ' flex gap-10" data-id="' + t.id + '"' + (style ? ' style="' + style + '"' : '') + drag + '>' + this.rowBody(r, { schedTime }) + '</li>';
    },
    // Per-row height estimate for contain-intrinsic-size. `auto` only remembers a row once it has actually
    // rendered, so a never-seen row falls back to this — one flat 38px guess against real 34/46/54+ rows made
    // the scrollbar lurch on the way down (#307). Same content the row builder renders, so it tracks it.
    _rowCis(r) {
      const chk = r.chk || r.t.checklist || [];
      const n = chk.length ? chkVisible(chk, !!r.t.checklist_plain, this.chkOpen.has(r.t.id)) : null;
      return 34 + (r.t.notes ? 17 : 0) + (r.rels?.length ? 19 : 0) + (n ? 4 + (n.rows.length + (n.more ? 1 : 0)) * 19 : 0);
    },
    // Rows → one <li> html string. completedRows() always carry completed_at OR archived_at, so the trailing '' never fires there.
    _rowsHtml(rows, drag = '') {
      let s = '';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        s += this._itemLi(r, { style: 'order:' + (i * 2) + ';padding-left:calc(18px + ' + (r.depth * 22) + 'px);--d:' + r.depth + ';--ci:' + this._rowCis(r) + 'px', drag });
      }
      return s;
    },
    doneHtml() { return this._rowsHtml(this.completedRows()); },
    // ONE html string via x-html (mounting ~900 x-for scopes was ~1s; one innerHTML parse is ~50ms). hover/drag/kbfocus are delegated+imperative so they never trigger a rebuild.
    // Pure over visibleRows() — deliberately does NOT read `editing`, so opening the composer never rebuilds the
    // list (a rebuild recreates every row, drops content-visibility size memory, and teleports the scroll).
    // The edited-row crossfade + subtree-hide are applied imperatively by applyEditDom().
    listHtml() { return this._rowsHtml(this.visibleRows(), this.navSel.type !== 'area' ? ' draggable="true"' : ''); },
    // Keyed morph of a rows-html string into `container`, REUSING unchanged <li>s by data-id. A blanket
    // `container.innerHTML = h` recreates every row, so off-screen rows lose content-visibility's remembered size
    // (contain-intrinsic-size:auto) → they collapse to the estimate → the list reflows and the scroll teleports on a
    // single-field save (#306). Here only genuinely-changed rows are replaced; the rest keep their element identity —
    // and thus their size memory AND their imperative classes (hover/select/edit persist through the render).
    // `_sig` = the CLEAN template outerHTML at creation; imperative classes are added afterwards so they never enter
    // the compare (a stale live class would otherwise force a needless replace).
    // Cache-keyed morph with scroll preservation (fixes scroll teleport on save, #306). All 4 rows containers use this.
    renderRows(el, h) {
      if (el._h === h) return;
      const sc = el.closest('.app'), st = sc ? sc.scrollTop : 0;
      el._h = h; this.morphRows(el, h);
      if (sc) sc.scrollTop = st;
      queueMicrotask(() => { if (sc) sc.scrollTop = st; this.applyEditDom(); });
      if (st) requestAnimationFrame(() => { if (sc && !sc.scrollTop) sc.scrollTop = st; });
    },
    morphRows(container, html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const old = new Map();
      for (const el of container.children) old.set(el.dataset.id, el);
      let cursor = container.firstElementChild;
      for (const nw of [...tpl.content.children]) {
        const cur = old.get(nw.dataset.id);
        old.delete(nw.dataset.id);
        const node = (cur && cur._sig === nw.outerHTML) ? cur : Object.assign(nw, { _sig: nw.outerHTML });
        if (cur === cursor) { cursor = cursor.nextElementSibling; if (node !== cur) container.replaceChild(node, cur); }   // same slot: keep or swap in place
        else { if (cur && node !== cur) cur.remove(); container.insertBefore(node, cursor); }                             // reorder: drop the stale node (a fresh one replaces it), then place; new id → just insert
      }
      for (const el of old.values()) el.remove();
    },
    // Effective duration (min): own est_minutes, else the rolled-up sum of subtasks' effective durations. Memoized (O(n)).
    effDurMin(t, byParent, memo) {
      if (memo.has(t.id)) return memo.get(t.id);
      memo.set(t.id, 0);   // cycle guard
      let v = t.est_minutes || 0;
      if (!v) for (const c of (byParent.get(t.id) || [])) v += this.effDurMin(c, byParent, memo);
      memo.set(t.id, v);
      return v;
    },
    // shared by visibleRows() + nowRows() for consistent rendering
    mkRow(t, depth, byParent, byId, def, now, edMemo) {
      const kids = byParent.get(t.id) || [], parent = byId.get(t.parent_id), cl = t.checklist || [];
      const hasKids = kids.length > 0, hasCl = cl.length > 0;
      const rel = (ids, type) => (ids ?? []).map(id => ({ id, type, icon: this.relIcon(type), name: byId.get(id)?.content || '' }));
      const em = edMemo ? this.effDurMin(t, byParent, edMemo) : (t.est_minutes || 0);   // roll up subtasks when no own duration
      const dueB = (t.available_from || t.due_at) ? windowBadge(t, now) : null;
      return {
        t, depth, pc: this.pc(t.importance), collapsed: !!this.collapsed[t.id],
        // Precomputed here (cached in _visMemo) so glint-only re-renders don't redo the title regex / checklist split per row.
        titleHtml: mdTitleFn(t.content),
        chk: cl.map((c, ci) => { const sep = c.text.indexOf('::'); return { ci, done: !!c.done, txt: sep >= 0 ? c.text.slice(0, sep) : c.text, desc: sep >= 0 ? c.text.slice(sep + 2) : '' }; }),
        est: em ? this.durFmt(em) : '', estRollup: !t.est_minutes && em > 0,
        // specific clock time on the due date — only for near dates (today/tomorrow/weekday badges)
        dueTime: t.due_at && t.due_at.length > 10 && ['today', 'soon'].includes(dueB?.kind) ? this._clTime(t.due_at) : null,
        loc: this.rowLoc(t),
        locX: t.location?.mode === 'except',   // away-from → negated pin

        rels: [...rel(t.blocked_by, 'blocked_by'), ...rel(t.relates, 'relates')],
        due: dueB,
        dl: t.deadline_at ? deadlineLeft(t.deadline_at, now) : null,
        projName: parent ? parent.content : '',
        projColor: parent && parent.color ? 'color:' + parent.color : '',
        isDefaultProj: !!t.parent_id && t.parent_id === def,
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        goals: this.goalsForTask(t),
        childCount: kids.length,
        hasProgress: hasKids || hasCl,
        progress: hasKids ? Math.round(kids.filter(c => c.completed_at || c.archived_at).length / kids.length * 100) : (hasCl ? Math.round(cl.filter(c => c.done).length / cl.length * 100) : 0),
        blocked: (t.blocked_by ?? []).some(id => { const b = byId.get(id); return b && !b.completed_at && !b.archived_at; }), // inline isBlocked over byId — hot per-row path
      };
    },
    nowRows() {
      const { mkRow, byParent, now, byId } = this._mkRowFn(false);
      const today = isoDate(now);
      return this.tasks
        .filter(t => !t.completed_at && !t.archived_at && !this.isSidebar(t) && t.due_at && t.due_at.slice(0, 10) <= today)
        .sort((a, b) => (a.due_at || '').localeCompare(b.due_at || '') || impRank(a.importance) - impRank(b.importance))
        .map(t => mkRow(t, 0));
    },
    nowListRows() { const hero = this.nowTask(); return this.nowRows().filter(r => r.t.id !== hero?.id); },
    // Keyboard focus over the visible list rows (j/k/↑↓ move; Enter/e open; x/Space complete).
    moveFocus(d) {
      const rows = this.visibleRows();
      if (!rows.length) { this._setKbFocus(null); return; }
      const cur = rows.findIndex(r => r.t.id === this.focusId);
      const next = cur < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + d));
      this._setKbFocus(rows[next].t.id);
    },
    focusedTask() { return this.byId.get(this.focusId); },
    // ── Multi-select (Ctrl/Cmd-click toggle, Shift-click / Shift+↑↓ range) ─────────────────────────
    // TODO(touch): long-press to enter selection. Desktop-first for now.
    selTasks() { return this.sel.map(id => this.byId.get(id)).filter(Boolean); },
    toggleSel(id) { const i = this.sel.indexOf(id); this.sel = i >= 0 ? this.sel.filter(x => x !== id) : [...this.sel, id]; this.selAnchor = id; },
    clearSel() { this.sel = []; this.selAnchor = null; this.selMenu = null; },
    selectRange(id) {   // anchor..id in visibleRows order (anchor stays put so repeated Shift-clicks pivot from it)
      const rows = this.visibleRows();
      const a = rows.findIndex(r => r.t.id === (this.selAnchor ?? id)), b = rows.findIndex(r => r.t.id === id);
      if (a < 0 || b < 0) return this.toggleSel(id);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      this.sel = rows.slice(lo, hi + 1).map(r => r.t.id);
      this._setKbFocus(id);
    },
    selExtend(d) {   // Shift+↑/↓ — grow/shrink the anchor..focus range by one row
      const rows = this.visibleRows(); if (!rows.length) return;
      if (this.selAnchor == null || !this.sel.length) { this.selAnchor = this.focusId ?? rows[0].t.id; this.focusId = this.selAnchor; }
      let cur = rows.findIndex(r => r.t.id === this.focusId); if (cur < 0) cur = rows.findIndex(r => r.t.id === this.selAnchor);
      this.selectRange(rows[Math.max(0, Math.min(rows.length - 1, cur + d))].t.id);
    },
    // Paint .selected + run-position classes imperatively — O(selected) diff.
    // Contiguous selected rows form a rounded group: sel-top/sel-mid/sel-bot/sel-single (mirrors .inblock rounding).
    paintSel() {
      const ns = new Set(this.sel);   // reactive dep — x-effect re-runs when sel changes
      this.$nextTick(() => {
        const list = document.querySelector('.surface-lists .list');
        if (!list) { _selSet = ns; return; }
        const RUN = ['sel-top', 'sel-mid', 'sel-bot', 'sel-single'];
        const ps = _selSet;
        for (const id of ps) if (!ns.has(id)) { const el = list.querySelector(`.item[data-id="${id}"]`); if (el) { el.classList.remove('selected'); el.classList.remove(...RUN); } }
        if (ns.size) {
          // Build id→position map from visible task rows (visibleRows() is cached — O(1) hit on memo)
          const rows = this.visibleRows();
          const posMap = new Map();
          for (let i = 0; i < rows.length; i++) if (ns.has(rows[i].t.id)) posMap.set(rows[i].t.id, i);
          for (const [id, pos] of posMap) {
            const el = list.querySelector(`.item[data-id="${id}"]`);
            if (!el) continue;
            el.classList.add('selected');
            el.classList.remove(...RUN);
            const p = pos > 0 && ns.has(rows[pos - 1]?.t.id);
            const n = pos < rows.length - 1 && ns.has(rows[pos + 1]?.t.id);
            el.classList.add(!p && n ? 'sel-top' : p && n ? 'sel-mid' : p && !n ? 'sel-bot' : 'sel-single');
          }
        }
        _selSet = ns;
      });
    },
    // Bulk actions — each routes through perform() as ONE composite op, so a single ⌘Z reverses the whole batch.
    async _bulk(label, ops) { this.clearSel(); if (ops.length) await this.perform(label, { kind: 'composite', target: 'task', ops }, { bin: true }); },
    async selComplete() {
      const ops = this.selTasks().filter(t => !t.completed_at && !t.archived_at).map(t => ({ kind: 'complete', target: 'task', mode: 'forward', fwd: { id: t.id, done: true } }));
      await this._bulk(`Completed ${ops.length} tasks`, ops);
    },
    async selDelete() {
      await this._bulk(`Deleted ${this.sel.length} tasks`, [...this.sel].map(id => ({ kind: 'delete', target: 'task', id })));
    },
    async selSetPrio(v) {
      await this._bulk(`Set priority · ${this.sel.length}`, [...this.sel].map(id => ({ kind: 'update', target: 'task', id, after: { importance: v } })));
    },
    async selMoveToProject(p) {
      await this._bulk(`Moved ${this.sel.length} to ${p.content}`, [...this.sel].map(id => ({ kind: 'update', target: 'task', id, after: { parent_id: p.id } })));
    },
    async selAddArea(a) {
      const ops = this.selTasks().filter(t => !(t.area_ids || []).includes(a.id)).map(t => ({ kind: 'update', target: 'task', id: t.id, after: { area_ids: [...(t.area_ids || []), a.id] } }));
      await this._bulk(`Tagged ${ops.length} · ${a.name}`, ops);
    },
    // shift each selected task's due_at by the SAME delta (relative spacing preserved); only tasks that HAVE a date move
    _shiftIso(iso, days) { const dateOnly = iso.length <= 10; const d = new Date(dateOnly ? iso + 'T00:00' : iso); d.setDate(d.getDate() + days); const day = isoDate(d); return dateOnly ? day : day + iso.slice(10); },
    async selShiftDue(days) {
      const ops = this.selTasks().filter(t => t.due_at).map(t => ({ kind: 'update', target: 'task', id: t.id, after: { due_at: this._shiftIso(t.due_at, days) } }));
      if (!ops.length) { this.clearSel(); return this.toast('No due dates to shift'); }
      await this._bulk(`Shifted ${ops.length} due date${ops.length > 1 ? 's' : ''}`, ops);
    },
    openFocused() { const t = this.focusedTask(); if (t) this.editTask(t); },
    toggleFocused() { const t = this.focusedTask(); if (t) this.toggle(t); },
    toggleShowCompleted() {
      this.showCompleted = !this.showCompleted;
      localStorage.setItem('adherod.list.showCompleted', this.showCompleted ? '1' : '0');   // persist across sessions (visibleRows keys on it)
    },
    toggleTaskCollapse(id) {
      this.collapsed = { ...this.collapsed, [id]: !this.collapsed[id] };
      this._rowV++;
      localStorage.setItem('adherod.nav.collapsed', JSON.stringify(this.collapsed));
    },
    allProjectRows() {   // all sidebar projects at all depths always shown (roller uses this)
      const rows = [], def = this.store.defaultProject(), visit = (parentId, depth) => {
        for (const p of this.tasks.filter(x => x.parent_id === parentId && x.id !== def && x.sidebar).sort((a,b)=>a.position-b.position)) {
          rows.push({ p, depth }); visit(p.id, depth + 1);
        }
      };
      visit(null, 0);
      return rows;
    },
    rollerItems() {
      // no special 'all' picker item — "All tasks" is now a seeded, removable filter in the Filters section.
      const it = [{ kind: 'sec', label: 'Projects' },
                  { kind: 'backlog', type: 'backlog', id: null, label: 'Backlog' }];
      for (const { p, depth } of this.allProjectRows())
        it.push({ kind: 'proj', type: 'project', id: p.id, label: p.content, depth, p });
      it.push({ kind: 'sec', label: 'Filters' });
      for (const f of this.filters) it.push({ kind: 'filter', type: 'filter', id: f.id, label: f.name, f });
      it.push({ kind: 'sec', label: 'Areas' });
      for (const l of this.areas) it.push({ kind: 'area', type: 'area', id: l.id, label: l.name, l });
      it.push({ kind: 'sec', label: 'Locations' }, { kind: 'loc', label: 'Manage locations' });
      return it;
    },
    selectableRollerItems() { return this.rollerItems().filter(i => i.kind !== 'sec'); },
    rollerMove(d) { const n = this.selectableRollerItems().length;
      this.rollerSel = Math.max(0, Math.min(n - 1, this.rollerSel + d)); this.rollerCenter(); },
    rollerCenter() {   // scroll the focused box to the vertical middle of the rail; clamps at the ends (so the top eases off → shows All)
      this.$nextTick(() => { const r = this.$refs.roller; if (!r) return;
        const el = r.querySelector('.rl-wrap.rl-focus'); if (!el) return;
        const target = el.offsetTop - (r.clientHeight - el.offsetHeight) / 2;
        r.scrollTop = Math.max(0, Math.min(r.scrollHeight - r.clientHeight, target)); });
    },
    rollerOpen() {
      const it = this.selectableRollerItems()[this.rollerSel]; if (!it) return;
      if (it.kind === 'loc') { this.locMgr = true; this.loadLocations(); return; }   // dialog layers over the overview (z 200 > 60); leave the overview open behind it
      this.setNav(it.type, it.id); this.overview = false; this.goSurface('lists');
    },
    rollerClick(e) {
      const more = e.target.closest('[data-more]');
      if (more) {
        const [kind, id] = more.dataset.more.split(':');
        if (kind === 'filter') { this.openFilterEditor(this.filters.find(f => f.id === id)); return; }
        const r = more.getBoundingClientRect(), POPH = 320;   // anchor in fixed coords (escapes overflow); clamp so it never spills off the bottom
        this.navPopXY = { x: Math.min(r.left, window.innerWidth - 230), y: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - POPH)) };
        this.navPop = (this.navPop && this.navPop.id === id) ? null : { type: kind, id };
        this.navRename = null;
        return;
      }
      const box = e.target.closest('[data-ridx]');
      if (box) { this.rollerSel = +box.dataset.ridx; this.rollerOpen(); }
    },
    rollerCount(it) {
      const open = t => !this.isSidebar(t) && !t.completed_at && !t.archived_at;
      if (it.kind === 'backlog') { const d = this.store.defaultProject(); return this.tasks.filter(t => open(t) && t.parent_id === d).length; }
      if (it.kind === 'proj') return descendantIds(this.tasks, it.id)   // already includes it.id — no re-concat (double-counted direct children)
        .reduce((n, pid) => n + this.tasks.filter(t => open(t) && t.parent_id === pid).length, 0);
      if (it.kind === 'area') return this.tasks.filter(t => !t.completed_at && !t.archived_at && (t.area_ids || []).includes(it.id)).length;
      if (it.kind === 'filter') { try { return this.store.runFilter(it.f.query).length; } catch { return ''; } }
      return '';
    },
    rollerData(it, ri) {   // enrich a roller item with the icon/color/count/progress the box needs
      const d = { ...it, ridx: ri, count: this.rollerCount(it) };
      if (it.kind === 'proj') { d.icon = 'prog'; d.color = it.p.color || ''; d.progress = this.projectProgress(it.id) / 100; }
      else if (it.kind === 'area') { d.icon = it.l.icon || 'i-tag-tag'; d.color = it.l.color || this.areaDefault; }
      else if (it.kind === 'filter') { d.icon = it.f.query === 'is:any' ? 'i-all' : 'i-search'; d.color = it.f.color || ''; }   // the 'All tasks' null filter keeps its original glyph; filters aren't otherwise icon-configurable
      else if (it.kind === 'backlog') d.icon = 'i-backlog';
      else if (it.kind === 'loc') { d.icon = 'i-tag-map'; d.count = ''; }
      return d;
    },
    rollerRows() {   // rollerItems with section headers kept inline; non-sec rows carry a running focus index (ridx)
      let ri = -1; const out = [];
      for (const it of this.rollerItems()) out.push(it.kind === 'sec' ? { sec: true, label: it.label } : this.rollerData(it, ++ri));
      return out;
    },

    // --- Nav management ---
    projectProgress(id) {
      const ids = descendantIds(this.tasks, id).slice(1);
      if (!ids.length) return 0;
      return Math.round(ids.filter(x => this.byId.get(x)?.completed_at).length / ids.length * 100);
    },
    startRename(id) { this.navRename = id; this.navPop = null; this.$nextTick(() => this.$nextTick(() => { const i = document.querySelector('.nav-pop .pop-input'); if (i) i.focus(); })); },
    async saveRename(p, name) {
      name = name.trim(); this.navRename = null;
      if (!name) return;
      if ('name' in p) { if (name !== p.name) if (await this.store.areas.update(p.id, { name })) await this.loadAreas(); }
      else { if (name !== p.content) if (await this.store.tasks.update(p.id, { content: name })) await this.loadTasks(); }
    },
    async patchTask(id, fields) { if (await this.store.tasks.update(id, fields)) await this.loadTasks(); this.navPop = null; },
    async patchArea(id, fields) { if (await this.store.areas.update(id, fields)) await this.loadAreas(); this.navPop = null; },
    // The nav settings popover renders at the overview level (not inside the clipping roller) — resolve its entity here.
    navPopProj() { return this.navPop?.type === 'proj' ? this.byId.get(this.navPop.id) : null; },
    navPopArea() { return this.navPop?.type === 'area' ? this.areas.find(l => l.id === this.navPop.id) : null; },
    async deleteArea(id) {
      this.navPop = null;
      if (this.navSel.type === 'area' && this.navSel.id === id) this.setNav('all');
      const area = this.areas.find(a => a.id === id);
      if (!area) return;
      const areaRow = JSON.parse(JSON.stringify(area));
      // store.areas.remove also strips this area's id out of every task's area_ids — a plain reinsert
      // of the area row wouldn't put that reference back, so capture + restore it via a composite too.
      const affected = this.tasks.filter(t => (t.area_ids || []).includes(id)).map(t => ({ id: t.id, area_ids: t.area_ids.slice() }));
      await this.store.areas.remove(id);
      await this.loadAreas(); await this.loadTasks();
      // was = each task's CURRENT (stripped) area_ids → the staleness guard skips a task whose membership was edited after the delete
      // (deleteArea is bin:true, restored out-of-band, so the sub-op would otherwise FULL-overwrite that later edit).
      this._pushEntry('Deleted area', { kind: 'composite', target: 'area', ops: [
        { kind: 'reinsert', target: 'area', id, rows: [areaRow] },
        ...affected.map(t => ({ kind: 'update', target: 'task', id: t.id, after: { area_ids: t.area_ids }, was: { area_ids: (this.byId.get(t.id)?.area_ids) || [] } })),
      ] }, { bin: true });
    },
    descendantCount(id) { return id ? descendantIds(this.tasks, id).length - 1 : 0; },   // tasks INSIDE (excl. the project itself)
    delTargets() {
      if (!this.delAsk) return [];
      const excluded = descendantIds(this.tasks, this.delAsk.id), def = this.store.defaultProject();
      if (this.delAsk.kind === 'project') return this.tasks.filter(p => !excluded.includes(p.id) && this.hasChildren(p.id));
      return this.tasks.filter(p => !excluded.includes(p.id) && (p.id === def || p.sidebar || this.hasChildren(p.id)));
    },
    startDeleteProject(id) {
      this.navPop = null;
      const project = this.byId.get(id);
      const excluded = descendantIds(this.tasks, id);
      const candidates = this.tasks.filter(x => !excluded.includes(x.id));
      const parentInList = project && project.parent_id && candidates.find(x => x.id === project.parent_id);
      this.delAsk = { kind: 'project', id, mode: 'move', target: parentInList ? project.parent_id : (candidates[0]?.id) || null, name: this.projName(id), count: this.descendantCount(id) };
    },
    // Shared by confirmDelete's "move" mode (both project and task): store.tasks.remove(id,
    // target) reparents id's DIRECT children onto target, then removes id — one call, not move+delete. Build the
    // journal entry by hand (a composite of "reinsert id" + "move each child back") since perform's generic
    // composite executor has no rollback and this call's DB-level atomicity must not be split across two ops.
    async _deleteReparent(label, id, target) {
      const row = this.byId.get(id); if (!row) return false;
      const taskRow = JSON.parse(JSON.stringify(row));
      const kids = this.tasks.filter(t => t.parent_id === id).map(c => ({ id: c.id, parent: c.parent_id ?? null, pos: c.position }));
      // Snapshot ancestor chain to detect auto-completions; use loadTasks() (not reloadAll) to avoid rAF racing the composer close.
      const ancSnap = new Map();
      for (let a = this.byId.get(row.parent_id); a; a = this.byId.get(a.parent_id)) ancSnap.set(a.id, a.completed_at ?? null);
      const ok = await this.store.tasks.remove(id, target);
      if (!ok) return false;
      await this.loadTasks();
      // Build update ops to reopen any ancestors that just auto-completed (undo reverses them).
      const autoOps = [];
      for (const [pid, was] of ancSnap) { const p = this.byId.get(pid); if (p && !was && p.completed_at) autoOps.push({ kind: 'update', target: 'task', id: pid, after: { completed_at: null } }); }
      this._pushEntry(label, { kind: 'composite', target: 'task', ops: [
        { kind: 'reinsert', target: 'task', id, rows: [taskRow] },
        ...kids.map(k => ({ kind: 'move', target: 'task', id: k.id, after: { parent: k.parent, pos: k.pos } })),
        ...autoOps,
      ] }, { bin: true });
      return true;
    },
    async confirmDelete() {
      const info = this.delAsk;
      this.delAsk = null;
      if (!info || (info.mode === 'move' && !info.target)) return;
      if (info.kind === 'project') {
        if (this.navSel.type === 'project' && descendantIds(this.tasks, info.id).includes(this.navSel.id)) this.setNav('all');
        if (info.mode === 'delete') await this.perform('Deleted project + tasks', { target: 'task', kind: 'delete', id: info.id });
        else if (this.byId.get(info.id)) await this._deleteReparent('Deleted project', info.id, info.target);
      } else {
        if (info.mode === 'delete') await this.perform('Deleted task', { target: 'task', kind: 'delete', id: info.id });
        else await this._deleteReparent('Deleted task, moved subtasks', info.id, info.target);
        if (info.source === 'editing') this.closeComposer(true);
      }
    },

    // top/bottom 30% = above/below, middle = into; "into" downgrades at MAX_DEPTH
    _dropMode(e, overId, dragId) {
      const rect = e.currentTarget.getBoundingClientRect(), y = e.clientY - rect.top, h = rect.height;
      let mode = y < h * 0.3 ? 'above' : y > h * 0.7 ? 'below' : 'into';
      if (mode === 'into' && projectDepth(this.tasks, overId) + subtreeDepth(this.tasks, dragId) > MAX_DEPTH) mode = y < h * 0.5 ? 'above' : 'below';
      return mode;
    },

    resetDraft() {
      this.draft = emptyDraft(); this.subDraft = emptyDraft(); _nlpFocus = null;
      this.pickerQ = ''; this.newAreaName = ''; this.projRequired = false; this.subGhost = ''; this.chkGhost = ''; this.endPicking = false; this.tpop = false;
      this.areaPicker = { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 };
      this.goalPicker = { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 };
      this._noPillOnce = false;   // the un-chip→no-re-pill guard is per-session; never leak it across composer opens
    },
    pc(imp) { return `var(--p${({ must: 1, focus: 2, someday: 3 })[imp] || 4})`; },   // check color by importance — PLACEHOLDER map (user will remap): must→p1, focus→p2, someday→p3, none→p4
    impName(v, unset = 'None') { return ({ none: 'None', focus: 'Focus', must: 'Must', someday: 'Someday' })[v] || unset; },   // proper name incl. None; pass 'Importance' for picker's unset label
    qfImpCol() { return this.pc([...this.qfImp].sort((a, b) => impRank(a) - impRank(b))[0]); },   // token color = the most-important selected value
    durMinNow() { return this.draft.durH * 60 + this.draft.durM; },
    durLabel() { return this.durMinNow() ? this.durFmt(this.durMinNow()) : 'Dur'; },
    setDur(min) { this.draft.durH = Math.floor(min / 60); this.draft.durM = min % 60; this.scrollWheels(); },
    scrollWheels() {
      this.$nextTick(() => {
        if (this.$refs.wheelH) this.$refs.wheelH.scrollTop = this.draft.durH * 30;
        if (this.$refs.wheelM) this.$refs.wheelM.scrollTop = (this.draft.durM / 5) * 30;
      });
    },
    openDur(anchor) { this.togglePop('dur', anchor); if (this.pop === 'dur') this.scrollWheels(); },

    reduceMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; },
    // measured via clone so live card is never touched; height lands where auto settles
    fullGrow(g) {
      const card = g.firstElementChild; if (!card) return g.scrollHeight;
      const probe = document.createElement('div');
      probe.className = 'composer-grow grown';
      probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;height:auto;width:${card.offsetWidth}px`;
      const clone = card.cloneNode(true);
      probe.appendChild(clone);
      card.parentElement.appendChild(probe);
      const cs = getComputedStyle(clone);
      const h = clone.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      probe.remove();
      return h;
    },
    // reused by task+goal composer; `grow` is a getter (element read at rAF time)
    _growOpen(grow, start) {
      this._closing = false; clearTimeout(this._t);
      if (this.reduceMotion()) { this.grown = true; this.clip = false; this.growH = null; return; }
      // synchronous so first frame isn't at full height (stutter)
      this.grown = false; this.clip = true; this.growH = start;
      // rAF past $nextTick: dynamic rows mount a tick late.
      // Retry: view-switch can leave grow un-mounted 1-2 frames (space-but-no-composer bug).
      this.$nextTick(() => {
        let tries = 0;
        const tryOpen = () => {
          const g = grow();
          if (!g) { if (tries++ < 12 && !this._closing) requestAnimationFrame(tryOpen); return; }
          const full = this.fullGrow(g);   // clone-measured grown height; live card untouched
          requestAnimationFrame(() => { this.growH = full; this.grown = true; });
        };
        requestAnimationFrame(tryOpen);
      });
      this._t = setTimeout(() => { this.growH = null; this.clip = false; }, 280);   // settle to auto
    },
    _growClose(grow, end, done) {
      clearTimeout(this._t); this._closing = true;   // guards the rAF/timeout so a quick re-open cancels them
      const g = grow();
      if (g && !this.reduceMotion()) {
        this.growH = this.fullGrow(g); this.clip = true;   // pin the current full height as the start
        this.$nextTick(() => requestAnimationFrame(() => { if (!this._closing) return; this.growH = end; this.grown = false; }));
      } else { this.grown = false; }
      this._t = setTimeout(() => { if (!this._closing) return; this.clip = false; this.growH = null; done && done(); }, 240);
    },
    openComposer() {
      // If the tapped task's TOP is in view, DON'T scroll — grow it in place (its bottom may extend below the
      // fold; the composer replaces it anyway). Only a task whose top is off-screen animates in. We test the
      // top only (not full visibility): getBoundingClientRect().top is layout-accurate, whereas offsetHeight is
      // unreliable under content-visibility. Close never scrolls either, so an in-view edit leaves the list put.
      if (!this.composer.open) {
        const sc = this.editing && this._listScroller(), r = sc && this._rowEl(this.editing);
        const top = r ? r.getBoundingClientRect().top - sc.getBoundingClientRect().top : null;
        this._skipOpenScroll = top != null && top >= -1 && top <= sc.clientHeight - 20;
      }
      this._closingComposer = false;   // re-arm draft persistence (closeComposer set it while animating out)
      this.relocateComposer();   // move the single composer into the active surface's list before it grows
      this.applyEditDom();       // style the edited row (crossfade) + hide its subtree imperatively — no list rebuild, so the scroll stays put
      const wasOpen = this.composer.open, start = this.editing ? this.blockH : 0;
      this.composer.open = true;
      if (wasOpen) { this._closing = false; clearTimeout(this._t); this.grown = true; this.clip = false; this.growH = null; }
      else this._growOpen(() => this.$refs.grow, start);
      this.setEditorText(this.draft.content);
      this.setDescText(this.draft.notes);
      this.$nextTick(() => {
        this.syncChkRows();   // reused rows keep stale live-editor markup across reopens — refresh from the draft
        this.syncSubRows();   // ditto for subtask pill editors (keyed x-for rows reuse across reopen/reload)
        const c = this.$refs.content; c?.focus({ preventScroll: true });
        // Editing → caret at the END of the title (ready to append a chip); adding starts empty so it's moot.
        if (c && this.editing) this._caret(c);
        if (!this._skipOpenScroll) {   // in-view opens grow in place — never scroll the list (user rule)
          const comp = this.$refs.composer, sc = this._listScroller(); if (!comp || !sc) return;
          const smooth = !this.reduceMotion();
          comp.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
          // After the grow transition settles, scroll DOWN only if the bottom is still cut off (initial scroll ran while still short).
          // Down-only: never scroll up — would fight the caret and jar the list position.
          const reveal = () => {
            if (!this.composer.open) return;
            const cr = comp.getBoundingClientRect(), sr = sc.getBoundingClientRect();
            if (cr.height > sc.clientHeight) { sc.scrollBy({ top: cr.top - sr.top - 8, behavior: smooth ? 'smooth' : 'auto' }); return; }
            const overhang = cr.bottom - sr.bottom;
            if (overhang > 4) sc.scrollBy({ top: overhang + 12, behavior: smooth ? 'smooth' : 'auto' });
          };
          const grow = this.$refs.grow; if (!grow) { reveal(); return; }
          clearTimeout(this._revealT);
          const onEnd = () => { clearTimeout(this._revealT); grow.removeEventListener('transitionend', onEnd); grow.removeEventListener('transitioncancel', onEnd); reveal(); };
          grow.addEventListener('transitionend', onEnd, { once: true });
          grow.addEventListener('transitioncancel', onEnd, { once: true });
          this._revealT = setTimeout(onEnd, 400);   // fallback: 400ms > 220ms grow transition
        }
      });
    },
    // Imperative edit styling (no list rebuild): crossfade height on the edited row + hide its subtree. Re-run
    // after any list rebuild (queueMicrotask in the .rows x-effect) and on open/close.
    applyEditDom() {
      for (const el of document.querySelectorAll('.surface-lists .item.editing-row')) { el.classList.remove('editing-row'); el.style.height = ''; }
      for (const el of document.querySelectorAll('.surface-lists .item.edit-hidden')) el.classList.remove('edit-hidden');
      if (!this.editing) return;
      const row = this._rowEl(this.editing);
      if (row) { row.classList.add('editing-row'); row.style.height = this.startH + 'px'; }
      for (const id of (this._editDescs || [])) this._rowEl(id)?.classList.add('edit-hidden');
    },
    // Now has no editable list — editIndex positions the composer on Lists
    editIndex() { const i = this.visibleRows().findIndex(r => r.t.id === this.editing); return i >= 0 ? i : this.completedRows().findIndex(r => r.t.id === this.editing); },
    editingDone() { return !!this.editing && this.completedRows().some(r => r.t.id === this.editing); },   // the edited task lives in the Done list
    // physically moved into the target .list on open; $refs survive; setNav/goSurface close it on switch
    relocateComposer() {
      const el = this.$refs.composer; if (!el) return;
      // Plan+panel → panel; a completed task → the Done list; otherwise the active Lists list
      const dest = (this.surface === 'plan' && this.clSideVisible()) ? document.querySelector('.cl-side-composer')
        : this.editingDone() ? document.querySelector('.list-done .list')
        : document.querySelector('.surface-lists .list');
      if (dest && el.parentElement !== dest) dest.appendChild(el);
    },
    startAdd() { this.editing = null; this._editDescs = null; this.resetDraft(); this._initDraftSafety(); this.openComposer(); },
    durFmt(min) {
      const h = Math.floor(min / 60), m = min % 60;
      return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '');
    },
    projName(id) { return this.byId.get(id)?.content || ''; },
    isDefaultProj(id) { return !!id && id === this.store.defaultProject(); },
    pickIsDefault() { return this.draft.project_id ? this.draft.project_id === this.store.defaultProject() : !this.draft.project; },
    projPickColor() {
      const c = this.draft.project_id
        ? this.byId.get(this.draft.project_id)?.color
        : this.tasks.find(x => x.content === (this.draft.project || this.defaultProjName()) && x.parent_id === null)?.color;
      return c ? 'color:' + c : '';
    },
    listTintCol() {
      if (this.navSel.type === 'project') return this.byId.get(this.navSel.id)?.color || null;
      if (this.navSel.type === 'area') return this.areas.find(x => x.id === this.navSel.id)?.color || null;
      if (this.navSel.type === 'filter') return this.filters.find(x => x.id === this.navSel.id)?.color || null;
      return null;
    },
    // page-wide wash + expose the tint so the filter chips can pick up the same color family (--list-tint)
    listTintStyle() { const col = this.listTintCol(); return col ? `background:color-mix(in srgb,${col} 5%,var(--bg));--list-tint:${col}` : ''; },
    areaObjs(ids) { return (ids || []).map(id => this.areas.find(x => x.id === id)).filter(Boolean); },
    areaChipsHtml(ids) { return this.areaObjs(ids).map(l => areaChipHtml({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })).join(''); },
    esc(s) { return escHtml(s); },
    // x-html; relation picker + cascade-complete use the same markup (ui.js)
    taskLine(t, markedTitle) {
      return taskRowHtml({
        checkColor: this.pc(t.importance),
        title: markedTitle != null ? raw(markedTitle) : raw(mdTitleFn(t.content)),
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        projName: this.projName(t.parent_id) || '',
        done: !!t.completed_at,
      });
    },
    // x-html; click delegated via finishStepClick(ev, gid)
    taskListHtml(tasks, opts = {}) {
      return taskListMarkup((tasks || []).map(t => ({ id: t.id, line: this.taskLine(t), milestone: t.milestone })), opts);
    },
    // static body — shell <li> keeps reactive bindings
    rowBody(r, opts) { return rowBodyHtml(r, { navType: this.navSel.type, glintId: this.chipGlintId, chkOpen: this.chkOpen.has(r.t.id), ...opts }); },
    // body is inert x-html — delegate here; editTask measures .item
    onRowClick(r, e) {
      if (e.target.closest('a')) return;   // markdown link — let the browser follow it
      if (e.metaKey || e.ctrlKey) return this.toggleSel(r.t.id);                                  // Ctrl/Cmd-click toggles selection
      if (e.shiftKey) { getSelection()?.removeAllRanges(); return this.selectRange(r.t.id); }     // Shift-click extends the range (drop any accidental text highlight)
      this.selAnchor = r.t.id;   // a plain click seeds the range anchor for a later Shift-click
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'collapse') return this.toggleTaskCollapse(r.t.id);
      if (act === 'check') return this.toggle(r.t);
      if (act === 'chk-more') { this.chkOpen.has(r.t.id) ? this.chkOpen.delete(r.t.id) : this.chkOpen.add(r.t.id); return; }   // reveal/re-hide the collapsed done items
      // the checkbox OR its text toggles a checklist item; plain (uncheckable) items fall through to editTask
      const chk = e.target.closest('.chk-rect, .chk-txt')?.closest('.chk-row');
      if (chk && !r.t.checklist_plain) return this.toggleChk(r.t.id, +chk.dataset.ci);
      this.editTask(r.t, e);
    },
    // first swatch = clear; '' → null; shared by editors + nav popovers
    swatchRow(cur, defaultBg) {
      const first = defaultBg
        ? `<button type="button" class="swatch${cur ? '' : ' sel'}" style="background:${defaultBg}" data-color="" title="Default"></button>`
        : `<button type="button" class="swatch none${cur ? '' : ' sel'}" data-color="" title="No color"></button>`;
      return first + this.colors.map(c => `<button type="button" class="swatch${cur === c ? ' sel' : ''}" style="background:${c}" data-color="${c}"></button>`).join('');
    },
    swatchPick(e, set) { if (e.target.dataset.color !== undefined) set(e.target.dataset.color || null); },   // ignores clicks on the gap; '' → null
    dragStart(t, e, depth) {
      this.dragId = t.id; this.taskDropHint = null; this.railHot = null; this.railList = this.railItems();
      this._dragX0 = e.clientX ?? 0; this._dragDepth = depth ?? 0;
      this._dragDescs = new Set(descendantIds(this.tasks, t.id).slice(1));   // descendants only (drop self); hide the subtree while dragging
      this._rowEl(t.id)?.classList.add('dragging');
      for (const id of this._dragDescs) this._rowEl(id)?.classList.add('row-hidden');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }
    },
    // depth = the target row's display depth (for the ghost indent); the MAX_DEPTH guard uses projectDepth.
    dragOver(t, e, depth) {
      if (!this.dragId) return;
      if (t.id === this.dragId) { this.taskDropHint = null; this._setDropInto(null); return; }
      if (this._dragDescs?.has(t.id)) { this.taskDropHint = null; this._setDropInto(null); return; }
      let mode = this._dropMode(e, t.id, this.dragId);
      // drag-left outdent only in above/below zones — prevents nest-drag from hijacking into
      const dt = this.byId.get(this.dragId);
      const par = dt && this.byId.get(dt.parent_id);
      if (mode !== 'into' && e.clientX - (this._dragX0 ?? e.clientX) < -30 && par && !par.sidebar) {
        this.taskDropHint = { id: this.dragId, mode: 'outdent', depth: Math.max(0, (this._dragDepth ?? 1) - 1) };
        this._setDropInto(null);
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        return;
      }
      this.taskDropHint = { id: t.id, mode, depth: mode === 'into' ? (depth ?? 0) + 1 : (depth ?? 0) };
      this._setDropInto(mode === 'into' ? t.id : null);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    },
    // placeholder slotted via flex order (rows i*2)
    ghostPos() {
      const h = this.taskDropHint;
      if (!this.dragId || !h) return null;   // ghost for every mode incl. into (deeper indent) so it never vanishes
      const rows = this.visibleRows();
      const gi = rows.findIndex(r => r.t.id === h.id);
      if (gi < 0) return null;
      const at = h.mode === 'above' ? gi : gi + 1;
      return { order: at * 2 - 1, depth: h.depth ?? rows[gi].depth };
    },
    // clear on list-leave only, not per-row — per-row clear flickers as the ghost shifts rows
    dragLeave(t, e) {
      const list = e.currentTarget.closest?.('.list'); if (!list) return;
      const rect = list.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        this.taskDropHint = null; this._setDropInto(null);
      }
    },
    async drop() {
      const hint = this.taskDropHint, dragId = this.dragId;
      this.taskDropHint = null; this.dragId = null; this._clearDrag();
      if (!hint || !dragId) return;
      if (hint.mode === 'outdent') {   // reparent to grandparent, just after the former parent — always a real move
        const dt = this.byId.get(dragId);
        const par = dt && this.byId.get(dt.parent_id);
        if (!par || par.sidebar) return;
        const newParentId = par.parent_id ?? null;
        const sibs = this.tasks.filter(x => x.parent_id === newParentId && x.id !== dragId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const insertAt = sibs.findIndex(x => x.id === par.id) + 1;
        sibs.splice(insertAt, 0, { id: dragId });
        return this._moveTask(dragId, newParentId, insertAt, sibs.map(x => x.id));
      }
      if (hint.id === dragId) return;
      const target = this.byId.get(hint.id);
      if (!target) return;
      const _dragTask = this.byId.get(dragId);
      const _isReorder = (hint.mode === 'above' || hint.mode === 'below') && !!_dragTask && (_dragTask.parent_id ?? null) === (target.parent_id ?? null);
      if (hint.mode === 'into') {
        const children = this.tasks.filter(x => x.parent_id === target.id);
        const toIndex = children.length ? Math.max(...children.map(x => x.position)) + 1 : 0;
        return this._moveTask(dragId, target.id, toIndex, [...children.map(x => x.id), dragId]);
      }
      const parentId = target.parent_id ?? null;
      const siblings = this.tasks.filter(x => x.parent_id === parentId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const ordered = siblings.filter(x => x.id !== dragId);
      const targetIdx = ordered.findIndex(x => x.id === target.id);
      const insertAt = hint.mode === 'above' ? targetIdx : targetIdx + 1;
      ordered.splice(insertAt, 0, { id: dragId });
      if (_isReorder) {   // same parent — non-lossy reorder, not journaled
        if (await this.store.tasks.move(dragId, parentId, insertAt)) await this.store.tasks.reorder(ordered.map(x => x.id));
        return this.loadTasks();
      }
      return this._moveTask(dragId, parentId, insertAt, ordered.map(x => x.id));
    },
    // journaled move + sibling normalization; `pos` journals the drop intent, `order` is the full normalized sibling order
    async _moveTask(id, parent, pos, order) {
      await this.perform('Moved', { target: 'task', kind: 'move', id, after: { parent, pos } });
      await this.store.tasks.reorder(order);   // normalize sibling positions — not journaled, a reorder loses nothing
      await this.loadTasks();
    },
    dragEnd() { this._clearDrag(); this.dragId = null; this.taskDropHint = null; this._dragDescs = null; this.railHot = null; },
    // ── Drag-to-move edge rail: Backlog + every project + every area as compact drop targets. ──
    railItems() {
      const items = [{ kind: 'backlog', id: null, label: 'Backlog', icon: 'i-backlog', color: '' }];
      for (const { p } of this.allProjectRows()) items.push({ kind: 'proj', id: p.id, label: p.content, icon: 'i-hash', color: p.color || '' });
      for (const l of this.areas) items.push({ kind: 'area', id: l.id, label: l.name, icon: l.icon || 'i-tag-tag', color: l.color || this.areaDefault });
      return items;
    },
    railOver(kind, id) { this.railHot = kind + id; this.taskDropHint = null; this._setDropInto(null); },   // clear the list ghost — the drop lands on the rail, not a row
    async railDrop(kind, id) {
      const dragId = this.dragId;
      this.railHot = null; this.taskDropHint = null; this.dragId = null; this._clearDrag();
      const t = this.byId.get(dragId); if (!t) return;
      if (kind === 'area') {   // areas are tags (many-to-many), not parents — add the tag, keep existing (a field update, not a parent move)
        const ids = t.area_ids || [];
        if (ids.includes(id)) return;
        await this.perform('Moved', { target: 'task', kind: 'update', id: dragId, after: { area_ids: [...ids, id] } });
        return;
      }
      const parentId = kind === 'backlog' ? this.store.defaultProject() : id;
      if (parentId === dragId) return;   // can't file a project under itself
      const sibs = this.tasks.filter(x => (x.parent_id ?? null) === (parentId ?? null) && x.id !== dragId);
      const toIndex = sibs.length ? Math.max(...sibs.map(x => x.position ?? 0)) + 1 : 0;   // bottom of the project
      await this._moveTask(dragId, parentId, toIndex, [...sibs.map(x => x.id), dragId]);
    },
    // ── The ONE list-surface scroll model ──────────────────────────────────────────────────────
    // The scroll STAYS. Opening an in-view task doesn't scroll (grow in place), so closing has nothing to
    // un-do — we never write scrollTop on close; the list stays exactly where the reader left it (if the
    // collapse shrinks the range past the end the browser clamps up a touch, which is fine). The ONLY
    // deliberate scroll is `_revealRow`: bring a task in when it's OFF-SCREEN (an off-screen open, or a save
    // that re-sorted the row out of view). Rows use content-visibility, so we never trust absolute scrollTop.
    _listScroller() { return document.querySelector('.surface-lists .app'); },
    _rowOffscreen(sc, el) { const r = el.getBoundingClientRect().top - sc.getBoundingClientRect().top; return r < -1 || r + el.offsetHeight > sc.clientHeight + 1; },
    _revealRow(id) { const sc = this._listScroller(), el = id && this._rowEl(id); if (sc && el && this._rowOffscreen(sc, el)) el.scrollIntoView({ block: 'nearest', behavior: this.reduceMotion() ? 'auto' : 'smooth' }); },
    // A just-saved row morphs in place (keyed morph, #306) with no motion cue — a brief warm wash marks WHICH row
    // took the edit. Imperative (like hover/edit state) so it never enters the morph's _sig compare. Color-only, so
    // it's reduced-motion-safe (comprehension aid, not movement). Re-trigger by removing+reflowing before re-adding.
    _flashSaved(id) {
      const el = this._rowEl(id); if (!el) return;
      el.classList.remove('just-saved'); void el.offsetWidth; el.classList.add('just-saved');
      el.addEventListener('animationend', () => el.classList.remove('just-saved'), { once: true });
    },
    // "Action pending" spinner on a row's checkmark — but ONLY if the store op is actually slow (≥150ms), so instant
    // local writes never flicker; a real wait (remote sync) morphs the check into a spinner until it resolves. Imperative,
    // by data-id, matching the list's other interaction state. Wrap any per-task async store call: _withPending(id, fn).
    _setCheckPending(id, on) { const c = this._rowEl(id)?.querySelector('.check'); if (c) c.classList.toggle('pending', on); },
    async _withPending(id, fn) {
      const t = setTimeout(() => this._setCheckPending(id, true), 150);
      try { return await fn(); } finally { clearTimeout(t); this._setCheckPending(id, false); }
    },
    async deleteEditing() {
      const task = this.byId.get(this.editing);
      if (task && this.askDeleteTask(task.id, 'editing')) return;   // has subtasks → the prompt finishes the job (incl. closing)
      if (task) await this.perform('Deleted', { target: 'task', kind: 'delete', id: task.id });
      this.closeComposer(true);   // row is gone → native overflow-anchor holds the surrounding content in place
    },
    // Task 26 — deleting a task that has subtasks asks: delete them too, or move them to a destination
    // (default = the parent's parent, i.e. the deleted task's parent; the top-level project if none).
    // Returns true when it opened the prompt (the caller must stop and let the dialog finish the op).
    askDeleteTask(id, source) {
      if (!this.hasChildren(id)) return false;
      const task = this.byId.get(id); if (!task) return false;
      this.delAsk = { kind: 'task', id, source, mode: 'move', target: (task.parent_id && this.byId.has(task.parent_id)) ? task.parent_id : this.store.defaultProject(), name: task.content || '', count: descendantIds(this.tasks, id).length - 1 };
      return true;
    },
    closeComposer(saved = false, revealId = null, manageScroll = true, revealGuard = null) {
      this.pop = null;
      // Draft safety: a close that ISN'T a save/delete keeps any unsaved edits — they stay persisted (already
      // autosaved via the watch effect) and reopening this task's composer restores them. A saved/handled
      // close clears the pending draft so it can't resurrect over the save.
      if (this.composer.open) {
        const key = this._draftKey();
        if (saved || this._draftSig() === this._draftBase) this._clearPending(key);
        else {
          // dropped-but-kept dirty draft → a recoverable "Draft" bin row + ⌘Z reopen (pending autosave stays too)
          const title = (this.draft.content || '').trim() || (this.chkGhost || this.subGhost || '').trim() || 'Untitled draft';
          this._pushDraftBin(key, 'Draft — ' + title);
        }
      }
      this._closingComposer = true;   // stop persistDraft re-writing during the async grow-close
      this.draftRestored = false;
      // Keep the list PUT across the collapse. applyEditDom re-renders the edited row's subtree, which
      // (content-visibility) can nudge scrollTop — so we hold the pre-close position and re-assert as it
      // settles. The save path passes manageScroll:false and owns this itself (it must wait out its reloadAll).
      const sc = manageScroll ? this._listScroller() : null, stBefore = sc ? sc.scrollTop : 0;
      // Hold the pre-close position against collapse/applyEditDom drift — but YIELD to the user: real input
      // (wheel/touch) during the collapse means they own the scroll now, so the hold stands down.
      let userScrolled = false; const mark = () => { userScrolled = true; };
      const unmark = () => { if (sc) for (const evt of ['wheel', 'touchmove']) sc.removeEventListener(evt, mark); };
      if (sc) for (const evt of ['wheel', 'touchmove']) sc.addEventListener(evt, mark, { passive: true });
      const end = this.editing ? this.blockH : 0;
      this._growClose(() => this.$refs.grow, end, () => {
        this.composer.open = false; this.editing = null; this._editDescs = null; this.resetDraft(); this.applyEditDom();
        if (sc) {
          const el = revealId && this._rowEl(revealId);
          if (el && this._rowOffscreen(sc, el)) { unmark(); el.scrollIntoView({ block: 'nearest', behavior: this.reduceMotion() ? 'auto' : 'smooth' }); return; }
          // content-visibility re-measure can nudge scroll 1–2 frames after the callback — hold through them,
          // still yielding to any real user input the moment it arrives.
          let stable = 0, frames = 0;
          const hold = () => {
            if (userScrolled) return unmark();
            if (sc.scrollTop !== stBefore) { sc.scrollTop = stBefore; stable = 0; } else stable++;
            (stable >= 2 || ++frames > 12) ? unmark() : requestAnimationFrame(hold);   // until 2 quiet frames (bounded)
          };
          hold();
        } else if (revealId) requestAnimationFrame(() => {
          // Guard: skip if user scrolled significantly during the async save (> 300px = deliberate, not DOM drift from collapse)
          const gs = this._listScroller();
          if (revealGuard != null && gs && Math.abs(gs.scrollTop - revealGuard) > 300) return;
          this._revealRow(revealId);
        });
      });
    },
    composerMt() { return (this.editing ? -this.startH : 0) + 'px'; },
    editDone() { const t = this.byId.get(this.editing); return !!(t && t.completed_at); },
    toggleEditing() { const t = this.byId.get(this.editing); if (t) this.toggle(t); },
    // A task's stored fields → a fresh composer draft (shared by editTask + subtask editors).
    taskToDraft(t) {
      const min = t.est_minutes || 0;
      return { ...emptyDraft(),
        content: t.content, notes: t.notes || '', importance: t.importance ?? 'none',
        due_at: (t.due_at || '').slice(0, 10),
        available_from: t.available_from || '',
        dueTime: timeOf(t.due_at || ''),
        deadline_at: (t.deadline_at || '').slice(0, 10),
        durH: Math.floor(min / 60), durM: min % 60,
        project: this.projName(t.parent_id) || null, project_id: t.parent_id || null, areas: [...(t.area_ids || [])], goal_ids: [...(t.goal_ids || [])], checklist: (t.checklist || []).map(c => ({ ...c })).sort(byDone), recurrence: t.recurrence ? JSON.parse(JSON.stringify(t.recurrence)) : null,
        location: t.location ? { ...t.location, ids: [...(t.location.ids || [])] } : { mode: 'any', ids: [] },
      };
    },
    editTask(t, ev) {
      // ev.currentTarget is the list (<ul>); resolve the actual row by id
      const row = ev?.currentTarget?.classList.contains('item') ? ev.currentTarget : this._rowEl(t.id);
      // programmatic opens lack a source row — fall back to a visible row height (else startH=0 loses overlap)
      this.startH = row?.offsetHeight || [...document.querySelectorAll('.list .item')].find(el => el.offsetParent !== null)?.offsetHeight || 34;
      // block height = row + its shown subtask rows (measured before they hide)
      let h = this.startH, el = row?.nextElementSibling;
      const depth = +(row?.style.getPropertyValue('--d') || 0);
      while (el && el.classList.contains('item') && +(el.style.getPropertyValue('--d') || 0) > depth) {
        h += el.offsetHeight; el = el.nextElementSibling;
      }
      this.blockH = h;
      this.draft = this.taskToDraft(t);
      this.editing = t.id;
      this._editDescs = new Set(descendantIds(this.tasks, t.id).slice(1));   // O(1) hiddenInEdit checks (reactive :style)
      this.pop = null;
      this.relSel = null; this.pickerQ = '';
      this._initDraftSafety();   // baseline + restore any unsaved draft for this task
      this.openComposer();
    },
    // sidebar project → navigate, not edit
    openTaskById(id) { const t = this.byId.get(id); if (!t) return; this.isSidebar(t) ? this.setNav('project', t.id) : this.editTask(t); },
    navTargets() {   // non-corpus palette targets: surfaces + filters + goals + action commands
      const t = this.surfaceOrder.map(s => ({ kind: 'nav', type: 'surface', id: s, title: SURF_META[s].label, icon: SURF_META[s].icon }));
      for (const f of this.filters) t.push({ kind: 'nav', type: 'filter', id: f.id, title: f.name, color: f.color || 'var(--muted)' });
      for (const g of this.goals.filter(x => !x.archived)) t.push({ kind: 'nav', type: 'goal', id: g.id, title: g.name, icon: 'i-target' });
      t.push(
        { kind: 'cmd', type: 'command', id: 'new-task', title: 'New task', icon: 'i-edit', kw: 'add create' },
        { kind: 'cmd', type: 'command', id: 'new-goal', title: 'New goal', icon: 'i-target', kw: 'add create' },
        { kind: 'cmd', type: 'command', id: 'new-filter', title: 'New filter', icon: 'i-search', kw: 'add create query' },
        { kind: 'cmd', type: 'command', id: 'today', title: 'Jump to Today', icon: 'i-cal', kw: 'calendar now' },
        { kind: 'cmd', type: 'command', id: 'locations', title: 'Manage locations', icon: 'i-tag-map', kw: 'places travel' },
      );
      return t;
    },
    searchResults() {
      const q = this.palette.q.trim().toLowerCase();
      const nav = this.navTargets().map(t => {                          // small set → match in JS
        if (!q) return null;   // empty query → recents only (clean); surfaces/commands appear once you type
        const i = (t.title + ' ' + (t.kw || '')).toLowerCase().indexOf(q);
        return i < 0 ? null : { ...t, _s: (t.title.toLowerCase().startsWith(q) ? 0 : 1) + i / 100 };
      }).filter(Boolean).sort((a, b) => a._s - b._s);
      const docs = this.store.search(this.palette.q, 50).map(r => {     // tasks/projects/areas from the fuzzy corpus
        const obj = r.type === 'area' ? this.areas.find(x => x.id === r.id) : this.byId.get(r.id);
        return obj ? { ...r, obj } : null;
      }).filter(Boolean);
      const results = [...nav, ...docs];   // nav/commands first (the "go/do" intent), then content matches
      if (this.isFilterQuery(this.palette.q)) results.push({ kind: 'cmd', type: 'command', id: 'save-filter', title: `Save "${this.palette.q.trim()}" as filter`, icon: 'i-search' });   // appended, not unshifted — must not hijack Enter from a real result (e.g. "@home")
      return results;
    },
    searchTitleHTML(r) {
      const raw = r.obj.content ?? r.obj.name ?? '';
      if (!r.ranges?.length) return mdTitleFn(raw);   // always render markdown (bold/italic/code)
      // Mark the RAW text at match boundaries (sentinels), THEN render markdown, THEN swap sentinels for <mark>.
      // Marking raw — not the rendered HTML — stops queries like 'em'/'s'/'code' from matching inside <em>/<s>/<code>.
      const lim = r.titleLen || raw.length, S = '\x01', E = '\x02';
      let out = '', pos = 0;
      for (let i = 0; i < r.ranges.length; i += 2) {
        const a = r.ranges[i], b = Math.min(r.ranges[i + 1], lim);
        if (a >= lim) break;
        if (a < pos) continue;   // skip overlaps (ranges are sorted)
        out += raw.slice(pos, a) + S + raw.slice(a, b) + E;
        pos = b;
      }
      out += raw.slice(pos);
      return mdTitleFn(out).replaceAll(S, '<mark>').replaceAll(E, '</mark>');
    },
    searchJumpHTML(r) {   // non-task palette row: lead (icon/dot) + name (+ a type tag for nav/commands)
      if (r.kind === 'nav' || r.kind === 'cmd') {
        const name = markTitle(r.title, [], (r.title || '').length);   // escape — filter/goal names are user input
        const lead = r.color
          ? `<span class="filter-dot" style="background:${r.color}"></span>`
          : `<svg class="ico pick-ico"><use href="#${r.icon || 'i-arrow'}"/></svg>`;
        return `${lead}<span class="pick-name">${name}</span><span class="pick-tag">${r.type === 'command' ? 'Action' : r.type}</span>`;
      }
      const marked = this.searchTitleHTML(r);
      if (r.type === 'project') return `<span class="hash">#</span><span class="pick-name">${marked}</span>`;
      const color = r.obj.color || this.areaDefault;
      return `<svg class="ico area-ico" style="color:${color}"><use href="#${r.obj.icon || 'i-tag-tag'}"/></svg><span class="pick-name">${marked}</span>`;
    },
    openPalette(q = '') { this.palette.open = true; this.palette.q = q; this.palette.sel = 0; this.$nextTick(() => this.$refs.paletteInput?.focus()); },
    paletteMove(d) {
      const n = this.searchResults().length; if (!n) return;
      this.palette.sel = (this.palette.sel + d + n) % n;
      this.$nextTick(() => document.querySelector('.palette-row.psel')?.scrollIntoView({ block: 'nearest' }));
    },
    paletteEnter() { const r = this.searchResults()[this.palette.sel]; if (r) this.pickSearchResult(r); },
    pickSearchResult(r) {
      this.palette.open = false;
      if (r.kind === 'cmd') return this.runCommand(r.id);
      if (r.type === 'surface') return this.goSurface(r.id);
      if (r.type === 'filter') return this.setNav('filter', r.id);
      if (r.type === 'goal') { this.setNav('goals'); return this.openGoal(r.id); }
      this.store.recordSearchPick(r.id);   // recents: corpus items only (task/project/area)
      if (r.type === 'task') this.openTaskById(r.id);
      else if (r.type === 'project') this.setNav('project', r.id);
      else if (r.type === 'area') this.setNav('area', r.id);
    },
    runCommand(id) {
      if (id === 'new-task') { this.goSurface('lists'); this.startAdd(); }
      else if (id === 'new-goal') { this.setNav('goals'); this.newGoalComposer(); }
      else if (id === 'new-filter') { this.openFilterEditor(); }
      else if (id === 'save-filter') this.saveQueryAsFilter();
      else if (id === 'today') { this.setNav('calendar'); this.$nextTick(() => this.clToday && this.clToday()); }
      else if (id === 'locations') { this.locMgr = true; this.loadLocations(); }
    },
    draftFields(d = this.draft) {
      // save-flush: catch a natural-language importance word the live pilling couldn't (prefix "focus
      // on X" can't pill trailing) — only when none was set explicitly, so a pill/picker choice wins.
      let content = d.content.trim(), importance = d.importance;
      if (importance === 'none') { const p = parseImportanceWords(content); if (p) { content = p.content; importance = p.importance; } }
      const fields = {
        content,
        notes: d.notes || null, importance,
        due_at: d.due_at ? (d.dueTime ? d.due_at + 'T' + d.dueTime : d.due_at) : null,
        available_from: d.available_from || null,
        deadline_at: d.deadline_at || null,
        est_minutes: ((d.durH || 0) * 60 + (d.durM || 0)) || null,
        project: d.project || null,
        area_ids: d.areas || [],   // draft.areas holds area IDs now; the store prefers explicit area_ids
        goal_ids: d.goal_ids ?? [],
        checklist: d.checklist,
        recurrence: d.recurrence,
        location: d.location || { mode: 'any', ids: [] },
      };
      if (d.project_id) fields.parent_id = d.project_id;
      else if (!fields.project && !this.editing) {
        if (this.navSel.type === 'project') fields.parent_id = this.navSel.id;
        else if (this.navSel.type === 'backlog') fields.parent_id = this.store.defaultProject();
      }
      return fields;
    },

    // The ONE owner of teleported-pop placement + outside-close (11 pops bind these; fix positioning here, once)
    popStyle(name) { return 'display:' + (this.pop === name ? 'flex' : 'none') + ';position:fixed;left:' + this.popXY.left + 'px;top:' + this.popXY.top + 'px;bottom:auto'; },
    popAway(name, e) { if (this.pop === name && !e.target.closest('.pop')) this.pop = null; },
    togglePop(name, anchor) {
      this.pop = this.pop === name ? null : name;
      // Remove any existing scroll/resize tracker before opening a new pop
      if (this._popTrack) { this._popTrack(); this._popTrack = null; }
      if (!this.pop || !anchor) return;
      const r = anchor.getBoundingClientRect(), m = 8;
      this.popXY = { left: r.left, top: r.bottom + 5 };
      this.$nextTick(() => {
        const findPop = () => [...document.querySelectorAll('.pop')].find(p => getComputedStyle(p).display !== 'none');
        const el = findPop();
        if (!el) return;
        const _pos = (ar) => {
          // Flip above if pop overflows the bottom edge, or if marked data-pos="up"
          const vh = window.innerHeight, vw = document.documentElement.clientWidth, ph = el.offsetHeight, pw = el.offsetWidth;
          let top = ar.bottom + 5;
          if (el.dataset.pos === 'up' || top + ph > vh - m) top = Math.max(m, ar.top - ph - 5);
          let left = ar.left;
          // Clamp left so pop stays within viewport
          if (left + pw > vw - m) left = vw - m - pw;
          if (left < m) left = m;
          return { left, top };
        };
        const ar = anchor.getBoundingClientRect();
        let xy = _pos(ar);
        // If pop still overflows vertically, scroll anchor into view then recompute
        const tentBottom = xy.top + el.offsetHeight;
        if (tentBottom > window.innerHeight - m || xy.top < m) {
          anchor.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          xy = _pos(anchor.getBoundingClientRect());
        }
        this.popXY = xy;
        // Scroll/resize tracking: reposition or close when anchor moves
        let rafId = null;
        const reposition = () => {
          if (!this.pop) { cleanup(); return; }
          const a = anchor.getBoundingClientRect(), vh = window.innerHeight, vw = document.documentElement.clientWidth;
          if (a.bottom < 0 || a.top > vh || a.right < 0 || a.left > vw) { this.pop = null; cleanup(); return; }
          if (!findPop()) { cleanup(); return; }
          this.popXY = _pos(a);
        };
        const onScrollOrResize = () => {
          if (!this.pop) { cleanup(); return; }
          if (rafId) return;
          rafId = requestAnimationFrame(() => { rafId = null; reposition(); });
        };
        const cleanup = () => {
          window.removeEventListener('scroll', onScrollOrResize, true);
          window.removeEventListener('resize', onScrollOrResize);
          if (this._popTrack === cleanup) this._popTrack = null;
        };
        window.addEventListener('scroll', onScrollOrResize, true);
        window.addEventListener('resize', onScrollOrResize);
        this._popTrack = cleanup;
      });
    },
    // translateX keeps absolute-positioned pickers in viewport (used by _positionPicker + log-when-pop)
    clampX(el) {
      if (!el) return;
      el.style.transform = '';
      const r = el.getBoundingClientRect(), m = 8, vw = document.documentElement.clientWidth;
      let dx = 0;
      if (r.right > vw - m) dx = (vw - m) - r.right;
      if (r.left + dx < m) dx = m - r.left;
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    },
    projectPath(p) {
      const parts = []; let cur = p;
      while (cur) { parts.unshift(cur.content); cur = this.byId.get(cur.parent_id); }
      return parts.join(' / ');
    },
    // uFuzzy-ranked + subsequence fallback for short fragments; shared picker search
    pickerMatches(candidates) {
      const q = this.pickerQ.trim();
      if (!q) return candidates;
      const hay = candidates.map(t => t.content + ' ' + this.projectPath(t));
      this._pickerFuzzy = this._pickerFuzzy || makeFuzzy();
      const ranked = fuzzyRank(this._pickerFuzzy, hay, q);
      if (ranked) return ranked.map(i => candidates[i]);
      return candidates.filter((_, i) => this._seqMatch(hay[i], q));   // short-fragment fallback
    },
    // Projects you can file under: sidebar projects (even empty) and any parent task; minus the default.
    // sidebar projects first (stable within groups); task-projects (tasks acting as containers) trail
    filteredProjects() { const def = this.store.defaultProject(); return this.pickerMatches(this.tasks.filter(t => t.id === def || t.sidebar || this.hasChildren(t.id))).sort((a, b) => (b.sidebar === true || b.id === def ? 1 : 0) - (a.sidebar === true || a.id === def ? 1 : 0)); },
    taskProj(p) { return !p.sidebar && p.id !== this.store.defaultProject(); },   // container task, not a real sidebar project
    pickProject(project) { this.draft.project_id = project.id; this.draft.project = project.content; this.projRequired = false; this.pickerQ = ''; this.pop = null; },
    defaultProjName() {
      const id = this.store.defaultProject();
      return this.byId.get(id)?.content ?? null;
    },
    async createFilteredProj() {
      const name = this.pickerQ.trim(); if (!name) return;
      const existing = this.tasks.find(x => x.content === name && x.parent_id === null);
      const project = existing || await this.store.tasks.create({ content: name, parent_id: null, sidebar: true });
      if (!project) return;
      await this.loadTasks();
      this.pickProject(project);
    },
    toggleArea(id) { const i = this.draft.areas.indexOf(id); if (i >= 0) this.draft.areas.splice(i, 1); else this.draft.areas.push(id); },
    // Find-or-create an area by NAME → its id. Store dedups (trim + reuse), so re-typing a name never
    // duplicates; the server also has areas_user_name_idx as the backstop.
    async ensureAreaId(name) {
      const nm = (name || '').trim(); if (!nm) return null;
      const found = this.areas.find(a => a.name === nm);
      if (found) return found.id;
      const area = await this.store.areas.create({ name: nm });
      await this.loadAreas();
      return area?.id ?? null;
    },
    async createAndToggleArea() {
      const id = await this.ensureAreaId(this.newAreaName);
      if (id && !this.draft.areas.includes(id)) this.draft.areas.push(id);
      this.newAreaName = '';
    },
    // Areas cluster: usage-weighted size tier (s1 big → s3 small) by rank thirds over tasks touching
    // the area in the last 30 LOCAL days. Ties share the better tier; flat usage → all s2.
    areaTier(id) {
      const cut = new Date(); cut.setHours(0, 0, 0, 0); cut.setDate(cut.getDate() - 30);
      const use = Object.fromEntries(this.areas.map(l => [l.id, 0]));
      for (const t of this.tasks) if (new Date(t.updated_at || t.created_at || 0) >= cut)
        for (const a of t.area_ids || []) if (a in use) use[a]++;
      const ranked = Object.keys(use).sort((a, b) => use[b] - use[a]);
      if (use[ranked[0]] === use[ranked.at(-1)]) return 's2';
      const third = Math.ceil(ranked.length / 3);
      return 's' + (Math.min(Math.floor(ranked.findIndex(r => use[r] === use[id]) / third), 2) + 1);
    },
    clusterPick(el, id) {   // toggle + soft scale pop on select (reduced-motion: none)
      this.toggleArea(id);
      if (this.draft.areas.includes(id) && !this.reduceMotion())
        el.animate({ transform: ['scale(1)', 'scale(1.06)', 'scale(1)'] }, { duration: 180, easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out' });
    },
    endPicking: false, tpop: false, tpopStyle: '', hdrPulse: false, repIdx: 0,
    repRules() { return recRules(this.draft.recurrence); },
    // the statement the spatial controls act on (headers, ordinals, time popover) — last-touched zone
    curRule() { const rs = this.repRules(); return rs[Math.min(this.repIdx, rs.length - 1)] || null; },
    _calTo(iso) { const d = new Date(iso.slice(0, 10) + 'T00:00'); this.cal = { y: d.getFullYear(), m: d.getMonth() }; },
    _dateKey(n = this.pop) { return n === 'due' ? 'due_at' : 'deadline_at'; },
    openDate(name, anchor) {
      this.togglePop(name, anchor);
      if (this.pop !== name) return;
      this.endPicking = false; this.tpop = false;
      this._calTo(this.draft[this._dateKey(name)] || isoDate(new Date()));
      this.$nextTick(() => this.$refs[name === 'due' ? 'dueType' : 'dlType']?.focus());
    },
    // Recompute the next-occurrence due whenever the recurrence rule changes (anchored at the current due, else today).
    refreshRecurrenceDue() {
      if (!this.repRules().length) return;
      // An existing due date (even a past one) is the rule's ANCHOR — never overwrite it; only seed when empty.
      if (this.draft.due_at) {
        this._calTo(this.draft.due_at);
        return;
      }
      const b = nextAcrossRules(this.draft.recurrence, isoDate(new Date()), new Date(), { inclusive: true });
      if (!b) return;
      this.draft.due_at = b.iso;
      this._calTo(b.iso);
    },
    // --- Repeat picker (lives at the bottom of the due popover) ---
    setRepeatFreq(freq) {
      const r = this.curRule();
      if (!r) { this.draft.recurrence = { freq, interval: 1, from_completion: false, ends: null, done_count: 0 }; this.repIdx = 0; }
      else { r.freq = freq; if (freq !== 'week') delete r.weekdays; if (freq !== 'month') delete r.month_day; }
      this.refreshRecurrenceDue();
    },
    // [+ repeat]: stack another statement (recurrence becomes an array; a single rule stays a plain object)
    addRepeat() {
      this.draft.recurrence = [...this.repRules(), { freq: 'day', interval: 1, from_completion: false, ends: null, done_count: 0 }];
      this.repIdx = this.draft.recurrence.length - 1;
      this.refreshRecurrenceDue();
    },
    setRepeatInterval(delta) {
      const r = this.curRule(); if (!r) return;
      r.interval = Math.max(1, Math.min(99, (r.interval || 1) + delta));
      this.refreshRecurrenceDue();
    },
    toggleRepeatWeekday(i) {
      if (!this.curRule()) this.setRepeatFreq('week');   // painting a header creates the weekly rule
      const r = this.curRule();
      r.freq = 'week';
      const wd = new Set(r.weekdays || []); wd.has(i) ? wd.delete(i) : wd.add(i);
      r.weekdays = [...wd].sort((a, b) => a - b);
      if (!r.weekdays.length) delete r.weekdays;
      this.refreshRecurrenceDue();
    },
    toggleFromCompletion() { const r = this.curRule(); if (r) r.from_completion = !r.from_completion; },
    cycleRepeatFreq() {
      const order = ['day', 'week', 'month', 'year'], r = this.curRule(); if (!r) return;
      const next = order[(order.indexOf(r.freq) + 1) % 4];
      this.setRepeatFreq(next);
      if (next === 'month') r.month_day = new Date((this.draft.due_at || isoDate(new Date())).slice(0, 10) + 'T00:00').getDate();
    },
    // "on [...]" chip label: weekly day set / monthly day-of-month / yearly anniversary; null when inapplicable (day freq)
    repDaysLabel(r) {
      if (!r) return null;
      const anchor = new Date((this.draft.due_at || isoDate(new Date())).slice(0, 10) + 'T00:00');
      if (r.freq === 'week') return r.weekdays?.length ? r.weekdays.map(i => CL_WD[i]).join(' ') : CL_WD[anchor.getDay()];
      if (r.freq === 'month') { const n = r.month_day || anchor.getDate(); return 'the ' + n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }
      if (r.freq === 'year') return anchor.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return null;
    },
    pulseWeekdays() { this.flashGoal('hdrPulse', '_hdrPulseT', true, 700); },
    // count-ends stepper: count and date are mutually exclusive (ends is single-valued); stepping to 0 = never
    setRepeatCount(delta) {
      const r = this.curRule(); if (!r) return;
      const next = Math.max(0, Math.min(99, (r.ends?.count || 0) + delta));
      r.ends = next ? { count: next } : null;
    },
    toggleEndPicking() { if (this.curRule()) this.endPicking = !this.endPicking; },
    // Tap-and-hold a day (~450ms) = "every month on the Nth", anchored there. The trailing click is swallowed.
    holdStart(c) { this.holdCancel(); this._holdT = setTimeout(() => { this._held = true; this.holdMonthly(c); }, 450); },
    holdCancel() { if (this._holdT) { clearTimeout(this._holdT); this._holdT = null; } },
    holdMonthly(c) {
      if (!this.draft.due_at) this.draft.due_at = c.iso;   // the held day anchors the rule — set BEFORE any seeding
      if (!this.curRule()) this.setRepeatFreq('month');
      const r = this.curRule();
      r.freq = 'month'; delete r.weekdays; r.month_day = c.d;
      this.refreshRecurrenceDue();
    },
    calDayTap(c) {
      if (this._held) { this._held = false; return; }   // the click that follows a fired hold is not a tap
      const r = this.curRule();
      if (this.endPicking && r) {   // quiet end-pick: tapped day = last occurrence of the active statement; boundary re-tap clears
        this.setRepeatUntil(c.iso === r.ends?.date ? '' : c.iso);
        this.endPicking = false; return;
      }
      this.draft.due_at = c.iso;
      if (this.repRules().length) this.repRules().forEach(x => { x.gen_due = false; });   // hand-set due: stays accent even while paused
      else this.pop = null;               // recurring drafts keep the popover open (anchor change repaints)
    },
    calDayClass(c) {
      return { out: !c.cur, today: c.today, sel: c.iso === this.draft.due_at, occ: c.occ, 'occ-h': c.occh, 'occ-g': c.occg, end: c.end, h: c.endh,
        gz: c.iso === this.draft.due_at && this.repRules().some(r => r.paused && r.gen_due) };
    },
    // --- shared time popover (anchors: the Add-time row and the sentence's [at ...] chip) ---
    toggleTimePop(ev) {
      if (this.tpop) { this.tpop = false; return; }
      const btn = ev.currentTarget, pop = btn.closest('.pop');
      const b = btn.getBoundingClientRect(), p = pop.getBoundingClientRect();
      this.tpopStyle = `display:block; left:${Math.round(Math.max(6, Math.min(b.left - p.left, p.width - 218)))}px; bottom:${Math.round(p.bottom - b.top + 6)}px;`;
      this.tpop = true;
      this.$nextTick(() => this.$refs.tpopIn?.focus());
    },
    // the time the popover edits: the active statement's own `at`, or the plain draft's task-level time
    timeGet() { const r = this.curRule(); return r ? (r.at || '') : (this.draft.dueTime || ''); },
    timeSet(v) { const r = this.curRule(); if (r) { if (v) r.at = v; else delete r.at; } else this.draft.dueTime = v; },
    tpopHours() {
      const t = this.timeGet(), cur = t ? +t.slice(0, 2) : -1;
      return Array.from({ length: 18 }, (_, i) => {
        const h = i + 6;
        return { h, lbl: h === 12 ? 12 : h % 12, ap: h === 6 ? 'a' : (h === 12 || h === 18) ? 'p' : '', on: h === cur };
      });
    },
    timeQuarter() { return this.timeGet() ? +this.timeGet().slice(3, 5) : null; },
    setTimeHour(h) { this.timeSet(String(h).padStart(2, '0') + ':' + String(this.timeQuarter() ?? 0).padStart(2, '0')); },
    setTimeQuarter(q) { const t = this.timeGet() || '12:00'; this.timeSet(t.slice(0, 2) + ':' + String(q).padStart(2, '0')); },
    applyTimeText(ev) {
      const { time } = parseDateText(ev.target.value);
      if (time) this.timeSet(time);
      ev.target.value = ''; this.tpop = false;
    },
    // Optional "until" end date — reuses the existing ends.date field (nextOccurrence/completion already honor it).
    setRepeatUntil(iso) { const r = this.curRule(); if (!r) return; r.ends = iso ? { date: iso } : null; },
    clearRepeat(i = 0) {   // trash one statement; a single leftover collapses back to the legacy object shape
      const arr = this.repRules().filter((_, j) => j !== i);
      this.draft.recurrence = arr.length === 0 ? null : arr.length === 1 ? arr[0] : arr;
      this.repIdx = 0; this.endPicking = false; this.tpop = false;
    },
    repeatUnitLabel(r) {
      if (!r) return '';
      const n = r.interval || 1;
      return r.freq + (n > 1 ? 's' : '');
    },
    calShift(n) {
      let { y, m } = this.cal; m += n;
      if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
      this.cal = { y, m };
    },
    calLabel() { return new Date(this.cal.y, this.cal.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }); },
    // Static inner HTML for .cal-head ×3 — calLabel() is an x-text directive Alpine processes after x-html inserts it, so the builder reads no reactive state.
    calHeadHtml() { return '<span x-text="calLabel()"></span><span class="cal-navs flex items-center"><button type="button" class="cal-nav inline-flex items-center justify-center" @click="calShift(-1)"><svg class="ico"><use href="#i-chev-l"/></svg></button><button type="button" class="cal-nav dot inline-flex items-center justify-center" @click="calToday()"><svg class="ico"><use href="#i-circle"/></svg></button><button type="button" class="cal-nav inline-flex items-center justify-center" @click="calShift(1)"><svg class="ico"><use href="#i-chev-r"/></svg></button></span>'; },
    // HAZARD: args must be string literals ('eventEdit'/'blockEdit'), never reactive values — a reactive arg changes the x-html string on state updates, causing re-render that kills the input caret mid-typing.
    evWhenHtml(key, ph) { return `<input class="ev-title" type="text" placeholder="${ph}" :value="${key}.title" @input="${key}.title = $event.target.value"><div class="ev-row flex items-center"><label class="ev-allday inline-flex items-center gap-6"><input type="checkbox" :checked="${key}.all_day" @change="${key}.all_day = $event.target.checked"> All-day</label></div><div class="ev-row flex items-center"><input class="ev-field" type="date" :value="${key}.date" @input="${key}.date = $event.target.value"><template x-if="!${key}.all_day"><span class="ev-times inline-flex items-center gap-6"><input class="ev-field" type="time" :value="${key}.start" @input="${key}.start = $event.target.value"><span class="ev-dash">–</span><input class="ev-field" type="time" :value="${key}.end" @input="${key}.end = $event.target.value"></span></template></div>`; },
    evActionsHtml(key) { const del = key === 'eventEdit' ? 'clDeleteEvent' : 'clDeleteBlock', save = key === 'eventEdit' ? 'clSaveEvent' : 'clSaveBlock'; return `<div class="dialog-actions flex items-center gap-8"><button class="ghost danger" x-show="${key}.id" @click="${del}()">Delete</button><span class="spacer"></span><button class="ghost" @click="${key} = null">Cancel</button><button class="primary" @click="${save}()">Save</button></div>`; },
    calCells() {
      const { y, m } = this.cal, lead = new Date(y, m, 1).getDay(), todayIso = isoDate(new Date());
      // Preview upcoming occurrences of the draft's recurrence as subtle dots — visible month only (cheap).
      const rules = this.repRules();
      const marks = new Map();   // iso → 'occ' | 'occh' | 'occg' (solid > hollow > grey across statements)
      let ord = null, wall = null, wallh = false;
      if (rules.length) {
        const first = isoDate(new Date(y, m, 1 - lead)), last = isoDate(new Date(y, m, 1 - lead + 41));
        const anchor = this.draft.due_at ? this.draft.due_at.slice(0, 10) : todayIso;
        const rank = { occ: 3, occh: 2, occg: 1 };
        for (const r of rules) {
          const kind = r.paused ? 'occg' : r.from_completion ? 'occh' : 'occ';
          for (const s of occurrencesInRange(r, anchor, first, last)) {
            const iso = s.slice(0, 10);
            if (!marks.has(iso) || rank[kind] > rank[marks.get(iso)]) marks.set(iso, kind);
          }
        }
        const cur = this.curRule();
        // Ordinals follow the ACTIVE statement: while end-picking (a date-end and a count-end are the same tap)
        // AND whenever a count end is set — the calendar shows which repetition lands on which day.
        // Armed picking ignores the rule's current ends: ALL candidate days get numbers (a tap swaps count → date).
        if (cur && (this.endPicking || cur.ends?.count)) {
          const probe = this.endPicking ? { ...cur, ends: null } : cur;
          ord = new Map(occurrencesInRange(probe, anchor, anchor, last).map((s, i) => [s.slice(0, 10), i + 1]));
        }
        if (cur?.ends?.date) wall = cur.ends.date;
        else if (cur?.ends?.count) { const all = occurrencesInRange(cur, anchor, anchor, '9999-12-31'); wall = all.length ? all[all.length - 1].slice(0, 10) : null; }
        wallh = !!cur?.from_completion;
      }
      return Array.from({ length: 42 }, (_, i) => {
        const d = new Date(y, m, 1 - lead + i), iso = isoDate(d);
        const kind = marks.get(iso), isWall = iso === wall;
        const nOrd = ord ? (ord.get(iso) || 0) : 0, vis = !isWall && !nOrd;   // a badge replaces the dot (both sit bottom-center)
        return { key: iso, d: d.getDate(), iso, cur: d.getMonth() === m, today: iso === todayIso,
          occ: kind === 'occ' && vis, occh: kind === 'occh' && vis, occg: kind === 'occg' && vis,
          end: isWall, endh: isWall && wallh, ord: nOrd };
      });
    },
    calToday() { const n = new Date(); this.cal = { y: n.getFullYear(), m: n.getMonth() }; },
    quickLabel(key) {
      const d = new Date(quickDate(key) + 'T00:00');
      return key === 'nextweek'
        ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
        : d.toLocaleDateString([], { weekday: 'short' });
    },
    setQuick(key) {
      if (this.pop === 'due') { const r = quickRange(key, new Date()); this.draft.available_from = r.from; this.draft.due_at = r.to; }
      else this.draft.deadline_at = quickDate(key);
      this.pop = null;
    },
    quickActive(key) { const r = quickRange(key, new Date()); return !!this.draft.due_at && this.draft.due_at.slice(0, 10) === r.to && (this.draft.available_from || '').slice(0, 10) === r.from; },
    applyDateText(close) {
      // a recurrence phrase ("every 10 days") sets the repeat rule rather than a one-off date (due popover only)
      if (this.pop === 'due') {
        const rec = parseRecurrence(this.draft.dateText);
        if (rec) {
          const { time } = parseDateText(this.draft.dateText);   // "every 2 days at 5pm" — the time rides along
          if (time) rec.at = time;
          const rs = this.repRules();
          if (rs.length > 1) { const arr = [...rs]; arr[Math.min(this.repIdx, arr.length - 1)] = rec; this.draft.recurrence = arr; }
          else this.draft.recurrence = rec;   // no rules or a single one: the phrase IS the rule
          this.refreshRecurrenceDue();
          if (close) { this.draft.dateText = ''; this.pop = null; }
          return;
        }
      }
      const { iso, time } = parseDateText(this.draft.dateText);
      if (iso) {
        this.draft[this._dateKey()] = iso;
        if (time && this.pop === 'due') this.draft.dueTime = time;
        this._calTo(iso);
      }
      if (close) { this.draft.dateText = ''; this.pop = null; }
    },
    dueLabel() {
      // Recurring: show each rule + its ending (until <date> / N×) so a repeat's end is visible on the
      // button without opening the picker; every rule in a multi-repeat carries its own end.
      const rs = this.repRules();
      if (rs.length) {
        const lbl = r => this.recurrenceLabel(r) + (r.at ? ' · ' + this.fmtTime(r.at) : '') + (r.ends?.date ? ' · until ' + this.fmt(r.ends.date) : r.ends?.count ? ' · ' + r.ends.count + '×' : '');
        return rs.map(lbl).join(' + ');
      }
      if (!this.draft.due_at) return 'Date';
      return this.fmt(this.draft.due_at) + (this.draft.dueTime ? ' ' + this.fmtTime(this.draft.dueTime) : '');
    },
    recurrenceLabel(rec) { return recurrenceLabel(rec); },
    // Active pill-NLP target — the editor + the draft its pills mutate. Defaults to the title; a subtask editor
    // sets `_nlpFocus` on focus so the shared engine (pillify/insert/commit/unchip/…) drives that row instead.
    _nlpEl() { return _nlpFocus?.el || this.$refs.content; },
    _nlpDraft() { return _nlpFocus?.draft || this.draft; },
    // --- Inline-pill editor (contenteditable title) ---
    // draft.content = the editor's TEXT nodes only (pills excluded), whitespace-collapsed. WYSIWYG: this
    // is the title verbatim; fields come only from pills (Task 3), never a submit-time re-parse.
    syncTitle() {
      const el = this._nlpEl(), d = this._nlpDraft(); if (!el) return;
      d.content = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
      const empty = !el.querySelector('.nlp-pill') && d.content === '';
      if (!_nlpFocus) this.titleEmpty = empty;           // titleEmpty is title-only placeholder state
      else if (_nlpFocus.ghost) this.subGhost = el.textContent.trim();   // ghost's active-state + submit-flush + autosave mirror
      if (empty && el.childNodes.length) {     // emptied (stray <br>/whitespace) → reset clean, caret to start
        el.textContent = '';
        this._caret(el, 0);
      }
    },
    setEditorText(text) { const el = this.$refs.content; if (el) { el.textContent = text || ''; this.titleEmpty = !el.querySelector('.nlp-pill') && (text || '') === ''; this._noPillOnce = false; } },
    // --- Inline live-markdown editor (contenteditable description) ---
    // mdLive keeps textContent === raw text; caret saved as char offset, restored 1:1 after innerHTML re-render
    // mdLive + a trailing <br> sentinel when the raw ends in \n: Chromium collapses a caret parked past a bare trailing
    // newline back before it (so typing lands on the wrong line) — the <br> gives the empty last line a caret home.
    // textContent ignores the <br>, so the textContent===raw contract still holds.
    _descHtml(text) { return mdLiveRender(text) + (text.endsWith('\n') ? '<br>' : ''); },
    setDescText(text) { const el = this.$refs.desc; if (el) el.innerHTML = this._descHtml(text || ''); },
    chkLive(text) { return chkLiveRender(text); },   // x-init source for the composer checklist item live "::" editor
    // Rows are contenteditable set once via x-init; Alpine x-for reuses keyed elements across reopen/undo without re-running it,
    // so refresh each idle row's markup from the draft after any wholesale draft.checklist change.
    syncChkRows() {
      document.querySelectorAll('.composer-entries .entry.chk:not(.ghost) .entry-txt').forEach(el => {
        if (document.activeElement === el) return;
        const item = this.draft.checklist.find(c => c.id === el.closest('.entry.chk')?.dataset.id);
        if (item) el.innerHTML = chkLiveRender(item.text);
      });
    },
    // defer-to-blur: only capture text on input; decoration applied by onDescBlur (preserves native ⌘Z).
    onDescInput(e) {
      if (e && e.isComposing) return;
      const el = this.$refs.desc; if (!el) return;
      this.draft.notes = el.textContent;
    },
    // On focus: restore raw text so the user edits raw markup and ⌘Z starts fresh.
    // Caret offset is computed first (textContent===raw is the mdLive contract, so the offset is valid in both).
    onDescFocus(el) {
      const off = this._caretOffset(el), raw = this.draft.notes || '';
      el.textContent = raw;
      this._setCaret(el, off ?? raw.length);
    },
    onDescBlur(el) { el.innerHTML = this._descHtml(el.textContent); },
    descKeydown(e) {
      // ArrowDown out of an EMPTY description continues the ladder into the entry rows; with text in it, down
      // still moves the caret through the lines (the field owns the key).
      if (e.key === 'ArrowDown') { if (!this.$refs.desc?.textContent.trim() && this.focusFirstEntry()) e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { if (!this.$refs.desc?.textContent.trim() && this._focusUp(this.$refs.content)) e.preventDefault(); return; }
      if (e.key !== 'Enter') return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { e.preventDefault(); this.submitComposer(); return; }
      e.preventDefault();
      // execCommand('insertText', '\n') silently drops the newline in this WebView. Splice a real \n into the raw text
      // at the caret (mdLive keeps textContent===raw with real \n; pre-wrap renders it), re-render, then place the caret
      // at offset+1 INSIDE the text node — a caret parked "past a standalone trailing \n node" collapses back before it.
      const el = this.$refs.desc; if (!el) return;
      const off = this._caretOffset(el); if (off == null) return;
      const text = el.textContent, nt = text.slice(0, off) + '\n' + text.slice(off);
      this.draft.notes = nt;
      el.innerHTML = this._descHtml(nt);
      this._setCaret(el, off + 1);
    },
    descPaste(e) { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain')); },
    descClick(e) { const a = e.target.closest?.('a.dm-link'); if (a) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); } },
    // stable across innerHTML re-render (mdLive never changes text, only wraps it)
    _caretOffset(el) {
      const s = getSelection(); if (!s || !s.rangeCount) return null;
      const r = s.getRangeAt(0); if (!el.contains(r.endContainer)) return null;
      const pre = r.cloneRange(); pre.selectNodeContents(el); pre.setEnd(r.endContainer, r.endOffset);
      return pre.toString().length;
    },
    _setCaret(el, off) {
      if (off == null) return;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n = 0, node;
      while ((node = w.nextNode())) {
        const len = node.nodeValue.length;
        if (n + len >= off) { this._caret(node, off - n); return; }
        n += len;
      }
      this._caret(el);
    },
    // Set caret: off == null → collapse to end of n (selectNodeContents); else → setStart at offset.
    _caret(n, off) { const r = document.createRange(); if (off == null) { r.selectNodeContents(n); r.collapse(false); } else { r.setStart(n, off); r.collapse(true); } const s = getSelection(); s.removeAllRanges(); s.addRange(r); },
    pillLabel(kind, v) { return PILL_SPEC[kind].label(this, v); },
    commitPill(kind, v) { PILL_SPEC[kind].commit(this, this._nlpDraft(), v); },
    // Revert the field a removed pill had set. `raw` is the pill's data-value (string form).
    clearPillField(kind, r) { PILL_SPEC[kind].clear(this, this._nlpDraft(), r); },
    // Snapshot the draft field(s) a `kind` pill owns — stored on the pill at insert, restored on backspace.
    _fieldSnapshot(kind) { return PILL_SPEC[kind].snapshot(this, this._nlpDraft()); },
    _restoreField(kind, s) { PILL_SPEC[kind].restore(this, this._nlpDraft(), s); },
    // Build a configured pill span (no DOM insertion). Single source of truth for pill markup.
    makePill(kind, value, token) {
      const pill = document.createElement('span');
      pill.className = 'nlp-pill inline-flex items-center'; pill.dataset.kind = kind;
      pill.dataset.value = PILL_SPEC[kind].json ? JSON.stringify(value) : String(value);
      pill.dataset.token = token; pill.contentEditable = 'false'; pill.textContent = this.pillLabel(kind, value);
      pill.dataset.prior = JSON.stringify(this._fieldSnapshot(kind));   // field value BEFORE this chip — restored on backspace (non-destructive)
      return pill;
    },
    // Build + insert a pill span replacing text [start..end) of the caret's text node, KEEPING the tail
    // after `end` so a token pilled mid-title doesn't eat the words after it. `token` is the source text
    // restored on un-chipify. Caret lands right after the pill (start of the tail node).
    insertPill(textNode, start, kind, value, token, end = textNode.textContent.length) {
      const el = this._nlpEl();
      const before = document.createTextNode(textNode.textContent.slice(0, start));
      const pill = this.makePill(kind, value, token);
      const after = document.createTextNode(textNode.textContent.slice(end));
      el.replaceChild(after, textNode); el.insertBefore(pill, after); el.insertBefore(before, pill);
      this._caret(after, 0);
      this.commitPill(kind, value);
      this.syncTitle();
    },
    // Pill the token ENDING AT THE CARET (not the node's end) — so editing/re-typing a word mid-title
    // re-recognises just like typing at the end. `off` is the caret offset; text after it is preserved.
    pillifyTrailing() {
      const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) return false;
      const node = sel.anchorNode, off = sel.anchorOffset;
      if (!node || node.nodeType !== 3) return false;
      // The caret is the authority on which editor is live. Aiming at a stale target (a subtask row that lost
      // focus without the title's @focus firing to reset it) used to make this bail SILENTLY — no chip at all,
      // for any kind. Re-point at the title instead of dropping the keystroke on the floor.
      if (node.parentNode !== this._nlpEl()) { if (node.parentNode !== this.$refs.content) return false; this.focusTitle(); }
      const pending = node.textContent.slice(0, off);
      const tok = matchTrailingToken(pending, new Date(), this.locNames());
      if (!tok) return false;
      const token = pending.slice(tok.start);
      if (tok.kind === 'date' && this.swallowIntoPrevDate(node, tok, token, off)) return true;   // [next week] + "sun" → [next week sunday]
      if (tok.kind === 'area') { this.pillifyArea(node, tok, token, off); return true; }         // area tokens carry a NAME → resolve to an id first
      this.insertPill(node, tok.start, tok.kind, tok.value, token, off);
      return true;
    },
    // Typed "@name" parses to an area NAME; resolve it to an area id (reuse or create) before inserting the
    // pill, so area pills always carry an id (dupes stay distinct). Async, like the @-picker's create path.
    async pillifyArea(node, tok, token, end) {
      const id = await this.ensureAreaId(tok.value);
      if (!id) return;
      // the node/caret may have shifted while awaiting the store — only pill if the token text is still there
      if (node.parentNode !== this._nlpEl() || node.textContent.slice(tok.start, end) !== token) return;
      this.insertPill(node, tok.start, 'area', id, token, end);
    },
    // A trailing date word right after a date pill MERGES into it: re-parse "<pill token> <word>"; if it reads as
    // one date, swap the pill for the combined one and drop the word. So [next week] + "sun" → next week's Sunday.
    swallowIntoPrevDate(node, tok, token, end = node.textContent.length) {
      if (node.textContent.slice(0, tok.start).trim() !== '') return false;          // the word must sit directly after the pill
      let prev = node.previousSibling;
      while (prev && prev.nodeType === 3 && /^\s*$/.test(prev.textContent)) prev = prev.previousSibling;
      if (!prev || prev.nodeType !== 1 || !prev.classList?.contains('nlp-pill') || prev.dataset.kind !== 'date') return false;
      const combined = (prev.dataset.token + ' ' + token).trim();
      const cls = classifyToken(combined, new Date(), this.locNames());
      if (!cls || cls.kind !== 'date') return false;
      // only MERGE a refinement (prev pill narrows the new word, e.g. "next week" + "sunday"). If the new word
      // alone lands on the same date as the combination, they're two INDEPENDENT dates ("friday" then "monday") — keep
      // them as separate chips so backspacing the second reverts to the first AND drops its word back as text.
      const solo = classifyToken(token.trim(), new Date(), this.locNames());
      if (solo && solo.kind === 'date' && solo.value?.iso && solo.value.iso === cls.value?.iso) return false;
      const merged = this.makePill('date', cls.value, combined);
      // backspacing the merged chip must revert to the PREVIOUS date (the state right now, before we commit the
      // merge), not to the pre-prev-chip base — else e.g. "friday" then "monday" would delete the date entirely.
      merged.dataset.prior = JSON.stringify(this._fieldSnapshot('date'));
      this._nlpEl().replaceChild(merged, prev);
      node.textContent = ' ' + node.textContent.slice(end);                           // word now inside the pill; keep any tail
      this._caret(node, 1);
      this.commitPill('date', cls.value); this.syncTitle();
      return true;
    },
    // backspace after a pill → restore token text + clear field; second backspace then edits normally
    unchipPillBefore() {
      const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) return false;
      const r = sel.getRangeAt(0); const node = r.startContainer;
      let prev = null;
      // Only revert when nothing REAL sits to the caret's left (a space is a real char → let native delete it first).
      if (node.nodeType === 3) { if (r.startOffset === 0) prev = node.previousSibling; }
      else if (node === this._nlpEl() && r.startOffset > 0) prev = node.childNodes[r.startOffset - 1];
      // Skip zero-width text nodes — typing past a chip leaves an empty node between the pill and the new text,
      // so the caret's previousSibling is that empty node, not the pill (this stranded the chip on backspace).
      while (prev && prev.nodeType === 3 && prev.textContent === '') prev = prev.previousSibling;
      if (!prev || !(prev instanceof HTMLElement) || !prev.classList.contains('nlp-pill')) return false;
      const kind = prev.dataset.kind, raw = prev.dataset.value, sp = PILL_SPEC[kind];
      const value = pillValue(kind, raw);
      const prior = prev.dataset.prior != null ? JSON.parse(prev.dataset.prior) : null;
      this.clearPillField(kind, sp.multi ? raw : value);
      const text = document.createTextNode(prev.dataset.token || prev.textContent);
      prev.replaceWith(text);
      // A same-kind pill may still stand: re-commit remaining pills; with none left, restore the prior value.
      this._recommitPills([kind]);
      const remaining = this._nlpEl().querySelectorAll('.nlp-pill[data-kind="' + kind + '"]');
      if (!remaining.length && !sp.multi) this._restoreField(kind, prior);
      this._caret(text, text.textContent.length);   // caret at the end of the restored token text
      this.syncTitle();
      this._noPillOnce = true;   // just un-chipped on purpose → the next space must NOT re-chip it
      return true;
    },
    // Reset the touched kinds, then replay every surviving pill so fields reflect exactly the pills left in
    // the DOM (area/goal are additive arrays → empty them fully; other kinds clear to their default).
    _recommitPills(kinds) {
      const d = this._nlpDraft();
      for (const k of kinds) { const sk = PILL_SPEC[k]; sk.multi ? (d[sk.multi] = []) : this.clearPillField(k, null); }
      for (const p of this._nlpEl().querySelectorAll('.nlp-pill')) {
        const pr = p.dataset.value, kind = p.dataset.kind;
        this.commitPill(kind, pillValue(kind, pr));
      }
    },
    // Deletions route through beforeinput, NOT keydown: it fires for hardware keys AND soft-keyboard/IME
    // input (Android sends deleteContentBackward with no 'Backspace' keydown), on both Blink and WebKit. Own
    // any delete that would touch a pill so native deletion never strands a pill's field or eats the block.
    onEditorBeforeInput(e) {
      if (!e.inputType || !e.inputType.startsWith('delete')) return;
      const sel = getSelection(); if (!sel.rangeCount) return;
      if (!sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const pills = [...this._nlpEl().querySelectorAll('.nlp-pill')].filter(p => range.intersectsNode(p));
        if (!pills.length) return;                                     // plain-text selection → let native delete it
        e.preventDefault();
        const kinds = new Set(pills.map(p => p.dataset.kind));
        range.deleteContents();                                        // remove selected text + pills together
        this._recommitPills(kinds); this.syncTitle();
      } else if (/Backward/.test(e.inputType)) {
        if (this.unchipPillBefore()) e.preventDefault();               // pill before caret → non-destructive revert
      }
    },
    _seqMatch(name, frag) {
      let fi = 0; const f = frag.toLowerCase(), n = name.toLowerCase();
      for (let i = 0; i < n.length && fi < f.length; i++) { if (n[i] === f[fi]) fi++; }
      return fi === f.length;
    },
    // Rank/filter over the area OBJECTS (by id), not names — so duplicate names stay distinct and the @ menu
    // renders the same deduped set as the id-keyed popups. fuzzyRank returns indices into this.areas.
    resolveArea(frag) {
      if (!frag) return this.areas;
      const names = this.areas.map(t => t.name);
      this._areaFuzzy = this._areaFuzzy || makeFuzzy();
      const ranked = fuzzyRank(this._areaFuzzy, names, frag);
      if (ranked) return ranked.map(i => this.areas[i]);
      // Subsequence fallback for short abbreviations uFuzzy won't match.
      return this.areas.filter(a => this._seqMatch(a.name, frag));
    },
    areaMatches() { return this.resolveArea(this.areaPicker.frag); },
    openPicker(type, node, at) { const sp = PICKERS[type], p = this[sp.key]; Object.assign(p, { open: true, frag: '', sel: 0, node, at, left: 0, top: 0 }); this._positionPicker(p, sp.sel); },
    refreshPicker(type) { const sp = PICKERS[type]; this._refreshPicker(this[sp.key], sp.char, sp.sel); },
    pickPill(type, id) {
      const sp = PICKERS[type], p = this[sp.key], node = p.node;
      node.textContent = node.textContent.slice(0, p.at) + node.textContent.slice(p.at + 1 + p.frag.length);
      this._caret(node, p.at);
      this.insertPill(node, p.at, sp.kind, id, sp.char + (sp.name(this, id) || ''));
      p.open = false;
      if (_nlpFocus?.c) this._nlpEl().focus();
    },
    pickerKeydown(type, e) {
      const sp = PICKERS[type], p = this[sp.key]; if (!p.open) return false;
      const matches = type === 'area' ? this.areaMatches() : this.goalMatches();
      return this._pickerKeydown(e, p, matches, m => this.pickPill(type, m.id), sp.onCreate ? () => sp.onCreate(this) : null);
    },
    // 1-line aliases — index.html references these by name
    openAreaPicker(node, at) { this.openPicker('area', node, at); },
    openGoalPicker(node, at) { this.openPicker('goal', node, at); },
    refreshAreaPicker() { this.refreshPicker('area'); },
    refreshGoalPicker() { this.refreshPicker('goal'); },
    pickArea(id) { this.pickPill('area', id); },
    pickGoal(id) { this.pickPill('goal', id); },
    areaPickerKeydown(e) { return this.pickerKeydown('area', e); },
    goalPickerKeydown(e) { return this.pickerKeydown('goal', e); },
    // Position a "@"/"^" autocomplete under its trigger char. rAF (not $nextTick): Alpine applies the :style left async — measure after paint.
    _positionPicker(p, sel) {
      if (!p.node) return;
      const body = this.$refs.content.closest('.composer-body'); if (!body) return;
      const r = document.createRange();
      r.setStart(p.node, Math.min(p.at, p.node.textContent.length)); r.collapse(true);
      const rect = r.getBoundingClientRect(), base = body.getBoundingClientRect();
      p.left = rect.left - base.left; p.top = rect.bottom - base.top + 4;
      requestAnimationFrame(() => this.clampX(document.querySelector(sel)));
    },
    // Re-derive the trigger position/fragment as the user types; close when the trigger char is gone.
    _refreshPicker(p, char, sel) {
      if (!p.open || !p.node) return;
      const txt = p.node.textContent || '', idx = txt.lastIndexOf(char);
      if (idx < 0) { p.open = false; return; }
      p.at = idx; p.frag = txt.slice(idx + 1); p.sel = 0;
      this._positionPicker(p, sel);
    },
    async createAreaFromPicker() {
      const id = await this.ensureAreaId(this.areaPicker.frag);   // reuse-or-create by name → id
      if (id) this.pickArea(id);
    },
    goalMatches() {
      const q = this.goalPicker.frag.toLowerCase();
      return this.goals.filter(g => !g.archived && (!q || g.name.toLowerCase().includes(q)));
    },
    _pickerKeydown(e, p, matches, onPick, onCreate, { allowNone = false } = {}) {
      if (e.key === 'Escape') { if (!p.open) return false; p.open = false; if (allowNone) p.sel = -1; return true; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { p.sel = Math.min(p.sel + 1, Math.max(0, matches.length - 1)); return true; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { p.sel = Math.max(p.sel - 1, 0); return true; }
      if ((e.key === 'Enter' || e.key === ' ') && matches.length) { onPick(matches[p.sel] || matches[0]); return true; }
      if (e.key === 'Enter' && onCreate) return onCreate();
      return false;
    },
    // Pill-editor keydown shared by the title + every subtask row: pickers, @/^ triggers, and space→pill.
    // Returns true when fully consumed (pickers / trigger chars); Enter is left to the caller (submit vs commit-row).
    _pillKeydown(e) {
      if (this.goalPicker.open && this.goalPickerKeydown(e)) { e.preventDefault(); e.stopPropagation(); return true; }
      if (this.areaPicker.open && this.areaPickerKeydown(e)) { e.preventDefault(); e.stopPropagation(); return true; }
      if (e.key === '^') { this.$nextTick(() => { const s = getSelection(); if (!s || !s.anchorNode) return; let node = s.anchorNode; if (node.nodeType !== 3) { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.includes('^')) { node = n; break; } } } const at = (node.textContent || '').lastIndexOf('^'); if (at >= 0) this.openGoalPicker(node, at); }); return true; }
      if (e.key === '@') { this.$nextTick(() => { const s = getSelection(); const at = (s?.anchorNode?.textContent || '').lastIndexOf('@'); if (s && s.anchorNode && at >= 0) this.openAreaPicker(s.anchorNode, at); }); return true; }
      if (e.key === ' ') { if (!this._noPillOnce && this.pillifyTrailing()) e.preventDefault(); this._noPillOnce = false; }
      else if (e.key.length === 1) { this._noPillOnce = false; }   // typing fresh content re-enables space→pill (Backspace/Delete → onEditorBeforeInput)
      return false;
    },
    editorKeydown(e) {
      if (this._pillKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this.submitComposer(); return; }
      // ArrowDown ladder: the title is a single line, so down is free to mean "next field".
      if (e.key === 'ArrowDown' && !e.shiftKey) { const d = this.$refs.desc; if (d) { e.preventDefault(); d.focus(); this._setCaret(d, 0); } }
    },
    async submitComposer() {
      if (!this.draft.content.trim()) return;   // contenteditable has no `required`; block empty titles
      if (this.chkGhost.trim()) this.commitChkGhost();   // save in-progress ghost inputs on Save, even without Enter
      if (this.subGhost.trim()) await this.commitSubGhost();   // journals its own "Added subtask" entry
      this.draft.checklist = this.draft.checklist.filter(c => (c.text || '').trim());   // prune whitespace-only items (transient while editing)
      if (!this.editing) {
        const fields = this.draftFields();
        if (!fields.project && !fields.parent_id && !this.store.defaultProject()) {
          this.projRequired = true;
          setTimeout(() => { this.projRequired = false; }, 800);
          return;
        }
      }
      if (this.editing) {
        // Capture before close (closeComposer resets draft/editing async via _growClose callback)
        const editId = this.editing, fields = this.draftFields(), draft = this.draft;
        this._clearPending(editId);   // saved → discard the pending draft so it can't resurrect over the save
        const sc = this._listScroller(), stBefore = sc ? sc.scrollTop : 0;
        // A save is ALWAYS slow enough to warrant feedback (composer collapse + reloadAll dominate; the store write
        // itself is quick, so the only-if-slow 150ms gate never tripped). Spin the checkmark IMMEDIATELY and let it
        // span the whole save — the post-save morph re-renders the row (clearing it) exactly when the saved data shows.
        this._setCheckPending(editId, true);
        // revealId = editId: fires in the done callback AFTER the 240ms animation + applyEditDom so _rowOffscreen
        // sees settled layout. revealGuard = stBefore: skips the reveal if the user scrolled > 300px during save.
        this.closeComposer(true, editId, false, stBefore);
        let updated;
        await this._journalRowChange('Saved task', 'task', editId, async () => {
          updated = await this.store.tasks.update(editId, fields);
          if (updated) {
            // A completed task whose checklist now has an undone item must reopen (e.g. you just added one).
            const cl = updated.checklist || [];
            if (updated.completed_at && cl.length && !cl.every(c => c.done)) { await this.store.tasks.setCompleted(updated.id, false); updated = this._rowById('task', updated.id); }
          }
        });
        if (!updated) {
          // Save failed — reopen the composer with the user's unsaved edits so nothing is silently lost.
          this._setCheckPending(editId, false);   // drop the spinner; the composer takes over again
          this.editing = editId; this.draft = draft;
          this._editDescs = new Set(descendantIds(this.tasks, editId).slice(1));
          this.openComposer();
          this.toast('Save failed — try again');
        } else {
          // No scroll-hold: native scroll-anchoring keeps the list put. Spinner + flash are cosmetic; they go on as
          // soon as the store write is confirmed (the reveal above, keyed to the animation, lands at ~241ms).
          this.$nextTick(() => { this._setCheckPending(editId, false); this._flashSaved(editId); });
        }
        return;
      }
      const newRow = await this.addTask();
      // reveal the just-added row (it lands just above the composer) ONLY if it's off-screen — an already-visible
      // new row leaves scroll untouched, so the view never jumps to the top on a rapid successive add.
      this.$nextTick(() => { this.setEditorText(''); this.$refs.content?.focus(); if (newRow) this._revealRow(newRow.id); });
    },
    // Ctrl/Cmd+Enter: submit then close (submitComposer keeps a NEW task's composer open for rapid add).
    async submitAndClose() { await this.submitComposer(); if (!this.projRequired) this.closeComposer(); },
    onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      // ⌘/Ctrl+Z → NATIVE text undo owns edits whenever focus is in a real field (input/textarea/contenteditable);
      // the app undo stack only takes over outside fields (list-level actions: complete, delete, move…).
      const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        if (inField) return;   // let the browser's native text undo/redo run
        if (this.composer.open) return;   // in-composer edits use native undo / draft autosave, not the journal
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();   // ⌘⇧Z = redo
        return;
      }
      // ⌘/Ctrl+Enter saves & closes the open composer from ANYWHERE — no input focus needed.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.composer.open) { e.preventDefault(); this.submitAndClose(); return; }
      // ⌘/Ctrl+K opens the everything-nav palette from anywhere, even mid-typing (Space does it outside typing).
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.openPalette(); return; }
      // Single-key shortcuts — only when not typing, composing, or in the palette, and unmodified.
      if (e.metaKey || e.ctrlKey || e.altKey || this.composer.open || this.palette.open
          || tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (this.overview) {   // the overview deck owns the keys while it's open
        if (this.ovSel === 0 && ['ArrowDown', 'j'].includes(e.key)) { e.preventDefault(); return this.rollerMove(1); }
        if (this.ovSel === 0 && ['ArrowUp', 'k'].includes(e.key))   { e.preventDefault(); return this.rollerMove(-1); }
        if (['ArrowRight', 'l'].includes(e.key)) { e.preventDefault(); this.ovMove(1); }
        else if (['ArrowLeft', 'h'].includes(e.key)) { e.preventDefault(); this.ovMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.ovSel === 0 ? this.rollerOpen() : this.diveTo(this.surfaceOrder[this.ovSel]); }
        else if (e.key >= '1' && e.key <= '4') { e.preventDefault(); this.diveTo(this.surfaceOrder[(+e.key) - 1]); }
        else if (e.key === 'o') { e.preventDefault(); this.closeOverview(); }
        return;
      }
      if (e.key === 'q') { e.preventDefault(); if (this.surface !== 'lists') this.setNav('all'); this.startAdd(); }   // opens inline on Lists; other surfaces (incl. Now, which has no list of its own) bounce to Lists first
      else if (e.key === 'b') { e.preventDefault(); this.trashOpen = true; }   // Bin (Recently Deleted) — recover anything
      else if (e.key === 'g') { e.preventDefault(); this.setNav('backlog'); }
      else if (e.key === 'a') { e.preventDefault(); this.setNav('all'); }
      // d / w / m switch the calendar's view, Plan-only — the same letters as the on-screen switcher, so the
      // keys teach themselves. `d` is free for this because the Bin moved to `b`.
      else if (this.surface === 'plan' && 'dwm'.includes(e.key)) { e.preventDefault(); this.clSetView({ d: 'day', w: 'week', m: 'month' }[e.key]); }
      // Plan has no list of rows to walk, so ↑/↓ drive the timeline itself — and by a UNIT you can name (an
      // hour, a week row), never a raw pixel nudge, so you always land somewhere you can read off the gutter.
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.surface === 'plan') {
        e.preventDefault(); const dir = e.key === 'ArrowDown' ? 1 : -1;
        // Shift travels a whole period and MORPHS, like a view switch: a deliberate jump should read as
        // movement. The plain arrows stay instant — they fire constantly, and motion §1 says don't animate those.
        e.shiftKey ? this.clStep(dir, true) : this.clArrow(dir, e.repeat);
      }
      else if (e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); this.selExtend(1); }   // Shift+↑/↓ extends the multi-select
      else if (e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); this.selExtend(-1); }
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); this.moveFocus(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); this.moveFocus(-1); }
      else if ((e.key === 'Enter' || e.key === 'e') && this.focusId) { e.preventDefault(); this.openFocused(); }
      else if (e.key === 'x' && this.focusId) { e.preventDefault(); this.toggleFocused(); }   // complete focused row (Space now opens the palette)
      else if (e.key === '?') { e.preventDefault(); this.shortcutsOpen = true; }
      else if (e.key === '/' && this.listView()) { e.preventDefault(); this.listSearchOpen = true; this.$nextTick(() => this.$refs.listSearch?.focus()); }   // Hearthsay: / → search unfolds
      else if (e.key === 'f' && this.listView()) { e.preventDefault(); this.listMenu = this.listMenu === 'add' ? null : 'add'; }   // f → filter sentence menu
      else if (e.key >= '1' && e.key <= '4') { e.preventDefault(); this.goSurface(this.surfaceOrder[(+e.key) - 1]); }   // jump to a surface
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.goSurface(this.surfaceOrder[Math.max(0, this.surfaceIndex() - 1)]); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.goSurface(this.surfaceOrder[Math.min(this.surfaceOrder.length - 1, this.surfaceIndex() + 1)]); }
      else if (e.key === ' ') { e.preventDefault(); this.openPalette(); }   // Space → the everything-nav palette
      else if (e.key === 'o') { e.preventDefault(); this.openOverview(); }   // o → zoom-out overview deck
    },
    escape() {
      // Anything that can stack ON TOP of the overview (dialogs, the roller ⋯ popover) closes first; the overview closes only when nothing is layered above it.
      if (this.shortcutsOpen) this.shortcutsOpen = false;
      else if (this.trashOpen) this.trashOpen = false;
      else if (this.palette.open) this.palette.open = false;
      else if (this.confirm) this.confirmNo();
      else if (this.goalOffer) this.goalOffer = null;           // pure close — no auto-decline/recommit/release; deliberate choices live only behind the dialog's explicit buttons
      else if (this.delAsk) { this.delAsk = null; }
      else if (this.locMgr) this.locMgr = false;
      else if (this.filterEdit) this.filterEdit = null;
      else if (this.eventEdit) this.eventEdit = null;
      else if (this.blockEdit) this.blockEdit = null;
      else if (this.settingsOpen) this.settingsOpen = false;   // corner settings popup — own light backdrop, below the dialogs
      else if (this.navPop) this.navPop = null;
      else if (this.listMenu) this.listMenu = null;   // Hearthsay sentence menus (add/sort)
      else if (this.navRename) this.navRename = null;
      else if (this.logWhenOpen) this.logWhenOpen = null;
      else if (this.identMenuId) this.identMenuId = null;
      else if (this.tpop) this.tpop = false;
      else if (this.endPicking) this.endPicking = false;
      else if (this.pop) this.pop = null;
      else if (this.selMenu) this.selMenu = null;       // an open edit-bar sub-menu closes before the selection itself
      else if (this.sel.length) this.clearSel();        // active multi-select clears (before the lower list states)
      else if (this.overview) this.overview = false;
      else if (this.composer.open) this.closeComposer();
      else if (this.goalOpenId) this.closeGoal();
      else if (this.goalDetailId) this.closeGoalDetail();
      else if (this.nowFocusId) this.nowBack();
      else if (this.focusId) this._setKbFocus(null);
    },

    fmt(ts) {
      if (!ts) return '';
      const dateOnly = ts.length <= 10, d = new Date(dateOnly ? ts + 'T00:00' : ts);
      return dateOnly ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                      : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    },
    fmtTime(hhmm) {
      if (!hhmm) return hhmm;
      const [h, m] = hhmm.split(':').map(Number);
      const h12 = h % 12 || 12;
      return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm');
    },
    today() { return new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }); },

    async loadTasks() { this.tasks = await this.store.tasks.list(); this.byId = new Map(this.tasks.map(t => [t.id, t])); this.parentIds = new Set(this.tasks.map(t => t.parent_id).filter(Boolean)); this._rowV++; _calDataV++; _goalStepsMemo.clear(); _goalMilestonesMemo.clear(); await this.loadStats(); },
    async loadStats() {
      const acts = await this.store.activity.list(), nowIso = new Date().toISOString();
      this._activityCache = acts;
      _activityV++; _goalLogMemo.clear(); _goalLastActiveMemo.clear(); _recentMemo.clear(); _identVotesMemo.clear();
      const prevStats = this.goalStats;
      this.goalStats = Object.fromEntries(this.goals.filter(g => !g.archived).map(g => [g.id, { ...goalProgress(acts, g, nowIso), ...goalWarmth(acts, g, nowIso) }]));
      // Ambient home read (hearth band): mean warmth of lit goals + a 14-day "any goal showed up" rhythm —
      // both derived from goalStats (already replayed from the activity cache above), not rescanned per tick.
      this.homeW = homeWarmth(Object.values(this.goalStats));
      this.homeDots = Array.from({ length: 14 }, (_, i) => Object.values(this.goalStats).some(s => s.marks?.[i]));
      // Ignition beat: kindling just caught (unlit/undefined → kindling) — mirrors the pulseGoal idiom.
      for (const id in this.goalStats) {
        const prevStage = prevStats[id]?.stage, stage = this.goalStats[id].stage;
        if (stage === 'kindling' && !['kindling', 'burning', 'sustaining'].includes(prevStage)) {
          this.flashGoal('ignitingGoal', '_ignitingT', id, 950);
        }
      }
    },
    async loadAreas() { this.areas = await this.store.areas.list(); this._rowV++; },
    // --- Goals (state + CRUD wiring; consumed by goals UI tasks) ---
    async loadIdentities() { this.identities = await this.store.identities.list(); },
    async loadGoals() {
      const fresh = await this.store.goals.list();
      this.goals.splice(0, this.goals.length, ...fresh); this._rowV++; await this.loadIdentities();
    },
    goalById(id) { return this.goals.find(g => g.id === id); },
    areaById(id) { return this.areas.find(a => a.id === id); },
    goalGlyph(g) { return g?.icon && !g.icon.startsWith('i-') ? g.icon : ''; },   // emoji icon → render as text; symbol ids/none fall back to the SVG
    identityById(id) { return this.identities.find(i => i.id === id); },
    identityStatement(g) { return this.identityById(g?.identity_id)?.statement ?? g?.identity ?? null; },
    identitySuggestions() {
      const q = (this.goalDraft?._identityBlank || '').trim().toLowerCase();
      if (!q) return [];
      return this.identities
        .map(i => ({ id: i.id, text: this.stripIdent(i.statement) }))
        .filter(({ text }) => { const t = text.toLowerCase(); return t.includes(q) && t !== q; })
        .slice(0, 5);
    },
    stripIdent(s) { return (s || '').replace(IDENTITY_WHO_RE, ''); },
    pickIdentitySuggestion(text) { this.goalDraft._identityBlank = text; this.identSug.sel = -1; },
    identSugKeydown(e) {
      const sugs = this.identitySuggestions();
      if (this._pickerKeydown(e, this.identSug, sugs, s => this.pickIdentitySuggestion(s.text), null, { allowNone: true })) {
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.key === 'Escape') this.closeGoal();
    },
    goalDueLabel(date) { if (!date) return ''; const d = Math.round((new Date(date) - new Date()) / 864e5); return d === 0 ? 'today' : d > 0 ? 'in ' + d + 'd' : Math.abs(d) + 'd ago'; },
    plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); },
    // Effective goals for a task: own goal_ids ∪ every ancestor's, walked via byId (cycle-safe), mapped to objects.
    goalsForTask(t) { return effectiveGoalIds(this.tasks, t.id, this.byId).map(id => this.goalById(id)).filter(Boolean); },
    toggleGoal(id) { const a = this.draft.goal_ids, i = a.indexOf(id); i >= 0 ? a.splice(i, 1) : a.push(id); },
    toast(msg) { return this.notify(msg); },   // thin wrapper: a plain message with no actions
    // Push a card onto the bottom-right stack. With action buttons it lingers longer (8s) so the Undo is reachable.
    notify(msg, { actions = [], timeout = actions.length ? 8000 : 4000 } = {}) {
      const id = crypto.randomUUID();
      this.notifs.push({ id, msg, actions, leaving: false });
      if (this.notifs.length > 3) this._dismissNotif(this.notifs[0].id);   // cap the visible stack
      setTimeout(() => this._dismissNotif(id), timeout);
      return id;
    },
    _dismissNotif(id) {
      const n = this.notifs.find(x => x.id === id); if (!n || n.leaving) return;
      n.leaving = true;                                                    // triggers the exit transition
      setTimeout(() => { this.notifs = this.notifs.filter(x => x.id !== id); }, 260);
    },
    _runNotifAction(n, a) { a.fn(); this._dismissNotif(n.id); },           // action fires, then the card leaves
    // ── Composer draft safety ──────────────────────────────────────────────────────────────────
    // Nothing typed is ever lost to a mispress: the whole draft is persisted (adherod.draftPending,
    // keyed by editing id or 'new') on EVERY change while the composer is open (x-effect → persistDraft).
    // Closing a dirty+unsaved draft KEEPS it (persisted) + makes it ⌘Z-undoable; reopening restores it.
    _pendingMap() { try { return JSON.parse(localStorage.getItem('adherod.draftPending')) || {}; } catch { return {}; } },
    _writePending(map) { localStorage.setItem('adherod.draftPending', JSON.stringify(map)); },
    _clearPending(key) { const m = this._pendingMap(); if (key in m) { delete m[key]; this._writePending(m); } },
    _draftKey() { return this.editing || 'new'; },
    // The full composer input state — draft fields PLUS the uncommitted ghost buffers. This is the unit of
    // loss-protection: everything the user has typed, committed or not. Reading it also subscribes the
    // x-effect to all three, so persistDraft re-fires when you type in a ghost box (not just the draft).
    _draftSig() { return JSON.stringify({ draft: this.draft, chkGhost: this.chkGhost, subGhost: this.subGhost }); },
    // x-effect on the composer: _draftSig() touches every draft field + both ghost buffers so Alpine re-runs this on any edit.
    persistDraft() {
      const s = this._draftSig(); void this.editing;   // subscribe to draft + ghost buffers + editing
      // open flips to false only in the async grow-close callback, so guard the whole close window here —
      // otherwise a save/close that just cleared the pending gets it re-written by this effect mid-animation.
      if (!this.composer.open || this._closingComposer) return;
      const map = this._pendingMap(), key = this._draftKey();
      if (s !== this._draftBase) map[key] = { editing: this.editing, draft: this.draft, chkGhost: this.chkGhost, subGhost: this.subGhost, ts: Date.now() };
      else if (key in map) delete map[key]; else return;   // clean draft → drop any stale pending; nothing to write otherwise
      this._writePending(map);
    },
    // Called from startAdd/editTask AFTER the pristine draft is built: record the baseline, then restore a
    // newer unsaved draft for this key if one exists (and it actually differs from the pristine state).
    _initDraftSafety() {
      this._draftBase = this._draftSig();
      const p = this._pendingMap()[this._draftKey()];
      if (p && JSON.stringify({ draft: p.draft, chkGhost: p.chkGhost || '', subGhost: p.subGhost || '' }) !== this._draftBase) {
        this.draft = p.draft; this.chkGhost = p.chkGhost || ''; this.subGhost = p.subGhost || ''; this.draftRestored = true;
        // A restored ghost buffer auto-fills via x-model; put the caret back at its end so typing resumes in place.
        this.$nextTick(() => {
          if (!this.composer.open) return;
          const kind = this.chkGhost ? 'chk' : this.subGhost ? 'sub' : null; if (!kind) return;
          const el = document.querySelector(`.composer-entries .entry${kind === 'sub' ? ':not(.chk)' : '.chk'}.ghost .entry-txt`);
          if (el) { el.focus(); if (el.isContentEditable) this._setCaret(el, el.textContent.length); else { const n = el.value.length; el.setSelectionRange(n, n); } }   // subtask ghost is contenteditable now
        });
      } else this.draftRestored = false;
    },
    // Banner "Discard": drop the recovered draft, revert to the saved/pristine state (composer stays open).
    discardDraft() {
      this._clearPending(this._draftKey());
      this.draftRestored = false;
      this.draft = JSON.parse(this._draftBase).draft; this.chkGhost = ''; this.subGhost = '';
      this.setEditorText(this.draft.content); this.setDescText(this.draft.notes);
      this.$nextTick(() => this.syncChkRows());
    },
    // ── Recently deleted (persistent trash bin) ────────────────────────────────────────────────
    // A VIEW over the journal (trashView, recovery.js): any bin:true, unrestored entry ≤30d old.
    // Restore applies the entry's inverse out-of-band and detaches it so linear ⌘Z can't re-touch it.
    trashItems() { void this._jV; return trashView(this.journal, Date.now()); },   // reactive on _jV
    _taskSubtreeRows(id) { return descendantIds(this.tasks, id).map(x => this.byId.get(x)).filter(Boolean).map(t => JSON.parse(JSON.stringify(t))); },   // task + all descendants, for trash
    trashRelTime(ts) {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return 'just now'; const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60); if (h < 24) return h + 'h ago'; const d = Math.round(h / 24);
      return d === 1 ? 'yesterday' : d + 'd ago';
    },
    // Bulk multi-select entry (≥2 ops, all one kind). isDel: the journal stores a delete as its reinsert inverse.
    _bulkOps(e) {
      const ops = e.op?.ops;
      if (!ops || ops.length < 2 || !ops.every(o => o.kind === ops[0].kind)) return null;
      return { ops, isDel: ops[0].kind === 'reinsert' };
    },
    trashIcon(e) {
      const b = this._bulkOps(e);   // a bulk CHANGE reads as an edit; a bulk delete keeps the trash glyph
      if (b && !b.isDel) return 'i-edit';
      return { task: 'i-circle', 'checklist-item': 'i-check', project: 'i-hash', area: 'i-tag-tag', goal: 'i-target', event: 'i-cal', block: 'i-cal', filter: 'i-search', location: 'i-pin', draft: 'i-edit' }[e.target] || 'i-trash';
    },
    // Read-only preview for a bin row: { title, detail (one key-detail line), lines: [{ sign, text }] }.
    // Diff colour rule: '-' = deleted content (red), '+' = a dropped draft that was being added (green). Lines cap at 4.
    trashPreview(e) {
      const MAX = 4, clip = (s, n = 72) => { s = (s ?? '').toString().replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
      const cap = (title, detail, lines) => {
        let out = lines.filter(l => l.text);
        if (out.length > MAX) { const more = out.length - (MAX - 1); out = out.slice(0, MAX - 1).concat({ sign: '', text: '… +' + more + ' more', more: true }); }
        // cls drives the diff colour: '+' add (green), '·' change (neutral), '' more (faint), else '-' del (red).
        out = out.map(l => ({ ...l, cls: l.more ? 'tdiff-more' : l.sign === '+' ? 'tdiff-add' : l.sign === '·' ? 'tdiff-chg' : 'tdiff-del' }));
        return { title: title || e.label || '(untitled)', detail, lines: out };
      };
      if (e.kind === 'draft') {   // a dropped composer draft → GREEN + lines (was being added)
        const d = e.payload?.draft || {}, ghost = (e.payload?.chkGhost || e.payload?.subGhost || '').trim();
        const title = clip(d.content) || ghost || 'Untitled draft';
        const items = (d.checklist || []).map(i => i.text).filter(t => (t || '').trim());
        const lines = [{ sign: '+', text: title }, ...items.map(t => ({ sign: '+', text: clip(t) }))];
        if (ghost && ghost !== title) lines.push({ sign: '+', text: clip(ghost) });
        return cap(title, 'Unsaved draft' + (items.length ? ' · ' + items.length + ' item' + (items.length > 1 ? 's' : '') : ''), lines);
      }
      if (e.kind === 'checklist-item') { const text = clip(e.payload?.item?.text); return cap(text, 'Checklist item', [{ sign: '-', text }]); }
      // Bulk multi-select change (≥2 ops, all one kind): show the COUNT + every affected item.
      // (Single-entity deletes model children re-parenting as mixed-kind ops, so they fall through to the row preview below.)
      const bulk = this._bulkOps(e);
      if (bulk) {
        const { ops, isDel } = bulk;
        const lines = ops.map(op => { const r = (op.rows && op.rows[0]) || this._rowById(op.target || 'task', op.id ?? op.fwd?.id) || {}; return { sign: isDel ? '-' : '·', text: clip(r.content ?? r.name ?? r.title) || '(untitled)' }; });
        const n = ops.length, tgt = e.op.target || 'task';
        return cap(isDel ? `${n} ${tgt}${n > 1 ? 's' : ''}` : e.label, isDel ? 'Deleted' : 'Changed', lines);
      }
      // every other bin entry is a deletion → RED − lines from the captured row(s)
      const rows = e.op?.rows || e.op?.ops?.[0]?.rows || [], root = rows[0] || {};
      const title = clip(root.content ?? root.name ?? root.title);
      const lines = [{ sign: '-', text: title }];
      let detail;
      if (e.target === 'task') {
        const subs = Math.max(0, rows.length - 1), bits = [];
        if (subs) bits.push(subs + ' subtask' + (subs > 1 ? 's' : ''));
        if (root.due_at) bits.push('due ' + this.fmt(root.due_at));
        detail = bits.join(' · ') || 'Task';
        for (const it of (root.checklist || [])) if ((it.text || '').trim()) lines.push({ sign: '-', text: clip(it.text) });
      } else detail = { project: 'Project', area: 'Area', goal: 'Goal', event: 'Event', block: 'Time block', filter: 'Filter', location: 'Location' }[e.target] || 'Item';
      if ((root.notes || '').trim()) lines.push({ sign: '-', text: clip(root.notes) });
      return cap(title, detail, lines);
    },
    // Append a journal entry: truncate any live redo tail, push (merging defaults), advance cursor, save.
    // callers read reactive deps before calling; pass only what differs from {id,ts,restored:false}.
    _journalPush(e) { this.journal.length = this.cursor; this.journal.push({ id: crypto.randomUUID(), ts: Date.now(), restored: false, ...e }); this.cursor = this.journal.length; this._journalSave(); },
    // A bin-only recoverable item with no invertible store op (checklist items live in the composer draft).
    // detached: never enters the linear ⌘Z timeline (you're composing when you delete one, and ⌘Z is gated off then).
    _pushBinItem(kind, label, payload) { this._journalPush({ label, target: kind, kind, op: null, payload, bin: true, detached: true }); },
    // A dropped-but-kept dirty composer draft → a bin row that is ALSO in the linear ⌘Z timeline (detached:false),
    // so ⌘Z or "Restore" reopens the composer with the draft. The pending autosave stays as the same-composer restore.
    _pushDraftBin(key, label) {
      const p = this._pendingMap()[key]; if (!p) return;
      this._journalPush({ label, target: 'draft', kind: 'draft', op: null, payload: { key, editing: p.editing, draft: p.draft, chkGhost: p.chkGhost, subGhost: p.subGhost }, bin: true, detached: false });
    },
    _reopenDraft(payload) {
      if (payload.editing && this.byId.get(payload.editing)) this.editTask(this.byId.get(payload.editing)); else this.startAdd();
      this.$nextTick(() => { this.draft = JSON.parse(JSON.stringify(payload.draft)); this.chkGhost = payload.chkGhost || ''; this.subGhost = payload.subGhost || ''; this.draftRestored = true; });
    },
    async restoreTrash(id) {
      const e = this.journal.find(x => x.id === id && x.bin && !x.restored);
      if (!e) return;
      if (e.kind === 'draft') { this._reopenDraft(e.payload); e.restored = true; e.detached = true; this._journalSave(); return; }
      if (e.kind === 'checklist-item') await this._restoreChecklistItem(e.payload);
      else e.op = await this._apply(e.op);
      e.restored = true; e.detached = true;
      this._journalSave(); await this.reloadAll();
      this.notify('Restored');
    },
    // A deleted checklist item goes back onto its (still-existing) task's stored checklist at its old index.
    async _restoreChecklistItem(payload) {
      const t = this.byId.get(payload.taskId); if (!t) return;
      const cl = (t.checklist || []).slice();
      if (cl.some(c => c.id === payload.item.id)) return;   // already there → idempotent
      cl.splice(Math.min(payload.index ?? cl.length, cl.length), 0, payload.item);
      await this.store.tasks.update(payload.taskId, { checklist: cl });
      if (this.editing === payload.taskId) this.draft.checklist = cl.slice().sort(byDone);
    },
    // ---- Inverse-op journal (recovery engine; ⌘Z/⌘⇧Z drive undo()/redo() below). ----
    _res(t) { return this.store[t + 's']; },                 // task→tasks, area→areas, goal→goals, event→events, block→blocks, filter→filters, location→locations
    _rowById(t, id) { return t === 'task' ? this.byId.get(id) : (this[t + 's'] || []).find(r => r.id === id); },
    _rowsForDelete(t, id) { return t === 'task' ? this._taskSubtreeRows(id) : [JSON.parse(JSON.stringify(this._rowById(t, id)))].filter(Boolean); },
    async _removeRow(t, id) {
      if (t !== 'task') return this._res(t).remove(id);
      const desc = descendantIds(this.tasks, id).slice().sort((a, b) => ancestorIds(this.tasks, b).length - ancestorIds(this.tasks, a).length); // deepest first
      for (const d of desc) await this.store.tasks.remove(d);
      return this.store.tasks.remove(id);
    },
    async _createRow(t, fields) { const r = this._res(t); return r.create ? r.create(fields) : r.add(fields); },

    _journalLoad() {
      try { const j = JSON.parse(localStorage.getItem('adherod.journal')); if (j) { this.journal = j.entries || []; this.cursor = j.cursor ?? this.journal.length; } } catch {}
      const p = pruneJournal(this.journal, this.cursor, Date.now()); this.journal = p.journal; this.cursor = p.cursor;
    },
    _journalSave() {
      const p = pruneJournal(this.journal, this.cursor, Date.now()); this.journal = p.journal; this.cursor = p.cursor;
      if (this.journal.length > JOURNAL_MAX) { const d = this.journal.length - JOURNAL_MAX; this.journal.splice(0, d); this.cursor = Math.max(0, this.cursor - d); }
      localStorage.setItem('adherod.journal', JSON.stringify({ entries: this.journal, cursor: this.cursor }));
      this._jV++;
    },

    // Diff helper for completion fx: which tasks' FX_FIELDS changed and which activity rows were added.
    _fxDiff(tasks, before, actList, beforeAct) {
      return {
        changed: tasks.filter(t => before.has(t.id) && JSON.stringify(before.get(t.id)) !== JSON.stringify(FX_FIELDS(t))).map(t => ({ id: t.id, before: before.get(t.id) })),
        addedActivity: actList.filter(a => !beforeAct.has(a.id)).map(a => a.id),
      };
    },
    // Run `mutate` (setCompleted / move), capturing which tasks' completed_at (and recurring fields) changed and which
    // 'complete' activity rows were added — so the inverse can restore every affected row, not just the primary target.
    async _captureCompletionFx(mutate) {
      const before = new Map(this.tasks.map(t => [t.id, FX_FIELDS(t)]));
      const beforeAct = new Set((await this.store.activity.list()).map(a => a.id));
      await mutate();
      await this.reloadAll();
      return this._fxDiff(this.tasks, before, await this.store.activity.list(), beforeAct);
    },
    // Reverse a captured completion delta: reopen every changed row + drop every added 'complete' activity row.
    async _reverseFx(fx) {
      for (const c of (fx?.changed || [])) await this.store.tasks.update(c.id, c.before);
      for (const aid of (fx?.addedActivity || [])) await this.store.activity.remove(aid);
    },

    // Applies one op, returns the op that reverses it. The reverse is what gets applied on the opposite action (undo↔redo toggle).
    async _apply(op) {
      if (op.kind === 'composite') { const invs = []; for (const o of op.ops) invs.push(await this._apply(o)); return { kind: 'composite', target: op.target, ops: invs.reverse() }; }
      if (op.kind === 'remove') {
        const rows = op.rows || this._rowsForDelete(op.target, op.id);
        await this._removeRow(op.target, op.id);
        return { kind: 'reinsert', target: op.target, id: op.id, rows };
      }
      if (op.kind === 'reinsert') {
        await this._reverseFx(op.fx);   // reopen any auto-completed parents captured when this task was deleted
        await this.store.reinsert(op.target, op.rows);
        return { kind: 'remove', target: op.target, id: op.id ?? op.rows[0]?.id, rows: op.rows };
      }
      if (op.kind === 'update') {
        const cur = this._rowById(op.target, op.id) || {};
        const before = {}; for (const k in op.after) before[k] = JSON.parse(JSON.stringify(cur[k] ?? null));
        const fields = op.was ? guardedFields(op.after, cur, op.was) : op.after;   // guard on reversal, full-apply on forward
        await this._res(op.target).update(op.id, fields);
        const nowRow = this._rowById(op.target, op.id) || {};
        return { kind: 'update', target: op.target, id: op.id, after: before, was: op.after, base: nowRow.updated_at };
      }
      if (op.kind === 'move') {
        const cur = this._rowById('task', op.id) || {};
        const before = { parent: cur.parent_id ?? null, pos: cur.position };
        const fx = await this._captureCompletionFx(() => this.store.tasks.move(op.id, op.after.parent, op.after.pos));   // capture any auto-completed old parent
        await this._reverseFx(op.fx);   // reversal side: reopen the parent this move originally auto-completed
        return { kind: 'move', target: 'task', id: op.id, after: before, was: op.after, fx };
      }
      if (op.kind === 'complete') {
        // Forward: (re)run setCompleted, capturing the full completion delta so the reverse can undo the whole sweep, not just the target.
        if (op.mode === 'forward') {
          const fx = await this._captureCompletionFx(() => this.store.tasks.setCompleted(op.fwd.id, op.fwd.done));
          return { kind: 'complete', target: 'task', mode: 'reverse', fwd: op.fwd, fx };
        }
        // Reverse: reopen every swept/target row + drop every phantom 'complete' activity row this completion added.
        await this._reverseFx(op.fx);
        return { kind: 'complete', target: 'task', mode: 'forward', fwd: op.fwd };
      }
    },

    _pushEntry(label, entryOp, { bin = false, silent = false } = {}) {
      this._journalPush({ label, target: entryOp.target, kind: entryOp.kind, op: entryOp, bin: !!bin });
      // silent = frequent actions (completion) that shouldn't toast on every press (emil: don't notify 100×/day).
      // The full per-action notify policy is finalized in the T7 notification-stack pass.
      if (!silent) this.notify(label, { actions: [{ label: 'Undo', fn: () => this.undo() }] });
    },
    // Applies one forward op, returns its inverse (the entry op) — the delete/create half of perform's op vocabulary.
    async _performOne(op) {
      if (op.kind === 'delete') {
        const rows = op.rows || this._rowsForDelete(op.target, op.id);
        if (op.target === 'task') {
          // Capture before state now; perform()'s own reloadAll() flushes the store, then finalizes fx — single reload, no race.
          const before = new Map(this.tasks.map(t => [t.id, FX_FIELDS(t)]));
          const beforeAct = new Set((await this.store.activity.list()).map(a => a.id));
          await this._removeRow(op.target, op.id);
          return { kind: 'reinsert', target: op.target, id: op.id, rows, _fxCapture: { before, beforeAct } };
        }
        await this._removeRow(op.target, op.id);
        return { kind: 'reinsert', target: op.target, id: op.id, rows };
      }
      if (op.kind === 'create') { const row = await this._createRow(op.target, op.fields); return { kind: 'remove', target: op.target, id: row.id, rows: this._rowsForDelete(op.target, row.id) }; }
      return this._apply(op);   // update / move
    },
    // Wrap ANY in-place mutation of one saved row: run it, diff before/after, journal only what changed.
    // Use for edits/archive/complete/etc. — no need to pre-list changed fields.
    async _journalRowChange(label, target, id, mutate, { bin = false, silent = false } = {}) {
      const before = JSON.parse(JSON.stringify(this._rowById(target, id) || {}));
      await mutate();
      await this.reloadAll();
      const after = this._rowById(target, id) || {};
      const rollback = {}, forward = {};
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { rollback[k] = before[k] ?? null; forward[k] = after[k] ?? null; }
      if (Object.keys(rollback).length) this._pushEntry(label, { kind: 'update', target, id, after: rollback, was: forward }, { bin, silent });
    },
    // Perform a user mutation and record how to reverse it. op.kind ∈ {delete, create, update, move, composite}.
    async perform(label, op, { bin } = {}) {
      let entryOp;
      if (op.kind === 'composite') { const invs = []; for (const o of op.ops) invs.push(await this._performOne(o)); entryOp = { kind: 'composite', target: op.target ?? 'task', ops: invs.reverse() }; }
      else { entryOp = await this._performOne(op); if (op.kind === 'delete' && bin === undefined) bin = true; }
      await this.reloadAll();
      // Finalize deferred fx for task deletes (captured before the delete; compared after this reloadAll so no double reload).
      if (entryOp?._fxCapture) {
        const { before, beforeAct } = entryOp._fxCapture; delete entryOp._fxCapture;
        entryOp.fx = this._fxDiff(this.tasks, before, await this.store.activity.list(), beforeAct);
      }
      this._pushEntry(label, entryOp, { bin: !!bin });
    },
    // Shared undo/redo body; dir=-1 = undo, dir=1 = redo. Draft branch is asymmetric: undo reopens, redo skips.
    async _journalStep(dir) {
      if (dir < 0) { while (this.cursor > 0 && this.journal[this.cursor - 1].detached) this.cursor--; if (this.cursor <= 0) return; }
      else { while (this.cursor < this.journal.length && this.journal[this.cursor].detached) this.cursor++; if (this.cursor >= this.journal.length) return; }
      const e = this.journal[this.cursor + Math.min(dir, 0)];
      if (e.kind === 'draft') { if (dir < 0) { this._reopenDraft(e.payload); e.restored = true; e.detached = true; } else this.cursor++; this._journalSave(); return; }
      e.op = await this._apply(e.op);
      if (e.bin) e.restored = dir < 0;   // undo: mark restored (bin row visible again); redo: unmark
      this.cursor += dir; this._journalSave(); await this.reloadAll();
      dir < 0 ? this.notify(e.label + ' undone', { actions: [{ label: 'Redo', fn: () => this.redo() }] }) : this.notify(e.label, { actions: [{ label: 'Undo', fn: () => this.undo() }] });
    },
    async undo() { await this._journalStep(-1); },
    async redo() { await this._journalStep(1); },

    // Last day (YYYY-MM-DD) the user showed up for a goal (direct show_up OR a laddered completion) — feeds the detail's "warmed today/Xd ago".
    goalLastActive(id) {
      void this._activityCache;   // touch the reactive dep on every call (even a cache hit) so bindings stay subscribed
      return _memo(_goalLastActiveMemo, id + '|' + _activityV, () => {
        let last = null;
        for (const a of (this._activityCache || [])) {
          if (a.void) continue;
          const isHit = (a.type === 'show_up' && a.subject_id === id) || (a.type === 'complete' && (a.ctx?.goal_ids || []).includes(id));
          if (isHit) { const d = isoDate(new Date(a.ts)); if (!last || d > last) last = d; }
        }
        return last;
      });
    },
    warmedLabel(id) {
      const last = this.goalLastActive(id);
      if (!last) return 'not lit yet';
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = Math.round((today - new Date(last + 'T00:00:00')) / 864e5);
      return days <= 0 ? 'warmed today' : days === 1 ? 'warmed yesterday' : `warmed ${days}d ago`;
    },
    stageLabel(stage) { return { unlit: 'Unlit', kindling: 'Kindling', burning: 'Burning', sustaining: 'Self-sustaining' }[stage] || 'Unlit'; },
    // Lane defs: tending always present (hosts "+ Light a new fire"); others only when non-empty.
    // Each goal copied with _w (laneComparator reads a._w/b._w) — never mutates reactive goals array.
    goalLaneDefs() {
      const acts = this._activityCache || [], now = new Date().toISOString();
      const lanes = { tending: [], sustaining: [], fizzled: [], shelved: [] };
      for (const g of this.goals.filter(x => !x.archived)) {
        const w = this.goalStats[g.id];
        lanes[goalLaneFull(acts, g, now, w)].push({ ...g, _w: w });
      }
      lanes.tending.sort(laneComparator);
      return [
        { key: 'tending', label: 'Tending now', goals: lanes.tending },
        { key: 'sustaining', label: 'Self-sustaining', goals: lanes.sustaining },
        { key: 'shelved', label: 'Shelved — on purpose', goals: lanes.shelved },
        { key: 'fizzled', label: 'Fizzled out', goals: lanes.fizzled },
      ].filter(l => l.key === 'tending' || l.goals.length);
    },
    // Fire-card subtitle: identity ("I am someone who moves every morning") rendered as "feeds the
    // person who moves every morning"; falls back to the cue when there's no identity yet.
    goalIdentitySubtitle(g) {
      const t = (this.identityStatement(g) || '').trim();
      if (!t) return g.cue || '';
      return 'feeds the person who ' + t.replace(IDENTITY_WHO_RE, '').replace(/^i\s+/i, '').replace(/\bmyself\b/gi, 'themselves').replace(/\bmy\b/gi, 'their');
    },
    // reuses the stage/warmed copy of the detail view; project: early = next milestone, late = goal/why.
    goalStatusLine(g) {
      if (g.shape === 'project') {
        const arc = this.goalArcStats(g.id);
        return arc.pct < ARC_LATE ? 'next: ' + (arc.next?.content || 'add a milestone') : 'nearly there — ' + (this.identityStatement(g) || g.name);
      }
      const s = this.goalStats[g.id] || {}; return this.stageLabel(s.stage) + ' · ' + this.warmedLabel(g.id);
    },
    // Block-level identity reflection (GR8) — "is this identity becoming true?", distinct from the
    // row-level goalStatusLine (stage · warmed-when). Mirror-not-doctor voice, by stage/warmth.
    identityReflection(w) {
      if (w.stage === 'sustaining') return 'This one holds itself now — the fire burns without your hands.';
      if (w.warmth >= 50) return 'Fed most days lately — this one is becoming true.';
      if (w.warmth >= 25) return 'Finding its rhythm — a little more feeds it.';
      return 'It flickered — one good day brings it back.';
    },
    // GR7: Identities view — per-entity groupings, position-sorted. Active feeders shown as rows;
    // votes counted from ALL feeders (incl. finished/archived) via activity cache so a fulfilled
    // identity accumulates its full evidence. finishedCount drives the "its fires became true" copy.
    identityGroups() {
      void this._activityCache;   // reactive dep: vote counting reads the cache
      const allByIdent = new Map(this.identities.map(i => [i.id, []]));
      for (const g of this.goals) { if (g.identity_id && allByIdent.has(g.identity_id)) allByIdent.get(g.identity_id).push(g); }
      return this.identities.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(ident => {
        const all = allByIdent.get(ident.id) || [];
        const activeGoals = all.filter(g => !g.archived);
        const finishedCount = all.filter(g => g.archived && g.finished_at).length;
        const stats = activeGoals.map(g => this.goalStats[g.id]).filter(Boolean);
        const agg = homeWarmth(stats);
        // Sustaining propagates: if ANY feeding goal is sustaining, so is the identity block.
        const stage = stats.some(s => s.stage === 'sustaining') ? 'sustaining' : this.aggStage(agg);
        // Count votes from ALL feeders (incl. archived) via activity cache, memoized on _activityV.
        const votes = _memo(_identVotesMemo, ident.id + '|' + _activityV, () => {
          const feederIds = new Set(all.map(g => g.id));
          return (this._activityCache || []).filter(a => !a.void && a.type === 'complete' && (a.ctx?.goal_ids || []).some(id => feederIds.has(id))).length;
        });
        const rows = activeGoals.map(g => {
          let note = null;
          for (const grp of this.goalLog(g.id)) { const row = grp.rows.find(r => r.icon === '✎'); if (row) { note = { text: row.text, day: grp.day }; break; } }
          return { g, w: this.goalStats[g.id] || {}, note };
        });
        return { ident, goals: rows, agg, stage, votes, finishedCount };
      });
    },
    // mirrors homeStage's thresholds
    aggStage(w) { return w <= HEARTH.ember ? 'unlit' : w >= 75 ? 'sustaining' : w >= 50 ? 'burning' : 'kindling'; },
    // Fizzled lane's quiet re-light: opens the editor so the user can reconsider the goal (cadence,
    // identity…) before recommitting — never a one-tap "undo the release", never a nag (mirror not doctor).
    relightGoal(id) { this.openGoal(id); },
    // Hearth band copy (informational read, never a grade/score/percentage) — null hides the band (empty state owns that view).
    homeBand() {
      const active = this.goals.filter(g => !g.archived);
      if (!active.length) return null;
      const title = this.homeW >= 75 ? 'The home is glowing' : this.homeW >= 50 ? "You're keeping the home warm"
        : this.homeW >= 25 ? 'The home is warming' : 'The hearth is quiet — one small log relights it';
      let fires = 0, sustaining = 0, onTrack = 0, target = 0;
      for (const g of active) {
        const s = this.goalStats[g.id]; if (!s) continue;
        if (s.stage === 'sustaining') { sustaining++; continue; }
        if (s.stage === 'kindling' || s.stage === 'burning') fires++;
        if (g.cadence?.times) { target += s.target; onTrack += Math.min(s.onTrack, s.target); }
      }
      const parts = [];
      if (fires) parts.push(this.plural(fires, 'fire') + ' burning');
      if (sustaining) parts.push(sustaining + ' self-sustaining');
      if (target) parts.push('shown up ' + onTrack + ' of ' + target + ' intended this week');
      return { title, sub: parts.join(' · ') };
    },
    setGoalsView(v) { this.goalsView = v; },
    homeStage() { return this.aggStage(this.homeW); },
    // 14-day ember strip: cold when nothing happened that day, mid/hot (by current home warmth) when it did.
    emberStripHtml() {
      const bucket = this.homeW >= 75 ? 'hot' : 'mid';
      return this.homeDots.map(on => `<span class="ember-dot e-${on ? bucket : 'cold'}"></span>`).join('');
    },
    // grouped by dayKey (not label) so distant same-weekday rows never merge
    goalLog(id) {
      void this._activityCache;   // touch the reactive dep on every call (even a cache hit) so bindings stay subscribed
      return _memo(_goalLogMemo, id + '|' + _activityV, () => {
        const rows = (this._activityCache || [])
          .filter(a => !a.void && (['show_up', 'graduate', 'note', 'release', 'shelve', 'unshelve', 'finish'].includes(a.type) ? a.subject_id === id : a.type === 'complete' && (a.ctx?.goal_ids || []).includes(id)))
          .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 30)
          .map(a => ({
            id: a.id,
            dayKey: isoDate(new Date(a.ts)),   // LOCAL calendar day — matches logDayLabel (local) + the local time shown; a UTC slice mislabels evening rows
            icon: a.type === 'show_up' ? '🔥' : a.type === 'graduate' ? '🏅' : a.type === 'note' ? '✎' : a.type === 'release' ? '🕊️' : a.type === 'shelve' ? '🧺' : a.type === 'unshelve' ? '🔥' : a.type === 'finish' ? '🏆' : '✓',
            text: a.type === 'show_up' ? (a.text || 'Logged a show-up') : a.type === 'graduate' ? 'Became self-sustaining'
              : a.type === 'note' ? a.text : a.type === 'release' ? 'Released — carried the heat'
              : a.type === 'shelve' ? 'Set down on purpose' : a.type === 'unshelve' ? 'Picked back up' : a.type === 'finish' ? 'The fire did its work'
              : `Completed "${this.byId.get(a.subject_id)?.content || 'a task'}"`,
            time: new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          }));
        return groupByDay(rows, d => logDayLabel(d));
      });
    },
    // memoized on _activityV (x-show + x-for both read it)
    recentContributions() {
      void this._activityCache;   // touch the reactive dep on every call (even a cache hit) so bindings stay subscribed
      return _memo(_recentMemo, _activityV, () => {
        const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
        const rows = [];
        for (const a of (this._activityCache || [])) {
          if (a.void || a.ts < cutoff) continue;
          if (a.type === 'show_up' || a.type === 'graduate') {
            const g = this.goalById(a.subject_id);
            if (!g) continue;
            rows.push({ id: a.id, ts: a.ts, dot: a.type === 'show_up' ? 'warm' : 'gold', html: a.type === 'show_up' ? `Logged <b>${escHtml(g.name)}</b>` : `<b>${escHtml(g.name)}</b> became self-sustaining 🏅` });
          } else if (a.type === 'complete') {
            const title = this.byId.get(a.subject_id)?.content;
            if (!title) continue;
            for (const gid of (a.ctx?.goal_ids || [])) {
              const g = this.goalById(gid);
              if (g) rows.push({ id: a.id + '|' + gid, ts: a.ts, dot: 'mid', html: `Completed <b>${escHtml(title)}</b> → ${escHtml(g.name)}` });
            }
          }
        }
        rows.sort((x, y) => y.ts.localeCompare(x.ts));
        return groupByDay(
          rows.slice(0, 20).map(({ id, ts, html, dot }) => { const d = new Date(ts); return { id, dayKey: isoDate(d), html, dot, time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }; }),
          d => logDayLabel(d)
        );
      });
    },
    async createGoal(name) { const g = await this.store.goals.create({ name: (name || '').trim() || 'New goal' }); await this.loadGoals(); return g; },
    async patchGoal(id, fields) { await this.store.goals.update(id, fields); await this.loadGoals(); },
    async archiveGoal(id, val) { await this.patchGoal(id, { archived: val }); },
    async deleteGoal(id) { await this.perform('Deleted goal', { target: 'goal', kind: 'delete', id }); },
    async addGoalNote(id, text) { if (!(text || '').trim()) return; await this.store.activity.note(id, text.trim()); await this.loadStats(); },
    async deleteLog(actId) { await this.store.activity.remove(actId); await this.loadStats(); },
    // Inline-expand edit, using the SAME measured-height grow as the task composer (open + close).
    openGoal(id, startH = 0) {
      const g = this.goalById(id);
      if (!g) return;
      this.identSug = { open: false, sel: -1 };   // reset before (re-)opening
      this.visited.goals = true;   // ensures the lazy-mounted goals surface is rendered
      this.goalDetailId = null;    // composer + detail are mutually exclusive
      this.goalOpenId = id;
      const identity = this.identityStatement(g) || '';
      this.goalDraft = { name: g.name || '', identity, _identityBlank: identity.replace(IDENTITY_WHO_RE, ''), cue: g.cue || '', log_default: g.log_default || '', targets: (g.targets || []).map(t => ({ ...t })), target_date: g.target_date || '', favorite: !!g.favorite, color: g.color || null, icon: g.icon || null, cadence: g.cadence || null, shape: g.shape || 'process', _colorPop: false };
      this._growOpen(() => document.querySelector('.goal-col.editing .composer-grow'), startH);   // start at the card's height, not 0
    },
    async closeGoal() {
      this.identSug = { open: false, sel: -1 };
      // FIX6: cancel on a never-touched new goal leaves nothing behind
      const d = this.goalDraft;
      if (this._newGoalId === this.goalOpenId && d && (!d.name.trim() || d.name.trim() === 'New goal') && !d._identityBlank?.trim() && !d.cue?.trim() && !d.log_default?.trim() && !d.cadence && !(d.targets || []).length) {
        await this.store.goals.remove(this._newGoalId); await this.loadGoals();
      }
      this._newGoalId = null;
      this._growClose(() => document.querySelector('.goal-col.editing .composer-grow'), 0, () => { this.goalOpenId = null; this.goalDraft = null; });
    },
    openGoalDetail(id, startH = 0) { this.visited.goals = true; this.goalOpenId = null; this.goalDraft = null; this.goalDetailId = id; this._growOpen(() => document.querySelector('.goal-col.detailing .composer-grow'), startH); },
    closeGoalDetail() { this._growClose(() => document.querySelector('.goal-col.detailing .composer-grow'), 0, () => { this.goalDetailId = null; }); },
    // fire animations paused off-screen via .fire-paused (not removed, so they resume mid-cycle);
    // SMIL ignores animation-play-state → svg.pauseAnimations() used instead
    initFireObserver() {
      if (this._fireIO) return;
      const root = this.$root;
      const syncSmil = f => { const svg = f.querySelector('svg.flame'); if (!svg) return;
        (f.classList.contains('fire-paused') || this.reduceMotion()) ? svg.pauseAnimations() : svg.unpauseAnimations(); };
      this._fireIO = new IntersectionObserver(es => es.forEach(e => { e.target.classList.toggle('fire-paused', !e.isIntersecting); syncSmil(e.target); }), { rootMargin: '200px' });
      const scan = () => root.querySelectorAll('.goal-card .fire, .identity-row .fire').forEach(f => { this._fireIO.observe(f); syncSmil(f); });
      scan();
      new MutationObserver(scan).observe(root, { childList: true, subtree: true });
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => root.querySelectorAll('.goal-card .fire, .identity-row .fire').forEach(syncSmil));
    },
    // grows from the detail's height so open feels continuous
    openGoalFromDetail(id) {
      const h = document.querySelector('.goal-col.detailing .composer-grow')?.offsetHeight || 0;
      this.goalDetailId = null;
      this.openGoal(id, h);
    },
    goalTasks(id) { return this.tasks.filter(t => !t.completed_at && !t.archived_at && this.goalsForTask(t).some(gg => gg.id === id)); },
    goalNextSteps(id) {
      void this.tasks;   // touch the reactive dep on every call (even a cache hit below) so x-show/x-html/count all stay subscribed to task changes
      return _memo(_goalStepsMemo, id + '|' + _calDataV, () => [...this.goalTasks(id)].sort((a, b) => (a.due_at || '\uffff').localeCompare(b.due_at || '\uffff') || impRank(a.importance) - impRank(b.importance)));
    },
    goalMilestones(id) {
      void this.tasks;
      return _memo(_goalMilestonesMemo, id + '|' + _calDataV, () => this.tasks.filter(t => t.milestone && this.goalsForTask(t).some(gg => gg.id === id)));
    },
    goalArcStats(id) { return goalArc(this.goalMilestones(id)); },
    goalArcMarks(id) { return this.goalArcStats(id).sorted.map(t => ({ done: !!t.completed_at })); },
    async submitGoal() {
      const id = this.goalOpenId, d = this.goalDraft;
      if (!id || !d) return;
      const blank = (d._identityBlank || '').trim();
      const statement = blank ? "I'm someone who " + blank : null;
      const ent = statement ? await this.store.identities.findOrCreate(statement) : null;
      await this.patchGoal(id, { name: d.name.trim() || 'New goal', identity_id: ent?.id ?? null, identity: statement ?? null, cue: d.cue.trim() || null, log_default: d.log_default?.trim() || null, targets: d.targets.filter(t => t.amount > 0), target_date: d.target_date || null, favorite: !!d.favorite, color: d.color || null, icon: d.icon || null, cadence: d.cadence || null, shape: d.shape || 'process' });
      await this.loadStats();
      this._newGoalId = null;   // FIX6: a real save is never a delete candidate
      this.closeGoal();
    },
    async newGoalComposer() {
      const g = await this.store.goals.create({ name: 'New goal' });
      this._newGoalId = g.id;
      await this.loadGoals();
      this.openGoal(g.id);
    },
    async renameIdentity(id, statement) {
      const st = (statement || '').trim();
      if (!st) return;
      await this.store.identities.update(id, { statement: st });
      await this.loadGoals();
    },
    mergeIdentityInto(fromId, toId) {
      this.identMenuId = null;
      const targetIdent = this.identities.find(i => i.id === toId);
      this.askConfirm({ message: 'Merge "' + (this.identities.find(i => i.id === fromId)?.statement || '').slice(0, 40) + '" into "' + (targetIdent?.statement || '').slice(0, 40) + '"? Its fires follow.', confirmLabel: 'Merge', onConfirm: async () => {
        await this.store.identities.merge(fromId, toId);
        await this.loadGoals();
        this.toast('Merged — its fires follow.');
      }});
    },
    releaseIdentity(id) {
      this.identMenuId = null;
      this.askConfirm({ message: "Release this identity? Its fires keep burning.", confirmLabel: 'Release', onConfirm: async () => {
        await this.store.identities.remove(id);
        await this.loadGoals();
      }});
    },
    async claimIdentity(statement) {
      await this.newGoalComposer();
      if (statement && this.goalDraft) this.goalDraft._identityBlank = (statement || '').replace(IDENTITY_WHO_RE, '');
    },
    // Shared transient flash: sets `this[prop] = id` for `ms`, guarding against a rapid re-flash
    // clearing early (clearTimeout before rearming). Used by pulseGoal, ignitingGoal, graduatingGoal.
    flashGoal(prop, timerProp, id, ms) {
      this[prop] = id;
      clearTimeout(this[timerProp]);
      this[timerProp] = setTimeout(() => { this[prop] = null; }, ms);
    },
    async _afterLog(id) { this.logWhenNote = ''; await this.loadStats(); this.flashGoal('pulseGoal', '_pulseT', id, 600); },
    // no note typed → default to the goal's log_default; a typed note may itself carry a
    // natural-language time ("read at 8pm yesterday") that backdates the show-up (nlp.js parseLogNote).
    async logGoal(id, note) {
      const raw = note != null ? note : this.logWhenNote;
      const { note: n, ts } = parseLogNote(raw, new Date(), this.goalById(id)?.log_default);
      await this.store.activity.showUp(id, ts, n);
      await this._afterLog(id);
    },
    // ~1h before now, clamped to midnight — crossing midnight would land in the future (OK disabled)
    _lwEarlierDefault(now) {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const anchor = new Date(now - 36e5);
      return hhmm(anchor < midnight ? midnight : anchor);
    },
    // HAZARD: logWhenOpen (not g.id) so the string is static — a reactive dep would re-inject and kill input caret mid-typing.
    logWhenHtml() {
      const lwr = (label, type, model, cls, which) => `<div class="lw-row flex items-center gap-8"><span class="lw-label grow">${label}</span><input type="${type}" class="inp ${cls}" x-model="${model}"><button type="button" class="lw-ok flex-none inline-flex items-center justify-center" :disabled="logWhenFuture('${which}')" @click="confirmLogWhen(logWhenOpen,'${which}')" title="Log at this time" aria-label="Confirm time"><svg class="ico"><use href="#i-check"/></svg></button></div>`;
      return '<div class="lw-row flex items-center gap-8 lw-note-row"><input class="inp lw-note" x-model="logWhenNote" placeholder="What did you do? (optional)"></div>' + lwr('Earlier today', 'time', 'logWhenT1', 'lw-time', 'earlier') + lwr('Yesterday', 'time', 'logWhenT2', 'lw-time', 'yesterday') + lwr('Pick date &amp; time', 'datetime-local', 'logWhenDT', 'lw-dt', 'pick');
    },
    toggleLogWhen(id) {
      if (this.logWhenOpen === id) { this.logWhenOpen = null; return; }
      const now = new Date();
      this.logWhenT1 = this._lwEarlierDefault(now);
      this.logWhenT2 = hhmm(now);                    // "yesterday" defaults to the same clock time
      this.logWhenDT = isoDate(now) + 'T' + hhmm(now);
      this.logWhenOpen = id;
      // Log chips sit at a card's right edge — clamp like every other popover so it never spills off-screen.
      this.$nextTick(() => {
        const open = [...document.querySelectorAll('.log-when-pop')].find(p => getComputedStyle(p).display !== 'none');
        if (open) this.clampX(open);
      });
    },
    _lwTimeOn(base, hhmmStr) {
      const [h, m] = (hhmmStr || '0:0').split(':').map(Number);
      return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h || 0, m || 0, 0, 0);
    },
    _lwDate(which, now = new Date()) {
      if (which === 'earlier') return this._lwTimeOn(now, this.logWhenT1);
      if (which === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); return this._lwTimeOn(y, this.logWhenT2); }
      return this.logWhenDT ? new Date(this.logWhenDT) : now;
    },
    // rejected, not clamped — no surprise time-shift
    logWhenFuture(which) { return this._lwDate(which) > new Date(); },
    async confirmLogWhen(id, which) {
      if (this.logWhenFuture(which)) return;   // guard holds even if called directly, bypassing the disabled button
      const ts = this._lwDate(which).toISOString();
      this.logWhenOpen = null;
      // the picker sets its OWN explicit ts — only the note defaults, never a note-embedded time.
      await this.store.activity.showUp(id, ts, this.logWhenNote.trim() || this.goalById(id)?.log_default?.trim() || null);
      await this._afterLog(id);
    },
    // Shared goal lifecycle spine: update fields → activity verb → reload → optional toast/flash.
    // Callers null their offer key synchronously (before any await) and keep call-site-only side effects.
    async _goalStep(id, fields, verb, msg, { flash } = {}) {
      await this.store.goals.update(id, fields);
      if (verb) await this.store.activity[verb](id);
      await this.loadGoals(); await this.loadStats();
      if (msg) this.toast(msg);
      if (flash) this.flashGoal(flash[0], flash[1], id, flash[2]);
    },
    // GS8 graduation: pull-based, never auto. Escape/backdrop unreachable (see escape()/closeDialogs()).
    openGraduateOffer(id) { this.goalOffer = { kind: 'graduate', id }; },
    async confirmGraduation() {
      const id = this.goalOffer?.id; if (!id) return;
      this.goalOffer = null;   // null synchronously, before any await — a second rapid tap must see it already gone
      const g = this.goalById(id);   // read name before the update
      await this._goalStep(id, { sustained_at: new Date().toISOString() }, 'graduate', null, { flash: ['graduatingGoal', '_graduatingT', 2050] });
      // Celebration starts once the reloads land, so the stage flip and .graduating begin together.
      this.toast('🏅 ' + (g?.name || 'This goal') + ' — self-sustaining. Carry the heat.');
    },
    async declineGraduation() {
      const id = this.goalOffer?.id; if (!id) return;
      this.goalOffer = null;
      await this._goalStep(id, { sustain_snoozed_until: new Date(Date.now() + 21 * 864e5).toISOString() }, null, null);
    },
    // Finish (HH8): the third good ending — offered when every project milestone is done.
    // goalFinishReady: cheap computed (goalMilestones is memoized) — never put in loadStats.
    goalFinishReady(id) { const g = this.goalById(id); return !!(g && finishReady(this.goalMilestones(id), g)); },
    identityPhrase(id) { return (id || '').trim().replace(/^i(?:'m| am)\s+/i, '') || null; },
    msBeatText(gid) {
      const g = this.goalById(gid); if (!g) return '';
      const phrase = this.identityPhrase(this.identityStatement(g));
      return phrase ? '→ a vote for ' + phrase : '→ toward "' + g.name + '"';
    },
    openFinishOffer(id) { this.goalOffer = { kind: 'finish', id }; },
    async confirmFinishing() {
      const id = this.goalOffer?.id; if (!id) return;
      this.goalOffer = null;   // null synchronously — rapid-tap guard
      await this._goalStep(id, { finished_at: new Date().toISOString() }, 'finish', 'Finished. Carry the heat — light something new.', { flash: ['graduatingGoal', '_graduatingT', 2050] });
      // reload-safe: finished_at is committed; archiving after the beat is cosmetic
      setTimeout(() => this.archiveGoal(id, true), 2100);
    },
    declineFinishing() { this.goalOffer = null; },
    // GS15: Recommit and Release are equal-weight — never framed as pass/fail
    openReflect(id) { this.visited.goals = true; this.goalOffer = { kind: 'reflect', id }; },
    activeGoalOffer() {
      const { kind, id } = this.goalOffer || {};
      const n = id => this.goalById(id)?.name || '';
      if (kind === 'graduate') return {
        cls: 'grad-dialog', head: 'Let it run on its own?',
        body: '”' + n(id) + '” has burned steadily for months. Mark it self-sustaining — it keeps its place and its warmth, and frees your energy for a new fire.',
        actions: [{ cls: 'ghost grad-decline', label: 'Keep tending', fn: () => this.declineGraduation() }, { cls: 'primary grad-confirm', label: 'Let it run', fn: () => this.confirmGraduation() }],
      };
      if (kind === 'finish') return {
        cls: 'finish-dialog', head: 'Let it rest, finished?',
        body: '”' + n(id) + '” — every milestone is done. Mark it finished — the heat carries to your next fire.',
        actions: [{ cls: 'ghost finish-decline', label: 'Keep going', fn: () => this.declineFinishing() }, { cls: 'primary finish-confirm', label: 'Finish it', fn: () => this.confirmFinishing() }],
      };
      if (kind === 'reflect') return {
        cls: 'reflect-dialog', head: 'Sit with this one?',
        body: '”' + n(id) + '” — fires change, and so do you. Recommit with a fresh shape, set it down on purpose for later, or release it and carry the heat to another fire. All are good endings.',
        actions: [
          { cls: 'ghost reflect-recommit', label: 'Recommit', fn: () => this.recommitGoal() },
          { cls: 'ghost reflect-shelve', label: 'Shelve', fn: () => { this.shelveGoal(this.goalOffer?.id); this.goalOffer = null; } },
          { cls: 'ghost reflect-release', label: 'Release', fn: () => this.releaseGoal() },
        ],
      };
      return null;
    },
    recommitGoal() {
      const id = this.goalOffer?.id; if (!id) return;
      this.goalOffer = null;
      this.openGoalFromDetail(id);   // reframing means editing cadence/why, same path as the detail's Edit button
    },
    async releaseGoal() {
      const id = this.goalOffer?.id; if (!id) return;
      this.goalOffer = null;
      const g = this.goalById(id);
      const first = firstShowUpDay(this._activityCache || [], id);
      const weeks = first ? Math.max(1, Math.floor((Date.now() - new Date(first + 'T00:00:00')) / (7 * 864e5))) : 0;
      await this.store.activity.release(id);
      this.archiveGoal(id, true);   // fire-and-forget, like the detail's own Archive button — closeGoalDetail's grow-close still finds the card mid-flight
      this.closeGoalDetail();
      const name = g?.name || 'this goal';
      this.toast(weeks > 0 ? `You tended “${name}” for ${this.plural(weeks, 'week')} — carry the heat.` : `Released “${name}” — carry the heat.`);
    },
    finishStepClick(ev, gid) {
      const ms = ev.target.closest('[data-act="milestone"]'); if (ms) { this.toggleMilestone(ms.dataset.tid); return; }
      const id = ev.target.closest('.task-line')?.dataset.tid; if (id) this.finishStep(id, gid);
    },
    async toggleMilestone(id) {
      const t = this.byId.get(id); if (!t) return;
      await this.store.tasks.update(id, { milestone: !t.milestone });
      await this.loadTasks();
    },
    async shelveGoal(id) {
      if (!id) return;
      await this._goalStep(id, { shelved_at: new Date().toISOString() }, 'shelve', 'Set down on purpose — the coals stay banked.');
      this.closeGoalDetail();   // must stay at call site
    },
    async unshelveGoal(id) {
      if (!id) return;
      await this._goalStep(id, { shelved_at: null }, 'unshelve', 'Picked back up — the fire returns.');
    },
    _milestoneBeat(gid) { this.flashGoal('pulseGoal', '_pulseT', gid, 1200); this.flashGoal('msBeatGid', '_msBeatT', gid, 1400); },
    async finishStep(taskId, gid) {
      const beat = () => {
        const t = this.byId.get(taskId);
        if (t?.milestone) this._milestoneBeat(gid);
        else this.flashGoal('pulseGoal', '_pulseT', gid, 600);
      };
      if (await this.confirmSweep(taskId, beat)) return;
      await this.applyComplete(taskId, true);
      beat();
    },
    warmthBand(w) { const v = w ?? 8; return v >= HEARTH.thriving ? 'thriving' : v >= 50 ? 'warm' : v >= 25 ? 'warming' : 'ember'; },
    fireHTML: FIRE_INNER,   // stage lives on the wrapping .fire's class, not per-instance
    // re-click active chip clears it (null = daily)
    toggleCadence(per, times) { const c = this.goalDraft.cadence; this.goalDraft.cadence = (c && c.per === per && c.times === times) ? null : { per, times }; },
    cadenceLabel(c) { if (!c || !c.times) return ''; const perWeek = c.per === 'day' ? c.times * 7 : c.times; return perWeek >= 7 ? 'Daily' : perWeek + '×/week'; },
    marksLabel(id, inline) {
      const s = this.goalStats[id] || {}, base = (s.onTrack ?? 0) + ' / ' + (s.target ?? 0) + ' this week';
      const cad = inline && this.cadenceLabel(this.goalById(id)?.cadence);
      return cad ? base + ' · ' + cad : base;
    },
    customCadenceTimes() { const c = this.goalDraft?.cadence; return (c && c.per === 'week') ? c.times : 3; },
    isCustomCadence() { const c = this.goalDraft?.cadence; return !!c && !(c.per === 'day' && c.times === 1) && !(c.per === 'week' && [1, 5].includes(c.times)); },
    stepCustomCadence(d) { this.goalDraft.cadence = { per: 'week', times: Math.min(7, Math.max(1, this.customCadenceTimes() + d)) }; },
    async loadFilters() { this.filters = await this.store.filters.list(); this._rowV++; },   // a filter's query drives the filter view's rows — invalidate the visibleRows memo
    async loadLocations() {
      this.locations = await this.store.locations.list();
      this.travel = await this.store.travel.list();
      this.homeLocationId = this.store.homeLocationId();
      this.currentRegion = this.store.currentRegion();
    },
    isHomeLocation(id) { return this.homeLocationId === id; },
    async setHomeLocation(id) { await this.store.setHomeLocation(id); await this.loadLocations(); },   // toggles home in the store; loadLocations refreshes the reactive mirror
    // NLP name list: real place names + a synthetic "home" alias (unless a place is literally named "home") so "at home" resolves.
    locNames() { const n = this.locations.map(l => l.name); if (this.homeLocationId && this.locations.some(l => l.id === this.homeLocationId) && !n.some(x => x.toLowerCase() === 'home')) n.push('home'); return n; },
    locByName(nm) { const low = String(nm).toLowerCase(); return this.locations.find(x => x.name.toLowerCase() === low) || (low === 'home' && this.homeLocationId ? this.locations.find(x => x.id === this.homeLocationId) : null) || null; },
    async addLocation(name, region) { if (!name?.trim()) return; await this.store.locations.add({ name: name.trim(), region: region || this.currentRegion }); await this.loadLocations(); },
    async patchLocation(id, fields) { await this.store.locations.update(id, fields); await this.loadLocations(); },
    async deleteLocation(id) { await this.perform('Deleted location', { target: 'location', kind: 'delete', id }); },
    async addTravelPair() {
      const { from, to, min } = this.travelPair;
      if (!from || !to || from === to) return;
      await this.store.travel.set(from, to, Number(min) || 20);
      this.travelPair = { from: '', to: '', min: 20 };
      await this.loadLocations();
    },
    async removeTravelPair(from, to) { await this.store.travel.remove(from, to); await this.loadLocations(); },
    locName(id) { const l = this.locations.find(x => x.id === id); return l ? l.name : id; },
    // Row badge: first pinned location's name (+N when several), '' when the task isn't location-scoped or names aren't loaded.
    rowLoc(t) {
      const L = t.location; if (!L || L.mode === 'any' || !(L.ids || []).length) return '';
      const l = this.locations.find(x => x.id === L.ids[0]); if (!l) return '';
      return L.ids.length > 1 ? `${l.name} +${L.ids.length - 1}` : l.name;
    },
    // --- location hybrid picker (sentence polarity + here-row + region chip rows) ---
    locNew: null, locExpanded: [], locOrder: {},
    openLoc(anchor) {
      this.togglePop('loc', anchor);
      if (this.pop !== 'loc') return;
      this.locNew = null; this.locExpanded = [];
      // Freeze chip order for this open: selected-first AT OPEN. Toggling must never reorder mid-interaction —
      // keyed DOM moves while the fill transition runs left stale orange/checkmarks, and jumping chips break spatial stability.
      const sel = new Set(this.draft.location?.ids || []);
      this.locOrder = {};
      for (const region of this.regions()) {
        const locs = this.locations.filter(l => (l.region || 'Home') === region);
        this.locOrder[region] = [...locs.filter(l => sel.has(l.id)), ...locs.filter(l => !sel.has(l.id))].map(l => l.id);
      }
    },
    // 'any' (no places picked) | 'only' | 'except' — empty set IS anywhere; "any" is not a mode you pick
    locPolarity() { const L = this.draft.location; return !L || !(L.ids || []).length ? 'any' : (L.mode === 'except' ? 'except' : 'only'); },
    toggleLocPolarity() {
      const L = this.draft.location; if (this.locPolarity() === 'any') return;
      this.draft.location = { mode: L.mode === 'except' ? 'only' : 'except', ids: [...L.ids] };
    },
    // "here" = the CURRENT BLOCK's location — the app's only location source for now (tracker precedence lands later)
    hereLocationId() {
      const now = new Date(), iso = isoDate(now);
      const prev = isoDate(new Date(now.getTime() - 864e5));   // a block active now may have started yesterday (spans midnight)
      const inst = blocksInRange(this.blocks || [], prev, iso).find(i => i.location_id && new Date(i.start) <= now && now < new Date(i.end));
      return inst?.location_id ?? null;
    },
    // Region rows: order frozen at open (see openLoc) — toggles flip the flag, never the position.
    // Ghosts cap at 5 per region; a selected chip can never be hidden by the cap.
    locRegionRows() {
      const CAP = 5, hereId = this.hereLocationId(), sel = new Set(this.draft.location?.ids || []);
      const byId = new Map(this.locations.map(l => [l.id, l]));
      return this.regions().map(region => {
        const snap = this.locOrder[region] || [];
        const extras = this.locations.filter(l => (l.region || 'Home') === region && !snap.includes(l.id)).map(l => l.id);   // created after open
        const ordered = [...snap, ...extras].map(id => byId.get(id)).filter(l => l && (l.region || 'Home') === region && l.id !== hereId);
        const open = this.locExpanded.includes(region);
        let visible = open ? ordered : ordered.slice(0, CAP);
        if (!open) visible = [...visible, ...ordered.slice(CAP).filter(l => sel.has(l.id))];
        return { region, chips: visible.map(l => ({ id: l.id, name: l.name, sel: sel.has(l.id) })), more: ordered.length - visible.length, open };
      });
    },
    // Chip visual state straight from the draft (object syntax = idempotent toggles): the x-for item's
    // `sel` snapshot can lag a rapid toggle — never bind selection visuals to it.
    locChipCls(id) {
      const on = !!this.draft.location?.ids?.includes(id);
      return { sel: on && this.draft.location.mode !== 'except', selx: on && this.draft.location.mode === 'except', ghosty: !on };
    },
    locExpandRegion(r) { this.locExpanded = this.locExpanded.includes(r) ? this.locExpanded.filter(x => x !== r) : [...this.locExpanded, r]; },
    async createPlaceInline(region, name) {
      this.locNew = null;
      if (!name?.trim()) return;
      await this.addLocation(name.trim(), region);
      const l = this.locations.find(x => x.name === name.trim() && (x.region || 'Home') === region);
      if (l) this.toggleLocId(l.id);   // created from the picker = you meant it → selected
    },
    locChipLabel() {
      const L = this.draft.location;
      if (!L || !(L.ids || []).length) return 'Location';
      const names = L.ids.map(id => this.locName(id));
      const list = names.length > 2 ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2) : names.join(' or ');
      return (L.mode === 'except' ? 'away from ' : 'at ') + list;
    },
    openLocManager() { this.pop = null; this.locMgr = true; this.loadLocations(); },
    toggleLocId(id) { const ids = new Set(this.draft.location?.ids || []); ids.has(id) ? ids.delete(id) : ids.add(id); this.draft.location = { mode: this.draft.location?.mode || 'only', ids: [...ids] }; },
    regions() { return [...new Set(this.locations.map(l => l.region || 'Home'))]; },
    // Manager grouping (string model): regions in use + any just-created empty ones.
    displayRegions() { return [...new Set([...this.locations.map(l => l.region || 'Home'), ...this.pendingRegions])]; },
    locationsIn(r) { return this.locations.filter(l => (l.region || 'Home') === r); },
    addRegion(name) { name = name?.trim(); if (name && !this.displayRegions().includes(name)) this.pendingRegions.push(name); },
    async moveToRegion(r) { const id = this.dragLocId; this.dragLocId = this.dragOverRegion = null; if (id) await this.patchLocation(id, { region: r }); },
    async renameRegion(oldName, newName) {
      newName = newName?.trim(); if (!newName || newName === oldName) return;
      const pi = this.pendingRegions.indexOf(oldName); if (pi >= 0) this.pendingRegions[pi] = newName;
      await Promise.all(this.locationsIn(oldName).map(l => this.store.locations.update(l.id, { region: newName })));
      await this.loadLocations();
    },

    // --- Saved filters ---
    activeFilter() { return this.navSel.type === 'filter' ? this.filters.find(f => f.id === this.navSel.id) : null; },
    isFilterQuery(q) { return /(^|\s)(#|@|due:|deadline:|importance:|is:|in:)|[&|!()]/i.test((q || '').trim()); },
    saveQueryAsFilter() {
      const q = (this.palette.q || '').trim(); if (!q || !this.isFilterQuery(q)) return;
      this.palette.open = false; this.openFilterEditor({ name: q, query: q });
    },
    // clone-on-open so textarea edits don't mutate the saved object live
    openFilterEditor(filter = null) {
      this.filterEdit = filter ? { ...filter } : { name: '', query: '', color: null };
      this.navPop = null;
      this.$nextTick(() => this.$refs.filterName?.focus());
    },
    async saveFilter() {
      const f = this.filterEdit; if (!f || !(f.name || '').trim()) return;
      const fields = { name: f.name.trim(), query: f.query || '', color: f.color ?? null };
      if (f.id) await this.store.filters.update(f.id, fields);
      else { const created = await this.store.filters.add(fields); if (created) { await this.loadFilters(); this.filterEdit = null; this.setNav('filter', created.id); return; } }
      await this.loadFilters();
      this.filterEdit = null;
    },
    async deleteFilter() {
      const id = this.filterEdit?.id; this.filterEdit = null;
      if (!id) return;
      if (this.navSel.type === 'filter' && this.navSel.id === id) this.setNav('backlog');
      await this.perform('Deleted filter', { target: 'filter', kind: 'delete', id });
    },
    filterMatches() { return this.filterEdit ? this.store.runFilter(this.filterEdit.query).map(id => this.byId.get(id)).filter(Boolean) : []; },
    filterMatchCount() { return this.filterMatches().length; },

    async addTask() {
      const fields = this.draftFields();
      const row = await this.store.tasks.create(fields);
      if (!row) return;
      // Position at end of siblings so new task appears just above the composer (bottom of its group).
      const siblings = this.tasks.filter(t => t.parent_id === (row.parent_id ?? null) && t.id !== row.id);
      if (siblings.length) {
        const maxPos = Math.max(...siblings.map(t => t.position ?? 0));
        await this.store.tasks.update(row.id, { position: maxPos + 1 });
        row.position = maxPos + 1;
      }
      this.tasks.push(row); if (row.parent_id) this.parentIds.add(row.parent_id);   // keep hasChildren truthful until loadTasks rebuilds
      await this.loadTasks();
      await this.loadAreas();
      this._clearPending('new');   // saved → the recovered-draft slot is spent
      this.resetDraft();
      this._draftBase = this._draftSig();   // next rapid-add starts clean
      this.draftRestored = false;
      return row;
    },

    childTasks(id) { return this.tasks.filter(t => t.parent_id === id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
    addChecklistItem(text) { if (!text.trim()) return; this.draft.checklist.unshift({ id: crypto.randomUUID(), text: text.trim(), done: false }); this.sortChecklist(); },   // new items land at the TOP of the open bucket
    // The composer keeps the array open-first/done-last (stable) so the array order == the visual order (drag indices map 1:1).
    sortChecklist() { this.draft.checklist.sort(byDone); },
    // Uncheckable: the checklist renders as a plain notes list (no boxes, no done styling) everywhere
    chkPlain() { return !!this.editingTask()?.checklist_plain; },
    async toggleChecklistPlain() { const t = this.editingTask(); if (t && await this.store.tasks.update(t.id, { checklist_plain: !t.checklist_plain })) await this.loadTasks(); },
    toggleChecklistItem(item) { item.done = !item.done; this.sortChecklist(); },   // toggling done moves the item to the done bucket
    removeChecklistItem(item) { const i = this.draft.checklist.indexOf(item); if (i >= 0) this.draft.checklist.splice(i, 1); if ((item.text || '').trim()) this._pushBinItem('checklist-item', item.text, { taskId: this.editing, index: i, item }); },
    // Backspace on an empty checklist row deletes it and lands the caret on the neighboring entry.
    chkBackspace(item, e) {
      if (e.target.textContent !== '') return;
      e.preventDefault();
      this.moveEntryFocus(e.target, -1) || this.moveEntryFocus(e.target, 1);
      this.removeChecklistItem(item);
    },
    renameChecklistItem(item, text) { text = text.trim(); if (text) item.text = text; },
    // checklist rows are plain, page-selectable text until you click into one — so a vertical drag makes a
    // normal document selection that SPANS rows (a per-row contenteditable would trap the drag in one row, killing
    // cross-item select+copy). Click (no drag) enters edit mode with the caret where clicked; a drag keeps the
    // multi-row selection intact for chkCopy. Keyboard focus paths still edit via the row's @focus handler.
    chkRowDown(e) { this._chkDownAt = { x: e.clientX, y: e.clientY }; this._chkPointer = true; },
    chkRowUp(el, e) {
      const d = this._chkDownAt; this._chkDownAt = null; this._chkPointer = false;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;   // a drag-select → keep the selection, don't edit
      if (el.contentEditable === 'true') return;   // already editing (2nd click of dblclick) — let browser word-select natively
      el.contentEditable = 'true'; el.focus();
      const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);      // caret at the click point (best-effort)
      if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    },
    // Rows are tabbable (tabindex=0) so keyboard Tab reaches the item title — but a MOUSE press must NOT enter edit
    // mode on focus (that would trap a cross-row drag-select in one contenteditable). _chkPointer marks the mouse path;
    // chkRowUp then decides click-to-edit vs drag. Keyboard focus (no pointer) falls through and enables editing.
    // auto-grow the ghost textarea to fit its wrapped content (field-sizing isn't universally implemented)
    // hidden → scrollHeight 0: keep auto, else the ghost re-shows 0px tall (unclickable)
    taGrow(el) { if (!el) return; el.style.height = 'auto'; if (el.scrollHeight) el.style.height = el.scrollHeight + 'px'; },
    chkFocus(el) {
      if (this._chkPointer) return;   // mouse path: chkRowUp decides click-to-edit vs drag
      el.contentEditable = 'true';
      // A div that becomes editable while already focused has NO caret inside it, so keystrokes do nothing —
      // place a collapsed caret at the end so keyboard Tab-in is immediately typable.
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    },
    // Enter → sibling item below · Shift+Enter → newline INSIDE the item (execCommand drops '\n' in this
    // WebView — splice like descKeydown) · ⌘/Ctrl+Enter → save & close the composer.
    chkEnter(e, item) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) return this.submitAndClose();
      if (!e.shiftKey) return this.insertChkAfter(item);
      const el = e.target, off = this._caretOffset(el); if (off == null) return;
      // at the very end, a LONE trailing \n collapses the caret back before it — double it so the caret
      // lands on a real empty line (the extra \n is trimmed away by renameChecklistItem on blur)
      const text = el.textContent, nt = text.slice(0, off) + '\n' + text.slice(off) + (off === text.length ? '\n' : '');
      item.text = nt;
      el.innerHTML = chkLiveRender(nt);
      this._setCaret(el, off + 1);
    },
    // Ghost enter: Shift+Enter falls through to the textarea's native newline; plain Enter commits.
    ghostEnter(e, kind) { if (e.shiftKey) return; e.preventDefault(); if (e.metaKey || e.ctrlKey) this.submitAndClose(); else this.commitGhostStay(kind); },
    // Enter on a checklist row inserts a new empty OPEN item just below it and focuses it. A new open item can't
    // live in the done bucket, so a row Entered from the done bucket lands at the end of the open bucket (the stable re-sort pulls it up).
    insertChkAfter(item) {
      const it = { id: crypto.randomUUID(), text: '', done: false };
      this.draft.checklist.splice(this.draft.checklist.indexOf(item) + 1, 0, it);
      this.sortChecklist();
      this.$nextTick(() => { const el = document.querySelector(`.composer-entries .entry.chk[data-id="${it.id}"] .entry-txt`); if (el) { el.contentEditable = 'true'; el.focus(); } });   // rows are editable-on-demand: make editable before focusing
    },
    // --- Subtask rows are pill editors too: the SAME title engine, aimed via _nlpFocus at the focused row. ---
    // On focus, point the engine at this row and rebuild its sub-draft from the pills already in its DOM (the
    // DOM is the record — survives blur→picker-click→re-focus). c = the child row; null = the "new subtask" ghost.
    focusSubEditor(el, c) {
      _nlpFocus = { el, draft: this.subDraft, ghost: !c, c };
      this._resetSubDraft();               // fresh scratch (also refreshes _nlpFocus.draft)
      this._recommitPills(PILL_KINDS);      // fields ← pills in this editor
      this.syncTitle();                     // content ← text nodes (+ mirrors subGhost for the ghost)
    },
    focusTitle() { _nlpFocus = null; },     // title regains the default target when it (re)gains focus
    // The ghost editor carries no x-model — mirror the (kept/restored) subGhost text into its DOM when it's idle
    // (x-effect on the row: re-runs when subGhost changes, but never clobbers what the user is actively typing).
    subGhostSync(el) { if (document.activeElement !== el && (el.textContent || '') !== (this.subGhost || '')) el.textContent = this.subGhost || ''; },
    subGhostHtml() { return '<span class="check sm ghost-check"></span><div class="entry-txt sub-ce" role="textbox" tabindex="0" contenteditable="true" data-placeholder="New subtask" x-effect="subGhostSync($el)" @focus="focusSubEditor($el, null)" @input="subInput()" @beforeinput="onEditorBeforeInput($event)" @keydown="entryKey($event); subEditorKeydown($event, null)" @keydown.escape="entryEscape($event)" @paste="onPaste($event)" @keydown.stop></div>'; },
    _resetSubDraft() { this.subDraft = emptyDraft(); if (_nlpFocus) _nlpFocus.draft = this.subDraft; },
    _clearEditor(el) { if (el) el.textContent = ''; },
    subInput() { this.syncTitle(); this.refreshAreaPicker(); this.refreshGoalPicker(); },
    subEditorKeydown(e, c) {
      if (this._pillKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); c ? this.commitChildEdit(c, true) : this.commitGhostStay('sub'); }
    },
    // A sub-draft → child task fields. A subtask's parent is the editing task (not a project); it has no checklist of its own.
    _subFields(d) { const f = this.draftFields(d); delete f.project; delete f.project_id; delete f.checklist; f.parent_id = this.editing; return f; },
    async commitSubGhost() {
      const el = document.querySelector('.composer-entries .entry.ghost:not(.chk) .entry-txt');
      // Rebuild the sub-draft from the ghost's DOM — covers Save-flush, where focus may never have entered the row.
      if (el) { _nlpFocus = { el, draft: this.subDraft, ghost: true }; this._resetSubDraft(); this._recommitPills(PILL_KINDS); this.syncTitle(); }
      const fields = this._subFields(this.subDraft);   // content trimmed + importance-word flush live in draftFields
      this.subGhost = '';
      if (this.editing && fields.content) {
        const task = await this.addSubtask(this.editing, fields);   // create-with-fields; position-at-top + reopen-parent
        if (task) this._pushEntry('Added subtask', { kind: 'remove', target: 'task', id: task.id, rows: this._rowsForDelete('task', task.id) });
      }
      this._clearEditor(el); this._resetSubDraft(); _nlpFocus = null;
    },
    // Fill an existing child row's editor with its content text + a pill per stored field (inverse of the parser).
    // Fields come from the pills, exactly like the title: a throwaway draft during the build gives each pill a correct
    // pre-chip `prior` snapshot (empty→accumulate) so backspace-revert works; the row's live draft is rebuilt on focus.
    hydrateSubEditor(el, c) {
      const prev = _nlpFocus;
      _nlpFocus = { el, draft: emptyDraft(), c };
      el.textContent = '';
      if (c.content) el.appendChild(document.createTextNode(c.content));
      const add = (kind, value) => { el.appendChild(this.makePill(kind, value, '')); this.commitPill(kind, value); };
      const min = c.est_minutes || 0;
      if (c.importance && c.importance !== 'none') add('imp', c.importance);
      if (c.due_at) add('date', { iso: c.due_at.slice(0, 10), time: timeOf(c.due_at), from: c.available_from || null });
      if (c.deadline_at) add('deadline', { iso: (c.deadline_at || '').slice(0, 10) });
      if (c.recurrence) add('rec', c.recurrence);
      if (min) add('dur', min);
      for (const a of (c.area_ids || [])) add('area', a);
      for (const g of (c.goal_ids || [])) add('goal', g);
      if (c.location && c.location.mode !== 'any') { const nm = this.locations.find(l => l.id === c.location.ids?.[0])?.name; if (nm) add('loc', (c.location.mode === 'except' ? 'away from ' : '') + nm); }
      _nlpFocus = prev;
    },
    // x-init runs once; Alpine reuses keyed x-for rows across reloads → refresh each idle child editor's pills from the store.
    syncSubRows() {
      if (!this.editing) return;
      document.querySelectorAll('.composer-entries .entry[data-id] .entry-txt.sub-ce').forEach(el => {
        if (document.activeElement === el) return;
        const c = this.byId.get(el.closest('.entry')?.dataset.id);
        if (c) this.hydrateSubEditor(el, c);
      });
    },
    // Only the child-owned fields — used to compare edited vs stored so an unchanged blur writes nothing (guarded, no-op write).
    _sameChildFields(a, b) {
      return ['content', 'notes', 'importance', 'due_at', 'available_from', 'deadline_at', 'est_minutes', 'recurrence', 'location', 'area_ids', 'goal_ids']
        .every(k => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
    },
    // Commit an edited child row: rebuild its sub-draft from the row's pills, and update the child if anything changed.
    // Skips while a picker is mid-selection (blur fires before the pick lands — the pick refocuses + a later blur commits).
    async commitChildEdit(c, advance = false) {
      if (this.areaPicker.open || this.goalPicker.open) return;
      const el = document.querySelector('.composer-entries .entry[data-id="' + c.id + '"] .entry-txt.sub-ce');
      if (el) this.focusSubEditor(el, c);            // rebuild subDraft from this row's DOM (idempotent)
      const fields = this._subFields(this.subDraft);
      _nlpFocus = null;
      if (advance && el) this.focusEntryGhost(el);   // Enter → hop to the "new subtask" ghost, mirroring the old flow
      if (!fields.content) { this.syncSubRows(); return; }   // emptied → revert to stored (never blank the task's title)
      if (this._sameChildFields(fields, this._subFields(this.taskToDraft(c)))) return;
      if (await this.store.tasks.update(c.id, fields)) { await this.loadTasks(); this.$nextTick(() => this.syncSubRows()); }
    },
    commitChkGhost() { const v = this.chkGhost.trim(); this.chkGhost = ''; if (v) this.addChecklistItem(v); },
    // Commit the ghost, then keep the caret on it for fast successive entry (survives the empty→list template swap).
    async commitGhostStay(kind) {
      if (kind === 'sub') await this.commitSubGhost(); else this.commitChkGhost();
      this.$nextTick(() => document.querySelector(`.composer-entries .entry${kind === 'sub' ? ':not(.chk)' : '.chk'}.ghost .entry-txt`)?.focus());
    },
    // Up/Down hop editing focus to the prev/next entry row, but only when the caret is already at the text boundary.
    // Handles both <input> (subtask/ghost) and the checklist item's contenteditable (live "::" editor).
    entryKey(e) {
      const el = e.target, ce = el.isContentEditable;
      const len = ce ? el.textContent.length : el.value.length, off = ce ? this._caretOffset(el) : el.selectionStart;
      const collapsed = ce ? getSelection()?.isCollapsed : el.selectionStart === el.selectionEnd;
      if (e.key === 'ArrowUp' && collapsed && off === 0) { if (this.moveEntryFocus(el, -1) || this._focusUp(this.$refs.desc)) e.preventDefault(); }
      else if (e.key === 'ArrowDown' && collapsed && off === len) { if (this.moveEntryFocus(el, 1)) e.preventDefault(); }
    },
    // VISUAL order (ghost → open bucket → done bucket) — sort by on-screen top so the CSS-ordered ghost-on-top
    // layout is respected regardless of DOM order.
    _entryFields(list) { return [...list.querySelectorAll('.entry-txt')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top); },
    // Up-ladder rung (entries → description → title), mirroring the ArrowDown ones. Caret lands at the END —
    // you're arriving from below, where the down-ladder lands it at 0.
    _focusUp(el) { if (!el) return false; el.focus(); this._setCaret(el, el.textContent.length); return true; },
    _focusEntry(next) {
      if (!next) return false;
      if (next.tagName === 'DIV') next.contentEditable = 'true';   // checklist row: editable-on-demand, make editable before focus
      next.focus();
      if (next.isContentEditable) this._setCaret(next, next.textContent.length);
      else { const n = next.value.length; next.setSelectionRange?.(n, n); }
      return true;
    },
    // Escape in an entry field: revert the edit and step out to the composer. An EMPTY field has nothing to
    // revert and nothing to step back to, so it skips straight to closing (these fields @keydown.stop, so the
    // window handler never sees it).
    entryEscape(e, revert) {
      const el = e.target;
      if (!(el.value ?? el.textContent).trim()) return this.escape();
      revert?.(); el.blur();
    },
    moveEntryFocus(el, dir) {
      const list = el.closest('.entry-list'); if (!list) return false;
      const fields = this._entryFields(list);
      return this._focusEntry(fields[fields.indexOf(el) + dir]);
    },
    // Bottom rung of the ArrowDown ladder (title → description → entries). Only a REAL entry list is a target —
    // the empty-state ghosts aren't "items that exist", so down from an empty composer stays put.
    focusFirstEntry() {
      const list = document.querySelector('.composer-entries .entry-list');
      return !!list && this._focusEntry(this._entryFields(list)[0]);
    },
    // Enter on a subtask row: commit (blur → rename) and jump to the ghost "new subtask" prompt.
    focusEntryGhost(input) { input.closest('.entry-list')?.querySelector('.entry.ghost .entry-txt')?.focus(); },
    // defer-to-blur when markdown is present: skip innerHTML rewrite so ⌘Z is preserved.
    // Pure "::" text (no markdown) still rewrites live so the separator shows while typing.
    chkInput(item, e) {
      if (e.isComposing) return;
      const el = e.target, text = el.textContent;
      item.text = text;
      if (/[*_~`<&]/.test(text)) return;   // markdown present → skip rewrite, blur will decorate
      const off = this._caretOffset(el), html = chkLiveRender(text);
      if (el.innerHTML !== html) { el.innerHTML = html; this._setCaret(el, off); }
    },
    // paste multiline text → new items split ONLY at bullet markers ("- "/"* "). Lines without a bullet are
    // continuations that join the current item (space-joined) — so a wrapped/multi-line sentence isn't torn apart.
    // Bullet-less multiline collapses to ONE item. Single line → normal inline paste. item=null ⇒ ghost (append).
    chkPaste(e, item = null) {
      const text = e.clipboardData?.getData('text') || '';
      if (!/\r?\n/.test(text.trim())) return;   // single line → let the browser paste inline
      const bulletRe = /^\s*[-*]\s+/;
      const lines = text.split(/\r?\n/);
      let texts;
      if (lines.some(l => bulletRe.test(l))) {
        texts = [];
        for (const l of lines) {
          if (bulletRe.test(l)) texts.push(l.replace(bulletRe, '').trim());
          else if (l.trim() && texts.length) texts[texts.length - 1] += ' ' + l.trim();   // non-bullet line = continuation of the current item
        }
        texts = texts.filter(Boolean);
      } else {
        texts = [lines.map(l => l.trim()).filter(Boolean).join(' ')].filter(Boolean);   // no bullets → one item (sentence stays whole)
      }
      if (!texts.length) return;
      e.preventDefault();
      const items = texts.map(t => ({ id: crypto.randomUUID(), text: t, done: false }));
      // ghost paste lands at the TOP (like addChecklistItem); pasting onto an item inserts right after it
      const at = item == null ? 0 : this.draft.checklist.indexOf(item) + 1;
      this.draft.checklist.splice(at, 0, ...items);
      this.sortChecklist();
    },
    // tint the checklist rows a cross-row selection spans — previews what ⌘C will copy (chkCopy kicks in at ≥2 rows)
    _chkSelTint() {
      const rows = document.querySelectorAll('.composer-entries .entry.chk:not(.ghost)');
      if (!rows.length) return;
      const sel = getSelection(), r = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      const hit = r ? [...rows].filter(el => r.intersectsNode(el.querySelector('.entry-txt'))) : [];
      const on = hit.length >= 2 ? new Set(hit) : null;
      for (const el of rows) el.classList.toggle('chk-sel', !!on?.has(el));
    },
    // a selection spanning ≥2 checklist items copies as a plain "- item" list (round-trips with chkPaste's bullet-strip).
    chkCopy(e) {
      const sel = getSelection(); if (!e.clipboardData || !sel?.rangeCount || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const items = [...e.currentTarget.querySelectorAll('.entry.chk:not(.ghost) .entry-txt')].filter(el => range.intersectsNode(el));
      if (items.length < 2) return;   // single item → native inline copy
      e.clipboardData.setData('text/plain', items.map(el => '- ' + el.textContent.trim()).join('\n'));
      e.preventDefault();
    },
    async removeChild(c) { if (this.askDeleteTask(c.id, 'child')) return; await this.perform('Deleted subtask', { target: 'task', kind: 'delete', id: c.id }); },
    // Drag-to-reorder the composer entry list (grip handle). kind: 'sub' = child tasks (store order) | 'chk' = draft.checklist.
    initEntrySort(el, kind) {
      makeSortable(el, { itemSel: '.entry:not(.ghost)', handleSel: '.entry-grip',
        onCommit: (from, to) => kind === 'sub' ? this.reorderSubtasks(from, to) : this.reorderChecklist(from, to) });
    },
    async reorderSubtasks(from, to) {
      const ids = this.childTasks(this.editing).map(c => c.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      if (await this.store.tasks.reorder(ids)) await this.loadTasks();
    },
    reorderChecklist(from, to) {
      this.draft.checklist.splice(to, 0, this.draft.checklist.splice(from, 1)[0]);
      this.sortChecklist();   // buckets are authoritative — a drop that crossed the open/done split snaps back to its own bucket
      if (this.editing) this.store.tasks.update(this.editing, { checklist: this.draft.checklist });   // persist immediately; the Saved-task diff (byId baseline is pre-reorder) still journals it for ⌘Z
    },
    // O(1)/row via precomputed _editDescs set (was descendantIds() per row → O(n²) on edit-open)
    hiddenInEdit(t) { return !!this.editing && t.id !== this.editing && !!this._editDescs && this._editDescs.has(t.id); },
    // IMPERATIVE hover-block (hovered task + direct children): reading hoverId in 1000 rows' :class costs ~16ms/hover
    hoverRow(r, e) {
      this.clearHover();
      this.hoverId = r.t.id;
      const list = e.target.closest('.list'); if (!list) return;
      const h = r.t.id, inb = (id, pid) => id === h || pid === h;
      for (const row of this.visibleRows()) {
        if (!inb(row.t.id, row.t.parent_id)) continue;
        const li = list.querySelector('.item[data-id="' + row.t.id + '"]'); if (!li) continue;
        li.classList.add('inblock');
        li.classList.toggle('rb-top', !inb(row.prevId, row.prevPid));
        li.classList.toggle('rb-bottom', !inb(row.nextId, row.nextPid));
        _hoverEls.push(li);
      }
    },
    clearHover() { for (const li of _hoverEls) li.classList.remove('inblock', 'rb-top', 'rb-bottom'); _hoverEls = []; this.hoverId = null; },
    _rowEl(id) { return document.querySelector('.surface-lists .list .item[data-id="' + id + '"]'); },
    _setDropInto(id) {   // drag "nest here" outline — one element, not a reactive :class on every row
      if (_dropEl && _dropEl.dataset.id === id) return;
      _dropEl && _dropEl.classList.remove('drop-into');
      _dropEl = id ? this._rowEl(id) : null;
      _dropEl && _dropEl.classList.add('drop-into');
    },
    _clearDrag() {
      const list = document.querySelector('.surface-lists .list');
      if (list) for (const li of list.querySelectorAll('.dragging, .row-hidden, .drop-into')) li.classList.remove('dragging', 'row-hidden', 'drop-into');
      _dropEl = null;
    },
    _setKbFocus(id) {   // keyboard focus outline — one element, applied imperatively
      _kbEl && _kbEl.classList.remove('kbfocus');
      this.focusId = id;
      _kbEl = id ? this._rowEl(id) : null;
      if (_kbEl) { _kbEl.classList.add('kbfocus'); this.$nextTick(() => _kbEl && _kbEl.scrollIntoView({ block: 'nearest' })); }
    },
    // --- Delegated row events (bound once on the <ul>, resolve the row by data-id) — see the list markup ---
    _rowFromEl(el) { return el ? (this.visibleRows().find(r => r.t.id === el.dataset.id) || this.completedRows().find(r => r.t.id === el.dataset.id)) : null; },   // active OR Done list
    listOver(e) {
      const el = e.target.closest && e.target.closest('.item'), id = el && el.dataset.id;
      if (id === this.hoverId) return;                  // mouseover fires per child element — skip if same row
      const r = id ? this._rowFromEl(el) : null;
      r ? this.hoverRow(r, e) : this.clearHover();
    },
    listClick(e) { const r = this._rowFromEl(e.target.closest && e.target.closest('.item')); if (r) this.onRowClick(r, e); },
    listDragStart(e) { if (e.target.closest('.chk-row')) return e.preventDefault(); const r = this._rowFromEl(e.target.closest && e.target.closest('.item')); if (r) this.dragStart(r.t, e, r.depth); },   // a checklist-row drag is pointer-based, not the row's HTML5 drag
    // Pointer-drag a task's checklist rows to reorder — scoped to that one task's .chk-list (never leaks / reparents).
    initListChkSort(el) {
      makeSortable(el, { itemSel: '.chk-row', scopeSel: '.chk-list', mouseOnly: true, onCommit: (from, to, scope) => this.reorderTaskChecklist(from, to, scope) });
    },
    async reorderTaskChecklist(from, to, scope) {
      const id = scope.closest('.item')?.dataset.id, t = this.byId.get(id); if (!t) return;
      const cis = [...scope.querySelectorAll('.chk-row')].map(r => +r.dataset.ci);   // current visual order → original array indices
      cis.splice(to, 0, cis.splice(from, 1)[0]);
      const cl = t.checklist || [], next = cis.map(i => cl[i]).filter(Boolean);
      // Journal against the captured id so ⌘Z reverses THIS reorder — not an earlier action on another task.
      await this._journalRowChange('Reordered checklist', 'task', id, () => this.store.tasks.update(id, { checklist: next }));
    },
    listDragOver(e) { const itemEl = e.target.closest && e.target.closest('.item'); const r = this._rowFromEl(itemEl); if (r) this.dragOver(r.t, { clientY: e.clientY, clientX: e.clientX, currentTarget: itemEl, dataTransfer: e.dataTransfer }, r.depth); if (this.dragId) edgeScrollStep(document.querySelector('.surface-lists .app'), e.clientY); },
    listDragLeave(e) { this.dragLeave(null, e); },
    // No row lookup: the drop lands wherever the pointer happens to be — the gap between rows, the list's own
    // padding, or the drop-ghost (an .item with NO data-id, rendered exactly where you're aiming). Gating on
    // "the release resolved to a row" threw those away, which is why some drags silently did nothing. The last
    // dragOver already recorded the intent in taskDropHint, and drop() reads only that.
    listDrop() { this.drop(); },
    hasProgress(t) { return this.childTasks(t.id).length > 0 || (t.checklist || []).length > 0; },
    rowProgress(t) {
      const kids = this.childTasks(t.id);
      if (kids.length) return Math.round(kids.filter(c => c.completed_at || c.archived_at).length / kids.length * 100);
      const cl = t.checklist || [];
      return cl.length ? Math.round(cl.filter(c => c.done).length / cl.length * 100) : 0;
    },
    async toggleChk(taskId, i) {
      const task = this.byId.get(taskId); if (!task) return;
      const list = task.checklist || [], item = list[i]; if (!item) return;
      const done = !item.done;
      // Journal the whole delta (item done + any parent auto-complete) against taskId so ⌘Z reverses THIS toggle,
      // not an earlier action on a different task. silent: a checklist tick is a frequent action — no toast (like completion).
      await this._journalRowChange(done ? 'Checked item' : 'Unchecked item', 'task', taskId, async () => {
        if (!await this.store.tasks.setChecklistItem(taskId, item.id, done)) return;
        // sync task completion once every item is checked
        const allDone = list.length > 0 && list.every((x, j) => j === i ? done : x.done);
        if (allDone !== !!task.completed_at) await this.store.tasks.setCompleted(taskId, allDone);
      }, { silent: true });
    },
    // arg is a plain content string OR a full fields object (subtask NLP → due/prio/area/… land on the child).
    async addSubtask(parentId, arg) {
      const fields = typeof arg === 'string' ? { content: arg } : { ...arg };
      fields.content = (fields.content || '').trim(); if (!fields.content) return;
      const task = await this.store.tasks.create({ ...fields, parent_id: parentId });
      if (!task) return;
      // Insert at TOP of siblings so it lands right under the "New subtask" ghost — mirrors the checklist ghost.
      const siblings = this.tasks.filter(t => t.parent_id === parentId);
      if (siblings.length) {
        const minPos = Math.min(...siblings.map(t => t.position ?? 0));
        await this.store.tasks.update(task.id, { position: minPos - 1 });
      }
      // new child reopens a completed parent (and its ancestors)
      if (this.byId.get(parentId)?.completed_at) await this.store.tasks.setCompleted(parentId, false);
      await this.loadTasks();
      return task;
    },
    // Overflow menu: convert the current editing task to a goal. The task is removed only once the goal
    // EXISTS — and a task carrying a checklist is archived instead of removed (its items have no goal home;
    // archive preserves them). Goal-create failure leaves the task exactly as it was.
    async convertToGoal() {
      if (!this.editing) return;
      const t = this.byId.get(this.editing);
      if (!t) return;
      this.closeComposer(true);   // task becomes a goal → drop its task draft
      const goal = await this.createGoal(t.content);   // creates the goal + reloads goals
      if (goal) {
        if ((t.checklist || []).length) await this.store.tasks.update(t.id, { archived_at: new Date().toISOString() });
        else await this.store.tasks.remove(t.id);
      }
      await this.loadTasks();
      if (goal) { this.setNav('goals'); this.$nextTick(() => this.openGoal(goal.id)); }
    },
    // Overflow menu: subtasks → checklist items (removes subtasks, adds them as checklist).
    // Committed immediately (like removeChild) under ONE undo step, so cancelling the composer can't lose the subtasks.
    async convertToChecklist() {
      if (!this.editing) return;
      const kids = this.childTasks(this.editing);
      if (!kids.length) return;
      const before = JSON.parse(JSON.stringify(this.draft.checklist));
      const items = kids.map(k => ({ id: crypto.randomUUID(), text: k.notes ? `${k.content}::${k.notes}` : k.content, done: !!k.completed_at }));
      this.draft.checklist = [...this.draft.checklist, ...items];
      // the checklist must be PERSISTED before any subtask is removed — a failed update aborts the conversion
      if (await this.store.tasks.update(this.editing, { checklist: this.draft.checklist })) {
        const kidRows = kids.map(k => this._rowsForDelete('task', k.id));   // snapshot before removal, for undo
        await Promise.all(kids.map(k => this.store.tasks.remove(k.id)));
        await this.reloadAll();
        this._pushEntry('Converted to checklist', { kind: 'composite', target: 'task', ops: [
          ...kids.map((k, i) => ({ kind: 'reinsert', target: 'task', id: k.id, rows: kidRows[i] })).reverse(),
          { kind: 'update', target: 'task', id: this.editing, after: { checklist: before } },
        ] });
      } else {
        this.draft.checklist = this.draft.checklist.filter(c => !items.includes(c));   // revert the staged copy; subtasks stay
      }
      this._draftBase = this._draftSig(); this._clearPending(this._draftKey());   // conversion is persisted → this is the saved state, not an unsaved draft
    },
    // Overflow menu: checklist → subtasks. CREATE FIRST, DELETE LAST: the checklist is cleared only after
    // every subtask verifiably exists; any failure rolls back the created tasks and leaves the checklist
    // untouched. Worst case is a duplicate, never a loss.
    async convertToSubtasks() {
      if (!this.editing) return;
      const items = this.draft.checklist.filter(i => i.text.trim());
      if (!items.length) return;
      const beforeChecklist = JSON.parse(JSON.stringify(this.draft.checklist));
      const wasCompletedAt = this.byId.get(this.editing)?.completed_at ?? null;
      const made = [];
      let ok = false;
      try {
        for (const item of items) {
          const sep = item.text.indexOf('::');
          const content = sep >= 0 ? item.text.slice(0, sep).trim() : item.text;
          const notes = sep >= 0 ? item.text.slice(sep + 2).trim() : null;
          const task = await this.store.tasks.create({ content, parent_id: this.editing, ...(notes ? { notes } : {}) });
          if (!task) throw 0;
          made.push(task.id);
        }
        await this.store.tasks.reorder(made);   // creates prepend — restore the checklist's order
        for (let i = 0; i < items.length; i++) if (items[i].done) await this.store.tasks.setCompleted(made[i], true);
        // every subtask exists — only NOW is the destructive step safe
        this.draft.checklist = [];
        await this.store.tasks.update(this.editing, { checklist: [] });
        if (wasCompletedAt) await this.store.tasks.setCompleted(this.editing, false);   // new children reopen a completed parent
        ok = true;
      } catch {
        await Promise.allSettled(made.map(id => this.store.tasks.remove(id)));   // undo partial creates; checklist intact
      }
      await this.reloadAll();
      if (ok) this._pushEntry('Converted to subtasks', { kind: 'composite', target: 'task', ops: [
        ...made.map(id => ({ kind: 'remove', target: 'task', id })).reverse(),
        { kind: 'update', target: 'task', id: this.editing, after: { checklist: beforeChecklist } },
        ...(wasCompletedAt ? [{ kind: 'update', target: 'task', id: this.editing, after: { completed_at: wasCompletedAt } }] : []),
      ] });
      this._draftBase = this._draftSig(); this._clearPending(this._draftKey());   // conversion is persisted → this is the saved state, not an unsaved draft
    },
    // Overflow menu: duplicate the edited task. Copies from the SAVED row (byId), not the in-progress draft —
    // fresh checklist ids, drop identity/status/subtree. Routed through perform() so ⌘Z removes the copy.
    async duplicateEditing() {
      const src = this.byId.get(this.editing); if (!src) return;
      const f = {
        content: src.content, notes: src.notes, importance: src.importance,
        due_at: src.due_at, deadline_at: src.deadline_at, scheduled_at: src.scheduled_at,
        est_minutes: src.est_minutes, parent_id: src.parent_id, area_ids: src.area_ids,
        goal_ids: src.goal_ids, color: src.color, favorite: src.favorite, place: src.place,
        location: src.location, recurrence: src.recurrence, milestone: src.milestone,
        checklist: (src.checklist || []).map(c => ({ ...c, id: crypto.randomUUID() })),
        checklist_plain: src.checklist_plain,
      };
      this.closeComposer(true);   // close first (saved=true → don't keep a draft)
      await this.perform('Duplicated task', { target: 'task', kind: 'create', fields: f });
    },
    anyDialog() { return !!(this.confirm || this.palette.open || DIALOG_KEYS.some(k => this[k])); },
    closeDialogs() { if (this.confirm) this.confirmNo(); this.palette.open = false; for (const k of DIALOG_KEYS) this[k] = null; },
    askConfirm(opts) { this.confirm = opts; },
    async confirmYes() { const c = this.confirm; this.confirm = null; if (c?.onConfirm) await c.onConfirm(); },
    confirmNo() { const c = this.confirm; this.confirm = null; if (c?.onCancel) c.onCancel(); },
    onPaste(e) {
      const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      if (!text) return;
      const segs = tokenizeAll(text, new Date(), this.locNames());
      if (!segs.some(s => s.kind)) return;          // no tokens → let the browser paste normally
      e.preventDefault();
      const sel = getSelection(); const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      this.askConfirm({
        message: 'This text has tokens — turn them into chips?',
        confirmLabel: 'Make chips',
        cancelLabel: 'Keep as text',
        onConfirm: () => this.insertSegments(segs, range),
        onCancel: () => this.insertAtRange(range, document.createTextNode(text)),
      });
    },
    insertAtRange(range, node) {
      const el = this._nlpEl(); el.focus();
      const s = getSelection(); s.removeAllRanges();
      if (range && el.contains(range.startContainer)) s.addRange(range); 
      else { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); }
      const r = s.getRangeAt(0); r.deleteContents();
      const last = node.nodeType === 11 ? node.lastChild : node;
      r.insertNode(node);
      if (last) { r.setStartAfter(last); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
      this.syncTitle();
    },
    insertSegments(segs, range) {
      const frag = document.createDocumentFragment();
      for (const seg of segs) {
        if (seg.text !== undefined) { if (seg.text) frag.appendChild(document.createTextNode(seg.text)); }
        else { frag.appendChild(this.makePill(seg.kind, seg.value, seg.token)); this.commitPill(seg.kind, seg.value); }
      }
      if (frag.lastChild && frag.lastChild.nodeType === 1) frag.appendChild(document.createTextNode(' '));   // caret home after a trailing pill
      this.insertAtRange(range, frag);
    },
    askSidebarPromote() {
      const id = this.editing;
      this.askConfirm({ message: "Promote this task to a project? It'll show in the project tree for navigation.",
        confirmLabel: 'Promote', onConfirm: () => this.promoteToSidebar(id) });
    },
    async promoteToSidebar(id) {
      if (!id) return;
      if (await this.store.tasks.update(id, { sidebar: true, parent_id: null })) await this.loadTasks();   // sidebar projects are top-level
      this.closeComposer(true);   // the edited task became a sidebar project — close + drop its draft
    },
    // Shared sweep-check: if completing `id` would also complete open dependents (children/blockers),
    // show the confirm dialog and return true — the caller must stop and let the dialog finish the job.
    // Returns false when there's nothing to sweep, so the caller completes it directly.
    async confirmSweep(id, onDone) {
      const { pendingSweep } = await import('./store.js');
      const sweep = pendingSweep(this.tasks, id);
      if (!sweep.length) return false;
      const items = sweep.map(x => this.byId.get(x)).filter(Boolean);
      const bodyHtml = `<div class="sweep-list">${items.map(it => `<div class="task-line">${this.taskLine(it)}</div>`).join('')}</div>`;
      this.askConfirm({ message: 'Completing this will also complete:', bodyHtml, confirmLabel: 'Complete all', onConfirm: async () => { await this.applyComplete(id, true); onDone?.(); } });
      return true;
    },
    async toggle(t) {
      if (t.archived_at) { this.toast('Archived — unarchive from the task menu'); return; }   // dash checkbox is inert
      if (!t.completed_at && await this.confirmSweep(t.id)) return;
      await this.applyComplete(t.id, !t.completed_at);
    },
    // Overflow menu: archive / unarchive the editing task (can't be completed anymore). Archive is a
    // terminal action — close the composer so it's visibly gone from the list; the undo banner
    // ("Archived task" + Undo) is the single truthful confirmation, so no extra toast.
    async toggleArchive() {
      if (!this.editing) return;
      const t = this.byId.get(this.editing); if (!t) return;
      const val = !t.archived_at, id = this.editing;
      await this._journalRowChange(val ? 'Archived task' : 'Unarchived task', 'task', id, () => this.store.tasks.setArchived(id, val));
      this.closeComposer(true);   // archived → drop the draft (task's now off the list)
    },
    async applyComplete(id, done) {
      // silent: completion is a 100×/day action + goal-linked completions fire their own celebratory toast below — no generic toast.
      // Capture the FULL completion delta (target + swept dependents + auto-completed parents) so undo reverses every affected row,
      // not just id — else the swept rows keep phantom completions inflating stats/streaks/EXP. (_captureCompletionFx reloads.)
      const fx = await this._captureCompletionFx(() => this._withPending(id, () => this.store.tasks.setCompleted(id, done)));
      // Entry op is the REVERSE (first ⌘Z undoes this completion); it carries fwd so redo can re-run + re-capture symmetrically.
      this._pushEntry(done ? 'Completed' : 'Uncompleted', { kind: 'complete', target: 'task', mode: 'reverse', fwd: { id, done }, fx }, { silent: true });
      if (done) {
        const t = this.byId.get(id), goals = t ? this.goalsForTask(t) : [];
        if (goals.length) {
          this.flashGoal('chipGlintId', '_chipGlintT', id, 300);   // daily-tier echo: brief warm glint on the row's goal chip
          const idg = goals.find(g => (this.identityStatement(g) || '').trim());
          const idgStmt = idg ? this.identityStatement(idg) : null;
          if (t?.milestone) {
            const phrase = this.identityPhrase(idgStmt);
            this.toast(phrase ? '◆ milestone · a vote for ' + phrase : '◆ milestone · toward "' + goals[0].name + '"');
            this._milestoneBeat(goals[0].id);
          } else {
            this.toast(idgStmt ? '🔥 +1 vote · ' + idgStmt : '🔥 +1 · ' + goals[0].name);
          }
        }
      }
    },

    async save(t, fields) { Object.assign(t, await this.store.tasks.update(t.id, fields) || {}); this._rowV++; },
    async remove(t) { await this.perform('Deleted', { target: 'task', kind: 'delete', id: t.id }); },

    // --- Relations ---
    relationCandidates() {
      const e = this.editingTask(), related = new Set([...(e?.blocked_by ?? []), ...(e?.relates ?? []), ...this.tasks.filter(o => (o.blocked_by ?? []).includes(this.editing)).map(o => o.id)]);
      // cap at 40; narrows as you type
      return this.pickerMatches(this.tasks.filter(t => t.id !== this.editing && t.id !== this.store.defaultProject() && !related.has(t.id))).slice(0, 40);
    },
    taskRels(t) {
      if (!t) return [];
      // 'blocks' = the INVERSE direction (this task sits in the other's blocked_by) — shown so it's managed from here too
      return [...(t.blocked_by ?? []).map(id => ({ id, type: 'blocked_by' })), ...this.tasks.filter(o => (o.blocked_by ?? []).includes(t.id)).map(o => ({ id: o.id, type: 'blocks' })), ...(t.relates ?? []).map(id => ({ id, type: 'relates' }))];
    },
    // Blocked = has an incomplete blocker (matches is:blocked) — drives the lock badge in the checkbox.
    blocked(t) { return isBlocked(this.tasks, t.id); },
    relChips() { return this.taskRels(this.editingTask()); },
    relTypeLabel(type) { return { blocked_by: 'blocked', blocks: 'blocks', relates: 'relates' }[type]; },
    relIcon(type) { return type === 'relates' ? 'i-link' : 'i-stop'; },
    // Ledger wells: relWell partitions taskRels per well; relTarget = clicked candidate (if still listed) else top hit
    relWell(type) { return this.taskRels(this.editingTask()).filter(r => r.type === type); },
    relTarget() { const c = this.relationCandidates(); return c.some(t => t.id === this.relSel) ? this.relSel : (c[0]?.id ?? null); },
    placeRelKey(e, type) { if (this.relTarget()) { e.preventDefault(); this.placeRel(type); } },   // arrows keep editing the query when there's nothing to place
    async placeRel(type) {
      const id = this.relTarget(); if (!id) return;
      this.relSel = null; this.pickerQ = '';
      this.relWarm = type; clearTimeout(this._relWarmT); this._relWarmT = setTimeout(() => this.relWarm = '', 650);
      await this.addRelation(id, type);
    },
    async dropRel(e, type) {
      const id = e.dataTransfer.getData('text/plain'); if (!id) return;
      this.relDragOver = '';
      this.relWarm = type; clearTimeout(this._relWarmT); this._relWarmT = setTimeout(() => this.relWarm = '', 650);
      await this.addRelation(id, type);
    },
    editingTask() { return this.byId.get(this.editing) ?? null; },
    // 'blocks' writes blocked_by on the OTHER task (swapped link direction) — no separate stored type
    async addRelation(otherId, type) { if (!otherId) return; const ok = type === 'blocks' ? await this.store.tasks.link(otherId, this.editing, 'blocked_by') : await this.store.tasks.link(this.editing, otherId, type); if (ok) await this.loadTasks(); },
    async removeRelation(otherId, type) { const ok = type === 'blocks' ? await this.store.tasks.unlink(otherId, this.editing, 'blocked_by') : await this.store.tasks.unlink(this.editing, otherId, type); if (ok) await this.loadTasks(); },

    // ---- Calendar (continuous Month · page-per-week Week/Day · Year — iOS/macOS-Calendar-style) ----
    listView() { return this.surface === 'lists'; },   // task-list views (all/backlog/project/area/filter) live on the Lists surface
    // ---- Now home (heuristic until the planner lands; always-functional with no data) ----
    nowGreeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; },
    // Open = not completed/archived/sidebar/parent. Callers append their own clauses (e.g. _actionable excludes defaultProject).
    _openLeaf(t) { return !t.completed_at && !t.archived_at && !this.isSidebar(t) && !this.hasChildren(t.id); },
    _actionable() {
      const def = this.store.defaultProject();
      return this.tasks.filter(t => this._openLeaf(t) && t.id !== def)
        .sort((a, b) => (a.due_at || '9999').slice(0, 10).localeCompare((b.due_at || '9999').slice(0, 10)) || impRank(a.importance) - impRank(b.importance));
    },
    nowTask() { return this._actionable()[0] || null; },
    nowNext() {
      const n = new Date(), iso = isoDate(n);
      const ev = calendarItems(this.events, this.tasks, iso, iso, n)
        .filter(it => it.kind === 'event' && !it.allDay && new Date(it.start) > n)
        .sort((a, b) => a.start.localeCompare(b.start))[0];
      if (!ev) return null;
      const mins = Math.max(0, Math.round((new Date(ev.start) - n) / 60000));
      return { id: ev.id, title: ev.title || 'Event', mins, when: this._clTime(ev.start) };
    },
    nowDay() {
      const d = new Date(), wake = 7, sleep = 23, span = (sleep - wake) * 60;
      const mins = d.getHours() * 60 + d.getMinutes();
      const pct = Math.max(0, Math.min(100, ((mins - wake * 60) / span) * 100));
      const leftMin = Math.max(0, sleep * 60 - mins);
      const left = leftMin >= 60 ? `${Math.floor(leftMin / 60)}h ${leftMin % 60}m` : `${leftMin}m`;
      const nx = this.nowNext();
      const evPct = nx ? Math.max(0, Math.min(100, ((mins + nx.mins) - wake * 60) / span * 100)) : null;
      return { pct, left, clock: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), nx, evPct };
    },
    nowMeta(t) {
      if (!t) return '';
      const bits = [];
      const b = t.due_at && dueBadge(t.due_at, new Date()); if (b) bits.push('Due ' + b.label);
      if (t.est_minutes) bits.push('~' + t.est_minutes + ' min');
      const proj = this.projName(t.parent_id); if (proj) bits.push('# ' + proj);
      return bits.join(' · ');
    },
    nowStart(t) {   // Now has no list/composer of its own — jump to the task's list, then open it
      if (!t) return;
      let root = t, seen = new Set();
      while (root.parent_id && !seen.has(root.id)) { seen.add(root.id); const p = this.byId.get(root.parent_id); if (!p) break; root = p; }
      const inProj = this.isSidebar(root) && root.id !== this.store.defaultProject();
      this.setNav(inProj ? 'project' : 'all', inProj ? root.id : null);
      this.$nextTick(() => this.editTask(t));
    },
    // ---- Now Room: daypart glow, alternates, today list (events-first), now-window, mainline ----
    daypart() { return daypartOf(new Date().getHours()); },   // real clock → dawn/day/dusk/night, drives the hearth's color temperature
    nowBrief() {
      const overdue = this._actionable().some(t => t.due_at && t.due_at.slice(0, 10) < isoDate(new Date()));
      return overdue ? "A few things slipped by — the hearth's still warm. Pick one and begin." : "Today's yours to shape. Pick the one that fits.";
    },
    nowAlts() { return this.nowListRows().slice(0, 2); },   // the next 2 real tasks — no energy/feeling model (LATER)
    nowVote(t) {
      const g = t && this.goalsForTask(t).find(x => (this.identityStatement(x) || '').trim());
      return g ? this.identityPhrase(this.identityStatement(g)) : null;
    },
    nowFocusTask() { return this.byId.get(this.nowFocusId) ?? null; },
    // transient VIEW state only; `e` target refocused on back; mobile scrolls Room into view
    nowMainline(id, e) {
      this.nowFocusId = id; _nowFocusEl = e?.currentTarget ?? null;
      this.$nextTick(() => { if (innerWidth < 840) document.querySelector('.room')?.scrollIntoView({ behavior: this.reduceMotion() ? 'auto' : 'smooth', block: 'start' }); });
    },
    nowBack() { this.nowFocusId = null; this.$nextTick(() => { _nowFocusEl?.focus(); _nowFocusEl = null; }); },
    // events first; completed tasks dropped (calendarItems includes them — Now hides them)
    nowToday(iso = isoDate(new Date()), now = new Date()) {
      return eventsFirst(calendarItems(this.events, this.tasks, iso, iso, now))
        .filter(it => it.kind === 'event' || !(this.byId.get(it.id)?.completed_at || this.byId.get(it.id)?.archived_at));
    },
    nowWindow() {
      void this._nowTickV;
      // rolling window: BEFORE h above + AFTER below; flows past midnight
      const HP = 34, BEFORE = 4, AFTER = 12;
      const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
      const startMin = Math.floor((nowMin - BEFORE * 60) / 60) * 60, endMin = startMin + (BEFORE + AFTER) * 60;
      const y = min => (min - startMin) / 60 * HP, dayH = (endMin - startMin) / 60 * HP;
      const hours = [];
      for (let m = startMin; m <= endMin; m += 60) {
        const abs = m / 60, hd = ((abs % 24) + 24) % 24;
        hours.push({ h: abs, label: (hd % 12 || 12) + (hd < 12 ? 'am' : 'pm'), next: abs >= 24, top: y(m), past: m < nowMin });
      }
      const place = (items, off) => items.filter(it => !it.allDay).map(it => {
        const s = this._clMin(it.start) + off, e = (it.end && it.end.length > 10 ? this._clMin(it.end) : this._clMin(it.start) + 30) + off;
        return { ...it, top: y(s), height: Math.max((e - s) / 60 * HP, 20), live: s <= nowMin && nowMin < e, past: e <= nowMin };
      }).filter(r => r.top + r.height >= 0 && r.top <= dayH);
      const dIso = d => isoDate(new Date(Date.now() + d * 864e5));
      const day = (d, off) => place(this.nowToday(dIso(d), now), off);
      const rows = [...place(this.nowToday(), 0), ...day(1, 1440), ...day(-1, -1440)];   // today ± the neighbouring days that fall in the window
      return { dayH, nowY: y(nowMin), hours, rows };
    },
    async loadEvents() { this.events = await this.store.events.list(); _calDataV++; _goalStepsMemo.clear(); _goalMilestonesMemo.clear(); },
    // must bust _calDataV too — without it a block added between two event loads never reaches the memo, and the
    // calendar keeps drawing the previous set until some unrelated task/event change happens to bump the sig
    async loadBlocks() { this.blocks = await this.store.blocks.list(); _calDataV++; },
    _clDate() { return new Date(this.clAnchor + 'T00:00'); },
    _clWeekStart(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; },   // Sunday
    // threadless items go WARM, never grey — grey is what made scheduled tasks read as disabled
    clItemColor(it) { return it.color || (it.kind === 'task-deadline' ? 'var(--p2)' : it.kind === 'task-due' ? 'var(--p4)' : 'var(--accent)'); },
    _clTime(s) { return this.clAgTime(this._clMin(s)); },
    _monthLabel(d) { return d.toLocaleDateString([], { month: 'long', year: 'numeric' }); },
    _weekIdx(d) { return Math.round((this._clWeekStart(d).getTime() - CL_EPOCH.getTime()) / 604800000); },
    _weekDate(idx) { const d = new Date(CL_EPOCH); d.setDate(d.getDate() + idx * 7); return d; },
    clAnchorIdx() { return this._weekIdx(this._clDate()); },
    // Row height so exactly 6 weeks fill the page (macOS); rendered-row count = visible + buffer each side.
    clRecalc() {
      const h = this._clVH();
      this.clRowH = Math.max(64, Math.floor((h - CL_BAR - CL_HEAD) / 6));
      this.clVisCount = Math.ceil(h / this.clRowH) + CL_BUFFER * 2;
      this.clVisStart = Math.max(0, this.clAnchorIdx() - CL_BUFFER);
      // computed from styles so it's right on every breakpoint (mobile uses a smaller title font)
      const bar = this.$root.querySelector('.cl-bar'), p = this.$root.querySelector('.cl-period');
      if (bar && p) { const ps = getComputedStyle(p); this._clBarY = bar.offsetHeight - parseFloat(ps.paddingBottom) - parseFloat(ps.fontSize); }
    },
    clTotalH() { return CL_TOTAL_WEEKS * this.clRowH; },
    clOpenCalendar() {
      this.clRecalc();
      if (!this._clResize) { this._clResize = true; window.addEventListener('resize', () => { if (this.surface !== 'plan') return; this.clRecalc(); if (this.clView === 'month') this.clScrollToAnchor(); else this._clZoomTo(this.clZoom); }); }
      if (this.clView === 'month') this.clScrollToAnchor(); else if (this.clView === 'week' || this.clView === 'day') { this.clRecalcPages(); this.$nextTick(() => this._clScrollToPeriod()); }
    },
    clHeading() {
      if (this.clView === 'day' || this.clView === 'week') return this.clTopPeriod || this._periodLabel(this.clView === 'day' ? this._clDate() : this._clWeekStart(this._clDate()));   // scroll-driven, like month
      return this.clTopMonth || this._monthLabel(this._clDate());   // month: scroll-driven label
    },
    _clFocusDate() { return new Date(Math.floor(this.clFocusYM / 12), this.clFocusYM % 12, 1); },
    // month labels the HIGHLIGHTED (viewport-centered) month, not the scroll-top one
    clTitleParts() {
      const src = this.clView === 'month' && this.clFocusYM != null ? this._monthLabel(this._clFocusDate()) : this.clHeading();
      return this.clSplitTitle(src);
    },
    clPeriodMain() { return this.clTitleParts()[0]; },
    clPeriodYear() { return this.clTitleParts()[1]; },
    clSetView(v) {
      // reset zoom to fit, never to 0 — a zero hour height collapses the spacer mid-switch and the browser
      // clamps scrollTop, which used to land the anchor years away
      this._withTransition(() => { this.clZoom = 1; this.clHourH = this._clFitHour(); this.clView = v; },
        () => { if (v === 'month') this.clScrollToAnchor(); else if (v === 'week' || v === 'day') { this.clRecalcPages(); this._clScrollToPeriod(); } this._clSettle(); });
    },
    _withTransition(setFn, afterFn) {
      // Switches must not be able to land out of order: _vtSeq ensures a stale callback never applies over a newer one.
      const seq = this._vtSeq = (this._vtSeq || 0) + 1;
      let ran = false;
      this.clVT = true;   // names go on for the capture only — see the CSS note on permanent layer promotion
      const run = async () => { if (ran || seq !== this._vtSeq) return; ran = true; setFn(); await this.$nextTick(); afterFn?.(); await this.$nextTick(); };
      // hidden tabs abort (InvalidStateError) — guard with visibilityState
      if (document.startViewTransition && document.visibilityState === 'visible') {
        const t = document.startViewTransition(run);
        // settle: clear CSS names once the animation finishes; also call run() in case the update callback was skipped
        const settle = () => { this.clVT = false; run(); };
        t.finished.then(settle, settle); t.updateCallbackDone.catch(run); t.ready.catch(() => {});
        setTimeout(run, 250);   // fallback: apply state if callback never fires; seq-guarded, never resets clVT
      } else { this.clVT = false; run(); }
    },

    // --- read-model (module scope — never triggers reactivity) ---
    _clGroup(fromIso, toIso) {
      // Register the reactive deps BEFORE the memo can short-circuit: on a hit we would otherwise return
      // without ever reading events/tasks, the render effect would record no dependency on them, and adding or
      // completing something would not repaint until an unrelated change happened to force it.
      void this.events; void this.tasks;
      // clPages re-derives every tick — cache to avoid full-set scans
      return _memo(_groupMemo, fromIso + '|' + toIso + '|' + _calDataV, () => {
        const map = {}, add = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
        for (const it of calendarItems(this.events, this.tasks, fromIso, toIso, new Date())) {
          const s = it.start.slice(0, 10), e = (it.end || it.start).slice(0, 10);
          if (it.allDay && e > s) {   // any multi-day all-day item (event or task band) explodes into connected segments
            for (let day = s < fromIso ? fromIso : s; day <= e && day <= toIso; day = add(day, 1))
              (map[day] ||= []).push({ ...it, spanStart: day === s, spanEnd: day === e });
          } else (map[s] ||= []).push(it);
        }
        return map;
      }, 12);
    },
    _clVisMap() {
      return this._clGroup(isoDate(this._weekDate(this.clVisStart)), isoDate(this._weekDate(this.clVisStart + this.clVisCount)));
    },

    // --- MONTH: virtualized week rows in a fixed-height spacer (constant scroll height, no reflow; buffer prevents blanks on fast flings) ---
    clWeeks() {
      if (!this.clRowH) this.clRecalc();
      const todayIso = isoDate(new Date()), byDay = this._clVisMap(), out = [];
      const end = Math.min(CL_TOTAL_WEEKS, this.clVisStart + this.clVisCount);
      for (let idx = Math.max(0, this.clVisStart); idx < end; idx++) {
        const ws = this._weekDate(idx);
        const days = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(ws);
          d.setDate(d.getDate() + i);
          const iso = isoDate(d);
          return {
            iso, day: d.getDate(), today: iso === todayIso,
            weekend: i === 0 || i === 6, out: d.getFullYear() * 12 + d.getMonth() !== this.clFocusYM,
            mlabel: d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short' }) : '', items: byDay[iso] || []
          };
        });
        out.push({ key: idx, top: idx * this.clRowH, days });
      }
      return out;
    },
    // Thursday's month = dominant; shared by scroll handler + jumps for consistent label
    _topMonthLabel(idx) { const d = this._weekDate(idx); d.setDate(d.getDate() + 3); return this._monthLabel(d); },
    _monthFirstIdx(d) { return this._weekIdx(new Date(d.getFullYear(), d.getMonth(), 1)); },   // week index of a month's 1st
    _clZoneTop() { return this.clView === 'month' ? this._clHeadH() + (this.clRowH || 1) : this._clVH() - CL_FOOT; },   // month: one week row of runway. day/week: the whole page — the incoming title rises from the bottom edge.   // fly runway: one week row in month; a fixed slice in day/week (a whole period would be a mile)   // viewport line below which a title rides coupled (body band); at/above it the overlay flies over the header into the bar (~1 row of fly runway)
    // Body bands: month titles glued to the grid (top=idx*rowH), only BELOW the zone. clZoneTitles picks them up overhead — both read clScrollTop for seamless handoff.
    clMonthBands() {
      if (!this.clRowH) this.clRecalc();
      const rowH = this.clRowH, head = CL_BAR + CL_HEAD, zoneTop = this._clZoneTop(), scrollTop = this.clScrollTop;
      const out = [], end = Math.min(CL_TOTAL_WEEKS, this.clVisStart + this.clVisCount);
      for (let idx = Math.max(0, this.clVisStart); idx < end; idx++) {
        if (head + idx * rowH - scrollTop <= zoneTop) continue;   // in the zone → the overlay shows it
        const ws = this._weekDate(idx);
        for (let i = 0; i < 7; i++) {
          const d = new Date(ws); d.setDate(d.getDate() + i);
          if (d.getDate() === 1) {
            out.push({ name: this._monthLabel(d), top: idx * rowH });
            break;
          }
        }
      }
      return out;
    },
    // Parallax clamp/shove/round shared by clZoneTitles and _periodZoneTitles.
    // Callers build list as [{name, vt}]; this applies the parallax, shoves overlaps, and filters.
    // LINEAR (not ease-out t*(2-t)): ease-out's zero slope at t=1 caused a visual "dip" at the band→overlay handoff.
    _zoneLayout(list, head, zoneH, barY, labelH = 46) {
      list.forEach(z => { z.y = z.vt <= head ? barY : barY + (head + zoneH - barY) * ((z.vt - head) / zoneH); });
      for (let i = list.length - 2; i >= 0; i--) list[i].y = Math.min(list[i].y, list[i + 1].y - labelH);
      return list.filter(z => z.y > -labelH).map(z => ({ name: z.name, y: Math.round(z.y), atBar: Math.abs(z.y - barY) < 3 }));
    },
    // `top` applied imperatively so it never lags
    clZoneTitles() {
      if (!this.clRowH) return [];
      const rowH = this.clRowH, head = CL_BAR + CL_HEAD, barY = this._clBarY != null ? this._clBarY : CL_BAR - 34 - 14, zoneH = this._clZoneTop() - head, scrollTop = this.clScrollTop;   // barY = measured .cl-period top (matches the idle heading on every breakpoint)
      const top = this._weekDate(Math.max(0, Math.floor(scrollTop / rowH))); top.setDate(top.getDate() + 3);
      const list = [];
      for (let k = -2; k <= 1; k++) {
        const first = new Date(top.getFullYear(), top.getMonth() + k, 1);
        const vt = head + this._weekIdx(first) * rowH - scrollTop;
        if (vt > head + zoneH) continue;
        list.push({ name: this._monthLabel(first), vt });
      }
      return this._zoneLayout(list, head, zoneH, barY);
    },
    _clVH() { return document.documentElement.clientHeight || window.innerHeight || 800; },   // window.innerHeight is unreliable in the test webview
    _clFocus(scrollTop) {   // dominant month = the one at the vertical center of the grid → stays bright when idle
      const rowH = this.clRowH || 1, head = CL_BAR + CL_HEAD;
      const d = this._weekDate(Math.max(0, Math.floor((scrollTop + (this._clVH() - head) / 2) / rowH)));
      d.setDate(d.getDate() + 3);
      this.clFocusYM = d.getFullYear() * 12 + d.getMonth();
    },
    _clScrollState(scrollTop) {
      const z = this.clZoneTitles().find(t => t.atBar);   // the toolbar heading == the title pinned in the bar
      this.clTopMonth = z ? z.name : this._topMonthLabel(Math.max(0, Math.floor(scrollTop / (this.clRowH || 1))));
      this._clFocus(scrollTop);
    },
    _clPositionZone() {   // set each over-header title's `top` imperatively (lag-free) from this frame's scrollTop
      const box = this.$refs.clMtitlesBox; if (!box) return;
      const y = {}; for (const t of (this.clView === 'month' ? this.clZoneTitles() : this._periodZoneTitles())) y[t.name] = t.y;   // MUST match what the markup rendered, or nothing moves until the next reactive flush (a frame late)
      for (const el of box.children) { const t = y[el.dataset.name]; if (t != null) el.style.top = t + 'px'; }
    },
    clMonthScroll(e) {
      const el = e.target, topIdx = Math.max(0, Math.floor(el.scrollTop / (this.clRowH || 1)));
      this.clVisStart = Math.max(0, topIdx - CL_BUFFER);
      this.clScrollTop = el.scrollTop;   // reactive → clMonthBands recomputes each band's rise/fade
      this._clScrollState(el.scrollTop);
      this._clPositionZone();   // sync: place the over-header titles THIS frame (reactive :style lags a frame → teleports on fast scroll)
      this.clScrolling = true; clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this.clScrolling = false, 600);
    },
    clMonthSnap() {},   // CSS scroll-snap-type: y proximity on .cl-month handles settling
    clScrollToAnchor() {
      const el = this.$refs.clMonth; if (!el) return;
      if (!this.clRowH) this.clRecalc();
      const target = this._monthFirstIdx(this._clDate());
      this.clVisStart = Math.max(0, target - CL_BUFFER);
      this.clScrollTop = target * this.clRowH;
      this._clScrollState(target * this.clRowH);
      this.$nextTick(() => { el.scrollTop = target * this.clRowH; this._clScrollState(target * this.clRowH); });
    },
    _clStepMonth() {
      const el = this.$refs.clMonth; if (!el) return this.clScrollToAnchor();
      if (!this.clRowH) this.clRecalc();
      const smooth = !this.reduceMotion();
      el.scrollTo({ top: Math.max(0, this._monthFirstIdx(this._clDate()) * this.clRowH), behavior: smooth ? 'smooth' : 'auto' });
    },
    clOpenWeekRow(idx) { this.clAnchor = isoDate(this._weekDate(idx)); this.clSetView('week'); },   // tap a week → expand

    // --- WEEK / DAY: a window of 7 pages (anchor ±3), each one viewport page; scroll snaps between them ---
    // ---- Continuous day/week timeline: same methodology as month (fixed-height spacer, absolutely placed
    // blocks, virtualized window, scroll-driven zone titles). Replaces the 7-page mandatory-snap pager. ----
    _periodSpan() { return this.clView === 'day' ? 1 : 7; },
    _dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); },
    _periodIdx(d) { return this.clView === 'day' ? Math.round((this._dayStart(d) - CL_EPOCH) / 86400000) : this._weekIdx(d); },
    _periodDate(idx) { if (this.clView !== 'day') return this._weekDate(idx); const d = new Date(CL_EPOCH); d.setDate(d.getDate() + idx); return d; },
    _periodTotal() { return this.clView === 'day' ? CL_TOTAL_WEEKS * 7 : CL_TOTAL_WEEKS; },
    _periodLabel(d) {
      if (this.clView === 'day') return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const e = new Date(d); e.setDate(e.getDate() + 6);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' + e.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    },
    // A WEEK block is its 24h body — its top border is the 12am rule. A DAY block is a PAGE: the agenda flows
    // from the top, so a 24h-tall block would park the whole list above a viewport scrolled to waking hours.
    // One day fills the scroller exactly, and the rail beside it carries the clock.
    clPeriodH() { return this.clView === 'day' ? this._clDayH() : 24 * (this.clHourH || 40); },
    // one page = the scroller's VISIBLE area: .cl-pages already reserves the chrome with padding-top, so a
    // parked day starts below the header without the agenda insetting itself a second time
    _clDayH() { return Math.max(320, this._clVH() - this._clHeadH() - CL_FOOT); },
    // Pinned head cells: weekday names in month; weekday + DATE of the period currently on top in week view.
    // Dates can't ride the block — in a continuous timeline they'd scroll out of sight almost immediately.
    clHeadCells() {
      if (this.clView !== 'week') return CL_WD.map(n => ({ key: n, name: n }));
      const ps = this._periodDate(this._clTopIdx()), todayIso = isoDate(new Date());
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d);
        return { key: iso, name: CL_WD[d.getDay()], day: d.getDate(), today: iso === todayIso, weekend: d.getDay() === 0 || d.getDay() === 6 };
      });
    },
    _clTopIdx() { return this._tlIdxAt(this.clScrollTop); },
    clPeriodsTotalH() { return CL_TL_SPAN * this.clPeriodH(); },
    _clHeadH() { return CL_BAR + CL_HEAD; },   // every px of pinned chrome the timeline scrolls under (must match --cl-top in CSS)
    _clFitHour() { return Math.max(18, Math.round((this._clVH() - this._clHeadH()) / (CL_WAKING_END - CL_WAKING_START))); },   // a waking day fills the viewport at zoom 1
    _tlSpan() { return Math.min(CL_TL_SPAN, this._periodTotal()); },
    // spacer origin: the anchor sits mid-window. Only ever moved by a jump (open/view switch/step/today),
    // which also re-scrolls — so free scrolling can never shift the ground under the user.
    _tlRebase() { this.clTLView = this.clView; this.clTLBase = Math.max(0, Math.min(this._periodTotal() - this._tlSpan(), this._periodIdx(this._clDate()) - (this._tlSpan() >> 1))); },
    _tlIdxAt(scrollTop) { return Math.max(0, Math.min(this._periodTotal() - 1, this.clTLBase + Math.floor(scrollTop / this.clPeriodH()))); },
    clRecalcPages() {
      const vh = this._clVH() - this._clHeadH();
      if (!this.clHourH) this.clHourH = this._clFitHour();
      this.clPVisCount = Math.ceil(vh / this.clPeriodH()) + 2;
      this._tlRebase();
      this.clPVisStart = Math.max(this.clTLBase, this._periodIdx(this._clDate()) - 1);
    },
    clBlocks() {
      void this.tasks; void this.events; void this.blocks; void this.byId;   // register the data deps BEFORE the memo can short-circuit (like _clGroup) — else a hit records no dep and adds/edits don't repaint
      if (!this.clHourH) this.clRecalcPages();
      const span = this._periodSpan(), todayIso = isoDate(new Date()), ph = this.clPeriodH();
      const base = this.clTLBase, last = Math.min(this._periodTotal(), base + this._tlSpan());
      const start = Math.max(base, this.clPVisStart), end = Math.min(last, start + this.clPVisCount);
      if (end <= start) return [];
      // The view-switch/scroll settle re-fires this effect ~100× against unchanged inputs. Return the SAME array
      // ref on a hit so Alpine's x-for no-ops instead of re-diffing every column/event. _calDataV busts on any data change.
      const sig = this.clView + '|' + base + '|' + start + '|' + end + '|' + this.clHourH + '|' + span + '|' + todayIso + '|' + _calDataV;
      if (_clBlocksSig === sig) return _clBlocksCache;
      const from = this._periodDate(start), toD = this._periodDate(end - 1); toD.setDate(toD.getDate() + span - 1);
      const byDay = this._clGroup(isoDate(from), isoDate(toD));
      const out = [];
      for (let idx = start; idx < end; idx++) {
        const ps = this._periodDate(idx);
        const cols = Array.from({ length: span }, (_, i) => {
          const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d), items = byDay[iso] || [];
          // One drawing level: non-container blocks lane-pack WITH events/tasks (peers cascade); only terrain
          // containers stay a layer behind, and everything inside a container insets past its spine.
          const tRanges = items.filter(it => !it.allDay && it.start.length > 10).map(it => { const sm = this._clMin(it.start), em = Math.max(this._clMin(it.end), sm + 20); return { it, sm, em }; });
          const blocks = this._dayBlocks(iso, tRanges), terrain = blocks.filter(b => b.isContainer);
          const packed = this._lanePack(tRanges, blocks.filter(b => !b.isContainer));
          for (const p of packed) p.inset = Math.max(0, ...terrain.filter(t => t._sm <= p.sm && t._em >= p.em && (t._em - t._sm) > (p.em - p.sm)).map(t => (t.depth + 1) * 14));
          return { iso, day: d.getDate(), today: iso === todayIso, past: iso < todayIso, weekend: d.getDay() === 0 || d.getDay() === 6, label: d.toLocaleDateString([], { weekday: 'short' }), blocks, terrain, packedBlocks: packed.filter(p => p.blk), ...this._clSplitDay(items), timed: packed.filter(p => !p.blk), cleared: this._clCleared(items) };
        });
        // Day stops being a grid, so it has no band layer at all: the agenda gives every mark and every all-day
        // item — including one that merely passes through today — a real row of its own.
        const bands = this._clWeekBands(cols);
        if (span === 1) for (const c of cols) c.agenda = this._clAgenda(c);
        out.push({ key: idx, rel: idx - base, cols, bands });   // top comes from --ph in CSS so it cannot drift from the height
      }
      _clBlocksSig = sig; _clBlocksCache = out; return out;
    },
    // A date-only item is one of two different things, and treating them alike is what broke the old lane.
    // A BAND occupies the day (an all-day event, a task scheduled across days).
    // A MARK is a moment ABOUT the day (a due date, a deadline); it has no width.
    _clSplitDay(items) {
      const ad = items.filter(it => it.allDay || it.start.length <= 10);
      return { bands: ad.filter(it => it.kind === 'event' || it.kind === 'task-block'),
               marks: ad.filter(it => it.kind === 'task-due'),
               // A deadline is the one mark with an HOUR in it — it gets drawn on the timeline, at the moment
               // it bites, rather than filed in the chrome with the whole-day claims.
               deadlines: ad.filter(it => it.kind === 'task-deadline') };
    },
    // ONE entry per band per PAGE, not one chip per column: {c0, len} is the run of columns it covers and `row`
    // its stacking order. Chapter draws the entry directly (a single element spanning its columns — so it cannot
    // disagree with itself, cannot lose its title, and there are no spacer chips to miscount); Terrain filters
    // the same list per column. `openL` means it began before this page, which is what earns the feathered edge.
    _clWeekBands(cols) {
      const seen = new Map(), rowEnd = [], out = [];
      cols.forEach((c, i) => { for (const it of c.bands) {
        const k = it.kind + it.id, e = seen.get(k);
        if (e) { e.len = i - e.c0 + 1; rowEnd[e.row] = i; continue; }
        let r = 0; while (rowEnd[r] >= i) r++;
        rowEnd[r] = i; seen.set(k, out[out.push({ it, c0: i, len: 1, row: r, openL: it.spanStart === false, openR: it.spanEnd === false }) - 1]);
      } });
      return out;
    },
    // Hold to travel. The first CL_HOLD_MS of a held arrow keep nudging at the key's own repeat rate; past it
    // the step becomes a whole PERIOD — a day, a week, a month — because by then you are travelling, not
    // reading. Throttled once escalated, or a ~30/s key repeat would fly a year past you in a second.
    // `e.repeat` is what distinguishes a held key from a fresh press, so a re-press always restarts the clock.
    clArrow(dir, repeat) {
      const now = Date.now();
      if (!repeat || !this._clHold) this._clHold = { t0: now, last: 0 };
      if (now - this._clHold.t0 < CL_HOLD_MS) return this.clNudge(dir);
      if (now - this._clHold.last < CL_HOLD_STEP) return;
      this._clHold.last = now; this.clStep(dir);
    },
    // ↑/↓: one hour in week/day, one week row in month. Smooth, so the move reads as movement and you keep your
    // place; it goes through the same scroller the wheel uses, so the snap and the midnight gate still apply.
    clNudge(dir) {
      const el = this.clView === 'month' ? this.$refs.clMonth : this.$refs.clPages;
      el?.scrollBy({ top: dir * (this.clView === 'month' ? this.clRowH : this.clHourH || 40), behavior: this.reduceMotion() ? 'auto' : 'smooth' });
    },
    clAdFields() { return CL_AD_FIELDS; },
    // How far down the day the deadline bites. Date-only means "by the end of it", so the rule sits at the
    // day's close; the moment deadlines carry a time, the same rule simply moves up to that hour.
    clDlPct(it) { return it.start.length > 10 ? this._clMin(it.start) / 14.4 : 100; },
    clDlWhen(it) { return it.start.length > 10 ? this.fmtTime(it.start.slice(11, 16)) : 'by end of day'; },
    // The rule and its runway live in the column, but the LABEL is chrome pinned above the nav, because a
    // deadline you can scroll past is a deadline you can miss. It cannot simply be `position: sticky`:
    // .cl-period-block sets `contain: paint`, which makes it the containing block for everything inside it,
    // so a sticky descendant sticks to the BLOCK and never to the scroller.
    clDeadlineCols() {
      if (this.clView !== 'week') return [];   // day view is the agenda, which already gives each one a row
      const b = this.clBlocks();
      return (b.find(p => p.key === this._clTopIdx()) || b.find(p => p.key === this._periodIdx(this._clDate())) || b[0] || { cols: [] }).cols;
    },
    clHasDeadlines() { return this.clDeadlineCols().some(c => c.deadlines.length); },
    clChRows(pg) { return pg.bands.reduce((m, b) => Math.max(m, b.row + 1), 0); },       // Chapter: marks start below the bands
    clColBands(pg, i) { return pg.bands.filter(b => b.c0 <= i && i < b.c0 + b.len); },   // Terrain: the fields standing behind THIS column
    clAdInset(pg, i) { return Math.min(CL_AD_FIELDS, this.clColBands(pg, i).length) * 13; },
    // F5: a day you actually finished. Real planned minutes, all of them done — never a count of tasks, which
    // is gameable the moment anyone notices (see "nothing fake" in ui-conventions).
    _clCleared(items) {
      const mine = items.filter(it => it.kind === 'task-block');
      if (!mine.length || !mine.every(it => this.byId.get(it.id)?.completed_at)) return null;
      const mins = mine.reduce((n, it) => n + (this.byId.get(it.id)?.est_minutes || 0), 0);
      return { mins, label: mins ? this._clDur(mins) + ' of planned work, done' : 'Everything you planned, done' };
    },
    _clMin(iso) { const t = timeOf(iso, '00:00'); return (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)); },
    _dayBlocks(iso, timed = []) {
      const all = blocksInRange(this.blocks, iso, iso).map(b => {
        const sm = Math.max(0, this._clMin(b.start)), em = b.end.slice(0, 10) > iso ? 1440 : Math.min(1440, this._clMin(b.end));
        return { id: b.id, title: b.title, color: b.color, topPct: sm / 1440 * 100, hPct: Math.max(1.5, (em - sm) / 1440 * 100), _sm: sm, _em: em };
      });
      // H-presence: A contains B if A fully covers B's range AND is strictly longer (equal ranges are peers,
      // not container+nested). Containment counts events/tasks too — a block holding a lone meeting is still
      // the room it happens in, so it earns the terrain treatment (corollary, 2026-08-01).
      const cont = (A, s, e) => A._sm <= s && A._em >= e && (A._em - A._sm) > (e - s);
      for (const a of all) {
        a.isContainer = all.some(b => b !== a && cont(a, b._sm, b._em)) || timed.some(r => cont(a, r.sm, r.em));
        a.isNested = all.some(b => b !== a && cont(b, a._sm, a._em));
      }
      // Nesting ACCUMULATES: every enclosing terrain costs another 14px of spine, so a container inside a
      // container steps twice and its contents clear BOTH spines. Longest-first so an enclosing depth is ready.
      for (const a of [...all].sort((x, y) => (y._em - y._sm) - (x._em - x._sm)))
        a.depth = Math.max(0, ...all.filter(b => b !== a && b.isContainer && cont(b, a._sm, a._em)).map(b => b.depth + 1));
      return all;
    },
    // H-states-D1: format actual_start timestamp ("2026-08-01T09:15") as "started 9:15am"
    _clFmtActualStart(ts) { if (!ts) return ''; return 'started ' + this.fmtTime(ts.slice(11, 16)); },
    // Height tier drives how much an event can say. Splitting evenly by lane count shrinks a 15-min standup
    // to an unreadable sliver, so overlaps CASCADE instead: each lane steps 14px right and stacks on top,
    // leaving the earlier event fully readable (macOS/Fantastical). Capped so deep stacks don't march away.
    _clTier(mins) { const px = mins * (this.clHourH || 0) / 60; return !px || px >= 40 ? 'full' : px >= 18 ? 'compact' : 'tiny'; },
    _lanePack(ranges, blocks = []) {
      // ranges are prebuilt {it, sm, em}; non-container blocks join the SAME pack so all kinds cascade as peers
      const raw = [...ranges, ...blocks.map(b => ({ it: b, blk: true, sm: b._sm, em: Math.max(b._em, b._sm + 20) }))].sort((a, b) => a.sm - b.sm || a.em - b.em);
      let cluster = [], cend = -1; const out = [];
      const flush = () => {
        if (!cluster.length) return;
        const lanes = [];
        for (const p of cluster) { let k = 0; while (k < lanes.length && lanes[k] > p.sm) k++; lanes[k] = p.em; p.lane = k; }
        // A cascade only reads while the covered item's TITLE still shows above the one stacked on it. Things
        // starting at (or within a title of) the same time leave no such strip — the top one hid the other
        // outright — so concurrent peers SPLIT what's left of the width and only a later start steps right.
        const perMin = (this.clHourH || 60) / 60;
        let grp = [], gend = -1;
        const share = () => { if (grp.length > 1) { const b = Math.min(...grp.map(p => p.lane)); grp.forEach((p, i) => { p.share = [i, grp.length]; p.lane = b; }); } grp = []; };
        for (const p of cluster) {
          if (grp.length && p.sm < gend && (p.sm - grp[0].sm) * perMin < CL_TITLE_PX) grp.push(p);
          else { share(); grp = [p]; gend = -1; }
          gend = Math.max(gend, p.em);
        }
        share();
        for (const p of cluster) out.push({ it: p.it, blk: p.blk, sm: p.sm, em: p.em, topPct: p.sm / 1440 * 100, hPct: (p.em - p.sm) / 1440 * 100, lane: p.lane, share: p.share, offPx: Math.min(p.lane, 4) * 14, tier: this._clTier(p.em - p.sm) });
        cluster = []; cend = -1;
      };
      for (const p of raw) { if (p.sm >= cend && cluster.length) flush(); cluster.push(p); cend = Math.max(cend, p.em); }
      flush(); return out;
    },
    // Cascade fills to the column's right edge (CSS `right`); a concurrent peer keeps the cascade's left edge
    // and takes its share of what remains, so neither title can be covered.
    clEvBox(p) {
      const L = p.inset + p.offPx + 1;
      if (!p.share) return `left:${L}px;`;
      const w = `(100% - ${L + 2}px) / ${p.share[1]}`;
      return `left:calc(${L}px + ${w} * ${p.share[0]});width:calc(${w} - 2px);right:auto;`;
    },
    // C5: rows flow at a readable height; gaps become named free slots; proportion moves to the rail.
    _clAgenda(col) {
      const rows = [];
      let end = -1, n = 0;
      // A deadline is the sharpest thing on a day and it was invisible — a lane row that got clipped. Here it
      // is a row of its own, at the top, before anything you could get lost in.
      for (const it of [...col.deadlines, ...col.marks]) { rows.push({ key: it.kind + it.id, it, mark: true, allday: true, min: 0, mins: 0 }); n++; }
      // ...and an all-day item is simply a thing you are doing today, whether or not it also runs past today
      for (const it of col.bands) { rows.push({ key: it.kind + it.id, it, allday: true, min: 0, mins: 0 }); n++; }
      for (const p of [...col.timed].sort((a, b) => a.topPct - b.topPct || b.hPct - a.hPct)) {
        const min = Math.round(p.topPct * 14.4), mins = Math.max(1, Math.round(p.hPct * 14.4));
        // a timed due/deadline is still a MOMENT: it keeps its time but never claims a duration
        if (this._clIsMark(p.it)) { rows.push({ key: p.it.kind + p.it.id + min, it: p.it, mark: true, min, mins: 0 }); n++; continue; }
        if (end >= 0 && min - end >= CL_AG_GAP) rows.push({ key: 'free' + end, free: true, min: end, mins: min - end });
        rows.push({ key: p.it.kind + p.it.id + min, it: p.it, min, mins });
        end = Math.max(end, min + mins); n++;
      }
      // Rows PACK from the top rather than stretching to fill 24h: an agenda's job is to be read, and a list
      // spaced by real proportion is mostly empty night. Scale stays on the rail, which is why it exists.
      // A packed day would outgrow its own block, and the block height is load-bearing (top = idx * periodH).
      // Shed the subtitle before anything gets clipped — same idea as B1's density tiers.
      return { rows, tier: n * CL_AG_ROW > this._clDayH() - 20 ? 'compact' : 'full' };
    },
    // An agenda row is read on its own, so the time must be unambiguous — "2:00" beside "11:00" reads as 2am.
    clAgTime(m) { return (m % 60 ? this._clHM(m) : ((Math.floor(m / 60) + 11) % 12) + 1) + (m < 720 ? ' AM' : ' PM'); },
    _clIsMark(it) { return it.kind === 'task-due' || it.kind === 'task-deadline'; },
    clAgSub(r) {
      const a = this.areaObjs(this.byId.get(r.it.id)?.area_ids || [])[0];
      // a mark has no length to report, so it says what KIND of moment it is; an all-day item has no length
      // either, and the time column already said "All day" — so it carries only its area, or nothing.
      const lead = r.mark ? (r.it.kind === 'task-deadline' ? 'Deadline' : 'Due') : r.allday ? (r.it.spanStart === false ? 'Continues' : '') : this._clDur(r.mins);
      return lead + (a ? (lead ? ' · ' : '') + a.name : '');
    },
    clHours() { return CL_HOURS; },
    clHourLabel(h) { return h === 0 ? '' : h < 12 ? h + ' AM' : h === 12 ? 'Noon' : (h - 12) + ' PM'; },
    clNowPct() { return this.clNowMin() / 1440 * 100; },
    clNowMin() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); },
    clNowLabel() { return this._clHM(this.clNowMin()); },
    clWakeTop() { return CL_WAKING_START / 24 * 100; },
    _clHM(m) { return `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`; },
    _clDur(m) { return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm'; },
    _clClock(iso) { return this._clHM(this._clMin(iso)); },
    clTimeLabel(it) { return it.allDay ? '' : this._clClock(it.start) + ' – ' + this._clClock(it.end); },
    // clientHeight is 0 on first open — retry until layout settles
    // scroll the anchor period under the chrome, opening at the waking hour
    _clScrollToPeriod(tries = 8) {
      const el = this.$refs.clPages; if (!el) return;
      if (!el.clientHeight) { if (tries > 0) requestAnimationFrame(() => this._clScrollToPeriod(tries - 1)); return; }
      if (!this.clHourH) this.clRecalcPages();
      this._tlRebase();
      // day: the whole day is on one page, so there is no waking-hours offset to scroll past
      const idx = this._periodIdx(this._clDate()), top = (idx - this.clTLBase) * this.clPeriodH() + (this.clView === 'day' ? 0 : CL_WAKING_START * this.clHourH);
      this.clPVisStart = Math.max(this.clTLBase, idx - 1);
      this.clScrollTop = top; this._clPeriodState(top);
      this.$nextTick(() => { this._clTlJump(el, top); this._clPeriodState(top); });
    },
    // A jump we made is not a landing to read a date out of: the browser fires scroll/scrollend for it too, and
    // clPagesScrollEnd would rewrite clAnchor from whatever transient offset it saw (a reset to 0 read as
    // "January 2000"). Mark ours, and let the flag outlive the event.
    _clTlJump(el, top) {
      this._clTlProg = true;
      el.scrollTop = top; this.clScrollTop = el.scrollTop;
      // Spacer height may not have flushed yet → value can be clamped; re-assert after layout.
      // Either way, clear _clTlProg in the rAF so the browser's scrollend event fires while suppressed.
      if (Math.abs(el.scrollTop - top) > 1) requestAnimationFrame(() => { el.scrollTop = top; this.clScrollTop = el.scrollTop; this._clTlProg = false; });
      else requestAnimationFrame(() => { this._clTlProg = false; });
    },
    // E3: a period ARRIVING (view switch, scroll settle, jump) stages its events in. Off-then-on so the
    // animation restarts; the class rides .calendar so every child replays together.
    _clSettle() {
      this.clSettling = false;
      this.$nextTick(() => {
        this.clSettling = true;
        clearTimeout(this._clSettleT); this._clSettleT = setTimeout(() => { this.clSettling = false; }, 450);
      });
    },
    _clPeriodState(scrollTop) {
      const z = this._periodZoneTitles().find(t => t.atBar);
      this.clTopPeriod = z ? z.name : this._periodLabel(this._periodDate(this._tlIdxAt(scrollTop)));
    },
    // Guard: only a scroll of the LIVE timeline may move state — and only once clTLBase belongs to the CURRENT
    // view. Switching day<->week flips clPeriodH/_periodTotal a frame before the rebase, so a scroll landing in
    // that gap reads a day offset against a week base (it once threw the anchor to 2099). A hidden//mid-view-switch scroller emits scroll
    // events with a browser-clamped scrollTop (the spacer resizes as clView/clHourH change), and reading a date
    // out of that once rewrote clAnchor four years off.
    _clLive(el) { return this.clTLView === this.clView && (this.clView === 'week' || this.clView === 'day') && el && el.clientHeight > 0 && this.clHourH > 0; },
    clPagesScroll(e) {
      const el = e.target; if (!this._clLive(el)) return;
      this.clScrollTop = el.scrollTop;
      this.clPVisStart = Math.max(this.clTLBase, this._tlIdxAt(el.scrollTop) - 1);
      this._clPeriodState(el.scrollTop);
      this._clPositionZone();
      this.clScrolling = true; clearTimeout(_clScrollT); _clScrollT = setTimeout(() => { this.clScrolling = false; }, 600);
    },
    // day/week zone titles: every block is a boundary, so each visible block's label rises into the heading
    _periodZoneTitles() {
      const rowH = this.clPeriodH(), head = this._clHeadH(), barY = this._clBarY != null ? this._clBarY : CL_BAR - 34 - 14;
      const zoneH = this._clZoneTop() - head, scrollTop = this.clScrollTop;
      const base = this.clTLBase, first = Math.max(base, this._tlIdxAt(scrollTop) - 1), list = [];
      for (let idx = first; idx <= first + 2; idx++) {
        const vt = head + (idx - base) * rowH - scrollTop;
        if (vt > head + zoneH) continue;
        list.push({ name: this._periodLabel(this._periodDate(idx)), vt });
      }
      return this._zoneLayout(list, head, zoneH, barY);
    },
    // ctrl+wheel vertical zoom: hours expand past viewport so day scrolls
    clPagesWheel(e) {
      if (e.ctrlKey) { if (!e.cancelable) return; e.preventDefault(); this._clZoomTo(Math.max(1, Math.min(4, +(this.clZoom - e.deltaY * 0.01).toFixed(2)))); return; }
      if ((this.clView !== 'day' && this.clView !== 'week') || !e.cancelable) return;
      // A gesture moves WITHIN one period and stops at its edge; the next gesture steps to the neighbour. So
      // every hour stays reachable (scroll up to midnight and it is simply there), you never come to rest
      // straddling two of them, and a trackpad flick can't carry you three days past the one you were reading.
      // We drive the scroll ourselves because CSS snap re-snaps every programmatic write; and since momentum
      // keeps firing wheel events, "one gesture" ends only when the fingers are genuinely done.
      e.preventDefault();
      const el = e.currentTarget, ph = this.clPeriodH(), t = performance.now();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      // Travel inside one period before its far edge is on screen. The scroller reserves the chrome as
      // padding-top, so the VISIBLE height is clientHeight MINUS that — measuring against clientHeight alone
      // left the last chrome-height of every week (11pm→midnight) permanently unreachable.
      const span = Math.max(0, ph - (el.clientHeight - this._clHeadH()));
      const fresh = !this._clGate || t - this._clGateT > CL_GESTURE_GAP;
      this._clGateT = t;
      if (!fresh && this._clGate.turned) return;    // the rest of this gesture is momentum for a turn already made
      if (fresh) {
        const i = Math.floor(el.scrollTop / ph), off = el.scrollTop - i * ph;
        // Crossing a boundary — or a period that exactly fills the viewport, where there is nowhere to travel —
        // is a PAGE TURN, and it must ANIMATE. Clamping to the neighbour instead jumped a whole viewport on the
        // first pixel of scroll: that is the teleport, in week at the edges and in day everywhere.
        const step = span < 2 ? Math.sign(dy) : dy > 0 && off >= span - 1 ? 1 : dy < 0 && off <= 1 ? -1 : 0;
        if (step) {
          this._clGate = { turned: true };
          // down → the next period's top; up → the previous period's FAR edge, so the two stay continuous
          const to = Math.max(0, (i + step) * ph + (step < 0 && span >= 2 ? span : 0));
          el.scrollTo({ top: to, behavior: this.reduceMotion() ? 'auto' : 'smooth' });
          return;
        }
        this._clGate = { lo: i * ph, hi: i * ph + span };
      }
      el.scrollTop = Math.max(this._clGate.lo, Math.min(this._clGate.hi, el.scrollTop + dy));
    },
    // scrollTop means "px into the timeline", so it only means a fixed instant while clPeriodH is fixed —
    // every hour-height change (zoom, resize) has to re-pin it, or the same offset reads as a different date.
    _clZoomTo(z) {
      const el = this.$refs.clPages; if (!el) return;
      const at = el.scrollTop / this.clPeriodH();
      this.clZoom = z; this.clHourH = Math.max(18, Math.round(this._clFitHour() * z));
      this.$nextTick(() => this._clTlJump(el, at * this.clPeriodH()));
    },
    // free scroll + proximity snap (like month) — landing settles the anchor on whatever period is on top
    clPagesScrollEnd(e) {
      if (this._clTlProg || !this._clLive(e.target)) return;
      const iso = isoDate(this._periodDate(this._tlIdxAt(e.target.scrollTop)));
      if (iso !== this.clAnchor) { this.clAnchor = iso; this._clSettle(); }
    },

    // The title IS the date picker in day/week — the same popup the composer uses for a deadline, so the
    // positioning, clamping and month paging are all the tested ones. Week mode picks a WEEK: the whole row
    // highlights, and landing anywhere in it anchors to that week.
    clPopHoverWk: '',
    clOpenDatePop(anchor) {
      if (this.clView !== 'day' && this.clView !== 'week') return;
      this.togglePop('clnav', anchor);
      if (this.pop !== 'clnav') return;
      this.clPopHoverWk = '';
      this._calTo(this.clAnchor);
    },
    _clWkKey(iso) { return isoDate(this._clWeekStart(new Date(iso + 'T00:00'))); },
    clPopSel(iso) { return this.clView === 'week' ? this._clWkKey(iso) === this._clWkKey(this.clAnchor) : iso === this.clAnchor; },
    clPopHot(iso) { return this.clView === 'week' && !!this.clPopHoverWk && this._clWkKey(iso) === this.clPopHoverWk; },
    clPickDate(iso) {
      this.pop = null; this.clPopHoverWk = '';
      this.clAnchor = this.clView === 'week' ? isoDate(this._clWeekStart(new Date(iso + 'T00:00'))) : iso;
      this.clRecalcPages(); this.$nextTick(() => this._clScrollToPeriod());
    },
    clStep(dir, vt) {
      const d = this._clDate(), mo = this.clView === 'month';
      mo ? d.setMonth(d.getMonth() + dir) : d.setDate(d.getDate() + dir * this._periodSpan());
      const set = () => { this.clAnchor = isoDate(d); }, after = () => mo ? this._clStepMonth() : this._clScrollToPeriod();
      if (vt) this._withTransition(set, after);          // Shift+↑/↓ — the same morph a view switch runs
      else { set(); mo ? after() : this.$nextTick(after); }
    },
    clToday() {
      this.clAnchor = isoDate(new Date());
      if (this.clView === 'month') this.clScrollToAnchor();
      else this.$nextTick(() => this._clScrollToPeriod());
    },
    clOpenDay(iso) { this.clAnchor = iso; this.clSetView('day'); },
    // ---- Event editor (create / edit / delete) ----
    clNewEvent(date) { this.eventEdit = { title: '', date: date || this.clAnchor, start: '09:00', end: '10:00', all_day: false, color: null }; },
    clEditEvent(id) {
      const e = this.events.find(x => x.id === id); if (!e) return;
      this.eventEdit = { id: e.id, title: e.title, date: e.starts_at.slice(0, 10), start: timeOf(e.starts_at, '09:00'), end: timeOf(e.ends_at, '10:00'), all_day: !!e.all_day, color: e.color || null };
    },
    clItemClick(it) { if (!it) return; if (it.kind === 'event') return this.clEditEvent(it.id); if (this.clIsTask(it)) return this.clOpenTaskSide(it.id); if (it.start) this.clOpenDay(it.start.slice(0, 10)); },
    clToggleTask(id) { const t = this.byId.get(id); if (t) this.toggle(t); },
    clKeyActivate(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    clChipCls(it) {
      const done = (it.kind === 'task-due' || it.kind === 'task-block' || it.kind === 'task-deadline') && this.byId.get(it.id)?.completed_at ? ' done' : '';
      if (it.spanStart === undefined || this.clView === 'day') return it.kind + done;   // one column ⇒ nothing to join across, so no span caps
      return it.kind + done + ' cl-span' + (it.spanStart ? ' cl-span-l' : '') + (it.spanEnd ? ' cl-span-r' : '') + (!it.spanStart && !it.spanEnd ? ' cl-span-mid' : '');
    },
    clSplitTitle(n) { const m = n.match(/^(.*?),?\s*(\d{4})$/); return m ? [m[1], ' ' + m[2]] : [n, '']; },   // trailing YEAR only — splitting on the first space mangled 'Jul 19 – Jul 25, 2026' down to 'Jul 19'
    clIsTask(it) { return it.kind === 'task-due' || it.kind === 'task-block' || it.kind === 'task-deadline'; },
    // all-day → date-only; never a backwards range; shared by event + block
    _evRange(e, date = e.date) { const end = (!e.all_day && e.end < e.start) ? e.start : e.end; return e.all_day ? { starts_at: date, ends_at: date } : { starts_at: date + 'T' + e.start, ends_at: date + 'T' + end }; },
    _toggleIn(arr, v) { const i = arr.indexOf(v); i < 0 ? arr.push(v) : arr.splice(i, 1); },
    async clSaveEvent() {
      const e = this.eventEdit; if (!e) return;
      const fields = { title: e.title.trim() || 'Untitled', all_day: e.all_day, color: e.color || null, ...this._evRange(e) };
      if (e.id) await this.store.events.update(e.id, fields); else await this.store.events.add(fields);
      await this.loadEvents(); this.eventEdit = null;
    },
    async clDeleteEvent() { const e = this.events.find(x => x.id === this.eventEdit?.id); if (e) await this.perform('Deleted event', { target: 'event', kind: 'delete', id: e.id }); this.eventEdit = null; },

    // --- Blocks: drag a span on the week/day grid to create; click a band to edit ---
    clBlockDragStart(e, iso) {
      if (e.button !== 0 || e.target.closest('.cl-event, .cl-block')) return;   // drag only on empty grid
      const col = e.currentTarget; col.setPointerCapture?.(e.pointerId);
      this._blkDrag = { iso, rect: col.getBoundingClientRect(), y0: e.clientY, y1: e.clientY };
      this.clDragBand = this._blkBand();
    },
    clBlockDragMove(e) { if (!this._blkDrag) return; this._blkDrag.y1 = e.clientY; this.clDragBand = this._blkBand(); },
    clBlockDragEnd() {
      const d = this._blkDrag; this._blkDrag = null; this.clDragBand = null; if (!d) return;
      if (Math.abs(d.y1 - d.y0) < 8) return;   // a click, not a drag → ignore
      const snap = m => Math.round(m / 15) * 15, span = 1440 / d.rect.height;
      const a = Math.max(0, snap((Math.min(d.y0, d.y1) - d.rect.top) * span));
      const b = Math.min(1440, snap((Math.max(d.y0, d.y1) - d.rect.top) * span));
      this.clNewBlock(d.iso, this._fmtMin(a), this._fmtMin(Math.max(a + 15, b)));
    },
    _blkBand() { const d = this._blkDrag, h = d.rect.height; return { iso: d.iso, topPct: (Math.min(d.y0, d.y1) - d.rect.top) / h * 100, hPct: Math.abs(d.y1 - d.y0) / h * 100 }; },

    // --- Drag-to-(re)schedule (HTML5 DnD) — wall-clock local strings, never toISOString (tz shift) ---
    _fmtMin: m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'),
    clDragStart(e, kind, id) {
      if (!kind) return;
      this._clDnd = { kind, id };
      // lift the SOURCE element (the drag image is the browser's; this is the hole it left behind)
      this._clLifted = e.target?.closest?.('.cl-event, .cl-chip, .cl-block, .item');
      this._clLifted?.classList.add('cl-lift');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); }
    },
    clDragEndSchedule() { this._clDnd = null; this.clDropHint = null; this.clDropPreview = null; this._clLifted?.classList.remove('cl-lift'); this._clLifted = null; },
    // F4: what you just placed settles into its slot, so the release reads as a landing and not a repaint
    _clPlaced(id) { this.clPlaced = id; clearTimeout(this._clPlacedT); this._clPlacedT = setTimeout(() => { this.clPlaced = null; }, 420); },
    _dropMin(e) {   // minutes-of-day (snapped 15) when dropped inside a week/day column; null on a month cell
      const col = e.target.closest && e.target.closest('.cl-pcol'); if (!col) return null;
      const r = col.getBoundingClientRect();
      return Math.max(0, Math.min(1425, Math.round((e.clientY - r.top) / r.height * 96) * 15));
    },
    // sizes the preview ghost; events/blocks keep their length, tasks use est_minutes
    _dragDurMin() {
      const d = this._clDnd; if (!d) return 60;
      if (d.kind === 'event' || d.kind === 'block') { const it = (d.kind === 'event' ? this.events : this.blocks).find(x => x.id === d.id); return it && !it.all_day ? Math.max(15, this._clMin(it.ends_at) - this._clMin(it.starts_at)) : 60; }
      if (d.kind === 'task') return this.byId.get(d.id)?.est_minutes || 60;
      return 60;   // due chip → a default marker height
    },
    clDropOver(e, iso) {
      if (!this._clDnd) return;
      const min = this._dropMin(e);
      this.clDropHint = null;   // timed preview and the all-day/month highlight are mutually exclusive
      this.clDropPreview = min == null ? null : { iso, min, h: this._dragDurMin(), label: this._clHM(min) + (min < 720 ? ' AM' : ' PM') };   // snap readout keeps :00 — precision is the point
      edgeScrollStep(e.target?.closest?.('.cl-pages, .cl-month'), e.clientY);
    },
    _dndKind(kind) { return kind === 'task-deadline' ? 'deadline' : kind === 'event' ? 'event' : kind === 'task-due' ? 'due' : kind === 'block' ? 'block' : 'task'; },
    async clDropOn(e, iso, allDay = false) {   // allDay: dropped into the week/day all-day row → make it all-day
      const d = this._clDnd; this._clDnd = null; this.clDropHint = null; this.clDropPreview = null;
      this._clLifted?.classList.remove('cl-lift'); this._clLifted = null;
      if (!d || !iso) return;
      this._clPlaced(d.id);
      const dm = allDay ? null : this._dropMin(e);   // null ⇒ month cell or all-day row (date only)
      const stamp = dm == null ? iso : iso + 'T' + this._fmtMin(dm);
      if (d.kind === 'task' || d.kind === 'due' || d.kind === 'deadline') {
        if (d.kind === 'deadline') {
          await this.perform('Rescheduled deadline', { kind: 'update', target: 'task', id: d.id, after: { deadline_at: stamp } });
        } else {
          if (d.kind === 'task') {
            const blockBand = e.target?.closest?.('.cl-block');
            if (blockBand?.dataset?.id) {
              const block = this.blocks.find(x => x.id === blockBand.dataset.id);
              await this.store.scheduleItems.add({ task_id: d.id, block_id: blockBand.dataset.id });
              this.scheduleItems = await this.store.scheduleItems.list();
              this.toast('Attached to ' + (block?.title || 'block'));
              return;
            }
          }
          await this.store.tasks.update(d.id, d.kind === 'due' ? { due_at: stamp } : { scheduled_at: stamp });
          await this.loadTasks();
        }
      } else {
        const it = (d.kind === 'event' ? this.events : this.blocks).find(x => x.id === d.id); if (!it) return;
        let fields;
        if (allDay || it.all_day) {   // dropped into the all-day row, or moving an already-all-day item
          const days = it.all_day ? Math.round((new Date(it.ends_at.slice(0, 10)) - new Date(it.starts_at.slice(0, 10))) / 86400000) : 0;
          const end = new Date(iso + 'T00:00:00'); end.setDate(end.getDate() + days);   // local parse (not UTC) so the day doesn't drift
          fields = { all_day: true, starts_at: iso, ends_at: isoDate(end) };
        } else {
          const dur = Math.max(15, this._clMin(it.ends_at) - this._clMin(it.starts_at));   // same-day duration, preserved
          const startMin = dm != null ? dm : this._clMin(it.starts_at);                     // dropped time, else keep tod
          fields = { starts_at: iso + 'T' + this._fmtMin(startMin), ends_at: iso + 'T' + this._fmtMin(Math.min(1439, startMin + dur)) };
        }
        await (d.kind === 'event' ? this.store.events : this.store.blocks).update(d.id, fields);
        d.kind === 'event' ? await this.loadEvents() : await this.loadBlocks();
      }
    },
    // no date at all, newest first; cap for perf
    clUnscheduled() {
      return this.tasks.filter(t => this._openLeaf(t) && !t.scheduled_at && !t.due_at)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 50);
    },
    _clNowBounds() { const now = new Date(), today = isoDate(now); return { today, at: today + 'T' + hhmm(now) }; },
    _overdue(t, b) { return t.scheduled_at ? (t.scheduled_at.length > 10 ? t.scheduled_at < b.at : t.scheduled_at.slice(0, 10) < b.today) : (t.due_at ? t.due_at.slice(0, 10) < b.today : false); },
    // local wall-clock, never UTC
    clReschedule() {
      void this._nowTickV;   // refresh as the clock passes each task's time
      const b = this._clNowBounds();
      return this.tasks.filter(t => this._openLeaf(t) && this._overdue(t, b))
        .sort((a, b) => (a.scheduled_at || a.due_at || '').localeCompare(b.scheduled_at || b.due_at || ''));
    },
    clReschedListHtml() { return this._clListHtml('res', this.clReschedule(), isoDate(new Date()) + '|' + this._nowTickV); },
    clSideVisible() { return this.clSideOpen || this.clView === 'day'; },   // the panel is up in day view (auto) or when toggled
    _clRowsHtml(tasks) {
      const now = new Date(), byId = this.byId, def = this.store.defaultProject(), byParent = buildByParent(this.tasks);
      let s = '';
      for (const t of tasks) {
        // due_at carries a time component (>10 chars) only when a specific due time was set; scheduled time wins the slot if both exist
        const schedTime = t.scheduled_at?.length > 10 ? this._clTime(t.scheduled_at) : null;
        s += this._itemLi(this.mkRow(t, 0, byParent, byId, def, now), { drag: ' draggable="true"', schedTime });
      }
      return s;
    },
    // x-effect re-runs on every tick — cache to avoid rebuilds on scroll
    _clListHtml(kind, tasks, sig) {
      return _memo(_clListMemo, kind + '|' + this._rowV + '|' + sig, () => this._clRowsHtml(tasks), 6);
    },
    clUnschedListHtml() { return this._clListHtml('un', this.clUnscheduled(), ''); },
    clRowClick(e) { const el = e.target.closest && e.target.closest('.item'); const t = el && this.byId.get(el.dataset.id); if (t) this.onRowClick({ t }, e); },
    clSideDragStart(e) { const el = e.target.closest && e.target.closest('.item'); if (el) this.clDragStart(e, 'task', el.dataset.id); },
    clOpenTaskSide(id) { const t = this.byId.get(id); if (!t) return; this.clSideOpen = true; this.$nextTick(() => this.editTask(t)); },
    clBlockWeekdays() { return [{ d: 0, l: 'S' }, { d: 1, l: 'M' }, { d: 2, l: 'T' }, { d: 3, l: 'W' }, { d: 4, l: 'T' }, { d: 5, l: 'F' }, { d: 6, l: 'S' }]; },
    clNewBlock(date, start, end) { this.blockEdit = { date: date || this.clAnchor, start: start || '09:00', end: end || '10:00', all_day: false, weekdays: [], location_id: null, areas: [], energy: null, availability: null, color: null, title: '', est_minutes: null }; },
    clEditBlock(id) {
      const b = this.blocks.find(x => x.id === id); if (!b) return;
      this.blockEdit = { id: b.id, title: b.title || '', date: b.starts_at.slice(0, 10), start: timeOf(b.starts_at, '09:00'), end: timeOf(b.ends_at, '10:00'), all_day: !!b.all_day,
        weekdays: (b.recurrence?.weekdays || []).slice(), location_id: b.location_id || null, areas: (b.areas || []).slice(), energy: b.energy || null, availability: b.availability || null, color: b.color || null, est_minutes: b.est_minutes ?? null };
    },
    async clSaveBlock() {
      const e = this.blockEdit; if (!e) return;
      let date = e.date, recurrence = null;
      if (e.weekdays.length) {   // weekly: anchor on the first selected weekday on/after the chosen date so expansion is correct
        const wds = e.weekdays.slice().sort((a, b) => a - b), d0 = new Date(date + 'T00:00');
        for (let i = 0; i < 7 && !wds.includes(d0.getDay()); i++) d0.setDate(d0.getDate() + 1);
        date = isoDate(d0); recurrence = { freq: 'week', interval: 1, weekdays: wds };
      }
      const est_minutes = e.est_minutes === '' || e.est_minutes == null ? null : +e.est_minutes;
      const { est_minutes: _em, ...core } = { title: e.title.trim(), all_day: e.all_day, recurrence, location_id: e.location_id || null, areas: e.areas, energy: e.energy || null, availability: e.availability || null, color: e.color || null, est_minutes, ...this._evRange(e, date) };
      if (e.id) await this.store.blocks.update(e.id, { ...core, est_minutes });
      else {
        const b = await this.store.blocks.add(core);   // est_minutes is update-only until db:apply (unknown column fails the whole insert)…
        if (b && est_minutes != null) await this.store.blocks.update(b.id, { est_minutes });   // …but the create path must still WRITE it
      }
      await this.loadBlocks(); this.blockEdit = null;
    },
    async clDeleteBlock() { const b = this.blocks.find(x => x.id === this.blockEdit?.id); if (b) await this.perform('Deleted block', { target: 'block', kind: 'delete', id: b.id }); this.blockEdit = null; },
    clBlockPreset(p) {
      const pre = { work: { title: 'Work', start: '08:15', end: '16:30', weekdays: [1,2,3,4,5], est_minutes: null }, lunch: { title: 'Lunch', start: '12:00', end: '13:00', weekdays: [1,2,3,4,5], est_minutes: 15 }, evening: { title: 'Evening', start: '18:00', end: '22:00', weekdays: [], est_minutes: null } }[p];
      if (!pre || !this.blockEdit) return;
      Object.assign(this.blockEdit, pre);
    },
    clAttachedTasks() { const id = this.blockEdit?.id; if (!id) return []; return this.scheduleItems.filter(s => s.block_id === id); },
    async clCycleRole(itemId) {
      const item = this.scheduleItems.find(x => x.id === itemId); if (!item) return;
      await this.store.scheduleItems.setRole(itemId, { before: 'during', during: 'after', after: 'before' }[item.role] || 'during');
      this.scheduleItems = await this.store.scheduleItems.list();
    },
    async clRemoveAttached(itemId) { await this.store.scheduleItems.remove(itemId); this.scheduleItems = await this.store.scheduleItems.list(); },

    // --- Block day (start-ask answered from the web; the phone writes the same rows) ---
    clBlockOccursToday(b) {
      if (!b || b.all_day) return false;
      const today = new Date();
      if (!b.recurrence) return b.starts_at?.slice(0, 10) === isoDate(today);
      const { freq, weekdays, month_day } = b.recurrence;
      if (freq === 'day') return true;
      if (freq === 'week') return (weekdays || []).includes(today.getDay());
      if (freq === 'month') return today.getDate() === (month_day ?? new Date(b.starts_at || '').getDate());
      return false;
    },
    clBlockDay(blockId) { const d = isoDate(new Date()); return this.blockDays.find(x => x.block_id === blockId && x.date === d) || null; },
    async clSetBlockDay(blockId, fields) {
      await this.store.blockDays.set({ block_id: blockId, date: isoDate(new Date()), ...fields });
      this.blockDays = await this.store.blockDays.list();
    },
    clStartBlock(blockId) { const n = new Date(); return this.clSetBlockDay(blockId, { status: 'running', actual_start: `${isoDate(n)}T${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}` }); },
    clSkipBlock(blockId) { return this.clSetBlockDay(blockId, { status: 'skipped' }); },
    clUndoBlockDay(blockId) { return this.clSetBlockDay(blockId, { status: 'pending', actual_start: null }); },
    // Lead = first incomplete during-attachment fitting capacity (mirrors the Android blockLead pick).
    clBlockLead(blockId) {
      const cap = this.blocks.find(b => b.id === blockId)?.est_minutes ?? null;
      return this.scheduleItems.filter(s => s.block_id === blockId && s.role === 'during')
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(s => this.tasks.find(t => t.id === s.task_id))
        .find(t => t && !t.completed_at && (cap == null || t.est_minutes == null || t.est_minutes <= cap)) || null;
    },

    // ---- Cloud sync (Supabase adapter, opt-in via magic link). LocalStore stays the offline default. ----
    async reloadAll() {
      if (this.store.requiresAuth && !this.session) return;   // cloud adapter: wait until signed in
      const b = await this.store.bootstrap();   // ONE round-trip (cloud): the whole account in a single query
      this.areas = b.areas; this.goals = b.goals;
      this.tasks = b.tasks; this.byId = new Map(b.tasks.map(t => [t.id, t])); this.parentIds = new Set(b.tasks.map(t => t.parent_id).filter(Boolean));   // ← list renders (reactive) from here
      this.filters = b.filters; this.locations = b.locations; this.travel = b.travel;
      _clBlocksSig = null;   // bust memo before reactive write so the flush sees the new blocks array
      this.events = b.events; this.blocks = b.blocks;
      this.scheduleItems = await this.store.scheduleItems.list();
      this.blockDays = await this.store.blockDays.list();
      this.homeLocationId = this.store.homeLocationId(); this.currentRegion = this.store.currentRegion();
      this._rowV++; _calDataV++; _goalStepsMemo.clear(); _goalMilestonesMemo.clear();
      await this.loadIdentities();
      // stats derivation is synchronous — paint the list first before blocking
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await this.loadStats();
    },

    async signIn() {
      const sb = sbClient(); if (!sb) return;
      if (!this.authEmail) { this.authMsg = 'Enter your email first.'; this.authErr = true; return; }
      // password filled → direct sign-in, no email round-trip
      if (this.authPass) {
        const { error } = await sb.auth.signInWithPassword({ email: this.authEmail, password: this.authPass });
        this.authMsg = error ? error.message : ''; this.authErr = !!error;
        if (!error) this.authPass = '';   // success: onAuthStateChange takes over
        return;
      }
      // one email carries both a link and a 6-digit code (templates: pg_mail/mail/mail.js); shouldCreateUser:false blocks new-account creation
      const { error } = await sb.auth.signInWithOtp({ email: this.authEmail, options: { emailRedirectTo: location.href, shouldCreateUser: false } });
      this.authMsg = error ? error.message : 'Tap the link in the email, or enter its code below.';
      this.authErr = !!error;
      this.authSent = !error;
    },
    async verifyCode() {
      const sb = sbClient(); if (!sb || !this.authCode) return;
      const { error } = await sb.auth.verifyOtp({ email: this.authEmail, token: this.authCode.trim(), type: 'email' });
      if (error) { this.authMsg = error.message; this.authErr = true; }   // stay on the code form; onAuthStateChange handles success
      this.authCode = '';
    },
    // Optional second path for phone sign-in — the emailed code already works without it
    async setAppPassword() {
      const sb = sbClient(); if (!sb || !this.authPass) return;
      const { error } = await sb.auth.updateUser({ password: this.authPass });
      this.authMsg = error ? error.message : 'Password saved — use it to sign in on your phone.';
      this.authErr = !!error;
      if (!error) this.authPass = '';
    },
    // Supabase re-emits SIGNED_IN on every tab focus — only uid change or sign-out recreates the store
    async onAuth(session) {
      const prevUid = this.session?.user?.id ?? null, nextUid = session?.user?.id ?? null;
      this.session = session;
      if (nextUid === prevUid) return;
      this.store.unsubscribe?.();   // tear down the old adapter's realtime channel before swapping
      this.store = session ? createSupabaseStore(sbClient()) : createLocalStore();
      this.authSent = false; this.authEmail = ''; this.authCode = '';
      await this.reloadAll();
      this._subscribeStore();       // re-arm realtime on the new store
    },
    // realtime → app: a 'tasks' change re-pulls the task list, an 'areas' change re-pulls areas (both off the warm cache)
    _subscribeStore() { this.store.subscribe?.((kind) => kind === 'areas' ? this.loadAreas() : this.loadTasks()); },
    async signOut() { const sb = sbClient(); if (sb) await sb.auth.signOut(); },   // onAuthStateChange → onAuth(null) swaps to LocalStore

    // ---- Account & settings popup (corner gear). Sign-in/phone reuse the auth machine above; surfaces + theme persist locally. ----
    settingsOpen: false,
    phoneOpen: false,                 // Connections → Phone row unfolded in place
    online: navigator.onLine,         // gear status dot + account-row sub (listeners live on the popup markup)
    theme: localStorage.getItem('adherod.theme') || 'system',
    dayTint: localStorage.getItem('adherod.dayTint') !== '0',   // time-of-day tint on the week/day columns (NB: daypart() is the Now Room's clock — don't shadow it)
    setDayTint(v) { this.dayTint = v; localStorage.setItem('adherod.dayTint', v ? '1' : '0'); },
    // How a whole-day claim is drawn in week view. Both replaced the pinned strip (which cost 66px of chrome on
    // every week, empty or not); they fail in opposite directions, so this is a real A/B and not a preference.
    clAdMode: localStorage.getItem('adherod.clAdMode') === 'terrain' ? 'terrain' : 'chapter',
    setClAdMode(v) { this.clAdMode = v; localStorage.setItem('adherod.clAdMode', v); },
    // Wipe this device's local copy and reload — the escape hatch when local storage is stale (e.g. a re-seeded
    // demo won't overwrite existing data). Signed-in accounts re-sync from the cloud; local-only data is gone.
    resetLocalData() {
      this.askConfirm({
        message: this.session
          ? "Clear this device's local copy? Your account data stays in the cloud and re-syncs when the page reloads."
          : "Delete everything stored on this device? This can't be undone.",
        confirmLabel: 'Delete', danger: true,
        onConfirm: () => {
          for (const k of Object.keys(localStorage)) if (k.startsWith('adherod.')) localStorage.removeItem(k);
          location.reload();
        },
      });
    },
    toggleSurface(s) {   // strike/unstrike a surface chip — never deleted; at least one stays lit
      const off = this.surfOff.includes(s) ? this.surfOff.filter(x => x !== s) : [...this.surfOff, s];
      if (off.length === this.surfAll.length) return;
      this.surfOff = off;
      this.surfaceOrder = this.surfAll.filter(x => !off.includes(x));
      if (!this.surfaceOrder.includes(this.surface)) this.goSurface(this.surfaceOrder[0]);
      localStorage.setItem('adherod.surfaces', JSON.stringify({ order: this.surfAll, off }));
    },
    setTheme(t) {   // 'light'|'system'|'dark' — honest override: re-inject the token vars + color-scheme; system removes it
      this.theme = t;
      t === 'system' ? localStorage.removeItem('adherod.theme') : localStorage.setItem('adherod.theme', t);
      let el = document.getElementById('theme-override');
      if (t === 'system') { el?.remove(); delete document.documentElement.dataset.theme; return; }
      if (!el) { el = document.createElement('style'); el.id = 'theme-override'; document.head.appendChild(el); }
      el.textContent = `:root{${_vars(DESIGN[t])}}`;   // later in <head> than #design-tokens → wins both scheme directions
      document.documentElement.dataset.theme = t;      // drives color-scheme + the one scheme-keyed rule (see styles.css)
    },
  }));
});
