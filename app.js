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

import { createLocalStore, descendantIds, ancestorIds, projectDepth, subtreeDepth, nextOccurrence, nextAcrossRules, recRules, recActive, isBlocked, MAX_DEPTH, pendingSweep, placedMap } from './store.js';
import { guardedFields, trashView, pruneJournal } from './recovery.js';
import { inNotes } from './predicates.js';
import { parseDateText, parseRecurrence, isoDate, dueBadge, windowBadge, deadlineLeft, matchTrailingToken, classifyToken, tokenizeAll, parseImportanceWords, recurrenceLabel, impRank, IMPORTANCE, WEEKDAYS } from './nlp.js';
import { markTitle, makeFuzzy, fuzzyRank, tokenize } from './search.js';
import { calendarItems, blocksInRange, occurrencesInRange, timeOf, sizeFromMinutes, minutesForSize } from './calendar.js';
import { motion, EASE_OUT } from './motion.js';
motion.install();   // registry listeners must be armed before Alpine renders anything that moves
import { esc as escHtml, mdLive as mdLiveRender, chkLive as chkLiveRender, byDone, chkVisible, raw, dotStripHtml, rollerBoxHtml, rowBodyHtml, checkHtml, mdTitle as mdTitleFn, areaChipHtml } from './ui.js';
import { makeSortable, edgeScrollStep } from './sortable.js';
import { SUPABASE, SURFACES } from './config.js';
// landing surface: lists when present, else the leftmost of the trimmed set
const SURF_HOME = !SURFACES || SURFACES.includes('lists') ? 'lists' : SURFACES[0];
import { createSupabaseStore } from './supabase-store.js';

// null when unconfigured → stays on LocalStore (UMD bundle sets globalThis.supabase at init).
let _sb;
const sbClient = () => { if (_sb === undefined) _sb = (globalThis.supabase && SUPABASE.url) ? globalThis.supabase.createClient(SUPABASE.url, SUPABASE.anonKey) : null; return _sb; };

// Module-scope: kept outside Alpine state so render reads/writes don't loop. _calDataV busts on any task/event change.

const SURF_META = { lists: { label: 'Lists', icon: 'i-all' }, plan: { label: 'Plan', icon: 'i-cal' } };
const CL_HOURS = Array.from({ length: 24 }, (_, h) => h);
const CL_WAKING_START = 8;   // default waking day start (h); future: from sleep data
const CL_WAKING_END = 24;    // waking day end (h)
const CL_EPOCH = new Date(2000, 0, 2);   // a (local) Sunday — week 0 of the virtual timeline
const CL_TOTAL_WEEKS = 5217;             // ~100 years: a fixed scroll height (no reflow) ⇒ effectively infinite
const CL_BUFFER = 10;                     // weeks rendered beyond the viewport each side (blank-free on fast flings)
const CL_HOLD_MS = 3000;                  // hold ↑/↓ this long and the step escalates from a nudge to a PERIOD
const CL_HOLD_STEP = 220;                 // ...then one period per this, so a held key travels at a readable rate
const CL_FOOT = 56;                       // bottom nav strip the timeline stops short of (must match --foot in CSS)
const CL_TITLE_PX = 15;                   // one title strip. Two events starting closer than this leave nothing of
                                          // the lower one to read, so they STACK (staggered) instead of cascading.
const CL_STACK_X = 8;                     // stagger step for concurrent peers. Splitting the width made slivers
const CL_STACK_Y = CL_TITLE_PX;           // (28px in a week column); a stack keeps every item near full width and
                                          // leaves each one a WHOLE title line of its own — which is also the only
                                          // place that hovers it, so raising one can't swallow a peer's hover zone.
// Day/week has NO SCROLLER. It is a transform viewport: clPos {idx, frac} is the position, and the timeline is
// painted at translateY(-pf · --ph). There is no spacer, so no origin, so no drift, so no excursion — the
// "insane scroll then teleport" is not fixed here, it is unrepresentable. (The old model kept a native
// scroller purely as an output sink while clPagesWheel already preventDefaulted every event and wrote
// scrollTop by hand: we paid a finite spacer over an infinite timeline, a drifting base, and five flags to
// suppress a browser scroll animation we never wanted, in exchange for nothing we used.)
const GLIDE_YIELD = ['wheel', 'touchstart', 'pointerdown'];   // a hand on the wheel outranks any animation we started
const CL_GESTURE_GAP = 140;               // ms of quiet that ends a scroll gesture (trackpad momentum fires continuously, so this only trips when the fingers are done)
const CL_TURN_MS = 368;                   // page-turn / nudge tween — we own the animation now that the browser doesn't
const CL_FLING = 0.94;                    // per-frame decay of touch-release momentum
const CL_NO_PAGE = Object.freeze({ key: '', bands: [], cols: [] });   // the rail's empty page (see clAdPage)
const CL_LEAVE_DIM = 0.55;                // how far the departing week fades behind the one arriving (see _clAdPaint)
const CL_WEEK_BLEED = 64;                 // px the week may travel PAST its own end, so the next week peeks in
const CL_MONTH_SLOW = 0.1;                // px/ms — a month scroll this slow is a crawl, and the out-of-month dim returns (tuned by feel)
const CL_MONTH_WAKE = 4;                  // ×SLOW to lift it again mid-gesture — the gap is what stops a decaying glide strobing across one threshold
const CL_MONTH_SETTLE = 260;              // ms a month scroll must stay stopped before the band/title text goes (a wheel's notches each fire scrollend)
const CL_AG_ROW = 46;                     // agenda row height (full tier); rows FLOW — proportion is the rail's job
const CL_AG_GAP = 30;                     // a hole in the day big enough to be worth naming ("1h free")
const CL_BAR = 90, CL_HEAD = 32;          // overlaid toolbar + weekday-header heights (must match --bar/--head in CSS)
const _groupMemo = new Map();   // byDay cache; busts on any task/event change
const _placedMemo = new Map();  // task_id → placement ISO; busts on _calDataV (read once per row per pass)
const _hay = new Map();   // task id -> picker search string; rebuilding it walked every parent chain per keystroke
let _hayV = -1, _relK = '', _relI = null, _candK = '', _cand = [];   // _hayV/_relK/_candK are their memo keys (see _relIdx)
const _clListMemo = new Map();   // keyed on kind|_rowV|range — Map hit on scroll/nav instead of rebuild
let _clAdNxH = null;   // last written --adh (the incoming claims rail height)
let _clBlocksSig = null, _clBlocksCache = [];   // clBlocks() single-entry memo — a view switch/scroll settle re-fires it ~100×; returning the SAME array ref lets Alpine's x-for no-op instead of re-diffing 500+ nodes
let _calDataV = 0, _clScrollT, _clFrac = 0, _clAdD, _clAdPg, _clAdH = 0;   // last boundary offset / rail page / deadline-rail height painted   // _clFrac mirrors clPos.frac without Alpine reactivity (set in _clSetPos)
const _periodLabels = new Map();   // (view|idx) -> label; toLocaleDateString is far too slow to call per wheel event
// List-drag ghost: module-level so Alpine's Proxy never wraps these DOM elements (wrapping breaks classList/style)
let _dragGhost = null, _dragBlank = null, _ghostHandler = null;
// visibleRows() memo: O(n) tree walk called many times per render; cache on _rowV+navSel+listQ so drag/animation don't recompute per frame.
let _visMemo = null, _visKey = '', _doneMemo = [], _secMemo = [], _qfToday = '', _qfTmr = '', _qfWk = '';   // _doneMemo: completed rows for the section below the add-task button
let _rowMap = null, _doneMap = null, _parentMap = null;   // id→row + parent→[childRows] Maps maintained alongside _visMemo for O(1) hover/rowFromEl lookup
let _areaUseMemo = null, _areaUseMemoV = -1, _palMemo = null, _palKey = '';
// Raw DOM refs — kept outside Alpine state so they're never proxied.
let _hoverEls = [], _fitQ = 0, _dropEl = null, _kbEl = null, _selSet = new Set();
let _jumped = false, _editIx = 0;   // _jumped: _ensureRow moved the reader to find a row · _editIx: the last flex slot the edited row held (see editIndex)
let _editPin = null;                // mirrors `editing` OUTSIDE Alpine (listHtml's pad-split reads it; a reactive read there would make composer open/close rebuild the list)
let _listW = -1, _fitV = 0;         // list width + the generation every row's fit is stamped with (see _fit)
// The overflow ladder: what leaves line 1, in order, while the title is still truncated. Everything after
// this list is what a row keeps longest — project 3rd-to-last, size 2nd-to-last, and the scheduled-time
// badge never at all. `.m.dl` is skipped when there is no scheduled time (the deadline holds that slot).
// Line 2 then degrades in place with L2_STEPS rather than wrapping. → docs/ui/task-list.md §Row overflow
const LADDER = ['.row-rels', '.m.loc', '.areas', '.m.dl', '.proj', '.m.est'];
// Line 2 reads in a FIXED order, not the order things happened to shed — otherwise the same two items
// swap places depending on which width you arrived from. Badges, then chips, then relations, then prose.
const L2_ORDER = ['.areas', '.proj', '.m.dl', '.m.loc', '.m.est', '.row-rels'];
const L2_STEPS = ['l2-shrink', 'icons-only', 'rolled'];
const L2_ROW_H = 17, L2_PAD = 4;    // one wrapped meta row + the line's own margin (layout-lists.e2e "ladder")
// WINDOWED LIST. Only the rows within WIN_MARGIN of the viewport EXIST as <li>s; the rest are two spacer
// <li>s holding their summed height, so the scrollbar stays honest. This replaces content-visibility:auto,
// which skipped their paint but kept every node alive (~25k elements at 1000 rows) — so every list-wide pass
// (fitRows, paintSel, the keyed morph, the browser's own style recalc) still paid for the whole corpus.
// Bigger margin costs rendered rows 1:1; 600px is ~15 rows each side, so a fling can't outrun the window
// between two frames.
const WIN_MARGIN = 600, SEC_H = 30;   // SEC_H: section-head height until one has actually been measured
let _model = null;                    // { rows, ent:[{id,order,h,mk}], ix:Map(id→i), total } — the flat <li> sequence
let _carryHint = null;               // Set of task ids that CHANGED in the current save; null = full rebuild
const _hCache = new Map();            // id → measured px. THE size memory contain-intrinsic-size:auto used to hold,
                                      // now ours: an estimate is only ever used for a row that has never rendered.
// The pill-NLP engine runs on an ACTIVE target: { el, draft } = the editor + the draft its pills write to.
// Null = the title (the default: $refs.content → this.draft); a focused subtask row swaps in its own editor +
// sub-draft so the SAME engine drives NLP there. Kept OUT of Alpine's reactive data (holds a live DOM node).
let _nlpFocus = null;
let _submitting = false;   // one save at a time — a repeated ⌘⏎ must not re-add the still-uncleared draft
// Every field kind the pill engine can commit — used to rebuild a draft wholesale from an editor's DOM pills.
const PILL_KINDS = ['imp', 'dur', 'proj', 'area', 'loc', 'rec', 'deadline', 'date', 'needs', 'neededBy'];
// Journal kinds that edit an OPEN composer draft and nothing else (never the store). They step in the linear
// ⌘Z timeline only while the draft they were recorded against is the one on screen — see _jSkip.
const DRAFT_KINDS = ['chk-multi', 'chk-item', 'checklist-item', 'desc-edit', 'title-nlp'];
// Per-kind spec: json flag (value stored as JSON in dataset), optional num (cast raw to number),
// and the four draft operations — all receive (self, draft, ...) so helpers like setDur/refreshRecurrenceDue are reachable.
const PILL_SPEC = {
  imp:      { json: 0, label: (s, v) => s.impName(v, 'Importance'),
              commit: (s, d, v) => { d.importance = v; }, clear: (s, d) => { d.importance = 'none'; }, snapshot: (s, d) => d.importance, restore: (s, d, x) => { d.importance = x ?? 'none'; } },
  dur:      { json: 0, num: 1, label: (s, v) => s.durFmt(v),
              commit: (s, d, v) => s.setDur(v), clear: (s, d) => { d.durMin = 0; }, snapshot: (s, d) => d.durMin, restore: (s, d, x) => { d.durMin = x || 0; } },
  proj:     { json: 0, label: (s, v) => '#' + v,
              commit: (s, d, v) => { d.project = v; d.project_id = null; s.projRequired = false; }, clear: (s, d) => { d.project = null; }, snapshot: (s, d) => ({ project: d.project, project_id: d.project_id }), restore: (s, d, x) => { d.project = x?.project ?? null; d.project_id = x?.project_id ?? null; } },
  area:     { json: 0, multi: 'areas', label: (s, v) => '@' + (s.areaById(v)?.name ?? v),
              commit: (s, d, v) => { if (!d.areas.includes(v)) d.areas.push(v); }, clear: (s, d, r) => { const i = d.areas.indexOf(r); if (i >= 0) d.areas.splice(i, 1); }, snapshot: (s, d) => [...d.areas], restore: (s, d, x) => { d.areas = x || []; } },
  loc:      { json: 0, label: (s, v) => '📍 ' + v,
              commit: (s, d, v) => { const neg = /^away from /i.test(v), nm = String(v).replace(/^away from /i, ''); const l = s.locByName(nm); d.location = { mode: neg ? 'except' : 'only', ids: l ? [l.id] : [] }; }, clear: (s, d) => { d.location = { mode: 'any', ids: [] }; }, snapshot: (s, d) => ({ mode: d.location.mode, ids: [...d.location.ids] }), restore: (s, d, x) => { d.location = x ? { mode: x.mode, ids: [...x.ids] } : { mode: 'any', ids: [] }; } },
  rec:      { json: 1, label: (s, v) => s.recurrenceLabel(v),
              commit: (s, d, v) => { d.recurrence = v; s.refreshRecurrenceDue(); }, clear: (s, d) => { d.recurrence = null; }, snapshot: (s, d) => d.recurrence ? JSON.parse(JSON.stringify(d.recurrence)) : null, restore: (s, d, x) => { d.recurrence = x || null; if (d.recurrence) s.refreshRecurrenceDue(); } },
  deadline: { json: 1, label: (s, v) => '⚑ ' + (v.only ? 'only ' : '') + dueBadge(v.iso).label + (timeOf(v.iso) ? ' ' + s.fmtTime(timeOf(v.iso)) : ''),
              commit: (s, d, v) => { d.deadline_at = v.iso; if (v.only) d.available_from = v.iso.slice(0, 10); },   // only = walled both sides
              clear: (s, d) => { d.deadline_at = ''; }, snapshot: (s, d) => ({ deadline_at: d.deadline_at, available_from: d.available_from }), restore: (s, d, x) => { d.deadline_at = (x && typeof x === 'object' ? x.deadline_at : x) || ''; if (x && typeof x === 'object') d.available_from = x.available_from || ''; } },
  // Dependencies. Both write ONE link (the other's `blocked_by`) — "needed by" is just the inverse direction,
  // recorded from the end you're usually standing at. Applied after save, since a new task has no id yet.
  needs:    { json: 0, multi: 'needs', label: (s, v) => 'needs ' + (s.byId.get(v)?.content || ''),
              commit: (s, d, v) => { if (!d.needs.includes(v)) d.needs.push(v); }, clear: (s, d, r) => { const i = d.needs.indexOf(r); if (i >= 0) d.needs.splice(i, 1); }, snapshot: (s, d) => [...d.needs], restore: (s, d, x) => { d.needs = x || []; } },
  neededBy: { json: 0, multi: 'neededBy', label: (s, v) => 'needed by ' + (s.byId.get(v)?.content || ''),
              commit: (s, d, v) => { if (!d.neededBy.includes(v)) d.neededBy.push(v); }, clear: (s, d, r) => { const i = d.neededBy.indexOf(r); if (i >= 0) d.neededBy.splice(i, 1); }, snapshot: (s, d) => [...d.neededBy], restore: (s, d, x) => { d.neededBy = x || []; } },
  date:     { json: 1, label: (s, v) => { if (v.iso) { const b = dueBadge(v.iso); return b.label + (v.time ? ' ' + s.fmtTime(v.time) : ''); } return s.fmtTime(v.time); },
              commit: (s, d, v) => { d.on = v.iso || d.on || isoDate(new Date()); if (v.iso) d.available_from = v.from ?? null; if (v.time) d.dueTime = v.time; }, clear: (s, d) => { d.on = ''; d.available_from = ''; d.dueTime = ''; }, snapshot: (s, d) => ({ on: d.on, available_from: d.available_from, dueTime: d.dueTime }), restore: (s, d, x) => { d.on = x?.on || ''; d.available_from = x?.available_from || ''; d.dueTime = x?.dueTime || ''; } },
};
// Decode a pill's dataset.value back to its typed JS value (JSON-encoded kinds vs string vs number).
function pillValue(kind, raw) { const sp = PILL_SPEC[kind]; return sp.json ? JSON.parse(raw) : sp.num ? +raw : raw; }
const DIALOG_KEYS = ['shortcutsOpen', 'trashOpen', 'locMgr', 'filterEdit', 'eventEdit', 'blockEdit', 'delAsk'];
// Completion-relevant fields for undo/redo fx diff — shared across _captureCompletionFx and _performOne task-delete path.
const FX_FIELDS = t => ({ completed_at: t.completed_at ?? null, recur_from: t.recur_from ?? null, completions: t.completions, recurrence: t.recurrence, checklist: t.checklist ?? null });
// Picker specs — drives openPicker/refreshPicker/pickPill/pickerKeydown generically.
// `char` is the trigger TEXT (not always one char — "at " opens the places), `val` maps a match row to the
// pill value, `find` locates the trigger in the node's text (default: the last occurrence of `char`).
const PICKERS = {
  area: { key: 'areaPicker', char: '@', sel: '.area-autocomplete', kind: 'area', grid: 1, name: (s, id) => s.areaById(id)?.name,
          matches: s => s.areaMatches(), onCreate: s => s.areaPicker.frag.trim() ? (s.createAreaFromPicker(), true) : false },
  proj: { key: 'projPicker', char: '#', sel: '.proj-autocomplete', kind: 'proj', name: (s, v) => v, val: p => p.content,
          matches: s => s.projMatches(), onCreate: s => s.projPicker.frag.trim() ? (s.pickPill('proj', s.projPicker.frag.trim()), true) : false },
  // `word` triggers open on the space that ENDS the word. noSpace: their fragments contain spaces
  // ("The office", "Buy the paint"), so space types through instead of picking.
  loc:  { key: 'locPicker', word: 'at', sel: '.loc-autocomplete', kind: 'loc', name: (s, v) => v, val: l => l.name,
          matches: s => s.locMatches(), noSpace: 1 },
  needs: { key: 'needsPicker', word: 'needs', sel: '.link-autocomplete', kind: 'needs', name: (s, id) => s.byId.get(id)?.content, val: t => t.id,
           matches: s => s.linkMatches(s.needsPicker.frag), noSpace: 1 },
  neededBy: { key: 'nbyPicker', word: 'needed by', sel: '.link-autocomplete', kind: 'neededBy', name: (s, id) => s.byId.get(id)?.content, val: t => t.id,
              matches: s => s.linkMatches(s.nbyPicker.frag), noSpace: 1 },
};
// A word trigger's text is the word plus its space, and it's found at the last WORD BOUNDARY — a plain
// lastIndexOf would latch onto the "at" inside "sat"/"later".
for (const k in PICKERS) if (PICKERS[k].word) {
  const w = PICKERS[k].word, re = new RegExp('(?:^|\\s)' + w + '\\s', 'gi'), n = w.length + 1;
  PICKERS[k].char = w + ' ';
  PICKERS[k].find = txt => { let i = -1, m; re.lastIndex = 0; while ((m = re.exec(txt))) i = m.index + m[0].length - n; return i; };
}
// The composer draft's empty shape — one source of truth for the title draft, resetDraft, and subtask sub-drafts.
const emptyDraft = () => ({ content: '', notes: '', importance: 'none', on: '', available_from: '', deadline_at: '', durMin: 0, dateText: '', dueTime: '', project: null, project_id: null, areas: [], goal_ids: [], checklist: [], recurrence: null, location: { mode: 'any', ids: [] }, needs: [], neededBy: [] });
let _chkQ = null, _chkFuzzy = null;   // ghost-find memo (query+len → id→ranges) + its uFuzzy instance
const QF_DUE = { today: { verb: 'due', label: 'today', col: 'var(--q-today)' }, overdue: { verb: '', label: 'overdue', col: 'var(--p1)' }, has: { verb: 'that', label: 'has a date', col: 'var(--accent)' }, none: { verb: 'with', label: 'no date', col: 'var(--faint)' } };
// Filter-editor due chips: [query word, label, QF_DUE key for the colour]. The list says 'has a date', AQL says `any` —
// same facet, two vocabularies; this table is the only place they meet.

// ── Popover placement: the ONE viewport clamp ────────────────────────────────
// Five placement sites used to inline this arithmetic, and they disagreed — one measured against
// window.innerWidth, which COUNTS THE SCROLLBAR and pushes a right-edge pop off by its width. Always
// document.clientWidth. `w`/`h` are the pop's extent INCLUDING the gutter to leave at the far edge (declared
// where the pop has a fixed width, measured where it doesn't); `m` is the near-edge margin. Neither rounds —
// call sites round at the point they write a px string, exactly as they did before.
const popLeft = (left, w, m = 6) => Math.max(m, Math.min(left, document.documentElement.clientWidth - w));
const popTop = (top, h, m = 8) => Math.max(m, Math.min(top, innerHeight - h));


// Memoize fn() keyed on sig; cap>0 bounds cache size (clear on overflow — stale-version entries never hit).
// DEP-TOUCH invariant: callers must read reactive deps BEFORE calling _memo so they run on every call.
const _memo = (map, sig, fn, cap = 0) => { const hit = map.get(sig); if (hit !== undefined) return hit; const out = fn(); if (cap && map.size >= cap) map.clear(); map.set(sig, out); return out; };

// local HH:MM
const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
// Format an HH:MM time token for chip display — strips :00 and leading 0 (09:00 → 9, 18:00 → 18)

const buildByParent = (tasks, sort = true) => {
  const m = new Map(); for (const t of tasks) { const a = m.get(t.parent_id); a ? a.push(t) : m.set(t.parent_id, [t]); }
  if (sort) for (const a of m.values()) a.sort((x, y) => (x.position ?? 0) - (y.position ?? 0)); return m;
};

// Alpine rejects x-transition promises with { isFromCancelledTransition: true } on interrupt (toast/undo routinely cut short) — swallow to keep the no-console-errors contract.
window.addEventListener('unhandledrejection', e => { if (e.reason?.isFromCancelledTransition) e.preventDefault(); });

document.addEventListener('alpine:init', () => {
  Alpine.data('adherod', () => ({
    store: createLocalStore(),
    session: null,
    authEmail: '', authCode: '', authSent: false, authMsg: '', authErr: false, authPass: '',   // inline sign-in (settings popup)
    setPassOpen: false, setPassVal: '', setPassErr: '',   // signed-in set-password affordance
    tasks: [],
    byId: new Map(),        // id → task, rebuilt in loadTasks → O(1) lookups (projName/blocked) instead of tasks.find
    parentIds: new Set(),   // ids that have children, rebuilt with byId — hasChildren was O(n) per call and rode every flush via the Now getters (stage-4 profile: 12,800 calls = 2.1s of a 2.2s save)
    areas: [],
    notifs: [],   // bottom-right notification stack: [{ id, msg, actions:[{label, fn}], leaving }]
    journal: [], cursor: 0, _jV: 0,   // inverse-op recovery engine (⌘Z/⌘⇧Z drive undo()/redo())
    draftRestored: false,   // an unsaved composer draft was recovered on open → show the restore banner
    _draftBase: '',         // pristine draft serialization at open — dirty = current !== this; drives persist/keep-on-close
    trashOpen: false,   // "Recently deleted" popup (keybound like ?) — trashItems() reads the journal, reactive on _jV
    chkOpen: new Set(),     // task ids whose collapsed "…N more" done checklist items are expanded in the list
    filters: [],            // saved filters (sidebar), loaded from store
    filterEdit: null,       // filter being edited in the modal: {id?, name, query, color}; null = closed
    locations: [],          // all locations, loaded from store
    pendingRegions: [],     // region names created in the manager but not yet holding a location (string model has no empty regions)
    dragLocId: null,        // location being dragged between region headers
    dragOverRegion: null,   // region currently hovered as a drop target
    events: [],             // calendar events, loaded from store
    blocks: [],             // condition-bearing blocks (environment per span), loaded from store
    scheduleItems: [],      // task↔block attachments; [] before migration is applied
    blockDays: [],          // block_day answer rows (start/skip/undo written here and on Android)
    clView: 'month',        // calendar view: day | week | month
    clSideOpen: false, clDropHint: null,   // Plan side-panel (scheduled + unscheduled + composer) toggle + drop-hover day iso
    peekPin: false, peekIso: '', peekEdgeHot: null, peekMonHot: '',   // Peek Pane (C2): drag-summoned docked day column on Lists; pin keeps it for batch planning; edge-dwell paging + month-dwell state
    clDropPreview: null,   // { iso, min, h, label } — live ghost of where a drag will land in a week/day column
    clAnchor: isoDate(new Date()),   // calendar anchor date (YYYY-MM-DD); drives the visible period
    clRowH: 0,              // month week-row height in px = (viewport − bar − header) / 6 (macOS: 6 weeks fill the page)
    clVisStart: 0,          // index of the first virtualized week row currently rendered
    clVisCount: 0,          // number of week rows rendered (visible + buffer); the rest is empty spacer
    clTopMonth: '',         // scroll-driven month label for the toolbar period (month view)
    clScrolling: false,     // scroll in progress → month band/title text visible; it holds until the scroll STOPS
    clFast: false,          // …moving fast enough to lift the out-of-month dim, which returns EARLIER, at a crawl
    narrow: matchMedia('(max-width: 640px)').matches,   // phone width — reactive twin of the 640px CSS block (a getter wouldn't re-render on resize)
    clVT: false,            // a view transition is capturing — see .calendar.vt (view-transition-name is layer-promoting, so it may not linger)
    clSettling: false, clPlaced: null,   // E3 arrival stagger · E4/F4 the block that just landed springs into place
    clPVisStart: 0, clPVisCount: 3,   // virtualization window over the continuous day/week timeline
    // WHERE YOU ARE, and the ONLY thing that says so. { idx: absolute period, frac: 0..1 into it }. Nothing is
    // ever read back out of the DOM to find the position — a pixel offset changes meaning the instant
    // clPeriodH does, so anything that stored one had to be corrected after every zoom/resize/view-switch, and
    // every one of those corrections was a race. Held in period-space, a zoom is just a repaint.
    clPos: { idx: 0, frac: 0 },
    clTopPeriod: '',        // scroll-driven day/week heading (mirrors clTopMonth)
    clScrollTop: 0,         // MONTH ONLY — month keeps a native scroller (bounded grid, no zoom, nothing to fight)
    clFocusYM: null,        // dominant month at center — others dim when idle
    clZoom: 1,              // 1 = whole day fits; >1 scrolls
    clHourH: 0,             // px per hour when zoomed (0 = fit)
    eventEdit: null,        // null = closed
    blockEdit: null,        // null = closed
    clDragBand: null,       // preview while drag-creating a block
    homeLocationId: null,   // designated home place (mirror of store)
    currentRegion: 'Home',
    locMgr: false,
    navSel: { type: 'all', id: null },
    // --- Spatial-canvas spine: top-level surface ∈ surfaceOrder; navSel keeps the Lists inner selection ---
    ...(() => {   // settings popup persists surface order + struck-off set (adherod.surfaces) over the config default
      const all = SURFACES ?? ['lists', 'plan'];   // config.js owns the shipped set; stale prefs naming a dropped surface are filtered out below
      let p = {}; try { p = JSON.parse(localStorage.getItem('adherod.surfaces')) || {}; } catch {}
      const ord = Array.isArray(p.order) ? p.order : [];
      const surfaceOrder = ord.filter(s => all.includes(s)).concat(all.filter(s => !ord.includes(s)));
      const home = surfaceOrder.includes(SURF_HOME) ? SURF_HOME : surfaceOrder.includes('lists') ? 'lists' : surfaceOrder[0];
      return { surfaceOrder, surface: home,
        visited: { [home]: true } };   // lazy-mount memory — heavy surfaces (Plan) mount on first visit, stay mounted
    })(),
    _nowTickV: 0, _nowDay: isoDate(new Date()),   // _nowDay: busts visibleRows memo on midnight rollover
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
    secShut: [],        // collapsed section keys (array so it persists + stays Alpine-reactive)
    groupBy: 'none',    // Lists sectioning: none|project|area|due|importance|place — sections come from this, order INSIDE one from sortBy; persisted
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
    _rowV: 0,           // visibleRows() memo key — bump on any task/area/collapse change
    dragId: null,
    relDragId: null,
    railList: [],     // move-rail drop targets, populated while a task row is dragged
    railHot: null,    // rail target currently under the drag (kind+id)
    _t: null,
    pop: null, popXY: { left: 0, top: 0 },
    titleEmpty: true,
    areaPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
    projPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
    locPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
    needsPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
    nbyPicker: { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 },
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
    // Task-list drag state
    taskDropHint: null,
    _dragX0: 0, _dragDepth: 0,
    _dragDescs: null,            // hidden during drag so the whole subtree moves
    _editDescs: null,            // precomputed so hiddenInEdit is O(1)/row

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
      await this._migratePlaceStrings();
      this._journalLoad();
      this._subscribeStore();     // activate realtime sync (no-op on LocalStore/tests)
      setInterval(() => { this._nowTickV++; const d = isoDate(new Date()); if (d !== this._nowDay) this._nowDay = d; }, 60000);   // keeps the Now-window's now-line/leave-by honest; _nowDay busts visibleRows on midnight
      document.addEventListener('selectionchange', () => this._chkSelTint());   // checklist cross-row selection tint
      // A paste event can't name the shortcut that fired it — remember ⌘/Ctrl+Shift+V here so chkPaste can honour it.
      document.addEventListener('keydown', e => { this._rawPaste = (e.metaKey || e.ctrlKey) && e.shiftKey && /^v$/i.test(e.key); }, true);   // any other key clears it
      // A trackpad PINCH arrives as ctrl/⌘+wheel. Left to the browser it page-zooms, which changes the row
      // height the virtualized calendar measures dates against — the same scrollTop then reads as a different
      // YEAR (it flew to 2014). Capture + stopPropagation so the calendar always claims it and no inner
      // scroll handler sees it as a fling.
      // Being on Plan is the WHOLE condition — ownership of a gesture must never depend on hit-testing. It
      // used to also require e.target inside `.surface-plan`, and that lost the gesture twice: over the side
      // panel/margins, and then over the ::view-transition overlay a view STEP puts up mid-pinch (e.target is
      // <html> for the ~300ms it runs, so the rest of one continuous pinch page-zoomed).
      document.addEventListener('wheel', e => {
        if (!(e.ctrlKey || e.metaKey) || this.surface !== 'plan') return;
        e.stopPropagation(); this.clZoomWheel(e);
      }, { passive: false, capture: true });
      // defer-to-blur decoration: desc and checklist items show raw text while focused, decorated on blur.
      // chk handlers use item.text (authoritative) not el.textContent (potentially stale on reused elements).
      const chkItem = (el) => {
        const id = el.closest?.('.entry.chk')?.dataset.id;
        return id ? this.draft.checklist.find(c => c.id === id) : null;
      };
      // focus and blur walk identically — the description hands off to its own handler, a checklist row repaints from the authoritative item.text.
      const decorate = (ev, desc, paint) => document.addEventListener(ev, (e) => {
        const el = e.target;
        if (el === this.$refs.desc) return desc(el);
        if (!el.matches?.('.composer-entries .entry.chk:not(.ghost) .entry-txt')) return;
        const item = chkItem(el); if (item) paint(el, item);
      }, true);
      decorate('focus', el => this.onDescFocus(el), (el, item) => { this._chkBefore = item.text; el.textContent = item.text; });   // raw text while focused (+ the pre-edit value renameChecklistItem journals against)
      decorate('blur', el => this.onDescBlur(el), (el, item) => { el.innerHTML = chkLiveRender(item.text); });    // decorated on blur
      // Phone width is a real mode, not just a stylesheet: week view is dropped and the calendar's view
      // switcher moves into the dot strip, so the flag has to be reactive and the current view legal.
      matchMedia('(max-width: 640px)').addEventListener('change', (e) => {
        this.narrow = e.matches;
        if (e.matches && this.clView === 'week') this.clSetView('day');
      });
      this.$nextTick(() => {
        const list = document.querySelector('.list');
        // contentRect is HANDED to us — the width that invalidates every row's fit costs no layout read here.
        if (list) new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w !== _listW) { _listW = w; _fitV++; } this._reflow(); }).observe(list);
        // The list is WINDOWED: scrolling is what brings rows into existence, so the scroll listener is the
        // render loop, not just a re-fit.
        const app = document.querySelector('.app');
        if (app) app.addEventListener('scroll', () => this._reflow(), { passive: true });
      });
      // Flush debounced writes synchronously before page closes — no data lost between keystrokes/actions.
      const flushAll = () => { clearTimeout(this._draftFlushT); this._flushDraftNow(); this._journalFlush(); };
      window.addEventListener('pagehide', flushAll);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
    },
    // rAF-throttle, shared by both passes: the ResizeObserver fires ~28× per composer-grow open, and a fling
    // fires scroll far faster than a frame — undebounced, each call forces a layout.
    fitRows() { if (_fitQ) return; _fitQ = requestAnimationFrame(() => { _fitQ = 0; this._fit(); }); },
    // Scroll/resize: re-window the DOM FIRST (rows only exist because we scrolled to them), then fit what
    // is now in it. One rAF for both — the fit has to read the rows the re-window just created.
    _reflow() { if (_fitQ) return; _fitQ = requestAnimationFrame(() => { _fitQ = 0; this._paintRows(); this._fit(); }); },
    // Things-style: title squeezed by areas → icons only; still squeezed → roll extras into "+N".
    // Windowing makes this pass viewport-sized by construction — every .item in the DOM is within one margin
    // of the fold — so the binary search that used to find that range (and the content-visibility caveats
    // around measuring it) is gone. Scoped to .surface-lists: Plan-surface lists are hidden and were matched
    // by the old '.list .item', costing ~37ms/pass of wasted querySelectorAll + 0-rect hits.
    _fit() {
      // Fit each row ONCE per list WIDTH. Squeeze is a function of the row's content and the width it has —
      // scrolling changes neither, so re-measuring a row that is already fitted is pure repeat work, and it
      // was 73% of a scroll pass (18 getComputedStyle + 18 title.scrollWidth per frame at 1000 rows, ~3 of
      // them for rows that had actually just arrived). The stamp rides on the ELEMENT, like morphRows' `_sig`:
      // the <li> the morph replaced comes back unstamped and is re-measured. The width generation `_fitV` is
      // bumped by the .list ResizeObserver, which HANDS us the new width — asking the DOM for it here would
      // force a second layout per pass, right after the morph dirtied it.
      // Zero-height items are the Done list while its lens is off, or a row hidden by an edit/drag: they
      // can't be squeezed — leave them UNSTAMPED so they are fitted once they are real.
      const rows = [];
      for (const el of document.querySelectorAll('.surface-lists .list .item')) {
        if (el._fitV === _fitV) continue;                                  // …before the descendant query, not after
        if (!el.querySelector('.r1l') || !el.offsetHeight) continue;
        el._fitV = _fitV; rows.push(el);
      }
      if (!rows.length) return;
      // Batch writes before reads to avoid per-row reflow: undo the previous width's fit first, so this
      // width is decided from the row's FULL content and the ladder can walk back up as well as down.
      for (const el of rows) if (el._moved || el._lad) this._unfit(el);
      // One read pass for the whole batch. Only a row whose title is actually truncated (or that has >3
      // chips, which roll on count, not width) enters the ladder — everything else costs a single read.
      const need = [];
      for (const el of rows) {
        const title = el.querySelector('.title'), g = el.querySelector('.areas');
        if (!title) continue;
        const cap = parseFloat(getComputedStyle(title).maxWidth) || Infinity;
        const squeezed = title.scrollWidth > title.clientWidth + 1 && title.clientWidth < cap - 1;
        if (squeezed || (g && g.querySelectorAll('.area').length > 3)) need.push(el);
      }
      const grew = this._ladder(need);
      // A row that gained (or lost) line 2 changed HEIGHT, and _measure already ran this pass and stamped
      // these elements for this width generation. Un-stamp exactly those and ask for one more pass, or the
      // spacers keep last width's heights and the scrollbar drifts. Converges: next pass they are _fitV-
      // stamped, so the ladder doesn't re-run and nothing schedules again.
      if (grew) { for (const el of need) el._mV = -1; this._reflow(); }
    },
    // The row's overflow ladder. Rungs fire ONE at a time and only while the title is still truncated, so a
    // row spends exactly as much of line 1 as its own title needs. Buying space in place (chips → icon
    // pills) always precedes buying it with height. The scheduled-time badge never leaves line 1; when the
    // row has no scheduled time the DEADLINE holds that slot and never leaves either.
    // Order + rationale: docs/ui/task-list.md §Row overflow. Returns true if line 2 was created.
    // RUNG-MAJOR, never row-major: each rung does ONE read pass over every row still overflowing, then one
    // write pass. Row-major (ladder one row to completion, then the next) interleaves a read after every
    // write, so 40 rows × 6 rungs cost 240 forced layouts instead of 6 — the exact cost this pass was built
    // to avoid, and what tests/row-overflow.e2e's read ratchet exists to catch.
    _ladder(rows) {
      if (!rows.length) return 0;
      const fits = (el) => { const t = el._t || (el._t = el.querySelector('.title')); return t.scrollWidth <= t.clientWidth + 1; };
      // Rung 0/1 — chips in place: >3 chips roll on COUNT (unchanged from the old fitRows), otherwise the
      // squeeze that got the row here collapses them to icon pills. Both are writes; no read needed.
      for (const el of rows) this._chipMode(el);
      const line2s = new Map();
      for (const sel of LADDER) {
        // Shed while the title is squeezed — AND for a row holding exactly ONE item on line 2. A lone item
        // is not allowed to stay (a line must earn itself), so if another rung can still supply a second
        // one, TAKE IT rather than reverting: handing back re-clips the title the first rung just fixed.
        // Measured: at 390 "Water the plants" shed its chips, fitted, hit the hand-back and came back
        // clipped to "Water the…" — while at 320, where one rung was not enough, it read in full.
        const still = rows.filter(el => {                              // READ — one layout for the batch
          const l2 = line2s.get(el);
          return !fits(el) || (l2 && l2.children.length === 1);
        });
        if (!still.length) break;
        for (const el of still) {                                      // WRITE
          if (sel === '.m.dl' && !el.querySelector('.badge')) continue;   // no scheduled time → the deadline IS it
          // The default-project chip is a bare inbox GLYPH. Moving it frees ~20px and strands an icon
          // alone on a line of its own, which reads like a bug — it is not a ladder candidate at all.
          const n = el.querySelector(sel === '.proj' ? '.proj:not(.proj-inbox)' : sel); if (!n) continue;
          let l2 = line2s.get(el);
          if (!l2) {
            l2 = document.createElement('div');
            l2.className = 'row2 meta flex items-center gap-8 min-w-0';
            const row1 = el.querySelector('.row1'); row1.parentNode.insertBefore(l2, row1.nextSibling);
            line2s.set(el, l2);
          }
          const home = n.parentElement;
          (el._moved || (el._moved = [])).push({ n, home, i: [...home.children].indexOf(n) });
          const rank = L2_ORDER.indexOf(sel);
          l2.insertBefore(n, [...l2.children].find(c => L2_ORDER.findIndex(o => c.matches(o)) > rank) || null);
          // icons-only/rolled are a LINE-1 treatment; once the chips leave line 1 the class is vestigial
          // there (it styles descendants it no longer has). Hand the count-based `rolled` to line 2 — >3
          // chips roll on any line — and let line 2's own ladder decide whether names still have to go.
          if (sel === '.areas') {
            const r1l = el.querySelector('.r1l');
            if (r1l.classList.contains('rolled')) l2.classList.add('icons-only', 'rolled');
            r1l.classList.remove('icons-only', 'rolled');
          }
        }
      }
      // A SECOND LINE MUST EARN ITSELF. One lone item down there — a bare project chip, a single badge —
      // reads worse than the slightly clipped title it bought, because the line looks like a mistake rather
      // than a row. Hand it back and let the title truncate. (Two or more is a meta row and reads as one.)
      // Whatever is STILL alone here had nothing left to pair with — the ladder ran out of rungs.
      for (const [el, l2] of line2s) {
        if (l2.children.length > 1) continue;
        this._unfit(el);                 // full restore: the node goes home, the empty line goes away
        this._chipMode(el);              // …but rung 1 was free, so the chips stay collapsed in place
        line2s.delete(el);
      }
      // Line 2 must never wrap to a third line, so it degrades IN PLACE: shrink text, then drop chip names,
      // then roll the chips away — same preference order as line 1, same rung-major batching.
      const l2s = [...line2s.values()];
      for (const cls of L2_STEPS) {
        const over = l2s.filter(l2 => l2.scrollWidth > l2.clientWidth + 1
          || [...l2.children].some(c => c.scrollWidth > c.clientWidth + 1));   // READ
        if (!over.length) break;
        for (const l2 of over) l2.classList.add(cls);                          // WRITE
      }
      return l2s.length;
    },
    // Rung 0/1 — chips collapse IN PLACE: >3 chips roll on COUNT (unchanged from the old fitRows), otherwise
    // the squeeze that got the row here collapses them to icon pills. Pure writes; costs no height, so it is
    // both the first rung and what a row keeps when a line is handed back.
    _chipMode(el) {
      const r1l = el.querySelector('.r1l'), chips = el.querySelector('.areas');
      if (!r1l.querySelector('.areas')) return void (el._lad = 1);   // chips live on line 2 now — not ours to style
      r1l.classList.add('icons-only');
      if (chips && chips.querySelectorAll('.area').length > 3) r1l.classList.add('rolled');
      el._lad = 1;
    },
    // Put every laddered node back where it came from and drop line 2. Ascending original index per home
    // restores the exact sibling order (.r1r's is sched·est·dl·loc·due·rep, and the badges read as a run).
    _unfit(el) {
      for (const { n, home, i } of (el._moved || []).sort((a, b) => a.i - b.i)) home.insertBefore(n, home.children[i] || null);
      el._moved = null; el._lad = 0;
      el.querySelector('.row2.meta')?.remove();
      el.querySelector('.r1l')?.classList.remove('icons-only', 'rolled');
    },

    // --- Nav ---
    setNav(type, id = null) {
      const SURF = { calendar: 'plan' };   // legacy type → surface (dropped surfaces fall through to Lists)
      if (this.composer.open && (type !== this.navSel.type || id !== this.navSel.id)) this.closeComposer();
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
      this.visited[name] = true;
      this.surface = name; this.navPop = null;
    },
    openOverview() {
      // Only close the composer if it's empty — non-empty content is kept behind the overview so the user doesn't lose work.
      if (this.composer.open && !this.draft.content.trim() && !this.draft.notes && !this.draft.on) this.closeComposer();
      this.ovSel = this.surfaceIndex(); this.rollerSel = 0; this.overview = true; this.rollerCenter();
    },
    closeOverview() { this.overview = false; },
    surfMeta(s) { return SURF_META[s] || { label: s, icon: 'i-all' }; },   // label + icon; an unknown surface still names itself
    surfaceLabel(s) { return this.surfMeta(s).label; },
    dotStripHtml,
    rollerBoxHtml,
    dotStripClick(e) {
      const v = e.target.closest('[data-v]'); if (v) return this.clSetView(v.dataset.v);   // the Plan dot's view segment (phone) — checked first, it sits INSIDE that dot
      const b = e.target.closest('[data-idx]'); if (!b) return;
      const i = +b.dataset.idx; i === this.surfaceIndex() ? this.openOverview() : this.goSurface(this.surfaceOrder[i]);
    },
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
    // Mirror of the pull-up: down-scroll past threshold dismisses the overview.
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
      const sc = ct.scrollHeight > ct.clientHeight + 1 ? ct : (ct.querySelector('.app') || ct);   // the actual scroller (handler may sit on the full-width surface)
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
      if (e.target.closest('input, textarea, [contenteditable], .inp, .cd-seg')) return;   // let text selection start inside a field (and a view tap in the strip), don't begin a surface swipe
      if (this.drag.active) return;   // ignore extra touch points once a drag owns the pointer
      this.drag = { active: true, x0: e.clientX, y0: e.clientY, w: this.$refs.canvas.offsetWidth, t0: e.timeStamp || performance.now(), id: e.pointerId, axis: null, from: e.target };
    },
    canvasMove(e) {
      if (!this.drag.active || e.pointerId !== this.drag.id) return;
      const dx = e.clientX - this.drag.x0, dy = e.clientY - this.drag.y0;
      if (!this.drag.axis && Math.hypot(dx, dy) > 8) {       // lock the axis once past the threshold
        this.drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        // A real horizontal list owns its own axis — the same deference onCanvasWheel
        // makes, which the pointer path never did: a finger paged the app where a trackpad scrolled the
        // lane. Finger sign is inverted from wheel delta (drag left = scroll right), hence -dx.
        if (this.drag.axis === 'x' && this._ownedByScroller(this.drag.from, e.currentTarget, 'x', -dx)) this.drag.axis = 'own';
        if (this.drag.axis === 'x') { this.dragging = true; document.body.classList.add('swiping'); try { this.$refs.canvas.setPointerCapture(e.pointerId); } catch {} }
      }
      if (this.drag.axis !== 'x') return;                     // vertical, or a list that owns it → scroll natively
      e.preventDefault();
      let d = dx;
      const i = this.surfaceIndex(), n = this.surfaceOrder.length;
      if ((i === 0 && d > 0) || (i === n - 1 && d < 0)) d *= 0.3;   // rising resistance past the ends (emil §10)
      this.dragDx = d;   // kept for test reads; no longer in :style (no Alpine UpdateLayoutTree per frame)
      this.$refs.track.style.transform = `translateX(calc(-${i * 100}% + ${d}px))`;   // imperative: GPU compositor, no style-recalc
    },
    canvasUp(e) {
      if (!this.drag.active || e.pointerId !== this.drag.id) return;
      this.drag.active = false; this.dragging = false; document.body.classList.remove('swiping');   // re-enable the transition + text selection
      const dx = this.dragDx, wasX = this.drag.axis === 'x';
      this.dragDx = 0;
      if (!wasX) return;                                      // a tap or a vertical scroll — stay put
      // Velocity from the EVENTS' own timestamps, not from when our handlers happened to run: a busy main
      // thread delays the handler, not the finger, and clock-at-handler-time under-reports the speed — which
      // silently swallows a real flick exactly when the app is loaded enough for one to matter.
      const vx = dx / Math.max(1, (e.timeStamp || performance.now()) - this.drag.t0);
      const targetIdx = this.snapTarget(dx, this.drag.w, vx, this.surfaceIndex(), this.surfaceOrder.length);
      const staysPut = this.surfaceOrder[targetIdx] === this.surface;
      this.goSurface(this.surfaceOrder[targetIdx]);
      // When surface unchanged, Alpine's :style doesn't re-evaluate, leaving the inline transform at the
      // drag offset. Reset explicitly so the CSS transition animates back to the resting position.
      if (staysPut && this.$refs.track) this.$refs.track.style.transform = `translateX(-${targetIdx * 100}%)`;
    },
    navHeading() {
      if (this.navSel.type === 'all') return 'All';
      if (this.navSel.type === 'backlog') return 'Backlog';
      if (this.navSel.type === 'project') return this.byId.get(this.navSel.id)?.content ?? 'All';
      if (this.navSel.type === 'area') return this.areas.find(x => x.id === this.navSel.id)?.name ?? 'Area';
      if (this.navSel.type === 'filter') return this.activeFilter()?.name ?? 'Filter';
      if (this.surface === 'plan') return 'Calendar';
      return 'All';
    },
    hasChildren(id) { return this.parentIds.has(id); },
    isSidebar(t) { return !!t.sidebar; },
    // Filter view: runFilter's ordered ids mapped to live task objects (order preserved).
    filterTasks() {
      const f = this.activeFilter(); if (!f) return [];
      return this.store.runFilter(f.query).map(id => this.byId.get(id)).filter(Boolean);
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
        const d = this.whenOf(t).slice(0, 10);
        if (this.qfDue === 'has' && !d) return false;
        if (this.qfDue === 'none' && d) return false;
        if (this.qfDue === 'today' && d !== _qfToday) return false;
        if (this.qfDue === 'overdue' && !(d && d < _qfToday && !t.completed_at && !t.archived_at)) return false;
      }
      return true;
    },
    rowPass(t) { return this.listHit(t) && this.qfPass(t); },
    // Sibling/root comparator for the tree walk — null = manual (keep drag/position order). Ties fall back to position (stable).
    sibCmp() {
      const by = this.sortBy; if (by === 'manual') return null;
      const dir = this.sortDir === 'desc' ? -1 : 1, FAR = '\uffff';
      const pm = this._placedMap(), when = t => this.whenOf(t, pm) || FAR;   // built once, not per comparison
      const base =
        by === 'due'      ? (a, b) => when(a).localeCompare(when(b))
      : by === 'deadline' ? (a, b) => (a.deadline_at || FAR).localeCompare(b.deadline_at || FAR)
      : by === 'importance' ? (a, b) => impRank(a.importance) - impRank(b.importance) || when(a).localeCompare(when(b))
      : by === 'created'  ? (a, b) => (a.created_at || '').localeCompare(b.created_at || '')
      :                     (() => { const col = new Intl.Collator(undefined, { sensitivity: 'base' }); return (a, b) => col.compare(a.content || '', b.content || ''); })();   // alpha: one Collator per sort, not per comparison
      return (a, b) => dir * base(a, b) || (a.position ?? 0) - (b.position ?? 0);
    },
    _saveView() { localStorage.setItem('adherod.list.view', JSON.stringify({ sortBy: this.sortBy, sortDir: this.sortDir, groupBy: this.groupBy, qfImp: this.qfImp, qfAreas: this.qfAreas, qfDue: this.qfDue, qfArchived: this.qfArchived, secShut: this.secShut })); },
    setSort(key) { if (this.sortBy === key && key !== 'manual') this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'; else { this.sortBy = key; this.sortDir = 'asc'; } this._saveView(); },
    // Grouping lives in the SORT menu because it answers the same question ("how is this list arranged?") and
    // the sentence only grows a clause once it has something to say — a permanent "sectioned by none" is a
    // control shouting about a feature you aren't using.
    setGroup(key) { this.groupBy = key; this.secShut = []; this._saveView(); this._rowV++; },
    groupWord() { return ({ project: 'projects', area: 'areas', due: 'dates', importance: 'importance', place: 'places' })[this.groupBy] || ''; },
    toggleSec(k) { this._toggleIn(this.secShut, k); this._rowV++; this._saveView(); },
    toggleQfImp(v) { this._toggleIn(this.qfImp, v); this._saveView(); },
    toggleQfArea(id) { this._toggleIn(this.qfAreas, id); this._saveView(); },
    setQfDue(v) { this.qfDue = this.qfDue === v ? null : v; this._saveView(); },
    toggleQfArchived() { this.qfArchived = !this.qfArchived; this._saveView(); },
    clearQf() { this.qfImp = []; this.qfAreas = []; this.qfDue = null; this.qfArchived = false; this._saveView(); },
    // --- Hearthsay sentence labels ---
    qfImpLabel() { return [...this.qfImp].sort((a, b) => impRank(a) - impRank(b)).map(v => this.impName(v)).join('·'); },   // e.g. Must·Focus, importance order
    _qfArea() { return this.areas.find(a => a.id === this.qfAreas[0]); },
    qfAreaCol() { return this._qfArea()?.color || this.areaDefault; },
    qfAreaLabel() { const n = this.qfAreas.length; return (this._qfArea()?.name || '?') + (n > 1 ? ` +${n - 1}` : ''); },
    qfDueVerb()  { return QF_DUE[this.qfDue]?.verb ?? ''; },   // connective before the token; '' for overdue
    qfDueLabel() { return QF_DUE[this.qfDue]?.label; },
    qfDueCol()   { return QF_DUE[this.qfDue]?.col; },
    // The sentence is one shape per facet — [connective] then a token that opens the menu and clears itself —
    // so this table IS the grammar: array order is reading order, and a new facet is one entry, not a 4th
    // copy of the markup. A facet WITHOUT a `verb` key renders no connective (importance leads the line);
    // due keeps one even when empty ('' for overdue), because the span is a flex item the spacing counts on.
    qfFragments() {
      const f = [];
      if (this.qfImp.length) f.push({ k: 'imp', aria: 'importance', cls: 'ls-tok-pri', flag: true, col: this.qfImpCol(), label: this.qfImpLabel() });
      if (this.qfAreas.length) f.push({ k: 'area', aria: 'area', verb: 'in', dot: true, col: this.qfAreaCol(), label: this.qfAreaLabel() });
      if (this.qfDue) f.push({ k: 'due', aria: 'due', verb: this.qfDueVerb(), col: this.qfDueCol(), label: this.qfDueLabel() });
      return f;
    },
    clearQfFacet(k) { if (k === 'imp') this.qfImp = []; else if (k === 'area') this.qfAreas = []; else this.qfDue = null; this._saveView(); },
    qfFacets() { return this.qfFragments().length; },
    sortWord() { return ({ manual: 'hand', due: 'due date', importance: 'importance', deadline: 'deadline', alpha: 'a-z', created: 'date added' })[this.sortBy]; },   // follows the "· sorted by" verb
    // Escalate the ad-hoc sentence into a saved filter; pre-populates the AQL textarea from the live filter state.
    lsSaveFilter() {
      this.listMenu = null;
      const f = { imp: this.qfImp, areas: this.qfAreas, due: { has: 'any' }[this.qfDue] || this.qfDue, done: this.showCompleted, arch: this.qfArchived };
      const or = xs => xs.length > 1 ? `(${xs.join(' OR ')})` : xs[0];
      const parts = [];
      if (f.imp.length) parts.push(or([...f.imp].sort((a, b) => impRank(a) - impRank(b)).map(v => 'importance:' + v)));
      if (f.areas.length) parts.push(or(f.areas.map(id => { const n = this.areas.find(a => a.id === id)?.name || ''; return '@' + (/\s/.test(n) ? `"${n}"` : n); })));
      if (f.due) parts.push('due:' + f.due);
      if (f.done && f.arch) parts.push('is:any');
      else if (f.done) parts.push('(is:open OR is:done)');
      else if (f.arch) parts.push('(is:open OR is:archived)');
      this.openFilterEditor({ name: '', query: parts.join(' ') });
    },
    // All values, always — a filter you can't reach reads as missing, not tidy (user 2026-07-23). Importance order.
    availImp() { return IMPORTANCE; },
    // Children index (O(n) tree walk) + mkRow closure — shared by visibleRows and the link picker. Hot path: no per-row work added.
    _mkRowFn(sort, cmp) {
      const byId = this.byId, def = this.store.defaultProject(), now = new Date(), byParent = buildByParent(this.tasks, sort && !cmp);
      if (cmp) for (const a of byParent.values()) a.sort(cmp);
      const edMemo = new Map(), pm = this._placedMap();
      return { mkRow: (t, depth) => this.mkRow(t, depth, byParent, byId, def, now, edMemo, pm), byParent, now, byId };
    },
    visibleRows() {
      // Reads here register Alpine deps so the x-for re-runs on change. Completed rows split into _doneMemo (rendered below the add button).
      const key = this._rowV + '|' + this.navSel.type + '|' + this.navSel.id + '|' + this.listQ + '|' + this.showCompleted
        + '|' + this.sortBy + this.sortDir + '|' + this.qfImp + '|' + this.qfAreas + '|' + this.qfDue + '|' + this.qfArchived
        + '|' + this.groupBy + '|' + this.secShut + '|' + this._nowDay;
      if (_visKey === key) return _visMemo;
      _qfToday = this._nowDay; const _t0 = new Date(_qfToday + 'T00:00'); _qfTmr = isoDate(new Date(_t0.getTime() + 864e5)); _qfWk = isoDate(new Date(_t0.getTime() + 6 * 864e5));   // once per recompute; relative to _nowDay for DST safety
      const filtering = this.filtering(), cmp = this.sibCmp();
      // Subproject sections: only INSIDE a container view. All/area scope by something other than containment,
      // where a project is a legitimate row rather than the thing the list is about.
      const subSec = this.groupBy === 'none' && this.navSel.type === 'project';
      const { mkRow, byParent, byId } = this._mkRowFn(true, cmp);
      let out = []; const done = [];   // active rows (main list) + below-the-line (completed via 'done' lens, archived via 'archived' lens)
      // Additive lenses: OPEN tasks always fill the main list; the 'done' lens adds completed tasks and the
      // 'archived' lens adds archived tasks to the below-the-line section (both, when both are on).
      // Filter view: matches + their ANCESTOR CHAIN as context rows (r.ctx), so a matched subtask keeps its parents.
      // Flat was wrong twice over — hits arrived orphaned, and a project (never a match itself, matchQuery drops
      // sidebars) simply vanished, which reads as "my whole checklist is missing from the filter".
      if (this.navSel.type === 'filter') {
        let rows = filtering ? this.filterTasks().filter(t => this.rowPass(t)) : this.filterTasks();
        if (cmp) rows = rows.slice().sort(cmp);
        const hits = [];
        for (const t of rows) {
          if (t.archived_at) { if (this.qfArchived) done.push(mkRow(t, 0)); }        // below-the-line stays flat: it's a review list, not a tree
          else if (t.completed_at) { if (this.showCompleted) done.push(mkRow(t, 0)); }
          else hits.push(t);
        }
        const keep = new Map(), def = this.store.defaultProject();   // id → true = matched, false = pulled in only as an ancestor
        for (const t of hits) {
          keep.set(t.id, true);
          const seen = new Set([t.id]);
          // stop at the default project — the inbox is where "no project" lives, so naming it adds nothing
          for (let a = byId.get(t.parent_id); a && a.id !== def && !seen.has(a.id); a = byId.get(a.parent_id)) { seen.add(a.id); if (!keep.has(a.id)) keep.set(a.id, false); }
        }
        const roots = [], seenRoot = new Set();   // first-hit order, so an unsorted filter keeps runFilter's ranking
        for (const t of hits) {
          let r = t, seen = new Set();
          while (r.parent_id && keep.has(r.parent_id) && !seen.has(r.id)) { seen.add(r.id); r = byId.get(r.parent_id); }
          if (!seenRoot.has(r.id)) { seenRoot.add(r.id); roots.push(r); }
        }
        if (cmp) roots.sort(cmp);
        const visitF = (t, depth) => {
          out.push(Object.assign(mkRow(t, depth), { ctx: !keep.get(t.id) }));
          for (const c of (byParent.get(t.id) || [])) if (keep.has(c.id)) visitF(c, depth + 1);
        };
        for (const r of roots) visitF(r, 0);
      } else {
        // When narrowing (search or quick-filters), keep only scope roots that pass + their full subtrees.
        // Subtask matches do NOT pull ancestors in — filters apply to top-level tasks only.
        let roots = this.scopeRoots();
        let keep = null;
        if (filtering) {
          keep = new Set();
          const addSubtree = (id) => { keep.add(id); for (const c of (byParent.get(id) || [])) addSubtree(c.id); };
          for (const r of roots) if (this.rowPass(r)) addSubtree(r.id);
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
        if (cmp) roots = roots.slice().sort(cmp);
        // Subprojects sink BELOW the project's own tasks: they become section heads, and a head sitting mid-list
        // reads as though the loose tasks after it belonged to it. sort is stable, so each group keeps its order.
        if (subSec) roots = roots.slice().sort((a, b) => (this.isSidebar(a) ? 1 : 0) - (this.isSidebar(b) ? 1 : 0));
        // Sections come from the group, the order INSIDE one from the sort — so grouping never throws your sort away.
        if (this.groupBy !== 'none') {
          const rk = new Map(roots.map(t => [t.id, this._groupOf(t).rank]));
          roots = roots.slice().sort((a, b) => rk.get(a.id) - rk.get(b.id));
        }
        for (const r of roots) visit(r, 0);
      }
      if (this.navSel.type === 'filter') { const [secs, kept] = this._promoteSections(out, r => !!r.ctx); _secMemo = secs; out = kept; }
      else if (this.groupBy !== 'none') { const [secs, kept] = this._sectionize(out); _secMemo = secs; out = kept; }
      // Inside a project, its sidebar subprojects become section heads even with grouping OFF — a subproject is
      // a container, and drawn as one more row it read as a sibling of the tasks it actually holds.
      else if (subSec) { const [secs, kept] = this._promoteSections(out, r => this.isSidebar(r.t)); _secMemo = secs; out = kept; }
      else _secMemo = [];
      // Neighbor ids so itemBlock (the hover "block" highlight) is O(1)/row — for both the active and Done lists.
      for (const arr of [out, done]) for (let k = 0; k < arr.length; k++) {
        arr[k].prevId = arr[k - 1]?.t.id; arr[k].prevPid = arr[k - 1]?.t.parent_id;
        arr[k].nextId = arr[k + 1]?.t.id; arr[k].nextPid = arr[k + 1]?.t.parent_id;
      }
      _visKey = key; _visMemo = out; _doneMemo = done;
      _rowMap = new Map(); _parentMap = new Map(); _doneMap = new Map();
      for (const r of out) { _rowMap.set(r.t.id, r); const ch = _parentMap.get(r.t.parent_id); ch ? ch.push(r) : _parentMap.set(r.t.parent_id, [r]); }
      for (const r of done) _doneMap.set(r.t.id, r);
      return out;
    },
    // Which section a ROOT task belongs to. rank orders the sections; the unset bucket always sinks last.
    _groupOf(t) {
      const LAST = 1e9, by = this.groupBy;
      if (by === 'project') { const p = this.byId.get(t.parent_id); const on = p && p.sidebar && p.id !== this.store.defaultProject();
        return on ? { k: p.id, label: p.content || 'Project', rank: p.position ?? 0 } : { k: '_none', label: 'No project', rank: LAST }; }
      if (by === 'area') { const a = this.areaObjs(t.area_ids)[0];
        return a ? { k: a.id, label: a.name, rank: a.position ?? 0 } : { k: '_none', label: 'No area', rank: LAST }; }
      if (by === 'importance') { const v = t.importance || 'none';
        return { k: v, label: this.impName(v), rank: impRank(v) }; }
      if (by === 'place') { const id = (t.location?.ids || [])[0], l = id && this.locations.find(x => x.id === id);
        return l ? { k: l.id, label: l.name, rank: l.position ?? 0 } : { k: '_none', label: 'Anywhere', rank: LAST }; }
      const d = this.whenOf(t).slice(0, 10);                                      // due
      if (!d) return { k: '_none', label: 'No date', rank: LAST };
      return d < _qfToday ? { k: 'over', label: 'Overdue', rank: 0 } : d === _qfToday ? { k: 'today', label: 'Today', rank: 1 }
        : d === _qfTmr ? { k: 'tmr', label: 'Tomorrow', rank: 2 } : d <= _qfWk ? { k: 'week', label: 'This week', rank: 3 }
        : { k: 'later', label: 'Later', rank: 4 };
    },
    // → [sections, keptRows]. A section head is INDEPENDENT of its rows (`at` = row index), so a shut section
    // still shows its header with nothing under it — attaching the head to its first row would hide it too.
    _sectionize(rows) {
      const secs = [], kept = []; let cur = null, head = null;
      for (const r of rows) {
        if (r.depth === 0) {
          const g = this._groupOf(r.t);
          if (g.k !== cur) { cur = g.k; head = { key: g.k, label: g.label, count: 0, shut: this.secShut.includes(g.k), at: kept.length, ...this._secPie(g.k) }; secs.push(head); }
          head.count++;
        }
        if (!head?.shut) kept.push(r);
      }
      return [secs, kept];
    },
    sections() { this.visibleRows(); return _secMemo; },
    // When a section IS a project, its head wears the same conic pie the picker gives that project — "how far
    // along is this" belongs where the project is being worked, not only where it's chosen. Keyed off byId, so
    // it fires for project grouping and subproject sections alike and stays inert for date/area/importance keys.
    _secPie(k) { const p = this.byId.get(k); return p?.sidebar ? { pct: this.projectProgress(k) / 100, pieColor: p.color || '' } : {}; },
    // Filter view: a ROOT ancestor that only provides context becomes a section HEAD rather than a dimmed row —
    // same vocabulary as grouping ("these rows live under this"), one less idiom to learn. Deeper ancestors stay
    // inline context rows, and everything under a head shifts up a level so the indent still reads as the tree.
    // A root that MATCHED stays a plain row: it's a result in its own right, not a container.
    // A depth-0 row that `isHead` claims becomes a section HEAD instead of a row, and its subtree shifts up a
    // level so the indent still reads as the tree. Two callers, one idiom: a filter view promotes the ancestors
    // that only provide context, a project view promotes its sidebar subprojects.
    _promoteSections(rows, isHead) {
      const secs = [], kept = []; let head = null;
      for (const r of rows) {
        if (r.depth === 0) {
          if (!isHead(r)) head = null;
          else { head = { key: r.t.id, label: r.t.content, count: 0, shut: this.secShut.includes(r.t.id), at: kept.length, ...this._secPie(r.t.id) }; secs.push(head); continue; }
        } else if (head) { r.depth--; if (!r.ctx) head.count++; }
        if (!head?.shut) kept.push(r);
      }
      return [secs, kept];
    },
    // The head's morph identity — _secLi stamps it as data-id, _entries keys the part by it; the two MUST agree or every head re-parses.
    _secKey(g) { return 'sec:' + g.at + ':' + g.key; },
    // Section head: the Done head's own type + count, plus a chevron on the row-chevron column.
    _secLi(g) {
      return '<li class="sec-row flex items-center" data-id="' + this._secKey(g) + '" data-sec="' + escHtml(g.key) + '" style="order:' + (g.at * 2 - 1) + '">'
        + '<svg class="ico sec-chev"' + (g.shut ? ' style="transform:rotate(-90deg)"' : '') + '><use href="#i-chev-d"/></svg>'
        + '<span class="sec-lbl">' + escHtml(g.label) + '</span><span class="sec-ct">' + g.count + '</span>'
        // AFTER the count, never before the label: the chevron/label column is aligned to the row chevron and the
        // Done head by deliberate convention (layout-lists asserts it), and a leading pie shifts the label 18px.
        + (g.pct == null ? '' : '<span class="rl-prog sec-pie" style="--p:' + g.pct + ';--pc:' + escHtml(g.pieColor || 'var(--muted)') + '"></span>')
        + '<span class="head-rule"></span></li>';
    },
    completedRows() { this.visibleRows(); return _doneMemo; },   // computed alongside visibleRows; the Done list below the add button
    // Same pure row markup as listHtml (order + depth padding so it aligns with the active list), so the single
    // composer can relocate into the Done list and open inline on a completed task. Edit styling via applyEditDom().
    // Shared <li> builder — used by _entries (list/done, with depth style + drag) and _clRowsHtml (tray, draggable always).
    _itemLi(r, { style = '', drag = '', schedTime = null } = {}) {
      const t = r.t;
      return '<li class="item' + (t.completed_at ? ' done' : t.archived_at ? ' archived' : r.blocked ? ' waiting' : '') + (r.ctx ? ' ctx' : '') + ' flex gap-10" data-id="' + t.id + '"' + (style ? ' style="' + style + '"' : '') + drag + '>' + this.rowBody(r, { schedTime }) + '</li>';
    },
    // Height estimate for a row that has NEVER been rendered (once one has, _hCache holds its real height).
    // One flat 38px guess against real 34/46/54+ rows made the scrollbar lurch on the way down (#307), so this
    // tracks the same content the row builder renders.
    _rowEst(r) {
      const chk = r.collapsed ? [] : (r.chk || r.t.checklist || []);   // folded → the checklist contributes no height
      const n = chk.length ? chkVisible(chk, !!r.t.checklist_plain, this.chkOpen.has(r.t.id)) : null;
      // Relations no longer own a line — they ride line 1 until the ladder sheds them onto the shared meta
      // line. NOTES always own theirs (prose never joins the meta line), so they still add their own 17.
      const ml = this._metaLines(r);
      return 34 + (ml ? L2_PAD + ml * L2_ROW_H : 0) + (r.t.notes ? 17 : 0) + (n ? 4 + (n.rows.length + (n.more ? 1 : 0)) * 19 : 0);
    },
    // How many WRAPPED rows the meta line will take (0 = none spent). Only _fit can KNOW, since it measures,
    // but a row that has never rendered has no measurement — and guessing one line for a taller row is
    // exactly the lurch #307 fixed. Approximate from the same inputs the row builder has: title length
    // against the width left over after the metadata, then how many rows that metadata needs. Deliberately
    // cheap and slightly eager; _measure overwrites it with the real height the instant the row renders,
    // so this only has to keep the scrollbar honest while the reader scrolls past.
    _metaLines(r) {
      if (_listW < 0) return 0;
      const meta = (r.areas?.length ? 8 + r.areas.length * 46 : 0) + (r.projName ? 92 : 0) + (r.estSize ? 20 : 0)
        + (r.dl ? 42 : 0) + (r.loc ? 62 : 0) + (r.due ? 56 : 0)
        + (r.rels?.length ? r.rels.length * 72 : 0);
      const avail = _listW - 46 - r.depth * 22;                              // 46 = gutter + check + gaps
      if (!meta || r.t.content.length * 7.2 + meta <= avail) return 0;       // everything still fits line 1
      return Math.max(1, Math.min(3, Math.ceil(meta / avail)));              // the meta line wraps as needed
    },
    // Rows → ENTRIES: one per <li>, carrying its flex `order`, its HEIGHT and a builder. The height is why
    // this shape exists — the render window and its two spacers are computed from these numbers, so a scroll
    // frame never walks the DOM. Measured beats estimated: an estimate is only ever used for a row that has
    // never rendered. Section heads interleave by their `at`; shut sections at the end still show their head.
    _entries(rows, drag = '', secs = null) {
      const ent = []; let si = 0;
      const head = () => { const g = secs[si++], id = this._secKey(g); ent.push({ id, order: g.at * 2 - 1, h: _hCache.get(id) ?? SEC_H, html: '', mk: () => this._secLi(g) }); };
      for (let i = 0; i < rows.length; i++) {
        while (secs && si < secs.length && secs[si].at === i) head();
        const r = rows[i], style = 'order:' + (i * 2) + ';padding-left:calc(18px + ' + (r.depth * 22) + 'px);--d:' + r.depth;
        ent.push({ id: r.t.id, order: i * 2, h: _hCache.get(r.t.id) ?? this._rowEst(r), html: '', mk: () => this._itemLi(r, { style, drag }) });
      }
      while (secs && si < secs.length) head();
      return ent;
    },
    // Entries → PARTS: [{ id, html }], one per <li>, NOT one concatenated string. The row markup was always
    // built per row and then joined; joining it threw away the only thing the morph actually needs. With a
    // single string the morph had to parse the WHOLE list (6.8ms of a 9.8ms morph at 1000 rows) and serialize
    // outerHTML per row to compare — so ticking one checkbox re-parsed 666KB. Keyed by id, each row's html IS
    // its signature, so an unchanged row costs a string compare and nothing else.
    // Built ONCE per entry, then handed out by reference. A scroll frame re-emits ~18 parts to change ~2, and
    // rebuilding each row's markup meant ~18 fresh ~600-byte strings per frame (GC churn through a whole
    // fling) AND a char-by-char compare in renderRows' early-out. Cached, the unchanged rows are the SAME
    // string object, so the compare is a pointer hit and nothing is allocated.
    _parts(ent, s = 0, e = ent.length) { const out = []; for (let i = s; i < e; i++) { const p = ent[i]; out.push({ id: p.id, html: p.html || (p.html = (window.__adhMkN = (window.__adhMkN || 0) + 1, p.mk())) }); } return out; },
    // The cache is only stale when something OUTSIDE visibleRows() changes what a row renders, and chkOpen
    // (the checklist "…N more" toggle) is the only such input — every other one busts the whole model.
    _dropRowHtml(id) { const e = _model && _model.ent[_model.ix.get(id)]; if (e) e.html = ''; },
    // completedRows() always carry completed_at OR archived_at, so the trailing '' in _itemLi never fires here.
    // Not windowed: the Done list is what the done lens turned up, not a corpus.
    doneHtml() { return this._parts(this._entries(this.completedRows())); },
    // The active list's flat model, memoised on the visibleRows() identity (which already busts on every
    // task/nav/filter/sort/collapse change). Rebuilt rarely; walked on every scroll frame.
    _listModel() {
      const rows = this.visibleRows();
      if (_model && _model.rows === rows) return _model;
      const ent = this._entries(rows, this.navSel.type !== 'area' ? ' draggable="true"' : '', this.sections());
      if (_model && _carryHint) { for (let i = 0; i < ent.length; i++) { const e = ent[i], oi = _model.ix.get(e.id); if (!_carryHint.has(e.id) && oi === i && _model.ent[oi].html) e.html = _model.ent[oi].html; } _carryHint = null; }
      const ix = new Map(); let total = 0;
      for (let i = 0; i < ent.length; i++) { ix.set(ent[i].id, i); total += ent[i].h; }
      return (_model = { rows, ent, ix, total });
    },
    // The list's first-entry position in scroll coordinates, READ off the DOM (the top spacer's own top)
    // rather than computed: everything above the window that can change height — the controls, an open
    // composer pulled up over its row — is absorbed instead of guessed at.
    _listOrigin(sc) {
      const rowsEl = document.querySelector('.surface-lists .rows'); if (!rowsEl) return 0;
      const el = rowsEl.firstElementChild || rowsEl.parentElement;
      return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    },
    // Fold the LIVE heights of the rendered entries back into the model. This IS the size memory the browser
    // used to keep for us (contain-intrinsic-size:auto); without it the spacers, and so the scrollbar, drift.
    // Measured ONCE per element per width generation (`_fitV`, same key _fit stamps with): a row's height is
    // a function of its content and the width, and scrolling changes neither. That is not a micro-saving —
    // this runs at the top of every pass, right after the previous pass wrote to the DOM, so ANY read here
    // forces a whole layout. Skipping the read on a steady-state frame removes that layout entirely.
    // A 0 height is a row hidden by an edit or a drag: don't cache the hole and don't stamp it, so it is
    // measured for real once it is.
    _measure(m) {
      const rowsEl = document.querySelector('.surface-lists .rows'); if (!rowsEl) return;
      for (const el of rowsEl.children) {
        if (el._mV === _fitV) continue;
        const i = m.ix.get(el.dataset.id); if (i == null) continue;   // spacers: no entry, nothing to measure
        const h = el.offsetHeight; if (!h) continue;
        el._mV = _fitV;
        if (h !== m.ent[i].h) { _hCache.set(el.dataset.id, h); m.total += h - m.ent[i].h; m.ent[i].h = h; }
      }
    },
    // Which entries must EXIST as <li>s: everything within WIN_MARGIN of the scroller's client box.
    _winOf(m) {
      const sc = this._listScroller();
      if (!sc) return { s: 0, e: m.ent.length, top: 0, bot: 0 };
      // The open composer sits INSIDE the run of rows and is taller than the row it covers, pushing
      // everything below it down; widen the window by its height rather than model it.
      const y0 = sc.scrollTop - this._listOrigin(sc) - WIN_MARGIN;
      const y1 = y0 + sc.clientHeight + 2 * WIN_MARGIN + (this.composer.open ? (this.$refs.composer?.offsetHeight || 0) : 0);
      const ent = m.ent; let y = 0, s = 0, e;
      while (s < ent.length && y + ent[s].h <= y0) y += ent[s++].h;
      const top = y;
      for (e = s; e < ent.length && y < y1; e++) y += ent[e].h;
      return { s, e, top, bot: Math.max(0, m.total - y) };
    },
    // WINDOWED parts for the active list: the rows near the viewport, bracketed by two spacer <li>s that hold
    // the elided rows' summed height so the scrollbar stays honest. A spacer is omitted when its side is
    // empty, which keeps `.sec-row:first-child` on the list's real first head.
    // Pure over visibleRows() — deliberately does NOT read `editing`, so opening the composer never rebuilds
    // the list; the edited-row crossfade + subtree-hide are stamped imperatively by applyEditDom().
    listHtml() {
      const m = this._listModel();
      this._measure(m);
      const w = this._winOf(m), out = this._parts(m.ent, w.s, w.e);
      // data-id, like every other part: morphRows keys the reconciliation off it, and two elements sharing
      // the undefined key collided — the old spacer was orphaned into the list and its height double-counted.
      const pad = (id, order, h) => ({ id, html: '<li class="win-pad" data-id="' + id + '" style="order:' + order + ';height:' + h + 'px"></li>' });
      // The composer's flex order pins it to its row's slot. If that slot is elided into a spacer, the spacer
      // would sort to the other side of the composer, and the composer's flow height (composerH - startH)
      // would hop across _listOrigin's measurement point — flipping the very window decision that elided the
      // row: a 2-frame flicker loop rippling through every row below. Split the spacer at the slot instead,
      // so the composer stays sandwiched at its place on either side of the boundary.
      const k = _editPin != null ? m.ix.get(_editPin) : undefined;
      const split = (from, to, idA, idB) => {   // spacer covering entries [from..to), split around entry k
        let hA = 0; for (let i = from; i <= k; i++) hA += m.ent[i].h;
        let hB = 0; for (let i = k + 1; i < to; i++) hB += m.ent[i].h;
        const o = m.ent[k].order;
        return [...(hA ? [pad(idA, o - 1, hA)] : []), ...(hB ? [pad(idB, o + 1, hB)] : [])];
      };
      if (w.top) out.unshift(...(k < w.s ? split(0, w.s, '__wtop', '__wtop2') : [pad('__wtop', (m.ent[w.s]?.order ?? 0) - 1, w.top)]));
      if (w.bot) out.push(...(k >= w.e ? split(w.e, m.ent.length, '__wbot2', '__wbot') : [pad('__wbot', (m.ent[w.e - 1]?.order ?? 0) + 1, w.bot)]));
      return out;
    },
    _paintRows() { const el = document.querySelector('.surface-lists .rows'); if (el) this.renderRows(el, this.listHtml()); },
    // Imperative row state (edit crossfade, selection, keyboard focus) lives on the ELEMENTS, so a morph — or
    // the window sliding a row back in — has to re-stamp it. One place, run after every list render.
    _repaintRows() { this.applyEditDom(); this.paintSel(); this._paintKb(); },
    // The scroll-coordinate top of an entry, straight out of the model — a windowed list can be asked to go
    // to a row that has no element at all.
    _modelTop(id) {
      const m = this._listModel(), i = m.ix.get(id), sc = this._listScroller();
      if (i == null || !sc) return null;
      let y = this._listOrigin(sc);
      for (let j = 0; j < i; j++) y += m.ent[j].h;
      return y;
    },
    // Anything that MEASURES or TOUCHES a row by id must bring it into the DOM first — the window only holds
    // the rows near the viewport. Jumps to the row's modelled position and re-windows SYNCHRONOUSLY: callers
    // need the element in this tick (editTask measures startH/blockH off it, _paintKb stamps the ring), and a
    // glide delivers a position over frames, not an element now. So this is the one place that writes
    // scrollTop by hand — and it therefore stamps the scroller's TAKEOVER clock, exactly as a wheel does.
    // This move IS the reader's (a keypress, a palette jump), and keyboard is not in GLIDE_YIELD, so nothing
    // stood down on their behalf: a hold in flight read the jump as layout drift and eased them straight back
    // off the row that had just been built for them — and the row unmounted under whoever asked for it, ring
    // and all. One stamp covers both halves of that: an in-flight tween ends on its next frame
    // (`sc._userAt > t0`) and a hold armed LATER never starts (`_userAt(sc) >= since` — the post-close hold
    // arms 240ms after Escape, i.e. after the keypress). The two constant-target holds can't be made "live"
    // instead: re-asserting a CONSTANT against layout drift is their whole job, and a target that re-reads
    // scrollTop is a hold that holds nothing.
    _ensureRow(id) {
      const el = id && this._rowEl(id); if (el || !id) return el;
      const sc = this._listScroller(), y = this._modelTop(id); if (!sc || y == null) return null;
      this._userAt(sc); sc._userAt = performance.now();
      sc.scrollTop = Math.max(0, y - sc.clientHeight / 3);
      _jumped = true;   // the reader was TELEPORTED to find this row, so "don't scroll an in-view edit" no longer applies to it
      this._paintRows();
      return this._rowEl(id);
    },
    // Keyed morph of the parts into `container`, REUSING unchanged <li>s by data-id. A blanket
    // `container.innerHTML = h` recreates every row on a single-field save, which reflowed the list and
    // teleported the scroll (#306); here only genuinely-changed rows are replaced and the rest keep their
    // element identity, and thus their imperative classes (hover/select/edit persist through the render).
    // `_sig` = the CLEAN template outerHTML at creation; imperative classes are added afterwards so they never
    // enter the compare (a stale live class would otherwise force a needless replace).
    // The three scrollTop re-assertions that used to bracket this are GONE with content-visibility: the list's
    // total height is now held by the window's spacers, so a morph cannot change it and cannot move the reader.
    // (Verified by deleting them and re-running scroll/tasks-d/regressions e2e.) All 4 rows containers use this.
    renderRows(el, parts) {
      const prev = el._parts;
      if (prev === parts || (prev && prev.length === parts.length && parts.every((p, i) => p.html === prev[i].html))) return;
      el._parts = parts; this.morphRows(el, parts);
      queueMicrotask(() => this._repaintRows());
    },
    // Parses ONLY the rows whose html actually changed. The old version parsed the entire list into a template
    // and read outerHTML off every new node to compare — so a one-field save did the work of a full rebuild.
    morphRows(container, parts) {
      const old = new Map();
      for (const el of container.children) old.set(el.dataset.id, el);
      // Drop what's LEAVING before placing what stays. A windowed list slides its range every frame, and with
      // the departing rows still sitting in front of the cursor every surviving row got insertBefore'd past
      // them — a DOM move per row per frame (measured: ~12/frame of pure churn during a fling).
      const want = new Set(); for (const p of parts) want.add(p.id);
      for (const [id, el] of old) if (!want.has(id)) { el.remove(); old.delete(id); }
      let cursor = container.firstElementChild, tpl = null;
      for (const p of parts) {
        const cur = old.get(p.id);
        let node = cur;
        if (!cur || cur._sig !== p.html) {   // changed (or new) → this is the only row we pay to parse
          (tpl || (tpl = document.createElement('template'))).innerHTML = p.html;
          node = tpl.content.firstElementChild;
          node._sig = p.html;
        }
        if (cur === cursor) { cursor = cursor.nextElementSibling; if (node !== cur) container.replaceChild(node, cur); }   // same slot: keep or swap in place
        else { if (cur && node !== cur) cur.remove(); container.insertBefore(node, cursor); }                             // reorder: drop the stale node (a fresh one replaces it), then place; new id → just insert
      }
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
    // one row shape for every consumer (list, link picker)
    mkRow(t, depth, byParent, byId, def, now, edMemo, pm) {
      const kids = byParent.get(t.id) || [], parent = byId.get(t.parent_id), cl = t.checklist || [];
      const hasKids = kids.length > 0, hasCl = cl.length > 0;
      // A note's inert dot already says "note", so `in Notes` on a top-level one just repeats the glyph.
      const pNote = !!parent && inNotes(parent, byId), notesRoot = pNote && !parent.parent_id;
      const rel = (ids, type) => (ids ?? []).map(id => ({ id, type, icon: this.relIcon(type), name: byId.get(id)?.content || '' }));
      const em = edMemo ? this.effDurMin(t, byParent, edMemo) : (t.est_minutes || 0);   // roll up subtasks when no own duration
      // ONE date fact: the placement (or, for a repeat, its rule anchor). A placement is an INTENTION that
      // reflows on miss, so it never wears the overdue band — only a deadline is allowed to go red.
      const when = this.whenOf(t, pm), sched = !t.recurrence && !!when;
      let dueB = when ? windowBadge({ available_from: t.available_from, recur_from: when }, now) : null;
      if (dueB && sched) dueB = { ...dueB, kind: dueB.kind === 'overdue' ? 'missed' : dueB.kind, sched: true };
      else if (dueB && t.recurrence && dueB.kind === 'overdue') dueB = { ...dueB, kind: '' };
      return {
        t, depth, pc: this.pc(t.importance), collapsed: !!this.collapsed[t.id],
        note: inNotes(t, byId),   // note → inert dot instead of the checkbox
        // Precomputed here (cached in _visMemo) so a state-only re-render doesn't redo the title regex / checklist split per row.
        titleHtml: mdTitleFn(t.content),
        chk: cl.map((c, ci) => { const sep = c.text.indexOf('::'); return { ci, done: !!c.done, txt: sep >= 0 ? c.text.slice(0, sep) : c.text, desc: sep >= 0 ? c.text.slice(sep + 2) : '' }; }),
        // The row shows the SIZE BUCKET as a glyph; est (the precise duration) survives only as its tooltip, so
        // the row carries the scheduling decision at a glance and the exact number is still one hover away.
        est: em ? this.durFmt(em) : '', estSize: sizeFromMinutes(em), estRollup: !t.est_minutes && em > 0,
        // specific clock time on the date — only for near dates (today/tomorrow/weekday badges)
        dueTime: when.length > 10 && ['today', 'soon'].includes(dueB?.kind) ? this._clTime(when) : null,
        loc: this.rowLoc(t),
        locX: t.location?.mode === 'except',   // away-from → negated pin

        rels: [...rel(t.blocked_by, 'blocked_by')],
        due: dueB,
        dl: t.deadline_at ? deadlineLeft(t.deadline_at, now) : null,
        projName: parent && !notesRoot ? parent.content : '',
        projColor: parent && parent.color ? 'color:' + parent.color : '',
        isDefaultProj: !!t.parent_id && t.parent_id === def,
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        childCount: kids.length,
        hasProgress: hasKids || hasCl,
        progress: hasKids ? Math.round(kids.filter(c => c.completed_at || c.archived_at).length / kids.length * 100) : (hasCl ? Math.round(cl.filter(c => c.done).length / cl.length * 100) : 0),
        blocked: (t.blocked_by ?? []).some(id => { const b = byId.get(id); return b && !b.completed_at && !b.archived_at; }), // inline isBlocked over byId — hot per-row path
      };
    },
    // Keyboard focus over the visible list rows (j/k/↑↓ move; Enter/e open; x/Space complete).
    moveFocus(d) {
      const rows = this.visibleRows();
      if (!rows.length) { this._setKbFocus(null); return; }
      const cur = rows.findIndex(r => r.t.id === this.focusId);
      const next = cur < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + d));
      this._setKbFocus(rows[next].t.id);
    },
    focusedTask() { return this.byId.get(this.focusId); },
    // --- Multi-select (Ctrl/Cmd-click toggle, Shift-click / Shift+↑↓ range) ---
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
        const byEl = new Map([...list.querySelectorAll('.item[data-id]')].map(el => [el.dataset.id, el]));
        for (const id of _selSet) if (!ns.has(id)) byEl.get(id)?.classList.remove('selected', ...RUN);
        if (ns.size) {
          const rows = this.visibleRows();   // cached — O(1) hit on the memo; run position comes from row order
          for (let i = 0; i < rows.length; i++) {
            const el = ns.has(rows[i].t.id) && byEl.get(rows[i].t.id);
            if (!el) continue;
            const p = i > 0 && ns.has(rows[i - 1].t.id), n = i < rows.length - 1 && ns.has(rows[i + 1].t.id);
            el.classList.remove(...RUN);
            el.classList.add('selected', !p && n ? 'sel-top' : p && n ? 'sel-mid' : p && !n ? 'sel-bot' : 'sel-single');
          }
        }
        _selSet = ns;
      });
    },
    // Bulk actions — each routes through perform() as ONE composite op, so a single ⌘Z reverses the whole batch.
    _nTasks(n) { return n + (n === 1 ? ' task' : ' tasks'); },   // labels show up verbatim in the Bin and the undo toast — "Deleted 1 tasks" is a tell
    async _bulk(label, ops) { this.clearSel(); if (ops.length) await this.perform(label, { kind: 'composite', target: 'task', ops }, { bin: true }); },
    async selComplete() {
      const ops = this.selTasks().filter(t => !t.completed_at && !t.archived_at).map(t => ({ kind: 'complete', target: 'task', mode: 'forward', fwd: { id: t.id, done: true } }));
      await this._bulk(`Completed ${this._nTasks(ops.length)}`, ops);
    },
    async selDelete() {
      await this._bulk(`Deleted ${this._nTasks(this.sel.length)}`, Array.from(this.sel, id => ({ kind: 'delete', target: 'task', id })));
    },
    async selSetPrio(v) {
      await this._bulk(`Set priority · ${this._nTasks(this.sel.length)}`, Array.from(this.sel, id => ({ kind: 'update', target: 'task', id, after: { importance: v } })));
    },
    async selMoveToProject(p) {
      await this._bulk(`Moved ${this._nTasks(this.sel.length)} to ${p.content}`, Array.from(this.sel, id => ({ kind: 'update', target: 'task', id, after: { parent_id: p.id } })));
    },
    async selAddArea(a) {
      const ops = this.selTasks().filter(t => !(t.area_ids || []).includes(a.id)).map(t => ({ kind: 'update', target: 'task', id: t.id, after: { area_ids: [...(t.area_ids || []), a.id] } }));
      await this._bulk(`Tagged ${this._nTasks(ops.length)} · ${a.name}`, ops);
    },
    // shift each selected task's PLACEMENT by the SAME delta (relative spacing preserved); only placed tasks
    // move — a repeat's recur_from is its rule anchor, not a date to drag, so it stays put.
    _shiftIso(iso, days) { const dateOnly = iso.length <= 10; const d = new Date(dateOnly ? iso + 'T00:00' : iso); d.setDate(d.getDate() + days); const day = isoDate(d); return dateOnly ? day : day + iso.slice(10); },
    async selShiftDue(days) {
      const ops = this.selTasks().map(t => this._siOf(t.id)).filter(Boolean)
        .map(si => ({ kind: 'update', target: 'scheduleItem', id: si.id, after: { date: this._shiftIso(si.date, days) } }));
      if (!ops.length) { this.clearSel(); return this.toast('No dates to shift'); }
      this.clearSel();
      await this.perform(`Shifted ${ops.length} date${ops.length > 1 ? 's' : ''}`, { kind: 'composite', target: 'scheduleItem', ops }, { bin: true });
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
      // ONE position-sorted byParent index: the old form re-scanned every task for each project it found (O(projects·tasks) per roller paint).
      const rows = [], def = this.store.defaultProject(), byP = buildByParent(this.tasks), visit = (parentId, depth) => {
        for (const p of byP.get(parentId) || []) if (p.sidebar && p.id !== def) { rows.push({ p, depth }); visit(p.id, depth + 1); }
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
      it.push({ kind: 'sec', label: 'Filters', add: 'filter' });
      for (const f of this.filters) it.push({ kind: 'filter', type: 'filter', id: f.id, label: f.name, f });
      it.push({ kind: 'sec', label: 'Areas', add: 'area' });
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
      const mv = e.target.closest('[data-move]');
      if (mv) { const [kind, id, dir] = mv.dataset.move.split(':'); this.navReorder(kind, id, +dir); return; }
      const add = e.target.closest('[data-add]');
      if (add) return this.rollerAdd(add.dataset.add, add.getBoundingClientRect());
      const more = e.target.closest('[data-more]');
      if (more) {
        const [kind, id] = more.dataset.more.split(':');
        if (kind === 'filter') { this.openFilterEditor(this.filters.find(f => f.id === id)); return; }
        this._navPopAt(more.getBoundingClientRect());
        this.navPop = (this.navPop && this.navPop.id === id) ? null : { type: kind, id };
        this.navRename = null;
        return;
      }
      const box = e.target.closest('[data-ridx]');
      if (box) { this.rollerSel = +box.dataset.ridx; this.rollerOpen(); }
    },
    // Anchor the nav popover off a rail button in FIXED coords (escapes the roller's overflow clip), clamped so a 320px-tall pop never spills off screen.
    _navPopAt(r) { this.navPopXY = { x: popLeft(r.left, 230, 8), y: popTop(r.bottom + 6, 320) }; },
    // One step of nav ordering, for all three orderable kinds. Every one of them already stores a `position` and
    // exposes reorder(ids) — this only has to pick the right sibling list, swap two ids in it, and reload.
    // Projects order within their OWN parent, so an arrow never jumps a subproject out of its branch.
    _navSibs(kind, id) {
      if (kind === 'area') return this.areas;
      if (kind === 'filter') return this.filters;
      const p = this.byId.get(id); if (!p) return [];
      return this.tasks.filter(x => x.parent_id === p.parent_id && x.sidebar && x.id !== this.store.defaultProject()).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    },
    async navReorder(kind, id, dir) {
      const sibs = this._navSibs(kind, id), i = sibs.findIndex(x => x.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= sibs.length) return;   // already at an end — a no-op, not an error
      const ids = sibs.map(x => x.id); [ids[i], ids[j]] = [ids[j], ids[i]];
      const api = kind === 'area' ? this.store.areas : kind === 'filter' ? this.store.filters : this.store.tasks;
      if (!await api.reorder(ids)) return this.toast('Could not reorder');
      await (kind === 'area' ? this.loadAreas() : kind === 'filter' ? this.loadFilters() : this.loadTasks());
    },
    // The rail lists filters and areas but had no way to MAKE one — filters were reachable only by saving a
    // search, areas only as a side effect of tagging a task. A new area is created named and then opened straight
    // into its rename popover: an abandoned add leaves a real, visible, deletable area, never a half-made thing.
    async rollerAdd(kind, r) {
      if (kind === 'filter') return this.openFilterEditor();
      const a = await this.store.areas.create({ name: 'New area' });
      if (!a) return this.toast('Could not add area');
      await this.loadAreas();
      this._navPopAt(r);
      this.startRename(a.id);
    },
    rollerCount(it) {
      const open = t => !this.isSidebar(t) && !t.completed_at && !t.archived_at;
      if (it.kind === 'backlog') { const d = this.store.defaultProject(); return this.tasks.filter(t => open(t) && t.parent_id === d).length; }
      // descendantIds already includes it.id — no re-concat (that double-counted direct children). One scan over tasks, not one per descendant.
      if (it.kind === 'proj') { const ids = new Set(descendantIds(this.tasks, it.id)); return this.tasks.filter(t => open(t) && ids.has(t.parent_id)).length; }
      if (it.kind === 'area') return this.tasks.filter(t => !t.completed_at && !t.archived_at && (t.area_ids || []).includes(it.id)).length;
      if (it.kind === 'filter') { try { return this.store.runFilter(it.f.query).length; } catch { return ''; } }
      return '';
    },
    rollerData(it, ri) {   // enrich a roller item with the icon/color/count/progress the box needs
      const d = { ...it, ridx: ri, count: this.rollerCount(it) };
      if (it.kind === 'proj') { d.color = it.p.color || ''; if (this.isNote(it.id)) d.icon = 'i-tack'; else { d.icon = 'prog'; d.progress = this.projectProgress(it.id) / 100; } }   // notes project: the glyph, not a progress ring — notes don't "complete"
      else if (it.kind === 'area') { d.icon = it.l.icon || 'i-tag-tag'; d.color = it.l.color || this.areaDefault; }
      else if (it.kind === 'filter') { d.icon = it.f.query === 'is:any' ? 'i-all' : 'i-search'; d.color = it.f.color || ''; }   // the 'All tasks' null filter keeps its original glyph; filters aren't otherwise icon-configurable
      else if (it.kind === 'backlog') d.icon = 'i-backlog';
      else if (it.kind === 'loc') { d.icon = 'i-tag-map'; d.count = ''; }
      return d;
    },
    rollerRows() {   // rollerItems with section headers kept inline; non-sec rows carry a running focus index (ridx)
      let ri = -1; const out = [];
      for (const it of this.rollerItems()) out.push(it.kind === 'sec' ? { sec: true, label: it.label, add: it.add } : this.rollerData(it, ++ri));
      return out;
    },

    // --- Nav management ---
    projectProgress(id) {
      const ids = descendantIds(this.tasks, id).slice(1);
      if (!ids.length) return 0;
      return Math.round(ids.filter(x => this.byId.get(x)?.completed_at).length / ids.length * 100);
    },
    startRename(id) { this.navRename = id; this.navPop = null; this.$nextTick(() => this.$nextTick(() => { const i = document.querySelector('.nav-pop .pop-input'); if (i) { i.focus(); i.select(); } })); },   // select: a rename usually replaces, and a just-added area opens on its placeholder
    async saveRename(p, name) {
      name = name.trim(); this.navRename = null;
      if (!name) return;
      if ('name' in p) { if (name !== p.name && await this.store.areas.update(p.id, { name })) await this.loadAreas(); }
      else if (name !== p.content && await this.store.tasks.update(p.id, { content: name })) await this.loadTasks();
    },
    async patchTask(id, fields) { if (await this.store.tasks.update(id, fields)) await this.loadTasks(); this.navPop = null; },
    async patchArea(id, fields) { if (await this.store.areas.update(id, fields)) await this.loadAreas(); this.navPop = null; },
    // The nav settings popover renders at the overview level (not inside the clipping roller) — resolve its entity here.
    navPopProj() { return this.navPop?.type === 'proj' ? this.byId.get(this.navPop.id) : null; },
    navPopArea() { return this.navPop?.type === 'area' ? this.areas.find(l => l.id === this.navPop.id) : null; },
    // --- Notes: membership, not a flag — everything under a root project named 'Notes' is a note ---
    isNote(id) { const t = this.byId.get(id); return !!t && inNotes(t, this.byId); },
    pickIsNote() { return this.isNote(this.draft.project_id); },
    // Ghost text doubles as find (uFuzzy, same matcher as the pickers): .chk-hit floats matches via
    // flex order (the lane done rows sink through) — no DOM moves, stored order untouched, nothing hidden.
    chkFind() {   // memo per (query, list length): item id → match ranges (null = hit without range info)
      const q = this.chkGhost.trim();
      if (!q) return null;
      const key = q + '|' + this.draft.checklist.length;
      if (_chkQ?.key !== key) {
        // outOfOrder=0: this uFuzzy build returns NO info/ranges for multi-term needles when ooo=1,
        // and the sub-match <mark>s need ranges — ordered terms is the right trade for find-as-you-type.
        const [idxs, info, order] = (_chkFuzzy ??= makeFuzzy()).search(this.draft.checklist.map(c => c.text), q, 0, 1e4);
        const map = new Map();
        if (idxs && info && order) for (const o of order) map.set(this.draft.checklist[info.idx[o]].id, info.ranges[o]);
        else if (idxs) for (const i of idxs) map.set(this.draft.checklist[i].id, null);
        _chkQ = { key, map };
      }
      return _chkQ.map;
    },
    chkHit(c) { return !!this.chkFind()?.has(c.id); },
    // Zebra bands follow the VISUAL order and count from the BOTTOM: adds unshift at the top, so a
    // bottom-anchored parity leaves every existing row's band alone. Find-hits leave the flow (order:-1)
    // carrying their own highlight — skipped here, so the non-matching rows keep alternating among themselves.
    // (Position is re-derived here, NOT taken from x-for's idx: a keyed x-for leaves idx stale on reused rows
    // after an unshift, which banded the list off-by-one.)
    chkAlt(c) { const m = this.chkFind(), l = this.draft.checklist;
      return m?.has(c.id) ? false : !!(l.slice(l.findIndex(x => x.id === c.id) + 1).filter(x => !m?.has(x.id)).length % 2); },
    // Row HTML while finding: raw text + <mark> sub-matches (md/:: styling pauses for the transient
    // state; textContent contract for the caret still holds — mark wraps text only).
    chkHl(c) { const r = this.chkFind()?.get(c.id); return r?.length ? markTitle(c.text, r, c.text.length) : chkLiveRender(c.text); },
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
      const excl = new Set(descendantIds(this.tasks, this.delAsk.id)), def = this.store.defaultProject();
      if (this.delAsk.kind === 'project') return this.tasks.filter(p => !excl.has(p.id) && this.hasChildren(p.id));
      return this.tasks.filter(p => !excl.has(p.id) && (p.id === def || p.sidebar || this.hasChildren(p.id)));
    },
    startDeleteProject(id) {
      this.navPop = null;
      const project = this.byId.get(id);
      const excl = new Set(descendantIds(this.tasks, id));
      const candidates = this.tasks.filter(x => !excl.has(x.id));
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
      this.pickerQ = ''; this.newAreaName = ''; this.projRequired = false; this.subGhost = ''; this.chkGhost = ''; this.endPicking = false; this.tpop = false; this._calDn = null; this.calH = null;
      for (const t in PICKERS) this[PICKERS[t].key] = { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 };
      this._noPillOnce = false;   // the un-chip→no-re-pill guard is per-session; never leak it across composer opens
      this._draftSid = crypto.randomUUID();   // ditto the draft identity — a rapid-add save resets the draft without reopening
    },
    pc(imp) { return `var(--p${({ must: 1, focus: 2, someday: 3 })[imp] || 4})`; },   // check color by importance — PLACEHOLDER map (user will remap): must→p1, focus→p2, someday→p3, none→p4
    impName(v, unset = 'None') { return ({ none: 'None', focus: 'Focus', must: 'Must', someday: 'Someday' })[v] || unset; },   // proper name incl. None; pass 'Importance' for picker's unset label
    qfImpCol() { return this.pc([...this.qfImp].sort((a, b) => impRank(a) - impRank(b))[0]); },   // token color = the most-important selected value
    durMinNow() { return this.draft.durMin; },
    sizeNow() { return sizeFromMinutes(this.durMinNow()); },
    setSize(k) { this.draft.durMin = minutesForSize(k); this.pop = null; },
    durLabel() {
      const m = this.durMinNow(); if (!m) return 'Size';
      const k = sizeFromMinutes(m); if (k && minutesForSize(k) === m) return k[0].toUpperCase() + k.slice(1);
      return this.durFmt(m);
    },
    setDur(min) { this.draft.durMin = min; },

    reduceMotion() { return motion.scale === 0; },   // one dial (motion.js) — OS preference or test override
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
        this.growH = g.offsetHeight; this.clip = true;   // pin the live height (already rendered, no probe needed)
        this.$nextTick(() => requestAnimationFrame(() => { if (!this._closing) return; this.growH = end; this.grown = false; }));
      } else { this.grown = false; }
      this._t = setTimeout(() => { if (!this._closing) return; this.clip = false; this.growH = null; done && done(); }, 240);
    },
    openComposer() {
      this._draftSid = crypto.randomUUID();   // identity of THIS draft session: every add-composer has editing === null, so a task id can't tell two blank drafts apart
      // If the tapped task's TOP is in view, DON'T scroll — grow it in place (its bottom may extend below the
      // fold; the composer replaces it anyway). Only a task whose top is off-screen animates in. We test the
      // top only (not full visibility): getBoundingClientRect().top is layout-accurate, whereas offsetHeight is
      // unreliable under content-visibility. Close never scrolls either, so an in-view edit leaves the list put.
      if (!this.composer.open) {
        const sc = this.editing && this._listScroller(), r = sc && this._rowEl(this.editing);
        const top = r ? r.getBoundingClientRect().top - sc.getBoundingClientRect().top : null;
        // …unless _ensureRow jumped us here to render the row at all: it lands near the top of the viewport,
        // which reads as "already in view" and would leave a composer opened on the LAST row below the fold.
        const jumped = _jumped; _jumped = false;
        this._skipOpenScroll = !jumped && top != null && top >= -1 && top <= sc.clientHeight - 20;
      }
      clearTimeout(this._draftFlushT);  // cancel stale timer — _closingComposer flip below re-triggers persistDraft x-effect
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
        // A task that ALREADY has entries opens with the caret in its "new item" ghost — the next thing you do to
        // a list is add to it, not rename it. (Exactly one ghost renders in either non-empty case: sub or chk.)
        const ghost = this.editing && (this.draft.checklist.length || this.childTasks(this.editing).length)
          && document.querySelector('.composer-entries .entry.ghost .entry-txt');
        const c = ghost || this.$refs.content;
        c?.focus({ preventScroll: true });
        // Editing → caret at the END of the title (ready to append a chip); adding starts empty so it's moot.
        if (!ghost && c && this.editing) this._caret(c);
        if (!this._skipOpenScroll) {   // off-screen → glide composer into view
          const comp = this.$refs.composer, sc = this._listScroller(); if (!comp || !sc) return;
          // ONE glide, aimed at the composer WHILE IT GROWS. This used to be a scrollIntoView at a pixel
          // measured mid-transition, plus a second scrollBy chained on transitionend (with a 400ms fallback
          // timer) — two browser animations racing over an element whose height was still changing, which is
          // exactly the open/close stutter. A live target absorbs the growth instead of chasing it.
          this._glide(sc, () => {
            // A live target has to survive the target MOVING: relocateComposer re-parents this element between
            // surfaces/lists, and a detached node reports an all-zero rect — aiming at that drags the list to
            // the top. scrollIntoView never had to care because it resolved its pixel once and forgot.
            const cr = comp.getBoundingClientRect();
            if (!this.composer.open || !comp.isConnected || !cr.height) return sc.scrollTop;
            const sr = sc.getBoundingClientRect(), overhang = cr.bottom - sr.bottom;
            // above the fold, or taller than the viewport → sit on its top; otherwise lift only what's cut off
            return sc.scrollTop + (cr.top < sr.top || cr.height > sc.clientHeight ? cr.top - sr.top - 8 : overhang > 4 ? overhang + 12 : 0);
          }, 420);   // outlasts the 220ms grow, so the target is still live for the whole of it
        } else {
          const sc = this._listScroller(); if (sc) this._glide(sc, sc.scrollTop, 420);   // in-view: hold against grow-induced anchor drift
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
    rowIndexOf(id) { const i = this.visibleRows().findIndex(r => r.t.id === id); return i >= 0 ? i : this.completedRows().findIndex(r => r.t.id === id); },
    // A row that has just been DELETED (or filtered out) is in NEITHER list — -1 sent the composer to flex
    // order -2, above every row, and the browser dragged the focused caret (and the scroll) up with it. Hold
    // the last index the row had: the composer stays put for the frame or two before it collapses.
    editIndex() { const i = this.rowIndexOf(this.editing); if (i >= 0) _editIx = i; return _editIx; },
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
    startAdd() { this.editing = null; _editPin = null; this._editDescs = null; this.resetDraft(); this._initDraftSafety(); this.openComposer(); },
    durFmt(min) {
      const h = Math.floor(min / 60), m = min % 60;
      return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '');
    },
    projName(id) { return this.byId.get(id)?.content || ''; },
    isDefaultProj(id) { return !!id && id === this._defId; },
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
      const parent = this.byId.get(t.parent_id);
      const pNote = !!parent && inNotes(parent, this.byId);
      const notesRoot = pNote && !parent.parent_id;
      return rowBodyHtml({
        t, pc: this.pc(t.importance),
        titleHtml: markedTitle != null ? markedTitle : mdTitleFn(t.content),
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        projName: parent && !notesRoot ? parent.content : '',
        isDefaultProj: !!t.parent_id && t.parent_id === this._defId,
        note: inNotes(t, this.byId),   // can't short-circuit via pNote: Notes root itself has parent=undefined so pNote=false but inNotes=true
        rels: [], chk: [],
      }, { minimal: true });
    },
    // static body — shell <li> keeps reactive bindings
    // Grouping by project already names it in the section head — repeating it on every row is noise.
    rowBody(r, opts) { return rowBodyHtml(r, { navType: this.navSel.type, chkOpen: this.chkOpen.has(r.t.id), ...(this.groupBy === 'project' ? { proj: false } : {}), ...opts }); },
    // body is inert x-html — delegate here; editTask measures .item
    onRowClick(r, e) {
      if (e.target.closest('a')) return;   // markdown link — let the browser follow it
      if (e.metaKey || e.ctrlKey) return this.toggleSel(r.t.id);                                  // Ctrl/Cmd-click toggles selection
      if (e.shiftKey) { getSelection()?.removeAllRanges(); return this.selectRange(r.t.id); }     // Shift-click extends the range (drop any accidental text highlight)
      this.selAnchor = r.t.id;   // a plain click seeds the range anchor for a later Shift-click
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'collapse') return this.toggleTaskCollapse(r.t.id);
      if (act === 'check') return this.toggle(r.t);
      if (act === 'chk-more') { this.chkOpen.has(r.t.id) ? this.chkOpen.delete(r.t.id) : this.chkOpen.add(r.t.id); this._dropRowHtml(r.t.id); return; }   // reveal/re-hide the collapsed done items
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
      this._clDnd = { kind: 'task', id: t.id }; this._peekShow();   // arm the calendar drop path — the Peek Pane docks in
      this._dragX0 = e.clientX ?? 0; this._dragDepth = depth ?? 0;
      this._dragDescs = new Set(descendantIds(this.tasks, t.id).slice(1));   // descendants only (drop self); hide the subtree while dragging
      this._rowEl(t.id)?.classList.add('dragging');
      for (const id of this._dragDescs) this._rowEl(id)?.classList.add('row-hidden');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id);
        // Custom follow-cursor ghost (module-level vars — Alpine's Proxy must not wrap DOM elements)
        if (!_dragGhost) { _dragGhost = document.createElement('div'); _dragGhost.className = 'drag-ghost'; document.body.appendChild(_dragGhost); }
        _dragGhost.innerHTML = `<div class="drag-ghost-row flex items-center gap-8">${this.taskLine(t)}</div><div class="drag-ghost-chip">${escHtml(t.content || 'Task')}</div>`;
        const itemEl = e.target?.closest?.('.item');
        const r = itemEl?.getBoundingClientRect() || { left: (e.clientX ?? 0) - 20, top: (e.clientY ?? 0) - 10 };
        const offX = (e.clientX ?? 0) - r.left, offY = (e.clientY ?? 0) - r.top;
        _dragGhost.classList.remove('compact'); _dragGhost.hidden = false;
        _dragGhost.style.transform = `translate(${(e.clientX ?? 0) - offX}px,${(e.clientY ?? 0) - offY}px)`;
        if (_ghostHandler) document.removeEventListener('dragover', _ghostHandler);
        _ghostHandler = ev => {
          _dragGhost.style.transform = `translate(${ev.clientX - offX}px,${ev.clientY - offY}px)`;
          _dragGhost.classList.toggle('compact', !!ev.target?.closest?.('.peek'));
        };
        document.addEventListener('dragover', _ghostHandler);
        // 1×1 blank canvas suppresses the browser's native ghost so only our custom one is visible
        if (!_dragBlank) { _dragBlank = document.createElement('canvas'); _dragBlank.style.cssText = 'position:absolute;top:-9999px;width:1px;height:1px'; document.body.appendChild(_dragBlank); }
        e.dataTransfer.setDragImage?.(_dragBlank, 0, 0);   // absent on synthesized DataTransfer (tests)
      }
    },
    // depth = the target row's display depth (for the ghost indent); the MAX_DEPTH guard uses projectDepth.
    dragOver(t, e, depth) {
      if (!this.dragId) return;
      if (t.id === this.dragId || this._dragDescs?.has(t.id)) { this.taskDropHint = null; this._setDropInto(null); return; }   // self or own subtree: no drop
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
      const dragTask = this.byId.get(dragId);
      const isReorder = (hint.mode === 'above' || hint.mode === 'below') && !!dragTask && (dragTask.parent_id ?? null) === (target.parent_id ?? null);
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
      if (isReorder) {   // same parent — non-lossy reorder, not journaled
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
      this._landOn(id);   // a drag can drop a row anywhere, incl. off-screen or into a collapsed/filtered-out spot
    },
    dragEnd() {
      if (_ghostHandler) { document.removeEventListener('dragover', _ghostHandler); _ghostHandler = null; }
      if (_dragGhost) _dragGhost.hidden = true;
      this._clearDrag(); this.dragId = null; this.taskDropHint = null; this._dragDescs = null; this.railHot = null; this.clDragEndSchedule(); this._peekCancelEdge();
    },
    // --- Peek Pane (C2): drag a Lists row → today's real day column docks right; drop = schedule, list drop still reorders ---
    peekOn() { return this.surface === 'lists' && (!!this.dragId || this.peekPin); },
    peekCol() { void this.tasks; void this.events; void this.blocks;   // register deps — the memos underneath may short-circuit
      return this._clColumn(this.peekIso || isoDate(new Date())); },
    _peekShow() {   // called from dragStart; scrolls the pane to now on first appearance
      if (!this.peekPin) this.peekIso = isoDate(new Date());
      this.$nextTick(() => { const b = document.querySelector('.peek-body');
        if (b && !this._peekKeep) b.scrollTop = Math.max(0, b.scrollHeight * this.clNowPct() / 100 - b.clientHeight / 2);
        this._peekKeep = this.peekPin; });   // pinned pane keeps its scroll between drags
    },
    // Edge-hold paging (user-spec): DWELL ~500ms at the pane's right edge → next day; left edge → back
    // (never before today). Crossing an edge en route must not flip — the timer cancels the moment you leave.
    peekEdge(e) {
      const r = e.currentTarget.getBoundingClientRect(), EDGE = r.width * .3;
      const zone = e.target?.closest?.('.peek-month') ? null   // the month grid owns its own dwell — edge zones would double-fire under it
        : e.clientX > r.right - EDGE ? 'next'
        : e.clientX < r.left + EDGE && this.peekIso > isoDate(new Date()) ? 'prev' : null;
      if (zone === this._peekZone) return;
      clearTimeout(this._peekT); this._peekZone = zone; this.peekEdgeHot = zone;
      if (zone) this._peekT = setTimeout(() => { this._peekZone = null; this.peekEdgeHot = null; this._peekPage(zone === 'next' ? 1 : -1); }, 500);
    },
    _peekCancelEdge() { clearTimeout(this._peekT); this._peekZone = null; this.peekEdgeHot = null; this._pkmCancel(); },
    peekCanBack() { return this.peekIso > isoDate(new Date()); },
    _peekDay() { return new Date((this.peekIso || isoDate(new Date())).slice(0, 10) + 'T00:00'); },   // the pane's day as a local Date (defaults to today)
    peekEdgeLabel(dir) {   // names the day the dwell will land on
      const d = this._peekDay(); d.setDate(d.getDate() + dir);
      const iso = isoDate(d), today = new Date(), tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
      return iso === isoDate(today) ? 'Today' : iso === isoDate(tmr) ? 'Tomorrow' : this.fmt(iso);
    },
    _peekPage(dir) {
      const d = this._peekDay(); d.setDate(d.getDate() + dir);
      const iso = isoDate(d), today = isoDate(new Date());
      this.peekIso = iso < today ? today : iso;
      this.clDropPreview = null;
      if (!this.reduceMotion()) this.$nextTick(() =>   // the new day slides in from the held edge (WAAPI: retriggers cleanly on rapid pages)
        document.querySelector('.peek-panel')?.animate(
          [{ transform: `translateX(${dir * 14}px)`, opacity: .55 }, { transform: 'translateX(0)', opacity: 1 }],
          { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }));
    },
    // Month strip at the pane's foot: drop on a day = all-day that day; dwell ~500ms retargets the timeline.
    peekCells() {
      const base = this._peekDay();
      const y = base.getFullYear(), m = base.getMonth(), lead = new Date(y, m, 1).getDay(), today = isoDate(new Date());
      const rows = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
      return Array.from({ length: rows * 7 }, (_, i) => {
        const d = new Date(y, m, 1 - lead + i), iso = isoDate(d);
        return { iso, d: d.getDate(), cur: d.getMonth() === m, today: iso === today, off: iso < today };
      });
    },
    peekMonLabel() { return this._peekDay().toLocaleDateString([], { month: 'long', year: 'numeric' }); },
    peekMonOver(c) {
      if (c.off || this._pkmZone === c.iso) return;
      clearTimeout(this._pkmT); this._pkmZone = c.iso; this.peekMonHot = c.iso;
      this._pkmT = setTimeout(() => { this._pkmCancel(); this.peekIso = c.iso; }, 500);
    },
    _pkmCancel() { clearTimeout(this._pkmT); this._pkmZone = null; this.peekMonHot = ''; },
    peekMonDrop(e, c) { this._pkmCancel(); if (!c.off) this.clDropOn(e, c.iso, true); },
    // --- Drag-to-move edge rail: Backlog + every project + every area as compact drop targets. ---
    railItems() {
      const items = [{ kind: 'backlog', id: null, label: 'Backlog', icon: 'i-backlog', color: '' }];
      for (const { p } of this.allProjectRows()) items.push({ kind: 'proj', id: p.id, label: p.content, icon: this.isNote(p.id) ? 'i-tack' : 'i-hash', color: p.color || '' });
      for (const l of this.areas) items.push({ kind: 'area', id: l.id, label: l.name, icon: l.icon || 'i-tag-tag', color: l.color || this.areaDefault });
      return items;
    },
    railOver(kind, id) { this.railHot = kind + id; this.taskDropHint = null; this._setDropInto(null); },
    async railDrop(kind, id) {
      const dragId = this.dragId;
      this.railHot = null; this.taskDropHint = null; this.dragId = null; this._clearDrag();
      if (_ghostHandler) { document.removeEventListener('dragover', _ghostHandler); _ghostHandler = null; }
      if (_dragGhost) _dragGhost.hidden = true;
      const t = this.byId.get(dragId); if (!t) return;
      if (kind === 'area') {   // areas are tags (many-to-many) — add the tag, keep existing
        const ids = t.area_ids || [];
        if (ids.includes(id)) return;
        await this.perform('Tagged', { target: 'task', kind: 'update', id: dragId, after: { area_ids: [...ids, id] } });
        return;
      }
      const parentId = kind === 'backlog' ? this.store.defaultProject() : id;
      if (parentId === dragId) return;
      const sibs = this.tasks.filter(x => (x.parent_id ?? null) === (parentId ?? null) && x.id !== dragId);
      const toIndex = sibs.length ? Math.max(...sibs.map(x => x.position ?? 0)) + 1 : 0;
      await this._moveTask(dragId, parentId, toIndex, [...sibs.map(x => x.id), dragId]);
    },
    // --- The ONE list-surface scroll model ---
    // The scroll STAYS. Opening an in-view task doesn't scroll (grow in place), so closing has nothing to
    // un-do — we never write scrollTop on close; the list stays exactly where the reader left it (if the
    // collapse shrinks the range past the end the browser clamps up a touch, which is fine). The ONLY
    // deliberate scroll is `_revealRow`: bring a task in when it's OFF-SCREEN (an off-screen open, or a save
    // that re-sorted the row out of view). The list is windowed, so we never trust absolute scrollTop.
    _listScroller() { return document.querySelector('.surface-lists .app'); },
    _rowOffscreen(sc, el) { const r = el.getBoundingClientRect().top - sc.getBoundingClientRect().top; return r < -1 || r + el.offsetHeight > sc.clientHeight + 1; },
    // --- The ONE scroll animation in the app ---
    // Every scroll stutter we have shipped came from the same two gaps in the browser's smooth scroll: it aims
    // at a pixel computed ONCE — so a reflow mid-flight (the composer still growing, a content-visibility row
    // resolving its real height, a list re-render) leaves you somewhere else — and we hold no handle on it, so
    // a second request RACES the first and your own scroll fights it instead of stopping it. Both are closed
    // here: `to` is a FUNCTION re-read every frame, and one tween per scroller owns the animation.
    // A hand on the wheel always wins: if scrollTop moved by anyone but us, we let go on the spot.
    // A CONSTANT target makes it a hold instead of a move — re-asserting the same position every frame is how
    // we sit still through a re-render, and it stands down on the same user input. One primitive, both jobs.
    // One passive record per scroller of when the user last touched it. Yield to REAL input, never to a
    // scrollTop delta: content-visibility resolving a row height moves scrollTop too, and reading that as
    // "they took over" is how a reveal gives up half way.
    _userAt(sc) {
      if (!sc._userArmed) { sc._userArmed = true; for (const ev of GLIDE_YIELD) sc.addEventListener(ev, () => { sc._userAt = performance.now(); }, { passive: true }); }
      return sc._userAt || 0;
    },
    // `since` = when the CALLER decided to scroll. It matters because the decision and the glide can be a
    // whole animation apart (the composer collapse is async), and a wheel that lands in that gap must still
    // win — arming only when the tween starts misses it entirely, and the reader gets yanked back.
    _glide(sc, to, ms = 340, since = Infinity) {
      if (!sc || this._userAt(sc) >= since) return;   // >= : coarsened performance.now() can stamp the user's wheel EQUAL to the arm instant — ties go to the hand
      const at = () => { const v = typeof to === 'function' ? to() : to; return Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, v)); };
      // Zero motion does NOT mean zero protection: grow/collapse still reflows layout and scroll anchoring
      // still drifts, so at scale 0 the glide JUMPS to the target immediately and then re-asserts the LIVE
      // target each frame for the RAW duration — the reader's position is managed, nothing visibly animates.
      const zero = this.reduceMotion();
      if (!zero) ms = motion.t(ms);
      // keyed on the scroller: a second request SUPERSEDES the first (motion.run), re-easing from wherever we are
      const t0 = performance.now();
      let from = sc.scrollTop, mine = zero ? (sc.scrollTop = at()) : from;
      motion.run(sc, now => {
        if (sc._userAt > t0) return false;   // ...and a hand arriving mid-flight ends it on the spot
        // Someone ELSE moved the scroller. It is never a hand (that's the line above) — it is LAYOUT: a long
        // glide crosses rows that swap their ESTIMATED height for the real one as the window renders them,
        // scrollHeight moves by hundreds of px and the browser's anchoring/clamping rewrites scrollTop to
        // hold the content still; the browser also yanks the focused caret into view the instant you type into
        // the composer we're still gliding to. Reading either as a takeover ABANDONED the glide (composer left
        // up to 760px out of view — the whole open-scroll regression). Absorb it: re-base and keep aiming at
        // the LIVE target, which is where the reader has to end up either way.
        if (Math.abs(sc.scrollTop - mine) > 24) { from += sc.scrollTop - mine; mine = sc.scrollTop; }
        const p = Math.min(1, (now - t0) / ms);
        sc.scrollTop = mine = zero ? at() : from + (at() - from) * EASE_OUT(p);
        return p < 1;
      });
    },
    // Is this row out of the reader's view? A WINDOWED list may not hold it at all, and "no element" means it
    // is at least a margin outside the viewport — never "nothing to reveal" (reading it that way left a
    // re-sorted row off-screen and held the list at the old position instead).
    _rowAway(id) { const sc = this._listScroller(), el = id && this._rowEl(id); return !!sc && !!id && (el ? this._rowOffscreen(sc, el) : this._modelTop(id) != null); },
    // Bring a row in when it's off-screen. The target is the row's LIVE position, so a list re-render or a row
    // growing under us retargets instead of missing (that was #307, and scrollIntoView could not be told).
    _revealRow(id) {
      if (!this._rowAway(id)) return;
      const sc = this._listScroller();
      // ONE glide owns the scroller, always — writing scrollTop by hand here loses to whatever hold is still
      // in flight (the open-composer hold ate the reveal and eased the list straight back). Outside the
      // WINDOW the row has no rect, so the target comes off its MODELLED box — and both branches must land
      // on the SAME pixel, because the glide's own scrolling renders the row and hands over mid-flight. Any
      // disagreement re-targets there and BOUNCES: aiming the fallback at row-top matched only an UPWARD
      // reveal (B2/B4); a downward one converges on the row's BOTTOM ~840px away and reversed twice on the
      // way (#391). One formula, fed whichever box exists.
      // (_ensureRow keeps its own clientHeight/3 — that aims to RENDER a row for measurement, not to land.)
      this._glide(sc, () => {
        const el = this._rowEl(id);
        if (el) { const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
          return sc.scrollTop + this._revealBy(r.top - s.top - 12, r.bottom - s.bottom + 12, r.height > sc.clientHeight); }
        // Residual: for a row that has never rendered, `h` is _rowEst, not a measured height — so the two
        // branches can still part by |est − real| at the handover. Tens of px (one re-aim), not the 840px class.
        const m = this._listModel(), i = m.ix.get(id), y = this._modelTop(id); if (y == null) return sc.scrollTop;
        const h = m.ent[i].h, top = y - sc.scrollTop;
        return sc.scrollTop + this._revealBy(top - 12, top + h - sc.clientHeight + 12, h > sc.clientHeight); });
    },
    // How far to scroll so a row sits in view. under/over = px its top falls short of the 12px line / its
    // bottom overshoots the fold. A row taller than the viewport can never have both ≤ 0, so chasing the
    // bottom would oscillate every frame (B1): tall rows align to the top, like a row above the fold.
    _revealBy(under, over, tall) { return tall || under < 0 ? under : over > 0 ? over : 0; },
    // Any write that can MOVE a row ends here (F9): carry the reader to it if it left the viewport, and mark which
    // row took the edit. Not composer-only — a drag, a sort change or an undo relocates rows just as thoroughly.
    // Native smooth scroll + scroll-margin, no JS tween: honours reduced-motion for free and can't teleport.
    _landOn(id) { if (id) this.$nextTick(() => { this._revealRow(id); this._flashSaved(id); }); },
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
        // Make the pending map EXACT before branching: the debounce may still hold the last <300ms of typing
        // (or the cleanup flush that marks a re-cleaned draft), and every branch below reads the map's truth.
        clearTimeout(this._draftFlushT); this._flushDraftNow();
        const key = this._draftKey();
        if (saved === true || this._draftSig() === this._draftBase) this._clearPending(key);
        else if (saved !== 'pre') {
          // dropped-but-kept dirty draft → a recoverable "Draft" bin row + ⌘Z reopen (pending autosave stays too)
          const title = (this.draft.content || '').trim() || (this.chkGhost || this.subGhost || '').trim() || 'Untitled draft';
          this._pushDraftBin(key, 'Draft — ' + title);
        }
        // 'pre': save in progress — don't consume journal entry; caller calls _clearPending on confirmed success
      }
      this._closingComposer = true;   // stop persistDraft re-writing during the async grow-close
      this.draftRestored = false;
      // Keep the list PUT across the collapse. applyEditDom re-renders the edited row's subtree, which
      // (content-visibility) can nudge scrollTop — so we hold the pre-close position and re-assert as it
      // settles. The save path passes manageScroll:false and owns this itself (it must wait out its reloadAll).
      const sc = manageScroll ? this._listScroller() : null, stBefore = sc ? sc.scrollTop : 0;
      // Arm the yield HERE, not in the callback: the collapse animates first, and a wheel during it is the
      // reader taking over — the hold below must never re-assert over that.
      const armed = performance.now(); if (sc) this._userAt(sc);
      const end = this.editing ? this.blockH : 0;
      this._growClose(() => this.$refs.grow, end, () => {
        this.composer.open = false; this.editing = null; _editPin = null; this._editDescs = null; this.resetDraft(); this.applyEditDom();
        if (sc) {
          // Either carry the reader to the row, or hold the list exactly where it was through the collapse —
          // both are the same glide, so they can never run at once (this used to be a bespoke rAF hold loop
          // with its own user-yield listeners racing a browser scrollIntoView).
          this._rowAway(revealId) ? this._revealRow(revealId) : this._glide(sc, stBefore, 220, armed);
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
    // Ticking the composer's own check finishes the task — like archive, that's terminal, so the composer closes.
    // Open edits are saved first (a dirty draft would otherwise only survive as a recoverable pending draft).
    // Un-completing keeps it open, and the close is conditional on the task actually ending up done (a sweep prompt can cancel).
    async toggleEditing() {
      const t = this.byId.get(this.editing); if (!t) return;
      if (t.completed_at) return this.toggle(t);
      if (this._draftSig() !== this._draftBase) await this.submitComposer();
      await this.toggle(t);
      if (this.byId.get(t.id)?.completed_at && this.composer.open) this.closeComposer(true);
    },
    // A task's stored fields → a fresh composer draft (shared by editTask + subtask editors).
    taskToDraft(t) {
      const min = t.est_minutes || 0, si = t.recurrence ? null : this._siOf(t.id);
      return { ...emptyDraft(),
        content: t.content, notes: t.notes || '', importance: t.importance ?? 'none',
        // ON register hydration: the date-item IS the placement, so it wins over the legacy recur_from column
        on: si?.date || (t.recur_from || '').slice(0, 10),
        available_from: t.available_from || '',
        dueTime: si?.start || timeOf(t.recur_from || ''),
        deadline_at: (t.deadline_at || '').slice(0, 16),   // 16, not 10: a timed deadline must survive an edit round-trip (F16)
        durMin: min,
        project: this.projName(t.parent_id) || null, project_id: t.parent_id || null, areas: [...(t.area_ids || [])], goal_ids: [...(t.goal_ids || [])], checklist: (t.checklist || []).map(c => ({ ...c })).sort(byDone), recurrence: t.recurrence ? JSON.parse(JSON.stringify(t.recurrence)) : null,
        location: t.location ? { ...t.location, ids: [...(t.location.ids || [])] } : { mode: 'any', ids: [] },
      };
    },
    // The composer IS a row in the visible list, so a task the current view doesn't hold (another project, a
    // filtered-out one, opened from Now/search/a subtask chevron) had nothing to sit on and landed in a broken
    // spot. Navigate to a view that holds it; returns true when it moved, so the caller re-opens next tick.
    goToTask(t) {
      if (!t || (this.surface === 'plan' && this.clSideVisible())) return false;   // the calendar's panel hosts the composer itself
      if (this.surface === 'lists' && this.rowIndexOf(t.id) >= 0) return false;
      let root = t, seen = new Set();
      while (root.parent_id && !seen.has(root.id)) { seen.add(root.id); const p = this.byId.get(root.parent_id); if (!p) break; root = p; }
      const inProj = this.isSidebar(root) && root.id !== this.store.defaultProject();
      this.setNav(inProj ? 'project' : 'all', inProj ? root.id : null);   // setNav also moves the surface to Lists
      return true;
    },
    // `routed` bounds the hop to ONE: a task with no row anywhere in Lists (a completed one while the done lens
    // is off) would otherwise re-navigate forever and hang the page.
    editTask(t, ev, routed) {
      if (!routed && this.goToTask(t)) return this.$nextTick(() => this.editTask(t, null, true));   // the row has to exist before it can be measured and covered
      _jumped = false;   // only a jump made for THIS open may relax the in-place rule below
      // ev.currentTarget is the list (<ul>); resolve the actual row by id
      const row = ev?.currentTarget?.classList.contains('item') ? ev.currentTarget : this._ensureRow(t.id);   // windowed: a programmatic open must window the row in before it can be measured
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
      this.editing = t.id; _editPin = t.id;
      this._editDescs = new Set(descendantIds(this.tasks, t.id).slice(1));   // O(1) hiddenInEdit checks (reactive :style)
      this.pop = null;
      this.pickerQ = '';
      this._initDraftSafety();   // baseline + restore any unsaved draft for this task
      this.openComposer();
    },
    // sidebar project → navigate, not edit
    openTaskById(id) { const t = this.byId.get(id); if (!t) return; this.isSidebar(t) ? this.setNav('project', t.id) : this.editTask(t); },
    navTargets() {   // non-corpus palette targets: surfaces + filters + action commands
      const t = this.surfaceOrder.map(s => ({ kind: 'nav', type: 'surface', id: s, title: SURF_META[s].label, icon: SURF_META[s].icon }));
      for (const f of this.filters) t.push({ kind: 'nav', type: 'filter', id: f.id, title: f.name, color: f.color || 'var(--muted)' });
      t.push(
        { kind: 'cmd', type: 'command', id: 'new-task', title: 'New task', icon: 'i-edit', kw: 'add create' },
        { kind: 'cmd', type: 'command', id: 'new-filter', title: 'New filter', icon: 'i-search', kw: 'add create query' },
        { kind: 'cmd', type: 'command', id: 'today', title: 'Jump to Today', icon: 'i-cal', kw: 'calendar now' },
        { kind: 'cmd', type: 'command', id: 'locations', title: 'Manage locations', icon: 'i-tag-map', kw: 'places regions' },
      );
      return t;
    },
    searchResults() {
      const pk = this.palette.q + '|' + this._rowV;
      if (_palKey === pk) return _palMemo;
      _palKey = pk;
      const q = this.palette.q.trim().toLowerCase();
      // empty query → recents only; surfaces/commands appear once you type (skip navTargets() call entirely)
      const nav = q ? this.navTargets().map(t => {
        const i = (t.title + ' ' + (t.kw || '')).toLowerCase().indexOf(q);
        return i < 0 ? null : { ...t, _s: (t.title.toLowerCase().startsWith(q) ? 0 : 1) + i / 100 };
      }).filter(Boolean).sort((a, b) => a._s - b._s) : [];
      const docs = this.store.search(this.palette.q, 50).map(r => {     // tasks/projects/areas from the fuzzy corpus
        const obj = r.type === 'area' ? this.areas.find(x => x.id === r.id) : this.byId.get(r.id);
        return obj ? { ...r, obj } : null;
      }).filter(Boolean);
      const results = [...nav, ...docs];   // nav/commands first (the "go/do" intent), then content matches
      if (this.isFilterQuery(this.palette.q)) results.push({ kind: 'cmd', type: 'command', id: 'save-filter', title: `Save "${this.palette.q.trim()}" as filter`, icon: 'i-search' });   // appended, not unshifted — must not hijack Enter from a real result (e.g. "@home")
      return (_palMemo = results);
    },
    searchTitleHTML(r) {
      const raw = r.obj.content ?? r.obj.name ?? '';
      if (!r.ranges?.length) return mdTitleFn(raw);   // always render markdown (bold/italic/code)
      // Mark the RAW text with sentinels (no-escape mode), THEN render markdown, THEN swap for <mark>.
      // Marking raw stops queries like 'em'/'s'/'code' from matching inside rendered <em>/<s>/<code>.
      const lim = r.titleLen || raw.length, S = '\x01', E = '\x02';
      return mdTitleFn(markTitle(raw, r.ranges, lim, S, E, false)).replaceAll(S, '<mark>').replaceAll(E, '</mark>');
    },
    searchJumpHTML(r) {   // non-task palette row: lead (icon/dot) + name (+ a type tag for nav/commands)
      if (r.kind === 'nav' || r.kind === 'cmd') {
        const name = escHtml(r.title || '');   // escape — filter/goal names are user input
        const lead = r.color
          ? `<span class="filter-dot" style="background:${r.color}"></span>`
          : `<svg class="ico pick-ico"><use href="#${r.icon || 'i-arrow'}"/></svg>`;
        return `${lead}<span class="pick-name">${name}</span><span class="pick-tag">${r.type === 'command' ? 'Action' : r.type}</span>`;
      }
      const marked = this.searchTitleHTML(r);
      // hash-ico, not pick-ico: this glyph stands in for the '#' beside it, so it wears the hash icon's box (15px).
      // At the 18px lead-icon size a notes project read as a heavier, bigger row than every hash project under it.
      if (r.type === 'project') return `${this.isNote(r.obj?.id) ? '<svg class="ico hash-ico"><use href="#i-tack"/></svg>' : '<span class="hash">#</span>'}<span class="pick-name">${marked}</span>`;
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
      this.store.recordSearchPick(r.id);   // recents: corpus items only (task/project/area)
      if (r.type === 'task') this.openTaskById(r.id);
      else if (r.type === 'project') this.setNav('project', r.id);
      else if (r.type === 'area') this.setNav('area', r.id);
    },
    runCommand(id) {
      if (id === 'new-task') { this.goSurface('lists'); this.startAdd(); }
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
        // recur_from is now ONLY the recurrence anchor — outside repeat mode draft.on is the ON register and
        // saves as a schedule-item instead (_saveSched), so an intention never becomes a legacy due date.
        recur_from: d.recurrence && d.on ? (d.dueTime ? d.on + 'T' + d.dueTime : d.on) : null,
        available_from: d.available_from || null,
        deadline_at: d.deadline_at || null,
        est_minutes: (d.durMin || 0) || null,
        task_size: sizeFromMinutes(d.durMin || 0),
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
    // Unified calendar pop (due / deadline / plan-nav) — mode driven by `pop`
    calPopStyle() { return (['due','clnav'].includes(this.pop) ? 'display:flex' : 'display:none') + ';position:fixed;left:' + this.popXY.left + 'px;top:' + this.popXY.top + 'px;bottom:auto'; },
    calDayClassFor(c, ci) {
      if (this.pop === 'due') return this.calDayClass(c, ci);
      return { out: !c.cur, today: c.today, sel: this.clPopSel(c.iso), hot: this.clPopHot(c.iso) };
    },
    calDayClickFor(c) {
      if (this.pop === 'due') this.calDayTap(c);
      else this.clPickDate(c.iso);
    },
    calDayMouseenterFor(c) { if (this.pop === 'clnav') this.clPopHoverWk = this.clView === 'week' ? this._clWkKey(c.iso) : ''; },
    togglePop(name, anchor) {
      this.pop = this.pop === name ? null : name;
      // Kill any live anchor tracker before opening a new pop
      if (this._popTrack) { this._popTrack(); this._popTrack = null; }
      if (!this.pop || !anchor) return;
      const r = anchor.getBoundingClientRect(), m = 8;
      this.popXY = { left: r.left, top: r.bottom + 5 };
      // The handle is published SYNCHRONOUSLY even though the loop below only starts a tick later —
      // otherwise two togglePops in one task both read _popTrack as null and leave TWO loops running,
      // the stale one still writing popXY from its own anchor.
      let rafId = null, dead = false;
      const cleanup = () => { dead = true; cancelAnimationFrame(rafId); if (this._popTrack === cleanup) this._popTrack = null; };
      this._popTrack = cleanup;
      this.$nextTick(() => {
        if (dead) return;
        const el = [...document.querySelectorAll('.pop')].find(p => getComputedStyle(p).display !== 'none');
        if (!el) return;
        const _pos = (ar) => {
          // Vertically this one FLIPS rather than clamping — above the anchor if the pop would overflow the
          // bottom edge, or if it's marked data-pos="up". Horizontally it's the shared clamp.
          const vh = window.innerHeight, ph = el.offsetHeight;
          let top = ar.bottom + 5;
          if (el.dataset.pos === 'up' || top + ph > vh - m) top = Math.max(m, ar.top - ph - 5);
          return { left: popLeft(ar.left, el.offsetWidth + m, m), top };
        };
        // Follow the anchor every frame — covers scroll/resize AND any layout move. Opening the composer
        // lays its chips out at the collapsed spot for exactly ONE frame before the grow snaps them up
        // (traced 483 → 351px): a chip clicked in that frame used to strand its pop where the chip WAS,
        // 127px below its own chip and permanently, since only scroll/resize re-anchored. Recompute only
        // when the anchor rect actually changed, so an at-rest pop costs one cached rect read per frame.
        let prev = '', zeroRects = 0;
        const follow = () => {
          rafId = requestAnimationFrame(follow);
          if (!this.pop || !el.isConnected) return cleanup();
          // The pop's own height is part of the key: a filtered list that shrinks under a STATIONARY
          // anchor otherwise leaves the pop hanging where the taller version ended (6px → 38px gap).
          const a = anchor.getBoundingClientRect(), k = `${a.top},${a.left},${a.bottom},${el.offsetHeight}`;
          if (k === prev) return;
          const vh = window.innerHeight, vw = document.documentElement.clientWidth;
          if (!a.width && !a.height) {
            // Disconnected = truly removed from DOM → close immediately.
            // Connected zero-rect: Alpine's x-show defers parent show via setTimeout, so the anchor
            // briefly reports zero-rect even though it IS still there. Allow a few frames for layout
            // to catch up (x-show fires within 1–2 rAF cycles). Permanent zero-rect still closes.
            if (!anchor.isConnected || ++zeroRects >= 4) { this.pop = null; return cleanup(); }
            return;
          }
          zeroRects = 0;
          if (a.bottom < 0 || a.top > vh || a.right < 0 || a.left > vw) { this.pop = null; return cleanup(); }
          prev = k;
          this.popXY = _pos(a);
        };
        follow();
      });
    },
    // translateX keeps absolute-positioned pickers in viewport (used by _positionPicker + log-when-pop)
    clampX(el) {
      if (!el) return;
      el.style.transform = '';
      const r = el.getBoundingClientRect(), m = 8, vw = document.documentElement.clientWidth;
      // Measured while the surface canvas is still gliding sideways, the whole box reads as off-screen — clamping
      // that snapshot bakes in a permanent shift (the picker landed ~1800px right of the caret). It's already
      // positioned correctly against its own parent, so when the parent isn't on screen, leave it alone.
      const pr = el.offsetParent?.getBoundingClientRect();
      if (pr && (pr.right < m || pr.left > vw - m)) return;
      const dx = popLeft(r.left, r.width + m, m) - r.left;   // same clamp as the fixed pops, applied as a delta
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    },
    projectPath(p) {
      const parts = []; const seen = new Set(); let cur = p;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(cur.content);
        cur = this.byId.get(cur.parent_id);
      }
      return parts.join(' / ');
    },
    // uFuzzy-ranked + subsequence fallback for short fragments; shared picker search
    pickerMatches(candidates, query = this.pickerQ) {
      const q = query.trim();
      if (!q) return candidates;
      // The haystack only changes when task data does. Rebuilding it per keystroke walked EVERY candidate's
      // parent chain — 20k chain-walks a key, once per picker render. Cached per id, dropped on _rowV.
      if (_hayV !== this._rowV) { _hayV = this._rowV; _hay.clear(); }
      const hay = candidates.map(t => { let s = _hay.get(t.id); if (s === undefined) _hay.set(t.id, s = t.content + ' ' + this.projectPath(t)); return s; });
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
      if (_areaUseMemoV !== this._rowV) {
        const cut = new Date(); cut.setHours(0, 0, 0, 0); cut.setDate(cut.getDate() - 30);
        const use = Object.fromEntries(this.areas.map(l => [l.id, 0]));
        for (const t of this.tasks) if (new Date(t.updated_at || t.created_at || 0) >= cut)
          for (const a of t.area_ids || []) if (a in use) use[a]++;
        _areaUseMemo = use; _areaUseMemoV = this._rowV;
      }
      const use = _areaUseMemo;
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
    endPicking: false, tpop: false, tpopStyle: '', _calDn: null, calH: null, _calDragged: false, calPulse: false, hdrPulse: false, repIdx: 0,
    // Which register the When pop's day taps speak (§11): 'on' = a schedule intention (placement, amber,
    // saved as a schedule-item), 'by' = the deadline wall (available_from→deadline_at, red). Derived from
    // the draft on every open, so the pop always reads back what the task already holds.
    dreg: 'by',
    repRules() { return recRules(this.draft.recurrence); },
    // the statement the spatial controls act on (headers, ordinals, time popover) — last-touched zone
    curRule() { const rs = this.repRules(); return rs[Math.min(this.repIdx, rs.length - 1)] || null; },
    _calTo(iso) { const d = new Date(iso.slice(0, 10) + 'T00:00'); this.cal = { y: d.getFullYear(), m: d.getMonth() }; },
    // draft.on is the ON register's date outside repeat mode (saved as a schedule-item, never as tasks.recur_from)
    // and the rule ANCHOR inside it; deadline_at is the BY register. The pop's type-a-date field follows suit.
    _dateKey() { return this.repRules().length || this.dreg === 'on' ? 'on' : 'deadline_at'; },
    setDreg(r) { this.dreg = r; },
    openDate(name, anchor) {
      this.togglePop(name, anchor);
      if (this.pop !== name) return;
      this.dreg = !this.repRules().length && this.draft.on ? 'on' : 'by';   // hydrate: a placed task opens in On
      this.endPicking = false; this.tpop = false;
      this._calTo(this.draft[this._dateKey()] || this.draft.on || isoDate(new Date()));
      this.$nextTick(() => this.$refs.calType?.focus());
    },
    // Recompute the next-occurrence due whenever the recurrence rule changes (anchored at the current due, else today).
    refreshRecurrenceDue() {
      if (!this.repRules().length) return;
      // An existing due date (even a past one) is the rule's ANCHOR — never overwrite it; only seed when empty.
      if (this.draft.on) {
        this._calTo(this.draft.on);
        return;
      }
      const b = nextAcrossRules(this.draft.recurrence, isoDate(new Date()), new Date(), { inclusive: true });
      if (!b) return;
      this.draft.on = b.iso;
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
      if (next === 'month') r.month_day = new Date((this.draft.on || isoDate(new Date())).slice(0, 10) + 'T00:00').getDate();
    },
    // "on [...]" chip label: weekly day set / monthly day-of-month / yearly anniversary; null when inapplicable (day freq)
    repDaysLabel(r) {
      if (!r) return null;
      const anchor = new Date((this.draft.on || isoDate(new Date())).slice(0, 10) + 'T00:00');
      if (r.freq === 'week') return r.weekdays?.length ? r.weekdays.map(i => WEEKDAYS[i]).join(' ') : WEEKDAYS[anchor.getDay()];
      if (r.freq === 'month') { const n = r.month_day || anchor.getDate(); return 'the ' + n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }
      if (r.freq === 'year') return anchor.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return null;
    },
    pulseWeekdays() { this.flash('hdrPulse', '_hdrPulseT', true, 700); },
    // count-ends stepper: count and date are mutually exclusive (ends is single-valued); stepping to 0 = never
    setRepeatCount(delta) {
      const r = this.curRule(); if (!r) return;
      const next = Math.max(0, Math.min(99, (r.ends?.count || 0) + delta));
      r.ends = next ? { count: next } : null;
    },
    toggleEndPicking() { if (this.curRule()) this.endPicking = !this.endPicking; },
    // Tap-and-hold a day (~450ms) = "every month on the Nth", anchored there. The trailing click is swallowed.
    calDayTap(c) {
      const r = this.curRule();
      if (this.endPicking && r) {   // quiet end-pick: tapped day = last occurrence of the active statement; boundary re-tap clears
        this.setRepeatUntil(c.iso === r.ends?.date ? '' : c.iso);
        this.endPicking = false; return;
      }
      if (this.repRules().length) {
        this.draft.on = c.iso;
        if ((this.draft.available_from || '').slice(0, 10) > c.iso) this.draft.available_from = '';
        this.repRules().forEach(x => { x.gen_due = false; });   // hand-set due: stays accent even while paused
        return;
      }
      // ON register (§11): the tap is an INTENTION — one all-day placement, re-tap to move it, re-tap the
      // same day to unplace. It never touches the window/deadline, so flipping registers loses nothing.
      if (this.dreg === 'on') { this.draft.on = this.draft.on === c.iso ? '' : c.iso; return; }
      this.calDayBy(c);
    },
    // BY register, nearest-endpoint model (2026-08-07, replaces tap-tap arming): fresh tap = THE deadline.
    // With something set, a tap grows the window at whichever endpoint the day is nearer (only a deadline:
    // earlier = start, later = deadline moves). Re-tapping an endpoint collapses to deadline-only that day —
    // so a degenerate from==deadline window can't exist. Drag (calUp) writes the same two fields.
    // Also the RIGHT-CLICK accelerator from any register (the By segment wears the mouse glyph for it).
    calDayBy(c) {
      const keepT = t => t + (this.draft.deadline_at || '').slice(10);   // a date tap never eats a set deadline time
      const f = (this.draft.available_from || '').slice(0, 10), dl = (this.draft.deadline_at || '').slice(0, 10);
      if (c.iso === dl || c.iso === f) {
        // same-day cycle (2026-08-08): a window endpoint collapses to by-that-day; by → ONLY (walls both
        // sides — vote day, birthday call); only → clear. Each state is voiced live on the chip.
        if (f === dl && f === c.iso) { this.draft.deadline_at = ''; this.draft.available_from = ''; return; }
        if (!f && c.iso === dl) { this.draft.available_from = c.iso; return; }
        this.draft.deadline_at = keepT(c.iso); this.draft.available_from = ''; return;
      }
      const day = iso => new Date(iso + 'T00:00');
      if (dl && c.iso < dl && (!f || day(c.iso) - day(f) <= day(dl) - day(c.iso))) { this.draft.available_from = c.iso; return; }
      this.draft.deadline_at = keepT(c.iso);
      if (f && f >= c.iso) this.draft.available_from = '';   // an end at/before the start is nonsense — drop the from
    },
    calDayClass(c, ci) {
      const f = (this.draft.available_from || '').slice(0, 10), dl = (this.draft.deadline_at || '').slice(0, 10);
      const a = this._calDn, hh = this.calH ?? a, drag = a != null && hh !== a;   // in-gesture range previews as the committed look
      // amber cap = draft.on: the rule anchor in repeat mode, the ON placement outside it. Painted in
      // BOTH registers — flipping to By must not hide a placement the user can still see on the chip.
      return { out: !c.cur, today: c.today, sel: !drag && !!this.draft.on && c.iso === this.draft.on, occ: c.occ, 'occ-h': c.occh, 'occ-g': c.occg, end: c.end, h: c.endh,
        dsel: drag ? ci === Math.max(a, hh) : c.iso === dl,   // the window's END is the deadline — closing bracket ⌉
        fsel: drag ? ci === Math.min(a, hh) : !!f && c.iso === f,   // the window's START — opening bracket ⌈
        only: !drag && !!f && f === dl && c.iso === dl,   // collapsed window: both walls red
        wnd: drag ? ci >= Math.min(a, hh) && ci < Math.max(a, hh) : !!f && !!dl && c.iso >= f && c.iso < dl,
        gz: c.iso === this.draft.on && this.repRules().some(r => r.paused && r.gen_due) };
    },
    // --- shared time popover (anchors: the Add-time row and the sentence's [at ...] chip) ---
    // ONE popover for every time anchor (due row, repeat sentence, deadline strip) — so it's fixed to the
    // viewport, not absolute inside whichever `.pop` it was opened from.
    toggleTimePop(ev) {
      if (this.tpop) { this.tpop = false; return; }
      const b = ev.currentTarget.getBoundingClientRect();   // BOTTOM-anchored (it sits above its trigger) — the only one
      this.tpopStyle = `display:block; left:${Math.round(popLeft(b.left, 218))}px; bottom:${Math.round(innerHeight - b.top + 6)}px;`;
      this.tpop = true;
      this.$nextTick(() => this.$refs.tpopIn?.focus());
    },
    // the time the popover edits: the deadline's hour when that popup is open, else the active statement's
    // own `at`, else the plain draft's task-level time
    timeGet() {
      const r = this.curRule(); return r ? (r.at || '') : (this.draft.dueTime || '');
    },
    timeSet(v) {
      const r = this.curRule(); if (r) { if (v) r.at = v; else delete r.at; } else this.draft.dueTime = v;
    },
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
    // due mode rides the On|By register toggle beside the month title — a MODE flag, not a menu (§11)
    calHeadHtml() { return '<span class="flex items-center gap-8"><span x-text="calLabel()"></span><span class="dreg swt" :class="{ by: dreg === \'by\' }" x-show="pop === \'due\' && !repRules().length"><button type="button" data-reg="on" :class="{ on: dreg === \'on\' }" :aria-pressed="dreg === \'on\'" title="Tap a day to schedule it there — an intention, never red" @click="setDreg(\'on\')">On</button><button type="button" data-reg="by" :class="{ on: dreg === \'by\' }" :aria-pressed="dreg === \'by\'" title="Tap a day = the deadline; right-click does this from either mode" @click="setDreg(\'by\')">By</button></span></span><span class="cal-navs flex items-center"><button type="button" class="cal-nav inline-flex items-center justify-center" @click="calShift(-1)"><svg class="ico"><use href="#i-chev-l"/></svg></button><button type="button" class="cal-nav dot inline-flex items-center justify-center" @click="calToday()"><svg class="ico"><use href="#i-circle"/></svg></button><button type="button" class="cal-nav inline-flex items-center justify-center" @click="calShift(1)"><svg class="ico"><use href="#i-chev-r"/></svg></button></span>'; },
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
        const anchor = this.draft.on ? this.draft.on.slice(0, 10) : todayIso;
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
      // Both registers read on the one chip, each in its own voice: a placement is a plain date ("Fri 12"),
      // a wall keeps "by"/the window. Never "by" for an intention.
      const dl = this.draft.deadline_at, f = this.draft.available_from, parts = [];
      if (this.draft.on) parts.push(this.fmt(this.draft.on) + (this.draft.dueTime ? ' ' + this.fmtTime(this.draft.dueTime) : ''));
      if (f && dl && f.slice(0, 10) === dl.slice(0, 10)) parts.push('only ' + this.fmt(dl.slice(0, 10)));   // one-day world-window — walled on both sides
      else if (f && dl) parts.push(this.fmt(f.slice(0, 10)) + ' – ' + this.fmt(dl.slice(0, 10)));   // the window; its end IS the deadline
      else if (dl) parts.push('by ' + this.fmt(dl.slice(0, 10)) + (timeOf(dl) ? ' ' + this.fmtTime(timeOf(dl)) : ''));
      return parts.join(' · ') || 'When';
    },
    recurrenceLabel(rec) { return recurrenceLabel(rec); },
    blockName(id) { return (this.blocks || []).find(b => b.id === id)?.title || null; },
    // from→due range: drag directly on the due calendar (tap = due, unchanged); the fchip is a readout + hint
    calXi(e) { const g = e.currentTarget, gr = g.getBoundingClientRect(), fr = g.querySelector('.cal-day').getBoundingClientRect();
      const col = Math.max(0, Math.min(6, Math.floor((e.clientX - gr.left) / gr.width * 7)));
      const rowH = (gr.bottom - fr.top) / 6;   // dow header row sits above the 6 day rows
      const row = Math.max(0, Math.min(5, Math.floor((e.clientY - fr.top) / rowH)));
      return row * 7 + col; },
    calDown(e) { if (this.pop !== 'due' || this._calDn != null || this.repRules().length || this.dreg === 'on') return; this._calDragged = false; this._calDn = this.calXi(e); this.calH = this._calDn; },   // no range-drag against a rule or in the On register — a placement is one day, and a drag there would silently write the other register
    calMove(e) { if (this._calDn == null || this.pop !== 'due') return; const i = this.calXi(e); if (i === this.calH) return;
      this.calH = i; try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} },
    calUp(e) { if (this._calDn == null) return; const cs = this.calCells(), a = this._calDn, z = this.calXi(e); this._calDn = null; this.calH = null;
      if (a === z) return;   // tap: the button's own click → calDayTap
      const lo = cs[Math.min(a, z)], hi = cs[Math.max(a, z)]; if (!lo || !hi) return;
      this._calDragged = true;   // eat the trailing click so calDayTap doesn't re-fire/close
      this.draft.available_from = lo.iso; this.draft.deadline_at = hi.iso + (this.draft.deadline_at || '').slice(10); },
    pulseCal() { this.calPulse = false; requestAnimationFrame(() => { this.calPulse = true; setTimeout(() => this.calPulse = false, 800); }); },
    _nlpEl() { return _nlpFocus?.el || this.$refs.content; },
    _nlpDraft() { return _nlpFocus?.draft || this.draft; },
    // --- Inline-pill editor (contenteditable title) ---
    // draft.content = the editor's TEXT nodes only (pills excluded), whitespace-collapsed. WYSIWYG: this
    // is the title verbatim; fields come only from pills (Task 3), never a submit-time re-parse.
    syncTitle() {
      const el = this._nlpEl(), d = this._nlpDraft(); if (!el) return;
      d.content = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
      const empty = !el.querySelector('.nlp-pill') && d.content === '';
      if (!_nlpFocus) { this.titleEmpty = empty; this._nlpTrack(el); }   // titleEmpty is title-only placeholder state
      else if (_nlpFocus.ghost) this.subGhost = el.textContent.trim();   // ghost's active-state + submit-flush + autosave mirror
      if (empty && el.childNodes.length) {     // emptied (stray <br>/whitespace) → reset clean, caret to start
        el.textContent = '';
        this._caret(el, 0);
      }
    },
    setEditorText(text) { const el = this.$refs.content; if (el) { el.textContent = text || ''; this.titleEmpty = !el.querySelector('.nlp-pill') && (text || '') === ''; this._noPillOnce = false; this._nlpPrev = null; } },
    // Minting/removing a title pill is ONE ⌘Z step together with the raw text it consumed: snapshot the editor
    // after every title edit, but journal only when the PILL SET changed (plain typing is native-undo territory).
    _nlpSnap(el) { return { html: el.innerHTML, sig: [...el.querySelectorAll('.nlp-pill')].map(p => p.dataset.kind + ':' + p.dataset.value).join('|'), f: Object.fromEntries(PILL_KINDS.map(k => [k, this._fieldSnapshot(k)])) }; },
    _nlpTrack(el) {
      const snap = this._nlpSnap(el), prev = this._nlpPrev;
      if (prev && prev.sig !== snap.sig) this._pushDraftEdit(snap.sig.length > prev.sig.length ? 'Title chip' : 'Title chip removed', 'title-nlp', { before: prev, after: snap });
      this._nlpPrev = snap;
    },
    _nlpRestore(s) {
      this.focusTitle();   // the engine must aim at the title (a stale subtask target would restore into the wrong draft)
      this.$refs.content.innerHTML = s.html;
      for (const k of PILL_KINDS) this._restoreField(k, s.f[k]);
      this._nlpPrev = s; this.syncTitle();
    },
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
      this._descBefore = raw;   // blur is the commit boundary: one ⌘Z step per focus session, however much was typed
      el.textContent = raw;
      this._setCaret(el, off ?? raw.length);
    },
    onDescBlur(el) {
      el.innerHTML = this._descHtml(el.textContent);
      const after = this.draft.notes || '';
      if (this._descBefore != null && this._descBefore !== after) this._pushDraftEdit('Description edit', 'desc-edit', { before: this._descBefore, after });
      this._descBefore = null;
    },
    descKeydown(e) {
      // ArrowDown out of an EMPTY description continues the ladder into the entry rows; with text in it, down
      // still moves the caret through the lines (the field owns the key).
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!this.$refs.desc?.textContent.trim() && (e.key === 'ArrowDown' ? this.focusFirstEntry() : this._focusEntry(this.$refs.content))) e.preventDefault(); return; }
      // Enter AND Shift+Enter both newline here — a description is multi-line, and only ⌘/Ctrl+Enter ever saves
      // (caught by the composer's capture handler before this runs, so there's no modifier case left to handle).
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      this.descInsert('\n');
    },
    // The ONE way text enters the description. Never execCommand: 'insertText' drops a '\n' outright in this WebView,
    // and its multi-line paste arrives as <br>/<div> nodes that textContent silently flattens — so draft.notes lost
    // every pasted newline, and the next re-render (Enter, save) redrew the field from that flattened raw.
    // Splice into the raw instead (mdLive keeps textContent===raw with real \n; pre-wrap renders it), then put the
    // caret back INSIDE the text node — one parked past a standalone trailing \n collapses back before it.
    descInsert(str) {
      const el = this.$refs.desc; if (!el) return;
      const off = this._caretOffset(el); if (off == null) return;
      const text = el.textContent, nt = text.slice(0, off) + str + text.slice(off);
      this.draft.notes = nt;
      el.innerHTML = this._descHtml(nt);
      this._setCaret(el, off + str.length);
    },
    descPaste(e) { e.preventDefault(); this.descInsert((e.clipboardData || window.clipboardData).getData('text/plain')); },
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
    // the DOM (area is an additive array → empty it fully; other kinds clear to their default).
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
    // "#" means file it under a project — sidebar projects + the default, not every task that happens to have children.
    projMatches() { const def = this.store.defaultProject(); return this.pickerMatches(this.tasks.filter(t => t.sidebar || t.id === def), this.projPicker.frag); },
    locMatches() { const q = this.locPicker.frag.trim().toLowerCase(); return this.locations.filter(l => !q || l.name.toLowerCase().includes(q)); },
    // Dependencies autocomplete over EXISTING open tasks — a dependency on something that doesn't exist yet
    // is a note, and notes already have a field.
    linkMatches(frag) { return this.pickerMatches(this.tasks.filter(t => t.id !== this.editing && !t.sidebar && t.id !== this.store.defaultProject() && !t.completed_at && !t.archived_at), frag).slice(0, 8); },
    // needs/needed-by share ONE popup (never open together): these aim it at whichever is live.
    _linkType() { return this.needsPicker.open ? 'needs' : this.nbyPicker.open ? 'neededBy' : null; },
    linkPicker() { const t = this._linkType(); return t ? this[PICKERS[t].key] : null; },
    // Rows, not bare tasks: a candidate is shown with its OWN checkbox (importance color, progress arc, lock)
    // and project, so "which task am I linking?" is answered the same way the list answers it. ≤8 rows.
    linkOptions() { const t = this._linkType(); if (!t) return []; const { mkRow } = this._mkRowFn(false); return PICKERS[t].matches(this).map(x => mkRow(x, 0)); },
    rowCheckHtml(r) { return checkHtml(r, 'span'); },
    pickLink(id) { const t = this._linkType(); if (t) this.pickPill(t, id); },
    // Click-only (no Enter): "Meet Sam at 5pm" + Enter must submit the task, never invent a place called "5pm".
    async createLocFromPicker() { const nm = this.locPicker.frag.trim(); if (!nm) return; await this.addLocation(nm); this.pickPill('loc', nm); },
    locOpenCount(id) { return this.tasks.filter(t => !t.completed_at && !t.archived_at && (t.location?.ids || []).includes(id)).length; },
    // Open, then immediately re-derive at/frag from the node — the trigger keydown lands before its own character
    // is inserted, so anything already typed past it (a paste, a fast burst) would otherwise be missed.
    openPicker(type, node, at) { const sp = PICKERS[type], p = this[sp.key]; Object.assign(p, { open: true, frag: '', sel: 0, node, at, left: 0, top: 0 }); this._refreshPicker(p, sp, sp.sel); },
    refreshPicker(type) { const sp = PICKERS[type]; this._refreshPicker(this[sp.key], sp, sp.sel); },
    pickPill(type, id) {
      const sp = PICKERS[type], p = this[sp.key], node = p.node, L = sp.char.length;
      node.textContent = node.textContent.slice(0, p.at) + node.textContent.slice(p.at + L + p.frag.length);
      this._caret(node, p.at);
      this.insertPill(node, p.at, sp.kind, id, sp.char + (sp.name(this, id) || ''));
      p.open = false;
      if (_nlpFocus?.c) this._nlpEl().focus();
    },
    // Keys while an autocomplete popup is open (the ONE popup key ladder — every picker is a PICKERS spec).
    // `grid` adds ←/→ to the ladder (the area menu wraps); `noSpace` lets Space type through (those fragments
    // contain spaces); Enter with nothing to pick falls through to the spec's create path.
    pickerKeydown(type, e) {
      const sp = PICKERS[type], p = this[sp.key]; if (!p.open) return false;
      if (e.key === 'Escape') { p.open = false; return true; }
      const matches = sp.matches(this);
      if (e.key === 'ArrowDown' || (sp.grid && e.key === 'ArrowRight')) { p.sel = Math.min(p.sel + 1, Math.max(0, matches.length - 1)); return true; }
      if (e.key === 'ArrowUp' || (sp.grid && e.key === 'ArrowLeft')) { p.sel = Math.max(p.sel - 1, 0); return true; }
      if ((e.key === 'Enter' || (e.key === ' ' && !sp.noSpace)) && matches.length) { const m = matches[p.sel] || matches[0]; this.pickPill(type, sp.val ? sp.val(m) : m.id); return true; }
      if (e.key === 'Enter' && sp.onCreate) return sp.onCreate(this);
      return false;
    },
    refreshPickers() { for (const t in PICKERS) if (this[PICKERS[t].key].open) this.refreshPicker(t); },
    pickArea(id) { this.pickPill('area', id); },   // index.html references this by name
    // Position a "@"/"#" autocomplete under its trigger char. rAF (not $nextTick): Alpine applies the :style left async — measure after paint.
    _positionPicker(p, sel) {
      if (!p.node) return;
      const body = this.$refs.content.closest('.composer-body'); if (!body) return;
      const r = document.createRange();
      r.setStart(p.node, Math.min(p.at, p.node.textContent.length)); r.collapse(true);
      const rect = r.getBoundingClientRect(), base = body.getBoundingClientRect();
      p.left = rect.left - base.left; p.top = rect.bottom - base.top + 4;
      requestAnimationFrame(() => this.clampX(document.querySelector(sel)));
    },
    // Re-derive the trigger position/fragment as the user types; close when the trigger text is gone.
    _refreshPicker(p, sp, sel) {
      if (!p.open || !p.node) return;
      const txt = p.node.textContent || '', idx = sp.find ? sp.find(txt) : txt.lastIndexOf(sp.char);
      if (idx < 0) { p.open = false; return; }
      p.at = idx; p.frag = txt.slice(idx + sp.char.length); p.sel = 0;
      this._positionPicker(p, sel);
    },
    async createAreaFromPicker() {
      const id = await this.ensureAreaId(this.areaPicker.frag);   // reuse-or-create by name → id
      if (id) this.pickArea(id);
    },
    // Pill-editor keydown shared by the title + every subtask row: pickers, trigger chars, and space→pill.
    // Returns true when fully consumed (pickers / trigger chars); Enter is left to the caller (submit vs commit-row).
    _pillKeydown(e) {
      for (const t in PICKERS) if (this[PICKERS[t].key].open && this.pickerKeydown(t, e)) { e.preventDefault(); e.stopPropagation(); return true; }
      // Trigger chars open their picker on the NEXT tick — the char isn't in the DOM when keydown fires. The
      // caret's anchorNode can be the editor ELEMENT (fresh/empty row), whose mixed textContent indexes wrong
      // and whose text pickPill would overwrite — so walk down to the text node that actually holds the char.
      const trig = e.key === '@' ? 'area' : e.key === '#' ? 'proj' : null;   // ternary, not a literal map: no allocation per keystroke
      if (trig) { this.$nextTick(() => { let node = getSelection()?.anchorNode; if (!node) return;
        if (node.nodeType !== 3) { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.includes(e.key)) { node = n; break; } }
        const at = (node.textContent || '').lastIndexOf(e.key); if (at >= 0) this.openPicker(trig, node, at); }); return true; }
      // "at "/"needs "/"needed by " open their picker, so the phrase teaches itself — the trigger is the
      // space that ends the word.
      if (e.key === ' ') {
        if (!this._noPillOnce && this.pillifyTrailing()) e.preventDefault();
        else this.$nextTick(() => {
          const s = getSelection(), n = s?.anchorNode; if (n?.nodeType !== 3) return;
          const txt = n.textContent.slice(0, s.anchorOffset);
          for (const t in PICKERS) { const sp = PICKERS[t];
            if (sp.word && new RegExp('(?:^|\\s)' + sp.word + '\\s$', 'i').test(txt)) return this.openPicker(t, n, s.anchorOffset - sp.char.length);
          }
        });
        this._noPillOnce = false;
      }
      else if (e.key.length === 1) { this._noPillOnce = false; }   // typing fresh content re-enables space→pill (Backspace/Delete → onEditorBeforeInput)
      return false;
    },
    editorKeydown(e) {
      if (this._pillKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this.submitComposer(); return; }
      // ArrowDown ladder: the title is a single line, so down is free to mean "next field".
      if (e.key === 'ArrowDown' && !e.shiftKey) { const d = this.$refs.desc; if (d) { e.preventDefault(); d.focus(); this._setCaret(d, 0); } }
    },
    // A save is async (store write + reload), and the draft isn't cleared until it resolves — so a second
    // ⌘⏎ (or a held key auto-repeating) in that window would add the SAME task again. Latch it.
    async submitComposer() {
      if (_submitting) return;
      _submitting = true;
      try { return await this._submit(); } finally { _submitting = false; }
    },
    async _submit() {
      if (!this.draft.content.trim()) return;   // contenteditable has no `required`; block empty titles
      if (_nlpFocus?.c) await this.commitChildEdit(_nlpFocus.c);   // ⌘Enter never blurs the focused subtask row — flush its text + pills, or they're lost
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
        const sc = this._listScroller(), stBefore = sc ? sc.scrollTop : 0;
        // A save is ALWAYS slow enough to warrant feedback (composer collapse + reloadAll dominate; the store write
        // itself is quick, so the only-if-slow 150ms gate never tripped). Spin the checkmark IMMEDIATELY and let it
        // span the whole save — the post-save morph re-renders the row (clearing it) exactly when the saved data shows.
        this._setCheckPending(editId, true);
        // revealId = editId: fires in the done callback AFTER the 240ms animation + applyEditDom so _rowOffscreen
        // sees settled layout. revealGuard = stBefore: skips the reveal if the user scrolled > 300px during save.
        this.closeComposer('pre', editId, false, stBefore);
        let updated;
        _carryHint = new Set([editId]);   // carry unchanged row html through the post-save _listModel rebuild
        await this._journalRowChange('Saved task', 'task', editId, async () => {
          updated = await this.store.tasks.update(editId, fields);
          if (updated) {
            // A completed task whose checklist now has an undone item must reopen (e.g. you just added one).
            const cl = updated.checklist || [];
            if (updated.completed_at && cl.length && !cl.every(c => c.done)) { await this.store.tasks.setCompleted(updated.id, false); updated = this._rowById('task', updated.id); }
          }
        });
        _carryHint = null;   // defensive: cleared by _listModel if the surface was visible, else clear here
        if (updated) await this._saveSched(editId, draft);   // the ON register lands as a date-item, never as recur_from
        if (updated && await this._applyDraftLinks(editId, draft)) await this.loadTasks();
        if (!updated) {
          // Save failed — reopen the composer with the user's unsaved edits so nothing is silently lost.
          this._setCheckPending(editId, false);   // drop the spinner; the composer takes over again
          this.editing = editId; _editPin = editId; this.draft = draft;
          this._editDescs = new Set(descendantIds(this.tasks, editId).slice(1));
          this.openComposer();
          this.toast('Save failed — try again');
        } else {
          // No scroll-hold: native scroll-anchoring keeps the list put. Spinner + flash are cosmetic; they go on as
          // soon as the store write is confirmed (the reveal above, keyed to the animation, lands at ~241ms).
          this._clearPending(editId);   // saved → discard the pending draft so it can't resurrect over the save
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
        if (this.composer.open && !DRAFT_KINDS.includes(this._journalPeek(e.shiftKey ? 1 : -1)?.kind)) return;   // composer open → only its OWN draft edits step; task-level ones stay blocked
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();   // ⌘⇧Z = redo
        return;
      }
      // ⌘/Ctrl+Enter saves & closes the open composer from ANYWHERE — no input focus needed.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.composer.open) { e.preventDefault(); this.submitAndClose(); return; }
      // ⌘/Ctrl+K opens the everything-nav palette from anywhere, even mid-typing (Space does it outside typing).
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.openPalette(); return; }
      // Plan claims ⌘/Ctrl+↑/↓ as well: the native binding is "scroll to the end of the document", and the
      // month scroller is virtualized to ~670k px, so it read as an uncontrollable fling. One period, morphed —
      // the same readable jump as Shift.
      // (no composer guard: the composer lives on Lists, and a stale-open one must not hand the fling back)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.surface === 'plan'
          && !this.palette.open && !this.overview) {
        e.preventDefault(); this.clStep(e.key === 'ArrowDown' ? 1 : -1, true); return;
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
      for (const [c, a] of [
        [this.shortcutsOpen, ()=>this.shortcutsOpen=false], [this.trashOpen, ()=>this.trashOpen=false],
        [this.palette.open, ()=>this.palette.open=false], [this.confirm, ()=>this.confirmNo()],
        [this.delAsk, ()=>this.delAsk=null], [this.locMgr, ()=>this.locMgr=false],
        [this.filterEdit, ()=>this.filterEdit=null],
        [this.eventEdit, ()=>this.eventEdit=null], [this.blockEdit, ()=>this.blockEdit=null],
        [this.settingsOpen, ()=>this.settingsOpen=false],   // corner settings popup — own light backdrop, below the dialogs
        [this.navPop, ()=>this.navPop=null], [this.listMenu, ()=>this.listMenu=null],   // Hearthsay sentence menus (add/sort)
        [this.navRename, ()=>this.navRename=null], [this.tpop, ()=>this.tpop=false],
        [this.endPicking, ()=>this.endPicking=false], [this.pop, ()=>this.pop=null],
        [this.selMenu, ()=>this.selMenu=null],   // an open edit-bar sub-menu closes before the selection itself
        [this.sel.length, ()=>this.clearSel()],  // active multi-select clears (before the lower list states)
        [this.overview, ()=>this.overview=false], [this.composer.open, ()=>this.closeComposer()],
        [this.focusId, ()=>this._setKbFocus(null)],
      ]) if (c) { a(); return; }
    },

    fmt(ts) {
      if (!ts) return '';
      const dateOnly = ts.length <= 10, d = new Date(dateOnly ? ts + 'T00:00' : ts);
      const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });   // no year, timed or not — these are near-term dates
      return dateOnly ? day : day + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    fmtTime(hhmm) {
      if (!hhmm) return hhmm;
      const [h, m] = hhmm.split(':').map(Number);
      const h12 = h % 12 || 12;
      return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm');
    },
    today() { return new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }); },

    async loadTasks() { const tasks = await this.store.tasks.list(); this._rowV++; _calDataV++; this._defId = this.store.defaultProject(); this.tasks = tasks; this.byId = new Map(tasks.map(t => [t.id, t])); this.parentIds = new Set(tasks.map(t => t.parent_id).filter(Boolean)); },
    async loadAreas() { const areas = await this.store.areas.list(); this._rowV++; this.areas = areas; },
    // Never a blank button: an id whose area is gone (deleted elsewhere, not yet loaded) resolves to nothing,
    // and keying the label off draft.areas.length alone left the chip showing its icon and no word at all.
    areaLabel() { return this.areaObjs(this.draft.areas).map(a => a.name).filter(Boolean).join(', ') || 'Areas'; },
    // The ONE map from a data kind to the narrowest re-read that covers it — shared by our own writes
    // (_reloadFor) and by realtime (_subscribeStore), so the two paths can never disagree about what's current.
    // reloadAll() (a whole-account pull: the cloud `bootstrap` RPC) is the cold start and the fallback, not a
    // step in every save. Kinds are the journal's singular target names; the store's channel speaks the same set.
    _loaders() {
      const st = this.store;
      return {
        task: () => this.loadTasks(), area: () => this.loadAreas(),
        event: () => this.loadEvents(), block: () => this.loadBlocks(),
        filter: () => this.loadFilters(),
        location: async () => { this.locations = await st.locations.list(); this.homeLocationId = st.homeLocationId(); this.currentRegion = st.currentRegion(); },
        // _rowV too: a date-item IS a row's date now, so a placement change must repaint the list, not just the calendar
        scheduleItem: async () => { const si = await st.scheduleItems.list(); _calDataV++; this._rowV++; this.scheduleItems = si; },
        blockDay: async () => { const bd = await st.blockDays.list();
          if (window.__bdTestSync) { if (window.__bdBaseOrder) { window.Alpine.disableEffectScheduling(() => { this.blockDays = bd; }); _calDataV++; } else { _calDataV++; window.Alpine.disableEffectScheduling(() => { this.blockDays = bd; }); } } else { _calDataV++; this.blockDays = bd; } },
      };
    },
    // An unknown kind falls back to the whole account — and 'all' is exactly that on purpose: it's what the
    // store sends when realtime dropped and came back, i.e. the one moment we know there may be a hole.
    _reloadFor(kind) { return (this._loaders()[kind] || (() => this.reloadAll()))(); },
    // A delete takes rows with it — Postgres cascades, LocalStore prunes — so it re-reads the lists that can
    // hold a reference to what was removed. Still bounded: never the whole account.
    _reloadAfterDelete(target) { return Promise.all(({ task: ['task', 'scheduleItem'], block: ['block', 'scheduleItem', 'blockDay'] }[target] || [target]).map(k => this._reloadFor(k))); },
    areaById(id) { return this.areas.find(a => a.id === id); },
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
    // --- Composer draft safety ---
    // Nothing typed is ever lost to a mispress: the whole draft is persisted (adherod.draftPending,
    // keyed by editing id or 'new') on EVERY change while the composer is open (x-effect → persistDraft).
    // Closing a dirty+unsaved draft KEEPS it (persisted) + makes it ⌘Z-undoable; reopening restores it.
    _pendingMap() { try { return JSON.parse(localStorage.getItem('adherod.draftPending')) || {}; } catch { return {}; } },
    _writePending(map) { localStorage.setItem('adherod.draftPending', JSON.stringify(map)); },
    // Clearing a pending draft normally means it LANDED (saved, or reverted to the saved state) → its bin row is
    // now stale: a "Restore" that re-applies text already on the task is worse than no row at all. `landed:false`
    // (the explicit Discard) keeps the row — at that point the bin holds the only surviving copy.
    _clearPending(key, landed = true) {
      const m = this._pendingMap(); if (key in m) { delete m[key]; this._writePending(m); }
      if (!landed) return;
      let hit = false;
      for (const e of this.journal) if (e.kind === 'draft' && e.bin && !e.restored && e.payload?.key === key) { e.restored = e.detached = true; hit = true; }
      if (hit) this._journalSave();
    },
    _draftKey() { return this.editing || 'new'; },
    // The full composer input state — draft fields PLUS the uncommitted ghost buffers. This is the unit of
    // loss-protection: everything the user has typed, committed or not. Reading it also subscribes the
    // x-effect to all three, so persistDraft re-fires when you type in a ghost box (not just the draft).
    _draftSig() { return JSON.stringify({ draft: this.draft, chkGhost: this.chkGhost, subGhost: this.subGhost }); },
    // x-effect on the composer: _draftSig() touches every draft field + both ghost buffers so Alpine re-runs this on any edit.
    // Writes are debounced (~300ms) to avoid N serializations per keystroke; flush fires synchronously on pagehide/
    // visibilitychange (registered in init below) so no data is lost when the page closes between keystrokes.
    persistDraft() {
      void this._draftSig(); void this.editing;   // subscribe to draft + ghost buffers + editing (reactive)
      // open flips to false only in the async grow-close callback, so guard the whole close window here —
      // otherwise a save/close that just cleared the pending gets it re-written by this effect mid-animation.
      if (!this.composer.open || this._closingComposer) return;
      clearTimeout(this._draftFlushT);
      this._draftFlushT = setTimeout(() => this._flushDraftNow(), 300);
    },
    _flushDraftNow() {
      if (!this.composer.open || this._closingComposer) return;
      const s = this._draftSig(), map = this._pendingMap(), key = this._draftKey();
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
          const kind = this.chkGhost ? 'chk' : this.subGhost ? 'sub' : null;
          if (kind) this._focusEntry(this._ghostEl(kind));   // handles both shapes: the chk ghost is a textarea, the subtask ghost contenteditable
        });
      } else this.draftRestored = false;
    },
    // Banner "Discard": drop the recovered draft, revert to the saved/pristine state (composer stays open).
    discardDraft() {
      clearTimeout(this._draftFlushT);   // cancel any pending debounce so it can't re-add after _clearPending
      this._clearPending(this._draftKey(), false);   // deliberate discard → the bin keeps the last copy
      this.draftRestored = false;
      this.draft = JSON.parse(this._draftBase).draft; this.chkGhost = ''; this.subGhost = '';
      this.setEditorText(this.draft.content); this.setDescText(this.draft.notes);
      this.$nextTick(() => this.syncChkRows());
    },
    // --- Recently deleted (persistent trash bin) ---
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
    _entryOps(e) { return e.op?.ops || (e.op ? [e.op] : []); },   // composite → its ops; single op → a one-item list; nothing → empty
    // Bulk multi-select DELETE (≥2 reinsert ops — the journal stores a delete as its reinsert inverse).
    _bulkOps(e) { const ops = this._entryOps(e); return ops.length >= 2 && ops.every(o => o.kind === 'reinsert') ? ops : null; },
    // A bin row is either a LOSS (it's gone) or a CHANGE (it still exists, moved or edited). Only losses earn red
    // − lines and "Put it back" — a move rendered as a deletion is alarming, and its Restore button ambiguous.
    // Single-op changes used to fall through to the deletion preview, which is the "moves are staged like
    // deletions" report: one selected task moved read exactly like one deleted.
    trashIsChange(e) {
      const ops = this._entryOps(e);
      return ops.length > 0 && ops.every(o => o.kind === 'update' || o.kind === 'move' || o.kind === 'complete');
    },
    trashIcon(e) {
      if (this.trashIsChange(e)) return 'i-edit';
      return { task: 'i-circle', 'checklist-item': 'i-check', project: 'i-hash', area: 'i-tag-tag', event: 'i-cal', block: 'i-cal', filter: 'i-search', location: 'i-pin', draft: 'i-edit' }[e.target] || 'i-trash';
    },
    // ONE chronological list. It used to be two stacked sections (all losses, then all changes), which threw
    // away the only ordering the bin exists to show — "what did I just do?" — and pushed every change below
    // the fold. The row already says which kind it is (icon, red − vs neutral ·, and this verb), so the
    // grouping bought nothing and cost the timeline.
    trashVerb(e) { return this.trashIsChange(e) ? 'Undo' : 'Put it back'; },
    // A Restore that CANNOT work must not look like it works: a checklist item whose task is gone (never saved,
    // or since deleted) has nowhere to go back to → name the reason in the row and disable the button.
    trashBlocked(e) { return e.kind === 'checklist-item' && !this.byId.get(e.payload?.taskId) ? 'its task is gone' : ''; },
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
      if (e.kind === 'checklist-item') { const text = clip(e.payload?.item?.text), b = this.trashBlocked(e); return cap(text, 'Checklist item' + (b ? ' · ' + b : ''), [{ sign: '-', text }]); }
      const opRow = op => (op.rows && op.rows[0]) || this._rowById(op.target || 'task', op.id ?? op.fwd?.id) || {};
      // A change (move / priority / completion): the rows still exist, so neutral · lines and the label's own
      // sentence ("Moved 3 to Notes") — never a red minus block, which is reserved for things that are gone.
      if (this.trashIsChange(e)) return cap(e.label, 'Changed', this._entryOps(e).map(op => ({ sign: '·', text: clip(opRow(op).content) || '(untitled)' })));
      // Bulk multi-select delete (≥2 ops): show the COUNT + every affected item.
      // (Single-entity deletes model children re-parenting as mixed-kind ops, so they fall through to the row preview below.)
      const bulk = this._bulkOps(e);
      if (bulk) {
        const n = bulk.length, tgt = e.op.target || 'task';
        return cap(`${n} ${tgt}${n > 1 ? 's' : ''}`, 'Deleted', bulk.map(op => ({ sign: '-', text: clip(opRow(op).content ?? opRow(op).name ?? opRow(op).title) || '(untitled)' })));
      }
      // every other bin entry is a deletion → RED − lines from the captured row(s)
      const rows = e.op?.rows || e.op?.ops?.[0]?.rows || [], root = rows[0] || {};
      const title = clip(root.content ?? root.name ?? root.title);
      const lines = [{ sign: '-', text: title }];
      let detail;
      if (e.target === 'task') {
        const subs = Math.max(0, rows.length - 1), bits = [];
        if (subs) bits.push(subs + ' subtask' + (subs > 1 ? 's' : ''));
        if (root.recurrence && root.recur_from) bits.push('repeats from ' + this.fmt(root.recur_from));
        detail = bits.join(' · ') || 'Task';
        for (const it of (root.checklist || [])) if ((it.text || '').trim()) lines.push({ sign: '-', text: clip(it.text) });
      } else detail = { project: 'Project', area: 'Area', event: 'Event', block: 'Time block', filter: 'Filter', location: 'Location' }[e.target] || 'Item';
      if ((root.notes || '').trim()) lines.push({ sign: '-', text: clip(root.notes) });
      return cap(title, detail, lines);
    },
    // Append a journal entry: truncate any live redo tail, push (merging defaults), advance cursor, save.
    // callers read reactive deps before calling; pass only what differs from {id,ts,restored:false}.
    // Truncation must NEVER destroy a bin row: bin retention is independent of journal position, and the cursor can
    // walk OVER a skipped entry (a draft-kind delete with the composer shut) whose bin row is the only copy left.
    // Survivors are re-appended `detached` — still in the bin, permanently out of the linear ⌘Z timeline.
    _journalPush(e) {
      const kept = this.journal.slice(this.cursor).filter(x => x.bin && !x.restored).map(x => (x.detached = true, x));
      this.journal.length = this.cursor;
      this.journal.push(...kept, { id: crypto.randomUUID(), ts: Date.now(), restored: false, ...e });
      this.cursor = this.journal.length; this._journalSave();
    },
    // An edit to the open composer draft. Undoable ONLY while that same draft is on screen (_jSkip) — these
    // entries mutate this.draft, so applying one to a different (or no) composer would corrupt it.
    _pushDraftEdit(label, kind, op) { this._journalPush({ label, target: 'draft', kind, op, bin: false, detached: false, editing: this.editing, sid: this._draftSid }); },
    // One checklist item added / renamed / deleted. A DELETE is ALSO a bin row so it survives the composer
    // closing — kind 'checklist-item' is what the bin label + restore-onto-the-saved-task path key off.
    _pushChkItem(item, index, before, after) {
      const del = after == null;
      this._journalPush({ label: del ? item.text : 'Checklist item', target: 'checklist-item', kind: del ? 'checklist-item' : 'chk-item',
        op: { id: item.id, index, before, after, item }, payload: del ? { taskId: this.editing, index, item } : null, bin: del, detached: false, editing: this.editing, sid: this._draftSid });
    },
    // Entries the timeline steps OVER: bin-only rows, and another draft's edits (or any draft edit with the composer shut).
    _jSkip(e) { return e.detached || (DRAFT_KINDS.includes(e.kind) && !(this.composer.open && this._draftSid === e.sid)); },
    _journalPeek(dir) { let i = dir < 0 ? this.cursor - 1 : this.cursor; while (this.journal[i] && this._jSkip(this.journal[i])) i += dir; return this.journal[i]; },
    // A dropped-but-kept dirty composer draft → a bin row that is ALSO in the linear ⌘Z timeline (detached:false),
    // so ⌘Z or "Restore" reopens the composer with the draft. The pending autosave stays as the same-composer restore.
    _pushDraftBin(key, label) {
      const m = this._pendingMap();
      if (!m[key]) {  // debounce may not have fired yet — write current state now
        m[key] = { editing: this.editing, draft: this.draft, chkGhost: this.chkGhost, subGhost: this.subGhost, ts: Date.now() };
        this._writePending(m);
      }
      const p = m[key];
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
      if (e.kind === 'checklist-item') {
        if (!await this._restoreChecklistItem(e.payload)) { this.toast('Restore failed — try again'); return; }
      } else e.op = await this._apply(e.op);
      e.restored = true; e.detached = true;
      this._journalSave(); await this.reloadAll();
      this.notify('Restored');
    },
    // A deleted checklist item goes back onto its (still-existing) task's stored checklist at its old index.
    async _restoreChecklistItem(payload) {
      const t = this.byId.get(payload.taskId); if (!t) return false;
      const cl = (t.checklist || []).slice(), at = list => Math.min(payload.index ?? list.length, list.length);
      // The STORED row can still hold the item while the open draft has dropped it (deleted, not yet saved) —
      // skipping the write is right, returning early was not: the draft on screen never got it back, so Restore
      // looked like it did nothing and the next save deleted it for real. Both halves are now independent.
      if (!cl.some(c => c.id === payload.item.id)) {
        cl.splice(at(cl), 0, payload.item);
        if (!await this.store.tasks.update(payload.taskId, { checklist: cl })) return false;
      }
      if (this.editing === payload.taskId && !this.draft.checklist.some(c => c.id === payload.item.id)) {
        this.draft.checklist.splice(at(this.draft.checklist), 0, payload.item);
        this.sortChecklist(); this.syncChkRows();
      }
      return true;
    },
    // --- Inverse-op journal (recovery engine; ⌘Z/⌘⇧Z drive undo()/redo() below). ---
    _res(t) { return this.store[t + 's']; },                 // task→tasks, area→areas, goal→goals, event→events, block→blocks, filter→filters, location→locations
    _rowById(t, id) { return t === 'task' ? this.byId.get(id) : (this[t + 's'] ?? JSON.parse(localStorage.getItem('adherod.' + t + 's') || '[]')).find(r => r.id === id); },
    _rowsForDelete(t, id) { const r = this._rowById(t, id); return t === 'task' ? this._taskSubtreeRows(id) : r ? [JSON.parse(JSON.stringify(r))] : []; },
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
    _journalFlush() {
      if (!this._jSaveT) return;   // no pending write — skip (prevents stale flush from pagehide when nothing queued)
      clearTimeout(this._jSaveT); this._jSaveT = null;
      localStorage.setItem('adherod.journal', JSON.stringify({ entries: this.journal, cursor: this.cursor }));
    },
    _journalSave() {
      const p = pruneJournal(this.journal, this.cursor, Date.now()); this.journal = p.journal; this.cursor = p.cursor;
      this._jV++;   // kept sync: trashItems() reactivity must update immediately
      if (!this._jSaveT) this._jSaveT = setTimeout(() => this._journalFlush(), 0);
    },

    // Diff helper for completion fx: which tasks' FX_FIELDS changed — so the inverse can restore every affected row.
    _fxDiff(tasks, before) {
      return { changed: tasks.filter(t => before.has(t.id) && JSON.stringify(before.get(t.id)) !== JSON.stringify(FX_FIELDS(t))).map(t => ({ id: t.id, before: before.get(t.id) })) };
    },
    // Run `mutate` (setCompleted / move), capturing which tasks' completed_at (and recurring fields) changed.
    async _captureCompletionFx(mutate) {
      const before = new Map(this.tasks.map(t => [t.id, FX_FIELDS(t)]));
      await mutate();
      await this.loadTasks();
      return this._fxDiff(this.tasks, before);
    },
    // Reverse a captured completion delta: reopen every changed row.
    async _reverseFx(fx) {
      await Promise.all((fx?.changed || []).map(c => this.store.tasks.update(c.id, c.before)));
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
          const fx = await this._captureCompletionFx(async () => {
            if (op.fwd.done) await this._checkAllItems(op.fwd.id);
            await this.store.tasks.setCompleted(op.fwd.id, op.fwd.done);
          });
          return { kind: 'complete', target: 'task', mode: 'reverse', fwd: op.fwd, fx };
        }
        // Reverse: reopen every swept/target row.
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
          await this._removeRow(op.target, op.id);
          return { kind: 'reinsert', target: op.target, id: op.id, rows, _fxCapture: { before } };
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
      await this._reloadFor(target);
      const after = this._rowById(target, id) || {};
      // normalize: treat missing array fields as empty so undefined→[] isn't a spurious diff
      for (const k of Object.keys(after)) if (before[k] === undefined && Array.isArray(after[k])) before[k] = [];
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
      await (op.kind === 'delete' ? this._reloadAfterDelete(op.target) : this._reloadFor(op.target));
      // Finalize deferred fx for task deletes (captured before the delete; compared after this reloadAll so no double reload).
      if (entryOp?._fxCapture) {
        const { before } = entryOp._fxCapture; delete entryOp._fxCapture;
        entryOp.fx = this._fxDiff(this.tasks, before);
      }
      this._pushEntry(label, entryOp, { bin: !!bin });
    },
    // Shared undo/redo body; dir=-1 = undo, dir=1 = redo. Draft branch is asymmetric: undo reopens, redo skips.
    async _journalStep(dir) {
      if (dir < 0) { while (this.cursor > 0 && this._jSkip(this.journal[this.cursor - 1])) this.cursor--; if (this.cursor <= 0) return; }
      else { while (this.cursor < this.journal.length && this._jSkip(this.journal[this.cursor])) this.cursor++; if (this.cursor >= this.journal.length) return; }
      const e = this.journal[this.cursor + Math.min(dir, 0)];
      if (e.kind === 'draft') { if (dir < 0) { this._reopenDraft(e.payload); e.restored = true; e.detached = true; } else this.cursor++; this._journalSave(); return; }
      if (DRAFT_KINDS.includes(e.kind)) {
        const was = dir < 0 ? e.op.before : e.op.after;
        if (e.kind === 'chk-multi') this.draft.checklist = JSON.parse(JSON.stringify(was));
        else if (e.kind === 'desc-edit') this.setDescText(this.draft.notes = was);
        else if (e.kind === 'title-nlp') this._nlpRestore(was);
        else {   // one item: null text = it did not exist then, so undo/redo removes or re-inserts it where it was
          const cl = this.draft.checklist, i = cl.findIndex(c => c.id === e.op.id);
          if (was == null) { if (i >= 0) cl.splice(i, 1); }
          else if (i >= 0) cl[i].text = was;
          else cl.splice(Math.min(e.op.index, cl.length), 0, { ...e.op.item, text: was });
        }
        if (e.bin) e.restored = dir < 0;
        this.syncChkRows();   // a row that lost focus mid-edit has no live x-effect dep on item.text — repaint it from the draft
        this.cursor += dir; this._journalSave();
        dir < 0 ? this.notify(e.label + ' undone', { actions: [{ label: 'Redo', fn: () => this.redo() }] }) : this.notify(e.label, { actions: [{ label: 'Undo', fn: () => this.undo() }] });
        return;
      }
      e.op = await this._apply(e.op);
      if (e.bin) e.restored = dir < 0;   // undo: mark restored (bin row visible again); redo: unmark
      this.cursor += dir; this._journalSave(); await this.reloadAll();
      if (e.target === 'task') this._landOn(e.op?.id ?? e.op?.fwd?.id ?? e.op?.ops?.[0]?.id);
      dir < 0 ? this.notify(e.label + ' undone', { actions: [{ label: 'Redo', fn: () => this.redo() }] }) : this.notify(e.label, { actions: [{ label: 'Undo', fn: () => this.undo() }] });
    },
    async undo() { await this._journalStep(-1); },
    async redo() { await this._journalStep(1); },
    // Shared transient flash: sets `this[prop] = id` for `ms`, guarding against a rapid re-flash
    // clearing early (clearTimeout before rearming). Used by the weekday-header pulse.
    flash(prop, timerProp, id, ms) {
      this[prop] = id;
      clearTimeout(this[timerProp]);
      this[timerProp] = setTimeout(() => { this[prop] = null; }, ms);
    },
    async loadFilters() { this.filters = await this.store.filters.list(); this._rowV++; },   // a filter's query drives the filter view's rows — invalidate the visibleRows memo
    async loadLocations() { await this._reloadFor('location'); },
    isHomeLocation(id) { return this.homeLocationId === id; },
    async setHomeLocation(id) { await this.store.setHomeLocation(id); await this.loadLocations(); },   // toggles home in the store; loadLocations refreshes the reactive mirror
    // NLP name list: real place names + a synthetic "home" alias (unless a place is literally named "home") so "at home" resolves.
    locNames() { const n = this.locations.map(l => l.name); if (this.homeLocationId && this.locations.some(l => l.id === this.homeLocationId) && !n.some(x => x.toLowerCase() === 'home')) n.push('home'); return n; },
    locByName(nm) { const low = String(nm).toLowerCase(); return this.locations.find(x => x.name.toLowerCase() === low) || (low === 'home' && this.homeLocationId ? this.locations.find(x => x.id === this.homeLocationId) : null) || null; },
    async addLocation(name, region) { if (!name?.trim()) return; await this.store.locations.add({ name: name.trim(), region: region || this.currentRegion }); await this.loadLocations(); },
    async patchLocation(id, fields) { await this.store.locations.update(id, fields); await this.loadLocations(); },
    async deleteLocation(id) { await this.perform('Deleted location', { target: 'location', kind: 'delete', id }); },
    locName(id) { const l = this.locations.find(x => x.id === id); return l ? l.name : id; },
    // Row badge: first pinned location's name (+N when several), '' when the task isn't location-scoped or names aren't loaded.
    rowLoc(t) {
      // The PICKED SET is what makes a task location-scoped — an empty set is "anywhere", whatever `mode` says
      // (the same rule as locPolarity). Trusting mode hid the badge on every task saved with the default 'any'.
      const L = t.location; if (!L || !(L.ids || []).length) return '';
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
    toggleLocId(id) { const ids = new Set(this.draft.location?.ids || []); ids.has(id) ? ids.delete(id) : ids.add(id); this.draft.location = { mode: this.draft.location?.mode === 'except' ? 'except' : 'only', ids: [...ids] }; },   // 'any' is truthy — `|| 'only'` left picked places stored as unscoped
    regions() { return [...new Set(this.locations.map(l => l.region || 'Home'))]; },
    // Manager grouping (string model): regions in use + any just-created empty ones.
    displayRegions() { return [...new Set([...this.regions(), ...this.pendingRegions])]; },
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
      const created = f.id ? await this.store.filters.update(f.id, fields) : await this.store.filters.add(fields);
      await this.loadFilters();
      this.filterEdit = null;
      if (!f.id && created) this.setNav('filter', created.id);   // a brand-new filter navigates to itself
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
      // Checklist items deleted while this draft was still unsaved left bin rows with no task to restore into
      // (this.editing was null). The task exists now — bind them, or the bin holds a Restore that can never work.
      let bound = false;
      for (const e of this.journal) if (e.kind === 'checklist-item' && e.sid === this._draftSid && e.payload && !e.payload.taskId) { e.payload.taskId = row.id; bound = true; }
      if (bound) this._journalSave();
      // Position at end of siblings so new task appears just above the composer (bottom of its group).
      const siblings = this.tasks.filter(t => t.parent_id === (row.parent_id ?? null) && t.id !== row.id);
      if (siblings.length) {
        const maxPos = Math.max(...siblings.map(t => t.position ?? 0));
        await this.store.tasks.update(row.id, { position: maxPos + 1 });
        row.position = maxPos + 1;
      }
      await this._saveSched(row.id, this.draft);   // the ON register lands as a date-item, never as recur_from
      await this._applyDraftLinks(row.id);   // before the reload below, so the new links are in the first render
      this.tasks.push(row); if (row.parent_id) this.parentIds.add(row.parent_id);   // keep hasChildren truthful until loadTasks rebuilds
      await Promise.all([this.loadTasks(), this.loadAreas()]);
      this._clearPending('new');   // saved → the recovered-draft slot is spent
      this.resetDraft();
      this._draftBase = this._draftSig();   // next rapid-add starts clean
      this.draftRestored = false;
      return row;
    },

    childTasks(id) { return this.tasks.filter(t => t.parent_id === id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)); },
    addChecklistItem(text) { if (!text.trim()) return; const it = { id: crypto.randomUUID(), text: text.trim(), done: false }; this.draft.checklist.unshift(it); this.sortChecklist(); this._pushChkItem(it, this.draft.checklist.indexOf(it), null, it.text); },   // new items land at the TOP of the open bucket
    // The composer keeps the array open-first/done-last (stable) so the array order == the visual order (drag indices map 1:1).
    sortChecklist() { this.draft.checklist.sort(byDone); },
    // Uncheckable: the checklist renders as a plain notes list (no boxes, no done styling) everywhere
    chkPlain() { return !!this.editingTask()?.checklist_plain; },
    async toggleChecklistPlain() { const t = this.editingTask(); if (t && await this.store.tasks.update(t.id, { checklist_plain: !t.checklist_plain })) await this.loadTasks(); },
    toggleChecklistItem(item) { item.done = !item.done; this.sortChecklist(); },   // toggling done moves the item to the done bucket
    removeChecklistItem(item) { const i = this.draft.checklist.indexOf(item); if (i >= 0) this.draft.checklist.splice(i, 1); if ((item.text || '').trim()) this._pushChkItem(item, i, item.text, null); },
    // Backspace on an empty checklist row deletes it and lands the caret on the neighboring entry.
    chkBackspace(item, e) {
      const selRows = document.querySelectorAll('.composer-entries .entry.chk.chk-sel');
      if (selRows.length >= 2) {
        e.preventDefault();
        const idSet = new Set([...selRows].map(el => el.dataset.id));
        const before = JSON.parse(JSON.stringify(this.draft.checklist));
        this.draft.checklist = this.draft.checklist.filter(c => !idSet.has(c.id));
        // Bin-only row per deleted item (detached: ⌘Z uses only chk-multi; trashView/restoreTrash handle each).
        // Payload matches _pushChkItem's shape; null taskId late-bound by addTask's loop on save (#388).
        for (const it of before.filter(c => idSet.has(c.id))) {
          const i = before.indexOf(it);
          this._journalPush({ label: it.text, target: 'checklist-item', kind: 'checklist-item',
            op: { id: it.id, index: i, before: it.text, after: null, item: it },
            payload: { taskId: this.editing, index: i, item: it }, bin: true, detached: true, editing: this.editing, sid: this._draftSid });
        }
        this._pushDraftEdit('Deleted checklist items', 'chk-multi', { before, after: JSON.parse(JSON.stringify(this.draft.checklist)) });
        return;
      }
      if (e.target.textContent !== '') return;
      e.preventDefault();
      this.moveEntryFocus(e.target, -1) || this.moveEntryFocus(e.target, 1);
      this.removeChecklistItem(item);
    },
    // chkInput writes item.text on every keystroke, so the pre-edit value comes from the focus snapshot — blur is the commit boundary (one ⌘Z step per edit session).
    renameChecklistItem(item, text) { text = text.trimStart(); if (!text.trim()) return; if (this._chkBefore != null && text !== this._chkBefore) this._pushChkItem(item, this.draft.checklist.indexOf(item), this._chkBefore, text); item.text = text; this._chkBefore = null; },
    // checklist rows are plain, page-selectable text until you click into one — so a vertical drag makes a
    // normal document selection that SPANS rows (a per-row contenteditable would trap the drag in one row, killing
    // cross-item select+copy). Click (no drag) enters edit mode with the caret where clicked; a drag keeps the
    // multi-row selection intact for chkCopy. Keyboard focus paths still edit via the row's @focus handler.
    chkRowDown(e) { this._chkDownAt = { x: e.clientX, y: e.clientY }; this._chkPointer = true; },
    // A drag that STARTS in the row you're already typing in is confined to that editable host, so it can't reach
    // siblings. Once it leaves the row's own band, drop the row out of edit mode mid-drag and the selection spans
    // rows again — an in-row drag (select a word to retype it) never leaves the band, so that row keeps editing.
    chkDragOut(e) {
      const a = document.activeElement;
      if (!this._chkDownAt || !e.buttons || a?.contentEditable !== 'true' || !a.matches('.entry.chk:not(.ghost) .entry-txt')) return;
      const r = a.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) a.contentEditable = 'false';
    },
    chkRowUp(el, e) {
      const d = this._chkDownAt; this._chkDownAt = null; this._chkPointer = false;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;   // a drag-select → keep the selection, don't edit
      if (el.contentEditable === 'true') return;   // already editing (2nd click of dblclick) — let browser word-select natively
      el.contentEditable = 'true'; el.focus();
      const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);      // caret at the click point (best-effort)
      if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    },
    // auto-grow the ghost textarea to fit its wrapped content (field-sizing isn't universally implemented)
    // hidden → scrollHeight 0: keep auto, else the ghost re-shows 0px tall (unclickable)
    taGrow(el) { if (!el) return; el.style.height = 'auto'; if (el.scrollHeight) el.style.height = el.scrollHeight + 'px'; },
    // Rows are tabbable (tabindex=0) so keyboard Tab reaches the item title — but a MOUSE press must NOT enter edit
    // mode on focus (that would trap a cross-row drag-select in one contenteditable). _chkPointer marks the mouse path;
    // chkRowUp then decides click-to-edit vs drag. Keyboard focus (no pointer) falls through and enables editing.
    chkFocus(el) {
      if (this._chkPointer) return;   // mouse path: chkRowUp decides click-to-edit vs drag
      el.contentEditable = 'true';
      // A div that becomes editable while already focused has NO caret inside it, so keystrokes do nothing —
      // place a collapsed caret at the end so keyboard Tab-in is immediately typable.
      this._caret(el);
    },
    // Enter → sibling item below · Shift+Enter → newline INSIDE the item (execCommand drops '\n' in this
    // WebView — splice like descKeydown) · ⌘/Ctrl+Enter → save & close the composer.
    chkEnter(e, item) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) return this.submitAndClose();
      if (!e.shiftKey) return this.insertChkAfter(item);
      const el = e.target, off = this._caretOffset(el); if (off == null) return;
      // at the very end, a LONE trailing \n collapses the caret back before it — double it in the HTML
      // so the caret lands on a real empty line. item.text stores only the real inserted \n (no sentinel);
      // renameChecklistItem on blur reads item.text via the capture handler, not el.textContent.
      const text = el.textContent, ins = text.slice(0, off) + '\n' + text.slice(off);
      el.innerHTML = chkLiveRender(off === text.length ? ins + '\n' : ins);
      item.text = ins;
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
      this.subDraft.goal_ids = [...(c?.goal_ids || [])];   // goals have no pill (R4) — carry the row's own, else a commit writes [] over them
      this._recommitPills(PILL_KINDS);      // fields ← pills in this editor
      // area pills can be stale if area_ids were updated after the editor was last hydrated (syncSubRows not called
      // on every loadTasks); seed from the task as a fallback when recommit found none.
      if (c?.area_ids?.length && !this.subDraft.areas.length) this.subDraft.areas = [...c.area_ids];
      this.syncTitle();                     // content ← text nodes (+ mirrors subGhost for the ghost)
    },
    focusTitle() { _nlpFocus = null; },     // title regains the default target when it (re)gains focus
    // The ghost editor carries no x-model — mirror the (kept/restored) subGhost text into its DOM when it's idle
    // (x-effect on the row: re-runs when subGhost changes, but never clobbers what the user is actively typing).
    subGhostSync(el) { if (document.activeElement !== el && (el.textContent || '') !== (this.subGhost || '')) el.textContent = this.subGhost || ''; },
    subGhostHtml() { return '<span class="check sm ghost-check"></span><div class="entry-txt sub-ce" role="textbox" tabindex="0" contenteditable="true" data-placeholder="New subtask" x-effect="subGhostSync($el)" @focus="focusSubEditor($el, null)" @input="subInput()" @beforeinput="onEditorBeforeInput($event)" @keydown="entryKey($event); subEditorKeydown($event, null)" @keydown.escape="entryEscape($event)" @paste="onPaste($event)" @keydown.stop></div>'; },
    _resetSubDraft() { this.subDraft = emptyDraft(); if (_nlpFocus) _nlpFocus.draft = this.subDraft; },
    _ghostEl(kind) { return document.querySelector('.composer-entries .entry' + (kind === 'sub' ? ':not(.chk)' : '.chk') + '.ghost .entry-txt'); },   // the "new subtask" / "new item" prompt row's editor
    _clearEditor(el) { if (el) el.textContent = ''; },
    subInput() { this.syncTitle(); this.refreshPickers(); },
    subEditorKeydown(e, c) {
      if (this._pillKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); c ? this.commitChildEdit(c, true) : this.commitGhostStay('sub'); }
    },
    // A sub-draft → child task fields. A subtask's parent is the editing task (not a project); it has no checklist of its own.
    _subFields(d) { const f = this.draftFields(d); delete f.project; delete f.project_id; delete f.checklist; f.parent_id = this.editing; return f; },
    async commitSubGhost() {
      const el = this._ghostEl('sub');
      // Rebuild the sub-draft from the ghost's DOM — covers Save-flush, where focus may never have entered the row.
      if (el) this.focusSubEditor(el, null);
      const fields = this._subFields(this.subDraft);   // content trimmed + importance-word flush live in draftFields
      const sd = { on: this.subDraft.on, dueTime: this.subDraft.dueTime, recurrence: this.subDraft.recurrence };   // survives the reset below
      this.subGhost = '';
      // Reset the row BEFORE the (async) create: Enter leaves you typing in this same element, so anything
      // clearing it afterwards would eat the next subtask's first keystrokes. Re-aim the engine at the row here
      // too — .focus() on an already-focused element fires no focus event, so nothing else re-points it and the
      // typing would land in the task title (and the row would keep reading as an empty placeholder).
      this._clearEditor(el); this._resetSubDraft();
      if (el && document.activeElement === el) this.focusSubEditor(el, null); else _nlpFocus = null;
      if (this.editing && fields.content) {
        const task = await this.addSubtask(this.editing, fields);   // create-with-fields; position-at-top + reopen-parent
        if (task) { await this._saveSched(task.id, sd); this._pushEntry('Added subtask', { kind: 'remove', target: 'task', id: task.id, rows: this._rowsForDelete('task', task.id) }); }
      }
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
      const si = c.recurrence ? null : this._siOf(c.id);   // the placement is the date fact; recur_from is only a rule anchor now
      if (si || c.recur_from) add('date', { iso: si?.date || c.recur_from.slice(0, 10), time: si ? si.start || '' : timeOf(c.recur_from), from: c.available_from || null });
      if (c.deadline_at) add('deadline', { iso: (c.deadline_at || '').slice(0, 16) });
      if (c.recurrence) add('rec', c.recurrence);
      if (min) add('dur', min);
      for (const a of (c.area_ids || [])) add('area', a);
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
      return ['content', 'notes', 'importance', 'recur_from', 'available_from', 'deadline_at', 'est_minutes', 'recurrence', 'location', 'area_ids', 'goal_ids']
        .every(k => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
    },
    // Commit an edited child row: rebuild its sub-draft from the row's pills, and update the child if anything changed.
    // Skips while a picker is mid-selection (blur fires before the pick lands — the pick refocuses + a later blur commits).
    async commitChildEdit(c, advance = false) {
      if (this.areaPicker.open) return;
      const el = document.querySelector('.composer-entries .entry[data-id="' + c.id + '"] .entry-txt.sub-ce');
      if (el) this.focusSubEditor(el, c);            // rebuild subDraft from this row's DOM (idempotent)
      const fields = this._subFields(this.subDraft);
      _nlpFocus = null;
      if (advance && el) this.focusEntryGhost(el);   // Enter → hop to the "new subtask" ghost, mirroring the old flow
      if (!fields.content) { this.syncSubRows(); return; }   // emptied → revert to stored (never blank the task's title)
      await this._saveSched(c.id, this.subDraft);   // a row's date pill is a placement (idempotent — no-ops when unchanged)
      if (this._sameChildFields(fields, this._subFields(this.taskToDraft(c)))) return;
      if (await this.store.tasks.update(c.id, fields)) { await this.loadTasks(); this.$nextTick(() => this.syncSubRows()); }
    },
    commitChkGhost() { const v = this.chkGhost.trim(); this.chkGhost = ''; if (v) this.addChecklistItem(v); },
    // Commit the ghost, then keep the caret on it for fast successive entry (survives the empty→list template swap).
    async commitGhostStay(kind) {
      if (kind === 'sub') await this.commitSubGhost(); else this.commitChkGhost();
      this.$nextTick(() => this._ghostEl(kind)?.focus());
    },
    // Up/Down hop editing focus to the prev/next entry row, but only when the caret is already at the text boundary.
    // Handles both <input> (subtask/ghost) and the checklist item's contenteditable (live "::" editor).
    entryKey(e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const el = e.target, ce = el.isContentEditable;
      // A selection spanning whole rows makes the ROW the keydown target, not an editor — it has no caret to
      // reason about (and no .value, which used to throw and kill ⌘C over a multi-item selection).
      if (!ce && typeof el.value !== 'string') return;
      const len = ce ? el.textContent.length : el.value.length, off = ce ? this._caretOffset(el) : el.selectionStart;
      const collapsed = ce ? getSelection()?.isCollapsed : el.selectionStart === el.selectionEnd;
      if (e.key === 'ArrowUp' && collapsed && off === 0) { if (this.moveEntryFocus(el, -1) || this._focusEntry(this.$refs.desc)) e.preventDefault(); }
      else if (e.key === 'ArrowDown' && collapsed && off === len) { if (this.moveEntryFocus(el, 1)) e.preventDefault(); }
    },
    // VISUAL order (ghost → open bucket → done bucket) — sort by on-screen top so the CSS-ordered ghost-on-top
    // layout is respected regardless of DOM order.
    _entryFields(list) { return [...list.querySelectorAll('.entry-txt')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top); },
    // One rung of the focus ladder (entries ↔ description ↔ title), either direction. The caret always lands at the
    // END: on the way UP you're arriving from below, where the down-ladder lands it at 0.
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
      // ⌘/Ctrl+Shift+V pastes VERBATIM — the newlines land inside one item (Shift+Enter makes the same shape).
      // The default below reads bullet-less lines as wrapped prose and space-joins them: right for a pasted
      // paragraph, wrong when the breaks were the point. Chrome fires an ordinary paste event for the shortcut,
      // so the intent is remembered from the keydown that just preceded it (see init).
      if (this._rawPaste) { e.preventDefault(); this._rawPaste = false; return this._chkPasteRaw(e.target, item, text); }
      const bulletRe = /^\s*[-*]\s+/;
      const lines = text.split(/\r?\n/);
      // no-bullet case: seed with '' so continuations accumulate into one item; bullet case: start empty so pre-bullet lines are dropped
      const texts = lines.some(l => bulletRe.test(l)) ? [] : [''];
      for (const l of lines) {
        if (bulletRe.test(l)) texts.push(l.replace(bulletRe, '').trim());
        else if (l.trim() && texts.length) texts[texts.length - 1] += ' ' + l.trim();
      }
      const trimmed = texts.map(t => t.trim()).filter(Boolean);
      if (!trimmed.length) return;
      e.preventDefault();
      const items = trimmed.map(t => ({ id: crypto.randomUUID(), text: t, done: false }));
      // ghost paste lands at the TOP (like addChecklistItem); pasting onto an item inserts right after it
      const at = item == null ? 0 : this.draft.checklist.indexOf(item) + 1;
      const before = JSON.parse(JSON.stringify(this.draft.checklist));
      this.draft.checklist.splice(at, 0, ...items);
      this.sortChecklist();
      this._pushDraftEdit('Pasted checklist items', 'chk-multi', { before, after: JSON.parse(JSON.stringify(this.draft.checklist)) });   // ONE ⌘Z step for the whole paste, not one per item
    },
    // Splice text in at the caret, verbatim. item=null ⇒ the ghost (a textarea on x-model), else a live item editor.
    _chkPasteRaw(el, item, text) {
      const at = item ? (this._caretOffset(el) ?? el.textContent.length) : (el.selectionStart ?? el.value.length);
      const src = item ? el.textContent : el.value, end = item ? at : (el.selectionEnd ?? at);
      const next = src.slice(0, at) + text + src.slice(end);
      if (!item) { this.chkGhost = next; this.$nextTick(() => { el.setSelectionRange(at + text.length, at + text.length); this.taGrow(el); }); return; }
      item.text = next;
      el.innerHTML = chkLiveRender(next);
      this._setCaret(el, at + text.length);
    },
    // tint the checklist rows a cross-row selection spans — previews what ⌘C will copy (chkCopy kicks in at ≥2 rows)
    _chkSelTint() {
      if (!this.composer.open) return;
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
    // Task → markdown: a checkbox line per task, description indented under it, checklist items and subtasks
    // nested below. Copies what's ON SCREEN (the draft), so an edit you can see is an edit you paste.
    taskMd(t, depth = 0) {
      const pad = '  '.repeat(depth), box = (d) => d ? '[x]' : '[ ]';
      const out = [`${pad}- ${box(!!t.completed_at)} ${t.content}`];
      if (t.notes) out.push(...String(t.notes).split('\n').map(l => pad + '  ' + l));
      for (const c of t.checklist || []) out.push(`${pad}  - ${box(c.done)} ${(c.text || '').replace(/\n/g, ' ')}`);
      for (const k of this.childTasks(t.id)) out.push(this.taskMd(k, depth + 1));
      return out.join('\n');
    },
    async copyEditingMd() {
      const t = this.editingTask(); if (!t) return;
      const md = this.taskMd({ ...t, content: this.draft.content || t.content, notes: this.draft.notes, checklist: this.draft.checklist });
      try { await navigator.clipboard.writeText(md); }
      catch { const ta = Object.assign(document.createElement('textarea'), { value: md }); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }   // no clipboard permission → the old way still works
      this.toast('Copied as markdown');
    },
    async removeChild(c) { if (this.askDeleteTask(c.id, 'child')) return; await this.perform('Deleted subtask', { target: 'task', kind: 'delete', id: c.id }); },
    // Drag-to-reorder the composer's rows (grip handle). Subtasks always; the checklist only while EDITING a
    // SAVED task — that is the scope of "no grip in the composer": it was asked for on the NEW-task composer,
    // where nothing is saved yet and the grip crowds the row. Removing it from both took it off saved tasks too.
    initEntrySort(el, kind) {
      makeSortable(el, { itemSel: '.entry:not(.ghost)', handleSel: '.entry-grip',
        onCommit: (from, to) => kind === 'sub' ? this.reorderSubtasks(from, to) : this.reorderChecklist(from, to) });
    },
    async reorderChecklist(from, to) {
      this.draft.checklist.splice(to, 0, this.draft.checklist.splice(from, 1)[0]);
      this.sortChecklist();   // buckets are authoritative — a drop that crossed the open/done split snaps back to its own bucket
      if (this.editing) await this._journalRowChange('Reordered checklist', 'task', this.editing, () => this.store.tasks.update(this.editing, { checklist: this.draft.checklist }));
    },
    async reorderSubtasks(from, to) {
      const ids = this.childTasks(this.editing).map(c => c.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      if (await this.store.tasks.reorder(ids)) await this.loadTasks();
    },
    // O(1)/row via precomputed _editDescs set (was descendantIds() per row → O(n²) on edit-open)
    hiddenInEdit(t) { return !!this.editing && t.id !== this.editing && !!this._editDescs && this._editDescs.has(t.id); },
    // IMPERATIVE hover-block (hovered task + direct children): reading hoverId in 1000 rows' :class costs ~16ms/hover
    hoverRow(r, e) {
      this.clearHover();
      this.hoverId = r.t.id;
      const h = r.t.id, inb = (id, pid) => id === h || pid === h;
      for (const row of [r, ...(_parentMap?.get(h) || [])]) {
        const li = this._rowEl(row.t.id); if (!li) continue;
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
    // keyboard focus outline — one element, applied imperatively.
    // Re-stamp only: a repaint must NEVER pull the reader back to the focused row (_setKbFocus scrolls).
    _paintKb() { _kbEl && _kbEl.classList.remove('kbfocus'); _kbEl = this.focusId ? this._rowEl(this.focusId) : null; _kbEl && _kbEl.classList.add('kbfocus'); },
    // TWO different distances, both real: a step or two past the fold leaves the row IN the window (nothing
    // to build, but the reader still has to follow it — 600px of margin is 15 rows of invisible focus without
    // this), and a long walk leaves it outside the window entirely (no element until _ensureRow builds one).
    // The follow goes through _revealRow, not scrollIntoView: `nearest` was a THIRD authority writing the same
    // scroller behind _glide's back, and _revealRow is the same intent (±12px of air) under the one owner.
    _setKbFocus(id) {
      this.focusId = id;
      if (id) this._ensureRow(id);
      this._paintKb();
      if (_kbEl) this._revealRow(id);
    },
    // --- Delegated row events (bound once on the <ul>, resolve the row by data-id) — see the list markup ---
    _rowFromEl(el) { return el ? (_rowMap?.get(el.dataset.id) ?? _doneMap?.get(el.dataset.id) ?? null) : null; },   // O(1) via Maps maintained in visibleRows(); active OR Done list
    listOver(e) {
      const el = e.target.closest?.('.item'), id = el?.dataset.id;
      if (id === this.hoverId) return;                  // mouseover fires per child element — skip if same row
      const r = id ? this._rowFromEl(el) : null;
      r ? this.hoverRow(r, e) : this.clearHover();
    },
    listClick(e) {
      const sec = e.target.closest?.('.sec-row');
      if (sec) return this.toggleSec(sec.dataset.sec);
      const r = this._rowFromEl(e.target.closest?.('.item')); if (r) this.onRowClick(r, e);
    },
    listDragStart(e) { if (e.target.closest('.chk-row')) return e.preventDefault(); const r = this._rowFromEl(e.target.closest?.('.item')); if (r) this.dragStart(r.t, e, r.depth); },   // a checklist-row drag is pointer-based, not the row's HTML5 drag
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
    listDragOver(e) { const itemEl = e.target.closest?.('.item'); const r = this._rowFromEl(itemEl); if (r) this.dragOver(r.t, { clientY: e.clientY, clientX: e.clientX, currentTarget: itemEl, dataTransfer: e.dataTransfer }, r.depth); if (this.dragId) edgeScrollStep(document.querySelector('.surface-lists .app'), e.clientY); },
    listDragLeave(e) { this.dragLeave(null, e); },
    // No row lookup: the drop lands wherever the pointer happens to be — the gap between rows, the list's own
    // padding, or the drop-ghost (an .item with NO data-id, rendered exactly where you're aiming). Gating on
    // "the release resolved to a row" threw those away, which is why some drags silently did nothing. The last
    // dragOver already recorded the intent in taskDropHint, and drop() reads only that.
    listDrop() { this.drop(); },
    hasProgress(t) { return this.hasChildren(t.id) || (t.checklist || []).length > 0; },   // parentIds Set — never an O(n) childTasks scan per row
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
        await this.loadTasks();
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
      await this.loadTasks();
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
      const f = { checklist: (src.checklist || []).map(c => ({ ...c, id: crypto.randomUUID() })) };   // fresh item ids; identity/status/subtree deliberately absent from the whitelist
      for (const k of ['content', 'notes', 'importance', 'recur_from', 'deadline_at', 'est_minutes', 'parent_id',
        'area_ids', 'goal_ids', 'color', 'favorite', 'place', 'location', 'recurrence', 'milestone', 'checklist_plain']) f[k] = src[k];
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
    // Mark all checklist items done (called inside _captureCompletionFx so the change is captured for undo).
    // Returns false if the store update failed — caller aborts setCompleted on failure to stay atomic.
    // Skips recurring leaf tasks: setCompleted advances their occurrence instead of closing them; leave checklist alone.
    async _checkAllItems(id) {
      const t = this.byId.get(id); const cl = t?.checklist;
      if (!cl?.length || cl.every(c => c.done)) return true;
      if (recActive(t.recurrence) && !t.completed_at && !this.tasks.some(r => r.parent_id === id)) return true;
      return !!await this.store.tasks.update(id, { checklist: cl.map(c => ({ ...c, done: true })) });
    },
    async applyComplete(id, done) {
      // silent: completion is a 100×/day action + goal-linked completions fire their own celebratory toast below — no generic toast.
      // Capture the FULL completion delta (target + swept dependents + auto-completed parents) so undo reverses every affected row,
      // not just id — else the swept rows keep phantom completions inflating stats/streaks/EXP. (_captureCompletionFx reloads.)
      // checklist is in FX_FIELDS so _reverseFx restores the exact prior mix on ⌘Z.
      const fx = await this._captureCompletionFx(async () => {
        if (done && !await this._checkAllItems(id)) return;
        return this._withPending(id, () => this.store.tasks.setCompleted(id, done));
      });
      // Entry op is the REVERSE (first ⌘Z undoes this completion); it carries fwd so redo can re-run + re-capture symmetrically.
      this._pushEntry(done ? 'Completed' : 'Uncompleted', { kind: 'complete', target: 'task', mode: 'reverse', fwd: { id, done }, fx }, { silent: true });
    },

    async save(t, fields) { Object.assign(t, await this.store.tasks.update(t.id, fields) || {}); this._rowV++; },
    async remove(t) { await this.perform('Deleted', { target: 'task', kind: 'delete', id: t.id }); },

    // --- Relations ---
    // Every consumer below (picker x-for, the row :class via relTarget, three wells, the chip row) used to
    // re-scan all tasks for the inverse 'blocks' edge. At 20k that was ~1s per composer render and again per
    // keystroke, so ONE scan is cached per (data-version × edited task) and everyone reads it.
    _relIdx() {
      const key = this._rowV + '|' + this.editing;
      if (_relK !== key) {
        _relK = key;
        const e = this.editingTask(), inv = this.tasks.filter(o => (o.blocked_by ?? []).includes(this.editing)).map(o => o.id);
        // 'blocks' = the INVERSE direction (this task sits in the other's blocked_by) — shown so it's managed from here too
        const rels = [...(e?.blocked_by ?? []).map(id => ({ id, type: 'blocked_by' })), ...inv.map(id => ({ id, type: 'blocks' })), ...(e?.relates ?? []).map(id => ({ id, type: 'relates' }))];
        const related = new Set(rels.map(r => r.id));
        _relI = { rels, open: this.tasks.filter(t => t.id !== this.editing && t.id !== this.store.defaultProject() && !related.has(t.id)) };
      }
      return _relI;
    },
    relationCandidates() {
      const key = this._rowV + '|' + this.editing + '|' + this.pickerQ;
      // cap at 40; narrows as you type
      if (_candK !== key) { _candK = key; _cand = this.pickerMatches(this._relIdx().open).slice(0, 40); }
      return _cand;
    },
    taskRels(t) { return t && t.id === this.editing ? this._relIdx().rels : []; },
    // Blocked = has an incomplete blocker (matches is:blocked) — drives the lock badge in the checkbox.
    blocked(t) { return isBlocked(this.tasks, t.id); },
    relChips() { return this.taskRels(this.editingTask()); },
    // A linked task in a well is still a TASK: it gets the same row the picker above it uses, so its state
    // (done, blocked, its areas, which project it's in) is readable without leaving the pop.
    relLine(id) { const t = this.byId.get(id); return t ? this.taskLine(t) : ''; },
    relTypeLabel(type) { return { blocked_by: 'blocked', blocks: 'blocks', relates: 'relates' }[type]; },
    relIcon() { return 'i-stop'; },
    editingTask() { return this.byId.get(this.editing) ?? null; },
    // Typed "needs / needed by" pills, applied once the task exists (a new one has no id to link to yet).
    // Same store call as the relation panel — one way a dependency gets written. Returns true if it wrote.
    async _applyDraftLinks(id, d = this.draft) {
      const needs = d.needs || [], nby = d.neededBy || [];
      for (const o of needs) await this.store.tasks.link(id, o);
      for (const o of nby) await this.store.tasks.link(o, id);
      return !!(needs.length || nby.length);
    },
    // 'blocks' writes blocked_by on the OTHER task (swapped link direction); 'relates' is symmetric
    async addRelation(otherId, type) {
      if (!otherId) return;
      if (type === 'relates') {
        // Composite: snapshot both rows, link, diff both, push a two-op journal entry so undo clears both sides.
        const snap = id => JSON.parse(JSON.stringify(this._rowById('task', id) || {}));
        const beA = snap(this.editing), beB = snap(otherId);
        await this.store.tasks.link(this.editing, otherId, 'relates');
        await this._reloadFor('task');
        const ops = [];
        for (const [be, id] of [[beA, this.editing], [beB, otherId]]) {
          const af = this._rowById('task', id) || {};
          for (const k of Object.keys(af)) if (be[k] === undefined && Array.isArray(af[k])) be[k] = [];
          const rollback = {}, forward = {};
          for (const k of new Set([...Object.keys(be), ...Object.keys(af)]))
            if (JSON.stringify(be[k]) !== JSON.stringify(af[k])) { rollback[k] = be[k] ?? null; forward[k] = af[k] ?? null; }
          if (Object.keys(rollback).length) ops.push({ kind: 'update', target: 'task', id, after: rollback, was: forward });
        }
        if (ops.length) this._pushEntry('Added relation', ops.length === 1 ? ops[0] : { kind: 'composite', target: 'task', ops }, {});
      } else {
        const taskId = type === 'blocks' ? otherId : this.editing;
        const linkId = type === 'blocks' ? this.editing : otherId;
        await this._journalRowChange('Added relation', 'task', taskId, async () => { await this.store.tasks.link(taskId, linkId); });
      }
      this.pickerQ = '';
    },
    async dropRel(e, type) { const id = e.dataTransfer.getData('text/plain'); if (id && this.byId.has(id)) await this.addRelation(id, type); },
    async removeRelation(otherId, type) {
      let ok;
      if (type === 'relates') ok = await this.store.tasks.unlink(this.editing, otherId, 'relates');
      else if (type === 'blocks') ok = await this.store.tasks.unlink(otherId, this.editing);
      else ok = await this.store.tasks.unlink(this.editing, otherId);
      if (ok) await this.loadTasks();
    },

    // --- Calendar (continuous Month · page-per-week Week/Day — iOS/macOS-Calendar-style) ---
    listView() { return this.surface === 'lists'; },   // task-list views (all/backlog/project/area/filter) live on the Lists surface
    // Open = not completed/archived/sidebar/parent. Callers append their own clauses (block-fill adds unscheduled/overdue).
    _openLeaf(t) { return !t.completed_at && !t.archived_at && !this.isSidebar(t) && !this.hasChildren(t.id); },
    async loadEvents() { const ev = await this.store.events.list(); _calDataV++; this.events = ev; },
    // must bust _calDataV too — without it a block added between two event loads never reaches the memo, and the
    // calendar keeps drawing the previous set until some unrelated task/event change happens to bump the sig
    async loadBlocks() { const bl = await this.store.blocks.list(); _calDataV++; this.blocks = bl; },
    _clDate() { return new Date(this.clAnchor + 'T00:00'); },
    _clWeekStart(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; },   // Sunday
    // threadless items go WARM, never grey — grey is what made scheduled tasks read as disabled
    clItemColor(it) { return it.color || (it.kind === 'task-deadline' ? 'var(--p2)' : it.kind === 'task-due' ? 'var(--p4)' : 'var(--accent)'); },
    _clTime(s) { return this.clAgTime(this._clMin(s)); },
    _monthLabel(d) { return this._lbl('m|' + (d.getFullYear() * 12 + d.getMonth()), () => d.toLocaleDateString([], { month: 'long', year: 'numeric' })); },
    _weekIdx(d) { return Math.round((this._clWeekStart(d).getTime() - CL_EPOCH.getTime()) / 604800000); },
    _weekDate(idx) { const d = new Date(CL_EPOCH); d.setDate(d.getDate() + idx * 7); return d; },
    clAnchorIdx() { return this._weekIdx(this._clDate()); },
    // Row height so exactly 6 weeks fill the page (macOS); rendered-row count = visible + buffer each side.
    clRecalc() {
      this._clM = null;   // BEFORE the read: this is the resize path, so the cached height is the stale one
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
      // A resize only changes the SCALE, and clPos is immune to scale — so day/week just re-measures the window.
      // (It used to re-run _clZoomTo purely to re-anchor scrollTop against the resized spacer.)
      if (!this._clResize) { this._clResize = true; window.addEventListener('resize', () => { if (this.surface !== 'plan') return; this.clRecalc(); if (this.clView === 'month') this.clScrollToAnchor(); else this.clRecalcPages(); }); }
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
    // A 7-column week grid is unreadable at 390px — the phone offers day and month only, and every route
    // into week (the 'w' key, tapping a month week-row) lands on that week's day instead.
    clViews() { return this.narrow ? ['day', 'month'] : ['day', 'week', 'month']; },
    clSetView(v) {
      if (v === 'week' && this.narrow) v = 'day';
      // reset zoom to fit, never to 0 — a zero hour height makes clPeriodH 0, and a divide by it has no position
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
      void this.events; void this.tasks; void this.scheduleItems;
      // clPages re-derives every tick — cache to avoid full-set scans
      return _memo(_groupMemo, fromIso + '|' + toIso + '|' + _calDataV, () => {
        const map = {}, add = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
        for (const it of calendarItems(this.events, this.tasks, fromIso, toIso, new Date(), this._placedMap())) {
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
    // Rows are MEMOIZED per index. Scrolling one row shifts the window by one, but rebuilding every row's day
    // objects handed Alpine fresh identities for all of them, so every cell's bindings re-ran: 1585 DOM
    // mutations for a ONE-row shift, ~27k across a single fling. Returning the identical object makes x-for's
    // scope write a no-op, so only the row that actually entered costs anything. The signature carries
    // everything a row's contents depend on — height, which month is dominant (the `out` fade), and the data.
    clWeeks() {
      if (!this.clRowH) this.clRecalc();
      const byDay = this._clVisMap(), out = [];
      // NOT keyed on clFocusYM: the dominant month changes at every month boundary (~4× a fling) and the only
      // thing that depends on it is the out-of-month fade. Cells carry their own `ym` and the template compares
      // it, so a focus change costs one class binding per cell instead of rebuilding every row.
      const sig = this.clRowH + '|' + _calDataV;
      if (this._clWkSig !== sig) { this._clWkSig = sig; this._clWkCache = new Map(); }
      const cache = this._clWkCache;
      if (cache.size > 200) cache.clear();   // a long scroll would otherwise keep every row it ever passed
      const todayIso = isoDate(new Date());
      const end = Math.min(CL_TOTAL_WEEKS, this.clVisStart + this.clVisCount);
      for (let idx = Math.max(0, this.clVisStart); idx < end; idx++) {
        let row = cache.get(idx);
        if (!row) {
          const ws = this._weekDate(idx);
          const days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(ws);
            d.setDate(d.getDate() + i);
            const iso = isoDate(d);
            return {
              iso, day: d.getDate(), today: iso === todayIso,
              weekend: i === 0 || i === 6, ym: d.getFullYear() * 12 + d.getMonth(),
              mlabel: d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short' }) : '', items: byDay[iso] || []
            };
          });
          cache.set(idx, row = { key: idx, top: idx * this.clRowH, days });
        }
        out.push(row);
      }
      return out;
    },
    // Thursday's month = dominant; shared by scroll handler + jumps for consistent label
    _topMonthLabel(idx) { const d = this._weekDate(idx); d.setDate(d.getDate() + 3); return this._monthLabel(d); },
    _monthFirstIdx(d) { return this._weekIdx(new Date(d.getFullYear(), d.getMonth(), 1)); },   // week index of a month's 1st
    // The viewport line below which a title rides coupled to the body (a band); at or above it the overlay flies
    // it over the header into the bar. That fly runway is one week row in month; in day/week the incoming title
    // rises from the bottom edge instead, because a whole period of runway would be a mile.
    _clZoneTop() { return this.clView === 'month' ? this._clHeadH() + (this.clRowH || 1) : this._clVH() - CL_FOOT; },
    // Body bands: month titles glued to the grid (top=idx*rowH), only BELOW the zone. clZoneTitles picks them up overhead — both read clScrollTop for seamless handoff.
    clMonthBands() {
      if (!this.clRowH) this.clRecalc();
      const rowH = this.clRowH, head = this._clHeadH(), zoneTop = this._clZoneTop(), scrollTop = this.clScrollTop;
      const out = [], end = Math.min(CL_TOTAL_WEEKS, this.clVisStart + this.clVisCount);
      for (let idx = Math.max(0, this.clVisStart); idx < end; idx++) {
        if (head + idx * rowH - scrollTop <= zoneTop) continue;   // in the zone → the overlay shows it
        // A week holds at most one 1st: either it starts on one, or the month turns over inside it (so its last
        // day is already in the new month). Two Dates, not the seven a per-day scan built on every scroll event.
        const ws = this._weekDate(idx), we = new Date(ws); we.setDate(we.getDate() + 6);
        const first = ws.getDate() === 1 ? ws : we.getMonth() !== ws.getMonth() ? we : null;
        if (first) out.push({ name: this._monthLabel(first), top: idx * rowH });
      }
      return out;
    },
    // Parallax clamp/shove/round shared by clZoneTitles and _periodZoneTitles.
    // Callers build list as [{name, vt}]; this applies the parallax, shoves overlaps, and filters.
    // LINEAR (not ease-out t*(2-t)): ease-out's zero slope at t=1 caused a visual "dip" at the band→overlay handoff.
    _zoneLayout(list, head, zoneH, barY, labelH = 46) {
      list.forEach(z => { z.y = z.vt <= head ? barY : barY + (head + zoneH - barY) * ((z.vt - head) / zoneH); });
      for (let i = list.length - 2; i >= 0; i--) list[i].y = Math.min(list[i].y, list[i + 1].y - labelH);
      // park out-of-zone titles at -999 instead of dropping them: the element must stay mounted so the
      // imperative positioner can bring it in mid-period without waiting for an x-for wake
      return list.map(z => ({ name: z.name, y: z.vt > head + zoneH || z.y <= -labelH ? -999 : Math.round(z.y), atBar: Math.abs(z.y - barY) < 3 }));
    },
    // `top` applied imperatively so it never lags
    clZoneTitles() {
      if (!this.clRowH) return [];
      const rowH = this.clRowH, head = this._clHeadH(), barY = this._clBarY != null ? this._clBarY : CL_BAR - 34 - 14, zoneH = this._clZoneTop() - head, scrollTop = this.clScrollTop;   // barY = measured .cl-period top (matches the idle heading on every breakpoint)
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
    // Viewport + scroller height, measured ONCE per layout. Both are forced-reflow reads, and a wheel event
    // wanted three of them — at ~10 trackpad events per frame that alone ate the budget. Invalidated wherever
    // either can actually move: resize, view switch, window recalc. Always cached, even at port===0 (pre-layout);
    // a rAF identity-check invalidates the zero so the next call re-measures once the DOM has laid out.
    _clMetrics() {
      if (this._clM) return this._clM;
      const el = this.$refs.clPages, m = { vh: document.documentElement.clientHeight || window.innerHeight || 800, port: el ? el.clientHeight : 0 };
      this._clM = m;
      if (!m.port) { const snap = this._clM; requestAnimationFrame(() => { if (this._clM === snap) this._clM = null; }); }
      return this._clM;
    },
    _clVH() { return this._clMetrics().vh; },   // window.innerHeight is unreliable in the test webview
    _clFocus(scrollTop) {   // dominant month = the one at the vertical center of the grid → stays bright when idle
      const rowH = this.clRowH || 1, head = this._clHeadH();
      const d = this._weekDate(Math.max(0, Math.floor((scrollTop + (this._clVH() - head) / 2) / rowH)));
      d.setDate(d.getDate() + 3);
      this.clFocusYM = d.getFullYear() * 12 + d.getMonth();
    },
    _clScrollState(scrollTop, list) {
      const z = (list || this.clZoneTitles()).find(t => t.atBar);   // the toolbar heading == the title pinned in the bar
      this.clTopMonth = z ? z.name : this._topMonthLabel(Math.max(0, Math.floor(scrollTop / (this.clRowH || 1))));
      this._clFocus(scrollTop);
    },
    // THE only thing that sets a zone title's `top`. It used to share the job with a reactive :style binding on
    // the same elements, so on any frame where a title entered or left the x-for, the element present had no
    // entry here and kept its stale top until the next flush — that is the teleport. The markup now renders
    // position-less (data-name only) and this is the single writer, called from the one place position moves.
    _clPositionZone(list) {
      const box = this.$refs.clMtitlesBox; if (!box) return;
      const y = {}; for (const t of (list || (this.clView === 'month' ? this.clZoneTitles() : this._periodZoneTitles()))) y[t.name] = t.y;
      for (const el of box.children) { const t = y[el.dataset.name]; el.style.top = (t != null ? t : -999) + 'px'; }   // no entry = not placeable yet; park it off-screen rather than leave it at a stale y
    },
    clMonthScroll(e) {
      const el = e.target, topIdx = Math.max(0, Math.floor(el.scrollTop / (this.clRowH || 1)));
      this.clVisStart = Math.max(0, topIdx - CL_BUFFER);
      this.clScrollTop = el.scrollTop;   // reactive → clMonthBands recomputes each band's rise/fade
      const zt = this.clZoneTitles();    // ONE layout pass, shared by the heading and the positioner — same rule as _clSetPos
      this._clScrollState(el.scrollTop, zt);
      this._clPositionZone(zt);   // sync: place the over-header titles THIS frame (reactive :style lags a frame → teleports on fast scroll)
      const t = performance.now();
      if (t < (this._clMGlide || 0)) return;   // our OWN settle glide: it still virtualizes, but it is not a gesture — re-lighting the chrome here is a flicker
      // TWO chrome states landing at different moments: the out-of-month DIM comes back as soon as the glide
      // slows to a crawl, the month band/title text holds until the scroll has STOPPED. Both are ONE-WAY per
      // scroll session (only _clMSettle re-arms them), because every rate gate we tried strobed — a decaying
      // glide jitters across any threshold, and the browser hands a wheel over in bursts that dip and spike.
      // dt is capped because speed means "distance moved in the last frame-ish window": an event's raw gap
      // spans the IDLE time before the gesture, so a coalesced 1038px jump read 0.33px/ms — a crawl.
      const dt = Math.min(t - (this._clMSt || 0), 100), v = Math.abs(el.scrollTop - this._clMSy) / dt;
      if (!v) return;   // phantom native scroll from el.scrollTop assignment — position unchanged since last synthetic event; skip chrome update
      if (!this._clMDone) {
        if (v > CL_MONTH_SLOW * CL_MONTH_WAKE) this._clMRest = false;
        else if (v <= CL_MONTH_SLOW) { this._clMRest = true; this._clMDone = true; }
      }
      this.clFast = !this._clMRest;
      this.clScrolling = true;
      this._clMSy = el.scrollTop; this._clMSt = t;
      clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this._clMSettle(), motion.t(600));   // backstop for a scroll whose scrollend never comes
    },
    // @scrollend, DEBOUNCED: a wheel's notches each END their own scroll, so settling on the bare event blinked
    // the month text off and back on 21ms later. Only a stop that lasts is a stop.
    clMonthSnap() { clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this._clMSettle(), motion.t(CL_MONTH_SETTLE)); },
    // The settle drops the chrome, re-arms the dim for the next scroll — and snaps the grid to a week boundary
    // OURSELVES. CSS scroll-snap can only do this by arresting the fling mid-flight (it cut a 2400px trackpad
    // fling to 9px); doing it here, after the scroll has stopped, keeps the momentum free AND lands flush.
    _clMSettle() {
      this.clScrolling = false; this.clFast = false; this._clMRest = true; this._clMDone = false;
      const el = this.$refs.clMonth, h = this.clRowH;
      if (!el || !h) return;
      const to = Math.round(el.scrollTop / h) * h;
      if (Math.abs(to - el.scrollTop) < 2) return;   // already flush — a 0px glide would still fire scroll events
      this._clMGlide = performance.now() + motion.t(700);   // this glide is ours; clMonthScroll must not read it as a gesture
      el.scrollTo({ top: to, behavior: this.reduceMotion() ? 'auto' : 'smooth' });
    },
    // …and the hand always wins: a smooth scrollTo keeps animating THROUGH new input, so it fought anyone who
    // scrolled during the settle. Any real input aborts the glide (an instant scroll to where we already are
    // cancels the animation) and hands the scroll straight back.
    clMonthTake() {
      if (!this._clMGlide) return;
      this._clMGlide = 0;
      const el = this.$refs.clMonth; if (el) el.scrollTo({ top: el.scrollTop, behavior: 'auto' });
    },
    clScrollToAnchor(tries = 8) {
      const el = this.$refs.clMonth; if (!el) return;
      // A zero-height element SILENTLY IGNORES scrollTop, and the Plan surface can still be off-screen when a
      // view switch lands here (clSetView runs this in its after-callback). Nothing re-runs it, so the month
      // stayed parked at row 0 while clVisStart pointed at the anchor — a grid rendered outside its own
      // window, i.e. empty. Retry until layout exists; same guard _clScrollToPeriod already carries.
      if (!el.clientHeight && tries > 0) return void requestAnimationFrame(() => this.clScrollToAnchor(tries - 1));
      if (!this.clRowH) this.clRecalc();
      const target = this._monthFirstIdx(this._clDate()), top = target * this.clRowH;
      this.clVisStart = Math.max(0, target - CL_BUFFER);
      this.clScrollTop = top;
      this._clScrollState(top);
      this.$nextTick(() => { el.scrollTop = top; this._clScrollState(top); });
    },
    _clStepMonth() {
      const el = this.$refs.clMonth; if (!el) return this.clScrollToAnchor();
      if (!this.clRowH) this.clRecalc();
      el.scrollTo({ top: Math.max(0, this._monthFirstIdx(this._clDate()) * this.clRowH), behavior: this.reduceMotion() ? 'auto' : 'smooth' });
    },
    clOpenWeekRow(idx) { this.clAnchor = isoDate(this._weekDate(idx)); this.clSetView('week'); },   // tap a week → expand

    // --- Continuous day/week timeline. NO SCROLLER: clPos is the position and the timeline is painted at
    // translateY(-clPosOff · --ph). Month keeps its native scroller — a bounded grid with no zoom has nothing
    // to fight — which is why clScrollTop still exists and means month, and only month. ---
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
      if (this.clView !== 'week') return WEEKDAYS.map(n => ({ key: n, name: n }));
      const ps = this._periodDate(this._clTopIdx()), todayIso = isoDate(new Date());
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d);
        return { key: iso, name: WEEKDAYS[d.getDay()], day: d.getDate(), today: iso === todayIso, weekend: d.getDay() === 0 || d.getDay() === 6 };
      });
    },
    _clTopIdx() { return this.clPos.idx; },
    _clHeadH() { return CL_BAR + CL_HEAD; },   // every px of pinned chrome the timeline hides under (must match --cl-top in CSS)
    _clFitHour() { return Math.max(18, Math.round((this._clVH() - this._clHeadH()) / (CL_WAKING_END - CL_WAKING_START))); },   // a waking day fills the viewport at zoom 1
    // How far INTO a period you can travel before its far edge is on screen, as a fraction of the period. 0 =
    // the period exactly fills the viewport, so there is nowhere to go and the next push is a page turn.
    // The week gets a little BLEED past its own end so the next week's first hours peek in before the page
    // turns — stopping dead the instant the last hour touches the bottom edge reads as a wall.
    _clMaxFrac() { const ph = this.clPeriodH(), port = this._clMetrics().port;
      if (!port || !ph) return 0;
      return Math.max(0, 1 - (port - this._clHeadH()) / ph) + (this.clView === 'week' ? CL_WEEK_BLEED / ph : 0); },
    // toLocaleDateString is ~100us; three zone titles plus the heading asked for one on EVERY wheel event.
    // A period's label is a pure function of its key, so it is computed once and kept.
    _lbl(k, make) { if (_periodLabels.has(k)) return _periodLabels.get(k); const v = make(); if (_periodLabels.size > 500) _periodLabels.clear(); _periodLabels.set(k, v); return v; },
    _periodLabelAt(idx) { return this._lbl(this.clView + '|' + idx, () => this._periodLabel(this._periodDate(idx))); },
    // The offset the timeline is painted at, in PERIODS, relative to the first rendered one.
    clPosOff() { return (this.clPos.idx - this.clPVisStart + this.clPos.frac).toFixed(4); },
    // The ONE paint. --pf and --ph are written together, so a zoom can never catch the transform and the
    // block tops (which are calc(var(--ph) * rel)) disagreeing for a frame. Both are custom properties on
    // already-composited elements: no layout, no Alpine, no style recalc beyond the transform itself.
    _clPaint() {
      const el = this.$refs.clPages, inner = this.$refs.clInner; if (!inner) return;
      el?.style.setProperty('--ph', this.clPeriodH() + 'px');
      inner.style.setProperty('--pf', this.clPosOff());
      this._clAdPaint();
    },
    // The rails are chrome, so the ONE thing allowed to move them is the week boundary — a week's items may
    // never outlive their week. `--rd` is how far below the pin that line sits, `--re` the same line measured
    // off the floor; both go negative once it is on screen, and each rail is then dragged along by it (the
    // arithmetic lives in the CSS, beside the rule it moves). The top rail pins under the weekday row and is
    // pushed out by its own height; the bottom rail pins above the nav and rides up the same way, because a
    // deadline belongs to the END of its day. The NEXT week's pair arrives from the far side of that same
    // line, so at d=0 they already stand exactly where the outgoing pair was and the index flip moves nothing.
    // Three properties on the WRAPPER, which Alpine never re-renders. Writing transforms onto the rails
    // themselves lost them every time a rail's contents changed — the rail snapped back to the floor until
    // the next wheel event, which is a teleport you can trigger just by editing a task.
    _clAdPaint(tries = 6) {
      // the ref can be absent on the very first paint (the surface is still mounting) — and a rail that
      // misses that paint stays parked at its CSS default until you happen to scroll, which reads as the
      // week's all-day items simply not existing. Retry, exactly as clScrollToAnchor does for layout.
      const w = this.$refs.clAd;
      if (!w) return void (tries > 0 && requestAnimationFrame(() => this._clAdPaint(tries - 1)));
      if (this.clView !== 'week') return;   // month/day have no boundary to ride, and the veil belongs to one
      const d = (1 - this.clPos.frac) * this.clPeriodH(), h = this._clMetrics().port - this._clHeadH() - CL_FOOT;
      const pg = this.clAdPage();
      // The deadline rail's height is the ONE number the top rail can't derive: its rows are wrapped type, not
      // a fixed grid. Measured when the week's contents change — never per frame. The `!_clAdH` arm is what
      // makes it survive the real entry path: the first paint runs while the surface is still mounting, so the
      // rail measures 0, and with only a page-identity guard that 0 stuck forever and the rails overlapped.
      // Retry ONLY while this page actually wants a deadline rail. The old `r.style.display !== 'none'` read
      // was true for every week that simply has no deadlines, so the measure — two forced layouts and a custom
      // property written on the wrapper, which restyles every child — ran on EVERY frame. A dense week froze
      // the renderer outright and put 16s on the suite.
      if (pg !== _clAdPg || (!_clAdH && this.clHasDeadlines(pg))) {
        _clAdPg = pg; this._clAdMeasure(w); requestAnimationFrame(() => this._clAdMeasure(w));
      }
      if (d === _clAdD) return;   // a wheel that didn't move the boundary must not restyle the rails
      _clAdD = d;
      w.style.setProperty('--rd', d + 'px');
      w.style.setProperty('--re', (d - h) + 'px');
      // the veil is the ONE stable element here, so it is written directly — a third property on the wrapper
      // would re-run style for every label in both rails just to change one element's alpha
      const v = w.firstElementChild;
      if (v) { v.style.transform = `translate3d(0,${Math.min(0, d - h)}px,0)`; v.style.opacity = Math.max(0, (h - d) / h) * CL_LEAVE_DIM; }
    },
    _clAdMeasure(w) {
      const r = w.querySelector('.cl-dlrail'); _clAdH = r ? r.offsetHeight : 0; w.style.setProperty('--dlh', _clAdH + 'px');
      // …and the same number for the INCOMING pair, which reserved nothing: both .nx rails hung off the same
      // boundary line, so a week with a tall deadline rail (18 labels ≈ 119px) simply swallowed its own claims
      // at the bottom of the screen — visible on arrival, no scrolling needed.
      const nx = w.querySelector('.cl-adrail.nx'), h = nx && nx.offsetParent ? nx.offsetHeight : 0;
      if (h !== _clAdNxH) { _clAdNxH = h; w.style.setProperty('--adh', h + 'px'); }   // writing it restyles every child — only on a real change
    },
    // Called from the wrapper's x-effect, i.e. AFTER Alpine renders a rail — the only moment its height can be
    // measured. Nothing scrolls at that point, so the paint's own "did d change?" guard would skip it; the
    // caches are cleared so it re-measures and re-places. Safe to re-run: every value here is derived.
    _clAdSync() { _clAdPg = null; _clAdD = undefined; this._clAdPaint(); },
    // THE one writer of clPos. Everything — wheel, touch, keys, jumps, tweens — arrives here in period-space.
    // Reactive state is touched ONLY when it actually changes: clPos is MUTATED IN PLACE so that a scroll
    // within a period (frac only) wakes nothing that reads .idx — clHeadCells rebuilds all seven week-header
    // cells off .idx, and having that run per wheel event is what made this feel heavy.
    _clSetPos(idx, frac) {
      const t = Math.max(0, Math.min(this._periodTotal() - 0.0001, idx + frac)), i = Math.floor(t);
      const crossed = i !== this.clPos.idx;
      if (crossed) this.clPos.idx = i;
      this.clPos.frac = _clFrac = t - i;   // _clFrac mirrors frac without Alpine reactivity
      if (crossed) this.clPVisStart = Math.max(0, i - 1);
      this._clPaint();
      const zt = this._periodZoneTitles();   // computed ONCE and shared — the positioner and the heading both want it
      this._clPeriodState(zt);
      // Place THIS frame — a reactive :style would lag one, which reads as the title teleporting on fast
      // scroll. Only a period crossing can add or remove a title, so only then is a post-flush pass needed
      // to place a brand-new element (it starts at CSS `top: -999px`, so it can never flash at the wrong y).
      this._clPositionZone(zt);
      if (crossed) this.$nextTick(() => this._clPositionZone());
    },
    // Tween in PERIOD-space (page turn, keyboard nudge). Same two properties as _glide — we own the handle so
    // a second request supersedes rather than races — but there is no scroller to fight, so it cannot be
    // clamped, cancelled or retargeted by the browser behind our back.
    _clTween(idx, frac, ms = CL_TURN_MS) {
      if (this.reduceMotion()) { motion.stop('clTween'); return this._clSetPos(idx, frac); }
      ms = motion.t(ms);
      const from = this.clPos.idx + this.clPos.frac, to = Math.max(0, Math.min(this._periodTotal() - 0.0001, idx + frac)), t0 = performance.now();
      motion.run('clTween', now => {   // keyed run: a second turn supersedes, never races
        const p = Math.min(1, (now - t0) / ms), at = from + (to - from) * EASE_OUT(p);
        this._clSetPos(Math.floor(at), at - Math.floor(at));
        if (p >= 1) this._clSettle();
        return p < 1;
      });
    },
    clRecalcPages() {
      this._clM = null;   // the scroller's height can have changed (view switch, resize) — re-measure once
      this.clHourH = Math.max(18, Math.round(this._clFitHour() * this.clZoom));
      this.clPVisCount = Math.ceil((this._clVH() - this._clHeadH()) / this.clPeriodH()) + 2;
      this.clPVisStart = Math.max(0, this.clPos.idx - 1);
    },
    // Pure per-day column (shared by clBlocks and the Peek Pane) — touches NO Plan scroll state.
    // All blocks lane-pack with events/tasks as peers (flat pack).
    _clColumn(iso, items = (this._clGroup(iso, iso)[iso] || [])) {
      const d = new Date(iso.slice(0, 10) + 'T00:00'), todayIso = isoDate(new Date());
      const tRanges = items.filter(it => !it.allDay && it.start.length > 10).map(it => { const sm = this._clMin(it.start), em = Math.max(this._clMin(it.end), sm + 20); return { it, sm, em }; });
      const blocks = this._dayBlocks(iso);
      const packed = this._lanePack(tRanges, blocks);
      return { iso, day: d.getDate(), today: iso === todayIso, past: iso < todayIso, weekend: d.getDay() === 0 || d.getDay() === 6, label: d.toLocaleDateString([], { weekday: 'short' }), blocks, packedBlocks: packed.filter(p => p.blk), ...this._clSplitDay(items), timed: packed.filter(p => !p.blk), cleared: this._clCleared(items) };
    },
    clBlocks() {
      void this.tasks; void this.events; void this.blocks; void this.byId; void this.blockDays;   // register deps BEFORE the memo can short-circuit — else a hit records no dep and adds/edits don't repaint
      if (!this.clHourH) this.clRecalcPages();
      const span = this._periodSpan(), todayIso = isoDate(new Date()), ph = this.clPeriodH();
      // The rendered window is just "around where you are" — there is no spacer to live inside, so no origin
      // to drift from, so nothing to recentre. It follows clPos for free.
      const start = Math.max(0, this.clPVisStart), end = Math.min(this._periodTotal(), start + this.clPVisCount);
      if (end <= start) return [];
      // The view-switch/scroll settle re-fires this effect ~100× against unchanged inputs. Return the SAME array
      // ref on a hit so Alpine's x-for no-ops instead of re-diffing every column/event. _calDataV busts on any data change.
      const sig = this.clView + '|' + start + '|' + end + '|' + this.clHourH + '|' + span + '|' + todayIso + '|' + _calDataV + '|' + this._rowV;
      if (_clBlocksSig === sig) return _clBlocksCache;
      const from = this._periodDate(start), toD = this._periodDate(end - 1); toD.setDate(toD.getDate() + span - 1);
      const byDay = this._clGroup(isoDate(from), isoDate(toD));
      const out = [];
      for (let idx = start; idx < end; idx++) {
        const ps = this._periodDate(idx);
        const cols = Array.from({ length: span }, (_, i) => {
          const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d);
          return this._clColumn(iso, byDay[iso] || []);
        });
        // Day stops being a grid, so it has no band layer at all: the agenda gives every mark and every all-day
        // item — including one that merely passes through today — a real row of its own.
        const bands = this._clWeekBands(cols);
        if (span === 1) for (const c of cols) c.agenda = this._clAgenda(c);
        out.push({ key: idx, rel: idx - start, cols, bands });   // top comes from --ph in CSS so it cannot drift from the height
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
      if (now - this._clHold.t0 < motion.t(CL_HOLD_MS)) return this.clNudge(dir);
      if (now - this._clHold.last < CL_HOLD_STEP) return;
      this._clHold.last = now; this.clStep(dir);
    },
    // ↑/↓: one hour in week/day, one week row in month. Smooth, so the move reads as movement and you keep your
    // place; it goes through the same scroller the wheel uses, so the snap and the midnight gate still apply.
    clNudge(dir) {
      // Month keeps the BROWSER's smooth scroll. It is a bounded grid with no zoom and no spacer — none of the
      // reasons day/week needed taking over apply — and its own virtualization re-render legitimately shifts
      // scrollTop, which a glide reads as someone else grabbing the wheel and gives up on.
      if (this.clView === 'month') return this.$refs.clMonth?.scrollBy({ top: dir * this.clRowH, behavior: this.reduceMotion() ? 'auto' : 'smooth' });
      const at = this.clPos.idx + this.clPos.frac + dir * (this.clHourH || 40) / this.clPeriodH();   // one hour, in periods
      this._clTween(Math.floor(at), at - Math.floor(at), 220);
    },
    // How far down the day the deadline bites. Date-only means "by the end of it", so the rule sits at the
    // day's close; the moment deadlines carry a time, the same rule simply moves up to that hour.
    clDlPct(it) { return timeOf(it.start) ? this._clMin(it.start) / 14.4 : 100; },
    clDlWhen(it) { const t = timeOf(it.start); return t ? this.fmtTime(t) : 'by end of day'; },
    // The page BOTH chrome rails describe: the week at the top of the viewport. Neither can be `position:
    // sticky` inside the grid — .cl-period-block sets `contain: paint`, which makes it the containing block
    // for its descendants, so a sticky layer sticks to the BLOCK and rides the transform off-screen with it.
    // Never null: a rail's x-for still evaluates its body while the rail is display:none, so an empty page
    // is what keeps a hidden rail from throwing on every view that isn't week.
    clAdPage() {
      if (this.clView !== 'week') return CL_NO_PAGE;   // day view is the agenda, which already gives each one a row
      const b = this.clBlocks();
      return b.find(p => p.key === this._clTopIdx()) || b.find(p => p.key === this._periodIdx(this._clDate())) || b[0] || CL_NO_PAGE;
    },
    // Two rails, drawn from ONE template: the week at the top, and the one whose start line is rising toward
    // the pin. What makes the swap invisible is that they trade places at d=0 — the incoming rail is already
    // sitting exactly where the outgoing one was, so the index flip moves nothing. See _clAdPaint.
    clAdPages() {
      const nx = this.clView === 'week' && this.clBlocks().find(p => p.key === this._clTopIdx() + 1);
      return [this.clAdPage(), nx || CL_NO_PAGE];
    },
    clAdRailOn(p) { return p.bands.length > 0 || p.cols.some(c => c.marks.length); },
    clHasDeadlines(p) { return p.cols.some(c => c.deadlines.length); },
    // Chapter: a day's marks start below the bands standing over THAT day — not below the tallest stack
    // anywhere in the week. A week-wide max meant one Tuesday claim reserved an empty row under all seven
    // columns, so a single all-day task pushed every other day's marks down for no reason.
    clChRows(pg, i) { return this.clColBands(pg, i).reduce((m, b) => Math.max(m, b.row + 1), 0); },
    clColBands(pg, i) { return pg.bands.filter(b => b.c0 <= i && i < b.c0 + b.len); },
    // F5: a day you actually finished. Real planned minutes, all of them done — never a count of tasks, which
    // is gameable the moment anyone notices (see "nothing fake" in ui-conventions).
    _clCleared(items) {
      const mine = items.filter(it => it.kind === 'task-block');
      if (!mine.length || !mine.every(it => this.byId.get(it.id)?.completed_at)) return null;
      const mins = mine.reduce((n, it) => n + (this.byId.get(it.id)?.est_minutes || 0), 0);
      return { mins, label: mins ? this._clDur(mins) + ' of planned work, done' : 'Everything you planned, done' };
    },
    _clMin(iso) { const t = timeOf(iso, '00:00'); return (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)); },
    _dayBlocks(iso) {
      return blocksInRange(this.blocks, iso, iso, this.blockDays).map(b => {
        const sm = Math.max(0, this._clMin(b.start)), em = b.end.slice(0, 10) > iso ? 1440 : Math.min(1440, this._clMin(b.end));
        return { id: b.id, title: b.title, color: b.color, src: b.src, topPct: sm / 1440 * 100, hPct: Math.max(1.5, (em - sm) / 1440 * 100), _sm: sm, _em: em };   // src = the occurrence's OWN day (its block_days key), which is not the column it renders in once day-moved
      });
    },
    // H-states-D1: format actual_start timestamp ("2026-08-01T09:15") as "started 9:15am"
    _clFmtActualStart(ts) { if (!ts) return ''; return 'started ' + this.fmtTime(timeOf(ts)); },
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
        // outright — so concurrent peers STACK: same lane, each stepped down-right so the one under it keeps a
        // title strip, and only a genuinely later start steps a full cascade lane.
        const perMin = (this.clHourH || 60) / 60;
        let grp = [], gend = -1;
        const stack = () => { if (grp.length > 1) { const b = Math.min(...grp.map(p => p.lane)); grp.forEach((p, i) => { p.stk = [i, grp.length]; p.lane = b; }); } grp = []; };
        for (const p of cluster) {
          if (grp.length && p.sm < gend && (p.sm - grp[0].sm) * perMin < CL_TITLE_PX) grp.push(p);
          else { stack(); grp = [p]; gend = -1; }
          gend = Math.max(gend, p.em);
        }
        stack();
        // Something drawn OVER an item leaves only its top strip visible, and the time sits on the SECOND line —
        // so mark it and let the view inline the time into the title, on the one line that survives.
        for (const p of cluster) p.cov = cluster.some(q => q !== p && q.sm < p.em && q.em > p.sm
          && (q.lane > p.lane || (q.lane === p.lane && (q.stk?.[0] ?? 0) > (p.stk?.[0] ?? 0))));
        for (const p of cluster) out.push({ it: p.it, blk: p.blk, cov: p.cov, sm: p.sm, em: p.em, topPct: p.sm / 1440 * 100, hPct: (p.em - p.sm) / 1440 * 100, lane: p.lane, stk: p.stk, offPx: Math.min(p.lane, 4) * 14, tier: this._clTier(p.em - p.sm) });
        cluster = []; cend = -1;
      };
      for (const p of raw) { if (p.sm >= cend && cluster.length) flush(); cluster.push(p); cend = Math.max(cend, p.em); }
      flush(); return out;
    },
    // Cascade fills to the column's right edge (CSS `right`); a concurrent peer keeps the cascade's left edge
    // and steps down-right from it, so the one beneath always keeps a strip of its own title showing. --peek is
    // that strip: it is the item's ONLY hit area (the body is inert), which is what makes hover non-glitchy —
    // raising an item to the front can never swallow a peer's hover zone. The front item keeps its whole body.
    clEvBox(p) {
      const L = p.offPx + 1;
      if (!p.stk) return `left:${L}px;`;
      const [k, n] = p.stk, dy = k * CL_STACK_Y;
      return `left:${L + k * CL_STACK_X}px;top:calc(${p.topPct}% + ${dy}px);height:calc(${p.hPct}% - ${dy}px);`
        + `--stk:${k};--peek:${k === n - 1 ? '100%' : CL_STACK_Y + 'px'};`;
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
    clNowMin() { void this._nowTickV; const n = new Date(); return n.getHours() * 60 + n.getMinutes(); },
    clNowLabel() { return this._clHM(this.clNowMin()); },
    _clHM(m) { return `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`; },
    _clDur(m) { return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm'; },
    _clClock(iso) { return this._clHM(this._clMin(iso)); },
    // A moment has no range to state: a TIMED due date/deadline carries end === start, and so does an event
    // saved with no length. Both printed "3:00 – 3:00", which reads as a broken range rather than a moment.
    clTimeLabel(it) { if (it.allDay) return ''; const a = this._clClock(it.start);
      return it.end && this._clMin(it.end) !== this._clMin(it.start) ? a + ' – ' + this._clClock(it.end) : a; },
    // Park the anchor period under the chrome, opening at the waking hour. clientHeight is 0 on first open, and
    // _clMaxFrac needs it — retry until layout settles. One assignment; nothing to re-assert afterwards.
    _clScrollToPeriod(tries = 8) {
      const el = this.$refs.clPages; if (!el) return;
      if (!el.clientHeight) { if (tries > 0) requestAnimationFrame(() => this._clScrollToPeriod(tries - 1)); return; }
      if (!this.clHourH) this.clRecalcPages();
      // day: the whole day is on one page, so there is no waking-hours offset to scroll past. In week it is a
      // FRACTION of the period, so a zoom cannot move it.
      this._clSetPos(this._periodIdx(this._clDate()), this.clView === 'day' ? 0 : Math.min(this._clMaxFrac(), CL_WAKING_START / 24));
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
    // The heading is the title the layout CLAMPED to the bar — asked of the layout, not searched for in its
    // output. (It used to scan the rendered list for |y − barY| < 3 on a rounded pixel, with a completely
    // different fallback formula when the scan missed by 3px, so the two could name different months.)
    _clPeriodState(list) {
      const z = (list || this._periodZoneTitles()).find(t => t.atBar);
      const name = z ? z.name : this._periodLabelAt(this.clPos.idx);
      if (name !== this.clTopPeriod) this.clTopPeriod = name;   // reactive write only when it actually changes
    },
    // day/week zone titles: every block is a boundary, so each visible block's label rises into the heading
    _periodZoneTitles() {
      const rowH = this.clPeriodH(), head = this._clHeadH(), barY = this._clBarY != null ? this._clBarY : CL_BAR - 34 - 14;
      const zoneH = this._clZoneTop() - head;
      const scrollTop = (this.clPos.idx + _clFrac) * rowH, base = 0;   // _clFrac: non-reactive mirror of clPos.frac so frac mutations don't wake this x-for
      const first = Math.max(0, this.clPos.idx - 1), list = [];
      for (let idx = first; idx <= first + 2; idx++) {
        const vt = head + (idx - base) * rowH - scrollTop;
        // membership is a function of idx ONLY — frac is non-reactive here, so a frac-dependent filter would
        // leave an incoming title unmounted until the next crossing; _zoneLayout parks out-of-zone ones instead
        list.push({ name: this._periodLabelAt(idx), vt });
      }
      return this._zoneLayout(list, head, zoneH, barY);
    },
    // Pinch = ctrl/⌘+wheel, claimed in capture phase for EVERY calendar view (month-view pinch used to
    // page-zoom the browser). Accumulates past a deliberate threshold and steps the view finer or coarser.
    clZoomWheel(e) {
      if (e.cancelable) e.preventDefault();
      const t = performance.now(), fresh = !this._clZG || t - this._clZGT > CL_GESTURE_GAP;
      this._clZGT = t;
      if (fresh) this._clZG = { acc: 0, stepped: false };
      const g = this._clZG, timed = this.clView === 'day' || this.clView === 'week';
      if (timed) {
        const z = Math.min(4, +(this.clZoom - e.deltaY * 0.01).toFixed(2));
        if (z >= 1) { g.acc = 0; if (z !== this.clZoom) this._clZoomTo(z); return; }   // still inside the hour range
        if (this.clZoom > 1) { g.acc = 0; this._clZoomTo(1); return; }                  // land on fit before stepping out
      }
      g.acc += e.deltaY;
      if (g.stepped || Math.abs(g.acc) < 40) return;   // one view step per gesture, past a deliberate threshold
      const views = this.clViews(), next = views[views.indexOf(this.clView) + (g.acc > 0 ? 1 : -1)];   // spread = finer
      if (next) { g.stepped = true; this.clSetView(next); }
    },
    // Zoom changes the SCALE and nothing else — clPos already says where we are, in units a scale cannot
    // touch, and the transform is bound to the same --ph the blocks are, so both change in one flush.
    _clZoomTo(z) {
      if (!this.$refs.clPages) return;
      this.clZoom = z; this.clHourH = Math.max(18, Math.round(this._clFitHour() * z));
      this._clSetPos(this.clPos.idx, Math.min(this.clPos.frac, this._clMaxFrac()));   // a coarser scale can shrink the room to travel
    },
    // ONE travel model for every continuous input — trackpad, wheel, finger. `dy` is pixels of hand movement;
    // everything downstream is periods. A gesture moves WITHIN one period and stops at its edge; the next
    // gesture turns the page. So every hour stays reachable, you never rest straddling two periods, and a
    // flick can't carry you three days past what you were reading. Momentum keeps firing events, so a gesture
    // ends only on CL_GESTURE_GAP of real quiet.
    _clTravel(dy, fresh) {
      const ph = this.clPeriodH(), maxF = this._clMaxFrac(), EDGE = 0.002;
      if (fresh) {
        // A boundary crossing — or a period that exactly fills the viewport, where there is nowhere to travel —
        // is a PAGE TURN, and it must ANIMATE. Clamping to the neighbour instead jumped a whole viewport on the
        // first pixel of scroll: that was the teleport, at the edges in week and everywhere in day.
        const f = this.clPos.frac;
        const step = maxF < EDGE ? Math.sign(dy) : dy > 0 && f >= maxF - EDGE ? 1 : dy < 0 && f <= EDGE ? -1 : 0;
        this._clGate = { turned: !!step };
        // down → the next period's top; up → the previous period's FAR edge, so the two stay continuous
        if (step) return this._clTween(this.clPos.idx + step, step < 0 ? maxF : 0);
      }
      if (this._clGate?.turned) return;   // the rest of this gesture is momentum for a turn already made
      motion.stop('clTween');   // a hand mid-flight outranks a tween, same rule as _glide
      this._clSetPos(this.clPos.idx, Math.max(0, Math.min(maxF, this.clPos.frac + dy / ph)));
    },
    _clGestureFresh() { const t = performance.now(), fresh = !this._clGate || t - this._clGateT > CL_GESTURE_GAP; this._clGateT = t; return fresh; },
    clPagesWheel(e) {
      if (e.ctrlKey || e.metaKey) return;   // pinch belongs to clZoomWheel, which already claimed it in capture
      if ((this.clView !== 'day' && this.clView !== 'week') || !e.cancelable) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * e.currentTarget.clientHeight : e.deltaY;
      this._clTravel(dy, this._clGestureFresh());
      this._clScrolling();
    },
    // Touch. There is no scroller to pan, so the finger drives the same travel the wheel does — which also
    // means pinch-zoom and paging behave identically on both, instead of touch getting the browser's model
    // and the trackpad getting ours. Claim only once the drag is clearly vertical, or the horizontal
    // surface-swipe loses its gesture.
    clPagesTouch(e) {
      if (e.type === 'pointerdown') { motion.stop('clFling'); this._clTouch = e.pointerType === 'touch' ? { y: e.clientY, x: e.clientX, v: 0, t: performance.now(), on: false } : null; return; }
      const d = this._clTouch; if (!d) return;
      if (e.type === 'pointerup' || e.type === 'pointercancel') {
        this._clTouch = null;
        if (d.on && Math.abs(d.v) > 0.05) this._clFlingStep(d.v);   // release with speed → let it run down
        return;
      }
      const dy = d.y - e.clientY, now = performance.now();
      if (!d.on) { if (Math.abs(dy) < 6 || Math.abs(dy) <= Math.abs(e.clientX - d.x)) return; d.on = true; this._clGate = null; this._clTravel(dy, true); }
      else this._clTravel(dy, false);
      d.v = dy / Math.max(1, now - d.t); d.y = e.clientY; d.t = now;
      this._clScrolling();
    },
    _clFlingStep(v) {
      // first decay step runs SYNCHRONOUSLY (as before) so release feels immediate; the driver owns the rest
      const step = () => { v *= CL_FLING; if (Math.abs(v) < 0.02) return false; this._clTravel(v * 16, false); this._clScrolling(); return true; };
      if (step()) motion.run('clFling', step); else motion.stop('clFling');
    },
    _clScrolling() { if (!this.clScrolling) this.clScrolling = true; clearTimeout(_clScrollT); _clScrollT = setTimeout(() => { this.clScrolling = false; this._clLand(); }, motion.t(600)); },
    // Landing settles the anchor on whatever period is on top. No scrollend to wait for — we know when we stopped.
    _clLand() {
      if (this.clView !== 'day' && this.clView !== 'week') return;
      const iso = isoDate(this._periodDate(this.clPos.idx));
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
    // --- Event editor (create / edit / delete) ---
    clNewEvent(date) { this.eventEdit = { title: '', date: date || this.clAnchor, start: '09:00', end: '10:00', all_day: false, color: null }; },
    clEditEvent(id) {
      const e = this.events.find(x => x.id === id); if (!e) return;
      this.eventEdit = { id: e.id, title: e.title, date: e.starts_at.slice(0, 10), endDate: e.ends_at.slice(0, 10), start: timeOf(e.starts_at, '09:00'), end: timeOf(e.ends_at, '10:00'), all_day: !!e.all_day, color: e.color || null };
    },
    clItemClick(it) { if (!it) return; if (it.kind === 'event') return this.clEditEvent(it.id); if (this.clIsTask(it)) return this.clOpenTaskSide(it.id); if (it.start) this.clOpenDay(it.start.slice(0, 10)); },
    clToggleTask(id) { const t = this.byId.get(id); if (t) this.toggle(t); },
    clKeyActivate(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    // ONE state class for every calendar mark of a task — chip, timeline event, agenda row, chapter band,
    // due/deadline mark. A finished deadline used to read exactly like a live one.
    clTaskState(it) { const t = this.clIsTask(it) && this.byId.get(it.id); return !t ? '' : t.archived_at ? ' archived' : t.completed_at ? ' done' : ''; },
    // Full checkHtml for calendar task checkboxes — same blocked/paused/prog states as list rows.
    clCheckHtml(it, cls = 'cl-chip-check') {
      const t = this.byId.get(it.id); if (!t) return '';
      const blocked = (t.blocked_by ?? []).some(id => { const b = this.byId.get(id); return b && !b.completed_at && !b.archived_at; });
      const hp = this.hasProgress(t);
      return checkHtml({ t, pc: this.pc(t.importance), blocked, hasProgress: hp, progress: hp ? this.rowProgress(t) : 0 }, 'button', cls);
    },
    // Full checkHtml for composer subtask rows — adds archived/blocked/paused not covered by inline :class.
    entryCheckHtml(c) {
      const blocked = (c.blocked_by ?? []).some(id => { const b = this.byId.get(id); return b && !b.completed_at && !b.archived_at; });
      const hp = this.hasProgress(c);
      return checkHtml({ t: c, pc: this.pc(c.importance), blocked, hasProgress: hp, progress: hp ? this.rowProgress(c) : 0 }, 'button', 'sm');
    },
    // Full checkHtml for the composer's own check (6th site). toggleEditing is a save-draft-then-complete wrapper.
    compCheckHtml() {
      const t = this.editingTask(); if (!t) return '';
      const blocked = (t.blocked_by ?? []).some(id => { const b = this.byId.get(id); return b && !b.completed_at && !b.archived_at; });
      const hp = this.hasProgress(t);
      return checkHtml({ t, pc: this.pc(this.draft.importance), blocked, hasProgress: hp, progress: hp ? this.rowProgress(t) : 0, note: inNotes(t, this.byId) }, 'button');
    },
    clChipCls(it) {
      const st = this.clTaskState(it);
      if (it.spanStart === undefined || this.clView === 'day') return it.kind + st;   // one column ⇒ nothing to join across, so no span caps
      return it.kind + st + ' cl-span' + (it.spanStart ? ' cl-span-l' : '') + (it.spanEnd ? ' cl-span-r' : '') + (!it.spanStart && !it.spanEnd ? ' cl-span-mid' : '');
    },
    clSplitTitle(n) { const m = n.match(/^(.*?),?\s*(\d{4})$/); return m ? [m[1], ' ' + m[2]] : [n, '']; },   // trailing YEAR only — splitting on the first space mangled 'Jul 19 – Jul 25, 2026' down to 'Jul 19'
    clIsTask(it) { return it.kind === 'task-due' || it.kind === 'task-block' || it.kind === 'task-deadline'; },
    // all-day → date-only; never a backwards range; shared by event + block
    _evRange(e, date = e.date) { const end = (!e.all_day && e.end < e.start) ? e.start : e.end; return e.all_day ? { starts_at: date, ends_at: e.endDate || date } : { starts_at: date + 'T' + e.start, ends_at: date + 'T' + end }; },
    _toggleIn(arr, v) { const i = arr.indexOf(v); i < 0 ? arr.push(v) : arr.splice(i, 1); },
    async clSaveEvent() {
      const e = this.eventEdit; if (!e) return;
      const fields = { title: e.title.trim() || 'Untitled', all_day: e.all_day, color: e.color || null, ...this._evRange(e) };
      if (e.id) {
        await this._journalRowChange('Edited event', 'event', e.id, () => this.store.events.update(e.id, fields));
      } else {
        const ev = await this.store.events.add(fields);
        await this.loadEvents();
        if (ev) this._pushEntry('Added event', { kind: 'remove', target: 'event', id: ev.id, rows: this._rowsForDelete('event', ev.id) });
      }
      this.eventEdit = null;
    },
    async clDeleteEvent() { const e = this.events.find(x => x.id === this.eventEdit?.id); if (e) await this.perform('Deleted event', { target: 'event', kind: 'delete', id: e.id }); this.eventEdit = null; },

    // --- Blocks: drag a span on the week/day grid to create; click a band to edit ---
    clBlockDragStart(e, iso) {
      // A finger dragging the grid is SCROLLING the day; stealing that gesture to draw a block makes the
      // calendar feel broken. Blocks are created from the ＋ on touch. Pen still draws (it points).
      if (e.pointerType === 'touch' || e.button !== 0 || e.target.closest('.cl-event, .cl-block')) return;   // drag only on empty grid
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
    clDragStart(e, kind, id, srcIso) {
      if (!kind) return;
      this._clDnd = { kind, id, ...(kind === 'block' && srcIso ? { date: srcIso } : {}) };
      // lift the SOURCE element (the drag image is the browser's; this is the hole it left behind)
      this._clLifted = e.target?.closest?.('.cl-event, .cl-chip, .cl-block, .item');
      this._clLifted?.classList.add('cl-lift');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); }
    },
    clDragEndSchedule() { this._clDnd = null; this.clDropHint = null; this.clDropPreview = null; this._clLifted?.classList.remove('cl-lift'); this._clLifted = null; },
    // F4: what you just placed settles into its slot, so the release reads as a landing and not a repaint
    _clPlaced(id) { this.flash('clPlaced', '_clPlacedT', id, 420); },
    _dropMin(e) {   // minutes-of-day (snapped 15) when dropped inside a week/day column; null on a month cell
      const col = e.target.closest?.('.cl-pcol'); if (!col) return null;
      const r = col.getBoundingClientRect();
      return Math.max(0, Math.min(1425, Math.round((e.clientY - r.top) / r.height * 96) * 15));
    },
    _dndRow(d) { return (d.kind === 'event' ? this.events : this.blocks).find(x => x.id === d.id); },   // the row a dragged event/block came from
    // Sizes AND names the preview ghost in one read, so it lands as the thing you dragged and not just a time:
    // an event/block keeps its own length and title, a task its est_minutes and content, a due chip a marker
    // height — 60 being that marker, i.e. the one-hour default every durationless or all-day drag falls back to.
    _dragGhost() {
      const d = this._clDnd; if (!d) return { h: 60, t: '' };
      if (d.kind === 'event' || d.kind === 'block') { const it = this._dndRow(d); return { h: it && !it.all_day ? Math.max(15, (1440 + this._clMin(it.ends_at) - this._clMin(it.starts_at)) % 1440) : 60, t: it?.title || '' }; }
      const t = this.byId.get(d.id);
      return { h: d.kind === 'task' ? t?.est_minutes || 60 : 60, t: t?.content || '' };
    },
    clDropOver(e, iso) {
      if (!this._clDnd) return;
      const min = this._dropMin(e);
      this.clDropHint = null;   // timed preview and the all-day/month highlight are mutually exclusive
      this.clDropPreview = min == null ? null : { iso, min, ...this._dragGhost(), label: this._clHM(min) + (min < 720 ? ' AM' : ' PM') };   // snap readout keeps :00 — precision is the point
      edgeScrollStep(e.target?.closest?.('.cl-pages, .cl-month, .peek-body'), e.clientY);
    },
    _dndKind(kind) { return ({ 'task-deadline': 'deadline', 'event': 'event', 'task-due': 'due', 'block': 'block' })[kind] ?? 'task'; },
    async clDropOn(e, iso, allDay = false) {   // allDay: dropped into the week/day all-day row → make it all-day
      const d = this._clDnd; this._clDnd = null; this.clDropHint = null; this.clDropPreview = null;
      this._clLifted?.classList.remove('cl-lift'); this._clLifted = null;
      if (!d || !iso) return;
      this._clPlaced(d.id);
      const dm = allDay ? null : this._dropMin(e);   // null ⇒ month cell or all-day row (date only)
      const stamp = dm == null ? iso : iso + 'T' + this._fmtMin(dm);
      if (d.kind === 'task' || d.kind === 'due' || d.kind === 'deadline') {
        if (d.kind === 'task') {
          const blockBand = e.target?.closest?.('.cl-block');
          if (blockBand?.dataset?.id) {
            const block = this.blocks.find(x => x.id === blockBand.dataset.id);
            const si = await this.store.scheduleItems.add({ task_id: d.id, block_id: blockBand.dataset.id });
            this.scheduleItems = await this.store.scheduleItems.list();
            const blockTitle = block?.title || 'block';
            if (si) this.notify('Attached to ' + blockTitle, { actions: [{ label: 'Undo', fn: async () => { await this.store.scheduleItems.remove(si.id); this.scheduleItems = await this.store.scheduleItems.list(); } }] });
            else this.toast('Attached to ' + blockTitle);
            return;
          }
        }
        if (d.kind === 'deadline' || d.kind === 'due') {
          const field = d.kind === 'deadline' ? 'deadline_at' : 'recur_from';
          await this.perform('Rescheduled ' + (d.kind === 'deadline' ? 'deadline' : 'due date'), { kind: 'update', target: 'task', id: d.id, after: { [field]: stamp } });
        } else {
          // plain task drop → schedule-items only
          const existing = this._siOf(d.id);
          const si = await this.store.scheduleItems.add({ task_id: d.id, date: iso, start: dm == null ? null : this._fmtMin(dm) });
          if (si) {
            if (existing) await this.store.scheduleItems.remove(existing.id);
            await this._reloadFor('scheduleItem');
            this.notify('Rescheduled task', { actions: [{ label: 'Undo', fn: async () => {
              await this.store.scheduleItems.remove(si.id);
              if (existing) await this.store.scheduleItems.add({ task_id: d.id, date: existing.date, start: existing.start });
              await this._reloadFor('scheduleItem');
            }}]});
          } else this.toast('Rescheduled task');
        }
      } else {
        const it = this._dndRow(d); if (!it) return;
        let fields;
        if (allDay || it.all_day) {   // dropped into the all-day row, or moving an already-all-day item
          const days = it.all_day ? Math.round((new Date(it.ends_at.slice(0, 10)) - new Date(it.starts_at.slice(0, 10))) / 86400000) : 0;
          const end = new Date(iso + 'T00:00:00'); end.setDate(end.getDate() + days);   // local parse (not UTC) so the day doesn't drift
          fields = { all_day: true, starts_at: iso, ends_at: isoDate(end) };
        } else {
          const dur = Math.max(15, (1440 + this._clMin(it.ends_at) - this._clMin(it.starts_at)) % 1440);   // mod 1440: cross-midnight end < start goes positive
          const startMin = dm != null ? dm : this._clMin(it.starts_at);                     // dropped time, else keep tod
          const endMin = startMin + dur, endD = new Date(iso + 'T00:00:00'); if (endMin >= 1440) endD.setDate(endD.getDate() + 1);
          fields = { starts_at: iso + 'T' + this._fmtMin(startMin), ends_at: isoDate(endD) + 'T' + this._fmtMin(endMin % 1440) };
        }
        // Recurring block: override only this occurrence via block_days; non-recurring: update the base block.
        if (d.kind === 'block' && it.recurrence && !allDay) {
          // The override row stays keyed on the occurrence's own day and points actual_start at wherever it landed,
          // so a cross-day drop is the same one write: the source day stops resolving it, the target day gains it.
          if (!d.date) { this.notify('Drag this occurrence from the week or day view to move it'); return; }   // no source-date on record (month/agenda chip); can't tell which occurrence
          // actual_start doubles as the RECORD of when you really started. ANY drag would overwrite that record with
          // a plan (and make the tick claim a start you never made), so a started occurrence stays where it happened.
          const rec = this.clBlockDay(d.id, d.date);
          if (rec?.status === 'running' || rec?.status === 'done') { this.notify('Already started this occurrence — undo it to move it'); return; }
          // A skip answers the DAY it was given: carried to another day it would arrive pre-answered on a day the
          // user never answered. Cleared in the SAME write, so one ⌘Z restores both the day and the answer.
          await this.clSetBlockDay(d.id, { actual_start: fields.starts_at, actual_end: fields.ends_at, ...(d.date !== iso && { status: 'pending' }) }, d.date, 'Moved block occurrence');
        } else {
          await this.perform('Moved ' + d.kind, { kind: 'update', target: d.kind, id: d.id, after: fields });   // one entry per drop → ⌘Z puts it back
        }
      }
    },
    // task_id → placement ISO (the ONE date fact). Cached on _calDataV — every scheduleItems write bumps it,
    // and it is read once per row in the list pipeline, so rebuilding it per call is not free.
    _placedMap() { void this.scheduleItems; return _memo(_placedMemo, 'p|' + _calDataV, () => placedMap(this.scheduleItems), 1); },
    // THE date a task sits on. The placement is the whole answer for a plain task; recur_from is consulted ONLY
    // for a repeat, where it is the rule anchor rather than a placement.
    whenOf(t, pm = this._placedMap()) { return pm.get(t.id) || (t.recurrence ? t.recur_from : null) || ''; },
    _siOf(id) { return this.scheduleItems.find(x => !x.block_id && x.date && x.task_id === id) || null; },   // that one task's date-item
    // Persist the composer's ON register: the task's ONE date-item mirrors draft.on/dueTime. CREATE first,
    // verify, and only then drop the old one — a failed add leaves the previous placement untouched. Journalled
    // as a composite so ⌘Z puts the prior placement back; silent, since the caller already announces the save.
    async _saveSched(id, d) {
      if (d.recurrence) return;   // repeat mode: recur_from IS the rule anchor, not a placement
      const have = this._siOf(id), want = d.on ? { task_id: id, date: d.on.slice(0, 10), start: d.dueTime || null } : null;
      if ((!want && !have) || (want && have && have.date === want.date && (have.start || null) === want.start)) return;
      const row = want ? await this.store.scheduleItems.add(want) : null;
      if (want && !row) return this.toast('Could not schedule — try again');
      const ops = [];   // undo order: put the old placement back FIRST, then drop the new one (never delete-first)
      if (have) { const rows = [JSON.parse(JSON.stringify(have))]; await this.store.scheduleItems.remove(have.id); ops.push({ kind: 'reinsert', target: 'scheduleItem', id: have.id, rows }); }
      if (row) ops.push({ kind: 'remove', target: 'scheduleItem', id: row.id, rows: [row] });
      await this._reloadFor('scheduleItem');
      this._pushEntry(want ? 'Scheduled task' : 'Unscheduled task', { kind: 'composite', target: 'scheduleItem', ops }, { silent: true });
    },
    // no date at all, newest first; cap for perf
    clUnscheduled() {
      const pm = this._placedMap();
      return this.tasks.filter(t => this._openLeaf(t) && !this.whenOf(t, pm))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 50);
    },
    _clNowBounds() { const now = new Date(), today = isoDate(now); return { today, at: today + 'T' + hhmm(now) }; },
    _overdue(t, b, pm) { const w = this.whenOf(t, pm); return !!w && (timeOf(w) ? w < b.at : w.slice(0, 10) < b.today); },
    // local wall-clock, never UTC
    clReschedule() {
      void this._nowTickV;   // refresh as the clock passes each task's time
      const b = this._clNowBounds(), pm = this._placedMap();
      return this.tasks.filter(t => this._openLeaf(t) && this._overdue(t, b, pm))
        .sort((x, y) => this.whenOf(x, pm).localeCompare(this.whenOf(y, pm)));   // the moment it slipped past
    },
    clReschedListHtml() { return this._clListHtml('res', this.clReschedule(), isoDate(new Date()) + '|' + this._nowTickV); },
    clSideVisible() { return this.clSideOpen || (this.clView === 'day' && !this.narrow); },   // the panel is up in day view (auto) or when toggled — but on a phone it OVERLAYS at 86%, so auto-opening would bury the day you just opened
    _clRowsHtml(tasks) {
      const now = new Date(), byId = this.byId, def = this.store.defaultProject(), byParent = buildByParent(this.tasks), pm = this._placedMap();
      return tasks.map(t => {
        const w = this.whenOf(t, pm);   // >10 chars only when the placement carries a clock time — that's the timed chip
        return { id: t.id, html: this._itemLi(this.mkRow(t, 0, byParent, byId, def, now, undefined, pm), { drag: ' draggable="true"', schedTime: w.length > 10 ? this._clTime(w) : null }) };
      });
    },
    // x-effect re-runs on every tick — cache to avoid rebuilds on scroll
    _clListHtml(kind, tasks, sig) {
      return _memo(_clListMemo, kind + '|' + this._rowV + '|' + sig, () => this._clRowsHtml(tasks), 6);
    },
    clUnschedListHtml() { return this._clListHtml('un', this.clUnscheduled(), ''); },
    clRowClick(e) { const el = e.target.closest?.('.item'); const t = el && this.byId.get(el.dataset.id); if (t) this.onRowClick({ t }, e); },
    clSideDragStart(e) { const el = e.target.closest?.('.item'); if (el) this.clDragStart(e, 'task', el.dataset.id); },
    clOpenTaskSide(id) { const t = this.byId.get(id); if (!t) return; this.clSideOpen = true; this.$nextTick(() => this.editTask(t)); },
    clBlockWeekdays() { return [{ d: 0, l: 'S' }, { d: 1, l: 'M' }, { d: 2, l: 'T' }, { d: 3, l: 'W' }, { d: 4, l: 'T' }, { d: 5, l: 'F' }, { d: 6, l: 'S' }]; },
    clNewBlock(date, start, end) { this.blockEdit = { date: date || this.clAnchor, start: start || '09:00', end: end || '10:00', all_day: false, weekdays: [], location_id: null, areas: [], color: null, title: '', est_minutes: null }; },
    clEditBlock(id, viewIso) {
      const b = this.blocks.find(x => x.id === id); if (!b) return;
      this.blockEdit = { id: b.id, title: b.title || '', date: b.starts_at.slice(0, 10), start: timeOf(b.starts_at, '09:00'), end: timeOf(b.ends_at, '10:00'), all_day: !!b.all_day,
        weekdays: (b.recurrence?.weekdays || []).slice(), location_id: b.location_id || null, areas: (b.areas || []).slice(), color: b.color || null, est_minutes: b.est_minutes ?? null,
        viewIso: viewIso || null };
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
      const core = { title: e.title.trim(), all_day: e.all_day, recurrence, location_id: e.location_id || null, areas: e.areas, color: e.color || null, ...this._evRange(e, date) };   // est_minutes deliberately absent — see below
      // Both halves are journaled by hand rather than through perform(): the create is a two-call sequence
      // (est_minutes can't ride the insert) and must still land as ONE undo entry.
      if (e.id) await this._journalRowChange('Edited block', 'block', e.id, () => this.store.blocks.update(e.id, { ...core, est_minutes }));
      else {
        const b = await this.store.blocks.add(core);   // est_minutes is update-only until db:apply (unknown column fails the whole insert)…
        if (b && est_minutes != null) await this.store.blocks.update(b.id, { est_minutes });   // …but the create path must still WRITE it
        await this.loadBlocks();
        if (b) this._pushEntry('Added block', { kind: 'remove', target: 'block', id: b.id, rows: this._rowsForDelete('block', b.id) });
      }
      this.blockEdit = null;
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
    async clRemoveAttached(itemId) {
      const item = this.scheduleItems.find(x => x.id === itemId);
      await this.store.scheduleItems.remove(itemId);
      this.scheduleItems = await this.store.scheduleItems.list();
      if (item) this.notify('Detached task', { actions: [{ label: 'Undo', fn: async () => { await this.store.scheduleItems.add(item); this.scheduleItems = await this.store.scheduleItems.list(); } }] });
    },

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
    // A repeating block draws one instance PER DAY, so the status has to be looked up for THAT day. Defaulting
    // to today made Monday's run-state light up every Tuesday, next week and last week too — the block editor is
    // the only caller that genuinely means "today", and it's the one that omits the date.
    clBlockDay(blockId, iso) { const d = iso || isoDate(new Date()); return this.blockDays.find(x => x.block_id === blockId && x.date === d) || null; },
    async clSetBlockDay(blockId, fields, iso, label) {
      iso ||= isoDate(new Date());   // callers pass blockEdit.viewIso, which is NULL outside a calendar chip — and a default only catches undefined
      const prev = this.clBlockDay(blockId, iso);
      // ONE row carries the whole per-occurrence answer (day-move included), so there is nothing to delete first —
      // but a failed write must leave the occurrence exactly where it was: the cloud adapter THROWS on error and
      // the local one returns the row, so both a throw and a falsy row mean "nothing moved", and we say so.
      let row; try { row = await this.store.blockDays.set({ block_id: blockId, date: iso, ...fields }); } catch { row = null; }
      if (!row) return this.toast('Could not update this day — try again');
      await this._reloadFor('blockDay');   // reloads blockDays + bumps _calDataV so clBlocks() memo busts and DOM repaints
      const cur = this.clBlockDay(blockId, iso);
      if (!cur?.id) return;
      const lbl = label ?? (fields.status === 'running' ? 'Started block' : fields.status === 'skipped' ? 'Skipped block' : 'Undid block day');
      const rollback = Object.fromEntries(Object.keys(fields).map(k => [k, prev?.[k] ?? null]));
      if (Object.keys(rollback).length) this._pushEntry(lbl, { kind: 'update', target: 'blockDay', id: cur.id, after: rollback, was: fields });
    },
    // The Start/Skip panel says "today", so it may only appear for the occurrence that LIVES today — the one you
    // opened, wherever its row is keyed. A chip moved onto today counts; today's own, moved away, no longer does.
    clDayPanel(b, iso) {
      return !b ? false : !iso ? this.clBlockOccursToday(b)
        : (this.clBlockDay(b.id, iso)?.actual_start || iso).slice(0, 10) === isoDate(new Date());
    },
    // What "Reset this day" would undo: a time nudge, or a whole day-move (named, so the note isn't a lie).
    clOverrideNote(blockId, iso) {
      const a = this.clBlockDay(blockId, iso)?.actual_start;
      return !a ? '' : a.slice(0, 10) === iso ? 'Time adjusted for this day'
        : 'Moved to ' + new Date(a.slice(0, 10) + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    },
    // These three answer ONE occurrence — the one on screen (iso), not whichever of them today happens to hold.
    // Start records the real clock time on the day that occurrence now LIVES, so starting it never un-moves it.
    clStartBlock(blockId, iso) {
      const n = new Date(), day = this.clBlockDay(blockId, iso)?.actual_start?.slice(0, 10) || iso || isoDate(n);
      return this.clSetBlockDay(blockId, { status: 'running', actual_start: day + 'T' + hhmm(n) }, iso);
    },
    clSkipBlock(blockId, iso) { return this.clSetBlockDay(blockId, { status: 'skipped' }, iso); },
    // actual_end goes with it: left orphaned, it stretched a 1-hour block into a bar down to midnight.
    clUndoBlockDay(blockId, iso) { return this.clSetBlockDay(blockId, { status: 'pending', actual_start: null, actual_end: null }, iso); },
    // Lead = first incomplete during-attachment fitting capacity (mirrors the Android blockLead pick).
    clBlockLead(blockId) {
      const cap = this.blocks.find(b => b.id === blockId)?.est_minutes ?? null;
      return this.scheduleItems.filter(s => s.block_id === blockId && s.role === 'during')
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(s => this.tasks.find(t => t.id === s.task_id))
        .find(t => t && !t.completed_at && (cap == null || t.est_minutes == null || t.est_minutes <= cap)) || null;
    },

    // --- Cloud sync (Supabase adapter, opt-in via magic link). LocalStore stays the offline default. ---
    async _migratePlaceStrings() {
      // One-shot: tasks saved during the 9a5d964 campaign era kept a plain `place` string but no constraint.
      // Exact case-insensitive name match → write location:{mode:'only',ids:[id]}, clear `place` (idempotent guard).
      // Non-matching place strings are left intact (retained but unused). Data-safety: write must succeed before clearing.
      let migrated = 0;
      for (const t of this.tasks) {
        if (!t.place || (t.location?.ids ?? []).length) continue;
        const match = this.locations.find(l => l.name.toLowerCase() === t.place.toLowerCase());
        if (!match) continue;
        const ok = await this.store.tasks.update(t.id, { location: { mode: 'only', ids: [match.id] }, place: null });
        if (ok) migrated++;
        // on failure: leave place intact — worst case is a retained-but-unused string, never a lost constraint
      }
      if (migrated) await this.loadTasks();
    },

    async reloadAll() {
      if (this.store.requiresAuth && !this.session) return;   // cloud adapter: wait until signed in
      // ONE parallel round-trip set (cloud): the whole account in a single query + the two side lists
      const [b, si, bd] = await Promise.all([this.store.bootstrap(), this.store.scheduleItems.list(), this.store.blockDays.list()]);
      // ALL awaits above, ONE synchronous block below: Alpine flushes effects during an await, so a reactive
      // write followed by an awaited gap ran renders against the OLD memo keys — and the version bumps after
      // the gap are module-scope, so nothing re-woke (month chips stayed stale after an event edit).
      this._rowV++; _calDataV++; _clBlocksSig = null;   // bust memos before the reactive writes so the flush sees fresh keys
      this.areas = b.areas;
      this.tasks = b.tasks; this.byId = new Map(b.tasks.map(t => [t.id, t])); this.parentIds = new Set(b.tasks.map(t => t.parent_id).filter(Boolean));   // ← list renders (reactive) from here
      this.filters = b.filters; this.locations = b.locations;
      this.events = b.events; this.blocks = b.blocks;
      this.scheduleItems = si; this.blockDays = bd;
      this.homeLocationId = this.store.homeLocationId(); this.currentRegion = this.store.currentRegion();
      this._defId = this.store.defaultProject();
    },

    async signIn() {
      const sb = sbClient(); if (!sb) return;
      if (!this.authEmail) { this.authMsg = 'Enter your email first.'; this.authErr = true; return; }
      if (this.authPass) {
        const { error } = await sb.auth.signInWithPassword({ email: this.authEmail, password: this.authPass });
        if (error) { this.authMsg = error.message; this.authErr = true; }
        return;
      }
      // one email carries both a link and a 6-digit code (templates: pg_mail/mail/mail.js); shouldCreateUser:false blocks new-account creation
      const { error } = await sb.auth.signInWithOtp({ email: this.authEmail, options: { emailRedirectTo: location.href, shouldCreateUser: false } });
      this.authMsg = error ? error.message : 'Tap the link in the email, or enter its code below.';
      this.authErr = !!error;
      this.authSent = !error;
    },
    async setPassword() {
      const sb = sbClient(); if (!sb || !this.setPassVal) return;
      const { error } = await sb.auth.updateUser({ password: this.setPassVal });
      if (error) { this.setPassErr = error.message; return; }
      this.setPassOpen = false; this.setPassVal = ''; this.setPassErr = '';
      this.toast('Password set');
    },
    async verifyCode() {
      const sb = sbClient(); if (!sb || !this.authCode) return;
      const { error } = await sb.auth.verifyOtp({ email: this.authEmail, token: this.authCode.trim(), type: 'email' });
      if (error) { this.authMsg = error.message; this.authErr = true; }   // stay on the code form; onAuthStateChange handles success
      this.authCode = '';
    },
    // Supabase re-emits SIGNED_IN on every tab focus — only uid change or sign-out recreates the store
    async onAuth(session) {
      const prevUid = this.session?.user?.id ?? null, nextUid = session?.user?.id ?? null;
      this.session = session;
      if (nextUid === prevUid) return;
      this.store.unsubscribe?.();   // tear down the old adapter's realtime channel before swapping
      this.store = session ? createSupabaseStore(sbClient()) : createLocalStore();
      this.authSent = false; this.authEmail = ''; this.authCode = ''; this.authPass = '';
      this.setPassOpen = false; this.setPassVal = ''; this.setPassErr = '';
      await this.reloadAll();
      this._subscribeStore();       // re-arm realtime on the new store
    },
    // realtime → app: the channel names the kind that changed, and it re-reads exactly that list. Same map as
    // our own writes use, so a remote change and a local one leave the app in the same state.
    _subscribeStore() { this.store.subscribe?.(kind => this._reloadFor(kind)); },
    async signOut() { const sb = sbClient(); if (sb) await sb.auth.signOut(); },   // onAuthStateChange → onAuth(null) swaps to LocalStore

    // --- Account & settings popup (corner gear). Sign-in/phone reuse the auth machine above; surfaces + theme persist locally. ---
    settingsOpen: false,
    online: navigator.onLine,         // gear status dot + account-row sub (listeners live on the popup markup)
    theme: localStorage.getItem('adherod.theme') || 'system',
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
