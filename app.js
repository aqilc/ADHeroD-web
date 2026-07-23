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

import { createLocalStore, descendantIds, projectDepth, subtreeDepth, nextOccurrence, nextAcrossRules, recRules, effectiveGoalIds, MAX_DEPTH } from './store.js';
import { goalProgress, goalWarmth, homeWarmth, firstShowUpDay, HEARTH, goalLaneFull, laneComparator, goalArc, finishReady } from './stats.js';
import { parseDateText, parseRecurrence, quickDate, quickRange, isoDate, dueBadge, windowBadge, deadlineLeft, matchTrailingToken, classifyToken, tokenizeAll, parseLogNote, recurrenceLabel, logDayLabel } from './nlp.js';
import { markTitle, makeFuzzy, fuzzyRank } from './search.js';
import { calendarItems, blocksInRange, daypartOf, eventsFirst, planAgenda, occurrencesInRange } from './calendar.js';
import { esc as escHtml, mdLive as mdLiveRender, chkLive as chkLiveRender, byDone, raw, taskRowHtml, taskListHtml as taskListMarkup, dotStripHtml as dotStripMarkup, rollerBoxHtml as rollerBoxMarkup, rowBodyHtml, mdTitle as mdTitleFn } from './ui.js';
import { makeSortable } from './sortable.js';
import { SUPABASE, SURFACES } from './config.js';
// landing surface: now when present (local default), else lists, else the leftmost of the trimmed set
const SURF_HOME = !SURFACES || SURFACES.includes('now') ? 'now' : SURFACES.includes('lists') ? 'lists' : SURFACES[0];
import { createSupabaseStore } from './supabase-store.js';

// null when unconfigured → stays on LocalStore (UMD bundle sets globalThis.supabase at init).
let _sb;
const sbClient = () => { if (_sb === undefined) _sb = (globalThis.supabase && SUPABASE.url) ? globalThis.supabase.createClient(SUPABASE.url, SUPABASE.anonKey) : null; return _sb; };

// Module-scope: kept outside Alpine state so render reads/writes don't loop. _calDataV busts on any task/event change.
const CL_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CL_HOURS = Array.from({ length: 24 }, (_, h) => h);
const CL_WAKING_START = 8;   // default waking day start (h); future: from sleep data
const CL_WAKING_END = 24;    // waking day end (h)
const CL_EPOCH = new Date(2000, 0, 2);   // a (local) Sunday — week 0 of the virtual timeline
const CL_TOTAL_WEEKS = 5217;             // ~100 years: a fixed scroll height (no reflow) ⇒ effectively infinite
const CL_BUFFER = 10;                     // weeks rendered beyond the viewport each side (blank-free on fast flings)
const CL_BAR = 90, CL_HEAD = 32;          // overlaid toolbar + weekday-header heights (must match --bar/--head in CSS)
const _calMemo = new Map();
const _groupMemo = new Map();   // byDay cache; busts on any task/event change
const _clListMemo = new Map();   // keyed on kind|_rowV|range — Map hit on scroll/nav instead of rebuild
let _calDataV = 0, _clRecenter = false, _clScrollT;
const _goalStepsMemo = new Map();   // per-goal id, unlike _calMemo's single-entry; same _calDataV bust
const _goalMilestonesMemo = new Map();   // all milestone tasks incl. completed
const ARC_LATE = 0.67;   // project arc threshold: above this pct, status line foregrounds the goal/why
const UNDO_MAX = 100;   // oldest drop past this
const IDENTITY_WHO_RE = /^i(?:'m| am)\s+someone who\s+/i;   // shared strip prefix for identity statements
// visibleRows() memo: O(n) tree walk called many times per render; cache on _rowV+navSel+listQ so drag/animation don't recompute per frame.
let _visMemo = null, _visKey = '', _doneMemo = [];   // _doneMemo: completed rows for the section below the add-task button
// Raw DOM refs — kept outside Alpine state so they're never proxied.
let _hoverEls = [], _fitQ = 0, _dropEl = null, _kbEl = null;
let _nowFocusEl = null;   // refocused on back/Escape

// Activity memo keyed on _activityV (bumped by every loadStats call) — logGoal/addGoalNote refresh via loadStats alone, so _calDataV would go stale.
let _activityV = 0;
const _goalLogMemo = new Map(), _goalLastActiveMemo = new Map();
const _recentMemo = new Map();   // home-wide, keyed on _activityV alone
const _identVotesMemo = new Map();   // keyed on ident.id+'|'+_activityV

// local HH:MM — shared by log-when-popover defaults
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

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
    authOpen: false, authEmail: '', authCode: '', authSent: false, authMsg: '', authPass: '',
    tasks: [],
    byId: new Map(),        // id → task, rebuilt in loadTasks → O(1) lookups (projName/blocked) instead of tasks.find
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
    graduateOffer: null,    // id of the goal shown in the "let it run?" dialog; null = closed
    graduatingGoal: null,   // transient: id of the goal playing the graduation celebration (~2050ms, full .graduating choreography)
    _graduatingT: null,     // graduating timeout id, reset each time so a rapid re-graduate doesn't clear early
    finishOffer: null,      // id of the goal shown in the finish dialog; null = closed
    msBeatGid: null,        // transient: id of the goal showing the milestone reorientation line (~1400ms)
    _msBeatT: null,         // msBeat timeout id
    reflectGoal: null,      // GS15: id of the goal shown in the "sit with this?" reflection dialog; null = closed
    logWhenOpen: null,      // GS13: id of the goal whose "log at a specific time" pop is open; null = closed
    logWhenT1: '', logWhenT2: '', logWhenDT: '',   // pop inputs: earlier-today time, yesterday time, pick datetime-local
    toastMsg: '', toastOn: false, _toastT: null,   // transient bottom toast (e.g. +1 identity vote)
    undo: { on: false, label: '', stack: [], timer: null },   // multi-level buffer: up to UNDO_MAX tasks+activity snapshots
    chipGlintId: null, _chipGlintT: null,   // GS9: task id whose goal chip briefly glints warm on completion
    goalOpenId: null,       // inline-expand: ID of the goal whose composer is currently open; null = all collapsed
    _newGoalId: null,       // FIX6: id of a just-created goal via newGoalComposer; removed on Cancel if left untouched
    logWhenNote: '',        // FIX8: optional "what did you do" note for a show-up log; cleared after logging
    goalDraft: null,        // {name,identity,targets,target_date,favorite,color,icon} while a goal composer is open
    _identSugSel: -1,       // keyboard-selected suggestion index (-1 = none)
    _identSugFocus: false,  // textarea focus flag (drives pop visibility)
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
    plan: [],               // server-materialized auto-plan rows (plan_items) — VIEW state only, never mutates tasks; empty offline/local-store
    clView: 'month',        // calendar view: day | week | month | year
    clSideOpen: false, clDropHint: null,   // Plan side-panel (scheduled + unscheduled + composer) toggle + drop-hover day iso
    clDropPreview: null,   // { iso, min, h, label } — live ghost of where a drag will land in a week/day column
    clAnchor: isoDate(new Date()),   // calendar anchor date (YYYY-MM-DD); drives the visible period
    clRowH: 0,              // month week-row height in px = (viewport − bar − header) / 6 (macOS: 6 weeks fill the page)
    clVisStart: 0,          // index of the first virtualized week row currently rendered
    clVisCount: 0,          // number of week rows rendered (visible + buffer); the rest is empty spacer
    clTopMonth: '',         // scroll-driven month label for the toolbar period (month view)
    clScrolling: false,     // true briefly during/after scroll → month bands visible; idle → they fade out
    clScrollTop: 0,         // drives band rise/fade in clMonthBands
    clFocusYM: null,        // dominant month at center — others dim when idle
    clZoom: 1,              // 1 = whole day fits; >1 scrolls
    clHourH: 0,             // px per hour when zoomed (0 = fit)
    eventEdit: null,        // null = closed
    blockEdit: null,        // null = closed
    clDragBand: null,       // preview while drag-creating a block
    currentLocationId: null,
    homeLocationId: null,   // designated home place (mirror of store)
    currentRegion: 'Home',
    locMgr: false,
    travelPair: { from: '', to: '', min: 20 },
    travel: [],
    navSel: { type: 'all', id: null },
    // --- Spatial-canvas spine: top-level surface ∈ surfaceOrder; navSel keeps the Lists inner selection ---
    surfaceOrder: SURFACES ?? ['lists', 'plan', 'now', 'goals'],   // Now centered (index 2), flanked by Plan/Goals; SURFACES trims the deployed shell
    surface: SURF_HOME,
    visited: { [SURF_HOME]: true },   // lazy-mount memory — heavy surfaces (Plan) mount on first visit, stay mounted
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
    draft: { content: '', notes: '', priority: 4, due_at: '', due_from: '', deadline_at: '', durH: 0, durM: 0, dateText: '', dueTime: '', project: null, project_id: null, areas: [], goal_ids: [], checklist: [], recurrence: null, location: { mode: 'any', ids: [] } },
    composer: { open: false },
    palette: { open: false, q: '', sel: 0 },
    listQ: '',          // ⌘K escalates to palette
    showCompleted: false,   // view-controls toggle; completed tasks hidden by default, persisted to localStorage
    sortBy: 'manual',   // Lists sort: manual|due|priority|alpha|created|deadline (manual = drag/position order); persisted
    sortDir: 'asc',     // asc|desc — ignored for manual
    listMenu: null,     // open toolbar dropdown: 'sort'|'pri'|'area'|'due'|null (kept separate from the composer's `pop`)
    qfPri: [],          // quick-filter: priorities to keep (1..4); empty = all
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
    _rowV: 0,           // visibleRows() memo key — bump on any task/area/goal/collapse change
    dragId: null,
    railList: [],           // move-rail drop targets, populated while a task row is dragged
    railHot: null,          // rail target currently under the drag (kind+id), for the tint highlight
    _t: null,
    pop: null,
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
    addingRootProject: false,
    newRootName: '',
    deletingProject: null,
    deleteTarget: null,
    deleteProjMode: 'move',   // 'move' (reparent tasks inside) | 'delete' (cascade the whole subtree)
    deleteSub: null,          // { id, source } — task-with-subtasks being deleted (composer trash / subtask row)
    deleteSubMode: 'move',    // 'move' (reparent subtasks) | 'delete' (cascade)
    deleteSubTarget: null,    // destination id when moving subtasks
    // Global color list (user-extendable via settings later) + the gray default for areas with no color.
    colors: DESIGN.palette,
    L: DESIGN.lang.labels,
    areaDefault: '#9aa0a6',
    areaIcons: ['i-tag-tag','i-tag-home','i-tag-briefcase','i-tag-star','i-tag-heart','i-tag-book','i-tag-cart','i-tag-dollar','i-tag-code','i-tag-dumbbell','i-tag-plane','i-tag-bell','i-tag-flame','i-tag-leaf','i-tag-music','i-tag-map','i-tag-zap','i-tag-globe','i-tag-camera','i-tag-gift'],
    relStaged: null,
    relType: 'blocked_by',
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
      const sb = sbClient();
      if (sb) {
        const { data } = await sb.auth.getSession();
        if (data.session) { this.session = data.session; this.store = createSupabaseStore(sb); }
        sb.auth.onAuthStateChange((e, session) => { if (e !== 'INITIAL_SESSION') this.onAuth(session); });
      }
      await this.reloadAll();
      this._subscribeStore();     // activate realtime sync (no-op on LocalStore/tests)
      setInterval(() => { this._nowTickV++; }, 60000);   // keeps the Now-window's now-line/leave-by honest with the real clock
      document.addEventListener('selectionchange', () => this._chkSelTint());   // checklist cross-row selection tint
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
    surfaceLabel(s) { const M = {lists:'Lists',plan:'Plan',now:'Now',goals:'Goals'}; return M[s] || s; },
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
    onOverviewWheel(e) {
      const s = this._ovd = this._ovd || {};
      const now = performance.now(), gap = now - (s.t || 0); s.t = now;
      if (e.deltaY <= 0) { s.accum = 0; return; }          // scrolling up → reset
      // a nested list (the project/area/location roller) that can still scroll DOWN owns the gesture — don't dismiss
      for (let n = e.target; n && n !== e.currentTarget; n = n.parentElement) {
        if (n.nodeType !== 1) continue;
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight - n.clientHeight > 2 && n.scrollTop < n.scrollHeight - n.clientHeight - 1) { s.accum = 0; return; }
      }
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
      if (e.deltaY < 0) {
        for (let n = e.target; n && n !== sc; n = n.parentElement) {
          if (n.nodeType !== 1) continue;
          const oy = getComputedStyle(n).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return;
        }
      }
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
      for (let n = e.target; n && n !== e.currentTarget; n = n.parentElement) {                      // defer ONLY to a real horizontal scroller that can still scroll (not text overflow)
        if (n.nodeType !== 1) continue;
        const ox = getComputedStyle(n).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth - n.clientWidth > 2) {
          const max = n.scrollWidth - n.clientWidth;
          if ((e.deltaX < 0 && n.scrollLeft > 0) || (e.deltaX > 0 && n.scrollLeft < max)) return;
        }
      }
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
    hasChildren(id) { return this.tasks.some(t => t.parent_id === id); },
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
    qfActive() { return this.qfPri.length > 0 || this.qfAreas.length > 0 || !!this.qfDue || this.qfArchived; },
    filtering() { return !!this.listQ.trim() || this.qfActive(); },   // narrowing active → show matches + ancestor context
    qfPass(t) {
      if (this.qfPri.length && !this.qfPri.includes(Math.min(t.priority ?? 4, 4))) return false;   // 4 levels; legacy P5 clamps to P4
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
      : by === 'priority' ? (a, b) => (Math.min(a.priority ?? 4, 4)) - (Math.min(b.priority ?? 4, 4)) || (a.due_at || FAR).localeCompare(b.due_at || FAR)
      : by === 'created'  ? (a, b) => (a.created_at || '').localeCompare(b.created_at || '')
      :                     (a, b) => (a.content || '').localeCompare(b.content || '', undefined, { sensitivity: 'base' });   // alpha
      return (a, b) => dir * base(a, b) || (a.position ?? 0) - (b.position ?? 0);
    },
    _saveView() { localStorage.setItem('adherod.list.view', JSON.stringify({ sortBy: this.sortBy, sortDir: this.sortDir, qfPri: this.qfPri, qfAreas: this.qfAreas, qfDue: this.qfDue, qfArchived: this.qfArchived })); },
    sortLabel() { return ({ manual: 'Manual', due: 'Due date', priority: 'Priority', alpha: 'Alphabetical', created: 'Date added', deadline: 'Deadline' })[this.sortBy]; },
    setSort(key) { if (this.sortBy === key && key !== 'manual') this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'; else { this.sortBy = key; this.sortDir = 'asc'; } this._saveView(); },
    toggleQfPri(p) { const i = this.qfPri.indexOf(p); i < 0 ? this.qfPri.push(p) : this.qfPri.splice(i, 1); this._saveView(); },
    toggleQfArea(id) { const i = this.qfAreas.indexOf(id); i < 0 ? this.qfAreas.push(id) : this.qfAreas.splice(i, 1); this._saveView(); },
    setQfDue(v) { this.qfDue = this.qfDue === v ? null : v; this._saveView(); },
    toggleQfArchived() { this.qfArchived = !this.qfArchived; this._saveView(); },
    clearQf() { this.qfPri = []; this.qfAreas = []; this.qfDue = null; this.qfArchived = false; this._saveView(); },
    // Only offer priority levels that actually appear on tasks (+ any currently selected, so they stay unselectable-visible)
    // — e.g. P5 stays hidden until a P5 task exists. Uses the composer's P1–P5 chips.
    availPri() {
      const s = new Set(this.qfPri);
      for (const t of this.tasks) s.add(Math.min(t.priority ?? 4, 4));   // every task has an effective 1..4 (legacy P5 → P4)
      return [...s].sort((a, b) => a - b);
    },
    visibleRows() {
      // Reads here register Alpine deps so the x-for re-runs on change. Completed rows split into _doneMemo (rendered below the add button).
      const key = this._rowV + '|' + this.navSel.type + '|' + this.navSel.id + '|' + this.listQ + '|' + this.showCompleted
        + '|' + this.sortBy + this.sortDir + '|' + this.qfPri + '|' + this.qfAreas + '|' + this.qfDue + '|' + this.qfArchived;
      if (_visKey === key) return _visMemo;
      const filtering = this.filtering();
      const now = new Date(), byId = this.byId, def = this.store.defaultProject();
      // Children index (O(n)) — drives the tree walk AND each row's childCount/progress without per-row filters.
      const byParent = buildByParent(this.tasks);
      const cmp = this.sibCmp();
      if (cmp) for (const arr of byParent.values()) arr.sort(cmp);   // sort siblings within each parent; manual leaves position order
      const edMemo = new Map();
      const mkRow = (t, depth) => this.mkRow(t, depth, byParent, byId, def, now, edMemo);
      const out = [], done = [], archv = [];   // active rows (main list) + completed + archived (both below the add button, archived after done)
      // Archived quick-filter: a flat "seen alone" view of every archived task (dash rows), across the account.
      if (this.qfArchived) {
        let rows = this.tasks.filter(t => t.archived_at && !this.isSidebar(t) && t.id !== def && this.rowPass(t));
        if (cmp) rows = rows.slice().sort(cmp); else rows.sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));
        rows.forEach(t => out.push(mkRow(t, 0)));
        for (let k = 0; k < out.length; k++) { out[k].prevId = out[k - 1]?.t.id; out[k].prevPid = out[k - 1]?.t.parent_id; out[k].nextId = out[k + 1]?.t.id; out[k].nextPid = out[k + 1]?.t.parent_id; }
        _visKey = key; _visMemo = out; _doneMemo = []; return out;
      }
      const sink = (r) => { if (r.t.completed_at) { if (this.showCompleted) done.push(r); } else if (r.t.archived_at) { if (this.showCompleted) archv.push(r); } else out.push(r); };
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
        // a completed root + its whole subtree → the Done list, kept tree-structured (so subtasks show, indented)
        const visitDone = (t, depth) => { done.push(mkRow(t, depth)); for (const c of (byParent.get(t.id) || [])) visitDone(c, depth + 1); };
        const visitArch = (t, depth) => { archv.push(mkRow(t, depth)); for (const c of (byParent.get(t.id) || [])) visitArch(c, depth + 1); };
        const visit = (t, depth) => {
          if (keep && !keep.has(t.id)) return;
          // A completed/archived ROOT (+ its subtree) goes to the Done section (archived after done). A completed/archived
          // SUBTASK under an ACTIVE parent stays inline (struck / dashed) so it keeps its place in the tree.
          if (t.completed_at && depth === 0) { if (this.showCompleted) visitDone(t, 0); return; }
          if (t.archived_at && depth === 0) { if (this.showCompleted) visitArch(t, 0); return; }
          out.push(mkRow(t, depth));
          if (this.isSidebar(t) && depth > 0) return;
          if (!filtering && this.collapsed[t.id]) return;   // searching/filtering reveals matches regardless of collapse
          for (const c of (byParent.get(t.id) || [])) visit(c, depth + 1);
        };
        let roots = this.scopeRoots();
        if (cmp) roots = roots.slice().sort(cmp);
        for (const r of roots) visit(r, 0);
      }
      // Done section = completed rows, then archived rows (dash) grouped after.
      const doneAll = done.concat(archv);
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
    // Rows → one <li> html string. completedRows() always carry completed_at OR archived_at, so the trailing '' never fires there.
    _rowsHtml(rows, drag = '') {
      let s = '';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], t = r.t;
        const style = 'order:' + (i * 2) + ';padding-left:calc(18px + ' + (r.depth * 22) + 'px);--d:' + r.depth;
        s += '<li class="item' + (t.completed_at ? ' done' : t.archived_at ? ' archived' : '') + '" data-id="' + t.id + '" style="' + style + '"' + drag + '>' + this.rowBody(r) + '</li>';
      }
      return s;
    },
    doneHtml() { return this._rowsHtml(this.completedRows()); },
    // ONE html string via x-html (mounting ~900 x-for scopes was ~1s; one innerHTML parse is ~50ms). hover/drag/kbfocus are delegated+imperative so they never trigger a rebuild.
    // Pure over visibleRows() — deliberately does NOT read `editing`, so opening the composer never rebuilds the
    // list (a rebuild recreates every row, drops content-visibility size memory, and teleports the scroll).
    // The edited-row crossfade + subtree-hide are applied imperatively by applyEditDom().
    listHtml() { return this._rowsHtml(this.visibleRows(), this.navSel.type !== 'area' ? ' draggable="true"' : ''); },
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
      const dueB = (t.due_from || t.due_at) ? windowBadge(t, now) : null;
      return {
        t, depth, pc: this.pc(t.priority), collapsed: !!this.collapsed[t.id],
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
        blocked: (t.blocked_by ?? []).some(id => { const b = byId.get(id); return b && !b.completed_at && !b.archived_at; }),
      };
    },
    nowRows() {
      const now = new Date(), today = isoDate(now), byId = this.byId, def = this.store.defaultProject();
      const byParent = buildByParent(this.tasks, false);
      const edMemo = new Map();
      return this.tasks
        .filter(t => !t.completed_at && !t.archived_at && !this.isSidebar(t) && t.due_at && t.due_at.slice(0, 10) <= today)
        .sort((a, b) => (a.due_at || '').localeCompare(b.due_at || '') || (Math.min(a.priority ?? 4, 4)) - (Math.min(b.priority ?? 4, 4)))
        .map(t => this.mkRow(t, 0, byParent, byId, def, now, edMemo));
    },
    nowListRows() { const hero = this.nowTask(); return this.nowRows().filter(r => r.t.id !== hero?.id); },
    // Keyboard focus over the visible list rows (j/k/↑↓ move; Enter/e open; x/Space complete).
    moveFocus(d) {
      const rows = this.visibleRows().filter(r => r.t);
      if (!rows.length) { this._setKbFocus(null); return; }
      const cur = rows.findIndex(r => r.t.id === this.focusId);
      const next = cur < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + d));
      this._setKbFocus(rows[next].t.id);
    },
    focusedTask() { return this.byId.get(this.focusId); },
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
    async saveRename(p, name) {
      name = name.trim(); this.navRename = null;
      if (!name || name === p.content) return;
      if (await this.store.tasks.update(p.id, { content: name })) await this.loadTasks();
    },
    async patchTask(id, fields) { if (await this.store.tasks.update(id, fields)) await this.loadTasks(); this.navPop = null; },
    async patchArea(id, fields) { if (await this.store.areas.update(id, fields)) await this.loadAreas(); this.navPop = null; },
    // The nav settings popover renders at the overview level (not inside the clipping roller) — resolve its entity here.
    navPopProj() { return this.navPop?.type === 'proj' ? this.byId.get(this.navPop.id) : null; },
    navPopArea() { return this.navPop?.type === 'area' ? this.areas.find(l => l.id === this.navPop.id) : null; },
    async deleteArea(id) {
      this.navPop = null;
      if (this.navSel.type === 'area' && this.navSel.id === id) this.setNav('all');
      this.pushUndo('Deleted area');
      if (await this.store.areas.remove(id)) {
        await this.loadAreas();
        await this.loadTasks();
      }
    },
    async confirmAddRoot() {
      const name = this.newRootName.trim();
      this.addingRootProject = false; this.newRootName = '';
      if (!name) return;
      const project = await this.store.tasks.create({ content: name, parent_id: null, sidebar: true });
      if (!project) return;
      await this.loadTasks();
      this.setNav('project', project.id);
    },
    descendantCount(id) { return id ? descendantIds(this.tasks, id).length - 1 : 0; },   // tasks INSIDE (excl. the project itself)
    deletionTargets() {
      if (!this.deletingProject) return [];
      const excluded = descendantIds(this.tasks, this.deletingProject);
      return this.tasks.filter(p => !excluded.includes(p.id) && this.hasChildren(p.id));
    },
    startDeleteProject(id) {
      this.navPop = null;
      const project = this.byId.get(id);
      this.deletingProject = id;
      this.deleteProjMode = 'move';
      const excluded = descendantIds(this.tasks, id);
      const candidates = this.tasks.filter(x => !excluded.includes(x.id));
      const parentInList = project && project.parent_id && candidates.find(x => x.id === project.parent_id);
      this.deleteTarget = parentInList ? project.parent_id : (candidates[0] && candidates[0].id) || null;
    },
    async confirmDeleteProject() {
      const id = this.deletingProject, mode = this.deleteProjMode, target = this.deleteTarget;
      this.deletingProject = null; this.deleteTarget = null;
      if (!id || (mode === 'move' && !target)) return;
      if (this.navSel.type === 'project' && descendantIds(this.tasks, id).includes(this.navSel.id)) this.setNav('all');
      if (mode === 'delete') {
        this.pushUndo('Deleted project + tasks');
        for (const tid of [...descendantIds(this.tasks, id)].reverse()) await this.store.tasks.remove(tid);   // leaves→root
        await this.loadTasks();
      } else if (await this.store.tasks.remove(id, target)) await this.loadTasks();
    },

    // top/bottom 30% = above/below, middle = into; "into" downgrades at MAX_DEPTH
    _dropMode(e, overId, dragId) {
      const rect = e.currentTarget.getBoundingClientRect(), y = e.clientY - rect.top, h = rect.height;
      let mode = y < h * 0.3 ? 'above' : y > h * 0.7 ? 'below' : 'into';
      if (mode === 'into' && projectDepth(this.tasks, overId) + subtreeDepth(this.tasks, dragId) > MAX_DEPTH) mode = y < h * 0.5 ? 'above' : 'below';
      return mode;
    },

    resetDraft() {
      this.draft = { content: '', notes: '', priority: 4, due_at: '', due_from: '', deadline_at: '', durH: 0, durM: 0, dateText: '', dueTime: '', project: null, project_id: null, areas: [], goal_ids: [], checklist: [], recurrence: null, location: { mode: 'any', ids: [] } };
      this.pickerQ = ''; this.newAreaName = ''; this.projRequired = false; this.subGhost = ''; this.chkGhost = ''; this.endPicking = false; this.tpop = false;
      this.areaPicker = { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 };
      this.goalPicker = { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 };
      this._noPillOnce = false;   // the un-chip→no-re-pill guard is per-session; never leak it across composer opens
    },
    pc(p) { return `var(--p${p >= 1 && p <= 4 ? p : 4})`; },   // 4 levels; legacy P5 clamps to P4 (both = lowest)
    durMinNow() { return this.draft.durH * 60 + this.draft.durM; },
    durLabel() { return this.durMinNow() ? this.durFmt(this.durMinNow()) : 'Dur'; },
    setDur(min) { this.draft.durH = Math.floor(min / 60); this.draft.durM = min % 60; this.scrollWheels(); },
    scrollWheels() {
      this.$nextTick(() => {
        if (this.$refs.wheelH) this.$refs.wheelH.scrollTop = this.draft.durH * 30;
        if (this.$refs.wheelM) this.$refs.wheelM.scrollTop = (this.draft.durM / 5) * 30;
      });
    },
    openDur() { this.togglePop('dur'); if (this.pop === 'dur') this.scrollWheels(); },

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
        const c = this.$refs.content; c?.focus({ preventScroll: true });
        // Editing → caret at the END of the title (ready to append a chip); adding starts empty so it's moot.
        if (c && this.editing) { const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        const comp = this.$refs.composer;
        if (comp) {
          const smooth = !this.reduceMotion();
          comp.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
          // Interruptible: mark the smooth scroll in-flight so the first keystroke can cancel it (editorKeydown).
          if (smooth) { this._composerScrolling = true; clearTimeout(this._scrollSettleT); this._scrollSettleT = setTimeout(() => { this._composerScrolling = false; }, 500); }
          // The first scroll ran while the composer was still mid-grow (small), so a composer that grows below the
          // fold stays cut off. After the grow settles, scroll DOWN just enough to reveal its bottom (Save/Cancel).
          // Down-only: never scroll up — that would fight the caret and jar the list's scroll position on a mid-list open.
          clearTimeout(this._revealT);
          this._revealT = setTimeout(() => {
            if (!this.composer.open || (smooth && !this._composerScrolling)) return;
            const el = this.$refs.composer; if (!el) return;
            let sc = el.parentElement; while (sc && sc.scrollHeight <= sc.clientHeight + 1 && sc !== document.body) sc = sc.parentElement;
            if (!sc || sc === document.body) return;
            const cr = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
            // Taller than the view: revealing the bottom would push the title off-screen — align the TOP instead.
            if (cr.height > sc.clientHeight) { sc.scrollBy({ top: cr.top - sr.top - 8, behavior: smooth ? 'smooth' : 'auto' }); return; }
            const overhang = cr.bottom - sr.bottom;
            if (overhang > 4) sc.scrollBy({ top: overhang + 12, behavior: smooth ? 'smooth' : 'auto' });
          }, smooth ? 300 : 0);
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
    startAdd() { this.editing = null; this._editDescs = null; this.resetDraft(); this.openComposer(); },
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
    esc(s) { return escHtml(s); },
    // x-html; relation picker + cascade-complete use the same markup (ui.js)
    taskLine(t, markedTitle) {
      return taskRowHtml({
        priorityColor: this.pc(t.priority),
        title: markedTitle != null ? raw(markedTitle) : raw(mdTitleFn(t.content)),
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        projName: this.projName(t.parent_id) || '',
        done: !!t.completed_at,
      });
    },
    // x-html; click delegated via openFromTaskList(ev)
    taskListHtml(tasks, opts = {}) {
      return taskListMarkup((tasks || []).map(t => ({ id: t.id, line: this.taskLine(t), milestone: t.milestone })), opts);
    },
    openFromTaskList(ev, after) { const id = ev.target.closest('.task-line')?.dataset.tid; if (id) { this.openTaskById(id); after && after(); } },
    // static body — shell <li> keeps reactive bindings
    rowBody(r, opts) { return rowBodyHtml(r, { navType: this.navSel.type, glintId: this.chipGlintId, ...opts }); },
    // body is inert x-html — delegate here; editTask measures .item
    onRowClick(r, e) {
      if (e.target.closest('a')) return;   // markdown link — let the browser follow it
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'collapse') return this.toggleTaskCollapse(r.t.id);
      if (act === 'check') return this.toggle(r.t);
      // the checkbox OR its text toggles a checklist item; empty space falls through to editTask (composer)
      const chk = e.target.closest('.chk-rect, .chk-txt')?.closest('.chk-row');
      if (chk) return this.toggleChk(r.t.id, +chk.dataset.ci);
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
      if (descendantIds(this.tasks, this.dragId).includes(t.id)) { this.taskDropHint = null; this._setDropInto(null); return; }
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
      const gi = rows.findIndex(r => r.t && r.t.id === h.id);
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
    async drop(t) {
      const hint = this.taskDropHint, dragId = this.dragId;
      this.taskDropHint = null; this.dragId = null; this._clearDrag();
      if (!hint || !dragId) return;
      if (hint.mode === 'outdent') {   // reparent to grandparent, just after the former parent
        const dt = this.byId.get(dragId);
        const par = dt && this.byId.get(dt.parent_id);
        if (!par || par.sidebar) return;
        this.pushUndo('Moved');
        const newParentId = par.parent_id ?? null;
        const sibs = this.tasks.filter(x => x.parent_id === newParentId && x.id !== dragId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const insertAt = sibs.findIndex(x => x.id === par.id) + 1;
        sibs.splice(insertAt, 0, { id: dragId });
        if (await this.store.tasks.move(dragId, newParentId, insertAt)) await this.store.tasks.reorder(sibs.map(x => x.id));
        await this.loadTasks();
        return;
      }
      if (hint.id === dragId) return;
      const target = this.byId.get(hint.id);
      if (!target) return;
      const _dragTask = this.byId.get(dragId);
      const _isReorder = (hint.mode === 'above' || hint.mode === 'below') && !!_dragTask && (_dragTask.parent_id ?? null) === (target.parent_id ?? null);
      this.pushUndo(_isReorder ? 'Reordered' : 'Moved');
      if (hint.mode === 'into') {
        const children = this.tasks.filter(x => x.parent_id === target.id);
        const toIndex = children.length ? Math.max(...children.map(x => x.position)) + 1 : 0;
        if (await this.store.tasks.move(dragId, target.id, toIndex))
          await this.store.tasks.reorder([...children.map(x => x.id), dragId]);
      } else {
        const parentId = target.parent_id ?? null;
        const siblings = this.tasks.filter(x => x.parent_id === parentId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const ordered = siblings.filter(x => x.id !== dragId);
        const targetIdx = ordered.findIndex(x => x.id === target.id);
        const insertAt = hint.mode === 'above' ? targetIdx : targetIdx + 1;
        ordered.splice(insertAt, 0, { id: dragId });
        if (await this.store.tasks.move(dragId, parentId, insertAt)) await this.store.tasks.reorder(ordered.map(x => x.id));
      }
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
      if (kind === 'area') {   // areas are tags (many-to-many), not parents — add the tag, keep existing
        const ids = t.area_ids || [];
        if (ids.includes(id)) return;
        this.pushUndo('Moved');
        if (await this.store.tasks.update(dragId, { area_ids: [...ids, id] })) await this.loadTasks();
        return;
      }
      const parentId = kind === 'backlog' ? this.store.defaultProject() : id;
      if (parentId === dragId) return;   // can't file a project under itself
      const sibs = this.tasks.filter(x => (x.parent_id ?? null) === (parentId ?? null) && x.id !== dragId);
      const toIndex = sibs.length ? Math.max(...sibs.map(x => x.position ?? 0)) + 1 : 0;   // bottom of the project
      this.pushUndo('Moved');
      if (await this.store.tasks.move(dragId, parentId, toIndex)) await this.store.tasks.reorder([...sibs.map(x => x.id), dragId]);
      await this.loadTasks();
    },
    async deleteEditing() {
      const task = this.byId.get(this.editing);
      if (task) {
        if (this.askDeleteTask(task.id, 'editing')) return;   // has subtasks → the prompt finishes the job (incl. closing)
        this.pushUndo('Deleted');
        const ok = await this.store.tasks.remove(task.id);    // leaf: no reparent target needed
        if (ok) {
          this.tasks = this.tasks.filter(x => x.id !== task.id);
          await this.loadTasks();
        }
      }
      this.closeComposer();
    },
    // Task 26 — deleting a task that has subtasks asks: delete them too, or move them to a destination
    // (default = the parent's parent, i.e. the deleted task's parent; the top-level project if none).
    // Returns true when it opened the prompt (the caller must stop and let the dialog finish the op).
    askDeleteTask(id, source) {
      if (!this.hasChildren(id)) return false;
      const task = this.byId.get(id); if (!task) return false;
      this.deleteSub = { id, source, count: descendantIds(this.tasks, id).length - 1 };   // descendants (excl. the task itself)
      this.deleteSubMode = 'move';
      this.deleteSubTarget = (task.parent_id && this.byId.has(task.parent_id)) ? task.parent_id : this.store.defaultProject();
      return true;
    },
    // Valid move destinations: any container (project/parent) that isn't the deleted task or its subtree.
    deleteSubTargets() {
      const info = this.deleteSub; if (!info) return [];
      const excluded = [info.id, ...descendantIds(this.tasks, info.id)], def = this.store.defaultProject();
      return this.tasks.filter(p => !excluded.includes(p.id) && (p.id === def || p.sidebar || this.hasChildren(p.id)));
    },
    async confirmDeleteTask() {
      const info = this.deleteSub, mode = this.deleteSubMode, target = this.deleteSubTarget;
      this.deleteSub = null;
      if (!info) return;
      // ONE undo entry for the whole op (snapshot before) — undo restores the task AND its subtasks.
      this.pushUndo(mode === 'delete' ? 'Deleted task' : 'Deleted task, moved subtasks');
      if (mode === 'delete') {
        // descendantIds includes the task itself; reversed BFS = leaves→root so each removes with no children left
        for (const tid of [...descendantIds(this.tasks, info.id)].reverse()) await this.store.tasks.remove(tid);
      } else {
        await this.store.tasks.remove(info.id, target);   // reparents direct subtasks (with their subtrees), removes the task
      }
      await this.loadTasks();
      if (info.source === 'editing') this.closeComposer();
    },
    closeComposer() {
      this.pop = null;
      const end = this.editing ? this.blockH : 0;
      this._growClose(() => this.$refs.grow, end, () => { this.composer.open = false; this.editing = null; this._editDescs = null; this.resetDraft(); this.applyEditDom(); });
    },
    composerMt() { return (this.editing ? -this.startH : 0) + 'px'; },
    editDone() { const t = this.byId.get(this.editing); return !!(t && t.completed_at); },
    toggleEditing() { const t = this.byId.get(this.editing); if (t) this.toggle(t); },
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
      const min = t.est_minutes || 0;
      this.draft = {
        content: t.content, notes: t.notes || '', priority: Math.min(t.priority ?? 4, 4),   // legacy P5 → P4 on edit (lazy migration)
        due_at: (t.due_at || '').slice(0, 10),
        due_from: t.due_from || '',
        dueTime: (t.due_at && t.due_at.length > 10) ? t.due_at.slice(11, 16) : '',
        deadline_at: (t.deadline_at || '').slice(0, 10),
        durH: Math.floor(min / 60), durM: min % 60, dateText: '',
        project: this.projName(t.parent_id) || null, project_id: t.parent_id || null, areas: this.areaObjs(t.area_ids).map(l => l.name), goal_ids: [...(t.goal_ids || [])], checklist: (t.checklist || []).map(c => ({ ...c })).sort(byDone), recurrence: t.recurrence ? JSON.parse(JSON.stringify(t.recurrence)) : null,
        location: t.location ? { ...t.location, ids: [...(t.location.ids || [])] } : { mode: 'any', ids: [] },
      };
      this.editing = t.id;
      this._editDescs = new Set(descendantIds(this.tasks, t.id).slice(1));   // O(1) hiddenInEdit checks (reactive :style)
      this.pop = null;
      this.relStaged = null; this.relType = 'blocked_by'; this.pickerQ = '';
      this.openComposer();
    },
    // sidebar project → navigate, not edit
    openTaskById(id) { const t = this.byId.get(id); if (!t) return; this.isSidebar(t) ? this.setNav('project', t.id) : this.editTask(t); },
    navTargets() {   // non-corpus palette targets: surfaces + filters + goals + action commands
      const SURF = { now: ['Now', 'i-clock'], plan: ['Plan', 'i-cal'], lists: ['Lists', 'i-all'], goals: ['Goals', 'i-target'] };
      const t = this.surfaceOrder.map(s => ({ kind: 'nav', type: 'surface', id: s, title: SURF[s][0], icon: SURF[s][1] }));
      for (const f of this.filters) t.push({ kind: 'nav', type: 'filter', id: f.id, title: f.name, color: f.color || 'var(--muted)' });
      for (const g of this.goals.filter(x => !x.archived)) t.push({ kind: 'nav', type: 'goal', id: g.id, title: g.name, icon: 'i-target' });
      t.push(
        { kind: 'cmd', type: 'command', id: 'new-task', title: 'New task', icon: 'i-edit', kw: 'add create' },
        { kind: 'cmd', type: 'command', id: 'new-project', title: 'New project', icon: 'i-promote', kw: 'add create' },
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
      else if (id === 'new-project') { this.goSurface('lists'); this.addingRootProject = true; this.newRootName = ''; this.$nextTick(() => this.$refs.newRootInput?.focus()); }
      else if (id === 'new-goal') { this.setNav('goals'); this.newGoalComposer(); }
      else if (id === 'new-filter') { this.openFilterEditor(); }
      else if (id === 'save-filter') this.saveQueryAsFilter();
      else if (id === 'today') { this.setNav('calendar'); this.$nextTick(() => this.clToday && this.clToday()); }
      else if (id === 'locations') { this.locMgr = true; this.loadLocations(); }
    },
    draftFields() {
      const d = this.draft;
      const fields = {
        content: d.content.trim(),
        notes: d.notes || null, priority: d.priority,
        due_at: d.due_at ? (d.dueTime ? d.due_at + 'T' + d.dueTime : d.due_at) : null,
        due_from: d.due_from || null,
        deadline_at: d.deadline_at || null,
        est_minutes: this.durMinNow() || null,
        project: d.project || null,
        areas: d.areas?.length ? d.areas : null,
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

    togglePop(name) {
      this.pop = this.pop === name ? null : name;
      if (this.pop) this.$nextTick(() => {
        const open = [...document.querySelectorAll('.composer .pop')].find(p => getComputedStyle(p).display !== 'none');
        if (open) { this.clampX(open); open.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      });
    },
    // translateX preserves each popover's anchor; max-width CSS cap guarantees it fits in vw
    clampX(el) {
      if (!el) return;
      el.style.transform = '';   // reset before measuring so a reopen/reposition never compounds an old shift
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
    toggleArea(name) { const i = this.draft.areas.indexOf(name); if (i >= 0) this.draft.areas.splice(i, 1); else this.draft.areas.push(name); },
    async createAndToggleArea() {
      const name = this.newAreaName.trim(); if (!name) return;
      const existing = this.areas.find(l => l.name === name);
      if (!existing) await this.store.areas.create({ name });
      await this.loadAreas();
      if (!this.draft.areas.includes(name)) this.draft.areas.push(name);
      this.newAreaName = '';
    },
    endPicking: false, tpop: false, tpopStyle: '', hdrPulse: false, repIdx: 0,
    repRules() { return recRules(this.draft.recurrence); },
    // the statement the spatial controls act on (headers, ordinals, time popover) — last-touched zone
    curRule() { const rs = this.repRules(); return rs[Math.min(this.repIdx, rs.length - 1)] || null; },
    openDate(name) {
      this.togglePop(name);
      if (this.pop !== name) return;
      this.endPicking = false; this.tpop = false;
      const cur = name === 'due' ? this.draft.due_at : this.draft.deadline_at;
      const d = cur ? new Date(cur + 'T00:00') : new Date();
      this.cal = { y: d.getFullYear(), m: d.getMonth() };
      this.$nextTick(() => this.$refs[name === 'due' ? 'dueType' : 'dlType']?.focus());   // typing goes straight to the field
    },
    // Recompute the next-occurrence due whenever the recurrence rule changes (anchored at the current due, else today).
    refreshRecurrenceDue() {
      if (!this.repRules().length) return;
      // An existing due date (even a past one) is the rule's ANCHOR — never overwrite it; only seed when empty.
      if (this.draft.due_at) {
        const d = new Date(this.draft.due_at.slice(0, 10) + 'T00:00'); this.cal = { y: d.getFullYear(), m: d.getMonth() };
        return;
      }
      const b = nextAcrossRules(this.draft.recurrence, isoDate(new Date()), new Date(), { inclusive: true });
      if (!b) return;
      this.draft.due_at = b.iso;
      const d = new Date(b.iso + 'T00:00'); this.cal = { y: d.getFullYear(), m: d.getMonth() };
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
      const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const anchor = new Date((this.draft.due_at || isoDate(new Date())).slice(0, 10) + 'T00:00');
      if (r.freq === 'week') return r.weekdays?.length ? r.weekdays.map(i => WD[i]).join(' ') : WD[anchor.getDay()];
      if (r.freq === 'month') { const n = r.month_day || anchor.getDate(); return 'the ' + n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }
      if (r.freq === 'year') return anchor.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return null;
    },
    pulseWeekdays() { this.hdrPulse = true; setTimeout(() => { this.hdrPulse = false; }, 700); },
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
      if (this.pop === 'due') { const r = quickRange(key, new Date()); this.draft.due_from = r.from; this.draft.due_at = r.to; }
      else this.draft.deadline_at = quickDate(key);
      this.pop = null;
    },
    quickActive(key) { const r = quickRange(key, new Date()); return !!this.draft.due_at && this.draft.due_at.slice(0, 10) === r.to && (this.draft.due_from || '').slice(0, 10) === r.from; },
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
        this.draft[this.pop === 'due' ? 'due_at' : 'deadline_at'] = iso;
        if (time && this.pop === 'due') this.draft.dueTime = time;
        const d = new Date(iso + 'T00:00'); this.cal = { y: d.getFullYear(), m: d.getMonth() };
      }
      if (close) { this.draft.dateText = ''; this.pop = null; }
    },
    dueLabel() {
      // Recurring: show each rule + its ending (until <date> / N×) so a repeat's end is visible on the
      // button without opening the picker; every rule in a multi-repeat carries its own end.
      const rs = this.repRules();
      if (rs.length) {
        const lbl = r => this.recurrenceLabel(r) + (r.ends?.date ? ' · until ' + this.fmt(r.ends.date) : r.ends?.count ? ' · ' + r.ends.count + '×' : '');
        return rs.map(lbl).join(' + ');
      }
      if (!this.draft.due_at) return 'Date';
      return this.fmt(this.draft.due_at) + (this.draft.dueTime ? ' ' + this.fmtTime(this.draft.dueTime) : '');
    },
    recurrenceLabel(rec) { return recurrenceLabel(rec); },
    // --- Inline-pill editor (contenteditable title) ---
    // draft.content = the editor's TEXT nodes only (pills excluded), whitespace-collapsed. WYSIWYG: this
    // is the title verbatim; fields come only from pills (Task 3), never a submit-time re-parse.
    syncTitle() {
      const el = this.$refs.content; if (!el) return;
      this.draft.content = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
      this.titleEmpty = !el.querySelector('.nlp-pill') && this.draft.content === '';
      if (this.titleEmpty && el.childNodes.length) {     // emptied (stray <br>/whitespace) → reset clean, caret to start
        el.textContent = '';
        const r = document.createRange(); r.setStart(el, 0); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
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
    onDescInput(e) {
      if (e && e.isComposing) return;                 // don't re-render mid-IME-composition
      const el = this.$refs.desc; if (!el) return;
      const text = el.textContent;
      this.draft.notes = text;
      const off = this._caretOffset(el), html = this._descHtml(text);
      if (el.innerHTML !== html) { el.innerHTML = html; this._setCaret(el, off); }
    },
    descKeydown(e) {
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
        if (n + len >= off) { const r = document.createRange(); r.setStart(node, off - n); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
        n += len;
      }
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    },
    pillLabel(kind, value) {
      if (kind === 'pri') return 'P' + value;
      if (kind === 'dur') return this.durFmt(value);
      if (kind === 'proj') return '#' + value;
      if (kind === 'area') return '@' + value;
      if (kind === 'goal') return '🔥 ' + (this.goalById(value)?.name || '');
      if (kind === 'loc') return '📍 ' + value;
      if (kind === 'rec') return this.recurrenceLabel(value);
      if (kind === 'deadline') { const b = dueBadge(value.iso); return '⚑ ' + b.label; }
      // date: a due badge when dated, else the bare time
      if (value.iso) { const b = dueBadge(value.iso); return b.label + (value.time ? ' ' + this.fmtTime(value.time) : ''); }
      return this.fmtTime(value.time);
    },
    commitPill(kind, value) {
      const d = this.draft;
      if (kind === 'pri') d.priority = value;
      else if (kind === 'dur') this.setDur(value);
      else if (kind === 'proj') { d.project = value; d.project_id = null; this.projRequired = false; }
      else if (kind === 'area') { if (!d.areas.includes(value)) d.areas.push(value); }
      else if (kind === 'goal') { if (!d.goal_ids.includes(value)) d.goal_ids.push(value); }
      else if (kind === 'loc') {
        const neg = /^away from /i.test(value), nm = String(value).replace(/^away from /i, '');
        const l = this.locByName(nm);
        d.location = { mode: neg ? 'except' : 'only', ids: l ? [l.id] : [] };
      }
      else if (kind === 'rec') { d.recurrence = value; this.refreshRecurrenceDue(); }
      else if (kind === 'deadline') d.deadline_at = value.iso;
      else if (kind === 'date') { d.due_at = value.iso || d.due_at || isoDate(new Date()); if (value.iso) d.due_from = value.from ?? null; if (value.time) d.dueTime = value.time; }
    },
    // Revert the field a removed pill had set. `raw` is the pill's data-value (string form).
    clearPillField(kind, raw) {
      const d = this.draft;
      if (kind === 'pri') d.priority = 5;
      else if (kind === 'dur') { d.durH = 0; d.durM = 0; }
      else if (kind === 'proj') d.project = null;
      else if (kind === 'area') { const i = d.areas.indexOf(raw); if (i >= 0) d.areas.splice(i, 1); }
      else if (kind === 'goal') { const i = d.goal_ids.indexOf(raw); if (i >= 0) d.goal_ids.splice(i, 1); }
      else if (kind === 'loc') d.location = { mode: 'any', ids: [] };
      else if (kind === 'rec') d.recurrence = null;
      else if (kind === 'deadline') d.deadline_at = '';
      else if (kind === 'date') { d.due_at = ''; d.due_from = ''; d.dueTime = ''; }
    },
    // Snapshot the draft field(s) a `kind` pill owns — stored on the pill at insert, restored on backspace.
    _fieldSnapshot(kind) {
      const d = this.draft;
      switch (kind) {
        case 'pri': return d.priority;
        case 'dur': return { durH: d.durH, durM: d.durM };
        case 'proj': return { project: d.project, project_id: d.project_id };
        case 'area': return [...d.areas];
        case 'goal': return [...d.goal_ids];
        case 'loc': return { mode: d.location.mode, ids: [...d.location.ids] };
        case 'rec': return d.recurrence ? JSON.parse(JSON.stringify(d.recurrence)) : null;
        case 'deadline': return d.deadline_at;
        case 'date': return { due_at: d.due_at, due_from: d.due_from, dueTime: d.dueTime };
      }
    },
    _restoreField(kind, s) {
      const d = this.draft;
      switch (kind) {
        case 'pri': d.priority = s ?? 5; break;
        case 'dur': d.durH = s?.durH || 0; d.durM = s?.durM || 0; break;
        case 'proj': d.project = s?.project ?? null; d.project_id = s?.project_id ?? null; break;
        case 'area': d.areas = s || []; break;
        case 'goal': d.goal_ids = s || []; break;
        case 'loc': d.location = s ? { mode: s.mode, ids: [...s.ids] } : { mode: 'any', ids: [] }; break;
        case 'rec': d.recurrence = s || null; if (d.recurrence) this.refreshRecurrenceDue(); break;
        case 'deadline': d.deadline_at = s || ''; break;
        case 'date': d.due_at = s?.due_at || ''; d.due_from = s?.due_from || ''; d.dueTime = s?.dueTime || ''; break;
      }
    },
    // Build a configured pill span (no DOM insertion). Single source of truth for pill markup.
    makePill(kind, value, token) {
      const pill = document.createElement('span');
      pill.className = 'nlp-pill'; pill.dataset.kind = kind;
      pill.dataset.value = (kind === 'date' || kind === 'rec' || kind === 'deadline') ? JSON.stringify(value) : String(value);
      pill.dataset.token = token; pill.contentEditable = 'false'; pill.textContent = this.pillLabel(kind, value);
      pill.dataset.prior = JSON.stringify(this._fieldSnapshot(kind));   // field value BEFORE this chip — restored on backspace (non-destructive)
      if (kind === 'pri') pill.style.setProperty('--rc', this.pc(value));
      return pill;
    },
    // Build + insert a pill span replacing text [start..end] of the caret's text node, leaving the caret
    // in a fresh trailing text node. `token` is the source text restored when the pill is un-chipified.
    insertPill(textNode, start, kind, value, token) {
      const el = this.$refs.content;
      const before = document.createTextNode(textNode.textContent.slice(0, start));
      const pill = this.makePill(kind, value, token);
      const after = document.createTextNode('');
      el.replaceChild(after, textNode); el.insertBefore(pill, after); el.insertBefore(before, pill);
      const r = document.createRange(); r.setStart(after, after.textContent.length); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      this.commitPill(kind, value);
      this.syncTitle();
    },
    pillifyTrailing() {
      const sel = getSelection(); if (!sel.rangeCount) return false;
      const node = sel.anchorNode;
      if (!node || node.nodeType !== 3 || node.parentNode !== this.$refs.content) return false;
      if (sel.anchorOffset !== node.textContent.length) return false;   // only pill when caret is at the end
      const tok = matchTrailingToken(node.textContent, new Date(), this.locNames());
      if (!tok) return false;
      const token = node.textContent.slice(tok.start);
      if (tok.kind === 'date' && this.swallowIntoPrevDate(node, tok, token)) return true;   // [next week] + "sun" → [next week sunday]
      this.insertPill(node, tok.start, tok.kind, tok.value, token);
      return true;
    },
    // A trailing date word right after a date pill MERGES into it: re-parse "<pill token> <word>"; if it reads as
    // one date, swap the pill for the combined one and drop the word. So [next week] + "sun" → next week's Sunday.
    swallowIntoPrevDate(node, tok, token) {
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
      this.$refs.content.replaceChild(merged, prev);
      node.textContent = ' ';                                                         // the word is now inside the pill
      const r = document.createRange(); r.setStart(node, 1); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      this.commitPill('date', cls.value); this.syncTitle();
      return true;
    },
    // backspace after a pill → restore token text + clear field; second backspace then edits normally
    unchipPillBefore() {
      const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) return false;
      const r = sel.getRangeAt(0); const node = r.startContainer;
      let prev = null;
      if (node.nodeType === 3 && r.startOffset === 0) {
        prev = node.previousSibling;
      } else if (node.nodeType === 3 && r.startOffset <= 1 && /^[\s ]*$/.test(node.textContent.slice(0, r.startOffset))) {
        prev = node.previousSibling;
      } else if (node === this.$refs.content && r.startOffset > 0) {
        const sib = node.childNodes[r.startOffset - 1];
        // If the last child before caret is a whitespace-only text node, skip it to find the pill
        if (sib && sib.nodeType === 3 && /^[\s ]*$/.test(sib.textContent)) prev = sib.previousSibling;
        else prev = sib;
      }
      if (!prev || !(prev instanceof HTMLElement) || !prev.classList.contains('nlp-pill')) return false;
      const kind = prev.dataset.kind, raw = prev.dataset.value;
      const value = (kind === 'date' || kind === 'rec' || kind === 'deadline') ? JSON.parse(raw) : (kind === 'pri' || kind === 'dur' ? +raw : raw);
      const prior = prev.dataset.prior != null ? JSON.parse(prev.dataset.prior) : null;
      this.clearPillField(kind, kind === 'area' ? raw : value);
      const text = document.createTextNode(prev.dataset.token || prev.textContent);
      prev.replaceWith(text);
      // A same-kind pill may still stand (e.g. two dates typed): revert to ITS value, not a blanket clear. Re-commit each remaining pill (DOM order → last wins for single-value fields; idempotent for areas).
      const remaining = this.$refs.content.querySelectorAll('.nlp-pill[data-kind="' + kind + '"]');
      for (const p of remaining) {
        const pr = p.dataset.value;
        this.commitPill(kind, (kind === 'date' || kind === 'rec' || kind === 'deadline') ? JSON.parse(pr) : (kind === 'pri' || kind === 'dur' ? +pr : pr));
      }
      // Non-destructive: with no same-kind chip left, restore the value the field held BEFORE this chip (a
      // picker selection, an earlier chip, or empty) rather than leaving it cleared. Areas are additive (splice only).
      if (!remaining.length && kind !== 'area' && kind !== 'goal') this._restoreField(kind, prior);
      const nr = document.createRange(); nr.setStart(text, text.textContent.length); nr.collapse(true);
      sel.removeAllRanges(); sel.addRange(nr);   // caret at the end of the restored token text
      this.syncTitle();
      this._noPillOnce = true;   // just un-chipped on purpose → the next space must NOT re-chip it
      return true;
    },
    _seqMatch(name, frag) {
      let fi = 0; const f = frag.toLowerCase(), n = name.toLowerCase();
      for (let i = 0; i < n.length && fi < f.length; i++) { if (n[i] === f[fi]) fi++; }
      return fi === f.length;
    },
    resolveArea(frag) {
      const names = this.areas.map(t => t.name);
      if (!frag) return names;
      this._areaFuzzy = this._areaFuzzy || makeFuzzy();
      const ranked = fuzzyRank(this._areaFuzzy, names, frag);
      if (ranked) return ranked.map(i => names[i]);
      // Subsequence fallback for short abbreviations uFuzzy won't match.
      return names.filter(n => this._seqMatch(n, frag));
    },
    areaMatches() { return this.resolveArea(this.areaPicker.frag).map(n => this.areas.find(t => t.name === n)).filter(Boolean); },
    openAreaPicker(node, at) { this.areaPicker = { open: true, frag: '', sel: 0, node, at, left: 0, top: 0 }; this._positionPicker(this.areaPicker, '.area-autocomplete'); },
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
    refreshAreaPicker() { this._refreshPicker(this.areaPicker, '@', '.area-autocomplete'); },
    pickArea(name) {
      const p = this.areaPicker; const node = p.node;
      node.textContent = node.textContent.slice(0, p.at) + node.textContent.slice(p.at + 1 + p.frag.length);
      const r = document.createRange(); r.setStart(node, p.at); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      this.insertPill(node, p.at, 'area', name, '@' + name);
      p.open = false;
    },
    async createAreaFromPicker() {
      const name = this.areaPicker.frag.trim(); if (!name) return;
      if (!this.areas.find(t => t.name === name)) { await this.store.areas.create({ name }); await this.loadAreas(); }
      this.pickArea(name);
    },
    goalMatches() {
      const q = this.goalPicker.frag.toLowerCase();
      return this.goals.filter(g => !g.archived && (!q || g.name.toLowerCase().includes(q)));
    },
    openGoalPicker(node, at) { this.goalPicker = { open: true, frag: '', sel: 0, node, at, left: 0, top: 0 }; this._positionPicker(this.goalPicker, '.goal-autocomplete'); },
    refreshGoalPicker() { this._refreshPicker(this.goalPicker, '^', '.goal-autocomplete'); },
    pickGoal(id) {
      const p = this.goalPicker; const node = p.node;
      node.textContent = node.textContent.slice(0, p.at) + node.textContent.slice(p.at + 1 + p.frag.length);
      const r = document.createRange(); r.setStart(node, p.at); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      this.insertPill(node, p.at, 'goal', id, '^' + (this.goalById(id)?.name || ''));   // visible chip, like @area
      p.open = false;
    },
    goalPickerKeydown(e) {
      const p = this.goalPicker; if (!p.open) return false;
      const matches = this.goalMatches();
      if (e.key === 'Escape') { p.open = false; return true; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { p.sel = Math.min(p.sel + 1, Math.max(0, matches.length - 1)); return true; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { p.sel = Math.max(p.sel - 1, 0); return true; }
      if ((e.key === 'Enter' || e.key === ' ') && matches.length) { this.pickGoal(matches[p.sel]?.id || matches[0].id); return true; }
      return false;
    },
    areaPickerKeydown(e) {
      const p = this.areaPicker; if (!p.open) return false;
      const matches = this.areaMatches();
      if (e.key === 'Escape') { p.open = false; return true; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { p.sel = Math.min(p.sel + 1, Math.max(0, matches.length - 1)); return true; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { p.sel = Math.max(p.sel - 1, 0); return true; }
      if (e.key === 'Enter' || e.key === ' ') {
        if (matches.length) { this.pickArea(matches[p.sel].name); return true; }   // sel is clamped to [0, len-1], so len===1 ⇒ sel 0
        if (e.key === 'Enter' && p.frag.trim()) { this.createAreaFromPicker(); return true; }
      }
      return false;
    },
    editorKeydown(e) {
      // Interruptible motion: a keystroke landing while the open-scroll still glides cancels it and jumps
      // instantly — so `q`-then-immediate-typing never lets the animation fight the caret.
      if (this._composerScrolling) { this._composerScrolling = false; clearTimeout(this._scrollSettleT); this.$refs.composer?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
      if (this.goalPicker.open && this.goalPickerKeydown(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if (this.areaPicker.open && this.areaPickerKeydown(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === '^') { this.$nextTick(() => { const s = getSelection(); if (!s || !s.anchorNode) return; let node = s.anchorNode; if (node.nodeType !== 3) { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.includes('^')) { node = n; break; } } } const at = (node.textContent || '').lastIndexOf('^'); if (at >= 0) this.openGoalPicker(node, at); }); return; }
      if (e.key === '@') { this.$nextTick(() => { const s = getSelection(); const at = (s?.anchorNode?.textContent || '').lastIndexOf('@'); if (s && s.anchorNode && at >= 0) this.openAreaPicker(s.anchorNode, at); }); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this.submitComposer(); return; }
      if (e.key === ' ') { if (!this._noPillOnce && this.pillifyTrailing()) e.preventDefault(); this._noPillOnce = false; }
      else if (e.key === 'Backspace') { if (this.unchipPillBefore()) e.preventDefault(); }
      else if (e.key.length === 1) { this._noPillOnce = false; }   // typing fresh content re-enables space→pill
    },
    async submitComposer() {
      if (!this.draft.content.trim()) return;   // contenteditable has no `required`; block empty titles
      this.pushUndo('Saved task');              // ONE undo step for the whole save (field edits + ghost commits)
      this._suppressUndo = true;                // the commits below are part of THIS save, not separate undo steps
      try {
        if (this.chkGhost.trim()) this.commitChkGhost();   // save in-progress ghost inputs on Save, even without Enter
        if (this.subGhost.trim()) await this.commitSubGhost();
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
          const editId = this.editing, task = this.byId.get(editId), fields = this.draftFields(), draft = this.draft;
          this.closeComposer();   // close first — user sees it gone immediately
          const updated = await this.store.tasks.update(editId, fields);
          if (updated) {
            // A completed task whose checklist now has an undone item must reopen (e.g. you just added one).
            const cl = updated.checklist || [];
            if (updated.completed_at && cl.length && !cl.every(c => c.done)) await this.store.tasks.setCompleted(updated.id, false);
            if (task) Object.assign(task, updated); await this.loadTasks(); await this.loadAreas();
            // an edit can re-sort/move the row — scroll it back into view so it's never lost.
            this.$nextTick(() => { const el = this._rowEl(editId); if (el) el.scrollIntoView({ block: 'nearest', behavior: this.reduceMotion() ? 'auto' : 'smooth' }); });
          } else {
            // Save failed — reopen the composer with the user's unsaved edits so nothing is silently lost.
            this.editing = editId; this.draft = draft;
            this._editDescs = new Set(descendantIds(this.tasks, editId).slice(1));
            this.openComposer();
            this.toast('Save failed — try again');
          }
          return;
        }
        const newRow = await this.addTask();
        // reveal the just-added row (it lands just above the composer) so the view never jumps to the top;
        // block:'nearest' keeps both the new row and the still-open composer in view for rapid successive adds.
        this.$nextTick(() => { this.setEditorText(''); this.$refs.content?.focus(); if (newRow) this._rowEl(newRow.id)?.scrollIntoView({ block: 'nearest', behavior: this.reduceMotion() ? 'auto' : 'smooth' }); });
      } finally { this._suppressUndo = false; }
    },
    // Ctrl/Cmd+Enter: submit then close (submitComposer keeps a NEW task's composer open for rapid add).
    async submitAndClose() { await this.submitComposer(); if (!this.projRequired) this.closeComposer(); },
    onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      // ⌘/Ctrl+Z → walk the undo buffer back. Outside the composer, let native text-undo win inside real fields;
      // but WHILE the composer is open its editors re-render live (native undo is already gone), so route it to
      // the app stack so a checklist/subtask/field edit undoes regardless of where focus sits.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
        if (this.composer.open || !inField) { e.preventDefault(); this.doUndo(); return; }
      }
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
      else if (e.key === 'b') { e.preventDefault(); this.setNav('backlog'); }
      else if (e.key === 'a') { e.preventDefault(); this.setNav('all'); }
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); this.moveFocus(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); this.moveFocus(-1); }
      else if ((e.key === 'Enter' || e.key === 'e') && this.focusId) { e.preventDefault(); this.openFocused(); }
      else if (e.key === 'x' && this.focusId) { e.preventDefault(); this.toggleFocused(); }   // complete focused row (Space now opens the palette)
      else if (e.key === '?') { e.preventDefault(); this.shortcutsOpen = true; }
      else if (e.key >= '1' && e.key <= '4') { e.preventDefault(); this.goSurface(this.surfaceOrder[(+e.key) - 1]); }   // jump to a surface
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.goSurface(this.surfaceOrder[Math.max(0, this.surfaceIndex() - 1)]); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.goSurface(this.surfaceOrder[Math.min(this.surfaceOrder.length - 1, this.surfaceIndex() + 1)]); }
      else if (e.key === ' ') { e.preventDefault(); this.openPalette(); }   // Space → the everything-nav palette
      else if (e.key === 'o') { e.preventDefault(); this.openOverview(); }   // o → zoom-out overview deck
    },
    escape() {
      // Anything that can stack ON TOP of the overview (dialogs, the roller ⋯ popover) closes first; the overview closes only when nothing is layered above it.
      if (this.shortcutsOpen) this.shortcutsOpen = false;
      else if (this.palette.open) this.palette.open = false;
      else if (this.confirm) this.confirmNo();
      else if (this.graduateOffer) this.graduateOffer = null;   // pure close — no snooze; unlike confirm's ghost button, deliberate decline lives only in declineGraduation()
      else if (this.finishOffer) this.finishOffer = null;       // pure close — the offer is quiet and true; may reappear
      else if (this.reflectGoal) this.reflectGoal = null;       // pure close — no recommit/release; both live only behind explicit buttons
      else if (this.deletingProject) this.deletingProject = null;
      else if (this.locMgr) this.locMgr = false;
      else if (this.filterEdit) this.filterEdit = null;
      else if (this.eventEdit) this.eventEdit = null;
      else if (this.blockEdit) this.blockEdit = null;
      else if (this.navPop) this.navPop = null;
      else if (this.navRename) this.navRename = null;
      else if (this.logWhenOpen) this.logWhenOpen = null;
      else if (this.identMenuId) this.identMenuId = null;
      else if (this.tpop) this.tpop = false;
      else if (this.endPicking) this.endPicking = false;
      else if (this.pop) this.pop = null;
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

    async loadTasks() { this.tasks = await this.store.tasks.list(); this.byId = new Map(this.tasks.map(t => [t.id, t])); this._rowV++; _calDataV++; _calMemo.clear(); _goalStepsMemo.clear(); _goalMilestonesMemo.clear(); await this.loadStats(); },
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
    pickIdentitySuggestion(text) { this.goalDraft._identityBlank = text; this._identSugSel = -1; },
    identSugKeydown(e) {
      const sugs = this.identitySuggestions();
      const popOpen = this._identSugFocus && sugs.length > 0;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!popOpen) return;
        e.preventDefault();
        this._identSugSel = e.key === 'ArrowDown' ? Math.min(this._identSugSel + 1, sugs.length - 1) : Math.max(this._identSugSel - 1, -1);
      } else if (e.key === 'Enter') {
        if (this._identSugSel >= 0 && sugs[this._identSugSel]) {
          e.preventDefault();
          this.pickIdentitySuggestion(sugs[this._identSugSel].text);
        }
      } else if (e.key === 'Escape') {
        if (popOpen) { e.stopPropagation(); this._identSugSel = -1; this._identSugFocus = false; }
        else this.closeGoal();
      }
    },
    goalDueLabel(date) { if (!date) return ''; const d = Math.round((new Date(date) - new Date()) / 864e5); return d === 0 ? 'today' : d > 0 ? 'in ' + d + 'd' : Math.abs(d) + 'd ago'; },
    plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); },
    // Effective goals for a task: own goal_ids ∪ every ancestor's, walked via byId (cycle-safe), mapped to objects.
    goalsForTask(t) { return effectiveGoalIds(this.tasks, t.id, this.byId).map(id => this.goalById(id)).filter(Boolean); },
    toggleGoal(id) { const a = this.draft.goal_ids, i = a.indexOf(id); i >= 0 ? a.splice(i, 1) : a.push(id); },
    toast(msg, ms = 2000) { this.toastMsg = msg; this.toastOn = true; clearTimeout(this._toastT); this._toastT = setTimeout(() => { this.toastOn = false; }, ms); },
    // buffer snapshot BEFORE each gesture (UNDO_MAX deep); bar hides but buffer persists — ⌘Z walks it back.
    // entry has .snap (store), .checklist (draft), or both; doUndo restores whatever is set.
    pushUndo(label) { if (this._suppressUndo) return; this.undo.stack.push({ label, snap: this.store.snapshot() }); this._capUndo(label); },
    // Draft-only gesture (checklist add/delete): snapshot ONLY the checklist slice, so undoing it can't clobber
    // notes/title the user edited afterward.
    pushUndoDraft(label) { if (this._suppressUndo) return; this.undo.stack.push({ label, checklist: JSON.parse(JSON.stringify(this.draft.checklist)), editing: this.editing }); this._capUndo(label); },
    _capUndo(label) { if (this.undo.stack.length > UNDO_MAX) this.undo.stack.shift(); this._flashUndo(label); },   // drop oldest past the cap
    _flashUndo(label) {
      this.undo.label = label; this.undo.on = true;
      clearTimeout(this.undo.timer);
      this.undo.timer = setTimeout(() => { this.undo.on = false; }, 6000);
    },
    async doUndo() {
      const entry = this.undo.stack.pop();
      if (!entry) { this.undo.on = false; return; }
      if (entry.snap) { await this.store.restore(entry.snap); await this.loadAreas(); await this.loadTasks(); }
      // Restore a composer checklist edit only if we're still editing the same task (else it was discarded/committed).
      if (entry.checklist && this.composer.open && this.editing === entry.editing) {
        this.draft.checklist = JSON.parse(JSON.stringify(entry.checklist));
        this.$nextTick(() => this.syncChkRows());   // reused rows keep stale live-editor markup — refresh from the restored draft
      }
      const next = this.undo.stack[this.undo.stack.length - 1];   // keep the bar alive while more remains to undo
      if (next) this._flashUndo(next.label); else { this.undo.on = false; clearTimeout(this.undo.timer); }
    },
    // reads the loadStats cache; newest-first, non-void
    goalTimeline(id) { return (this._activityCache || []).filter(a => !a.void && ((a.type === 'note' && a.subject_id === id) || (a.type === 'complete' && (a.ctx?.goal_ids || []).includes(id)))).sort((a, b) => b.ts.localeCompare(a.ts)); },
    // Last day (YYYY-MM-DD) the user showed up for a goal (direct show_up OR a laddered completion) — feeds the detail's "warmed today/Xd ago".
    goalLastActive(id) {
      void this._activityCache;   // touch the reactive dep on every call (even a cache hit) so bindings stay subscribed
      const sig = id + '|' + _activityV, hit = _goalLastActiveMemo.get(sig);
      if (hit !== undefined) return hit;
      let last = null;
      for (const a of (this._activityCache || [])) {
        if (a.void) continue;
        const isHit = (a.type === 'show_up' && a.subject_id === id) || (a.type === 'complete' && (a.ctx?.goal_ids || []).includes(id));
        if (isHit) { const d = isoDate(new Date(a.ts)); if (!last || d > last) last = d; }
      }
      _goalLastActiveMemo.set(sig, last);
      return last;
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
        const sig = ident.id + '|' + _activityV;
        let votes = _identVotesMemo.get(sig);
        if (votes === undefined) {
          const feederIds = new Set(all.map(g => g.id));
          votes = (this._activityCache || []).filter(a => !a.void && a.type === 'complete' && (a.ctx?.goal_ids || []).some(id => feederIds.has(id))).length;
          _identVotesMemo.set(sig, votes);
        }
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
      const sig = id + '|' + _activityV, hit = _goalLogMemo.get(sig);
      if (hit) return hit;
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
      const out = groupByDay(rows, d => logDayLabel(d));
      _goalLogMemo.set(sig, out);
      return out;
    },
    // memoized on _activityV (x-show + x-for both read it)
    recentContributions() {
      void this._activityCache;   // touch the reactive dep on every call (even a cache hit) so bindings stay subscribed
      const hit = _recentMemo.get(_activityV);
      if (hit) return hit;
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
      const out = groupByDay(
        rows.slice(0, 20).map(({ id, ts, html, dot }) => { const d = new Date(ts); return { id, dayKey: isoDate(d), html, dot, time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }; }),
        d => logDayLabel(d)
      );
      _recentMemo.set(_activityV, out);
      return out;
    },
    async createGoal(name) { const g = await this.store.goals.create({ name: (name || '').trim() || 'New goal' }); await this.loadGoals(); return g; },
    async patchGoal(id, fields) { await this.store.goals.update(id, fields); await this.loadGoals(); },
    async archiveGoal(id, val) { await this.patchGoal(id, { archived: val }); },
    async deleteGoal(id) { await this.store.goals.remove(id); await this.loadGoals(); await this.loadTasks(); },
    async addGoalNote(id, text) { if (!(text || '').trim()) return; await this.store.activity.note(id, text.trim()); await this.loadStats(); },
    async deleteLog(actId) { await this.store.activity.remove(actId); await this.loadStats(); },
    // Inline-expand edit, using the SAME measured-height grow as the task composer (open + close).
    openGoal(id, startH = 0) {
      const g = this.goalById(id);
      if (!g) return;
      this._identSugSel = -1; this._identSugFocus = false;   // reset before (re-)opening
      this.visited.goals = true;   // ensures the lazy-mounted goals surface is rendered
      this.goalDetailId = null;    // composer + detail are mutually exclusive
      this.goalOpenId = id;
      const identity = this.identityStatement(g) || '';
      this.goalDraft = { name: g.name || '', identity, _identityBlank: identity.replace(IDENTITY_WHO_RE, ''), cue: g.cue || '', log_default: g.log_default || '', targets: (g.targets || []).map(t => ({ ...t })), target_date: g.target_date || '', favorite: !!g.favorite, color: g.color || null, icon: g.icon || null, cadence: g.cadence || null, shape: g.shape || 'process', _colorPop: false };
      this._growOpen(() => document.querySelector('.goal-col.editing .composer-grow'), startH);   // start at the card's height, not 0
    },
    async closeGoal() {
      this._identSugSel = -1; this._identSugFocus = false;
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
      const sig = id + '|' + _calDataV, hit = _goalStepsMemo.get(sig); if (hit) return hit;
      const out = [...this.goalTasks(id)].sort((a, b) => (a.due_at || '\uffff').localeCompare(b.due_at || '\uffff') || (Math.min(a.priority ?? 4, 4)) - (Math.min(b.priority ?? 4, 4)));
      _goalStepsMemo.set(sig, out);
      return out;
    },
    goalMilestones(id) {
      void this.tasks;
      const sig = id + '|' + _calDataV, hit = _goalMilestonesMemo.get(sig); if (hit) return hit;
      const out = this.tasks.filter(t => t.milestone && this.goalsForTask(t).some(gg => gg.id === id));
      _goalMilestonesMemo.set(sig, out);
      return out;
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
    // GS8 graduation: pull-based, never auto. Escape/backdrop unreachable (see escape()/closeDialogs()).
    openGraduateOffer(id) { this.graduateOffer = id; },
    async confirmGraduation() {
      const id = this.graduateOffer; if (!id) return;
      this.graduateOffer = null;   // null synchronously, before any await — a second rapid tap must see it already gone
      const g = this.goalById(id);
      await this.store.goals.update(id, { sustained_at: new Date().toISOString() });
      await this.store.activity.graduate(id);
      await this.loadGoals(); await this.loadStats();
      // Celebration starts once the reloads land, so the stage flip and .graduating begin together.
      this.flashGoal('graduatingGoal', '_graduatingT', id, 2050);
      this.toast('🏅 ' + (g?.name || 'This goal') + ' — self-sustaining. Carry the heat.');
    },
    async declineGraduation() {
      const id = this.graduateOffer; if (!id) return;
      this.graduateOffer = null;
      await this.store.goals.update(id, { sustain_snoozed_until: new Date(Date.now() + 21 * 864e5).toISOString() });
      await this.loadGoals(); await this.loadStats();
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
    openFinishOffer(id) { this.finishOffer = id; },
    async confirmFinishing() {
      const id = this.finishOffer; if (!id) return;
      this.finishOffer = null;   // null synchronously — rapid-tap guard
      await this.store.goals.update(id, { finished_at: new Date().toISOString() });
      await this.store.activity.finish(id);
      await this.loadGoals(); await this.loadStats();
      this.flashGoal('graduatingGoal', '_graduatingT', id, 2050);
      this.toast('Finished. Carry the heat — light something new.');
      // reload-safe: finished_at is committed; archiving after the beat is cosmetic
      setTimeout(() => this.archiveGoal(id, true), 2100);
    },
    declineFinishing() { this.finishOffer = null; },
    // GS15: Recommit and Release are equal-weight — never framed as pass/fail
    openReflect(id) { this.visited.goals = true; this.reflectGoal = id; },
    recommitGoal() {
      const id = this.reflectGoal; if (!id) return;
      this.reflectGoal = null;
      this.openGoalFromDetail(id);   // reframing means editing cadence/why, same path as the detail's Edit button
    },
    async releaseGoal() {
      const id = this.reflectGoal; if (!id) return;
      this.reflectGoal = null;
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
      await this.store.goals.update(id, { shelved_at: new Date().toISOString() });
      await this.store.activity.shelve(id);
      await this.loadGoals();
      await this.loadStats();
      this.closeGoalDetail();
      this.toast('Set down on purpose — the coals stay banked.');
    },
    async unshelveGoal(id) {
      if (!id) return;
      await this.store.goals.update(id, { shelved_at: null });
      await this.store.activity.unshelve(id);
      await this.loadGoals();
      await this.loadStats();
      this.toast('Picked back up — the fire returns.');
    },
    async finishStep(taskId, gid) {
      const beat = () => {
        const t = this.byId.get(taskId);
        if (t?.milestone) {
          if (this.msBeatGid !== gid) {   // applyComplete already fired these; skip to avoid stutter
            this.flashGoal('pulseGoal', '_pulseT', gid, 1200);
            this.flashGoal('msBeatGid', '_msBeatT', gid, 1400);
          }
        } else {
          this.flashGoal('pulseGoal', '_pulseT', gid, 600);
        }
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
      this.currentLocationId = this.store.currentLocationId();
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
    async deleteLocation(id) { await this.store.locations.remove(id); await this.loadLocations(); },
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
    setLocMode(mode) { this.draft.location = { mode, ids: mode === 'any' ? [] : (this.draft.location?.ids || []) }; },
    // --- location hybrid picker (sentence polarity + here-row + region chip rows) ---
    locNew: null, locExpanded: [], locOrder: {},
    openLoc() {
      this.togglePop('loc');
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
      const inst = blocksInRange(this.blocks || [], iso, iso).find(i => i.location_id && new Date(i.start) <= now && now < new Date(i.end));
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
    async setHere(id) { await this.store.setCurrentLocation(id); await this.loadLocations(); },
    async switchRegion(name) { await this.store.setCurrentRegion(name); await this.loadLocations(); },
    currentLocation() { return this.locations.find(l => l.id === this.currentLocationId) || null; },
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
    isFilterQuery(q) { return /(^|\s)(#|@|due:|deadline:|priority:|p:|is:|in:)|[&|!()]/i.test((q || '').trim()); },
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
      await this.store.filters.remove(id);
      await this.loadFilters();
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
      this.tasks.push(row);
      await this.loadTasks();
      await this.loadAreas();
      this.resetDraft();
      return row;
    },

    childTasks(id) { return this.tasks.filter(t => t.parent_id === id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
    addChecklistItem(text) { if (!text.trim()) return; this.pushUndoDraft('Added item'); this.draft.checklist.unshift({ id: crypto.randomUUID(), text: text.trim(), done: false }); this.sortChecklist(); },   // new items land at the TOP of the open bucket
    // The composer keeps the array open-first/done-last (stable) so the array order == the visual order (drag indices map 1:1).
    sortChecklist() { this.draft.checklist.sort(byDone); },
    // Uncheckable: the checklist renders as a plain notes list (no boxes, no done styling) everywhere
    chkPlain() { return !!this.editingTask()?.checklist_plain; },
    async toggleChecklistPlain() { const t = this.editingTask(); if (t && await this.store.tasks.update(t.id, { checklist_plain: !t.checklist_plain })) await this.loadTasks(); },
    toggleChecklistItem(item) { item.done = !item.done; this.sortChecklist(); },   // toggling done moves the item to the done bucket
    removeChecklistItem(item) { this.pushUndoDraft('Deleted item'); const i = this.draft.checklist.indexOf(item); if (i >= 0) this.draft.checklist.splice(i, 1); },
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
    // Enter on a checklist row inserts a new empty OPEN item just below it and focuses it. A new open item can't
    // live in the done bucket, so a row Entered from the done bucket lands at the end of the open bucket (the stable re-sort pulls it up).
    insertChkAfter(item) {
      this.pushUndoDraft('Added item');
      const it = { id: crypto.randomUUID(), text: '', done: false };
      this.draft.checklist.splice(this.draft.checklist.indexOf(item) + 1, 0, it);
      this.sortChecklist();
      this.$nextTick(() => { const el = document.querySelector(`.composer-entries .entry.chk[data-id="${it.id}"] .entry-txt`); if (el) { el.contentEditable = 'true'; el.focus(); } });   // rows are editable-on-demand: make editable before focusing
    },
    async commitSubGhost() { const v = this.subGhost.trim(); this.subGhost = ''; if (v && this.editing) { this.pushUndo('Added subtask'); await this.addSubtask(this.editing, v); } },
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
      if (e.key === 'ArrowUp' && collapsed && off === 0) { if (this.moveEntryFocus(el, -1)) e.preventDefault(); }
      else if (e.key === 'ArrowDown' && collapsed && off === len) { if (this.moveEntryFocus(el, 1)) e.preventDefault(); }
    },
    // dir hops in VISUAL order (ghost → open bucket → done bucket) — sort the fields by their on-screen top so the
    // CSS-ordered ghost-on-top layout is respected regardless of DOM order.
    moveEntryFocus(el, dir) {
      const list = el.closest('.entry-list'); if (!list) return false;
      const fields = [...list.querySelectorAll('.entry-txt')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const next = fields[fields.indexOf(el) + dir];
      if (!next) return false;
      if (next.tagName === 'DIV') next.contentEditable = 'true';   // checklist row: editable-on-demand, make editable before focus
      next.focus();
      if (next.isContentEditable) this._setCaret(next, next.textContent.length);
      else { const n = next.value.length; next.setSelectionRange?.(n, n); }
      return true;
    },
    // Enter on a subtask row: commit (blur → rename) and jump to the ghost "new subtask" prompt.
    focusEntryGhost(input) { input.closest('.entry-list')?.querySelector('.entry.ghost .entry-txt')?.focus(); },
    // Live "::" editor for a checklist item: commit text live (so Enter-insert / save never lose in-progress edits),
    // then re-render the faded "::" markup keeping the caret (chkLive keeps textContent === raw; mirrors onDescInput).
    chkInput(item, e) {
      if (e.isComposing) return;
      const el = e.target, text = el.textContent;
      item.text = text;
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
      this.pushUndoDraft('Pasted items');
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
    async renameChild(c, name) { name = name.trim(); if (name && name !== c.content && await this.store.tasks.update(c.id, { content: name })) await this.loadTasks(); },
    async removeChild(c) { if (this.askDeleteTask(c.id, 'child')) return; this.pushUndo('Deleted subtask'); if (await this.store.tasks.remove(c.id)) await this.loadTasks(); },
    // Drag-to-reorder the composer entry list (grip handle). kind: 'sub' = child tasks (store order) | 'chk' = draft.checklist.
    initEntrySort(el, kind) {
      makeSortable(el, { itemSel: '.entry:not(.ghost)', handleSel: '.entry-grip',
        onCommit: (from, to) => kind === 'sub' ? this.reorderSubtasks(from, to) : this.reorderChecklist(from, to) });
    },
    async reorderSubtasks(from, to) {
      const ids = this.childTasks(this.editing).map(c => c.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      this.pushUndo('Reordered subtasks');
      if (await this.store.tasks.reorder(ids)) await this.loadTasks();
    },
    reorderChecklist(from, to) {
      this.pushUndoDraft('Reordered');
      this.draft.checklist.splice(to, 0, this.draft.checklist.splice(from, 1)[0]);
      this.sortChecklist();   // buckets are authoritative — a drop that crossed the open/done split snaps back to its own bucket
      if (this.editing) this.store.tasks.update(this.editing, { checklist: this.draft.checklist });
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
      this.pushUndo('Reordered checklist');
      if (await this.store.tasks.update(id, { checklist: next })) await this.loadTasks();
    },
    listDragOver(e) { const itemEl = e.target.closest && e.target.closest('.item'); const r = this._rowFromEl(itemEl); if (r) this.dragOver(r.t, { clientY: e.clientY, clientX: e.clientX, currentTarget: itemEl, dataTransfer: e.dataTransfer }, r.depth); },
    listDragLeave(e) { this.dragLeave(null, e); },
    listDrop(e) { const r = this._rowFromEl(e.target.closest && e.target.closest('.item')); if (r) this.drop(r.t); },
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
      if (!await this.store.tasks.setChecklistItem(taskId, item.id, done)) return;
      // sync task completion once every item is checked
      const allDone = list.length > 0 && list.every((x, j) => j === i ? done : x.done);
      if (allDone !== !!task.completed_at) await this.store.tasks.setCompleted(taskId, allDone);
      await this.loadTasks();
    },
    async addSubtask(parentId, content) {
      content = content.trim(); if (!content) return;
      const task = await this.store.tasks.create({ content, parent_id: parentId });
      if (!task) return;
      // Append at bottom of siblings so it appears last in the composer entries.
      const siblings = this.tasks.filter(t => t.parent_id === parentId);
      if (siblings.length) {
        const maxPos = Math.max(...siblings.map(t => t.position ?? 0));
        await this.store.tasks.update(task.id, { position: maxPos + 1 });
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
      this.closeComposer();
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
      this.pushUndo('Converted to checklist');
      const items = kids.map(k => ({ id: crypto.randomUUID(), text: k.content, done: !!k.completed_at }));
      this.draft.checklist = [...this.draft.checklist, ...items];
      this._suppressUndo = true;
      try {
        // the checklist must be PERSISTED before any subtask is removed — a failed update aborts the conversion
        if (await this.store.tasks.update(this.editing, { checklist: this.draft.checklist }))
          await Promise.all(kids.map(k => this.store.tasks.remove(k.id)));
        else this.draft.checklist = this.draft.checklist.filter(c => !items.includes(c));   // revert the staged copy; subtasks stay
      } finally { this._suppressUndo = false; }
      await this.loadTasks();
    },
    // Overflow menu: checklist → subtasks. CREATE FIRST, DELETE LAST: the checklist is cleared only after
    // every subtask verifiably exists; any failure rolls back the created tasks and leaves the checklist
    // untouched. Worst case is a duplicate, never a loss.
    async convertToSubtasks() {
      if (!this.editing) return;
      const items = this.draft.checklist.filter(i => i.text.trim());
      if (!items.length) return;
      this.pushUndo('Converted to subtasks');
      this._suppressUndo = true;
      const made = [];
      try {
        for (const item of items) {
          const task = await this.store.tasks.create({ content: item.text, parent_id: this.editing });
          if (!task) throw 0;
          made.push(task.id);
        }
        await this.store.tasks.reorder(made);   // creates prepend — restore the checklist's order
        for (let i = 0; i < items.length; i++) if (items[i].done) await this.store.tasks.setCompleted(made[i], true);
        // every subtask exists — only NOW is the destructive step safe
        this.draft.checklist = [];
        await this.store.tasks.update(this.editing, { checklist: [] });
        if (this.byId.get(this.editing)?.completed_at) await this.store.tasks.setCompleted(this.editing, false);   // new children reopen a completed parent
      } catch {
        await Promise.allSettled(made.map(id => this.store.tasks.remove(id)));   // undo partial creates; checklist intact
      } finally { this._suppressUndo = false; }
      await this.loadTasks();
    },
    anyDialog() { return !!(this.confirm || this.shortcutsOpen || this.palette.open || this.locMgr || this.filterEdit || this.eventEdit || this.blockEdit || this.deletingProject || this.deleteSub || this.graduateOffer || this.finishOffer || this.reflectGoal); },
    closeDialogs() { if (this.confirm) this.confirmNo(); this.shortcutsOpen = false; this.palette.open = false; this.locMgr = false; this.filterEdit = null; this.eventEdit = null; this.blockEdit = null; this.deletingProject = null; this.deleteSub = null; this.graduateOffer = null; this.finishOffer = null; this.reflectGoal = null; },
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
      const el = this.$refs.content; el.focus();
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
      this.closeComposer();   // the edited task became a sidebar project — close the composer
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
      const val = !t.archived_at;
      this.pushUndo(val ? 'Archived task' : 'Unarchived task');
      await this.store.tasks.setArchived(this.editing, val);
      await this.loadTasks();
      this.closeComposer();
    },
    async applyComplete(id, done) {
      if (done) this.pushUndo('Completed');
      const ok = await this.store.tasks.setCompleted(id, done);
      if (!ok) return;
      await this.loadTasks();   // refreshes stats (loadStats → goalStats) so the strip/chips stay fresh
      if (done) {
        const t = this.byId.get(id), goals = t ? this.goalsForTask(t) : [];
        if (goals.length) {
          this.flashGoal('chipGlintId', '_chipGlintT', id, 300);   // daily-tier echo: brief warm glint on the row's goal chip
          const idg = goals.find(g => (this.identityStatement(g) || '').trim());
          const idgStmt = idg ? this.identityStatement(idg) : null;
          if (t?.milestone) {
            const phrase = this.identityPhrase(idgStmt);
            this.toast(phrase ? '◆ milestone · a vote for ' + phrase : '◆ milestone · toward "' + goals[0].name + '"');
            this.flashGoal('pulseGoal', '_pulseT', goals[0].id, 1200);
            this.flashGoal('msBeatGid', '_msBeatT', goals[0].id, 1400);
          } else {
            this.toast(idgStmt ? '🔥 +1 vote · ' + idgStmt : '🔥 +1 · ' + goals[0].name);
          }
        }
      }
    },

    async save(t, fields) { Object.assign(t, await this.store.tasks.update(t.id, fields) || {}); this._rowV++; },
    async remove(t) { this.pushUndo('Deleted'); if (await this.store.tasks.remove(t.id)) { this.tasks = this.tasks.filter(x => x.id !== t.id); this._rowV++; } },

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
    blocked(t) { return (t.blocked_by ?? []).some(id => { const b = this.byId.get(id); return b && !b.completed_at && !b.archived_at; }); },
    relChips() { return this.taskRels(this.editingTask()); },
    relTypeLabel(type) { return { blocked_by: 'blocked', blocks: 'blocks', relates: 'relates' }[type]; },
    relIcon(type) { return type === 'relates' ? 'i-link' : 'i-stop'; },
    stageRel(id) { this.relStaged = id; },
    async submitRel() { const id = this.relStaged; this.relStaged = null; this.pickerQ = ''; if (id) await this.addRelation(id, this.relType); },
    editingTask() { return this.byId.get(this.editing) ?? null; },
    // 'blocks' writes blocked_by on the OTHER task (swapped link direction) — no separate stored type
    async addRelation(otherId, type) { if (!otherId) return; const ok = type === 'blocks' ? await this.store.tasks.link(otherId, this.editing, 'blocked_by') : await this.store.tasks.link(this.editing, otherId, type); if (ok) await this.loadTasks(); },
    async removeRelation(otherId, type) { const ok = type === 'blocks' ? await this.store.tasks.unlink(otherId, this.editing, 'blocked_by') : await this.store.tasks.unlink(this.editing, otherId, type); if (ok) await this.loadTasks(); },

    // ---- Calendar (continuous Month · page-per-week Week/Day · Year — iOS/macOS-Calendar-style) ----
    listView() { return this.surface === 'lists'; },   // task-list views (all/backlog/project/area/filter) live on the Lists surface
    // ---- Now home (heuristic until the planner lands; always-functional with no data) ----
    nowGreeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; },
    _actionable() {
      const def = this.store.defaultProject();
      return this.tasks.filter(t => !t.completed_at && !t.archived_at && !this.isSidebar(t) && t.id !== def && !this.hasChildren(t.id))
        .sort((a, b) => (a.due_at || '9999').slice(0, 10).localeCompare((b.due_at || '9999').slice(0, 10)) || a.priority - b.priority);
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
    // Today's slice of the server auto-plan (plan_items), rank-ordered with fuzzy day-windows (no clock-times).
    // planAgenda is pure (calendar.js); enriched here into calm today-list rows. Empty offline/local → the day list stands.
    nowPlan() {
      const now = new Date(), iso = isoDate(now);
      return planAgenda(this.plan, this.byId, iso, iso).map(p => {
        const flags = p.flags || [], blocked = flags.includes('blocked');
        return {
          t: p.t, rank: p.rank,
          badge: windowBadge({ due_from: p.earliest, due_at: p.latest }, now),
          blocked, infeasible: flags.includes('infeasible'), noEst: flags.includes('no_estimate'),
          waiting: blocked ? (p.after || []).map(id => this.byId.get(id)?.content).filter(Boolean).join(', ') : '',
        };
      });
    },
    nowVote(t) {
      const g = t && this.goalsForTask(t).find(x => (this.identityStatement(x) || '').trim());
      if (!g) return null;
      return (this.identityStatement(g) || '').trim().replace(/^i(?:'m| am)\s+/i, '') || null;
    },
    nowFocusTask() { return this.byId.get(this.nowFocusId) ?? null; },
    // transient VIEW state only; `e` target refocused on back; mobile scrolls Room into view
    nowMainline(id, e) {
      this.nowFocusId = id; _nowFocusEl = e?.currentTarget ?? null;
      this.$nextTick(() => { if (innerWidth < 840) document.querySelector('.room')?.scrollIntoView({ behavior: this.reduceMotion() ? 'auto' : 'smooth', block: 'start' }); });
    },
    nowBack() { this.nowFocusId = null; this.$nextTick(() => { _nowFocusEl?.focus(); _nowFocusEl = null; }); },
    // events first; completed tasks dropped (calendarItems includes them — Now hides them)
    nowToday() {
      const n = new Date(), iso = isoDate(n);
      return eventsFirst(calendarItems(this.events, this.tasks, iso, iso, n))
        .filter(it => it.kind === 'event' || !(this.byId.get(it.id)?.completed_at || this.byId.get(it.id)?.archived_at));
    },
    nowWindow() {
      void this._nowTickV;
      // rolling window: BEFORE h above + AFTER below; flows past midnight
      const HP = 34, BEFORE = 4, AFTER = 12;
      const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
      const startMin = Math.floor((nowMin - BEFORE * 60) / 60) * 60, endMin = startMin + (BEFORE + AFTER) * 60;
      const y = min => (min - startMin) / 60 * HP, dayH = (endMin - startMin) / 60 * HP;
      const mins = iso => (+iso.slice(11, 13)) * 60 + (+iso.slice(14, 16));
      const hours = [];
      for (let m = startMin; m <= endMin; m += 60) {
        const abs = m / 60, hd = ((abs % 24) + 24) % 24;
        hours.push({ h: abs, label: (hd % 12 || 12) + (hd < 12 ? 'am' : 'pm'), next: abs >= 24, top: y(m), past: m < nowMin });
      }
      const place = (items, off) => items.filter(it => !it.allDay).map(it => {
        const s = mins(it.start) + off, e = (it.end && it.end.length > 10 ? mins(it.end) : mins(it.start) + 30) + off;
        return { ...it, top: y(s), height: Math.max((e - s) / 60 * HP, 20), live: s <= nowMin && nowMin < e, past: e <= nowMin };
      }).filter(r => r.top + r.height >= 0 && r.top <= dayH);
      const dIso = d => isoDate(new Date(Date.now() + d * 864e5));
      const day = (d, off) => place(eventsFirst(calendarItems(this.events, this.tasks, dIso(d), dIso(d), now)).filter(it => it.kind === 'event' || !(this.byId.get(it.id)?.completed_at || this.byId.get(it.id)?.archived_at)), off);
      const rows = [...place(this.nowToday(), 0), ...day(1, 1440), ...day(-1, -1440)];   // today ± the neighbouring days that fall in the window
      return { dayH, nowY: y(nowMin), hours, rows };
    },
    async loadEvents() { this.events = await this.store.events.list(); _calDataV++; _calMemo.clear(); _goalStepsMemo.clear(); _goalMilestonesMemo.clear(); },
    async loadBlocks() { this.blocks = await this.store.blocks.list(); },
    _clDate() { return new Date(this.clAnchor + 'T00:00'); },
    _clWeekStart(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; },   // Sunday
    clItemColor(it) { return it.color || (it.kind === 'event' ? 'var(--accent)' : it.kind === 'task-block' ? 'var(--muted)' : 'var(--p4)'); },
    _clTime(s) { let [h, m] = s.slice(11, 16).split(':').map(Number); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`; },
    clWeekdayNames() { return CL_WD; },
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
      if (!this._clResize) { this._clResize = true; window.addEventListener('resize', () => { if (this.surface === 'plan') { this.clRecalc(); if (this.clView === 'month') this.clScrollToAnchor(); } }); }
      if (this.clView === 'month') this.clScrollToAnchor(); else this.$nextTick(() => { this._centerPages(); if (this.clView === 'day' || this.clView === 'week') this._applyDayZoom(); });
    },
    // Zoom the day/week view to waking hours (CL_WAKING_START–CL_WAKING_END) and scroll every page there.
    _applyDayZoom(tries = 5) {
      const bodies = this.$refs.clPages?.querySelectorAll('.cl-pbody'); if (!bodies?.length) return;
      const h = bodies[0].clientHeight;
      if (!h) { if (tries > 0) requestAnimationFrame(() => this._applyDayZoom(tries - 1)); return; }
      const zoom = 24 / (CL_WAKING_END - CL_WAKING_START);
      this.clZoom = zoom;
      this.clHourH = Math.round(h / 24 * zoom);
      this.$nextTick(() => { const top = CL_WAKING_START * this.clHourH; bodies.forEach(b => { b.scrollTop = top; }); });
    },
    clHeading() {
      if (this.clView === 'year') return String(this._clDate().getFullYear());
      if (this.clView === 'day') return this._clDate().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      if (this.clView === 'week') {
        const s = this._clWeekStart(this._clDate()), e = new Date(s); e.setDate(e.getDate() + 6);
        return s.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' + e.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }
      return this.clTopMonth || this._monthLabel(this._clDate());   // month: scroll-driven label
    },
    _clFocusDate() { return new Date(Math.floor(this.clFocusYM / 12), this.clFocusYM % 12, 1); },
    // month labels the HIGHLIGHTED (viewport-centered) month, not the scroll-top one
    clPeriodMain() {
      if (this.clView === 'year') return '';
      if (this.clView === 'month' && this.clFocusYM != null) return this._monthLabel(this._clFocusDate()).replace(/,?\s*\d{4}$/, '');
      return this.clHeading().replace(/,?\s*\d{4}$/, '');
    },
    clPeriodYear() {
      if (this.clView === 'month' && this.clFocusYM != null) return String(this._clFocusDate().getFullYear());
      const m = this.clHeading().match(/(\d{4})$/); return m ? m[1] : '';
    },
    clSetView(v) {
      this.clZoom = 1; this.clHourH = 0;   // reset zoom when changing views
      this._withTransition(() => { this.clView = v; }, () => { if (v === 'month') this.clScrollToAnchor(); else if (v === 'week' || v === 'day') { this._centerPages(); this._applyDayZoom(); } });
    },
    _withTransition(setFn, afterFn) {
      const run = async () => { setFn(); await this.$nextTick(); afterFn?.(); await this.$nextTick(); };
      // hidden tabs abort (InvalidStateError); overlapping ones dupe view-transition-names — guard both
      if (document.startViewTransition && document.visibilityState === 'visible' && !this._vtBusy) {
        this._vtBusy = true;
        const t = document.startViewTransition(run);
        const clear = () => { this._vtBusy = false; };
        t.finished.then(clear, clear); t.ready.catch(() => {}); t.updateCallbackDone.catch(() => {});
      } else run();
    },

    // --- read-model (module scope — never triggers reactivity) ---
    _clGroup(fromIso, toIso) {
      // clPages re-derives every tick — cache to avoid full-set scans
      const sig = fromIso + '|' + toIso + '|' + _calDataV, hit = _groupMemo.get(sig); if (hit) return hit;
      const map = {}, add = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
      for (const it of calendarItems(this.events, this.tasks, fromIso, toIso, new Date())) {
        const s = it.start.slice(0, 10), e = (it.end || it.start).slice(0, 10);
        if (it.allDay && e > s) {   // any multi-day all-day item (event or task band) explodes into connected segments
          for (let day = s < fromIso ? fromIso : s; day <= e && day <= toIso; day = add(day, 1))
            (map[day] ||= []).push({ ...it, spanStart: day === s, spanEnd: day === e });
        } else (map[s] ||= []).push(it);
      }
      if (_groupMemo.size >= 12) _groupMemo.clear();   // bound the cache; stale-_calDataV entries never hit anyway
      _groupMemo.set(sig, map); return map;
    },
    _clVisMap() {
      const sig = this.clVisStart + '|' + this.clVisCount + '|' + _calDataV, hit = _calMemo.get(sig); if (hit) return hit;
      const map = this._clGroup(isoDate(this._weekDate(this.clVisStart)), isoDate(this._weekDate(this.clVisStart + this.clVisCount)));
      _calMemo.clear(); _calMemo.set(sig, map); return map;
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
    _clZoneTop() { return CL_BAR + CL_HEAD + (this.clRowH || 1) * 1; },   // viewport line below which a title rides coupled (body band); at/above it the overlay flies over the header into the bar (~1 row of fly runway)
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
    // `top` applied imperatively so it never lags
    clZoneTitles() {
      if (!this.clRowH) return [];
      const rowH = this.clRowH, head = CL_BAR + CL_HEAD, barY = this._clBarY != null ? this._clBarY : CL_BAR - 34 - 14, zoneH = this._clZoneTop() - head, labelH = 46, scrollTop = this.clScrollTop;   // barY = measured .cl-period top (matches the idle heading on every breakpoint)
      const top = this._weekDate(Math.max(0, Math.floor(scrollTop / rowH))); top.setDate(top.getDate() + 3);
      const list = [];
      for (let k = -2; k <= 1; k++) {
        const first = new Date(top.getFullYear(), top.getMonth() + k, 1);
        const vt = head + this._weekIdx(first) * rowH - scrollTop;
        if (vt > head + zoneH) continue;
        const t = (vt - head) / zoneH;
        // LINEAR (not ease-out t*(2-t)): ease-out's zero slope at t=1 caused a visual "dip" at the band→overlay handoff.
        list.push({ name: this._monthLabel(first), y: vt <= head ? barY : barY + (head + zoneH - barY) * t });
      }
      for (let i = list.length - 2; i >= 0; i--) list[i].y = Math.min(list[i].y, list[i + 1].y - labelH);   // next month shoves the pinned one up
      return list.filter(z => z.y > -labelH).map(z => ({ name: z.name, y: Math.round(z.y), atBar: Math.abs(z.y - barY) < 3 }));
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
      const y = {}; for (const t of this.clZoneTitles()) y[t.name] = t.y;
      for (const el of box.children) { const t = y[el.dataset.name]; if (t != null) el.style.top = t + 'px'; }
    },
    clMonthScroll(e) {
      const el = e.target, topIdx = Math.max(0, Math.floor(el.scrollTop / (this.clRowH || 1)));
      this.clVisStart = Math.max(0, topIdx - CL_BUFFER);
      this.clScrollTop = el.scrollTop;   // reactive → clMonthBands recomputes each band's rise/fade
      this._clScrollState(el.scrollTop);
      this._clPositionZone();   // sync: place the over-header titles THIS frame (reactive :style lags a frame → teleports on fast scroll)
      this.clScrolling = true; clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this.clScrolling = false, 600);
      if (this._clProg) return;   // programmatic scroll (open/snap) → don't arm the snap
      // Arm only on a new gesture after ≥2s idle — trackpad fires a long chain; one snap per gesture.
      const now = Date.now();
      if (!this._clScrollTs || now - this._clScrollTs > 2000) this._clArmed = true;
      this._clScrollTs = now;
    },
    clMonthSnap(e) {
      if (this._clProg) { this._clProg = false; return; }   // swallow programmatic scrollend
      if (!this._clArmed) return;   // CSS scroll-snap handles week settling; this only fires on the first armed gesture
      this._clArmed = false;
      const el = e.target, rowH = this.clRowH || 1, cur = el.scrollTop / rowH;
      const d = this._weekDate(Math.round(cur)); d.setDate(d.getDate() + 3);
      const cands = [-1, 0, 1].map(k => this._monthFirstIdx(new Date(d.getFullYear(), d.getMonth() + k, 1)));
      const idx = cands.reduce((a, b) => Math.abs(b - cur) < Math.abs(a - cur) ? b : a);
      if (Math.abs(idx * rowH - el.scrollTop) > 2) { this._clProg = true; el.scrollTo({ top: Math.max(0, idx * rowH), behavior: 'smooth' }); setTimeout(() => { this._clProg = false; }, 700); }
    },
    clScrollToAnchor() {
      const el = this.$refs.clMonth; if (!el) return;
      if (!this.clRowH) this.clRecalc();
      const target = this._monthFirstIdx(this._clDate());
      this.clVisStart = Math.max(0, target - CL_BUFFER);
      this.clScrollTop = target * this.clRowH;
      this._clScrollState(target * this.clRowH);
      this.$nextTick(() => { this._clProg = true; el.scrollTop = target * this.clRowH; this._clScrollState(target * this.clRowH); setTimeout(() => { this._clProg = false; }, 200); });
    },
    _clStepMonth() {
      const el = this.$refs.clMonth; if (!el) return this.clScrollToAnchor();
      if (!this.clRowH) this.clRecalc();
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ top: Math.max(0, this._monthFirstIdx(this._clDate()) * this.clRowH), behavior: smooth ? 'smooth' : 'auto' });
    },
    clOpenWeekRow(idx) { this.clAnchor = isoDate(this._weekDate(idx)); this.clSetView('week'); },   // tap a week → expand

    // --- WEEK / DAY: a window of 7 pages (anchor ±3), each one viewport page; scroll snaps between them ---
    _pageSpan() { return this.clView === 'day' ? 1 : 7; },
    clPages() {
      const span = this._pageSpan(), todayIso = isoDate(new Date());
      const anchor = span === 1 ? this._clDate() : this._clWeekStart(this._clDate());
      const ws = new Date(anchor); ws.setDate(ws.getDate() - 3 * span);
      const we = new Date(anchor); we.setDate(we.getDate() + 4 * span);
      const byDay = this._clGroup(isoDate(ws), isoDate(we));
      return Array.from({ length: 7 }, (_, k) => {
        const ps = new Date(anchor); ps.setDate(ps.getDate() + (k - 3) * span);
        const cols = Array.from({ length: span }, (_, i) => {
          const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d), items = byDay[iso] || [];
          return { iso, day: d.getDate(), today: iso === todayIso, weekend: d.getDay() === 0 || d.getDay() === 6, label: d.toLocaleDateString([], { weekday: 'short' }), blocks: this._dayBlocks(iso), allday: items.filter(it => it.allDay || it.start.length <= 10), timed: this._lanePack(items.filter(it => !it.allDay && it.start.length > 10)) };
        });
        this._alignSpanLanes(cols);
        return { key: isoDate(ps), mid: k === 3, cols };
      });
    },
    // Stable all-day lanes: a spanning band keeps ONE row across every column of its page — otherwise it
    // jumps up wherever another band ends. Lanes are padded with invisible spacer chips.
    _alignSpanLanes(cols) {
      const spans = new Map();
      cols.forEach((c, i) => { for (const it of c.allday) if (it.spanStart !== undefined) { const k = it.kind + it.id, s = spans.get(k) ?? spans.set(k, { cols: [] }).get(k); s.cols.push(i); } });
      if (!spans.size) return;
      const lanes = [];   // lanes[l] = Set of occupied col indexes
      for (const s of spans.values()) {
        let l = 0; while (lanes[l] && s.cols.some(i => lanes[l].has(i))) l++;
        (lanes[l] ??= new Set()); for (const i of s.cols) lanes[l].add(i); s.lane = l;
      }
      cols.forEach((c, i) => {
        const rows = Array.from({ length: lanes.length }, () => null), rest = [];
        for (const it of c.allday) { const s = it.spanStart !== undefined ? spans.get(it.kind + it.id) : null; s ? rows[s.lane] = it : rest.push(it); }
        c.allday = [...rows.map(r => r ?? { kind: 'pad', id: 'p' + i, title: '' }), ...rest];
      });
    },
    _clMin(iso) { const t = iso.length > 10 ? iso.slice(11, 16) : '00:00'; return (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)); },
    _dayBlocks(iso) {
      return blocksInRange(this.blocks, iso, iso).map(b => {
        const sm = Math.max(0, this._clMin(b.start)), em = b.end.slice(0, 10) > iso ? 1440 : Math.min(1440, this._clMin(b.end));
        return { id: b.id, title: b.title, color: b.color, topPct: sm / 1440 * 100, hPct: Math.max(1.5, (em - sm) / 1440 * 100) };
      });
    },
    _lanePack(list) {
      const raw = list.map(it => { const sm = this._clMin(it.start), em = Math.max(this._clMin(it.end), sm + 20); return { it, sm, em }; }).sort((a, b) => a.sm - b.sm || a.em - b.em);
      let cluster = [], cend = -1; const out = [];
      const flush = () => { if (!cluster.length) return; const lanes = []; for (const p of cluster) { let k = 0; while (k < lanes.length && lanes[k] > p.sm) k++; lanes[k] = p.em; p.lane = k; } const n = lanes.length; for (const p of cluster) out.push({ it: p.it, topPct: p.sm / 1440 * 100, hPct: (p.em - p.sm) / 1440 * 100, leftPct: p.lane * 100 / n, widthPct: 100 / n }); cluster = []; cend = -1; };
      for (const p of raw) { if (p.sm >= cend && cluster.length) flush(); cluster.push(p); cend = Math.max(cend, p.em); }
      flush(); return out;
    },
    clHours() { return CL_HOURS; },
    clHourLabel(h) { return h === 0 ? '' : h < 12 ? h + ' AM' : h === 12 ? 'Noon' : (h - 12) + ' PM'; },
    clNowPct() { const n = new Date(); return (n.getHours() * 60 + n.getMinutes()) / 1440 * 100; },
    // clientHeight is 0 on first open — retry until layout settles
    _centerPages(tries = 10) {
      const el = this.$refs.clPages; if (!el) return;
      if (!el.clientHeight) { if (tries > 0) requestAnimationFrame(() => this._centerPages(tries - 1)); return; }
      const target = 3 * el.clientHeight; el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) > 2 && tries > 0) requestAnimationFrame(() => this._centerPages(tries - 1));
    },
    // ctrl+wheel vertical zoom: hours expand past viewport so day scrolls
    clPagesWheel(e) {
      if (!e.ctrlKey || !e.cancelable) return;
      e.preventDefault();
      const body = e.currentTarget.querySelector('.cl-pbody'); if (!body) return;
      const fit = body.clientHeight / 24;   // px/hour that exactly fills the viewport (the scroll-viewport height is stable)
      this.clZoom = Math.max(1, Math.min(4, +(this.clZoom - e.deltaY * 0.01).toFixed(2)));
      this.clHourH = Math.round(fit * this.clZoom);
    },
    clPagesScrollEnd(e) {
      if (_clRecenter) { _clRecenter = false; return; }
      const el = e.target, pageH = el.clientHeight; if (!pageH) return;
      const idx = Math.round(el.scrollTop / pageH); if (idx === 3) return;
      const d = this._clDate(); d.setDate(d.getDate() + (idx - 3) * this._pageSpan()); this.clAnchor = isoDate(d);
      this.$nextTick(() => { _clRecenter = true; el.scrollTop = 3 * pageH; });
    },

    clStep(dir) {
      const d = this._clDate();
      if (this.clView === 'year') { d.setFullYear(d.getFullYear() + dir); this.clAnchor = isoDate(d); return; }
      if (this.clView === 'month') { d.setMonth(d.getMonth() + dir); this.clAnchor = isoDate(d); this._clStepMonth(); return; }
      d.setDate(d.getDate() + dir * this._pageSpan()); this.clAnchor = isoDate(d); this.$nextTick(() => this._centerPages());
    },
    clToday() {
      this.clAnchor = isoDate(new Date());
      if (this.clView === 'month') this.clScrollToAnchor();
      else this.$nextTick(() => this._centerPages());
    },
    // --- YEAR — 12 mini-months with per-day item counts (heat-tinted) ---
    clYearMonths() {
      const y = this._clDate().getFullYear(), todayIso = isoDate(new Date()), byDay = this._clGroup(y + '-01-01', y + '-12-31');
      return Array.from({ length: 12 }, (_, m) => {
        const lead = new Date(y, m, 1).getDay();
        const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(y, m, 1 - lead + i), iso = isoDate(d), cur = d.getMonth() === m; return { key: iso, iso, day: d.getDate(), cur, today: iso === todayIso, n: cur ? (byDay[iso] || []).length : 0 }; });
        return { key: y + '-' + m, y, m, name: new Date(y, m, 1).toLocaleDateString([], { month: 'short' }), cells };
      });
    },
    clOpenDay(iso) { this.clAnchor = iso; this.clSetView('day'); },
    clOpenMonth(y, m) { this.clAnchor = isoDate(new Date(y, m, 1)); this.clSetView('month'); },
    // ---- Event editor (create / edit / delete) ----
    clNewEvent(date) { this.eventEdit = { title: '', date: date || this.clAnchor, start: '09:00', end: '10:00', all_day: false, color: null }; },
    _timeOf(iso, fb) { return iso.length > 10 ? iso.slice(11, 16) : fb; },
    clEditEvent(id) {
      const e = this.events.find(x => x.id === id); if (!e) return;
      this.eventEdit = { id: e.id, title: e.title, date: e.starts_at.slice(0, 10), start: this._timeOf(e.starts_at, '09:00'), end: this._timeOf(e.ends_at, '10:00'), all_day: !!e.all_day, color: e.color || null };
    },
    clItemClick(it) { if (!it) return; if (it.kind === 'event') return this.clEditEvent(it.id); if (this.clIsTask(it)) return this.clOpenTaskSide(it.id); if (it.start) this.clOpenDay(it.start.slice(0, 10)); },
    clToggleTask(id) { const t = this.byId.get(id); if (t) this.toggle(t); },
    clKeyActivate(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    clChipCls(it) {
      const done = (it.kind === 'task-due' || it.kind === 'task-block') && this.byId.get(it.id)?.completed_at ? ' done' : '';
      if (it.spanStart === undefined) return it.kind + done;
      return it.kind + done + ' cl-span' + (it.spanStart ? ' cl-span-l' : '') + (it.spanEnd ? ' cl-span-r' : '') + (!it.spanStart && !it.spanEnd ? ' cl-span-mid' : '');
    },
    clIsTask(it) { return it.kind === 'task-due' || it.kind === 'task-block'; },
    // all-day → date-only; never a backwards range; shared by event + block
    _evRange(e, date = e.date) { const end = (!e.all_day && e.end < e.start) ? e.start : e.end; return e.all_day ? { starts_at: date, ends_at: date } : { starts_at: date + 'T' + e.start, ends_at: date + 'T' + end }; },
    _toggleIn(arr, v) { const i = arr.indexOf(v); i < 0 ? arr.push(v) : arr.splice(i, 1); },
    async clSaveEvent() {
      const e = this.eventEdit; if (!e) return;
      const fields = { title: e.title.trim() || 'Untitled', all_day: e.all_day, color: e.color || null, ...this._evRange(e) };
      if (e.id) await this.store.events.update(e.id, fields); else await this.store.events.add(fields);
      await this.loadEvents(); this.eventEdit = null;
    },
    async clDeleteEvent() { if (this.eventEdit?.id) await this.store.events.remove(this.eventEdit.id); await this.loadEvents(); this.eventEdit = null; },

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
      this._clDnd = { kind, id };
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); }
    },
    clDragEndSchedule() { this._clDnd = null; this.clDropHint = null; this.clDropPreview = null; },
    _dropMin(e) {   // minutes-of-day (snapped 15) when dropped inside a week/day column; null on a month cell
      const col = e.target.closest && e.target.closest('.cl-pcol'); if (!col) return null;
      const r = col.getBoundingClientRect();
      return Math.max(0, Math.min(1425, Math.round((e.clientY - r.top) / r.height * 96) * 15));
    },
    _minLabel(min) { const h = Math.floor(min / 60), m = min % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap; },
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
      this.clDropPreview = min == null ? null : { iso, min, h: this._dragDurMin(), label: this._minLabel(min) };
    },
    _dndKind(kind) { return kind === 'event' ? 'event' : kind === 'task-due' ? 'due' : kind === 'block' ? 'block' : 'task'; },
    async clDropOn(e, iso, allDay = false) {   // allDay: dropped into the week/day all-day row → make it all-day
      const d = this._clDnd; this._clDnd = null; this.clDropHint = null; this.clDropPreview = null; if (!d || !iso) return;
      const dm = allDay ? null : this._dropMin(e);   // null ⇒ month cell or all-day row (date only)
      const stamp = dm == null ? iso : iso + 'T' + this._fmtMin(dm);
      if (d.kind === 'task' || d.kind === 'due') {
        await this.store.tasks.update(d.id, d.kind === 'due' ? { due_at: stamp } : { scheduled_at: stamp });
        await this.loadTasks();
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
      return this.tasks.filter(t => !t.completed_at && !t.archived_at && !t.scheduled_at && !t.due_at && !this.isSidebar(t) && !this.hasChildren(t.id))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 50);
    },
    clViewRange() {
      const d = this._clDate();
      if (this.clView === 'week') { const s = this._clWeekStart(d), e = new Date(s); e.setDate(e.getDate() + 6); return [isoDate(s), isoDate(e)]; }
      const iso = isoDate(d); return [iso, iso];
    },
    _clNowBounds() { const now = new Date(), today = isoDate(now); return { today, at: today + 'T' + hhmm(now) }; },
    _overdue(t, b) { return t.scheduled_at ? (t.scheduled_at.length > 10 ? t.scheduled_at < b.at : t.scheduled_at.slice(0, 10) < b.today) : (t.due_at ? t.due_at.slice(0, 10) < b.today : false); },
    clViewTasks() {
      void this._nowTickV; const [from, to] = this.clViewRange(), b = this._clNowBounds();
      return this.tasks.filter(t => t.scheduled_at && !this.isSidebar(t) && !this._overdue(t, b) && t.scheduled_at.slice(0, 10) >= from && t.scheduled_at.slice(0, 10) <= to)
        .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
    },
    // local wall-clock, never UTC
    clReschedule() {
      void this._nowTickV;   // refresh as the clock passes each task's time
      const b = this._clNowBounds();
      return this.tasks.filter(t => !t.completed_at && !t.archived_at && !this.isSidebar(t) && !this.hasChildren(t.id) && this._overdue(t, b))
        .sort((a, b) => (a.scheduled_at || a.due_at || '').localeCompare(b.scheduled_at || b.due_at || ''));
    },
    clReschedListHtml() { return this._clListHtml('res', this.clReschedule(), isoDate(new Date()) + '|' + this._nowTickV); },
    // Server auto-plan (plan_items) over the visible calendar range — same pure planAgenda + badge vocab as nowPlan().
    clPlanItems() { const [from, to] = this.clViewRange(); return planAgenda(this.plan, this.byId, from, to); },
    _clPlanRowsHtml(items) {
      const multiDay = new Set(items.map(p => p._day)).size > 1;
      let s = '', lastDay = null;
      for (const p of items) {
        if (multiDay && p._day !== lastDay) {
          lastDay = p._day;
          s += '<div class="cl-side-sec plan-day">' + this.esc(new Date(p._day + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) + '</div>';
        }
        const win = windowBadge({ due_from: p.earliest, due_at: p.latest }, new Date());
        const flags = p.flags || [], blocked = flags.includes('blocked'), infeasible = flags.includes('infeasible'), noEst = flags.includes('no_estimate');
        const waiting = blocked ? (p.after || []).map(id => this.byId.get(id)?.content).filter(Boolean).join(', ') : '';
        s += '<li class="item plan-item' + (blocked ? ' blocked' : '') + '" data-id="' + p.t.id + '">'
          + '<span class="plan-rank">' + p.rank + '</span>'
          + '<div class="task-line">' + this.taskLine(p.t) + '</div>'
          + (win ? '<span class="badge ' + this.esc(win.kind) + '">' + this.esc(win.label) + '</span>' : '')
          + (infeasible ? '<span class="badge overdue" title="Infeasible — window too tight for the estimate">⚠</span>' : '')
          + (blocked ? '<svg class="ico lock-ico" title="' + (waiting ? 'Waiting on: ' + this.esc(waiting) : 'Blocked') + '"><use href="#i-lock"/></svg>' : '')
          + (noEst ? '<span class="plan-dim" title="No estimate">◌</span>' : '')
          + '</li>';
      }
      return s;
    },
    clPlanListHtml() { return this._clPlanRowsHtml(this.clPlanItems()); },
    clSideLabel() { return this.clView === 'week' ? 'This week' : this._clDate().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }); },
    clSideVisible() { return this.clSideOpen || this.clView === 'day'; },   // the panel is up in day view (auto) or when toggled
    _clRowsHtml(tasks) {
      const now = new Date(), byId = this.byId, def = this.store.defaultProject(), byParent = buildByParent(this.tasks);
      let s = '';
      for (const t of tasks) {
        const schedTime = t.scheduled_at?.length > 10 ? this._clTime(t.scheduled_at) : null;
        // due_at carries a time component (>10 chars) only when a specific due time was set; scheduled time wins the slot if both exist
        s += '<li class="item' + (t.completed_at ? ' done' : '') + '" data-id="' + t.id + '" draggable="true">' + this.rowBody(this.mkRow(t, 0, byParent, byId, def, now), { schedTime }) + '</li>';
      }
      return s;
    },
    // x-effect re-runs on every tick — cache to avoid rebuilds on scroll
    _clListHtml(kind, tasks, sig) {
      const key = kind + '|' + this._rowV + '|' + sig, hit = _clListMemo.get(key);
      if (hit != null) return hit;
      const html = this._clRowsHtml(tasks);
      if (_clListMemo.size > 6) _clListMemo.clear();
      _clListMemo.set(key, html); return html;
    },
    clViewListHtml() { const [from, to] = this.clViewRange(); return this._clListHtml('sch', this.clViewTasks(), from + '|' + to + '|' + this._nowTickV); },
    clUnschedListHtml() { return this._clListHtml('un', this.clUnscheduled(), ''); },
    clRowClick(e) { const el = e.target.closest && e.target.closest('.item'); const t = el && this.byId.get(el.dataset.id); if (t) this.onRowClick({ t }, e); },
    clSideDragStart(e) { const el = e.target.closest && e.target.closest('.item'); if (el) this.clDragStart(e, 'task', el.dataset.id); },
    clOpenTaskSide(id) { const t = this.byId.get(id); if (!t) return; this.clSideOpen = true; this.$nextTick(() => this.editTask(t)); },
    clBlockWeekdays() { return [{ d: 0, l: 'S' }, { d: 1, l: 'M' }, { d: 2, l: 'T' }, { d: 3, l: 'W' }, { d: 4, l: 'T' }, { d: 5, l: 'F' }, { d: 6, l: 'S' }]; },
    clNewBlock(date, start, end) { this.blockEdit = { date: date || this.clAnchor, start: start || '09:00', end: end || '10:00', all_day: false, weekdays: [], location_id: null, areas: [], energy: null, availability: null, color: null, title: '' }; },
    clEditBlock(id) {
      const b = this.blocks.find(x => x.id === id); if (!b) return;
      this.blockEdit = { id: b.id, title: b.title || '', date: b.starts_at.slice(0, 10), start: this._timeOf(b.starts_at, '09:00'), end: this._timeOf(b.ends_at, '10:00'), all_day: !!b.all_day,
        weekdays: (b.recurrence?.weekdays || []).slice(), location_id: b.location_id || null, areas: (b.areas || []).slice(), energy: b.energy || null, availability: b.availability || null, color: b.color || null };
    },
    async clSaveBlock() {
      const e = this.blockEdit; if (!e) return;
      let date = e.date, recurrence = null;
      if (e.weekdays.length) {   // weekly: anchor on the first selected weekday on/after the chosen date so expansion is correct
        const wds = e.weekdays.slice().sort((a, b) => a - b), d0 = new Date(date + 'T00:00');
        for (let i = 0; i < 7 && !wds.includes(d0.getDay()); i++) d0.setDate(d0.getDate() + 1);
        date = isoDate(d0); recurrence = { freq: 'week', interval: 1, weekdays: wds };
      }
      const fields = { title: e.title.trim(), all_day: e.all_day, recurrence, location_id: e.location_id || null, areas: e.areas, energy: e.energy || null, availability: e.availability || null, color: e.color || null, ...this._evRange(e, date) };
      if (e.id) await this.store.blocks.update(e.id, fields); else await this.store.blocks.add(fields);
      await this.loadBlocks(); this.blockEdit = null;
    },
    async clDeleteBlock() { if (this.blockEdit?.id) await this.store.blocks.remove(this.blockEdit.id); await this.loadBlocks(); this.blockEdit = null; },

    // ---- Cloud sync (Supabase adapter, opt-in via magic link). LocalStore stays the offline default. ----
    async reloadAll() {
      if (this.store.requiresAuth && !this.session) return;   // cloud adapter: wait until signed in
      const b = await this.store.bootstrap();   // ONE round-trip (cloud): the whole account in a single query
      this.areas = b.areas; this.goals = b.goals;
      this.tasks = b.tasks; this.byId = new Map(b.tasks.map(t => [t.id, t]));   // ← list renders (reactive) from here
      this.filters = b.filters; this.locations = b.locations; this.travel = b.travel;
      this.events = b.events; this.blocks = b.blocks;
      try { this.plan = await this.store.plan.list(); } catch { this.plan = []; }   // server-only; degrade gracefully offline
      this.currentLocationId = this.store.currentLocationId(); this.homeLocationId = this.store.homeLocationId(); this.currentRegion = this.store.currentRegion();
      this._rowV++; _calDataV++; _calMemo.clear(); _goalStepsMemo.clear(); _goalMilestonesMemo.clear();
      await this.loadIdentities();
      // stats derivation is synchronous — paint the list first before blocking
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await this.loadStats();
    },
    async signIn() {
      const sb = sbClient(); if (!sb || !this.authEmail) return;
      // password filled → direct sign-in, no email round-trip (the built-in mailer can't carry codes)
      if (this.authPass) {
        const { error } = await sb.auth.signInWithPassword({ email: this.authEmail, password: this.authPass });
        this.authMsg = error ? error.message : ''; if (!error) this.authPass = '';   // success: onAuthStateChange takes over
        return;
      }
      // one email = magic link (+ code once custom SMTP exists); shouldCreateUser:false blocks new-account creation
      const { error } = await sb.auth.signInWithOtp({ email: this.authEmail, options: { emailRedirectTo: location.href, shouldCreateUser: false } });
      this.authMsg = error ? error.message : 'Check your email — tap the link, or enter the code below.';
      this.authSent = !error;
    },
    async verifyCode() {
      const sb = sbClient(); if (!sb || !this.authCode) return;
      const { error } = await sb.auth.verifyOtp({ email: this.authEmail, token: this.authCode.trim(), type: 'email' });
      if (error) this.authMsg = error.message;   // stay on the code form; onAuthStateChange handles success
      this.authCode = '';
    },
    // Supabase mail can't carry OTP without custom SMTP — use password for phone sign-in
    async setAppPassword() {
      const sb = sbClient(); if (!sb || !this.authPass) return;
      const { error } = await sb.auth.updateUser({ password: this.authPass });
      this.authMsg = error ? error.message : 'Password set — use it to sign in on your phone.';
      if (!error) this.authPass = '';
    },
    // Supabase re-emits SIGNED_IN on every tab focus — only uid change or sign-out recreates the store
    async onAuth(session) {
      const prevUid = this.session?.user?.id ?? null, nextUid = session?.user?.id ?? null;
      this.session = session;
      if (nextUid === prevUid) return;
      this.store.unsubscribe?.();   // tear down the old adapter's realtime channel before swapping
      this.store = session ? createSupabaseStore(sbClient()) : createLocalStore();
      this.authOpen = false; this.authSent = false; this.authEmail = ''; this.authCode = '';
      await this.reloadAll();
      this._subscribeStore();       // re-arm realtime on the new store
    },
    // realtime → app: a 'tasks' change re-pulls the task list, an 'areas' change re-pulls areas (both off the warm cache)
    _subscribeStore() { this.store.subscribe?.((kind) => kind === 'areas' ? this.loadAreas() : this.loadTasks()); },
    async signOut() { const sb = sbClient(); if (sb) await sb.auth.signOut(); },   // onAuthStateChange → onAuth(null) swaps to LocalStore
  }));
});
