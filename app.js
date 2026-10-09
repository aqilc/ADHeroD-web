// The Alpine component — every surface and interaction; the only module with import-time side effects (motion.install, design-token injection).
import DESIGN from './design.json' with { type: 'json' };

// design.json → CSS custom properties, injected before Alpine boots. styles.css declares only layout constants (--foot, --bar, --side…).
const _vars = (m) => Object.entries(m).map(([k, v]) => `--${k}:${v}`).join(';');
const _scale = (d) => [
  d.space.map((n) => `--sp-${n}:${n}px`), d.type.map((n) => `--fs-${n}:${n}px`), Object.entries(d.layout).map(([k, v]) => `--${k}:${v}px`),
  Object.entries(d.radius).map(([k, v]) => `--r${k === 'r' ? '' : '-' + k}:${v}`),
  Object.entries(d.ease).map(([k, v]) => `--ease-${k}:${v}`), Object.entries(d.motion).map(([k, v]) => `--motion-${k}:${v}ms`),
  Object.entries(d.font).map(([k, v]) => `--font-${k}:${v}`),
  Object.entries(d.priority).map(([k, v]) => `--p${k}:${v}`),
  Object.entries(d.quick).map(([k, v]) => `--q-${k}:${v}`),
].flat().join(';');
const themeVars = (family, scheme) => ({ ...DESIGN.light, ...(scheme === 'dark' ? DESIGN.dark : {}), ...DESIGN.themes[family + '-' + scheme]?.over });
const THEME_COLORS = Object.entries(DESIGN.themes).filter(([, t]) => t.family).map(([id, t]) => {
  const family = id.replace('-light', ''), light = themeVars(family, 'light'), dark = themeVars(family, 'dark');
  return { id: family, label: t.family, preview: ['bg', 'panel', 'ink', 'muted', 'accent'].map(k => `--preview-${k}:light-dark(${light[k]},${dark[k]})`).join(';') };
});
const savedColorTheme = account => [localStorage.getItem('adherod.colorTheme'), account, 'graphite'].find(id => THEME_COLORS.some(t => t.id === id));
const savedAppearance = () => ['light', 'dark'].includes(localStorage.getItem('adherod.theme')) ? localStorage.getItem('adherod.theme') : 'system';
function applyTheme(mode, family) {
  const vars = scheme => _vars(themeVars(family, scheme));
  let el = document.getElementById('design-tokens');
  if (!el) { el = document.createElement('style'); el.id = 'design-tokens'; document.head.appendChild(el); }
  el.textContent = `:root{${_scale(DESIGN)};${vars(mode === 'dark' ? 'dark' : 'light')}}` +
    (mode === 'system' ? `@media (prefers-color-scheme: dark){:root{${vars('dark')}}}` : '');
  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}
applyTheme(savedAppearance(), savedColorTheme()); // Before Alpine boots: no flash of the previous palette.

import { createLocalStore, childIndex, descendantIds, orderSlots, projectDepth, subtreeDepth, nextOccurrence, nextAcrossRules, recRules, recActive, cascades, MAX_DEPTH, pendingSweep, placedMap, overviewFields, liveRefs } from './store.js';
import { guardedFields, trashView, pruneJournal, sameRow, jRead, jWrite, jWipe, jMigrate } from './recovery.js';
import { inNotes, openBlockers } from './predicates.js';
import { anchorsFor, suggestionsFor, isRepeating, isPassed, nextAt, leadIcon, userReminders, offsetLabel } from './reminders.js';
import { parseDateText, parseRecurrence, isoDate, localStamp, nextTimeAt, addMonths, quickDate, dueBadge, windowBadge, deadlineLeft, matchTrailingToken, classifyToken, foldIntoDate, tokenizeAll, parseImportanceWords, recurrenceLabel, ordinal, impRank, IMPORTANCE, WEEKDAYS } from './nlp.js';
import { markTitle, makeFuzzy, fuzzyRank, tokenize, KEYS, qfQuery, bodyText } from './search.js';
import { calendarItems, tasksFirst, onCalendar, placeable, blocksInRange, occurrencesInRange, loggedOf, plannedOf, unended, timeOf, minutesBetween, addMinutes, sizeFromMinutes, minutesForSize, emberOdds } from './calendar.js';
import { parseICS, parsePayload, looksLikePayload, icsReplaces, importPrompt, PROMPT_EXAMPLE } from './import.js';
import { motion, EASE_OUT } from './motion.js';
motion.install();   // registry listeners must be armed before Alpine renders anything that moves
import { esc as escHtml, mdLive as mdLiveRender, mdCut, chkLive as chkLiveRender, chkParts, chkVisible, raw, dotStripHtml, rollerBoxHtml, rowBodyHtml, checkHtml, mdTitle as mdTitleFn, titleLive, areaChipHtml, areaOptHtml, keyTip } from './ui.js';
import { makeSortable, edgeScrollStep, edgeSpeed, sorting, DWELL } from './sortable.js';
import { SUPABASE, SURFACES, FILES_URL } from './config.js';
// landing surface: lists when present, else the leftmost of the trimmed set
const SURF_HOME = SURFACES.includes('lists') ? 'lists' : SURFACES[0];
import { createSupabaseStore } from './supabase-store.js';
import { loadChats, loadMessages, sendMessage, editMessage, messageStore, watchMessages, peerName, whenLabel, unread, markRead, createInvite, setName, loadFiles, uploadFile, fileBlob, fileSize } from './chat.js';

// null when unconfigured → stays on LocalStore (UMD bundle sets globalThis.supabase at init).
let _sb, _inFlight = 0;
let _filesTried = new Set(), _tasksGen = 0;   // file ids a read answered without a row (not re-read per load) · loadTasks' generation   // the client's requests not yet answered: onAuth lets them land before it reloads
const countedFetch = (...a) => { _inFlight++; return fetch(...a).finally(() => _inFlight--); };   // every signed-in read and write passes here
const sbClient = () => { if (_sb === undefined) _sb = (globalThis.supabase && SUPABASE.url) ? globalThis.supabase.createClient(SUPABASE.url, SUPABASE.anonKey, { global: { fetch: countedFetch } }) : null; return _sb; };

// Module-scope: kept outside Alpine state so render reads/writes don't loop. _calDataV busts on any task/event change.

const SURF_META = { lists: { label: 'Lists', icon: 'i-all' }, plan: { label: 'Plan', icon: 'i-cal' }, social: { label: 'Social', icon: 'i-chat' } };
const CL_HOURS = Array.from({ length: 24 }, (_, h) => h);
const CL_WAKING_START = 8;   // default waking day start (h); future: from sleep data
const CL_WAKING_END = 24;    // waking day end (h)
const DAY_NAME = new Intl.DateTimeFormat([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });   // a day cell's accessible name
const CL_EPOCH = new Date(2000, 0, 2);   // a (local) Sunday — week 0 of the virtual timeline
const CL_TOTAL_WEEKS = 5217;             // ~100 years: a fixed scroll height (no reflow) ⇒ effectively infinite
const CL_BUFFER = 10;                     // weeks rendered beyond the viewport each side (blank-free on fast flings)
const CL_HOLD_MS = 3000;                  // hold ↑/↓ this long and the step escalates from a nudge to a PERIOD
const CL_HOLD_STEP = 220;                 // ...then one period per this, so a held key travels at a readable rate
const PHONE_MQ = matchMedia('(max-width: 640px)');   // the 640px CSS block's twin; .matches reads live
const STACK_MQ = matchMedia('(max-width: 759px)');   // the stacked-dialogs CSS block's twin: two 380px dialog min-widths don't fit
const SIDE_MQ = matchMedia('(max-width: 772px)');   // the task panel (--side 412) + the narrowest phone we lay out (360): under it the panel overlays
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
const CL_AG_ROW = 52, CL_AG_FREE = 34;   // full-tier agenda row heights ("1h free" rows too) = their CSS min-heights; the page fit sums both. Rows FLOW — proportion is the rail's job
const CL_AG_GAP = 30;                     // a hole in the day big enough to be worth naming ("1h free")
const CL_WALK = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };   // a focused month day's arrows, in days
const CL_BAR = 90, CL_HEAD = 32;          // overlaid toolbar + weekday-header heights (must match --bar/--head in CSS)
const _groupMemo = new Map();   // byDay cache; busts on any task/event change
const _placedMemo = new Map();  // task_id → placement ISO; busts on _calDataV (read once per row per pass)
const _taskIdxMemo = new Map();  // _taskIdx(): children + inverse blocked_by, one pass per _rowV
const _hay = new Map();   // task id -> picker search string; rebuilding it walked every parent chain per keystroke
let _hayV = -1;   // _hay's data version (see pickerMatches)
let _hayOf = new WeakMap();   // candidate array -> { hay, low }: a memoized pool (relationCandidates) reuses its haystack per keystroke
const _seqIn = (low, f) => { let at = 0; for (let k = 0; k < f.length; k++) if (!(at = low.indexOf(f[k], at) + 1)) return false; return true; };   // f in order within low; both lowercased
const _relMemo = new Map(), _candMemo = new Map();   // _relIdx / relationCandidates, one entry each
const _clSideOut = { res: { rows: [], html: new Map() }, un: { rows: [], html: new Map() } };   // clSideRows(): each kind's last rows + their key (_rowV|day(|tick)) + id → row html; hidden, the last rows show
let _clSideV = -1;   // the _rowV the tray's cached row html holds for: _patchTask keeps it current, any other bump leaves it behind
let _clAdNxH = null;   // last written --adh (the incoming claims rail height)
const _clPgCache = new Map();   // day/week periods by index: scale-free days + bands, and their packed cols at one scale
const _clWkCache = new Map();   // month week rows by index, off the Alpine proxy (a reactive Map deep-proxies every cell)
const _nextMemo = new Map();   // repeat rule + anchor + day → the occurrence its row shows (whenShown): one step-walk per repeat per day
let _clBlocksSig = null, _clBlocksCache = [], _clWkOut = [], _clWkSig = null, _clPgSig = null;   // clBlocks() single-entry memo — a view switch/scroll settle re-fires it ~100×; returning the SAME array ref lets Alpine's x-for no-op instead of re-diffing 500+ nodes
const _clWheel = { t: -Infinity, v: Infinity, hi: 0, lo: 0, hiT: 0, n: 0 };   // wheel gesture gate (_clGestureFresh): last event time and speed, peak/floor speed, the peak's time, events since it — module scope, off the Alpine proxy
let _calDataV = 0, _clScrollT, _clFrac = 0, _clMTop = 0, _clAdD, _clAdPg, _clAdH = 0;   // last boundary offset / rail page / deadline-rail height painted   // _clFrac mirrors clPos.frac, _clMTop the month scrollTop, without Alpine reactivity
const _periodLabels = new Map();   // (view|idx) -> label; toLocaleDateString is far too slow to call per wheel event
// The week edge glide (_clEdgeGlide) ends on entering anything but a day column: leaving fires dragenter, not dragover.
const clEdgeEnd = () => { motion.stop('clEdge'); removeEventListener('dragenter', clEdgeOut, true); };
const clEdgeOut = e => e.target.closest?.('.cl-pcol') || clEdgeEnd();
// List-drag ghost: module-level — no binding reads it, so its writes trigger no Alpine effect
let _dragGhost = null, _dragBlank = null, _dragOff = null, _dragIds = null, _dragGrab = null, _dragDescs = null, _dragSubDepth = 1, _dndHeld = null, _liftTop = null;   // _liftTop: the grabbed row's top as the drag lifts its subtree · _dragIds: the dragged tasks, in shown order · _dragGrab: the grabbed row, kept in the window · _dragDescs: their descendants, out of the list until the drop (see _editShift) · _dragSubDepth: their deepest subtree's depth
// Our drag image, held under the pointer by its grab offset. The browser's own is a snapshot we can neither place
// nor test (it may carry the source's dim): a blank canvas hides it.
function dragFollow(e) {   // a move onto a new element brings only a dragenter, so both move it
  if (!_dragOff) return;
  _dragGhost.style.transform = `translate(${(e.clientX ?? 0) - _dragOff.x}px,${(e.clientY ?? 0) - _dragOff.y}px)`;
  _dragGhost.classList.toggle('compact', !!e.target?.closest?.('.peek'));
}
function dragImage(e, html, r) {   // r: the grabbed box
  if (!_dragGhost) {
    _dragGhost = document.createElement('div'); _dragGhost.className = 'drag-ghost'; _dragGhost.inert = true; document.body.appendChild(_dragGhost);   // inert: a hit on the copy at the drag origin cancels the drag
    _dragBlank = document.createElement('canvas'); _dragBlank.style.cssText = 'position:absolute;top:-9999px;width:1px;height:1px'; document.body.appendChild(_dragBlank);
    for (const type of ['dragenter', 'dragover']) document.addEventListener(type, dragFollow);
  }
  _dragGhost.innerHTML = html; _dragGhost.hidden = false;
  _dragOff = { x: (e.clientX ?? 0) - r.left, y: (e.clientY ?? 0) - r.top };
  dragFollow(e);
  e.dataTransfer.setDragImage?.(_dragBlank, 0, 0);   // absent on synthesized DataTransfer (tests)
}
const dragImageEnd = () => { _dragOff = null; if (_dragGhost) _dragGhost.hidden = true; };
const INTO_SEEN = 100;   // ms: a human reaction to the nest outline. ceiling: a release within it of the outline reorders; revisit if users report a deliberate nest landing as a reorder
let _intoAt = null, _intoSeen = null, _dropSlot = null, _ghostAt = null, _ghostGrown = false, _sortRefused = false, _dragParents = null, _dragProjs = null;   // _sortRefused: the last dragover's slot is one a sort refuses · _dragParents: the carried roots' parents · _dragProjs: their projects · _intoAt: { id, t } the row whose middle the pointer entered, and when · _intoSeen: { t, half } when the last into was earned, and the half under it · _dropSlot: the last row zone, which the ghost keeps · _ghostAt: the slot the ghost first opened at this drag · _ghostGrown: it has moved or closed since
// visibleRows() memo: O(n) tree walk called many times per render; cache on _rowV+navSel+listQ so drag/animation don't recompute per frame.
let _listHay = new Map(), _listHayV = -1;   // task id → its lowercased searchable text, per _rowV (a _rowStale bump drops only its ids): built once, not per keystroke
let _visMemo = null, _visKey = '', _doneMemo = [], _secMemo = [], _hitRank = new Map(), _qfToday = '', _qfTmr = '', _qfWk = '';   // _doneMemo: completed rows for the section below the add-task button
let _rowMap = null, _doneMap = null, _parentMap = null;   // id→row + parent→[childRows] Maps maintained alongside _visMemo for O(1) hover/rowFromEl lookup
const _areaUseMemo = new Map(), _palMemo = new Map(), _filterMemo = new Map(), _treeMemo = new Map();   // areaTier usage per _rowV · searchResults per q|_rowV · filterMatches per q|_rowV|day · tree order per _rowV
// Raw DOM refs — kept outside Alpine state so they're never proxied.
let _hoverEls = [], _hoverId = null, _fitQ = 0, _fitW = false, _dropEl = null, _kbEl = null, _selSet = new Set();
const _notifTimers = new Map();   // card id → { left, at, timer, holds }: a held card's time stays put
let _skKeys = null, _tipsSeen = new Set();   // shortcut coach: ? sheet label → its key text · labels whose tip has shown (adherod.tipsSeen)
const _skUses = new Map();   // label → mouse uses this session
let _histPop = false;               // the next popstate is _syncHist retiring the overlay history entry, not the user's back
let _modalFrom = null, _modalSel = null;   // a modal's opener + its caret (init's focus-return effect)
let _jumped = false, _editIx = 0;   // _jumped: _ensureRow moved the reader to find a row · _editIx: the last flex slot the edited row held (see editIndex)
let _addSlot = 0;   // the Add task row's height + margin, measured while shown: a new task grows from it and collapses back into it
let _kb = 0;   // the soft keyboard's height (init's keyboard()): pops sit above it
let _editPin = null, _editEnd = null;   // mirror `editing` / the collapse's target height OUTSIDE Alpine (listHtml reads both; a reactive read there would make composer open/close rebuild the list)
let _listW = -1, _fitV = 0;         // list width + the generation every row's fit is stamped with (see _fit)
const _fitMemo = new Map();         // id → { sig, lad, shed, r1, l2, ri }: this width's fit outcome, replayed onto a rebuilt <li> (see _fit)
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
const STEP_FLOOR = 160;   // a Steps row's title gives way first, down to this; then chips hide (b4c, _shed)
// WINDOWED LIST. Only the rows within WIN_MARGIN of the viewport EXIST as <li>s; the rest are two spacer
// <li>s holding their summed height, so the scrollbar stays honest — and every list-wide pass (fitRows, paintSel,
// the keyed morph, the browser's style recalc) pays for the window, not the corpus (~25k elements at 1000 rows).
// Bigger margin costs rendered rows 1:1; 600px is ~15 rows each side. The window is rebuilt only once fewer than
// WIN_KEEP px remain past an edge (see _winOf), plus WIN_RUN ms of travel ahead of a fling.
const WIN_MARGIN = 600, WIN_KEEP = 200, WIN_RUN = 120, SEC_H = 30;   // SEC_H: section-head height until one has actually been measured
let _winSt = 0, _winAt = 0, _winV = 0, _winRun = WIN_RUN, _win = new WeakMap(), _restT = 0;   // the last scroll event's scrollTop, timeStamp, velocity (px/ms), runway (ms) · the kept window per list model { s, e } · the at-rest re-grow timer
let _model = null;                    // { rows, ent:[{id,order,h,mk,d,html,r}], ix:Map(id→i), total } — the flat <li> sequence
let _doneModel = null;                // the Done list's, the same shape, memoised on completedRows()
let _chkHeld = null, _chkHeldT = 0, _chkOut = null, _chkDraftList = null;   // a checklist whose ticks show in place: app._holdChk
let _appRaw = null;   // the component unproxied (init): visibleRows rebuilds on it
// _patchRows → visibleRows: { ids, drop, sort, key, v } = rebuild ONLY these rows of the memo keyed `key` (drop: roots leaving it; sort: parents whose children moved), once _rowV is `v`
const GLIDE_ROWS = '.surface-lists :is(.rows > [data-id], .add-task-btn, .list-done-head)';   // what _glideFrom moves
const _push = new Map();   // task id → the Steps tick waiting for its re-rendered row (_stepTick)
const _arrive = new Map();   // task id → user-create stagger slot, consumed before paint; unseen rows expire
const _cele = new Map();   // task id → its running completion reward (_celebrate): its row holds its slot until it ends
// A completion's ember burst: 7 to 9 particles around the check, each its own angle, reach, size and timing
// (docs/ui/task-list.md §Completion reward). Rolled once per tick, so a re-rendered row replays the same burst.
const emberBurst = () => {
  const n = 7 + Math.floor(motion.rand() * 3);
  return '<i class="ember">' + Array.from({ length: n }, (_, i) => {
    const reach = 6 + motion.rand() * 8;   // px past the ring; the farther, the longer it flies
    return `<i style="--a:${(i + motion.rand() * .5 - .25) * 360 / n}deg;--d:${reach}px;--s:${3 + motion.rand() * 1.5}px;--t:${480 + reach * 12 + motion.rand() * 80}ms;--f:${450 + motion.rand() * 100}ms"></i>`;
  }).join('') + '</i>';
};
let _celeT = 0;   // the rewards' shared linger (_celebrate)
let _rowPatch = null, _visBP = null, _visRoots = new Set();  // _visBP: the last full walk's parent → children index · _visRoots: its scope roots
let _secKids = null;   // childIndex for this pass's section pies — one build, not one per head
// task id → its row's view data, reused across recomputes while _rowCacheKey (`_rowV|minute`) holds: a search key
// changes which rows show, not what one says. The minute: due/deadline labels read the clock.
let _rowCache = new Map(), _rowCacheKey = '';
let _rowStale = null;   // ids: loadTasks' _rowV bump changed only these rows — the cache drops them, not all
const _idIx = new WeakMap();   // list → id → item: areas/locations are replaced on write, never mutated in place
const byIdIn = list => { let m = _idIx.get(list); if (!m) _idIx.set(list, m = new Map(list.map(x => [x.id, x]))); return m; };
// Task fields the list's SHAPE reads (scope, tree, order, sections, roll-ups) — a save changing one rebuilds it
// all (done/archived/position: unless _patchTask can place it). Sort/group add their own key; a filter or search reads anything, so it never patches.
const SHAPE = 'parent_id position completed_at archived_at overview area_ids est_minutes'.split(' ');
const FILTER_RE = new RegExp(`(^|\\s)(#|@|${KEYS.join(':|')}:)|[&|!()]`, 'i');   // a query that filters, not just searches
const VIEW_KEYS = { due: ['recur_from', 'recurrence'], importance: ['importance', 'recur_from', 'recurrence'], deadline: ['deadline_at'], created: ['created_at'], alpha: ['content'], place: ['location'] };
const _hCache = new Map();            // id → measured px: an estimate is only ever used for a row that has never rendered at this width
// The pill-NLP engine runs on an ACTIVE target: { el, draft } = the editor + the draft its pills write to.
// Null = the title (the default: $refs.content → this.draft); a focused subtask row swaps in its own editor +
// sub-draft so the SAME engine drives NLP there. Off Alpine's reactive data: no binding reads it.
let _nlpFocus = null;
let _trigKey = null;   // '@'/'#' keyed down: its picker opens on that char's input event (refreshPickers)
const MAC = /Mac|iP/.test(navigator.platform);   // Ctrl isn't the mod key there: Ctrl+Y is the system yank
let _lastAdded = null;   // the task the add composer last created: ↑ in its empty title reopens it. ceiling: set once the add lands, so ↑ during a slow signed-in add does nothing; queue the open behind the save if that's reported
let _submitting = null;   // an edit save's sid: one at a time — a repeated ⌘⏎ must not re-save the still-uncleared draft. ceiling: edits only (an add owns its save:<sid> slot); move edits onto those slots when an edit press must queue behind another
let _draftFrom = null;    // the open draft was restored mid-save from this sid's: it continues that draft (see _initDraftSafety)
let _saveBase = null;     // the draft the open one's edits are relative to: a save writes only the fields that differ
let _tab = window.name ||= crypto.randomUUID();   // this tab's add-draft slot and ⌘Z entries: window.name outlives a reload and is never another tab's or frame's (a duplicate's is re-minted at boot)
let _handoff = null;     // {key, payload}: a Bin/⌘Z-reopened draft for the composer about to open (storage may have refused it)
let _jSnap = new Map();   // entry id → its JSON as stored when this tab last read or wrote it: entries change in place, so a write puts what differs
let _jEpoch = null, _jChain = Promise.resolve(), _jTs = 0;   // the last wipe this tab read; its reads and writes, one at a time; its newest entry's ts
let _jMt = 0, _jStashes = 0;   // the newest `mt` this tab stamped; page-hide keys written since its key was last cleared
const _jBus = new BroadcastChannel('adherod.journal');   // a tab that wrote tells the others to re-read
const _ahead = new Set();   // entry ids: this tab's Bin copies of deletes still running (_binAhead), hidden in its Bin until they settle
const _converting = new Set();   // task ids mid-convert to subtasks: a second convert of the same items would duplicate them
const _serialQ = new Map();   // key → its last queued run (_serial)
// Every field kind the pill engine can commit — used to rebuild a draft wholesale from an editor's DOM pills.
const PILL_KINDS = ['imp', 'dur', 'proj', 'area', 'loc', 'rec', 'deadline', 'date', 'needs', 'neededBy'];
// Journal kinds that edit an OPEN composer draft and nothing else (never the store). They step in the linear
// ⌘Z timeline only while the draft they were recorded against is the one on screen — see _jSkip.
const DRAFT_KINDS = ['convert', 'chk-multi', 'sub-multi', 'chk-item', 'checklist-item', 'held-sub', 'desc-edit'];
// A task's fields whose single edit is a Bin "small change" (+ 'date', its date-item); position, completion and checklist ticks never are.
const SMALL_FIELDS = ['content', 'importance', 'area_ids', 'deadline_at', 'checklist'];
const SMALL_CAP = 40;   // ceiling: small rows kept per day (the oldest goes), each a Bin row for 30 days — lower it once the journal nears pruneJournal's ~1000-entry re-read trigger; raise it if a day's edits fall out of the Bin
// Per-kind spec: json flag (value stored as JSON in dataset), optional num (cast raw to number), the four draft operations, and
// (single kinds) read = the field as a chip value, null when clear (mirrorPills) — all receive (self, draft, ...) so helpers like
// setDur/refreshRecurrenceDue are reachable.
const PILL_SPEC = {
  imp:      { json: 0, label: (s, v) => s.impName(v, 'Importance'), read: (s, d) => d.importance === 'none' ? null : d.importance,
              commit: (s, d, v) => { d.importance = v; }, clear: (s, d) => { d.importance = 'none'; }, snapshot: (s, d) => d.importance, restore: (s, d, x) => { d.importance = x ?? 'none'; } },
  dur:      { json: 0, num: 1, label: (s, v) => s.durFmt(v), read: (s, d) => d.durMin || null,
              commit: (s, d, v) => { d.durMin = v; }, clear: (s, d) => { d.durMin = 0; }, snapshot: (s, d) => d.durMin, restore: (s, d, x) => { d.durMin = x || 0; } },
  proj:     { json: 0, label: (s, v) => '#' + v, read: (s, d) => d.project || null,
              commit: (s, d, v) => { if (v !== d.project) d.project_id = null; d.project = v; s.projRequired = false; }, clear: (s, d) => { d.project = null; }, snapshot: (s, d) => ({ project: d.project, project_id: d.project_id }), restore: (s, d, x) => { d.project = x?.project ?? null; d.project_id = x?.project_id ?? null; } },   // a replayed chip keeps the picked (maybe nested) project's id
  area:     { json: 0, multi: 'areas', label: (s, v) => '@' + (s.areaById(v)?.name ?? v),
              commit: (s, d, v) => { if (!d.areas.includes(v)) d.areas.push(v); }, clear: (s, d, r) => { const i = d.areas.indexOf(r); if (i >= 0) d.areas.splice(i, 1); }, snapshot: (s, d) => [...d.areas], restore: (s, d, x) => { d.areas = x || []; } },
  loc:      { json: 0, label: (s, v) => '📍 ' + v,
              read: (s, d) => d.location.mode === 'any' ? null : (d.location.mode === 'except' ? 'away from ' : '') + (s.locations.find(l => l.id === d.location.ids[0])?.name ?? ''),
              commit: (s, d, v) => { const neg = /^away from /i.test(v), nm = String(v).replace(/^away from /i, ''); const l = s.locByName(nm); d.location = { mode: neg ? 'except' : 'only', ids: l ? [l.id] : [] }; }, clear: (s, d) => { d.location = { mode: 'any', ids: [] }; }, snapshot: (s, d) => ({ mode: d.location.mode, ids: [...d.location.ids] }), restore: (s, d, x) => { d.location = x ? { mode: x.mode, ids: [...x.ids] } : { mode: 'any', ids: [] }; } },
  rec:      { json: 1, label: (s, v) => s.recurrenceLabel(v), read: (s, d) => d.recurrence || null,
              commit: (s, d, v) => { d.recurrence = v; s.refreshRecurrenceDue(); }, clear: (s, d) => { d.recurrence = null; }, snapshot: (s, d) => d.recurrence ? JSON.parse(JSON.stringify(d.recurrence)) : null, restore: (s, d, x) => { d.recurrence = x || null; if (d.recurrence) s.refreshRecurrenceDue(); } },
  deadline: { json: 1, label: (s, v) => '⚑ ' + (v.only ? 'only ' : v.from ? dueBadge(v.from).label + ' – ' : '') + dueBadge(v.iso).label + (timeOf(v.iso) ? ' ' + s.fmtTime(timeOf(v.iso)) : ''),
              read: (s, d) => { if (!d.deadline_at) return null; const from = (d.available_from || '').slice(0, 10), only = !!from && from === d.deadline_at.slice(0, 10); return { iso: d.deadline_at, only, from: only ? '' : from }; },
              commit: (s, d, v) => { d.deadline_at = v.iso; if (v.only || v.from) d.available_from = v.from || v.iso.slice(0, 10); },   // only = walled both sides; from = a range ("next month")
              clear: (s, d) => { d.deadline_at = ''; }, snapshot: (s, d) => ({ deadline_at: d.deadline_at, available_from: d.available_from }), restore: (s, d, x) => { d.deadline_at = (x && typeof x === 'object' ? x.deadline_at : x) || ''; if (x && typeof x === 'object') d.available_from = x.available_from || ''; } },
  // Dependencies. Both write ONE link (the other's `blocked_by`) — "needed by" is just the inverse direction,
  // recorded from the end you're usually standing at. Applied after save, since a new task has no id yet.
  needs:    { json: 0, multi: 'needs', label: (s, v) => 'needs ' + (s.byId.get(v)?.content || ''),
              commit: (s, d, v) => { if (!d.needs.includes(v)) d.needs.push(v); }, clear: (s, d, r) => { const i = d.needs.indexOf(r); if (i >= 0) d.needs.splice(i, 1); }, snapshot: (s, d) => [...d.needs], restore: (s, d, x) => { d.needs = x || []; } },
  neededBy: { json: 0, multi: 'neededBy', label: (s, v) => 'needed by ' + (s.byId.get(v)?.content || ''),
              commit: (s, d, v) => { if (!d.neededBy.includes(v)) d.neededBy.push(v); }, clear: (s, d, r) => { const i = d.neededBy.indexOf(r); if (i >= 0) d.neededBy.splice(i, 1); }, snapshot: (s, d) => [...d.neededBy], restore: (s, d, x) => { d.neededBy = x || []; } },
  date:     { json: 1, label: (s, v) => { if (v.iso) { const b = dueBadge(v.iso); return b.label + (v.time ? ' ' + s.fmtTime(v.time) : ''); } return s.fmtTime(v.time); },
              read: (s, d) => d.on || d.dueTime ? { iso: d.on, time: d.dueTime, from: d.available_from || null } : null,
              commit: (s, d, v) => { d.on = v.iso || d.on || nextTimeAt(v.time).slice(0, 10); if (v.iso) d.available_from = v.from ?? null; if (v.time) d.dueTime = v.time; }, clear: (s, d) => { d.on = ''; d.available_from = ''; d.dueTime = ''; }, snapshot: (s, d) => ({ on: d.on, available_from: d.available_from, dueTime: d.dueTime }), restore: (s, d, x) => { d.on = x?.on || ''; d.available_from = x?.available_from || ''; d.dueTime = x?.dueTime || ''; } },
};
// Decode a pill's dataset.value back to its typed JS value (JSON-encoded kinds vs string vs number).
function pillValue(kind, raw) { const sp = PILL_SPEC[kind]; return sp.json ? JSON.parse(raw) : sp.num ? +raw : raw; }
// Every overlay, topmost first: [open?, close, dialog?]. escape() and Back (popstate) close the first open one;
// anyDialog/closeDialogs (the shared backdrop) read the dialog rows. Anything that stacks ON TOP of the overview
// (dialogs, the roller ⋯ popover) closes first; the overview only when nothing is layered above it.
const OVERLAYS = [
  [c => c.shortcutsOpen, c => c.shortcutsOpen = false, 1], [c => c.trashOpen, c => c.trashOpen = false, 1],
  [c => c.palette.open, c => c.palette.open = false, 1], [c => c.confirm, c => c.confirmNo(), 1],
  [c => c.guideOpen, c => c.guideOpen = false, 1],
  [c => c.importPreview, c => c.importPreview = null, 1],   // above the rest: it is the frontmost thing when open
  [c => c.delAsk, c => c.delAsk = null, 1], [c => c.locMgr, c => c.locMgr = false, 1],
  [c => c.filterEdit, c => c.filterEdit = null, 1],
  [c => c.eventEdit, c => c.eventEdit = null, 1], [c => c.blockEdit, c => c.blockEdit = null, 1],
  [c => c.settingsOpen, c => c.settingsOpen = false],   // corner settings popup — own light backdrop, below the dialogs
  [c => c.navPop, c => c.navPop = null], [c => c.listMenu, c => c.listMenu = null],   // Hearthsay sentence menus (add/sort)
  [c => c.navRename, c => c.navRename = null], [c => c.tpop, c => c.tpop = false],
  [c => c.endPicking, c => c.endPicking = false], [c => c.pop, c => c.pop = null],
  [c => c.selMenu, c => c.selMenu = null],   // an open edit-bar sub-menu closes before the selection itself
  [c => c.sel.length, c => c.clearSel()],    // active multi-select clears (before the lower list states)
  [c => c.overview, c => c.closeOverview()],
  [c => c.phoneThread(), c => c.chat.open = null],   // Back (the system's edge swipe) returns to the chats
  [c => c.composer.open && !c._closingComposer, c => c.closeComposer()],   // a collapsing composer is already closed
];
// Completion-relevant fields for undo/redo fx diff (_apply's task complete/move/remove).
const FX_FIELDS = (t, pos) => ({ completed_at: t.completed_at ?? null, recur_from: t.recur_from ?? null, completions: t.completions, recurrence: t.recurrence, checklist: t.checklist ?? null, ...pos && { position: t.position ?? null } });
const DONE_FIELDS = ['completed_at', 'recur_from', 'completions', 'recurrence'];   // what a completion writes (store.js advanceRecurrence)
const normalizeTaskOp = op => {
  if (!op) return op;
  if (op.kind === 'composite') { for (const child of op.ops || []) normalizeTaskOp(child); return op; }
  if (op.target !== 'task') return op;
  for (const key of ['before', 'after', 'expect', 'was', 'fields']) if (op[key]) op[key] = overviewFields(op[key]);
  if (op.rows) op.rows = op.rows.map(overviewFields);
  for (const change of op.fx?.changed || []) if (change.before) change.before = overviewFields(change.before);
  return op;
};
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
const emptyDraft = () => ({ subs: [], subMoves: {}, content: '', notes: '', importance: 'none', on: '', available_from: '', deadline_at: '', durMin: 0, dateText: '', dueTime: '', project: null, project_id: null, areas: [], goal_ids: [], checklist: [], checklist_plain: false, task_type: null, recurrence: null, location: { mode: 'any', ids: [] }, needs: [], neededBy: [], reminders: [] });
// Deep-read a reactive value WITHOUT serializing it — subscribes an effect to every nested field (what JSON.stringify
// subscribed to, minus the string it built each run). `skip` prunes one subtree that another effect owns.
const _touch = (v, skip) => { if (v && typeof v === 'object' && v !== skip) for (const k in v) _touch(v[k], skip); };
let _growGen = 0;   // _growOpen's generation ids: negative (a reactive {} would read back as a proxy), so never a live timer id
let _dlAuto = '';   // the deadline a By time pick derived: while the draft's still equals it, the date isn't the user's. Off the draft, so it never dirties one.
let _draftT = 0;   // persistDraft's debounce — module-level: a reactive handle, written by one persistDraft effect, woke the other
let _qfGone = [];   // area ids _pruneQfAreas took out of the filter: one that comes back (⌘Z, another device) rejoins it
let _wiping = false;   // resetLocalData is reloading: the page-hide flush must not write back what it just wiped
let _chkQ = null, _chkFuzzy = null, _chkTinted = false;   // ghost-find memo (query+len → id→ranges) + its uFuzzy instance; any row carries .chk-sel
const _chkHtml = new Map();   // item text → chkLive html: paintChk re-derives every row's html on each checklist change
const DESC_BLOCK = 4000;   // chars per block of a huge description (_descHtml): about a screen of it
let _liveOn = [];   // the live field's tokens showing their markers (liveReveal)
const _canon = document.createElement('template');
let _linkPress = null;   // a press on a composer link (description, title, subtask or checklist row): where it started (pointer and text), whether it moved into a selection
let _linkCard = null;   // the still press whose link card is open: its field and text point, for Edit
let _press = null;   // the mouse press under way, a tap's too: the description shows markers at its release
let _opened = null;   // the field openComposer focused: an opened task reads as a view, no markers, until a key or a press (web-14)
const _textWidth = document.createElement('canvas').getContext('2d');   // _descHtml's chars-per-line estimate
const _tpl = h => Object.assign(document.createElement('template'), { innerHTML: h }).content.firstChild;
const CHK_ROW = _tpl('<div class="entry chk"><button type="button" class="chk-rect"></button><div class="entry-txt" role="textbox" tabindex="0"></div><button type="button" class="entry-del" title="Remove"><svg class="ico"><use href="#i-trash"/></svg></button></div>');
const GRIP = '<span class="entry-grip" aria-hidden="true"><svg class="ico"><use href="#i-grip"/></svg></span>', CHK_GRIP = _tpl(GRIP);
const SUB_ROW = _tpl('<div class="entry">' + GRIP + '<span class="entry-chk"></span><div class="entry-txt sub-ce" role="textbox" tabindex="0" contenteditable="true"></div><button type="button" class="entry-kids" title="Open this task"><svg class="ico"><use href="#i-chev-r"/></svg></button><button type="button" class="entry-del" title="Remove"><svg class="ico"><use href="#i-trash"/></svg></button></div>');
const QF_DUE = { today: { verb: 'due', label: 'today', col: 'var(--q-today)' }, overdue: { verb: '', label: 'overdue', col: 'var(--p1)' }, has: { verb: 'that', label: 'has a date', col: 'var(--accent)' }, none: { verb: 'with', label: 'no date', col: 'var(--faint)' } };

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

const buildByParent = (tasks, sort = true) => {
  const m = new Map(); for (const t of tasks) { const a = m.get(t.parent_id); a ? a.push(t) : m.set(t.parent_id, [t]); }
  if (sort) for (const a of m.values()) a.sort((x, y) => (x.position ?? 0) - (y.position ?? 0)); return m;
};
const subLast = (a, b) => (a.overview ? 1 : 0) - (b.overview ? 1 : 0);   // a project view's order: its own rows, then its subprojects

// Alpine rejects x-transition promises with { isFromCancelledTransition: true } on interrupt (toast/undo routinely cut short) — swallow to keep the no-console-errors contract.
window.addEventListener('unhandledrejection', e => { if (e.reason?.isFromCancelledTransition) e.preventDefault(); });

// ── Alpine component: state + every surface (to end of file) ──
document.addEventListener('alpine:init', () => {
  // x-text as Alpine's, minus the rewrite of an unchanged value: a binding reading the rows (the empty copy, the Done
  // count) re-runs on every tick, and replacing even a hidden text node cost the tick ~1.1 est-ms of its ~5 at 1k.
  // ceiling: replaces Alpine 3.15.12's x-text — re-diff it on an Alpine upgrade.
  Alpine.directive('text', (el, { expression }, { effect, evaluateLater }) => {
    const get = evaluateLater(expression);
    effect(() => get(v => { const text = v == null ? '' : String(v); if (el.textContent !== text) Alpine.mutateDom(() => { el.textContent = text; }); }));
  });
  // ceiling: patches Alpine 3.15.12's x-show internals — revisit on an Alpine upgrade. Untransitioned, it showed a frame
  // late and its deferred hide applied the newest hide, so close → open → close in one frame stayed up. A show lands now
  // and drops the pending hide; hides keep their frame (a transitioned parent's leave still waits for its children).
  // Cost: Alpine deferred show for click-away (`clickAwayCompatibleShow`) — an x-show + @click.outside pop whose trigger
  // sits outside it now closes on its opening click; none today (our pops contain their trigger or use x-transition/x-if).
  const toggle = Element.prototype._x_toggleAndCascadeWithTransitions;
  Element.prototype._x_toggleAndCascadeWithTransitions = function (el, value, show, hide) {
    if (!value || el._x_transition) return toggle.call(this, el, value, show, hide);
    delete el._x_hidePromise;
    show();
  };
  Alpine.data('adherod', () => ({
    store: createLocalStore(),
    session: null,
    authEmail: '', authCode: '', authSent: false, authMsg: '', authErr: false, authPass: '',   // inline sign-in (settings popup)
    setPassOpen: false, setPassVal: '', setPassErr: '',   // signed-in set-password affordance
    setNameOpen: false, setNameVal: '',   // …and the name friends see (chat.js › setName)
    tasks: [],
    byId: new Map(),        // id → task, rebuilt in loadTasks → O(1) lookups (projName/blocked) instead of tasks.find
    parentIds: new Set(),   // ids that have children, rebuilt with byId — hasChildren was O(n) per call and rode every flush via the Now getters (stage-4 profile: 12,800 calls = 2.1s of a 2.2s save)
    areas: [],
    notifs: [],   // bottom-right notification stack: [{ id, msg, actions:[{label, fn}], leaving }]
    journal: [], cursor: 0, _jV: 0,   // inverse-op recovery engine (⌘Z/⌘⇧Z drive undo()/redo())
    draftRestored: false,   // an unsaved composer draft was recovered on open → show the restore banner
    _draftBase: '',         // pristine draft serialization at open — dirty = current !== this; drives persist/keep-on-close
    trashOpen: false,   // "Recently deleted" popup (keybound like ?) — trashItems() reads the journal, reactive on _jV
    trashSmallOpen: {},   // day key → its small-changes row is shown open
    chkOpen: new Set(),     // task ids whose collapsed "…N more" done checklist items are expanded in the list
    filters: [],            // saved filters (sidebar), loaded from store
    filterEdit: null,       // filter being edited in the modal: {id?, name, query, color}; null = closed
    locations: [],          // all locations, loaded from store
    pendingRegions: [],     // region names created in the manager but not yet holding a location (string model has no empty regions)
    dragLocId: null,        // location being dragged between region headers
    dragOverRegion: null,   // region currently hovered as a drop target
    events: [],             // calendar events, loaded from store
    blocks: [],             // condition-bearing blocks (environment per span), loaded from store
    scheduleItems: [],
    reminders: [],           // user-authored reminder rows; [] before db:apply carries the user columns      // task↔block attachments; [] before migration is applied
    blockDays: [],          // block_day answer rows (start/skip/undo written here and on Android)
    dayNotes: [],           // named days (B·V3): { date, label }
    clView: 'month',        // calendar view: day | week | month
    clSideOpen: false, clDropHint: null,   // Plan side-panel (scheduled + unscheduled + composer) toggle; 'peek-ad' while a drag hovers the Peek all-day strip
    peekPin: false, peekIso: '', peekEdgeHot: null, peekMonHot: '',   // Peek Pane (C2): drag-summoned docked day column on Lists; pin keeps it for batch planning; edge-dwell paging + month-dwell state
    clDropPreview: null,   // { iso, min, h, label } — live ghost of where a drag will land in a week/day column
    clAnchor: isoDate(new Date()),   // calendar anchor date (YYYY-MM-DD); drives the visible period
    clRowH: 0,              // month week-row height in px = (viewport − bar − header) / 6 (macOS: 6 weeks fill the page)
    _clStale: false,        // resized while Plan was hidden: showing Plan re-measures once (_clResized)
    clVisStart: 0,          // index of the first virtualized week row currently rendered
    clDayFocus: null,       // the month's one Tab stop: the day the arrows last walked to (null: today)
    clDayInView: null,      // the Tab stop while clDayFocus/today is scrolled out of the rendered rows: the first day in view
    clVisCount: 0,          // number of week rows rendered (visible + buffer); the rest is empty spacer
    clTopMonth: '',         // scroll-driven month label for the toolbar period (month view)
    clScrolling: false,     // scroll in progress → month band/title text visible; it holds until the scroll STOPS
    clFast: false,          // …moving fast enough to lift the out-of-month dim, which returns EARLIER, at a crawl
    _clMRest: true,         // month scroll at rest until a sample says otherwise (clFast = !_clMRest)
    narrow: PHONE_MQ.matches,   // phone width — reactive twin of the 640px CSS block (a getter wouldn't re-render on resize)
    stacked: STACK_MQ.matches,  // dialogs share one cell, the covered one inert — reactive twin of the 759px CSS block
    clSideOver: SIDE_MQ.matches,   // the task panel overlays the calendar instead of squeezing it, and day view doesn't open it by itself
    clVT: false,            // a view transition is capturing — see .calendar.vt (view-transition-name is layer-promoting, so it may not linger)
    clSettling: false, clPlaced: null,   // E3 arrival stagger · E4/F4 the block that just landed springs into place
    clPVisStart: 0, clPVisCount: 3,   // virtualization window over the continuous day/week timeline
    // WHERE YOU ARE, and the ONLY thing that says so. { idx: absolute period, frac: 0..1 into it }. Nothing is
    // ever read back out of the DOM to find the position — a pixel offset changes meaning the instant
    // clPeriodH does, so anything that stored one had to be corrected after every zoom/resize/view-switch, and
    // every one of those corrections was a race. Held in period-space, a zoom is just a repaint.
    clPos: { idx: 0, frac: 0 },
    clTopPeriod: '',        // scroll-driven day/week heading (mirrors clTopMonth)
    clFocusYM: null,        // dominant month at center — others dim when idle
    clDimYM: null,          // clFocusYM as the dim reads it, held while clFast: nothing dims then, so a boundary mid-fling rewrites no cell
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
    surfaceOrder: SURFACES, surface: SURF_HOME,   // config.js owns the shipped set
    chat: { chats: [], open: null, msgs: [], draft: '', watch: null, editing: null, stash: '', name: '', pending: [] },   // stash: the draft an edit set aside; pending: files on their way up
    attach: [],   // files on their way to a task: a new draft's ({ sid }) until it saves, then bound ({ taskId })
    files: {},   // attachments rows by id, chat's and task chips' both; a sign-in change reloads the page, so it's this account's
    filesUrl: FILES_URL,
    visited: { [SURF_HOME]: true },   // lazy-mount memory — heavy surfaces (Plan) mount on first visit, stay mounted
    _nowTickV: 0, _nowDay: isoDate(new Date()),   // _nowDay: the reactive "today" — busts list + calendar memos on midnight rollover
    drag: { active: false, x0: 0, y0: 0, w: 0, t0: 0, id: null, axis: null },
    dragDx: 0,
    dragging: false,
    kbd: false,   // the last input was a key: keyboard paths cut instead of animating (ui-build G9); a pointer or wheel clears it
    overview: false,
    ovSel: 0,
    ovArchOpen: false,   // Overview's Archived row: shut until opened, as left after that
    rollerSel: 0,
    navPopXY: null,                   // escapes overflow clip
    collapsed: {},
    draft: emptyDraft(),
    subDraft: emptyDraft(),           // scratch draft the focused subtask editor's pills write to (rebuilt from that row's DOM on focus)
    composer: { open: false },
    importPreview: null,              // { kind:'ics'|'tasks', name, items, problems, busy } — the ONE import surface
    fileDrag: false,                  // a file is over the window (page-wide .ics drop)
    guideOpen: false,                 // bulk-add format + copyable assistant prompt
    palette: { open: false, q: '', sel: 0 },
    mod: MAC ? '⌘' : 'Ctrl',   // the platform's command key, for keycaps (shortcuts sheet, finder footer)
    listQ: '',          // the list search's in-place filter
    sticky: !!window.desktopSticky,   // the Windows sticky note's window (desktop/sticky.js): this page, skinned
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
    shortcutTips: localStorage.getItem('adherod.shortcutTips') !== '0',   // Settings → Shortcut tips; off = no coach tips
    nowBreathe: localStorage.getItem('adherod.nowBreathe') !== '0',       // Settings → Breathing now line; off = a still knob
    celebrations: localStorage.getItem('adherod.celebrations') || 'full',   // Settings → Celebrations: full | calm | off (_celebrate)
    _celeV: 0,   // bumped as a reward ends: its held row may leave (a visibleRows dep, not its key: the exit's patch keeps the key)
    _foldV: 0,   // bumped by a collapse toggle: which rows show changes, no row's build does (visibleRows key, not _rowV)
    grown: false,
    clip: false,
    growH: null,        // null = auto; pre-set to avoid auto-height flash on first render
    startH: 0,          // drives crossfade overlap
    blockH: 0,
    subGhost: '',
    chkGhost: '',
    focusId: null,      // keyboard-focused list row (j/k/↑↓); Enter/e opens it, x completes it
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
    areaDefault: 'var(--muted)',
    areaIcons: ['i-tag-tag','i-tag-home','i-tag-briefcase','i-tag-star','i-tag-heart','i-tag-book','i-tag-cart','i-tag-dollar','i-tag-code','i-tag-dumbbell','i-tag-plane','i-tag-bell','i-tag-flame','i-tag-leaf','i-tag-music','i-tag-map','i-tag-zap','i-tag-globe','i-tag-camera','i-tag-gift'],
    // Task-list drag state
    taskDropHint: null,
    _dragX0: 0,
    _loadFailed: false,          // the last reloadAll missed a part: the minute tick retries it
    _loadGen: 0,                 // bumped per reloadAll: an older pull landing late must not repaint

    // LocalStore needs no auth; cloud adopts the existing session before loading.
    async init() {
      _appRaw = window.Alpine.raw(this.$el._x_dataStack[0]);
      const loaded = this._jQueue(() => this._journalLoad());   // before any await: a boot-window write queues behind it
      this._serial('journal', () => loaded);   // a ⌘Z pressed before the read lands steps once it has, never into an empty journal
      // Flush debounced writes synchronously before page closes — no data lost between keystrokes/actions.
      const flushAll = () => { if (_wiping) return; clearTimeout(_draftT); this._flushDraftNow(); this._journalStash(); };
      window.addEventListener('pagehide', flushAll);
      _jBus.onmessage = () => this._jQueue(() => this._journalSync());   // another tab's entries: its deletes show in this Bin
      // While any overlay is open the app owns ONE history entry, so a phone's/browser's Back closes the topmost
      // (escape()) instead of leaving the page (O1, D6); none open → no entry, so a real Back still leaves. Back while
      // typing in the composer only drops the keyboard (read a long task). A shortcut only — iOS has no back, so
      // ×/Cancel/Escape stay the way out (ui-ios-portable).
      Alpine.effect(() => this._syncHist());
      // Focus goes back to a modal's opener on close — unless the close itself moved focus on (palette → a task).
      Alpine.effect(() => {
        const open = this.modalOpen();
        if (open && !_modalFrom) { _modalFrom = document.activeElement; _modalSel = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null; }
        else if (!open && _modalFrom) queueMicrotask(() => {   // after Alpine lifts the inert
          const at = document.activeElement;
          const from = _modalFrom, r = _modalSel, placed = from.contains(getSelection().anchorNode);   // the close's own insert put a caret in the opener: keep it
          if (at === document.body || at?.closest('.dialog-backdrop, .settings')) {
            // the page itself (body can't take focus) or a collapsed opener (out of the Tab order): keys go to the page's
            // shortcuts — a closed dialog's hidden field kept them until the next frame (Shift+↓ right after ⌘K Escape was lost)
            if (from !== document.body && !from.matches('[tabindex="-1"]')) from.focus();
            if (document.activeElement === at) at.blur();   // …as from an opener the pick slid off-screen (inert: the list search under ⌘K → Plan)
            else if (r && from.isContentEditable && !placed) getSelection().setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);   // .focus() alone puts a contenteditable's caret at its start
          }
          _modalFrom = null;
        });
      });
      window.addEventListener('popstate', () => {
        const ed = document.activeElement, top = !_histPop && OVERLAYS.some(([open]) => open(this));
        _histPop = false;   // our own close retiring the entry (a quick re-open may have beaten it here)
        if (top) !this.anyDialog() && this.composer.open && this.$refs.composer.contains(ed) ? ed.blur() : this.escape();   // a dialog the composer opened keeps the composer's focused button
        this._syncHist();
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
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
      try { this.collapsed = JSON.parse(localStorage.getItem('adherod.nav.collapsed') || '{}'); } catch { this.collapsed = {}; }
      this.showCompleted = localStorage.getItem('adherod.list.showCompleted') === '1';   // persists the view setting across sessions
      try { Object.assign(this, JSON.parse(localStorage.getItem('adherod.list.view') || '{}')); } catch {}   // restore sort + quick-filters
      if (this.sticky) Object.assign(this, { sortBy: 'due', sortDir: 'asc', groupBy: 'none', qfImp: [], qfAreas: [], qfDue: null, qfArchived: false, showCompleted: false });   // its own view, never saved
      try { _tipsSeen = new Set(JSON.parse(localStorage.getItem('adherod.tipsSeen') || '[]')); } catch {}
      // Shortcut coach: a MOUSE click on a control a key also does (data-sk = its ? sheet label). Capture, so a
      // @click.stop can't hide it; a keyboard-activated click has pointerType '' and a tap 'touch' — neither counts.
      // Composer/palette open: onKey runs no single keys and holds ⌘Z there, so the tip would teach a dead key.
      document.addEventListener('click', e => {
        if (this.shortcutTips && e.pointerType === 'mouse' && !this.composer.open && !this.palette.open) this._coach(e.target.closest?.('[data-sk]')?.dataset);
      }, true);
      this.qfImp.sort((a, b) => impRank(a) - impRank(b));   // ceiling: re-sorts views saved before toggleQfImp sorted at write, every boot; drop when adherod.list.view next migrates
      const sb = sbClient();
      if (sb) {
        const { data } = await sb.auth.getSession();
        if (data.session) { this.session = data.session; this.store = createSupabaseStore(sb); }
        sb.auth.onAuthStateChange((e, session) => { if (e !== 'INITIAL_SESSION') this.onAuth(session); });
      }
      // An invite link (?invite=<id>) waits in storage for a signed-in boot: signing in reloads, or arrives by a mail link without it.
      const invite = new URLSearchParams(location.search).get('invite');
      if (/^[0-9a-f-]{36}$/i.test(invite ?? '')) localStorage.setItem('adherod.invite', invite);
      if (invite != null) history.replaceState(history.state, '', location.pathname);
      if (localStorage.getItem('adherod.invite')) this.redeemInvite();
      // A tab holds its lock until it closes. A closed tab's add draft (or one from before slots had a tab): this account's
      // newest comes back in this tab's add composer if it has none, the rest go to their account's Bin.
      const held = async () => (await navigator.locks.query()).held.some(l => l.name === _tab);
      // a duplicated tab inherits window.name and finds its lock held; a reloaded one's is gone by the recheck
      if (await held() && await new Promise(r => setTimeout(r, 300)).then(held)) { _tab = window.name = crypto.randomUUID(); this.cursor = this._jCursor(); }
      navigator.locks.request(_tab, () => new Promise(() => {}));
      const locks = await navigator.locks.query(), live = new Set([...locks.held, ...locks.pending].map(l => l.name));
      const pend = this._pendingMap(), mine = this._newKey(), acctOf = k => k.split('@')[0].slice(4) || null;
      const dead = Object.keys(pend).filter(k => /^new(:|@|$)/.test(k) && k !== mine && !live.has(k.split('@')[1]));
      const heir = pend[mine] ? null : dead.filter(k => [null, this._acct()].includes(acctOf(k))).sort((a, b) => (pend[b].ts || 0) - (pend[a].ts || 0))[0];
      if (heir) { pend[mine] = pend[heir]; delete pend[heir]; this._writePending(pend); }
      // An add the page died in may have landed server-side: never resubmitted — its draft goes to its account's Bin.
      // ceiling: another tab's in-flight add is binned too (a duplicate if it lands); slot by tab if two tabs add at once
      for (const [k, p] of Object.entries(this._pendingMap())) if (k.startsWith('save:')) await this._binSave(k, p); else if (dead.includes(k)) await this._binSave(k, { ...p, acct: acctOf(k) }, true);
      await this.reloadAll();
      await this._migratePlaceStrings();
      if (this.sticky) { this.startAdd(); this.$watch('draft.content', q => this.listQ = q || ''); }   // the title adds AND filters: its text, never its pills
      this._subscribeStore();     // activate realtime sync (no-op on LocalStore/tests)
      this._migrateNotes();       // not awaited: its per-row writes never hold up live sync
      setInterval(() => { this._nowTickV++; const d = isoDate(new Date()); if (d !== this._nowDay) this._nowDay = d; if (this._loadFailed) this.reloadAll(); }, 60000);   // keeps the Now-window's now-line/leave-by honest; _nowDay busts visibleRows on midnight
      if (window.desktopWindow) addEventListener('storage', e => {   // the sticky and composer windows follow the app window's theme live: its write reaches them as this event
        if (e.key === 'adherod.theme' || e.key === 'adherod.colorTheme') { this.colorTheme = savedColorTheme(this.store.theme()); this.setTheme(savedAppearance()); }
      });
      if (window.desktopWindow && !this.sticky && !window.desktopComposer) {   // the Windows app's main window (desktop/main.cpp); its overlay.js checks for updates
        this.desk = await desktopWindow('desk');
        const checkUpdate = async () => { this.updateUrl = await desktopUpdate(); };
        checkUpdate();
        setInterval(checkUpdate, 6 * 3600e3);
      }
      document.addEventListener('selectionchange', () => this._chkSelTint());   // checklist cross-row selection tint
      // An IME owns its keys mid-composition (its Enter converts): no handler may act on them — a title Enter saved the unconverted word.
      document.addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) e.stopImmediatePropagation(); }, true);
      // A paste event can't name the shortcut that fired it — remember ⌘/Ctrl+Shift+V here so chkPaste can honour it.
      document.addEventListener('keydown', () => { _opened = null; }, true);
      document.addEventListener('keydown', e => { this._rawPaste = (e.metaKey || e.ctrlKey) && e.shiftKey && /^v$/i.test(e.key); }, true);   // any other key clears it
      // Decorate on blur; raw text while editing. Pointer focus alone must not interrupt drag selection.
      // chk handlers use item.text (authoritative) not el.textContent (potentially stale on reused elements).
      // focus and blur walk identically — the description hands off to its own handler, a checklist row repaints from the authoritative item.text.
      const decorate = (ev, desc, paint) => document.addEventListener(ev, (e) => {
        const el = e.target;
        if (el === this.$refs.desc) return desc(el);
        if (!el.matches?.('.composer-entries .entry.chk:not(.ghost) .entry-txt')) return;
        const item = this._chkItem(el); if (item) paint(el, item, e);
      }, true);
      // A huge description's blocks (_descHtml) draw markdown near the screen and go back to plain text off it.
      // ceiling: a block reached by a long jump (or on screen at blur) shows plain text for a frame, and Tab skips the Copy of
      // a code block not yet drawn; render ahead if either is noticed.
      this.$refs.desc?.addEventListener('contentvisibilityautostatechange', e => {
        const block = e.target, ends = this._selOffsets(block);
        if (e.skipped === !block.firstElementChild || ends && e.skipped) return;   // already plain / already drawn; the selection's stays as it is
        block.innerHTML = this._blockHtml(block, e.skipped);
        if (ends) this._setSel(block, ends);
      }, true);
      // A press on a link shows its card at release (4C): focus would put the caret there, revealing its markers under the pointer.
      // Past 4px it selects from where it started instead; touch keeps its native long-press selection.
      document.addEventListener('mousedown', e => {
        const el = e.target.closest?.('.composer a.dm-link')?.closest('.desc, .content, .sub-ce, .entry-txt');
        _press = e; _opened = null;
        _linkPress = el && { el, x: e.clientX, y: e.clientY, from: document.caretPositionFromPoint(e.clientX, e.clientY), moved: false };
        if (el) e.preventDefault();
      }, true);
      document.addEventListener('click', e => { const a = _linkPress && !_linkPress.moved && e.target.closest('a.dm-link'); if (a) { e.preventDefault(); _linkCard = _linkPress; this.linkUrl = a.href; this.togglePop('link', a); } });
      document.addEventListener('mouseup', () => { _press = null; this._pastMarks(); this.liveReveal(); }, true);
      document.addEventListener('selectionchange', () => this.liveReveal());
      document.addEventListener('mousemove', e => {
        if (!_linkPress || !(e.buttons & 1) || !_linkPress.moved && Math.hypot(e.clientX - _linkPress.x, e.clientY - _linkPress.y) < 4) return;
        const from = _linkPress.from, to = document.caretPositionFromPoint(e.clientX, e.clientY);   // from: a scroll mid-drag keeps the start
        if (!from || !to) return;
        if (!_linkPress.moved) _linkPress.el.focus({ preventScroll: true });
        _linkPress.moved = true;
        getSelection().setBaseAndExtent(from.offsetNode, from.offset, to.offsetNode, to.offset);
      });
      decorate('focus', el => this.onDescFocus(el), (el, item) => { this._chkBefore = item.text; this.chkFocus(el); });
      decorate('blur', el => this.onDescBlur(el), (el, item, e) => {
        if (!el.contains(e.relatedTarget)) el.innerHTML = el._h = this.chkHl(item);   // don't remove a copy button receiving focus
        el.contentEditable = 'false'; this.renameChecklistItem(item, el.textContent);
      });
      STACK_MQ.addEventListener('change', (e) => { this.stacked = e.matches; });
      SIDE_MQ.addEventListener('change', (e) => { this.clSideOver = e.matches; });
      // The soft keyboard's height (0 when down), from what the visual viewport lost: a phone docks the composer's chips + Save on it.
      const root = document.documentElement, keyboard = () => { const h = _kb = Math.max(0, Math.round(innerHeight - visualViewport.offsetTop - visualViewport.height));
        root.style.setProperty('--kb', h + 'px'); root.classList.toggle('kb', h > 0); };
      new ResizeObserver(([e]) => root.style.setProperty('--dock', e.borderBoxSize[0].blockSize + 'px')).observe(this.$refs.composer.querySelector('.composer-dock'));
      visualViewport.addEventListener('resize', keyboard);
      visualViewport.addEventListener('scroll', keyboard);
      // Phone width is a real mode, not just a stylesheet: week view is dropped and the calendar's view
      // switcher moves into the dot strip, so the flag has to be reactive and the current view legal.
      PHONE_MQ.addEventListener('change', (e) => {
        this.narrow = e.matches;
        if (e.matches && this.clView === 'week') { const hour = this._clHour(); this.clSetView('day', true); this._clWeekDropped = hour; }   // instant: a morph snapshot can't follow a live resize
        else if (!e.matches && this._clWeekDropped != null) this.clSetView('week', true, this._clWeekDropped);   // the width took week, the width gives it back, at the hour it took
      });
      this.$nextTick(() => {
        const list = document.querySelector('.list');
        // contentRect is HANDED to us — the width that invalidates every row's fit costs no layout read here.
        // Width 0 is the list hidden, not a new width: refitting every row on the way back cost ~390 layout reads.
        // On Plan it doesn't fire: content-visibility skips Lists' layout, so a resize there refits once, on return.
        // A grow/collapse (`clip`) resizes it every frame; the composer re-windows at the motion's ends instead.
        if (list) new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (!w || this.clip && w === _listW) return;
          // The first delivery is the boot width: boot's rows were measured and fitted at it; only never-rendered rows re-estimate.
          if (_listW < 0) { _listW = w; this._reEstimate(); }
          else if (w !== _listW) {
            // Re-estimating at the new width rebuilds the window, so the row on top would leave the DOM: hold it, at its offset.
            const sc = this._listScroller(), at = sc.getBoundingClientRect().top, row = [...document.querySelectorAll('.surface-lists .rows > .item')].find(el => el.getBoundingClientRect().bottom > at);
            const off = row?.getBoundingClientRect().top - at;
            _listW = w; _fitV++; _fitMemo.clear(); _hCache.clear(); this._reEstimate(); this._fitControls();
            if (row) {
              let el = null;
              for (let i = 0; i < 2 && !el; i++) { sc.scrollTop = this._modelTop(row.dataset.id) - off; this._paintRows(); el = this._rowEl(row.dataset.id); }   // a 2nd pass: the old spacers' height clamped the 1st
              if (el) sc.scrollTop += el.getBoundingClientRect().top - at - off;   // the model's estimates above it → the rendered heights
            }
          }
          this._reflow(); }).observe(list);
        // The list is WINDOWED: scrolling is what brings rows into existence, so the scroll listener is the
        // render loop, not just a re-fit. 150ms at REST re-grows the window to a whole margin: a jump (PageDown, a
        // scrollbar click) is painted before we re-window, onto rows already built — and the kept one may be WIN_KEEP.
        // Not `scrollend` (a per-frame programmatic scroll fires it every frame); a long frame mid-fling has moved on.
        const app = document.querySelector('.app');
        // Speed = travel over the scroll EVENTS' timeStamps, however far apart: a slow phone's every frame is >150ms, and
        // zeroing past that stopped the runway growing ahead (T22). A jump after a pause divides by the pause. Budget: O(1) per event.
        // Mid-motion the runway is the last frame's length when that beats WIN_RUN: the next frame is as slow as the last, so a
        // 1s frame at 1px/ms must reach 1000px ahead, not 120 (scroll.e2e "fling", red under load). From rest (_winV 0) it stays WIN_RUN.
        if (app) app.addEventListener('scroll', e => { const st = app.scrollTop, dt = e.timeStamp - _winAt; _winRun = _winV ? Math.max(WIN_RUN, dt) : WIN_RUN; _winV = (st - _winSt) / Math.max(1, dt); _winSt = st; _winAt = e.timeStamp;
          this._reflow(); clearTimeout(_restT); _restT = setTimeout(() => { if (app.scrollTop === _winSt) { _win = new WeakMap(); _winV = 0; this._reflow(); } }, 150); }, { passive: true });
        document.fonts.ready.then(() => { _fitV++; _fitMemo.clear(); this._fitControls(); this._reflow(); });   // font-display: swap — a boot pass may have measured (and cached) fallback widths
      });
    },
    // rAF-throttle, shared by both passes: a fling fires scroll far faster than a frame — undebounced, each
    // call forces a layout. The slot REMEMBERS a
    // re-window asked for while a fit-only frame was queued: dropping it left the rows a scroll landing in that
    // frame had asked for unbuilt until the next scroll — a blank viewport if there was none (B5).
    fitRows(win) { _fitW ||= !!win; if (_fitQ) return; _fitQ = requestAnimationFrame(() => { try { if (_fitW) { _fitW = false; this._paintRows(); } } finally { _fitQ = 0; } this._fit(); }); },   // _fitQ held through the paint: its morph's fit is this frame's; a throw must not wedge it
    // Scroll/resize: re-window the DOM FIRST (rows only exist because we scrolled to them), then fit what
    // is now in it. One rAF for both — the fit has to read the rows the re-window just created.
    _reflow() { this.fitRows(true); },
    // Things-style: title squeezed by areas → icons only; still squeezed → roll extras into "+N".
    // Windowing makes this pass viewport-sized by construction: every .item in the DOM is within one margin
    // of the fold. Scoped to .surface-lists: Plan-surface lists are hidden (~37ms/pass of 0-rect hits).
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
      // A row the window dropped and rebuilt at the same width REPLAYS its fit: the outcome is cached by id and
      // checked against its markup (`_sig`), so scrolling back over rows measures nothing. The width change that
      // bumps `_fitV` clears the cache.
      const rows = [];
      for (const el of document.querySelectorAll('.surface-lists .list .item')) {
        if (el._fitV === _fitV) continue;                                  // …before the descendant query, not after
        if (!el.querySelector('.r1l')) continue;
        const f = _fitMemo.get(el.dataset.id);
        if (f && f.sig === el._sig && !el._lad) {
          const l2 = new Map(); for (const sel of f.shed) this._shed(el, sel, l2);   // the moves, then the final classes
          el.querySelector('.r1l').className = f.r1; if (f.l2) l2.get(el).className = f.l2;
          for (const i of f.ri) this._relIcon(el, i);
          el._lad = f.lad; el._fitV = _fitV;
          continue;
        }
        if (!el.offsetHeight) continue;
        el._fitV = _fitV; rows.push(el);
      }
      if (!rows.length) return;
      const grown = this._fitEls(rows);
      for (const el of rows) if (el._sig) _fitMemo.set(el.dataset.id, { sig: el._sig, lad: el._lad, shed: (el._moved || []).map(m => m.sel),
        r1: el.querySelector('.r1l').className, l2: el.querySelector('.row2.meta')?.className, ri: [...el.querySelectorAll('.r1l .row-rel')].flatMap((c, i) => c.classList.contains('icon-only') ? [i] : []) });
      // A row that gained (or lost) line 2 changed HEIGHT, and _measure already ran this pass and stamped
      // these elements for this width generation. Un-stamp exactly those and ask for one more pass, or the
      // spacers keep last width's heights and the scrollbar drifts. Converges: next pass they are _fitV-
      // stamped, so the ladder doesn't re-run and nothing schedules again.
      if (grown.length) { for (const el of grown) el._mV = -1; this._reflow(); }
    },
    // Fit `rows` at their current width; returns the rows the ladder ran on if it opened a line 2 (they changed height).
    _fitEls(rows) {
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
        const squeezed = title.scrollWidth > title.clientWidth + 1 && title.clientWidth < Math.min(cap - 1, el.querySelector('.step-block') ? STEP_FLOOR : Infinity);
        if (squeezed || (g && g.querySelectorAll('.area').length > 3)) need.push(el);
      }
      return this._ladder(need) ? need : [];
    },
    // The Plan tray's rows wear the same ladder: new rows next frame, every row when the panel's width changes.
    _fitSide(side, made) {
      requestAnimationFrame(() => this._fitEls(made));
      if (side._ro) return;
      let width = 0;
      (side._ro = new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width); if (!w) return;   // 0: hidden, not a new width
        if (width && w !== width) this._fitEls([...side.querySelectorAll('.cl-side-list .item')]);
        width = w;
      })).observe(side);
    },
    // The row's overflow ladder. Rungs fire ONE at a time and only while the title is still truncated, so a
    // row spends exactly as much of line 1 as its own title needs. Buying space in place (chips → icon
    // pills) always precedes buying it with height. The scheduled-time badge never leaves line 1; when the
    // row has no scheduled time the DEADLINE holds that slot and never leaves either.
    // Order + rationale: docs/ui/task-list.md §Row overflow. Returns true if line 2 was created.
    // RUNG-MAJOR, never row-major: each rung does ONE read pass over every row still overflowing, then one
    // write pass. Row-major (ladder one row to completion, then the next) interleaves a read after every
    // write, so 40 rows × 6 rungs cost 240 forced layouts instead of 6 — the exact cost this pass was built
    // to avoid, and what tests/lists-view.e2e's read ratchet exists to catch.
    _ladder(rows) {
      if (!rows.length) return 0;
      const fits = (el) => { const t = el._t || (el._t = el.querySelector('.title')); return t.scrollWidth <= t.clientWidth + 1 || (el._steps && t.clientWidth >= STEP_FLOOR); };
      for (const el of rows) el._steps = !!el.querySelector('.step-block');
      // Rung 0/1 — chips in place: >3 chips roll on COUNT (unchanged from the old fitRows), otherwise the
      // squeeze that got the row here collapses them to icon pills. Both are writes; no read needed.
      for (const el of rows) this._chipMode(el);
      // Then blocker and file chips drop their names ONE at a time, the widest named first, so the row keeps the most names it has room for (soc-2 b).
      const relRungs = batch => { while ((batch = batch.filter(el => !fits(el) && (el._relAt = this._relWidest(el)) >= 0)).length) for (const el of batch) this._relIcon(el, el._relAt); };   // READ, then WRITE
      relRungs(rows);
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
        for (const el of still) this._shed(el, sel, line2s);          // WRITE
      }
      // A SECOND LINE MUST EARN ITSELF. One lone item down there — a bare project chip, a single badge —
      // reads worse than the slightly clipped title it bought, because the line looks like a mistake rather
      // than a row. Hand it back and let the title truncate. (Two or more is a meta row and reads as one.)
      // Whatever is STILL alone here had nothing left to pair with — the ladder ran out of rungs.
      const back = [];
      for (const [el, l2] of line2s) {
        if (l2.children.length > 1) continue;
        this._unfit(el);                 // full restore: the node goes home, the empty line goes away
        this._chipMode(el);              // …but rung 1 was free, so the chips stay collapsed in place
        line2s.delete(el); back.push(el);
      }
      relRungs(back);                    // and so are the chip rungs
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
    // One rung's WRITE for one row: move `sel` onto line 2 (created on first use), in L2_ORDER. Pure writes, so
    // _fit can REPLAY a cached outcome through it without measuring.
    _shed(el, sel, line2s) {
      if (sel === '.m.dl' && !el.querySelector('.badge')) return;   // no scheduled time → the deadline IS it
      // The default-project chip is a bare inbox GLYPH. Moving it frees ~20px and strands an icon
      // alone on a line of its own, which reads like a bug — it is not a ladder candidate at all.
      const n = el.querySelector(sel === '.proj' ? '.proj:not(.proj-inbox)' : sel); if (!n) return;
      // b4c: a Steps row keeps ONE title line, so the step never reads as a task — what doesn't fit hides behind a "…"
      // listing it, never moving under the step. The deadline is exempt: the one red that means a consequence.
      if (el.querySelector('.step-block')) {
        if (sel === '.m.dl') return;
        n.classList.add('shed-hid');
        (el._moved || (el._moved = [])).push({ n, home: n.parentElement, i: [...n.parentElement.children].indexOf(n), sel });
        const more = el.querySelector('.hid-more') || el.querySelector('.r1l').appendChild(Object.assign(document.createElement('span'), { className: 'hid-more', textContent: '…' }));
        more.title = el._moved.map(m => [...m.n.children].map(c => c.textContent.trim()).filter(Boolean).join(', ') || m.n.title).join(' · ');   // per chip: an icon-only one (est) names itself in its tooltip
        return;
      }
      let l2 = line2s.get(el);
      if (!l2) {
        l2 = document.createElement('div');
        l2.className = 'row2 meta flex items-center gap-8 min-w-0';
        el.querySelector('.row1').after(l2);
        line2s.set(el, l2);
      }
      const home = n.parentElement;
      (el._moved || (el._moved = [])).push({ n, home, i: [...home.children].indexOf(n), sel });
      const rank = L2_ORDER.indexOf(sel);
      l2.insertBefore(n, [...l2.children].find(c => L2_ORDER.findIndex(o => c.matches(o)) > rank) || null);
      // icons-only/rolled are a LINE-1 treatment; once the chips leave line 1 the class is vestigial
      // there (it styles descendants it no longer has). Hand the count-based `rolled` to line 2 — >3
      // chips roll on any line — and let line 2's own ladder decide whether names still have to go.
      if (sel === '.row-rels') this._relNames(n);   // line 2 has the room: names come back
      if (sel === '.areas') {
        const r1l = el.querySelector('.r1l');
        if (r1l.classList.contains('rolled')) l2.classList.add('icons-only', 'rolled');
        r1l.classList.remove('icons-only', 'rolled');
      }
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
      for (const { n, home, i } of (el._moved || []).sort((a, b) => a.i - b.i)) { n.classList.remove('shed-hid'); home.insertBefore(n, home.children[i] || null); }
      el._moved = null; el._lad = 0;
      el.querySelector('.row2.meta')?.remove(); el.querySelector('.hid-more')?.remove();
      el.querySelector('.r1l')?.classList.remove('icons-only', 'rolled');
      const rels = el.querySelector('.row-rels'); if (rels) this._relNames(rels);
    },
    // A chip rung's READ: the widest line-1 chip still named (a tie: the later one), -1 when none is.
    _relWidest(el) {
      let at = -1, widest = -1;
      el.querySelectorAll('.r1l .row-rel').forEach((c, i) => { if (!c.classList.contains('icon-only') && c.offsetWidth >= widest) [at, widest] = [i, c.offsetWidth]; });
      return at;
    },
    // A chip rung's WRITE: chip i drops to its icon; a kind with >3 chips and none named rolls into its first chip + count.
    _relIcon(el, i) {
      const chips = [...el.querySelector('.r1l .row-rels').children], kind = chips[i].dataset.kind, same = chips.filter(c => c.dataset.kind === kind);
      chips[i].classList.add('icon-only');
      if (same.length < 4 || same.some(c => !c.classList.contains('icon-only'))) return;
      same[0].classList.add('rolled');
      for (const c of same.slice(1)) c.classList.add('rel-hid');
    },
    _relNames(rels) { for (const c of rels.children) c.classList.remove('icon-only', 'rolled', 'rel-hid'); },

    // --- Nav ---
    setNav(type, id = null) {
      const SURF = { calendar: 'plan' };   // legacy type → surface (dropped surfaces fall through to Lists)
      if (type !== this.navSel.type || id !== this.navSel.id) {
        if (this.composer.open) this.closeComposer();
        this.clearSel();   // the edit bar acts on sel: off-screen rows must not ride along
      }
      this.navSel = { type, id };                 // unchanged: legacy navSel.type gates keep working
      this.surface = SURF[type] || 'lists';       // mirror into the surface layer (list-types → Lists)
      this.visited[this.surface] = true;
      this.navPop = null;
    },
    surfaceIndex() { return this.surfaceOrder.indexOf(this.surface); },
    surfaceStyle(name) { const i = this.surfaceOrder.indexOf(name); return i < 0 ? 'display:none' : 'order:' + i; },   // visual order follows surfaceOrder; trimmed surfaces vanish
    mounted(name) { return this.surface === name || !!this.visited[name]; },   // gate lazy-mounted heavy surfaces
    goSurface(name) {
      if (!this.surfaceOrder.includes(name) || name === this.surface) return;   // a swipe/wheel that springs back must not file the draft
      if (this.composer.open) this.closeComposer();
      this.visited[name] = true;
      this.surface = name; this.navPop = null;
    },
    openOverview() {
      // Only close the composer if it's empty — non-empty content is kept behind the overview so the user doesn't lose work.
      if (this.composer.open && !this.draft.content.trim() && !this.draft.notes && !this.draft.on) this.closeComposer();
      this.ovSel = this.surfaceIndex(); this.rollerSel = 0; this.overview = true; this.rollerCenter();
    },
    closeOverview() { this.overview = false; this.navPop = null; },   // a ⋯ popover left open must not reappear on the next open
    surfMeta(s) { return SURF_META[s]; },   // label + icon
    // --- Social: 1:1 chats (chat.js). Mounted on first visit; signed out shows a sign-in prompt. ---
    async socialStart() {
      const sb = sbClient();
      if (!this.session || !sb || this.chat.watch) return;
      this.chat.watch = watchMessages(sb, e => this.chatChange(e));
      this._setChats(await loadChats(sb) ?? []);
      if (!this.narrow && !this.chat.open && this.chat.chats[0]) this.openChat(this.chat.chats[0].id);   // desktop shows a thread beside the list
    },
    async openChat(id) {
      if (this.chat.editing) this.endEdit();
      this.chat.open = id; this.chat.msgs = [];
      await this.chatReload(false);
    },
    // The journal's 'message' loader too (_loaders): the open thread, and the list's previews when an edit or delete may have moved them.
    async chatReload(list = true) {
      const sb = sbClient(), id = this.chat.open;
      const [chats, msgs] = await Promise.all([list && loadChats(sb), id && loadMessages(sb, id)]);
      if (chats) this._setChats(chats);
      if (msgs && this.chat.open === id) this.chat.msgs = msgs;
      if (msgs) this._chatFiles(msgs);
    },
    _chatFiles(msgs) { return this._loadFiles(msgs.flatMap(m => m.attachments ?? [])); },
    // Rows for ids not in the map yet, in one read. Signed out, gone or failed: their chips say "File unavailable" (a failed read retries next load).
    async _loadFiles(ids) {
      const sb = this.session && sbClient(), missing = [...new Set(ids)].filter(id => !this.files[id] && !_filesTried.has(id));
      if (!sb || !missing.length) return;
      const rows = await loadFiles(sb, missing).catch(() => null); if (!rows) return;
      for (const id of missing) _filesTried.add(id);
      this._putFiles(rows);
    },
    // A row already drawn with one of these ids re-renders (just those rows): the lists' unchanged-tasks return would keep "File unavailable".
    _putFiles(rows) {
      for (const f of rows) this.files[f.id] = f;
      const ids = new Set(rows.map(f => f.id)), hit = new Set(window.Alpine.raw(this.tasks).filter(t => t.attachments?.some(id => ids.has(id))).map(t => t.id));
      if (!hit.size) return;
      if (this._canPatch()) this._patchRows(hit);
      else this._rowV++;
    },
    phoneThread() { return this.narrow && this.surface === 'social' && !!this.chat.open; },   // a whole-screen page with no switcher (soc-2e)
    chatPeer(chat) { return chat ? peerName(chat, this._acct()) : ''; },
    // Signed out, Social asks to sign in and the invite waits. A server's no (used, expired, your own) drops it; a network failure keeps it for the next boot.
    async redeemInvite() {
      this.goSurface('social');
      if (!this.session) return;
      const { data: id, error } = await sbClient().rpc('redeem_invite', { invite: localStorage.getItem('adherod.invite') });
      if (!error || error.code === 'P0001') localStorage.removeItem('adherod.invite');
      if (error) return this.notify(error.code === 'P0001' ? 'That invite link has been used or has expired' : 'Invite not opened. Check your connection');
      await this.chatReload();
      this.openChat(id);
    },
    // A phone hands the link to the share sheet; elsewhere, or if the sheet can't open, it goes to the clipboard, else into the card.
    async inviteFriend() {
      const row = await createInvite(sbClient(), this._acct());
      if (!row) return this.notify('Invite link not made');
      const url = `https://7ris.net/?invite=${row.id}`;   // the desktop app's own origin (127.0.0.1) means nothing to a friend
      if (this.narrow && navigator.share) {
        try { return await navigator.share({ url }); } catch (e) { if (e.name === 'AbortError') return; }   // dismissing the sheet is a choice
      }
      const copied = await navigator.clipboard.writeText(url).then(() => true, () => false);
      this.notify(copied ? 'Invite link copied. It works once, for 14 days' : `Invite link: ${url}`);
    },
    // ceiling: with Social not yet opened on this device, only a name set here shows; load the chats with the card if that confuses
    chatName() { return this._myMembers().find(m => m.name)?.name || this.chat.name || localStorage.getItem('adherod.chatName:' + this._acct()) || ''; },   // chat.name: storage isn't reactive
    _myMembers() { return this.chat.chats.flatMap(c => c.members).filter(m => m.user_id === this._acct()); },
    // The device keeps it too: with no chats yet there's no row to hold it, and the next new one gets it here.
    async saveName() {
      const name = this.setNameVal.trim();
      if (!name) return;
      if (!(await setName(sbClient(), this._acct(), name))) return this.notify('Name not saved');
      localStorage.setItem('adherod.chatName:' + this._acct(), name);
      this.chat.name = name;
      for (const m of this._myMembers()) m.name = name;
      this.setNameOpen = false;
    },
    // Every load of the list: a chat you joined (or a friend joined) since is named for you.
    _setChats(chats) {
      this.chat.chats = chats;
      this._nameChats();
    },
    async _nameChats() {
      const name = this.chatName();
      if (!name || this._myMembers().every(m => m.name === name)) return;
      if (!(await setName(sbClient(), this._acct(), name))) return;   // the next load tries again
      for (const m of this._myMembers()) m.name = name;
    },
    chatNew(chat) { return unread(chat, this._acct()); },
    chatUnread() { return this.chat.chats.some(c => this.chatNew(c)); },
    // .social's x-effect: the chat on screen is read; its sync part tracks the surface, the open chat and its newest message.
    async chatSeen(chat) {
      const uid = this._acct();
      if (!chat || this.surface !== 'social' || !unread(chat, uid)) return;
      const at = chat.last.created_at;
      if (await markRead(sbClient(), uid, chat.id, at)) chat.members.find(m => m.user_id === uid).last_read_at = at;
    },
    chatWhen: whenLabel,
    chatLine(m) { return m?.body || (m?.attachments?.length ? 'File' : ''); },   // a files-only message previews as "File"
    openChatRow() { return this.chat.chats.find(c => c.id === this.chat.open); },
    chatCanSend() { return this.chat.editing ? !!this.chat.draft.trim() : (!!this.chat.draft.trim() || !!this.chat.pending.length) && this.chat.pending.every(f => f.row); },
    async sendChat() {
      const body = this.chat.draft.trim(), id = this.chat.open;
      if (!id || !this.chatCanSend()) return;
      if (this.chat.editing) return this.saveEdit(body);
      const files = this.chat.pending.map(f => f.row);
      const row = await sendMessage(sbClient(), this._acct(), id, body, files.map(f => f.id));
      if (!row) return this.notify('Message not sent');
      this.chat.draft = '';
      this.chat.pending = [];
      this.chatChange({ eventType: 'INSERT', new: row });
    },
    // Realtime and our own sends land here; a row already shown (by id) is never added twice.
    chatChange({ eventType, new: row, old }) {
      const chat = this.chat.chats.find(c => c.id === (row?.conversation_id ?? old?.conversation_id));
      if (eventType === 'DELETE') {   // carries only the id: a chat whose preview it was re-reads its new last message
        this.chat.msgs = this.chat.msgs.filter(m => m.id !== old.id);
        if (this.chat.chats.some(c => c.last?.id === old.id)) loadChats(sbClient()).then(chats => chats && this._setChats(chats));
        return;
      }
      if (row.attachments?.length) this._chatFiles([row]);
      if (eventType === 'UPDATE') {
        this.chat.msgs = this.chat.msgs.map(m => m.id === row.id ? row : m);
        if (chat?.last?.id === row.id) chat.last = row;
        return;
      }
      if (row.conversation_id === this.chat.open && !this.chat.msgs.some(m => m.id === row.id)) this.chat.msgs.push(row);
      if (!chat) return void loadChats(sbClient()).then(chats => chats && this._setChats(chats));   // a chat we haven't loaded yet
      chat.last = row;
      if (row.user_id !== this._acct() && !(this.surface === 'social' && this.chat.open === chat.id)) {   // soc-1b: a quiet card, never for the chat on screen
        const line = this.chatLine(row).split('\n')[0];
        this.notify(`${this.chatPeer(chat)}: ${line.length > 80 ? line.slice(0, 79) + '…' : line}`, { actions: [{ label: 'Open', fn: () => { this.goSurface('social'); this.openChat(chat.id); } }], timeout: 6000 });
      }
      this.chat.chats.sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? ''));
    },
    chatKey(e) {
      if (e.isComposing) return;
      if (e.key === 'Escape' && this.chat.editing) { e.stopPropagation(); this.endEdit(); }   // not escape(): on a phone that also leaves the thread
      else if (e.key === 'ArrowUp' && !this.chat.draft && !this.chat.editing) {   // ↑ in an empty composer edits your last message
        const mine = this.chat.msgs.findLast(m => m.user_id === this._acct());
        if (mine) { e.preventDefault(); this.startEdit(mine); }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendChat();
      }
    },
    // An edit borrows the composer: the draft set aside comes back when it ends.
    // Uploads start as files arrive (drop, paste, the phone's +); Send waits until every one has its row.
    addFiles(list, into = this.chat.pending, bind = {}) {
      for (const file of list) {
        if (file.size > 15728640) { this.notify(`${file.name} is over 15 MB`); continue; }
        into.push({ key: crypto.randomUUID(), name: file.name, size: file.size, pct: 0, row: null, failed: false, file, ...bind });
        this._upload(into.at(-1));
      }
    },
    async _upload(pending) {
      pending.failed = false;
      pending.row = await uploadFile(this.filesUrl, this.session.access_token, pending.file, f => pending.pct = f);
      pending.failed = !pending.row;
      if (pending.row) this._putFiles([pending.row]);   // named before any chip draws it
      if (pending.row && pending.taskId) this._attachFiles(pending.taskId);
      else if (pending.failed && pending.taskId && !this.composerFiles().includes(pending)) this.notify(`${pending.name} didn’t upload`, { actions: [{ label: 'Retry', fn: () => this._upload(pending) }] });   // its composer closed: no chip shows it
    },
    // ceiling: a file removed after it uploaded stays in Drive until the daily sweep's 90-day grace ends; fine at chat volumes
    dropPending(pending) {
      this.chat.pending = this.chat.pending.filter(f => f !== pending);
      this.attach = this.attach.filter(f => f !== pending);
    },
    chatPaste(e) {
      if (!this.filesUrl || !e.clipboardData?.files.length || e.clipboardData.types.includes('text/plain')) return;   // Excel and Word put a picture of copied text beside it
      e.preventDefault();
      this.addFiles(e.clipboardData.files);
    },
    chatDrop() { return !!this.filesUrl && this.surface === 'social' && !!this.chat.open && !this.chat.editing; },
    composerDrop() { return !!this.filesUrl && this.composer.open && !this._closingComposer; },   // an open task or draft takes dropped and pasted files
    dropNote() { return !this.chatDrop() && !this.composerDrop() ? 'Drop a calendar file to import its events' : this.session ? 'Drop to attach' : 'Sign in to attach files'; },
    // Images, PDFs and text open in a tab (opened before the await, or it's a blocked popup); the rest download.
    async openFile(file) {
      const tab = /^(image\/|application\/pdf$|text\/plain)/.test(file.mime) ? window.open('', '_blank') : null;
      const blob = await fileBlob(this.filesUrl, this.session.access_token, file.id);
      if (!blob) {
        tab?.close();
        return this.notify('File not opened. Check your connection');
      }
      const url = URL.createObjectURL(blob);
      if (tab) tab.location = url;
      else Object.assign(document.createElement('a'), { href: url, download: file.name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60e3);
    },
    fileSize,
    startEdit(m) {
      if (!this.chat.editing) this.chat.stash = this.chat.draft;
      this.chat.editing = m.id;
      this.chat.draft = m.body;
      queueMicrotask(() => this.$refs.chatInput?.focus());
    },
    endEdit() {
      this.chat.editing = null;
      this.chat.draft = this.chat.stash;
      this.chat.stash = '';
    },
    async saveEdit(body) {
      const id = this.chat.editing;
      if (this.chat.msgs.find(m => m.id === id)?.body === body) return this.endEdit();
      if (await this._journalRowChange('Edited message', 'message', id, () => editMessage(sbClient(), id, body), { fail: 'Message not saved' })) this.endEdit();
    },
    deleteMsg(m) {
      if (this.chat.editing === m.id) this.endEdit();
      return this.perform('Deleted message', { kind: 'delete', target: 'message', id: m.id }, { fail: 'Message not deleted' });
    },
    dotStripHtml,
    rollerBoxHtml,
    areaOptHtml,
    keyTip,   // a keycap row → its platform text (⌘K / Ctrl+K) for markup that names one shortcut
    dotStripClick(e) {
      const v = e.target.closest('[data-v]'); if (v) return this.clSetView(v.dataset.v);   // the Plan dot's view segment (phone) — checked first, it sits INSIDE that dot
      const a = e.target.closest('[data-act]')?.dataset.act;   // …and Plan's actions beside it (segHtml)
      if (a) return a === 'today' ? this.clToday() : a === 'side' ? (this.clSideOpen = !this.clSideOpen) : this.quickAdd();
      const b = e.target.closest('[data-idx]'); if (!b) return;
      const i = +b.dataset.idx; i === this.surfaceIndex() ? this.openOverview() : this.goSurface(this.surfaceOrder[i]);
    },
    diveTo(name) { this.closeOverview(); this.goSurface(name); },
    ovMove(d) { const n = this.surfaceOrder.length; this.ovSel = (this.ovSel + d + n) % n; if (this.ovSel === 0) this.rollerCenter(); },
    // Deliberate up-scroll at top → true (shared by list/calendar). Only a gesture begun at the top counts: from rest, or
    // a second push (_clGestureFresh: speed under half a >.5px/ms peak, then past 2× that floor + .25px/ms). That rise
    // clears a tail's integer-px wobble, and a push's ramp clears it within 2 frames. `t` = the event's own time.
    _pullUp(s, deltaY, atTop, t) {
      if (this._clGestureFresh(deltaY, t, s, true, true) || !atTop) s.fromTop = atTop;   // below the top: an up-flick reversed out of a down-scroll began there
      if (!s.fromTop || deltaY >= 0) { s.accum = 0; return false; }                    // carried in from below, or scrolling down → reset
      s.accum = (s.accum || 0) - deltaY;
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
      const sc = e.currentTarget.querySelector('.app');   // the scroller: the surface's one, full-width child
      // Bail if gesture originates inside an inner scrollable (dropdown, popup) — never let those bleed to the overview.
      if (e.deltaY < 0 && this._ownedByScroller(e.target, sc, 'y')) return;
      if (this._pullUp(this._os = this._os || {}, e.deltaY, sc.scrollTop <= 0, e.timeStamp)) this.openOverview();
    },
    onCalTitleWheel(e) {   // deliberate up-scroll over the calendar TITLE bar pulls up the overview (onOverscroll bails on 'plan')
      if (this.overview) return;
      if (this._pullUp(this._ct = this._ct || {}, e.deltaY, true, e.timeStamp)) this.openOverview();   // the title bar is always the "top"
    },
    onCanvasWheel(e) {   // horizontal trackpad scroll switches surfaces (like a swipe); one move per gesture
      if (this.overview || this.anyDialog() || this.dragging) return;
      if (e.target.closest('input, textarea, [contenteditable], .inp, .composer, code, .md-code')) return;   // don't hijack scroll started over native text interaction
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
      if (e.target.closest('input, textarea, [contenteditable], .inp, .composer, code, .md-code, .cd-seg')) return;   // let native text interaction (and a view-strip tap) win
      if (this.drag.active) return;   // ignore extra touch points once a drag owns the pointer
      this.drag = { active: true, x0: e.clientX, y0: e.clientY, w: this.$refs.canvas.offsetWidth, t0: e.timeStamp || performance.now(), id: e.pointerId, axis: null, from: e.target };
      // Holding the strip's ＋ = a new event on the shown day (D8): the platform's 500ms, real time (motion.t zeroes it → every tap a hold); the slop below cancels it.
      // A fired hold ends the drag (a mouse release lands on the editor's backdrop, missing canvasUp); the strip's @touchend eats a finger's release click, which would close it.
      if (e.target.closest('[data-act="add"]')) this.drag.hold = setTimeout(() => { Object.assign(this.drag, { held: true, active: false }); this.clNewEvent(); }, 500);
    },
    canvasMove(e) {
      if (!this.drag.active || e.pointerId !== this.drag.id || sorting) return;   // a held row owns the finger
      const dx = e.clientX - this.drag.x0, dy = e.clientY - this.drag.y0;
      if (!this.drag.axis && Math.hypot(dx, dy) > 8) {       // lock the axis once past the threshold
        clearTimeout(this.drag.hold);                         // …which is also a hold's slop
        this.drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        // A real horizontal list owns its own axis — the same deference onCanvasWheel
        // makes, which the pointer path never did: a finger paged the app where a trackpad scrolled the
        // lane. Finger sign is inverted from wheel delta (drag left = scroll right), hence -dx.
        if (this.drag.axis === 'x' && this._ownedByScroller(this.drag.from, e.currentTarget, 'x', -dx)) this.drag.axis = 'own';
        if (this.drag.axis === 'x' && this.phoneThread()) this.drag.axis = 'back';   // swipes back to the chats, not to Plan
        if (this.drag.axis === 'x') this.dragging = true;
        if (this.drag.axis === 'x' || this.drag.axis === 'back') { document.body.classList.add('swiping'); try { this.$refs.canvas.setPointerCapture(e.pointerId); } catch {} }
        if (this.drag.axis === 'back') this.$refs.thread.parentElement.classList.add('back');   // the chats show beneath
      }
      if (this.drag.axis === 'back') {
        e.preventDefault();
        this.$refs.thread.style.transform = `translateX(${dx > 0 ? dx : dx * 0.3}px)`;   // leftward: the same resistance as past the ends
        return;
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
      clearTimeout(this.drag.hold);
      this.drag.active = false; this.dragging = false; document.body.classList.remove('swiping');   // re-enable the transition + text selection
      const dx = this.dragDx, wasX = this.drag.axis === 'x';
      this.dragDx = 0;
      if (this.drag.axis === 'back') return this.threadRelease(e);
      if (!wasX) return;                                      // a tap or a vertical scroll — stay put
      // Velocity from the EVENTS' own timestamps, not from when our handlers happened to run: a busy main
      // thread delays the handler, not the finger, and clock-at-handler-time under-reports the speed — which
      // silently swallows a real flick exactly when the app is loaded enough for one to matter.
      const vx = dx / Math.max(1, (e.timeStamp || performance.now()) - this.drag.t0);
      const targetIdx = this.snapTarget(dx, this.drag.w, vx, this.surfaceIndex(), this.surfaceOrder.length);
      this.goSurface(this.surfaceOrder[targetIdx]);
      // An unchanged surface doesn't re-run Alpine's :style, leaving the drag offset inline: write the resting transform
      // so the CSS transition animates back.
      if (this.$refs.track) this.$refs.track.style.transform = `translateX(-${targetIdx * 100}%)`;
    },
    // The thread slides off to the right (a flick or past half-way, like the surface swipe) or springs back; the chats stay shown until it lands.
    // ceiling: a new swipe inside the 220ms slide waits it out (the animation outranks the finger); make it interruptible if that reads as stuck.
    threadRelease(e) {
      const el = this.$refs.thread, social = el.parentElement, dx = e.clientX - this.drag.x0;
      const back = this.snapTarget(dx, this.drag.w, dx / Math.max(1, e.timeStamp - this.drag.t0), 1, 2) === 0;
      const from = el.style.transform, to = back ? 'translateX(100%)' : 'translateX(0)';
      el.style.transform = to;
      motion.go(null, el, [{ transform: from }, { transform: to }], { duration: DESIGN.motion.daily, easing: DESIGN.ease.drawer }).finished.then(() => {
        if (back) this.chat.open = null;
        el.style.transform = '';
        social.classList.remove('back');   // the thread may be gone (‹ Chats mid-slide)
      });
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
    isOverviewProject(t) { return !!t.overview; },
    // Filter view: runFilter's ordered ids mapped to live task objects (order preserved).
    filterTasks() {
      const f = this.activeFilter(); if (!f) return [];
      return this.store.runFilter(f.query).map(id => this.byId.get(id)).filter(Boolean);
    },
    scopeRoots(byParent) {   // byParent, not childTasks: a raw rebuild must not seed the shared _taskIdx with raw rows
      const { type, id } = this.navSel, def = this.store.defaultProject(), kids = pid => (byParent.get(pid) || []).filter(t => t.id !== pid);
      if (type === 'project') return kids(id);
      if (type === 'backlog') return kids(def);
      if (type === 'area') return this.tasks.filter(t => t.area_ids?.includes(id));
      // All: tasks whose parent is a container (root, backlog, overview project). byId keeps this O(n) — tasks.find per task melted at ~1k rows.
      const byId = this.byId;
      const inProject = pid => pid === null || pid === def || !!byId.get(pid)?.overview;
      return this.tasks.filter(t => !t.overview && t.id !== def && inProject(t.parent_id));
    },
    // Hearthsay: / or ⌘F → search unfolds; a selection hides the controls row, so it clears first
    openListSearch(select) { if (this.sel.length) this.clearSel(); this.listSearchOpen = true; this.$nextTick(() => { this.$refs.listSearch?.focus(); if (select) this.$refs.listSearch?.select(); }); },
    listHit(t) {
      const q = this.listQ.trim().toLowerCase(); if (!q) return true;
      if (_listHayV !== this._rowV) { _listHay = new Map(); _listHayV = this._rowV; }
      let hay = _listHay.get(t.id);
      if (hay == null) {   // every typed field: title · areas · places · description · checklist; '\n' keeps a query from spanning two fields
        const places = (t.location?.ids || []).map(id => byIdIn(this.locations).get(id)?.name || '');
        // a project's body describes the whole list it heads, so it would match everything in it (decision #99)
        _listHay.set(t.id, hay = [t.content || '', ...this.areaObjs(t.area_ids).map(l => l.name || ''), ...places, t.overview ? '' : bodyText(t)].join('\n').toLowerCase());
      }
      return hay.includes(q);
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
    setGroup(key) { this.groupBy = key; this.secShut = []; this._saveView(); },
    groupWord() { return ({ project: 'projects', area: 'areas', due: 'dates', importance: 'importance', place: 'places' })[this.groupBy] || ''; },
    toggleSec(k) { this._toggleIn(this.secShut, k); this._saveView(); },   // no _rowV: visibleRows keys on secShut, nothing else reads it
    toggleQfImp(v) { this._toggleIn(this.qfImp, v); this.qfImp.sort((a, b) => impRank(a) - impRank(b)); this._saveView(); },   // importance order: the sentence and its saved query read it as is
    toggleQfArea(id) { this._toggleIn(this.qfAreas, id); if (!this.qfAreas.length) _qfGone = []; this._saveView(); },   // an emptied facet forgets deleted areas, like its ×
    setQfDue(v) { this.qfDue = this.qfDue === v ? null : v; this._saveView(); },
    toggleQfArchived() { this.qfArchived = !this.qfArchived; this._saveView(); },
    clearQf() { this.qfImp = []; this.qfAreas = []; _qfGone = []; this.qfDue = null; this.qfArchived = false; this._saveView(); },
    // The sentence is one shape per facet — [connective] then a token that opens the menu and clears itself —
    // so this table IS the grammar: array order is reading order, and a new facet is one entry, not a 4th
    // copy of the markup. A facet WITHOUT a `verb` key renders no connective (importance leads the line);
    // due keeps one even when empty ('' for overdue), because the span is a flex item the spacing counts on.
    qfFragments() {
      const f = [], due = QF_DUE[this.qfDue];
      if (this.qfImp.length) f.push({ k: 'imp', aria: 'importance', cls: 'ls-tok-pri', flag: true, col: this.pc(this.qfImp[0]), label: this.qfImp.map(v => this.impName(v)).join('·') });   // e.g. Must·Focus; the most important colors it
      if (this.qfAreas.length) {
        const area = this.areas.find(a => a.id === this.qfAreas[0]), more = this.qfAreas.length - 1;
        f.push({ k: 'area', aria: 'area', verb: 'in', dot: true, col: area?.color || this.areaDefault, label: (area?.name || '?') + (more ? ` +${more}` : '') });
      }
      if (this.qfDue) f.push({ k: 'due', aria: 'due', verb: due?.verb ?? '', col: due?.col, label: due?.label });
      return f;
    },
    // The filter line's shed ladder (task-list.md §Filter line shed order). Where the line can't wrap, the search
    // field yields first (CSS); then ONE rung at a time while a piece still runs past the sentence: `showing`, the
    // sort word → ⇅, token labels → 6ch, then the labels of tokens whose colour mark can stand in for them.
    // Measured, so a long area name sheds at 414 and a short one never does.
    _fitControls() {
      const lc = this.$refs.lc, sent = lc?.querySelector('.ls-sent');
      if (!sent || this.sel.length) return;   // hidden under the edit bar; clearing the selection re-runs the x-effect
      // this x-effect can run before lc's x-show in the same flush: fit next frame, never measured hidden
      if (lc.style.display === 'none') return requestAnimationFrame(() => lc.style.display !== 'none' && this._fitControls());
      const over = () => { const r = sent.getBoundingClientRect().right; return [...sent.querySelectorAll('.ls-word, .ls-tok, .ls-clear')].some(e => e.getBoundingClientRect().right > r + 1); };
      lc.classList.remove('shed-1', 'shed-2', 'shed-3', 'shed-4');
      for (let i = 1; i <= 4 && over(); i++) lc.classList.add('shed-' + i);
    },
    clearQfFacet(k) { if (k === 'imp') this.qfImp = []; else if (k === 'area') { this.qfAreas = []; _qfGone = []; } else this.qfDue = null; this._saveView(); },
    qfFacets() { return this.qfFragments().length; },
    sortWord() { return ({ manual: 'hand', due: 'due date', importance: 'importance', deadline: 'deadline', alpha: this.sortDir === 'desc' ? 'z-a' : 'a-z', created: 'date added' })[this.sortBy]; },   // follows the "· sorted by" verb
    // Escalate the ad-hoc sentence into a saved filter; pre-populates the AQL textarea from the live filter state.
    lsSaveFilter() {
      this.listMenu = null;
      const areas = this.qfAreas.map(id => this.areaById(id)?.name || '');
      const scope = this.navSel.type === 'area' ? this.areaById(this.navSel.id)?.name : null;
      this.openFilterEditor({ name: '', query: qfQuery({ imp: this.qfImp, areas, due: this.qfDue, done: this.showCompleted, archived: this.qfArchived, scope }) });
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
      // The key's reads are the only Alpine deps registered: the list re-runs on them. Completed rows split into _doneMemo (rendered below the add button).
      const key = this._rowV + '|' + this.navSel.type + '|' + this.navSel.id + '|' + this.listQ + '|' + this.showCompleted
        + '|' + this.sortBy + this.sortDir + '|' + this.qfImp + '|' + this.qfAreas + '|' + this.qfDue + '|' + this.qfArchived
        + '|' + this.groupBy + '|' + this.secShut + '|' + this._nowDay + '|' + this._foldV;
      void this._celeV;   // _celeExit patches the memo or clears _visKey: either way a pending change
      if (_visKey === key && !_rowPatch) return _visMemo;
      if (this !== _appRaw) return _appRaw.visibleRows();   // rebuild untracked: the key holds every dep the memo needs. Callers' `this` is Alpine's merged scope, which Alpine.raw() returns as is
      if (_rowPatch && !this.sticky && _rowPatch.key === _visKey && key === _rowPatch.v + _visKey.slice(_visKey.indexOf('|'))) {   // future-guard: the patch re-lays a tree's runs, never the note's flat order
        // Same row OBJECTS, reassigned in place: _rowMap, _parentMap and the list model's entries all stay valid.
        const def = this.store.defaultProject(), now = new Date(), pm = this._placedMap(), ed = new Map();
        for (const id of _rowPatch.ids) {
          const r = _rowMap.get(id) || _doneMap.get(id);
          if (r) { Object.assign(r, this.mkRow(r.t, r.depth, _visBP, this.byId, def, now, ed, pm)); this._dropRowHtml(id); }
          else _rowCache.delete(id);   // hidden: rebuilt when it next shows
        }
        _rowCacheKey = this._rowV + _rowCacheKey.slice(_rowCacheKey.indexOf('|'));   // the shown rows ARE the cached objects, patched above
        const { drop, sort } = _rowPatch; _rowPatch = null; _visKey = key;
        if (drop.size) _doneMemo.hidden = true;   // a dropped root went to the hidden Done list
        if (!drop.size && !sort.size) return _visMemo;
        // a root gone out of sight takes its subtree: its run ends at the next root (DFS order)
        let gone = false; const out = _visMemo.filter(r => !(gone = r.depth ? gone : drop.has(r.t.id)));
        // a parent's children re-sorted: its run (each child + its subtree) is re-laid in the new order
        const cmp = sort.size && (this.sibCmp() || ((a, b) => (a.position ?? 0) - (b.position ?? 0)));
        for (const pid of sort) {
          const kids = _visBP.get(pid); kids.sort(cmp);
          const p = out.indexOf(_rowMap.get(pid)), d = out[p]?.depth, runs = new Map(); let end = p + 1, run;
          if (p < 0) continue;
          for (; end < out.length && out[end].depth > d; end++) { if (out[end].depth === d + 1) runs.set(out[end].t.id, run = []); run.push(out[end]); }
          out.splice(p + 1, end - p - 1, ...kids.flatMap(c => runs.get(c.id) || []));
        }
        return this._linkRows(out, _doneMemo);
      }
      _rowPatch = _secKids = null;
      const cacheKey = this._rowV + '|' + Math.floor(Date.now() / 6e4);
      if (_rowCacheKey !== cacheKey) {
        // the one bump since the cache was keyed carried its id set: every other row reads only what didn't change
        if (_rowStale && _rowCacheKey === (this._rowV - 1) + cacheKey.slice(cacheKey.indexOf('|'))) for (const id of _rowStale) _rowCache.delete(id);
        else _rowCache = new Map();
        _rowCacheKey = cacheKey;
      }
      if (_rowStale && _listHayV === this._rowV - 1) {   // so do the search haystacks: a tick rebuilds its rows', not all 5k
        for (const id of _rowStale) _listHay.delete(id);
        _listHayV = this._rowV;
      }
      _rowStale = null;
      _qfToday = this._nowDay; const _t0 = new Date(_qfToday + 'T00:00'); _qfTmr = isoDate(new Date(_t0.getTime() + 864e5)); _qfWk = isoDate(new Date(_t0.getTime() + 6 * 864e5));   // once per recompute; relative to _nowDay for DST safety
      const filtering = this.filtering(), cmp = this.sibCmp();
      const fold = !this.sticky && !filtering && this.navSel.type !== 'filter';   // search, quick filters and saved filters show every match: no fold, no chevron
      // Subproject sections: only INSIDE a container view. All/area scope by something other than containment,
      // where a project is a legitimate row rather than the thing the list is about. Inside a project, grouping by
      // project IS its subproject sections — the same view as grouping off.
      const inProj = this.navSel.type === 'project', group = inProj && this.groupBy === 'project' ? 'none' : this.groupBy, subSec = inProj && group === 'none';
      const { mkRow: build, byParent, byId } = this._mkRowFn(true, cmp); _visBP = byParent;
      // t (a re-read hands in new objects), depth, ctx, fold and collapsed are this pass's (sections shift depth, a filter marks ctx); no other row field reads them
      const mkRow = (t, depth) => { let r = _rowCache.get(t.id); if (!r) _rowCache.set(t.id, r = build(t, depth)); r.t = t; r.depth = depth; r.ctx = false; r.fold = fold; r.collapsed = !!this.collapsed[t.id]; return r; };
      let out = [], roots, walk; const done = [], seen = new Set();   // one row per id, even with cyclic cloud data
      // Additive lenses: OPEN tasks always fill the main list; the 'done' lens adds completed tasks and the
      // 'archived' lens adds archived tasks to the below-the-line section (both, when both are on).
      // Filter view: matches + their ANCESTOR CHAIN as context rows (r.ctx), so a matched subtask keeps its parents
      // and its project (never a match itself: matchQuery drops overview projects) still shows. Grouped, the
      // project chain is All's sections instead, so the walk stops at the first project.
      if (this.navSel.type === 'filter') {
        let rows = filtering ? this.filterTasks().filter(t => this.rowPass(t)) : this.filterTasks();
        if (cmp) rows = rows.slice().sort(cmp);
        const hits = [];
        for (const t of rows) {
          // below-the-line stays flat: it's a review list, not a tree. Uncached: the row may also be an open match's context row up top
          if (t.archived_at) { if (this.qfArchived) done.push(Object.assign(build(t, 0), { fold })); }
          else if (t.completed_at && !_cele.has(t.id)) { if (this.showCompleted) done.push(Object.assign(build(t, 0), { fold })); }
          else hits.push(t);
        }
        const keep = new Map(), def = this.store.defaultProject();   // id → true = matched, false = pulled in only as an ancestor
        for (const t of hits) {
          keep.set(t.id, true);
          const seen = new Set([t.id]);
          // stop at the default project — the inbox is where "no project" lives, so naming it adds nothing
          for (let a = byId.get(t.parent_id); a && a.id !== def && !seen.has(a.id) && !(group !== 'none' && a.overview); a = byId.get(a.parent_id)) { seen.add(a.id); if (!keep.has(a.id)) keep.set(a.id, false); }
        }
        // Roots in first-hit order, so an unsorted filter keeps runFilter's ranking among the loose rows and among the heads.
        // _hitRank: id → the rank its row sorts by as a root (ghostPos) — its subtree's first hit, or its own when sorted.
        roots = []; _hitRank = new Map();
        hits.forEach((t, i) => {
          for (let r = t; !_hitRank.has(r.id); r = byId.get(r.parent_id)) {   // stops at a row an earlier hit reached
            _hitRank.set(r.id, i);
            if (!keep.has(r.parent_id) || _hitRank.get(r.parent_id) === i) { roots.push(r); break; }   // a root, or where cyclic cloud data closes its loop
          }
        });
        if (cmp) { roots.sort(cmp); hits.forEach((t, i) => _hitRank.set(t.id, i)); }
        if (group === 'none') roots.sort((a, b) => keep.get(b.id) - keep.get(a.id));   // subLast's rule: context roots become heads, so they follow the matched roots
        walk = (t, depth) => {
          if (seen.has(t.id)) return; seen.add(t.id);
          out.push(Object.assign(mkRow(t, depth), { ctx: !keep.get(t.id) }));
          for (const c of (byParent.get(t.id) || [])) if (keep.has(c.id)) walk(c, depth + 1);
        };
      } else {
        // When narrowing (search or quick-filters), keep only scope roots that pass + their full subtrees.
        // Subtask matches do NOT pull ancestors in — filters apply to top-level tasks only.
        roots = this.scopeRoots(byParent); _visRoots = new Set(roots.map(t => t.id));
        let keep = null;
        if (filtering) {
          keep = new Set();
          const addSubtree = (id) => { if (keep.has(id)) return; keep.add(id); for (const c of (byParent.get(id) || [])) addSubtree(c.id); };
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
        const shelvedView = inProj && this._shelved().has(this.navSel.id);   // an archived project, opened: its archived tasks are what it holds
        const visitDone = (t, depth) => { if (seen.has(t.id)) return; seen.add(t.id); done.push(mkRow(t, depth)); if (fold && this.collapsed[t.id]) return; for (const c of (byParent.get(t.id) || [])) visitDone(c, depth + 1); };
        walk = (t, depth) => {
          if (keep && !keep.has(t.id)) return;
          // A completed/archived ROOT or PROJECT CHILD (a section's row) (+ its subtree) goes to the Done section or is
          // hidden. A completed/archived SUBTASK under an ACTIVE task stays inline (struck / dashed) so it keeps its place in the tree.
          const top = !depth || this.isOverviewProject(byId.get(t.parent_id));
          if (t.archived_at && top && !shelvedView) { if (this.qfArchived) visitDone(t, 0); return; }   // archived lens → below-the-line section
          if (t.completed_at && top && !_cele.has(t.id)) { if (this.showCompleted) visitDone(t, 0); else done.hidden = true; return; }   // a celebrating root holds its slot; .hidden: done tasks the lens hides (the empty copy reads "All clear")
          if (seen.has(t.id)) return; seen.add(t.id);
          out.push(mkRow(t, depth));
          if (this.isOverviewProject(t) && depth > 0) return;
          if (fold && this.collapsed[t.id]) return;
          for (const c of (byParent.get(t.id) || [])) walk(c, depth + 1);
        };
        if (cmp) roots = roots.slice().sort(cmp);
        else if (!inProj) {   // by hand, a view spanning parents reads the tree (Inbox first, like the sidebar), each project in its view's order: a position ranks siblings only
          const dfs = _memo(_treeMemo, this._rowV, () => {
            const ix = new Map(), walk = id => { if (ix.has(id)) return; ix.set(id, ix.size); for (const c of (byParent.get(id) || []).toSorted(subLast)) walk(c.id); };
            walk(this.store.defaultProject()); walk(null); return ix;
          }, 1);
          roots = roots.slice().sort((a, b) => (dfs.get(a.id) ?? dfs.size) - (dfs.get(b.id) ?? dfs.size));   // unreachable (cyclic) rows last
        }
        // Subprojects sink BELOW the project's own tasks: they become section heads, and a head sitting mid-list
        // reads as though the loose tasks after it belonged to it. sort is stable, so each group keeps its order.
        if (subSec) roots = roots.slice().sort(subLast);
      }
      // Sections come from the group, the order INSIDE one from the sort — so grouping never throws your sort away.
      if (group !== 'none') {
        // inside a project's group, the project view's order, depth-first: a project's own rows (0), then each
        // subproject's section (1) — every step ranked by its place among its own siblings (byParent, already in
        // sort order), never by raw position
        const ix = new Map(), at = (pid, id) => { let m = ix.get(pid); if (!m) ix.set(pid, m = new Map((byParent.get(pid) || []).map((c, i) => [c.id, i]))); return m.get(id) ?? 0; };
        const nth = new Map();   // group key → first-seen ordinal: two groups tied on rank must not interleave
        const key = (t, g) => {
          if (!nth.has(g.k)) nth.set(g.k, nth.size);
          const k = [g.rank, nth.get(g.k)]; if (!g.path) return k;
          let up = g.k;
          for (const p of g.path) { k.push(1, at(up, p.id)); up = p.id; }
          k.push(0, at(up, t.id)); return k;
        };
        const ks = new Map(roots.map(t => [t.id, key(t, this._groupOf(t))]));
        // two keys in one group differ before either ends: each ends on a row's 0 where the other holds a section's 1
        roots = roots.slice().sort((a, b) => { const x = ks.get(a.id), y = ks.get(b.id); let i = 0; while (i < x.length - 1 && x[i] === y[i]) i++; return x[i] - y[i]; });
      }
      for (const r of roots) walk(r, 0);
      if (this.sticky) {   // the sticky note: every open task, flat, as the Mac note (wOrder, N11 user 08-17) — today, overdue, later, undated; then when, importance
        const pm = this._placedMap(), today = this._nowDay, k = new Map();
        out = out.filter(r => placeable(r.t) && (filtering ? this.rowPass(r.t) : r.t.task_type !== 'note'));   // a note is never done: only a search shows it
        for (const r of out) { const w = this.whenOf(r.t, pm) || '', d = w.slice(0, 10); r.depth = 0; k.set(r, [!w ? 3 : d === today ? 0 : d < today ? 1 : 2, w, impRank(r.t.importance)]); }
        out.sort((a, b) => { const x = k.get(a), y = k.get(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2]; });
        _secMemo = []; _visKey = key; return this._linkRows(out, done);
      }
      if (group !== 'none') { const [secs, kept] = this._sectionize(out); _secMemo = secs; out = kept; }
      else if (this.navSel.type === 'filter') { const [secs, kept] = this._promoteSections(out, r => !!r.ctx); _secMemo = secs; out = kept; }
      // Inside a project, its overview subprojects become section heads even with grouping OFF — a subproject is
      // a container, and drawn as one more row it read as a sibling of the tasks it actually holds.
      else if (subSec) { const [secs, kept] = this._promoteSections(out, r => this.isOverviewProject(r.t)); _secMemo = secs; out = kept; }
      else _secMemo = [];
      _visKey = key; return this._linkRows(out, done);
    },
    // Neighbor ids (itemBlock's hover highlight) and index `i` (a row's position by id) — O(1)/row via _rowMap/_doneMap.
    _linkRows(out, done) {
      for (const arr of [out, done]) for (let k = 0; k < arr.length; k++) {
        arr[k].i = k; arr[k].prevId = arr[k - 1]?.t.id; arr[k].prevPid = arr[k - 1]?.t.parent_id;
        arr[k].nextId = arr[k + 1]?.t.id; arr[k].nextPid = arr[k + 1]?.t.parent_id;
      }
      _visMemo = out; _doneMemo = done;
      _rowMap = new Map(); _parentMap = new Map(); _doneMap = new Map();
      for (const r of out) { _rowMap.set(r.t.id, r); const ch = _parentMap.get(r.t.parent_id); ch ? ch.push(r) : _parentMap.set(r.t.parent_id, [r]); }
      for (const r of done) _doneMap.set(r.t.id, r);
      return out;
    },
    // Which section a ROOT task belongs to. rank orders the sections; the unset bucket always sinks last.
    _groupOf(t) {
      const LAST = 1e9, by = this.groupBy;
      // project = the TOP project; `path` = the subprojects between it and t, outermost first — each one a section,
      // as in the project view. t itself is a row even when it is a subproject (area view).
      if (by === 'project') { const def = this.store.defaultProject(), path = [];
        for (let p = this.byId.get(t.parent_id), n = 0; p?.overview && p.id !== def && n < 50; p = this.byId.get(p.parent_id), n++) path.unshift(p);   // n: cyclic cloud data
        const top = path.shift();
        return top ? { k: top.id, label: top.content || 'Project', rank: top.position ?? 0, path } : { k: '_none', label: 'No project', rank: LAST }; }
      if (by === 'area') { const a = this.areaObjs(t.area_ids)[0];
        return a ? { k: a.id, label: a.name, rank: a.position ?? 0 } : { k: '_none', label: 'No area', rank: LAST }; }
      if (by === 'importance') { const v = t.importance || 'none';
        return { k: v, label: this.impName(v), rank: impRank(v) }; }
      if (by === 'place') { const id = (t.location?.ids || [])[0], l = id && byIdIn(this.locations).get(id);
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
      const secs = [], kept = []; let cur = null, head = null, open = [];   // open: the subproject heads the row sits in, outermost first
      for (const r of rows) {
        if (r.depth === 0) {
          const g = this._groupOf(r.t), path = g.path || [];
          if (g.k !== cur) { cur = g.k; open = []; head = this._secHead(g.k, g.label, kept.length); secs.push(head); }
          let n = 0;
          while (n < open.length && open[n].key === path[n]?.id) n++;
          open.length = n;
          // each subproject gets a head labelled by its path from the top project; inside a shut one, none — it's folded away
          for (; n < path.length && !(open[n - 1] || head).shut; n++) {
            const s = { ...this._secHead(path[n].id, path[n].content || 'Project', kept.length), up: [g.label, ...path.slice(0, n).map(p => p.content || 'Project')].join(' › ') + ' › ' };
            open.push(s); secs.push(s);
          }
          head.count++;
          for (const s of open) s.count++;
        }
        if (!head?.shut && !open.at(-1)?.shut) kept.push(r);
      }
      return [secs, kept];
    },
    _secHead(key, label, at) { return { key, label, count: 0, shut: this.secShut.includes(key), at, ...this._secPie(key) }; },
    sections() { this.visibleRows(); return _secMemo; },
    // When a section IS a project, its head wears the same conic pie the picker gives that project — "how far
    // along is this" belongs where the project is being worked, not only where it's chosen. Keyed off byId, so
    // it fires for project grouping and subproject sections alike and stays inert for date/area/importance keys.
    _secPie(k) { const p = this.byId.get(k); return p?.overview ? { pct: this.projectProgress(k, _secKids ??= childIndex(this.tasks)) / 100, pieColor: p.color || '' } : {}; },
    // A depth-0 row that `isHead` claims becomes a section HEAD instead of a row, and its subtree shifts up a
    // level so the indent still reads as the tree. Two callers, one idiom: a filter view promotes the ancestors
    // that only provide context (a root that MATCHED stays a row), a project view promotes its overview subprojects.
    _promoteSections(rows, isHead) {
      const secs = [], kept = []; let head = null;
      for (const r of rows) {
        if (r.depth === 0) {
          if (!isHead(r)) head = null;
          else { head = this._secHead(r.t.id, r.t.content || (this.isOverviewProject(r.t) ? 'Project' : ''), kept.length); secs.push(head); continue; }
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
        + '<span class="sec-lbl">' + (g.up ? '<span class="sec-up"><span>' + escHtml(g.up) + '</span></span>' : '') + '<span class="sec-nm">' + escHtml(g.label) + '</span></span><span class="sec-ct">' + g.count + '</span>'
        // AFTER the count, never before the label: the chevron/label column is aligned to the row chevron and the
        // Done head by deliberate convention (layout-lists asserts it), and a leading pie shifts the label 18px.
        + (g.pct == null ? '' : '<span class="rl-prog sec-pie" style="--p:' + g.pct + ';--pc:' + escHtml(g.pieColor || 'var(--muted)') + '"></span>')
        + '<span class="head-rule"></span></li>';
    },
    completedRows() { this.visibleRows(); return _doneMemo; },   // computed alongside visibleRows; the Done list below the add button
    // Same pure row markup as listHtml (order + depth padding so it aligns with the active list), so the single
    // composer can relocate into the Done list and open inline on a completed task. Edit styling via applyEditDom().
    // Shared <li> builder — _entries (list/done: order + drag) and _clRowsHtml (tray, draggable always). Its 18px gutter
    // holds the chevron left of the check on EVERY row, so checks line up with or without one.
    _itemLi(r, { order = null, drag = '', ...body } = {}) {
      const t = r.t, style = (order == null ? '' : 'order:' + order + ';') + 'padding-left:calc(var(--gut) + ' + (r.depth * 22) + 'px);--d:' + r.depth;
      return '<li class="item' + (t.completed_at ? ' done' : t.archived_at ? ' archived' : r.blocked ? ' waiting' : '') + (r.ctx ? ' ctx' : '') + ' flex gap-10" data-id="' + t.id + '" style="' + style + '"' + drag + '>' + this.rowBody(r, body) + '</li>';
    },
    // Height estimate for a row that has NEVER been rendered (once one has, _hCache holds its real height).
    // One flat 38px guess against real 34/46/54+ rows made the scrollbar lurch on the way down (#307), so this
    // tracks the same content the row builder renders.
    _rowEst(r) {
      const chk = r.step || (r.collapsed && r.fold !== false) ? [] : (r.chk || r.t.checklist || []);   // folded or Steps → the checklist contributes no height
      const n = chk.length ? chkVisible(chk, !!r.t.checklist_plain, this.chkOpen.has(r.t.id), _chkHeld?.key === r.t.id ? _chkHeld.done : null) : null;
      // Relations ride line 1 until the ladder sheds them onto the shared meta line. A DESCRIPTION always owns its
      // (prose never joins the meta line), so they add their own 17.
      const ml = this._metaLines(r);
      // A Steps row's step line: 18px, less the 4px its text block rises; its desc 1+14, its preview 4+16 (styles.css .row-step, .step-desc, .step-next).
      return 34 + (r.step ? 14 + (r.step.desc ? 15 : 0) + (r.next ? 20 : 0) : 0) + (ml ? L2_PAD + ml * L2_ROW_H : 0) + (r.t.notes ? 17 : 0) + (n ? 4 + (n.rows.length + (n.more ? 1 : 0)) * 19 : 0);
    },
    // How many WRAPPED rows the meta line will take (0 = none spent). Only _fit can KNOW, since it measures,
    // but a row that has never rendered has no measurement — and guessing one line for a taller row is
    // exactly the lurch #307 fixed. Approximate from the same inputs the row builder has: title length
    // against the width left over after the metadata, then how many rows that metadata needs. Deliberately
    // cheap and slightly eager; _measure overwrites it with the real height the instant the row renders,
    // so this only has to keep the scrollbar honest while the reader scrolls past.
    _metaLines(r) {
      if (_listW < 0 || r.step) return 0;   // a Steps row hides, never sheds
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
        const r = rows[i];
        ent.push({ id: r.t.id, order: i * 2, d: r.depth, r, h: _hCache.get(r.t.id) ?? this._rowEst(r), html: '', mk: () => this._itemLi(r, { order: i * 2, drag }) });
      }
      while (secs && si < secs.length) head();
      return ent;
    },
    // Entries → PARTS: [{ id, html }], one per <li>, NOT one string: keyed by id, each row's html IS its signature, so
    // an unchanged row costs a string compare, not a re-parse of the whole list (6.8ms of a 9.8ms morph at 1000 rows).
    // Built ONCE per entry, then handed out by reference: a scroll frame re-emits ~18 parts to change ~2, and the
    // unchanged ones are the SAME string object, so renderRows' compare is a pointer hit and nothing is allocated.
    _parts(ent, s = 0, e = ent.length) { const out = []; for (let i = s; i < e; i++) { const p = ent[i]; out.push({ id: p.id, html: p.html || (p.html = p.mk()) }); } return out; },
    // The cache is only stale when something OUTSIDE visibleRows() changes what a row renders, and chkOpen
    // (the checklist "…N more" toggle) is the only such input — every other one busts the whole model.
    _dropRowHtml(id) { const e = _model?.ent[_model.ix.get(id)] || _doneModel?.ent[_doneModel.ix.get(id)]; if (e) e.html = ''; },
    // The active list's flat model, memoised on the visibleRows() identity (which already busts on every
    // task/nav/filter/sort/collapse change). Rebuilt rarely; walked on every scroll frame.
    _listModel() {
      const rows = this.visibleRows();
      return _model?.rows === rows ? _model : (_model = this._mkModel(rows, this._entries(rows, this.navSel.type !== 'area' ? ' draggable="true"' : '', this.sections()), '.surface-lists .rows', '__w'));
    },
    // The Done list's, windowed the same way below the active list in the same scroller (its origin is read off the DOM).
    // completedRows() always carry completed_at OR archived_at, so the trailing '' in _itemLi never fires here.
    _doneListModel() {
      const rows = this.completedRows();
      return _doneModel?.rows === rows ? _doneModel : (_doneModel = this._mkModel(rows, this._entries(rows), '.list-done .rows', '__d'));
    },
    // `sel`: the list's .rows element · `pad`: its spacers' id prefix (_glideRows keys both lists' elements by id).
    _mkModel(rows, ent, sel, pad) {
      const ix = new Map(); let total = 0;
      for (let i = 0; i < ent.length; i++) { ix.set(ent[i].id, i); total += ent[i].h; }
      return { rows, ent, ix, total, sel, pad };
    },
    _modelOf(id) { const m = this._listModel(); return m.ix.has(id) ? m : this._doneListModel().ix.has(id) ? _doneModel : null; },
    // A width reading moves only the estimates: a row's html is width-free, so every built row keeps it.
    // ceiling: O(active + Done) per width change, i.e. every frame of a window-resize drag — 20k Done: 11.7 vs 7.8 est-ms a frame
    // with Done hidden. Re-estimate only the rows a window reaches if a resize drag stutters.
    _reEstimate() { for (const m of [_model, _doneModel]) if (m) { m.total = 0; for (const e of m.ent) m.total += e.h = _hCache.get(e.id) ?? (e.r ? this._rowEst(e.r) : SEC_H); } },
    // The list's first-entry position in scroll coordinates, READ off the DOM (the top spacer's own top)
    // rather than computed: everything above the window that can change height — the controls, an open
    // composer pulled up over its row, the whole active list above the Done one — is absorbed instead of guessed at.
    _listOrigin(sc, sel) {
      const rowsEl = document.querySelector(sel); if (!rowsEl) return 0;
      const el = rowsEl.firstElementChild || rowsEl.parentElement;
      return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    },
    // Fold the LIVE heights of the rendered entries back into the model: the list's size memory, without which
    // the spacers, and so the scrollbar, drift.
    // Measured ONCE per element per width generation (`_fitV`, same key _fit stamps with): a row's height is
    // a function of its content and the width, and scrolling changes neither. That is not a micro-saving —
    // this runs at the top of every pass, right after the previous pass wrote to the DOM, so ANY read here
    // forces a whole layout. Skipping the read on a steady-state frame removes that layout entirely.
    // A 0 height is a row hidden by an edit or a drag: don't cache the hole and don't stamp it, so it is
    // measured for real once it is.
    _measure(m) {
      const rowsEl = document.querySelector(m.sel); if (!rowsEl) return;
      for (const el of rowsEl.children) {
        if (el._mV === _fitV) continue;
        const i = m.ix.get(el.dataset.id); if (i == null) continue;   // spacers: no entry, nothing to measure
        const h = el.offsetHeight; if (!h) continue;
        el._mV = _fitV;
        if (h !== m.ent[i].h) { _hCache.set(el.dataset.id, h); m.total += h - m.ent[i].h; m.ent[i].h = h; }
      }
    },
    // The open edit composer sits in the run of rows, pulled up over entry k and `x` px taller than it, with k's
    // subtree hidden under it: in SCROLL px, entry k spans the composer and its subtree spans nothing. `sp` is an
    // entry's SPACER px (subtree zeroed; the composer is its own element). Modelling neither — the window was
    // only widened by the composer's height — windowed the rows past it far below the fold: a blank band (B1).
    // A DRAGGED task's subtree is out of the list until the drop, so it spans nothing too: counted, the window
    // disagreed with the DOM and every re-window near the list's end flipped its height (list-dnd "subtree stays hidden").
    _editShift(m) {
      const ent = m.ent, c = this.$refs.composer, k = _editPin != null && this.composer.open ? m.ix.get(_editPin) : undefined;
      const g = _dragDescs?.size ? _dragDescs : null, h = g ? i => g.has(ent[i].id) ? 0 : ent[i].h : i => ent[i].h;
      let gd = 0; if (g) for (const id of g) { const i = m.ix.get(id); if (i != null) gd += ent[i].h; }   // O(subtree), any layout
      if (k == null || c?.parentElement !== document.querySelector(m.sel)?.parentElement) return { k: -1, x: 0, d: gd, lead: 0, sp: h };
      let n = k + 1, d = 0; while (n < ent.length && ent[n].d > ent[k].d) d += ent[n++].h;   // ceiling: O(subtree) per pass (the composer renders it anyway), index it if a 1000-child edit stutters
      // Collapsing: window the END state, reaching back `lead` px for every row that rises through the viewport on the way.
      const live = c.offsetHeight, to = Math.min(live, _editEnd ?? live);   // min: a close that grows (a short composer over a taller block) only pushes rows down
      return { k, x: to - this.startH, lead: live - to, d: d + gd, sp: i => i > k && i < n ? 0 : h(i) };
    },
    // Which entries must EXIST as <li>s: the scroller's client box ± a margin, plus a RUNWAY ahead of a fling.
    _winOf(m, E) {
      const sc = this._listScroller();
      if (!sc) return { s: 0, e: m.ent.length, top: 0, bot: 0 };
      // A fling outruns a FIXED margin once one frame scrolls further than it (a slow phone frame at speed — B5).
      // Bands start once a frame outlasts margin ÷ speed (~75ms at 8000px/s), so the travel direction gets
      // _winRun ms of runway (capped at 2× the margin), at the speed the scroll listener measured.
      const g = Math.min(2 * WIN_MARGIN, Math.abs(_winV) * _winRun), o = sc.scrollTop - this._listOrigin(sc, m.sel), H = sc.clientHeight;
      const n = m.ent.length, { k, x, sp } = E, h = i => sp(i) + (i === k ? x : 0);
      // ceiling: span, the `top` walk, _winHtml's split and _modelTop walk from entry 0 — O(rows above), 0.6ms/frame at 5000 rows
      // on 16× CPU vs ~4ms for _measure (_bench_window). A prefix sum + binary search once _winOf's split there passes ~2ms.
      // Either list: Done grows without bound (every completed task; app.perf seeds 20k).
      const span = (y0, y1) => { let y = 0, s = 0, e; while (s < n && y + h(s) <= y0) y += h(s++); for (e = s; e < n && y < y1; e++) y += h(e); return { s, e }; };
      const box = pad => span(o - pad - (_winV < 0 ? g : 0) - E.lead, o + H + pad + (_winV > 0 ? g : 0)), need = box(WIN_KEEP);
      // HYSTERESIS: keep the rendered window while it still covers the box ± WIN_KEEP (+ runway). Any pass that
      // changes the list's DOM pays a fixed style/layout/PrePaint bill however few rows it moved (~35ms of
      // PrePaint alone at 16× CPU), so sliding every frame paid it every frame; this pays it every ~400px.
      let kept = _win.get(m);
      if (!(kept && kept.s <= need.s && kept.e >= need.e)) _win.set(m, kept = box(WIN_MARGIN));
      const { s, e } = kept;
      let y = 0, top = 0;
      for (let i = 0; i <= e; i++) { if (i === s) top = y - (s > k ? x : 0); if (i < e) y += h(i); }
      return { s, e, top, bot: Math.max(0, m.total - E.d + x - y) };
    },
    // WINDOWED parts for a list (the active one or Done): the rows near the viewport, bracketed by two spacer <li>s that hold
    // the elided rows' summed height so the scrollbar stays honest. A spacer is omitted when its side is
    // empty, which keeps `.sec-row:first-child` on the list's real first head.
    // Pure over visibleRows() — deliberately does NOT read `editing`, so opening the composer never rebuilds
    // the list; the edited-row crossfade + subtree-hide are stamped imperatively by applyEditDom().
    listHtml() { return this._winHtml(this._listModel()); },
    doneHtml() { return this._winHtml(this._doneListModel()); },
    _winHtml(m) {
      if (!m.ent.length) return [];
      this._measure(m);
      const E = this._editShift(m), w = this._winOf(m, E), out = this._parts(m.ent, w.s, w.e).filter(p => !_dragDescs?.has(p.id));
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
        let hA = 0; for (let i = from; i <= k; i++) hA += E.sp(i);
        let hB = 0; for (let i = k + 1; i < to; i++) hB += E.sp(i);
        const o = m.ent[k].order;
        return [...(hA ? [pad(idA, o - 1, hA)] : []), ...(hB ? [pad(idB, o + 1, hB)] : [])];
      };
      // The grabbed row stays drawn however far the list scrolls (windowed out, a held finger loses its row and a mouse its dragend),
      // between two spacers that hold the rest. ceiling: an open composer's split spacer on the same side wins (a phone never drags with it open); merge the two if a desktop drag past it loses its row
      const g = _dragGrab != null ? m.ix.get(_dragGrab) : undefined, keep = (from, to, idA, idB) => {
        let hA = 0; for (let i = from; i < g; i++) hA += E.sp(i);
        let hB = 0; for (let i = g + 1; i < to; i++) hB += E.sp(i);
        const o = m.ent[g].order;
        return [...(hA ? [pad(idA, o - 1, hA)] : []), ...this._parts(m.ent, g, g + 1), ...(hB ? [pad(idB, o + 1, hB)] : [])];
      };
      const [t1, t2, b1, b2] = ['top', 'top2', 'bot', 'bot2'].map(s => m.pad + s);
      if (w.top) out.unshift(...(k < w.s ? split(0, w.s, t1, t2) : g < w.s ? keep(0, w.s, t1, t2) : [pad(t1, (m.ent[w.s]?.order ?? 0) - 1, w.top)]));
      if (w.bot) out.push(...(k >= w.e ? split(w.e, m.ent.length, b2, b1) : g >= w.e ? keep(w.e, m.ent.length, b2, b1) : [pad(b1, (m.ent[w.e - 1]?.order ?? 0) + 1, w.bot)]));
      return out;
    },
    // Both lists' parts before either morph: each pass reads layout, and a morph between them would force a second one.
    // ceiling: Done's window is placed off the active list's PRE-morph height, so a pass that resizes the active list leaves Done's
    // window off by that delta until the next pass; window Done after the active morph if a band shows at Done's top edge.
    _paintRows() {
      const el = document.querySelector('.surface-lists .rows'), done = document.querySelector('.list-done .rows');
      const parts = el && this.listHtml(), doneParts = done && this.doneHtml();
      if (el) this.renderRows(el, parts);
      if (done) this.renderRows(done, doneParts);
      // #83: the list pads its top by what the lifted rows above the grab took, so a still pointer keeps its row (and slot)
      // even scrolled to the top; dropped, the pad leaves as they come back. Scroll anchoring sits the lift out (see
      // _liftSubtree): scrolled past those rows, it would move the list by them too.
      // ceiling: a blank band of their height tops the list while they're lifted; collapse it once the drag ends if it reads as a gap
      const list = el?.closest('.list'), grab = _liftTop != null && this._rowEl(_dragGrab);
      if (grab) list.style.paddingTop = Math.max(0, _liftTop - grab.offsetTop) + 'px';
      else if (!_dragIds) list?.style.removeProperty('padding-top');
      if (_liftTop != null) requestAnimationFrame(() => requestAnimationFrame(() => this._listScroller()?.style.removeProperty('overflow-anchor')));
      _liftTop = null;
    },
    // Imperative row state, by id, onto an <li> a morph created (a kept one keeps its classes; each state's writer restamps live rows).
    _stampRow(el) {
      const id = el.dataset.id, c = el.classList;
      if (id === this.editing) { c.add('editing-row'); el.style.height = this.startH + 'px'; }
      // The edited subtree, asked LIVE: a snapshot at open missed subtasks added while editing — the window (_editShift)
      // modelled them under the composer, the list still drew them, and every row past it came in that much late.
      else if (this.editing && this._chain(this.byId.get(id)?.parent_id).includes(this.editing)) c.add('edit-hidden');
      if (id === this.focusId) { c.add('kbfocus'); _kbEl = el; }
      if (this.dragId && _dragIds?.has(id)) c.add('dragging');   // every carried row, not just the grabbed one
      if (id === _dropEl?.dataset.id) { c.add('drop-into'); _dropEl = el; }
      const slot = _arrive.get(id);
      if (slot != null && !c.contains('edit-hidden')) {
        _arrive.delete(id);
        if (this.celebrations !== 'off' && this.surface === 'lists') {
          const delay = motion.gentle ? 0 : Math.min(slot, 6) * 60, opts = { duration: 400, delay, easing: DESIGN.ease.pop };   // requested arrival: a small, appreciable spring, 60ms stagger capped at 360ms
          motion.go(null, el, { translate: ['0 var(--sp-6)', '0 0'] }, { ...opts, id: 'arrival' });
          motion.go(null, el, { opacity: [0, 1] }, { ...opts, easing: DESIGN.ease.out });
          motion.go(null, el.querySelector('.check'), { scale: [.6, 1] }, { ...opts, delay: delay + (motion.gentle ? 0 : 60) });   // the row's own tick follows by 60ms
          motion.go(null, el, { backgroundColor: ['color-mix(in oklch, var(--accent) 12%, transparent)', 'transparent'] }, { ...opts, duration: 700, easing: DESIGN.ease.out });   // requested wash: a longer, faint tail
        }
      }
      _push.get(id)?.(el);
      const fx = _cele.get(id);
      if (fx && this.byId.get(id)?.completed_at) {
        c.add('cele', fx.mode, ...fx.leave ? ['leave'] : []);
        if (fx.ember) el.querySelector('.check')?.insertAdjacentHTML('beforeend', fx.ember);
      }
    },
    // The scroll-coordinate top of an entry, straight out of the model — a windowed list can be asked to go
    // to a row that has no element at all.
    _modelTop(id) {
      const m = this._modelOf(id), sc = this._listScroller();
      if (!m || !sc) return null;
      const i = m.ix.get(id), { k, x, sp } = this._editShift(m);
      let y = this._listOrigin(sc, m.sel) + (i > k ? x : 0);
      for (let j = 0; j < i; j++) y += sp(j);
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
    // and all. The stamp ends an in-flight tween on its next frame (`sc._userAt > t0`). The open's in-view hold
    // can't be made "live" instead: re-asserting a CONSTANT against layout drift is its whole job, and a target
    // that re-reads scrollTop is a hold that holds nothing.
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
    // The window's spacers hold the list's total height, so a morph cannot change it or move the reader.
    // All 4 rows containers use this.
    renderRows(el, parts) {
      const prev = el._parts;
      if (prev === parts || (prev && prev.length === parts.length && parts.every((p, i) => p.html === prev[i].html))) return;
      const before = _arrive.size && el.closest('.surface-lists') && this._rowTops();
      el._parts = parts; const made = this.morphRows(el, parts);
      if (made.length && el.closest('.surface-lists')) { queueMicrotask(() => { for (const n of made) this._stampRow(n); this.paintSel(); this._rehover(); }); this.fitRows(); }   // list rows only; a microtask reads the state subscribing no effect
      else if (made.length && el.closest('.cl-side')) this._fitSide(el.closest('.cl-side'), made);
      if (before) queueMicrotask(() => this._glideFrom(before, false));
    },
    // Parses ONLY the rows whose html actually changed: a one-field save never does the work of a full rebuild.
    morphRows(container, parts) {
      const old = new Map();
      for (const el of container.children) old.set(el.dataset.id, el);
      // Drop what's LEAVING before placing what stays. A windowed list slides its range every frame, and with
      // the departing rows still sitting in front of the cursor every surviving row got insertBefore'd past
      // them — a DOM move per row per frame (measured: ~12/frame of pure churn during a fling).
      const want = new Set(); for (const p of parts) want.add(p.id);
      for (const [id, el] of old) if (!want.has(id)) { el.remove(); old.delete(id); }
      let cursor = container.firstElementChild, tpl = null; const made = [];
      for (const p of parts) {
        const cur = old.get(p.id);
        let node = cur;
        if (!cur || cur._sig !== p.html) {   // changed (or new) → this is the only row we pay to parse
          (tpl || (tpl = document.createElement('template'))).innerHTML = p.html;
          node = tpl.content.firstElementChild;
          if (cur?.matches(':hover')) {   // patch the row under the pointer in place: a fresh <li> isn't :hover until the mouse next moves (a frame untinted)
            for (const name of cur.getAttributeNames()) if (!node.hasAttribute(name)) cur.removeAttribute(name);
            for (const attr of node.attributes) cur.setAttribute(attr.name, attr.value);
            cur.replaceChildren(...node.childNodes); node = cur;
          }
          node._sig = p.html; made.push(node);
        }
        if (cur === cursor) { cursor = cursor.nextElementSibling; if (node !== cur) container.replaceChild(node, cur); }   // same slot: keep or swap in place
        else { if (cur && node !== cur) cur.remove(); container.insertBefore(node, cursor); }                             // reorder: drop the stale node (a fresh one replaces it), then place; new id → just insert
      }
      return made;   // the created <li>s: the only ones without the list's imperative state
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
      const hasKids = kids.some(c => !inNotes(c)), hasCl = cl.length > 0;   // a note child never fills the ring
      const blockers = openBlockers(t, byId), files = t.attachments ?? [];   // a done blocker leaves the row
      // n: the kind's count, on its first chip, which stands for them all once that kind rolls (_relIcon)
      const rels = [...blockers.map((id, i) => ({ id, type: 'blocked_by', icon: 'i-stop', name: byId.get(id).content, label: 'Blocked by ' + byId.get(id).content, n: !i && blockers.length > 3 ? blockers.length : 0 })),
        ...files.map((id, i) => ({ id, type: 'file', icon: 'i-file', name: this.fileName(id), label: this.files[id] ? 'File ' + this.files[id].name : 'File unavailable', n: !i && files.length > 3 ? files.length : 0 }))];
      // Steps: the row leads with the first open step (stored order), or the last once all are done, so a done one still reads as steps; the pie counts steps, never subtasks.
      const si = t.task_type === 'steps' && !t.checklist_plain ? (i => i < 0 ? cl.length - 1 : i)(cl.findIndex(x => !x.done)) : -1;
      const em = edMemo ? this.effDurMin(t, byParent, edMemo) : (t.est_minutes || 0);   // roll up subtasks when no own duration
      // ONE date fact: the placement (or, for a repeat, whenShown). Either is an INTENTION, so a passed one never
      // wears the overdue band's fill, only the deadline red as a line.
      const when = this.whenShown(t, pm);
      let dueB = when ? windowBadge({ available_from: t.available_from, recur_from: when, completed_at: t.completed_at }, now) : null;
      if (dueB?.kind === 'overdue') dueB = { ...dueB, kind: 'missed' };
      return {
        t, depth, pc: this.pc(t.importance), collapsed: !!this.collapsed[t.id],
        note: inNotes(t),   // note → inert dot instead of the checkbox
        // Precomputed here (cached in _visMemo) so a state-only re-render doesn't redo the title regex / checklist split per row.
        titleHtml: mdTitleFn(t.content),
        chk: cl.map(chkParts),
        step: si >= 0 ? chkParts(cl[si], si) : null,
        next: si >= 0 ? (n => n >= 0 ? chkParts(cl[n], n) : null)(cl.findIndex((x, j) => j > si && !x.done)) : null,   // the preview: the next OPEN step after the current one
        // The row shows the SIZE BUCKET as a glyph; est (the precise duration) survives only as its tooltip, so
        // the row carries the scheduling decision at a glance and the exact number is still one hover away.
        est: em ? this.durFmt(em) : '', estSize: sizeFromMinutes(em), estRollup: !t.est_minutes && em > 0,
        // specific clock time on the date — only for near dates (today/tomorrow/weekday badges)
        dueTime: when.length > 10 && ['today', 'soon'].includes(dueB?.kind) ? this._clTime(when) : null,
        loc: this.rowLoc(t),
        locX: t.location?.mode === 'except',   // away-from → negated pin

        rels,
        due: dueB,
        dl: t.deadline_at ? deadlineLeft(t.deadline_at, now) : null,
        projName: parent ? parent.content : '',
        projColor: parent && parent.color ? 'color:' + parent.color : '',
        isDefaultProj: !!t.parent_id && t.parent_id === def,
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        childCount: kids.length,
        hasProgress: hasKids || hasCl,
        progress: this.rowProgress(t, si >= 0 ? [] : kids),
        blocked: blockers.length > 0,
      };
    },
    // Enter keyboard navigation where the reader is, not at the corpus boundary.
    moveFocus(d) {
      const rows = this.visibleRows(), done = _doneMemo, n = rows.length + done.length;   // the Done list (empty unless shown) continues the open one
      if (!n) { this._setKbFocus(null); return; }
      const sc = this._listScroller(), box = sc?.getBoundingClientRect();
      const onScreen = el => { const r = el?.getBoundingClientRect(); return r && box && r.height > 0 && r.bottom > box.top && r.top < box.bottom; };
      const pos = id => _rowMap.get(id)?.i ?? (_doneMap.has(id) ? rows.length + _doneMap.get(id).i : -1), idAt = k => (k < rows.length ? rows[k] : done[k - rows.length]).t.id;
      let cur = pos(this.focusId);
      if (cur < 0 || !onScreen(this._rowEl(this.focusId))) {
        const at = [...sc.querySelectorAll('.list .item')].filter(onScreen).map(el => pos(el.dataset.id)).filter(k => k >= 0);   // the window's rows, not a corpus scan
        if (at.length) { this._setKbFocus(idAt(d > 0 ? Math.min(...at) : Math.max(...at))); return; }
        cur = -1;
      }
      this._setKbFocus(idAt(cur < 0 ? (d > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + d))));
    },
    // --- Multi-select (Ctrl/Cmd-click toggle, Shift-click / Shift+↑↓ range) ---
    selTasks() { return this.sel.map(id => this.byId.get(id)).filter(Boolean); },
    toggleSel(id) { const i = this.sel.indexOf(id); this.sel = i >= 0 ? this.sel.filter(x => x !== id) : [...this.sel, id]; this.selAnchor = id; },
    clearSel() { this.sel = []; this.selAnchor = null; this.selMenu = null; },
    selectRange(id) {   // anchor..id in visibleRows order (anchor stays put so repeated Shift-clicks pivot from it)
      const rows = this.visibleRows();
      const a = _rowMap.get(this.selAnchor ?? id)?.i ?? -1, b = _rowMap.get(id)?.i ?? -1;
      if (a < 0 || b < 0) return this.toggleSel(id);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      this.sel = rows.slice(lo, hi + 1).map(r => r.t.id);
      this._setKbFocus(id);
    },
    selExtend(d) {   // Shift+↑/↓ — grow/shrink the anchor..focus range by one row
      const rows = this.visibleRows(); if (!rows.length) return;
      if (this.selAnchor == null || !this.sel.length) { this.selAnchor = this.focusId ?? rows[0].t.id; this.focusId = this.selAnchor; }
      const cur = (_rowMap.get(this.focusId) ?? _rowMap.get(this.selAnchor))?.i ?? -1;
      this.selectRange(rows[Math.max(0, Math.min(rows.length - 1, cur + d))].t.id);
    },
    // Paint .selected + run-position classes imperatively — O(selected) diff.
    // Contiguous selected rows form a rounded group: sel-top/sel-mid/sel-bot/sel-single (mirrors .inblock rounding).
    paintSel() {
      this.visibleRows();   // deps: the selection, and the rows (a run's neighbours)
      // a row folded, filtered, searched or deleted away leaves: the edit bar and a drag act on listed rows only
      const shown = this.sel.filter(id => _rowMap.has(id) || _doneMap.has(id));
      if (shown.length < this.sel.length) this.sel = shown;
      const ns = new Set(shown); if (!ns.size && !_selSet.size) return;
      queueMicrotask(() => {   // not $nextTick: Alpine holds it while the edit bar's x-transition starts — the highlight painted a frame late
        const RUN = ['sel-top', 'sel-mid', 'sel-bot', 'sel-single'];
        const byEl = new Map([...document.querySelectorAll('.surface-lists .list .item[data-id]')].map(el => [el.dataset.id, el]));   // the open list and the Done list
        for (const id of _selSet) if (!ns.has(id)) byEl.get(id)?.classList.remove('selected', ...RUN);
        for (const id of ns) {   // run position from the row's walk neighbours, each list its own
          const el = byEl.get(id), r = _rowMap.get(id) ?? _doneMap.get(id); if (!el || !r) continue;
          const p = ns.has(r.prevId), n = ns.has(r.nextId), run = !p && n ? 'sel-top' : p && n ? 'sel-mid' : p && !n ? 'sel-bot' : 'sel-single';
          if (!el.classList.contains(run)) { el.classList.remove(...RUN); el.classList.add('selected', run); }   // unchanged rows untouched: an extend rewrites ~2, not the run
        }
        _selSet = ns;
      });
    },
    // Bulk actions — each routes through perform() as ONE composite op, so a single ⌘Z reverses the whole batch.
    _nTasks(n) { return n + (n === 1 ? ' task' : ' tasks'); },   // labels show up verbatim in the Bin and the undo toast — "Deleted 1 tasks" is a tell
    async _bulk(label, ops, keep) {   // a failed batch keeps its selection (the retry is one click), minus rows a partial one took; `keep`: a drag's keeps it either way
      const sel = this.sel;   // a delete's rows leave sel while it runs; a failure's rollback puts them back
      if (ops.length && !await this.perform(label, { kind: 'composite', target: ops[0].target, ops }, { bin: true })) this.sel = sel.filter(id => this.byId.has(id));
      else if (!keep) this.clearSel();
    },
    async selComplete() {
      const ops = this.selTasks().filter(t => !t.completed_at && !t.archived_at && !inNotes(t)).map(t => ({ kind: 'complete', target: 'task', mode: 'forward', fwd: { id: t.id, done: true } }));
      await this._bulk(`Completed ${this._nTasks(ops.length)}`, ops);
    },
    _selRoots(ids = this.sel) { const s = new Set(ids); return ids.filter(id => !this._chain(this.byId.get(id)?.parent_id).some(a => s.has(a))); },   // a selected ancestor carries its subtree
    async selDelete() {   // deleting a descendant again fails the batch
      await this._bulk(`Deleted ${this._nTasks(this.sel.length)}`, this._selRoots().map(id => ({ kind: 'delete', target: 'task', id })));
    },
    async selSetPrio(v) {
      await this._bulk(`Set priority · ${this._nTasks(this.sel.length)}`, Array.from(this.sel, id => ({ kind: 'update', target: 'task', id, after: { importance: v } })));
    },
    async selMoveToProject(p) {
      const kids = childIndex(this.tasks);   // once per batch, not per selected row
      if (this.sel.some(id => descendantIds(this.tasks, id, kids).includes(p.id))) return this.toast('Cannot move a task into itself or its subtasks');
      const ids = this._selRoots(), at = projectDepth(this.tasks, p.id);   // reparenting a selected descendant too would flatten it out of its parent
      if (ids.some(id => at + subtreeDepth(this.tasks, id, kids) > MAX_DEPTH)) return this.toast(`Too deep. Tasks nest at most ${MAX_DEPTH} levels`);
      // drag's path (railDrop): move() closes a parent its last open subtask left. A failed move keeps the selection: the retry is one click
      if (await this._moveTask(ids, p.id, [...this.childTasks(p.id).flatMap(x => ids.includes(x.id) ? [] : [x.id]), ...ids], { label: n => `Moved ${this._nTasks(n === ids.length ? this.sel.length : n)} to ${p.content}`, bin: true })) this.clearSel();   // n: the roots that landed
    },
    async selAddArea(a, keep) {
      const ops = this.selTasks().filter(t => !(t.area_ids || []).includes(a.id)).map(t => ({ kind: 'update', target: 'task', id: t.id, after: { area_ids: [...(t.area_ids || []), a.id] } }));
      await this._bulk(`Tagged ${this._nTasks(ops.length)} · ${a.name}`, ops, keep);
    },
    // shift each selected task's PLACEMENT by the SAME delta (relative spacing preserved); only placed tasks
    // move — a repeat's recur_from is its rule anchor, not a date to drag, so it stays put.
    _shiftIso(iso, days) { const dateOnly = iso.length <= 10; const d = new Date(dateOnly ? iso + 'T00:00' : iso); d.setDate(d.getDate() + days); const day = isoDate(d); return dateOnly ? day : day + iso.slice(10); },
    async selShiftDue(days) {
      const ops = this.selTasks().map(t => this._siOf(t.id)).filter(Boolean)
        .map(si => ({ kind: 'update', target: 'scheduleItem', id: si.id, after: { date: this._shiftIso(si.date, days) } }));
      if (!ops.length) { this.clearSel(); return this.toast('No dates to shift'); }
      await this._bulk(`Shifted ${ops.length} date${ops.length > 1 ? 's' : ''}`, ops);
    },
    // a focused row folded away (its parent or section) is no target — j/k treat it as no focus too
    focusedTask() { return this.rowIndexOf(this.focusId) < 0 ? null : this.byId.get(this.focusId); },
    openFocused() { const t = this.focusedTask(); if (t) this.editTask(t); },
    toggleFocused() { const t = this.focusedTask(), step = t && _rowMap.get(t.id)?.step; if (step) this.toggleChk(t.id, step.ci); else if (t) this.toggle(t); },   // a Steps row ticks its step, like its check
    toggleShowCompleted() {
      this.showCompleted = !this.showCompleted;
      localStorage.setItem('adherod.list.showCompleted', this.showCompleted ? '1' : '0');   // persist across sessions (visibleRows keys on it)
    },
    toggleTaskCollapse(id) {
      this.collapsed = { ...this.collapsed, [id]: !this.collapsed[id] };
      this._foldV++;
      for (const side of Object.values(_clSideOut)) side.html.delete(id);   // the Plan tray draws the same chevron
      localStorage.setItem('adherod.nav.collapsed', JSON.stringify(this.collapsed));
    },
    overviewProjectRows() {   // all overview projects at all depths always shown (roller uses this)
      // ONE position-sorted byParent index: the old form re-scanned every task for each project it found (O(projects·tasks) per roller paint).
      const rows = [], seen = new Set(), def = this.store.defaultProject(), byP = buildByParent(this.tasks), visit = (parentId, depth, shelved) => {
        for (const p of byP.get(parentId) || []) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          const gone = shelved || !!p.archived_at, shown = p.overview && p.id !== def && !gone;   // gone: under an archived row (_shelved, walked)
          if (shown) rows.push({ p, depth });
          visit(p.id, depth + (shown ? 1 : 0), gone);   // hidden parents must not hide overview descendants
        }
      };
      visit(null, 0, false);
      for (const p of this.tasks) if (p.overview && !seen.has(p.id)) visit(p.parent_id, 0, this._shelved().has(p.parent_id));   // legacy cycles/orphans remain navigable without rewriting data
      return rows;
    },
    rollerItems() {
      // no 'all' item: "All tasks" is a seeded, removable filter in the Filters section
      const it = [{ kind: 'sec', label: 'Projects' },
                  { kind: 'backlog', type: 'backlog', id: null, label: 'Backlog' }];
      for (const { p, depth } of this.overviewProjectRows())
        it.push({ kind: 'proj', type: 'project', id: p.id, label: p.content, depth, p });
      // Projects end with the archived ones, folded into one row: the top of each archived tree, latest first
      const shelved = this._shelved(), arch = this.tasks.filter(t => t.overview && t.archived_at && !shelved.has(t.parent_id)).sort((a, b) => b.archived_at.localeCompare(a.archived_at));
      if (arch.length) it.push({ kind: 'arch', label: 'Archived', n: arch.length, open: this.ovArchOpen });
      if (this.ovArchOpen) for (const p of arch) it.push({ kind: 'proj', type: 'project', id: p.id, label: p.content, depth: 1, p, archived: true });
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
      if (it.kind === 'arch') { this.ovArchOpen = !this.ovArchOpen; return; }
      if (it.kind === 'loc') { this.locMgr = true; this.loadLocations(); return; }   // dialog layers over the overview (z 200 > 60); leave the overview open behind it
      this.setNav(it.type, it.id); this.closeOverview();
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
      return this.tasks.filter(x => x.parent_id === p.parent_id && x.overview && x.id !== this.store.defaultProject()).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    },
    async navReorder(kind, id, dir) {
      const sibs = this._navSibs(kind, id), i = sibs.findIndex(x => x.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= sibs.length) return;   // already at an end — a no-op, not an error
      const ids = sibs.map(x => x.id); [ids[i], ids[j]] = [ids[j], ids[i]];
      const api = kind === 'area' ? this.store.areas : kind === 'filter' ? this.store.filters : this.store.tasks;
      if (!await api.reorder(ids)) return this.toast('Failed reordering');
      await this._reloadFor(kind === 'area' || kind === 'filter' ? kind : 'task');
    },
    // The rail lists filters and areas but had no way to MAKE one — filters were reachable only by saving a
    // search, areas only as a side effect of tagging a task. A new area is created named and then opened straight
    // into its rename popover: an abandoned add leaves a real, visible, deletable area, never a half-made thing.
    async rollerAdd(kind, r) {
      if (kind === 'filter') return this.openFilterEditor();
      const a = await this.store.areas.create({ name: 'New area' });
      if (!a) return this.toast('Failed adding area');
      await this._reloadFor('area');
      this._navPopAt(r);
      this.startRename(a.id);
    },
    // One tree index and one open-per-area tally per paint, shared by every row: per row they made it O(projects·tasks).
    _rollerIdx() {
      const areaOpen = new Map();
      for (const t of this.tasks) if (!t.completed_at && !t.archived_at && !inNotes(t)) for (const a of t.area_ids || []) areaOpen.set(a, (areaOpen.get(a) || 0) + 1);
      return { kids: childIndex(this.tasks), areaOpen };
    },
    rollerCount(it, ix = this._rollerIdx()) {
      const open = t => t && !this.isOverviewProject(t) && !t.completed_at && !t.archived_at && !inNotes(t);   // a note is reference, not work
      if (it.kind === 'backlog') { const d = this.store.defaultProject(); return this.tasks.filter(t => open(t) && t.parent_id === d).length; }
      if (it.kind === 'proj') return descendantIds(this.tasks, it.id, ix.kids).filter(id => open(this.byId.get(id))).length;   // the root is a project, so open() drops it
      if (it.kind === 'area') return ix.areaOpen.get(it.id) || 0;
      if (it.kind === 'filter') { try { return this.store.runFilter(it.f.query).length; } catch { return ''; } }
      return '';
    },
    rollerData(it, ri, ix) {   // enrich a roller item with the icon/color/count/progress the box needs
      const d = { ...it, ridx: ri, count: this.rollerCount(it, ix) };
      if (it.kind === 'proj') { d.color = it.p.color || ''; d.icon = 'prog'; d.progress = this.projectProgress(it.id, ix?.kids) / 100; }
      else if (it.kind === 'area') { d.icon = it.l.icon || 'i-tag-tag'; d.color = it.l.color || this.areaDefault; }
      else if (it.kind === 'filter') { d.icon = it.f.query === 'is:any' ? 'i-all' : 'i-search'; d.color = it.f.color || ''; }   // the 'All tasks' null filter keeps its original glyph; filters aren't otherwise icon-configurable
      else if (it.kind === 'backlog') d.icon = 'i-backlog';
      else if (it.kind === 'loc') { d.icon = 'i-tag-map'; d.count = ''; }
      else if (it.kind === 'arch') { d.icon = 'i-archive'; d.count = it.n; }
      if (it.archived) d.count = '';   // nothing in it is open
      return d;
    },
    rollerRows() {   // rollerItems with section headers kept inline; non-sec rows carry a running focus index (ridx)
      let ri = -1; const out = [], ix = this._rollerIdx();
      for (const it of this.rollerItems()) out.push(it.kind === 'sec' ? { sec: true, label: it.label, add: it.add } : this.rollerData(it, ++ri, ix));
      return out;
    },

    // --- Nav management ---
    projectProgress(id, kids) {
      const ids = descendantIds(this.tasks, id, kids).slice(1).filter(x => !inNotes(this.byId.get(x)));   // notes aren't work
      if (!ids.length) return 0;
      return Math.round(ids.filter(x => this.byId.get(x)?.completed_at).length / ids.length * 100);
    },
    startRename(id) { this.navRename = id; this.navPop = null; this.$nextTick(() => this.$nextTick(() => { const i = document.querySelector('.nav-pop .pop-input'); if (i) { i.focus(); i.select(); } })); },   // select: a rename usually replaces, and a just-added area opens on its placeholder
    async saveRename(p, name) {
      name = name.trim(); this.navRename = null;
      if (!name) return;
      if ('name' in p) { if (name !== p.name) await this._journalRowChange('Renamed area', 'area', p.id, () => this.store.areas.update(p.id, { name })); }
      else if (name !== p.content) await this._journalRowChange('Renamed project', 'task', p.id, () => this.store.tasks.update(p.id, { content: name }));
    },
    async patchTask(id, fields, label = 'Edited project') { await this._journalRowChange(label, 'task', id, () => this.store.tasks.update(id, fields)); this.navPop = null; },
    async patchArea(id, fields) { await this._journalRowChange('Edited area', 'area', id, () => this.store.areas.update(id, fields)); this.navPop = null; },
    // The nav settings popover renders at the overview level (not inside the clipping roller) — resolve its entity here.
    navPopProj() { return this.navPop?.type === 'proj' ? this.byId.get(this.navPop.id) : null; },
    navPopArea() { return this.navPop?.type === 'area' ? this.areas.find(l => l.id === this.navPop.id) : null; },
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
    // Row HTML while finding: raw text + <mark> sub-matches (md/:: styling pauses for the transient
    // state; textContent contract for the caret still holds — mark wraps text only).
    chkHl(c) { const r = this.chkFind()?.get(c.id); return r?.length ? markTitle(c.text, r, c.text.length) : _memo(_chkHtml, c.text, () => chkLiveRender(c.text), 1000); },
    async deleteArea(id) {
      this.navPop = null;
      if (!this.areas.some(a => a.id === id)) return;
      if (!await this.perform('Deleted area', { kind: 'delete', target: 'area', id })) return false;   // a failed delete keeps the user on the area
      if (this.navSel.type === 'area' && this.navSel.id === id) this.setNav('all');
      return true;
    },
    descendantCount(id) { return id ? descendantIds(this.tasks, id).length - 1 : 0; },   // tasks INSIDE (excl. the project itself)
    delTargets() {
      if (!this.delAsk) return [];
      const excl = new Set(descendantIds(this.tasks, this.delAsk.id)), def = this.store.defaultProject();
      if (this.delAsk.kind === 'project') return this.tasks.filter(p => !excl.has(p.id) && this.hasChildren(p.id));
      return this.tasks.filter(p => !excl.has(p.id) && (p.id === def || p.overview || this.hasChildren(p.id)));
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
    // journal entry by hand (a composite of "reinsert id" + "move each child back"): this call's DB-level
    // atomicity must not be split across two ops.
    async _deleteReparent(label, id, target) {
      const row = this.byId.get(id); if (!row) return false;
      const taskRow = JSON.parse(JSON.stringify(row)), refs = this._taskRefs([taskRow]);
      const kids = this.tasks.filter(t => t.parent_id === id).map(c => ({ id: c.id, parent: c.parent_id ?? null, pos: c.position }));
      const fx = this._fxSnap([...this._chain(row.parent_id), ...this._chain(target)]);   // the ancestors this remove auto-completes, the target's it reopens: undo puts both back
      const settled = await this._binAhead(label, { kind: 'delete', target: 'task', id }, [taskRow]);   // its children move, not go
      if (!settled) return false;
      const ok = await this.store.tasks.remove(id, target);
      await this._reloadAfter({ kind: 'reinsert', target: 'task' });   // the deleted-from lists, not reloadAll: its rAF races the composer close
      // signed in, the move and the DELETE are two requests: a failure may follow a move that landed — journal what did
      const gone = ok || !this.byId.has(id), moved = ok ? kids : kids.filter(k => this.byId.get(k.id)?.parent_id === target);
      settled();   // the entry below holds what landed
      if (!gone && !moved.length) { this.toast(`Failed saving “${label}”. Try again?`); return false; }
      const entry = { kind: 'composite', target: 'task', _fxCapture: fx, ops: [
        ...gone ? [{ kind: 'reinsert', target: 'task', id, rows: [taskRow], ...refs }] : [],
        ...moved.map(k => ({ kind: 'move', target: 'task', id: k.id, after: { parent: k.parent, pos: k.pos } })),
      ] };
      this._finalizeFx(entry); this._pushEntry(label, entry, { bin: gone, silent: !ok });
      if (!ok) this.toast(`“${label}” didn’t fully save. The list shows what’s saved`);
      return ok;
    },
    async confirmDelete() {
      const info = this.delAsk, d = this.draft;
      this.delAsk = null;
      if (!info || (info.mode === 'move' && !info.target)) return;
      if (info.kind === 'project') {
        const onIt = this.navSel.type === 'project' && descendantIds(this.tasks, info.id).includes(this.navSel.id);
        const ok = info.mode === 'delete' ? await this.perform('Deleted project + tasks', { target: 'task', kind: 'delete', id: info.id })
          : !this.byId.get(info.id) || await this._deleteReparent('Deleted project', info.id, info.target);
        if (ok && onIt) this.setNav('all');   // a failed delete keeps the user on the project
      } else if (info.source === 'child') { const s = this.editing && d.subs.find(x => x.id === info.id); if (s) this.removeChild(s, info.mode === 'move' ? info.target : null); }
      else {
        const ok = info.mode === 'delete' ? await this.perform('Deleted task', { target: 'task', kind: 'delete', id: info.id })
          : await this._deleteReparent('Deleted task, moved subtasks', info.id, info.target);
        if (ok && info.source === 'editing' && this._live(d)) this.closeComposer(true);   // a failed delete keeps the composer and its edits
      }
    },

    // halves = above/below; the middle 40% nests only after DWELL there, so a drag passing over never nests. A still pointer's
    // dragovers keep coming, so a stamp needs no timer; leaving the band or the row restarts it. No "into" past MAX_DEPTH.
    // A drop nests only INTO_SEEN after into was earned (listDrop): a stalled page handles a stale dragover past DWELL and the drop
    // right behind it, the nest never shown. Rate-free: the stall compresses both.
    _dropMode(e, overId) {
      const rect = e.currentTarget.getBoundingClientRect(), y = e.clientY - rect.top, h = rect.height, now = performance.now(), half = y < h * 0.5 ? 'above' : 'below';
      const band = !_dndHeld && y > h * 0.3 && y < h * 0.7 && projectDepth(this.tasks, overId) + _dragSubDepth <= MAX_DEPTH;   // a list gliding at its edge (_dndHeld) slides rows under the pointer: no rest
      if (!band) _intoAt = null;
      else if (_intoAt?.id !== overId) _intoAt = { id: overId, t: now };
      if (!band || now - _intoAt.t < DWELL) return half;
      if (_intoAt.top == null) {
        _intoAt.top = e.currentTarget.offsetTop;   // where the row sat when into was earned (listDragOver)
        _intoSeen = { t: now };
      }
      _intoSeen.half = half;
      return 'into';
    },
    // Sorted, a position ranks nothing the list shows: a slot (its parent) among the row's own siblings is refused, and one moving it to
    // another project (#90: the rail, Move or Manual do that); nest, outdent, another parent's slot in its project and the rail still land.
    _sortPins(parentId) { return this.sortBy !== 'manual' && !!_dragParents && (_dragParents.has(parentId) || _dragProjs.size > 1 || !_dragProjs.has(this._projOf(parentId))); },
    _projOf(parentId) { return this._chain(parentId).find(id => !this.taskProj(this.byId.get(id))); },   // the nearest project (or Inbox) up from parentId
    // ...and under another parent the row lands at its sorted place among the parent's SHOWN rows (_parentMap: shown order, sorted), the
    // hinted slot among ties. drop() keeps hand order among ties: after the last tie before the slot, else before the row after it.
    _sortLand(t, mode, id = this.dragId) {
      const cmp = this.sibCmp(), m = this.byId.get(id), row = _rowMap?.get(t.id);
      if (!cmp || !m || !row || mode === 'into') return { id: t.id, mode };
      const order = _parentMap.get(t.parent_id).flatMap(r => _dragIds?.has(r.t.id) ? [] : [r.t]), probe = { ...window.Alpine.raw(m) };   // raw: a proxy read per compare is 80x
      let lo = 0, hi = 0, i = 0;
      for (const [k, x] of order.entries()) { probe.position = x.position; const c = cmp(x, probe); lo += c < 0; hi += c <= 0; if (x.id === t.id) i = k; }
      const at = Math.min(Math.max(i + (mode === 'below'), lo), hi);
      const land = at > lo || at === order.length ? { id: order[at - 1].id, mode: 'below' } : { id: order[at].id, mode: 'above' };
      if (row.depth || _secMemo.length || !['all', 'area'].includes(this.navSel.type)) return land;
      // All and area roots interleave parents by the sort: `at` is where the row's new position (orderSlots, as drop() writes) ranks among them all
      const parent = t.parent_id ?? null, sibs = this.childTasks(parent).filter(x => !_dragIds?.has(x.id)), cut = sibs.findIndex(x => x.id === land.id) + (land.mode === 'below');
      const slots = orderSlots(sibs.map(x => x.position ?? 0), sibs.length + 1), slotOf = new Map(sibs.map((x, k) => [x.id, slots[k < cut ? k : k + 1]]));
      const moved = { ...probe, parent_id: parent, position: slots[cut] }, roots = _visMemo.filter(r => !r.depth && !_dragIds?.has(r.t.id));
      const next = roots.find(r => cmp(slotOf.has(r.t.id) ? { ...r.t, position: slotOf.get(r.t.id) } : r.t, moved) > 0);
      return { ...land, at: next ? { id: next.t.id, mode: 'above' } : { id: roots.at(-1).t.id, mode: 'below' } };
    },
    _sortHint() { this.toast(`Sorted by ${this.sortWord()}: switch to Manual to rearrange`); },   // a drag let go on a refused slot

    resetDraft() {
      this.draft = emptyDraft(); this.subDraft = emptyDraft(); _nlpFocus = null; _dlAuto = '';
      this.draftRestored = false;   // a blank draft restored nothing (the note's Esc clears its always-open line in place)
      this.pickerQ = ''; this.newAreaName = ''; this.projRequired = false; this.subGhost = ''; this.chkGhost = ''; this.endPicking = false; this.tpop = false; this._calDn = null; this.calH = null;
      for (const t in PICKERS) this[PICKERS[t].key] = { open: false, frag: '', sel: 0, node: null, at: 0, left: 0, top: 0 };
      this._noPillOnce = false;   // the un-chip→no-re-pill guard is per-session; never leak it across composer opens
      this._draftSid = crypto.randomUUID();   // ditto the draft identity — a rapid-add save resets the draft without reopening
    },
    pc(imp) { return `var(--p${({ must: 1, focus: 2, someday: 3 })[imp] || 4})`; },   // check color by importance — PLACEHOLDER map (user will remap): must→p1, focus→p2, someday→p3, none→p4
    impName(v, unset = 'None') { return ({ none: 'None', focus: 'Focus', must: 'Must', someday: 'Someday' })[v] || unset; },   // proper name incl. None; pass 'Importance' for picker's unset label
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
    // The LIVE card's height as-if-grown, so the grow lands where auto settles. `grown` flips on for one synchronous
    // read with transitions held (no frame ever sees it); a probe clone laid out a second copy of every row.
    fullGrow(g) {
      const card = g.firstElementChild; if (!card) return g.scrollHeight;
      g.style.transition = card.style.transition = 'none'; g.classList.add('grown');
      const cs = getComputedStyle(card), h = card.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      g.classList.remove('grown'); cs.paddingTop;   // restyle un-grown while transitions are still held
      g.style.transition = card.style.transition = '';
      return h;
    },
    // `grow` is a getter: the composer element is read at rAF time
    _growOpen(grow, start) {
      clearTimeout(this._t);
      if (this.reduceMotion()) { this.grown = true; this.clip = false; this.growH = null; return; }
      // synchronous so first frame isn't at full height (stutter)
      this.grown = false; this.clip = true; this.growH = start;
      motion.run('grow', () => this.growH !== null);   // idle() spans the measuring frames + settle timer, which no CSS event reports
      const settle = () => { this.growH = null; this.clip = false; this._reflow(); };   // to auto; the list re-windows once, here
      let t = this._t = --_growGen;   // this open's generation; becomes the settle timer once the grow starts
      // Measured the frame AFTER the grow mounts: x-show's deferred hides (a rAF) have landed by then.
      // Not past $nextTick — Alpine holds it while the entry ghosts' x-transition starts (entry-less opens grew 2 frames late).
      // Each step bails once a re-open/close supersedes THIS open (`_t`): a stale measure stripped the live
      // `grown` class for good (opacity 0), a stale growH pinned the height.
      requestAnimationFrame(() => {
        if (this._t !== t) return;
        const g = grow();
        // settle times from the grow's start, not the tap: a slow first paint outlasted a tap-timed one and the late grow pinned growH
        requestAnimationFrame(() => { if (this._t === t) { this.growH = this.fullGrow(g); this.grown = true; this._t = t = setTimeout(settle, 280); } });
      });
    },
    _growClose(grow, end, done) {
      clearTimeout(this._t);   // closeComposer's _closingComposer guards the rAF/timeout: a quick re-open clears it
      const g = grow(), anim = g && !this.reduceMotion();
      if (anim) {
        this.growH = g.offsetHeight; this.clip = true;   // pin the live height (already rendered, no probe needed)
        motion.run('grow', () => this.growH !== null);   // supersedes an open's; ends when the collapse unpins
        // growH null: a starved frame landed past the settle below, and collapsing now re-pinned the closed grow
        this.$nextTick(() => requestAnimationFrame(() => { if (!this._closingComposer || this.growH === null) return; this.growH = end; this.grown = false; }));
      } else { this.grown = false; }
      // reduced motion: no collapse, but the opacity fade (≤150ms) still runs; zero motion: nothing to wait out
      this._t = setTimeout(() => { if (!this._closingComposer) return; this.clip = false; this.growH = null; done && done(); }, anim ? 240 : motion.gentle ? 150 : 0);
    },
    openComposer() {
      const focusBefore = document.activeElement, d = this.draft;
      // If the tapped task's TOP is in view, DON'T scroll — grow it in place (its bottom may extend below the
      // fold; the composer replaces it anyway). Only a task whose top is off-screen animates in. Close never
      // scrolls either, so an in-view edit leaves the list put.
      if (!this.composer.open) {
        const sc = this.editing && this._listScroller(), r = sc && this._rowEl(this.editing);
        const top = r ? r.getBoundingClientRect().top - sc.getBoundingClientRect().top : null;
        // …unless _ensureRow jumped us here to render the row at all: it lands near the top of the viewport,
        // which reads as "already in view" and would leave a composer opened on the LAST row below the fold.
        const jumped = _jumped; _jumped = false;
        this._skipOpenScroll = !jumped && top != null && top >= -1 && top <= sc.clientHeight - 20;
      }
      clearTimeout(_draftT);  // cancel stale timer — _closingComposer flip below re-triggers persistDraft x-effect
      this._closingComposer = false;   // re-arm draft persistence (closeComposer set it while animating out)
      this._listScroller()?.style.removeProperty('overflow-anchor'); _editEnd = null;   // a re-open inside the close's collapse skips its done
      this.relocateComposer();   // move the single composer into the active surface's list before it grows
      this.applyEditDom();       // style the edited row (crossfade) + hide its subtree imperatively — no list rebuild, so the scroll stays put
      // A new task grows from the Add task row it hides: from 0, a list scrolled to its end lost that row and dropped by it.
      const wasOpen = this.composer.open, add = !this.editing && !this._inPanel() && this.$refs.addRow;
      if (add?.offsetHeight) _addSlot = add.offsetHeight + parseFloat(getComputedStyle(add).marginTop);   // hidden while a new task is open: keep the last
      const start = this.editing ? this.blockH : add ? _addSlot : 0;
      this.composer.open = true;
      if (wasOpen) { clearTimeout(this._t); this._t = 0; this.grown = true; this.clip = false; this.growH = null; }
      else this._growOpen(() => this.$refs.grow, start);
      this.setEditorText(this.draft.content);
      this.setDescText(this.draft.notes);
      // After Alpine's flush, not a $nextTick: Alpine holds those while the empty entries' ghost x-transition starts, and
      // keys typed in the frames before focus landed were lost.
      queueMicrotask(() => {
        // A task that ALREADY has entries opens with the caret in its "new item" ghost — the next thing you do to
        // a list is add to it, not rename it. (Exactly one ghost renders in either non-empty case: sub or chk.)
        const kids = this.shownSubs().length, ghost = (kids || this.editing && this.draft.checklist.length) && this._ghostEl(kids ? 'sub' : 'chk');
        const c = ghost || this.$refs.content;
        // Default focus must not steal a click/Tab that reached the composer before this deferred callback,
        // nor land in a session an Escape already closed (a stall queues input ahead of this callback).
        if (c && this._live(d) && (document.activeElement === focusBefore || !this.$refs.composer.contains(document.activeElement))) {
          c.focus({ preventScroll: true }); _opened = c;
          if (!ghost && (this.editing || this.draftRestored)) this._caret(c);   // a restored draft goes on where its typing stopped
        }
        if (this._inPanel()) return;   // the panel hosts it: hidden Lists' scroller isn't the open's to move
        if (!this._skipOpenScroll) this._showComposer();   // off-screen → glide composer into view
        else { const sc = this._listScroller(); if (sc) this._glide(sc, sc.scrollTop, 420); }   // in-view: hold against grow-induced anchor drift
      });
    },
    // ONE glide, aimed at the composer WHILE IT GROWS: a live target absorbs the growth instead of chasing it (two
    // browser animations racing over a growing element were the open/close stutter). No-op when it's already in view.
    _showComposer() {
      const comp = this.$refs.composer, sc = this._listScroller(); if (!comp || !sc) return;
      const start = sc.scrollTop;
      this._glide(sc, () => {
        // A live target has to survive the target MOVING: relocateComposer re-parents this element between
        // surfaces/lists, and a detached node reports an all-zero rect — aiming at that drags the list to
        // the top. scrollIntoView never had to care because it resolved its pixel once and forgot.
        const cr = comp.getBoundingClientRect();
        if (!this.composer.open || !comp.isConnected || !cr.height) return sc.scrollTop;
        const sr = sc.getBoundingClientRect(), H = this._seenH(sc), top = sc.scrollTop + cr.top - sr.top - 8, lift = top + cr.height - H + 20;
        // taller than the viewport → sit on its top; otherwise the start, clamped so it's all in. Absolute, never the live scrollTop
        // (the easing pulled back from it every frame, ±12px wobble) nor a bare start: one that hid it bounced the glide back there.
        return cr.height > H ? top : Math.min(top, lift > start + 16 ? lift : start);
      }, 420);   // outlasts the 220ms grow, so the target is still live for the whole of it
    },
    // Imperative edit styling (no list rebuild): crossfade height on the edited row + hide its subtree. Run on
    // open/close; rows a morph creates later are stamped by _stampRow.
    applyEditDom() {
      for (const el of document.querySelectorAll('.surface-lists .item.editing-row')) { el.classList.remove('editing-row'); el.style.height = ''; }
      const before = !this.editing && _arrive.size && this._rowTops();
      for (const el of document.querySelectorAll('.surface-lists .item.edit-hidden')) {
        el.classList.remove('edit-hidden');
        if (!this.editing && _arrive.has(el.dataset.id)) this._stampRow(el);
      }
      if (before) queueMicrotask(() => this._glideFrom(before, false));
      if (!this.editing) return;
      const sub = new Set([this.editing]);   // the edited subtree: only its rows take edit state, so only they get stamped
      for (const id of sub) for (const k of this.childTasks(id)) sub.add(k.id);   // a Set: a parent cycle ends the walk
      for (const el of document.querySelectorAll('.surface-lists .list .item')) if (sub.has(el.dataset.id)) this._stampRow(el);   // one pass over the rows, not a query per hidden descendant
    },
    // Now has no editable list — editIndex positions the composer on Lists
    rowIndexOf(id) { this.visibleRows(); return (_rowMap.get(id) ?? _doneMap.get(id))?.i ?? -1; },
    // A row that has just been DELETED (or filtered out) is in NEITHER list — -1 sent the composer to flex
    // order -2, above every row, and the browser dragged the focused caret (and the scroll) up with it. Hold
    // the last index the row had: the composer stays put for the frame or two before it collapses.
    editIndex() { const i = this.rowIndexOf(this.editing); if (i >= 0) _editIx = i; return _editIx; },
    editingDone() { return !!this.editing && this.completedRows().some(r => r.t.id === this.editing); },   // the edited task lives in the Done list
    // physically moved into the target .list on open; $refs survive; setNav/goSurface close it on switch
    relocateComposer() {
      const el = this.$refs.composer; if (!el) return;
      // Plan+panel → panel; a completed task → the Done list; otherwise the active Lists list
      const dest = this._inPanel() ? document.querySelector('.cl-side-composer')
        : this.editingDone() ? document.querySelector('.list-done .list')
        : document.querySelector('.surface-lists .list');
      if (dest && el.parentElement !== dest) dest.appendChild(el);
    },
    quickAdd() {   // `q` and the phone's ＋: opens inline on Lists, in the list left open there
      if (this.surface !== 'lists' && this.navSel.type === 'filter') this.setNav('all');   // unseen, the filter can't promise the new task shows
      this.goSurface('lists'); this.startAdd();
    },
    startAdd() {
      this._endDraft(); this.editing = null; _editPin = null; this.resetDraft();
      if (this.navSel.type === 'area') this.draft.areas = [this.navSel.id];   // lands in the area view it's added from, on its visible chip
      this._initDraftSafety(); this.openComposer();
    },
    durFmt(min) {
      const h = Math.floor(min / 60), m = min % 60;
      return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '');
    },
    projName(id) { return this.byId.get(id)?.content || ''; },
    isDefaultProj(id) { return !!id && id === this._defId; },
    pickIsDefault() { return this.draft.project_id ? this.draft.project_id === this.store.defaultProject() : !this.draft.project; },
    projPickColor() {
      const p = this.draft.project, c = this.draft.project_id || !p   // no name → the default project, by its cached id (O(1))
        ? this.byId.get(this.draft.project_id || this._defId)?.color
        : this.tasks.find(x => x.content === p && x.parent_id === null)?.color;
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
    areaObjs(ids) { const areas = byIdIn(this.areas); return (ids || []).map(id => areas.get(id)).filter(Boolean); },

    // x-html; relation picker + cascade-complete use the same markup (ui.js)
    taskLine(t, markedTitle) {
      const parent = this.byId.get(t.parent_id);
      return rowBodyHtml({
        t, pc: this.pc(t.importance),
        titleHtml: markedTitle != null ? markedTitle : mdTitleFn(t.content),
        areas: this.areaObjs(t.area_ids).map(l => ({ name: l.name, icon: l.icon, color: l.color || this.areaDefault })),
        projName: parent ? parent.content : '',
        isDefaultProj: !!t.parent_id && t.parent_id === this._defId,
        note: inNotes(t),
        rels: [], chk: [],
      }, { minimal: true });
    },
    // static body — shell <li> keeps reactive bindings
    // Grouping by project already names it in the section head — repeating it on every row is noise.
    // A Done root from a subproject names it inside the project view (even grouped); a row of the viewed project itself doesn't.
    rowBody(r, opts) {
      const subDone = this.navSel.type === 'project' && r.depth === 0 && _doneMap?.get(r.t.id) === r && r.t.parent_id !== this.navSel.id;
      return rowBodyHtml(r, { navType: this.navSel.type, chkOpen: this.chkOpen.has(r.t.id), chkHeld: _chkHeld?.key === r.t.id ? _chkHeld.done : null, ...(subDone ? { proj: true } : this.groupBy === 'project' ? { proj: false } : {}), ...opts });
    },
    // body is inert x-html — delegate here; editTask measures .item
    onRowClick(r, e) {
      if (e.target.closest('a, code, .md-code')) return;   // links and code own their clicks/selection
      if (e.metaKey || e.ctrlKey) return this.toggleSel(r.t.id);                                  // Ctrl/Cmd-click toggles selection
      if (e.shiftKey) { getSelection()?.removeAllRanges(); return this.selectRange(r.t.id); }     // Shift-click extends the range (drop any accidental text highlight)
      this.selAnchor = r.t.id;   // a plain click seeds the range anchor for a later Shift-click
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'collapse') return this.toggleTaskCollapse(r.t.id);
      if (act === 'rel') return this.rowRelOpen(r.t, e.target.closest('.row-rel'));
      if (act === 'check') return r.step ? (e.detail ? this._stepTick(r.t.id) : this.toggleChk(r.t.id, r.step.ci)) : this.toggle(r.t, e.detail ? r : null);   // a pointer tick celebrates; a key's (detail 0) stays instant
      if (act === 'chk-more') { this.chkOpen.has(r.t.id) ? this.chkOpen.delete(r.t.id) : this.chkOpen.add(r.t.id); this._dropRowHtml(r.t.id); this._paintRows(); return; }   // reveal/re-hide the collapsed done items; repaint here — no effect may have read chkOpen for this row
      // the checkbox OR its text toggles a checklist item; plain (uncheckable) items fall through to editTask
      const chk = e.target.closest('.chk-rect, .chk-txt')?.closest('.chk-row, .step-next');   // a Steps row's preview ticks by its node
      if (chk && !r.t.checklist_plain) return chk.matches('.step-next') && e.detail ? this._stepTick(r.t.id, true) : this.toggleChk(r.t.id, +chk.dataset.ci);
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
    // Dragged tasks' subtrees move with them, so they leave the list until the drop (_clearDrag brings them back). The grabbed
    // row stays, dimmed with them: hiding a drag's source cancels the drag.
    _liftSubtree(ids, grab = ids[0]) {
      const kids = childIndex(this.tasks);
      _dragIds = new Set([...ids, grab]); _dragGrab = grab; _sortRefused = false;
      _dragParents = new Set(ids.map(id => this.byId.get(id)?.parent_id));
      _dragProjs = new Set([..._dragParents].map(p => this._projOf(p)));
      _dragDescs = new Set(ids.flatMap(id => descendantIds(this.tasks, id, kids).slice(1)));   // descendants only (drop self): hidden now, out of the window next frame
      _dragDescs.delete(grab);
      _dragSubDepth = Math.max(...ids.map(id => subtreeDepth(this.tasks, id, kids)));   // once per drag, not per dragover
      // rows drawn above the grab leave next frame: closing up now moves it from under the pointer, and Chrome cancels the drag
      const at = _rowMap.get(grab)?.i ?? -1;
      for (const d of _dragDescs) if (_rowMap.get(d)?.i > at) this._rowEl(d)?.classList.add('row-hidden');
      _liftTop = this._rowEl(grab)?.offsetTop ?? null;   // offsetTop: a held row's translate isn't the list's
      if (_liftTop != null) this._listScroller().style.overflowAnchor = 'none';   // _paintRows' pad restores the grab's place; anchoring would add the rows' height again
      this._reflow();
    },
    dragStart(t, e) {
      this.taskDropHint = null; this.railHot = null;
      this._clDnd = { kind: 'task', id: t.id }; this._peekShow();   // arm the calendar drop path — the Peek Pane docks in
      const at = id => _rowMap.get(id)?.i ?? Infinity, ids = this.sel.includes(t.id) ? this._selRoots().sort((a, b) => at(a) - at(b)) : [t.id];   // a selected row carries the selection
      this.dragId = [t.id, ...this._chain(t.parent_id)].findLast(id => ids.includes(id));   // it lands where its selected root does
      this._dragX0 = e.clientX ?? 0;
      this._liftSubtree(ids, t.id);
      this.railList = this.railItems().filter(it => it.id === t.id ? t.id === this.dragId : !_dragDescs.has(it.id));   // its own subprojects, a carried grabbed row too: a drop there is a cycle the store refuses
      for (const id of _dragIds) this._rowEl(id)?.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id);
        const row = this._rowFromEl(e.target?.closest?.('.item')) || this._mkRowFn().mkRow(t, 0);
        const rest = ids.length - (t.id === this.dragId), more = rest ? `<span class="badge">+${rest}</span>` : '';   // the roots besides the card's row; the card only: a Peek drop schedules the grabbed row alone
        dragImage(e, `<div class="drag-ghost-row">${this.rowBody(row, { chevron: false, checklist: false, rels: false })}${more}</div><div class="drag-ghost-chip">${escHtml(t.content || 'Task')}</div>`,
          e.target?.closest?.('.item')?.getBoundingClientRect() || { left: (e.clientX ?? 0) - 20, top: (e.clientY ?? 0) - 10 });
      }
    },
    // depth = the target row's display depth (for the ghost indent); the MAX_DEPTH guard uses projectDepth. keep: the mode the ghost holds.
    dragOver(t, e, depth, keep) {
      if (!this.dragId) return;
      _sortRefused = false;
      // #91, user: "if it's 100px to the left (relative to screen size), unindent wherever it is": the slot under the pointer, a level up
      const far = this._dragFar(e.clientX), own = _dragIds?.has(t.id) || _dragDescs?.has(t.id);
      const out = this.taskDropHint?.mode === 'outdent' && this.byId.get(this.taskDropHint.id)?.parent_id;
      if (far && out && !_rowMap.has(out) && this._chain(t.parent_id).includes(out)) return;   // out of a filter's head the ghost opens above the heads, sliding the head's rows under a still pointer
      // over the carried rows the move unindents from its moving root's parent: a parent that moves too has no slot to land beside
      const at = own ? this.byId.get([t.id, ...this._chain(t.parent_id)].findLast(id => _dragIds.has(id))) : t, d = own ? _rowMap.get(at.id)?.depth ?? depth : depth;
      const mode = own ? 'below' : keep ?? this._dropMode(e, t.id), par = far && mode !== 'into' && this.byId.get(at.parent_id);
      const up = par && this.taskProj(par);   // a project's row, or the Inbox's, has no parent to outdent to
      if (own && !up) { this.taskDropHint = null; this._setDropInto(null); return; }   // self or own subtree: no slot; far, it unindents from its own parent
      _dropSlot = { t, depth, mode };   // own too: a pointer resting on the gap keeps the unindent the ghost shows
      this._setDropInto(!own && (mode === 'into' || _intoAt) ? t.id : null, mode !== 'into');   // an outdent drawn meanwhile keeps the dwell
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (mode !== 'into' && this._sortPins(up ? par.parent_id : t.parent_id)) { _sortRefused = true; this.taskDropHint = null; return; }
      // sorted, an unindent lands at its sorted place under par's parent; out of a filter's section head (par unshown) ghostPos places it
      if (up) this.taskDropHint = this.sortBy !== 'manual' && _rowMap.has(par.id) ? this._sortLand(par, 'below') : { id: at.id, mode: 'outdent', depth: Math.max(0, d - 1) };
      else this.taskDropHint = { ...this._sortLand(t, mode), depth: mode === 'into' ? (depth ?? 0) + 1 : (depth ?? 0) };
    },
    // placeholder slotted via flex order (rows i*2)
    ghostPos() {
      const h = this.taskDropHint?.at ?? this.taskDropHint;   // at: where a row landing among several parents' roots is drawn
      if (!this.dragId || !h || h.mode === 'into') return null;   // into opens no gap: the .drop-into box shows it
      const rows = this.visibleRows(), r = _rowMap.get(h.id);
      if (!r) return null;
      // below lands after the target's subtree, an outdent after its parent's: from the row under the pointer (h.id), past
      // its siblings and anything deeper — a filter's section head has no row to walk from.
      const pid = h.mode === 'outdent' && r.t.parent_id, drag = _rowMap.get(this.dragId);
      let at = r.i; while (h.mode !== 'above' && (rows[at + 1]?.depth > r.depth || pid && rows[at + 1]?.t.parent_id === pid)) at++;
      // out of a filter's head a match turns loose, landing among the loose rows above every head, and a context row
      // becomes a head among the heads, each by sort or rank as visibleRows orders roots
      if (pid && this.navSel.type === 'filter' && !_rowMap.has(pid)) {
        // a sort tie falls to position: the drop gives pid's siblings, and the row just after pid, the slots orderSlots does
        const sibs = this.childTasks(this.byId.get(pid)?.parent_id ?? null), rank = _hitRank.get(this.dragId), cmp = this.sibCmp();
        const slots = orderSlots(sibs.map(x => x.position ?? 0), sibs.length + 1), cut = sibs.findIndex(x => x.id === pid) + 1;
        const slotOf = new Map(sibs.map((x, i) => [x.id, slots[i < cut ? i : i + 1]])), moved = { ...drag.t, position: slots[cut] };
        const after = t => cmp?.(slotOf.has(t.id) ? { ...t, position: slotOf.get(t.id) } : t, moved) || _hitRank.get(t.id) - rank;
        if (drag.ctx) { const g = _secMemo.find(s => after(this.byId.get(s.key)) >= 0); at = (g ? g.at : rows.length) - 1; }
        else for (at = -1; at + 1 < _secMemo[0].at && (rows[at + 1].depth || after(rows[at + 1].t) < 0); at++);
      }
      // ties with a section head's order land AFTER it (the ghost follows the rows in the DOM): 'above' row i shares
      // i's head (into that section), anything after row i shares the ROW's order, so it stays above the next head
      return { order: h.mode === 'above' ? r.i * 2 - 1 : at * 2, depth: h.depth ?? r.depth };
    },
    // A slot move is a 100+/day motion: the ghost grows in only where it first opens in a drag (_ghostAt); moved, or reopened past
    // the dragged row, it stands at its slot and depth at once. x-if calls it too, so a closed ghost counts.
    ghostStyle() {
      const g = this.ghostPos();
      _ghostGrown ||= _ghostAt != null && _ghostAt !== g?.order;
      _ghostAt ??= g?.order;
      return g && `order:${g.order};margin-left:${g.depth * 22}px${_ghostGrown ? ';animation:none' : ''}`;
    },
    _dragFar(x) { return x - (this._dragX0 ?? x) < -Math.min(100, innerWidth * 0.15); },
    // clear on list-leave only, not per-row — per-row clear flickers as the ghost shifts rows
    listDragLeave(e) {
      const list = e.currentTarget.closest?.('.list'); if (!list) return;
      const rect = list.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        this.taskDropHint = null; this._setDropInto(null);
      }
    },
    // #91, user: "the cursor is on the left of the task list": a grab near a title's start leaves the list going far left;
    // beside it, the row at the pointer's height unindents as if the pointer were on it
    listDragLeft(e) {
      const list = this.dragId && document.querySelector('.surface-lists .list');
      if (!list || list.contains(e.target)) return;
      const rect = list.getBoundingClientRect();
      // off the list, no slot but beside it and far (no dragleave fires within main.app); the rail and the rest of main.app clear it
      if (e.target !== e.currentTarget || e.clientX >= rect.left || e.clientY < rect.top || e.clientY > rect.bottom || !this._dragFar(e.clientX)) {
        this.taskDropHint = null; this._setDropInto(null);
        return;
      }
      e.preventDefault();
      this.listDragOver({ clientX: e.clientX, clientY: e.clientY, dataTransfer: e.dataTransfer, target: document.elementFromPoint(rect.left + 1, e.clientY) ?? list });
    },
    async drop() {
      const hint = this.taskDropHint, dragId = this.dragId, ids = this._selRoots([...(_dragIds || [dragId])]), refused = _sortRefused;   // the landing is dragId's (the grabbed row's selected root); the rest join it, in shown order
      this.dragEnd();   // repaint can detach the source before its dragend bubbles to the list
      if (!hint && refused) this._sortHint();
      if (!hint || !dragId) return;
      const moving = new Set(ids), kids = parent => this.childTasks(parent).flatMap(x => moving.has(x.id) ? [] : [x.id]);   // shown order: this.tasks keeps a patched reorder's old order
      let parentId, order, at;
      if (hint.mode === 'outdent') {   // a level up from the row under the pointer: just after its parent
        const par = this.byId.get(this.byId.get(hint.id)?.parent_id);
        if (!par || !this.taskProj(par)) return;
        parentId = par.parent_id ?? null; order = kids(parentId); at = order.indexOf(par.id) + 1;
      } else {
        const target = hint.id !== dragId && this.byId.get(hint.id);
        if (!target) return;
        parentId = hint.mode === 'into' ? target.id : target.parent_id ?? null; order = kids(parentId);
        at = hint.mode === 'into' ? order.length : order.indexOf(target.id) + (hint.mode === 'above' ? 0 : 1);
      }
      order.splice(at, 0, ...ids);
      return this._moveTask(ids, parentId, order);
    },
    // A journaled move, keyed by the rows (several: one composite step): ⌘Z lands on it. `order` = the parent's children after the drop;
    // they take the positions they hold (orderSlots), so the order write — and the entry — touch only rows whose position changes. A move
    // keeps the row's position: a same-parent order write that fails leaves the list as it was. A row whose move fails stays put.
    async _moveTask(ids, parent, order, { label: name, bin = false } = {}) {
      const before = this.childTasks(parent).map(x => x.id), pos = x => this.byId.get(x)?.position ?? 0, home = x => (this.byId.get(x)?.parent_id ?? null) === parent, same = ids.every(home);
      const plan = rows => { const slots = orderSlots(rows.filter(home).map(pos), rows.length); return rows.flatMap((x, i) => pos(x) === slots[i] ? [] : [[x, slots[i]]]); };
      let writes = plan(order);
      if (same && !writes.length) return true;   // dropped where it was
      const landed = [], invs = [];
      for (const id of ids) {
        const inv = await this._apply({ target: 'task', kind: 'move', id, after: { parent, pos: pos(id) } });
        if (inv) { landed.push(id); invs.push(inv); }
      }
      if (!landed.length) { await this.loadTasks(); this.toast('Failed moving task'); return false; }
      if (landed.length < ids.length) {   // a row that stayed keeps its place among its old siblings; the landed ones go in after the row they dropped after
        const prev = order[order.indexOf(ids[0]) - 1], stay = before.filter(x => !landed.includes(x));
        stay.splice(stay.indexOf(prev) + 1, 0, ...landed);
        writes = plan(stay);
      }
      const ordered = !writes.length || await this.store.tasks.reorder(writes.map(w => w[0]), writes.map(w => w[1]));   // success/Undo must wait for this final write too
      await this.loadTasks();
      const entry = invs.length > 1 ? { kind: 'composite', target: 'task', ops: invs.reverse() } : invs[0], label = name?.(landed.length) ?? (landed.length > 1 ? `Moved ${this._nTasks(landed.length)}` : 'Moved');
      this._finalizeFx(entry);
      if (!ordered && same && ![entry, ...entry.ops || []].some(o => o.fx?.changed.length)) { this.toast('Failed reordering'); return false; }   // nothing moved: no entry, ⌘Z keeps the one before
      if (this.collapsed[parent] && _rowMap.has(parent)) this.toggleTaskCollapse(parent);   // into a parent shown folded: open it, as the ghost drew. View state: ⌘Z leaves it open
      this._landOn(landed[0]);   // a drag can drop a row anywhere, incl. off-screen or into a filtered-out spot
      const ok = ordered && landed.length === ids.length;
      this._pushEntry(label, entry, { bin: bin || landed.length > 1, ...!ok && { msg: `“${label}” didn’t fully save. The list shows what’s saved` } });   // several rows: a bulk change, in Recent changes as the edit bar's Move
      return ok;
    },
    dragEnd() {
      this._clearDrag(); this.dragId = null; this.taskDropHint = null; this.railHot = null; this.clDragEndSchedule(); this._peekCancelEdge();
    },
    // --- Peek Pane (C2): drag a Lists row → today's real day column docks right; drop = schedule, list drop still reorders ---
    peekOn() { return this.surface === 'lists' && (!!this.dragId || this.peekPin); },
    peekCol() { void this.tasks; void this.events; void this.blocks;   // register deps — the memos underneath may short-circuit
      return this._clPack(this._clColumn(this.peekIso || isoDate(new Date())), 44); },   // 44: .peek-grid's --clhh, whatever Plan's scale
    _peekShow() {   // called from dragStart; scrolls the pane to now on first appearance
      if (!this.peekPin) this.peekIso = isoDate(new Date());
      this.$nextTick(() => { const b = document.querySelector('.peek-body');
        if (b && !this._peekKeep) b.scrollTop = Math.max(0, b.scrollHeight * this.clNowPct() / 100 - b.clientHeight / 2);
        this._peekKeep = this.peekPin; });   // pinned pane keeps its scroll between drags
    },
    // Edge-hold paging (user-spec): DWELL ~500ms at the pane's right edge → next day; left edge → back
    // (never before today). Crossing an edge en route must not flip — the timer cancels the moment you leave.
    peekEdge(e) {
      const r = e.currentTarget.getBoundingClientRect(), EDGE = 26;   // the outer 26px (calendar-mobile-exploration §Scroll/snap physics) = .peek-eg's width
      const zone = e.target?.closest?.('.peek-month') ? null   // the month grid owns its own dwell — edge zones would double-fire under it
        : e.clientX > r.right - EDGE ? 'next'
        : e.clientX < r.left + EDGE && this.peekIso > isoDate(new Date()) ? 'prev' : null;
      if (zone === this._peekZone) return;
      clearTimeout(this._peekT); this._peekZone = zone; this.peekEdgeHot = zone;
      if (zone) this._peekT = setTimeout(() => { this._peekZone = null; this.peekEdgeHot = null; this._peekPage(zone === 'next' ? 1 : -1); }, DWELL);
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
      this.$nextTick(() => {   // the new day slides in from the held edge (WAAPI: retriggers cleanly on rapid pages)
        const panel = document.querySelector('.peek-panel');
        if (panel) motion.soften(panel.animate([{ transform: `translateX(${dir * 14}px)`, opacity: .55 }, { transform: 'translateX(0)', opacity: 1 }],
          { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }));   // reduced motion: the fade alone, ≤150ms
      });
    },
    // Month strip at the pane's foot: drop on a day = all-day that day; dwell ~500ms retargets the timeline.
    // It shows the month of the pane day's TOMORROW: on a month's last day that's next month, so a future day is always there.
    _peekMon() { const d = this._peekDay(); d.setDate(d.getDate() + 1); return d; },
    peekCells() {
      const base = this._peekMon();
      const y = base.getFullYear(), m = base.getMonth(), lead = new Date(y, m, 1).getDay(), today = isoDate(new Date());
      const rows = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
      return Array.from({ length: rows * 7 }, (_, i) => {
        const d = new Date(y, m, 1 - lead + i), iso = isoDate(d);
        return { iso, d: d.getDate(), cur: d.getMonth() === m, today: iso === today, off: iso < today };
      });
    },
    peekMonLabel() { return this._peekMon().toLocaleDateString([], { month: 'long', year: 'numeric' }); },
    peekMonOver(c) {
      if (c.off || this._pkmZone === c.iso) return;
      clearTimeout(this._pkmT); this._pkmZone = c.iso; this.peekMonHot = c.iso;
      this._pkmT = setTimeout(() => { this._pkmCancel(); this.peekIso = c.iso; }, DWELL);
    },
    _pkmCancel() { clearTimeout(this._pkmT); this._pkmZone = null; this.peekMonHot = ''; },
    peekMonDrop(e, c) { this._pkmCancel(); if (!c.off) this.clDropOn(e, c.iso, true); },
    // --- Drag-to-move edge rail: Backlog + every project + every area as compact drop targets. ---
    railItems() {
      const items = [{ kind: 'backlog', id: null, label: 'Backlog', icon: 'i-backlog', color: '' }];
      for (const { p } of this.overviewProjectRows()) items.push({ kind: 'proj', id: p.id, label: p.content, icon: 'i-hash', color: p.color || '' });
      for (const l of this.areas) items.push({ kind: 'area', id: l.id, label: l.name, icon: l.icon || 'i-tag-tag', color: l.color || this.areaDefault });
      return items;
    },
    railOver(kind, id) { this.railHot = kind + id; this.taskDropHint = null; this._setDropInto(null); },
    async railDrop(kind, id) {
      const dragId = this.dragId, ids = this._selRoots([...(_dragIds || [dragId])]);
      this.dragEnd();
      const t = this.byId.get(dragId); if (!t) return;
      if (kind === 'area') {   // areas are tags (many-to-many) — add the tag, keep existing
        if (this.sel.includes(dragId)) return this.selAddArea(this.areas.find(a => a.id === id), true);   // a carried selection tags as the edit bar
        const tags = t.area_ids || [];
        if (tags.includes(id)) return;
        await this.perform('Tagged', { target: 'task', kind: 'update', id: dragId, after: { area_ids: [...tags, id] } });
        return;
      }
      const parentId = kind === 'backlog' ? this.store.defaultProject() : id;
      if (ids.includes(parentId)) return;
      await this._moveTask(ids, parentId, [...this.childTasks(parentId).flatMap(x => ids.includes(x.id) ? [] : [x.id]), ...ids]);
    },
    // --- The ONE list-surface scroll model ---
    // The scroll STAYS. Opening an in-view task doesn't scroll (grow in place), so closing has nothing to
    // un-do — we never write scrollTop on close; the list stays exactly where the reader left it (if the
    // collapse shrinks the range past the end the browser clamps up a touch, which is fine). The ONLY
    // deliberate scroll is `_revealRow`: bring a task in when it's OFF-SCREEN (an off-screen open, or a save
    // that re-sorted the row out of view). The list is windowed, so we never trust absolute scrollTop.
    _listScroller() { return document.querySelector('.surface-lists .app'); },
    _rowOffscreen(sc, el) { const r = el.getBoundingClientRect().top - sc.getBoundingClientRect().top; return r < -1 || r + el.offsetHeight > this._seenH(sc) + 1; },
    // How much of the scroller the reader SEES: the nav strip covers its bottom --foot band, and a phone's soft
    // keyboard the visual viewport's. Landing a composer "in view" under either left its footer hidden (B3).
    _seenH(sc) {
      const top = sc.getBoundingClientRect().top, foot = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--foot')) || 0;
      return Math.min(sc.clientHeight - foot, visualViewport.offsetTop + visualViewport.height - top);
    },
    // --- The ONE scroll animation in the app ---
    // Every scroll stutter we have shipped came from the same two gaps in the browser's smooth scroll: it aims
    // at a pixel computed ONCE — so a reflow mid-flight (the composer still growing, a row's measured height
    // replacing its estimate, a list re-render) leaves you somewhere else — and we hold no handle on it, so
    // a second request RACES the first and your own scroll fights it instead of stopping it. Both are closed
    // here: `to` is a FUNCTION re-read every frame, and one tween per scroller owns the animation.
    // A hand on the wheel always wins: if scrollTop moved by anyone but us, we let go on the spot.
    // A CONSTANT target makes it a hold instead of a move — re-asserting the same position every frame is how
    // we sit still through a re-render, and it stands down on the same user input. One primitive, both jobs.
    // One passive record per scroller of when the user last touched it. Yield to REAL input, never to a
    // scrollTop delta: a row above the reader changing height moves scrollTop too, and reading that as
    // "they took over" is how a reveal gives up half way.
    _userAt(sc) {
      if (!sc._userArmed) { sc._userArmed = true; for (const ev of GLIDE_YIELD) sc.addEventListener(ev, () => { sc._userAt = performance.now(); }, { passive: true }); }
      return sc._userAt || 0;
    },
    _glide(sc, to, ms = 340) {
      if (!sc) return; this._userAt(sc);   // arm the hand-wins listeners
      const at = () => { const v = typeof to === 'function' ? to() : to; return Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, v)); };
      // Zero motion does NOT mean zero protection: grow/collapse still reflows layout and scroll anchoring
      // still drifts, so at scale 0 the glide JUMPS to the target immediately and then re-asserts the LIVE
      // target each frame for the RAW duration — the reader's position is managed, nothing visibly animates.
      const zero = !ms || this.reduceMotion();
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
    _revealRow(id, ms = 340) {
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
        const H = this._seenH(sc);
        if (el) { const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
          return sc.scrollTop + this._revealBy(r.top - s.top - 12, r.bottom - s.top - H + 12, r.height > H); }
        // Residual: for a row that has never rendered, `h` is _rowEst, not a measured height — so the two
        // branches can still part by |est − real| at the handover. Tens of px (one re-aim), not the 840px class.
        const y = this._modelTop(id); if (y == null) return sc.scrollTop;
        const m = this._modelOf(id), h = m.ent[m.ix.get(id)].h, top = y - sc.scrollTop;
        return sc.scrollTop + this._revealBy(top - 12, top + h - H + 12, h > H); }, ms);
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
      const task = this.byId.get(this.editing), d = this.draft;
      if (task && this.askDeleteTask(task.id, 'editing')) return;   // has subtasks → the prompt finishes the job (incl. closing)
      if (task && !await this.perform('Deleted', { target: 'task', kind: 'delete', id: task.id })) return;   // failed: keep the composer and its edits
      if (this._live(d)) this.closeComposer(true);   // row is gone → the close holds scrollTop (anchoring off for its collapse), so the rows below close the gap
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
    closeComposer(saved = false) {   // → a promise of the collapse's end (a save times its reveal off it)
      if (this.sticky) return Promise.resolve();   // the sticky note's add line never closes (Esc, an outside click)
      if (this.composer.open && this._closingComposer) return;   // already closing (⌘Enter's save closes itself): a 2nd close would file the edit as a Draft
      this.pop = null;
      this._endDraft(saved);
      if (this.$refs.composer?.contains(document.activeElement)) document.activeElement.blur();   // a key during the collapse must not type into the closing draft
      this.draftRestored = false;
      // A close never scrolls: the list stays exactly where the reader left it. Scroll anchoring sits the collapse
      // out — scrolled INTO a tall composer, the rows on screen are the ones below it, so one of them was the anchor:
      // the list rode the collapse and the re-render (−349/−96px), then a pre-close HOLD eased it back — "every close
      // jumps, then glides back" (B2). Back on two frames after done: past the close's own layout, in time for the
      // next measure pass, whose estimate→real corrections it absorbs invisibly. openComposer restores it too.
      const sc = this._listScroller(), end = this.editing ? this.blockH : this._inPanel() ? 0 : _addSlot;   // the open's mirror: to 0, a list at its end dropped by the Add task row
      if (sc) sc.style.overflowAnchor = 'none';
      _editEnd = end; this._reflow();   // before any row rises into view — the collapse itself never re-windows
      return new Promise(done => this._growClose(() => this.$refs.grow, end, () => {
        this.composer.open = false; this.editing = null; _editPin = _editEnd = null; this.resetDraft(); this.applyEditDom(); this._paintRows(); this.fitRows();   // windowed in the frame the subtree returns, fitted next
        requestAnimationFrame(() => requestAnimationFrame(() => sc?.style.removeProperty('overflow-anchor')));
        done();
      }));
    },
    composerMt() { return (this.editing ? -this.startH : 0) + 'px'; },
    // A terminal action (done, duplicate, archive) closes the composer: its open edits land first. False = they didn't, and
    // the composer keeps them — a dirty draft closed over would only survive as a recoverable pending draft.
    async _saveOpenEdits(d) { return this._live(d) && (this._draftSig() === this._draftBase || await this.submitComposer() === true); },
    // Ticking the composer's own check finishes the task — like archive, that's terminal, so the composer closes.
    // Un-completing keeps it open, and the close is conditional on the task actually ending up done (a sweep prompt can cancel).
    async toggleEditing() {
      const t = this.byId.get(this.editing), d = this.draft; if (!t) return;
      if (t.completed_at) return this.toggle(t);
      if (!await this._saveOpenEdits(d)) return;
      await this.toggle(t);
      if (this.byId.get(t.id)?.completed_at && this._live(d)) this.closeComposer(true);
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
        project: this.projName(t.parent_id) || null, project_id: t.parent_id || null, areas: [...(t.area_ids || [])], goal_ids: [...(t.goal_ids || [])], checklist: (t.checklist || []).map(c => ({ ...c })), checklist_plain: !!t.checklist_plain, task_type: t.task_type ?? null, recurrence: t.recurrence ? JSON.parse(JSON.stringify(t.recurrence)) : null,
        location: t.location ? { ...t.location, ids: [...(t.location.ids || [])] } : { mode: 'any', ids: [] },
        reminders: userReminders(this.reminders, t.id).map(r => ({ ...r })), subs: this._subsOf(t.id),
      };
    },
    _subsOf(id) { return this.childTasks(id).map(c => ({ id: c.id, done: !!c.completed_at })); },   // a draft's subtask rows as stored
    _inPanel() { return this.surface === 'plan' && this.clSideVisible(); },   // the calendar's panel hosts the composer itself
    // The composer IS a row in the visible list, so a task the current view doesn't hold (another project, a
    // filtered-out one, opened from Now/search/a subtask chevron) had nothing to sit on and landed in a broken
    // spot. Navigate to a view that holds it; returns true when it moved, so the caller re-opens next tick.
    goToTask(t) {
      if (!t || this._inPanel()) return false;
      if (this.surface === 'lists' && this.rowIndexOf(t.id) >= 0) return false;
      let root = t, seen = new Set();
      while (root.parent_id && !seen.has(root.id)) { seen.add(root.id); const p = this.byId.get(root.parent_id); if (!p) break; root = p; }
      const inProj = this.isOverviewProject(root) && root.id !== this.store.defaultProject();
      this.setNav(inProj ? 'project' : 'all', inProj ? root.id : null);   // setNav also moves the surface to Lists
      return true;
    },
    // `routed` bounds the hop to ONE: a task with no row anywhere in Lists (a completed one while the done lens
    // is off) would otherwise re-navigate forever and hang the page.
    editTask(t, ev, routed) {
      if (this.sticky) return desktopWindow('openTask', t.id);   // the note is too small for the composer: the app window opens it
      if (!routed && this.goToTask(t)) return queueMicrotask(() => this.editTask(t, null, true));   // the row has to exist before it can be measured and covered: after Alpine's flush, not a $nextTick — the palette's closing transition holds that a frame, and keys typed in it reached the page
      _jumped = !ev;   // the in-place rule is for a row the reader TAPPED; a palette/keyboard open lifts the whole composer in (B3)
      // ev.currentTarget is the list (<ul>); resolve the actual row by id
      // windowed: a programmatic open must window the row in before it can be measured — not for the panel, whose jump would move hidden Lists
      const row = ev?.currentTarget?.classList.contains('item') ? ev.currentTarget : this._inPanel() ? this._rowEl(t.id) : this._ensureRow(t.id);
      // programmatic opens lack a source row — fall back to a visible row height (else startH=0 loses overlap)
      this.startH = row?.offsetHeight || [...document.querySelectorAll('.list .item')].find(el => el.offsetParent !== null)?.offsetHeight || 34;
      // block height = row + its shown subtask rows (measured before they hide)
      let h = this.startH, el = row?.nextElementSibling;
      const depth = +(row?.style.getPropertyValue('--d') || 0);
      while (el && el.classList.contains('item') && +(el.style.getPropertyValue('--d') || 0) > depth) {
        h += el.offsetHeight; el = el.nextElementSibling;
      }
      this.blockH = h;
      this._endDraft();   // a composer already open (another row, a subtask's chevron) keeps its draft under its own key
      // the ghost rows are shared DOM, and focusing one mirrors its text back into subGhost before subGhostSync runs
      this.draft = this.taskToDraft(t); _dlAuto = ''; this.subGhost = this.chkGhost = ''; this._clearEditor(this._ghostEl('sub'));
      this.editing = t.id; _editPin = t.id;
      this.pop = null;
      this.pickerQ = '';
      this._initDraftSafety();   // baseline + restore any unsaved draft for this task
      this.openComposer();
    },
    // ── Reminders (composer) ───────────────────────────────────────────────────────────────────────
    // The draft stages the sentences; _saveReminders reconciles on save, so Cancel really cancels.
    remLead(r) { return leadIcon(r); },
    remTag(r) { return isPassed(r) ? 'passed' : 'paused'; },
    remWhen(r, task = this._draftTaskShape()) {
      if (r.anchor && r.anchor !== 'absolute') {
        const a = anchorsFor(task).find(x => x.key === r.anchor), n = r.offset_minutes || 0;
        return (n ? offsetLabel(n) + (n < 0 ? ' before ' : ' after ') : 'at ') + (a?.label || r.anchor).toLowerCase();
      }
      if ((r.times || []).length) return r.times.map(t => this.fmtTime(t)).join(' + ');
      if (!r.at) return 'no time';
      const day = r.at.slice(0, 10), away = Math.abs(Math.round((new Date(day + 'T00:00') - new Date(isoDate(new Date()) + 'T00:00')) / 864e5));
      return (!away ? '' : away > 6 ? this.fmt(day) + ' ' : WEEKDAYS[new Date(r.at).getDay()] + ' ') + this.fmtTime(timeOf(r.at));   // a weekday past a week reads as the wrong one
    },
    // The suggestion engine reads the draft's OWN facts, so it stays right while the user is still typing.
    _draftTaskShape() { const d = this.draft; return { deadline_at: d.deadline_at, available_from: d.available_from, recur_from: d.on, recurrence: d.recurrence }; },
    remSuggest() { return suggestionsFor(this._draftTaskShape(), this.draft.reminders); },
    remAdd(sug) {
      this.draft.reminders.push({ id: 'new-' + Math.random().toString(36).slice(2, 9), _new: true,
        anchor: sug.anchor, offset_minutes: sug.offset_minutes ?? null, at: sug.at || null, severity: 'ping', repeat: null, times: null, paused: false });
    },
    remDrop(id) { this.draft.reminders = this.draft.reminders.filter(r => r.id !== id); },
    remCycleSev(r) { const o = ['gentle', 'ping', 'alarm']; r.severity = o[(o.indexOf(r.severity || 'ping') + 1) % 3]; },
    // The lead switch is the pause, and only a self-repeating reminder has something to pause.
    remLeadTap(r) { if (isRepeating(r)) r.paused = !r.paused; else this.remCycleSev(r); },
    remLabel() { const n = this.draft.reminders.length; return n ? String(n) : 'Remind'; },
    // Create-then-delete: a reconcile never leaves the user with fewer reminders than they authored. It removes only what the draft
    // dropped from `base`, what the composer opened with: a reminder another tab added since was never on screen to remove. A removal
    // joins the save's journal ops `j`, so ⌘Z brings it back; its Bin copy is stored first and, once `j` is journaled (`drops`), stays a Bin row.
    // false: one didn't land — the draft keeps it staged, a landed add as saved.
    async _saveReminders(taskId, d, base, j, drops) {
      const live = new Map(userReminders(this.reminders, taskId).map(r => [r.id, r])), keep = new Set(), left = [];   // derived rows are the brain's — never ours to delete
      const pick = r => ({ severity: r.severity, repeat: r.repeat, times: r.times, message: r.message ?? null, paused: !!r.paused });
      const was = new Map(base.reminders.map(r => [r.id, JSON.stringify(pick(r))]));   // one the draft didn't change keeps another tab's edit (or delete)
      let ok = true;
      for (const r of d.reminders) {
        const fields = pick(r);
        keep.add(r.id);
        // an update that fails may have no row left (another tab's delete): it's created again — worst case a duplicate
        if (r._new || JSON.stringify(fields) !== was.get(r.id) && !await this.store.reminders.update(r.id, fields)) {
          const row = await this.store.reminders.add({ task_id: taskId, anchor: r.anchor, offset_minutes: r.offset_minutes, at: r.at, ...fields });
          if (row) Object.assign(r, { id: row.id, _new: false }); else ok = false;
        }
      }
      const gone = base.reminders.filter(r => !keep.has(r.id) && live.has(r.id)).map(r => JSON.parse(JSON.stringify(live.get(r.id))));   // gone from the lists: another tab's delete, already in its Bin
      const drop = await this._binAhead('Removed reminder', { kind: 'composite', target: 'reminder', ops: gone.map(r => ({ kind: 'delete', target: 'reminder', id: r.id })) });
      if (!drop) { ok = false; left.push(...gone); }   // no Bin copy: they stay, still staged to go
      for (const row of drop ? gone : []) if (await this.store.reminders.remove(row.id)) j.push(['Saved task', { kind: 'reinsert', target: 'reminder', id: row.id, rows: [row] }]); else { ok = false; left.push(row); }
      if (drop) drops.push(() => drop(left.length < gone.length));   // as a deleted checklist item's (_pushChkItem)
      base.reminders = JSON.parse(JSON.stringify([...d.reminders.filter(r => !r._new), ...left]));   // what's stored now: a later save of this draft diffs against it
      if (live.size || d.reminders.length) await this._reloadFor('reminder');
      return ok;
    },
    // overview project → navigate, not edit
    openTaskById(id) { const t = this.byId.get(id); if (!t) return; this.isOverviewProject(t) ? this.setNav('project', t.id) : this.editTask(t); },
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
      if (!this.palette.open) return [];   // its x-show/x-for evaluate while shut: a save would re-run the search (and rebuild its index) unseen
      return _memo(_palMemo, this.palette.q + '|' + this._rowV, () => {
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
        return results;
      }, 1);
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
      this.store.recordSearchPick(r.id);   // recents: corpus items only (task/project/area)
      _palMemo.clear();   // the memo keys on q|_rowV; a pick reorders recents without a row change
      if (r.type === 'task') this.openTaskById(r.id);
      else if (r.type === 'project') this.setNav('project', r.id);
      else if (r.type === 'area') this.setNav('area', r.id);
    },
    runCommand(id) {
      if (id === 'new-task') this.quickAdd();
      else if (id === 'new-filter') { this.openFilterEditor(); }
      else if (id === 'save-filter') this.saveQueryAsFilter();
      else if (id === 'today') {   // arriving from another surface, the slide is the motion: Plan shows today from its first frame
        const turn = this.surface === 'plan';
        this.goSurface('plan'); queueMicrotask(() => this.clToday(turn));   // after the flush that mounts Plan
      }
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
        checklist_plain: !!d.checklist_plain, task_type: d.task_type ?? null,
      };
      if (d.project_id) fields.parent_id = d.project_id;
      else if (!fields.project && !this.editing) {
        if (this.navSel.type === 'project') fields.parent_id = this.navSel.id;
        else if (this.navSel.type === 'backlog') fields.parent_id = this.store.defaultProject();
      }
      return fields;
    },

    // The ONE owner of teleported-pop placement + outside-close (every teleported pop binds these; fix positioning here, once)
    popStyle() { return 'position:fixed;left:' + this.popXY.left + 'px;top:' + this.popXY.top + 'px;bottom:auto'; },   // each sits in an x-if: shown = mounted
    // capture (index.html): a click that repaints its own target (a row's check) detaches it before bubbling, and Alpine's .outside skips detached targets
    popAway(name, e) {
      if (this.pop !== name || e.target.closest('.pop, .tpop')) return;
      this.pop = null;
      this.tpop = false;   // the date pop's time pop goes with it: its own .outside skips the same detached targets
    },
    // Unified calendar pop (due / plan-nav) — mode driven by `pop`
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
      this.calFocus = null;
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
        const el = document.querySelector('body > .pop');   // the teleported one: list menus are .pop too, drawn through their leave
        if (!el) return;
        const _pos = (ar) => {
          // Vertically this one FLIPS rather than clamping — above the anchor if the pop would overflow the
          // bottom edge, or if it's marked data-pos="up". Horizontally it's the shared clamp.
          const vh = innerHeight - _kb, ph = el.offsetHeight;
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
          // The pop's own size is part of the key: a filtered list that shrinks under a STATIONARY anchor otherwise leaves the
          // pop hanging where the taller version ended (6px → 38px gap), and content that widens it after placement runs it flush to the edge.
          const a = anchor.getBoundingClientRect(), k = `${a.top},${a.left},${a.bottom},${el.offsetHeight},${el.offsetWidth},${_kb}`;
          if (k === prev) return;
          const vh = window.innerHeight, vw = document.documentElement.clientWidth;
          if (!a.width && !a.height) {
            // Disconnected = truly removed from DOM → close immediately.
            // Connected zero-rect: a parent still mid-show (an x-transition enter) reports zero-rect for a
            // frame or two. Allow a few frames; permanent zero-rect still closes.
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
      if (_hayV !== this._rowV) { _hayV = this._rowV; _hay.clear(); _hayOf = new WeakMap(); }
      let pool = _hayOf.get(candidates);
      if (!pool) _hayOf.set(candidates, pool = { low: null, hay: candidates.map(t => { let s = _hay.get(t.id); if (s === undefined) _hay.set(t.id, s = t.content + ' ' + this.projectPath(t)); return s; }) });
      this._pickerFuzzy = this._pickerFuzzy || makeFuzzy();
      const ranked = fuzzyRank(this._pickerFuzzy, pool.hay, q);
      if (ranked) return ranked.map(i => candidates[i]);
      const f = q.toLowerCase(), low = pool.low ??= pool.hay.map(s => s.toLowerCase());
      return candidates.filter((_, i) => _seqIn(low[i], f));   // short-fragment fallback
    },
    // Projects you can file under: overview projects (even empty) and any parent task; minus the default.
    // Overview projects first (stable within groups); task-projects (tasks acting as containers) trail.
    filteredProjects() {
      const def = this.store.defaultProject();
      // pool per _relIdx (data × editing): a keystroke reuses its haystack; the copy keeps the sort off the cached pool (an empty query returns it as is)
      const idx = this._relIdx();
      if (!idx.projs) { const own = new Set(this.editing ? descendantIds(this.tasks, this.editing) : []), shelved = this._shelved();   // filing a task under its own subtree is a cycle the store refuses
        idx.projs = this.tasks.filter(t => !own.has(t.id) && !shelved.has(t.id) && (t.id === def || t.overview || this.hasChildren(t.id))); }
      return [...this.pickerMatches(idx.projs)].sort((a, b) => (b.overview === true || b.id === def ? 1 : 0) - (a.overview === true || a.id === def ? 1 : 0));
    },
    taskProj(p) { return !p.overview && p.id !== this.store.defaultProject(); },   // container task, not an overview project
    pickProject(project) { this.draft.project_id = project.id; this.draft.project = project.content; this.projRequired = false; this.pickerQ = ''; this.pop = null; },
    defaultProjName() {
      const id = this.store.defaultProject();
      return this.byId.get(id)?.content ?? null;
    },
    // Enter files under the project named exactly, else the top one the query starts ("wor" → Work); none → create.
    // The Create row skips matching: it reuses only a root task of that exact name.
    enterProj() {
      const q = this.pickerQ.trim().toLowerCase(); if (!q) return;
      const projects = this.filteredProjects();
      const top = projects.find(p => p.content.toLowerCase() === q) || projects.find(p => p.content.toLowerCase().startsWith(q));
      top ? this.pickProject(top) : this.createFilteredProj();
    },
    async createFilteredProj() {
      const name = this.pickerQ.trim(); if (!name) return;
      const existing = this.tasks.find(x => x.content === name && x.parent_id === null && !x.archived_at);
      const project = existing || await this._newTask({ content: name, parent_id: null, overview: true });
      if (!project) return this.toast(`Failed creating “${name}”. Try again?`);   // the name stays typed in the picker
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
      await this._reloadFor('area');
      return area?.id ?? null;
    },
    async createAndToggleArea() {
      const d = this.draft, id = await this.ensureAreaId(this.newAreaName);   // held: the tag goes on the draft it was typed in, not one opened meanwhile
      if (id && !d.areas.includes(id)) d.areas.push(id);
      this.newAreaName = '';
    },
    // Areas cluster: usage-weighted size tier (s1 big → s3 small) by rank thirds over tasks touching
    // the area in the last 30 LOCAL days. Ties share the better tier; flat usage → all s2.
    areaTier(id) {
      const use = _memo(_areaUseMemo, this._rowV, () => {
        const cut = new Date(); cut.setHours(0, 0, 0, 0); cut.setDate(cut.getDate() - 30);
        const use = Object.fromEntries(this.areas.map(l => [l.id, 0])), since = cut.toISOString();
        // raw + an ISO string compare: a Date parse and two proxy traps per task, ×5000, on every _rowV bump
        for (const t of window.Alpine.raw(this.tasks)) if ((t.updated_at || t.created_at || '') >= since)
          for (const a of t.area_ids || []) if (a in use) use[a]++;
        return use;
      }, 1);
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
    endPicking: false, tpop: false, linkUrl: '', calFocus: null, tpopStyle: '', _calDn: null, calH: null, _calDragged: false, calPulse: false, hdrPulse: false, repIdx: 0,
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
    // A repeat resumed after falling behind starts again at its next date from today, not the pile it missed
    // (user, tweak-9: "let's not unload onto the user when they restart a project"); one still ahead keeps its date.
    repPause(r) {
      r.paused = !r.paused;
      if (r.paused || !this.draft.on || this.draft.on >= isoDate(new Date())) return;
      this.draft.on = '';
      this.refreshRecurrenceDue();
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
      if (r.freq === 'month') return 'the ' + ordinal(r.month_day || anchor.getDate());
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
      _dlAuto = '';   // any tap is a chosen date, even on the derived day
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
    // --- time popover: opened only by a repeat statement's [at …] chip (index.html) — fixed to the viewport, not absolute inside the teleported `.pop` ---
    toggleTimePop(ev) {
      if (this.tpop) { this.tpop = false; return; }
      const b = ev.currentTarget.getBoundingClientRect();   // BOTTOM-anchored (it sits above its trigger) — the only one
      this.tpopStyle = `left:${Math.round(popLeft(b.left, 218))}px; bottom:${Math.round(innerHeight - b.top + 6)}px;`;
      this.tpop = true;
      this.$nextTick(() => this.$refs.tpopIn?.focus());
    },
    // the time the popover edits: the active statement's own `at`, else the By register's deadline time (never the On
    // time — By shows and clears only the deadline), else the On time
    timeGet() {
      const r = this.curRule();
      return r ? (r.at || '') : this._dateKey() === 'deadline_at' ? timeOf(this.draft.deadline_at || '') : (this.draft.dueTime || '');
    },
    timeSet(v) {
      const r = this.curRule(), by = this._dateKey() === 'deadline_at', dl = by && this.draft.deadline_at;
      if (r) { if (v) r.at = v; else delete r.at; }
      // "by" IS the deadline: until a date is chosen, every pick re-derives its next occurrence and "no time" drops the unchosen date
      else if (by && (!dl || dl === _dlAuto)) this.draft.deadline_at = _dlAuto = v ? nextTimeAt(v) : '';
      else if (dl) this.draft.deadline_at = dl.slice(0, 10) + (v ? 'T' + v : '');
      else if (!by) this.draft.dueTime = v;
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
    // The grid's one Tab stop, as the Plan month's _clStop: the walked day, else the picked one, else today; off the month shown, its 1st.
    calStop() {
      const { y, m } = this.cal, f = (this.calFocus || (this.pop === 'due' && (this.draft[this._dateKey()] || this.draft.on)) || isoDate(new Date())).slice(0, 10);
      return +f.slice(0, 4) === y && +f.slice(5, 7) === m + 1 ? f : isoDate(new Date(y, m, 1));
    },
    // A focused day walks as a Plan month day does (CL_WALK); Home/End reach its week's ends, PageUp/PageDown a month.
    calKey(e, c) {
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const d = new Date((this.calFocus || c.iso) + 'T00:00'), step = CL_WALK[e.key] ?? { Home: -d.getDay(), End: 6 - d.getDay() }[e.key];
      if (step != null) d.setDate(d.getDate() + step);
      else if (e.key === 'PageUp' || e.key === 'PageDown') addMonths(d, e.key === 'PageUp' ? -1 : 1);
      else return;
      e.preventDefault(); e.stopPropagation();
      this.calFocus = isoDate(d); this._calTo(this.calFocus);
      // a key held or typed ahead walks on from calFocus while focus is still on its way; a new month's cells render first
      requestAnimationFrame(() => document.querySelector(`.pop.cal .cal-day[aria-label="${DAY_NAME.format(new Date(this.calFocus + 'T00:00'))}"]`)?.focus());
    },
    // HAZARD: args must be string literals ('eventEdit'/'blockEdit'), never reactive values — a reactive arg changes the x-html string on state updates, causing re-render that kills the input caret mid-typing.
    evWhenHtml(key, ph) { return `<input class="ev-title" type="text" placeholder="${ph}" :value="${key}.title" @input="${key}.title = $event.target.value"><div class="ev-row flex items-center"><label class="ev-allday inline-flex items-center gap-6"><input type="checkbox" :checked="${key}.all_day" @change="${key}.all_day = $event.target.checked"> All-day</label></div><div class="ev-row flex items-center"><input class="ev-field" type="date" :value="${key}.date" @input="${key}.date = $event.target.value"><template x-if="!${key}.all_day">${this.evTimesHtml(key)}</template></div>`; },
    evTimesHtml(key) { return `<span class="ev-times inline-flex items-center gap-6"><input class="ev-field" type="time" :value="${key}.start" @input="${key}.start = $event.target.value"><span class="ev-dash">–</span>${key === 'eventEdit' ? `<template x-if="eventEdit.multi"><input class="ev-field" type="date" :value="_evRange(eventEdit).ends_at.slice(0, 10)" @input="$event.target.value && (eventEdit.span = Math.round((new Date($event.target.value) - new Date(eventEdit.date)) / 86400000))"></template>` : ''}<input class="ev-field" type="time" :value="${key}.end" @input="${key}.end = $event.target.value"></span>`; },   // ceiling: a blanked end-date segment keeps the last full date, which Save stores; refuse Save on a blank date if a user reports it
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
        return { key: iso, d: d.getDate(), iso, label: DAY_NAME.format(d), cur: d.getMonth() === m, today: iso === todayIso,
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
      const { iso, time, bare } = parseDateText(this.draft.dateText), byTime = bare && this._dateKey() === 'deadline_at';   // a bare By time is a time pick: no date of its own
      if (iso) {
        if (!byTime) this.draft[this._dateKey()] = iso;
        if (time && this.pop === 'due') this.timeSet(time);
        this._calTo(byTime ? this.draft.deadline_at : iso);
      }
      if (close) { this.draft.dateText = ''; this.pop = null; }
    },
    // Grounded scheduling suggestions: clock-facts only (today/tomorrow/weekend/nextweek).
    // Suppressed by similarity (same day as draft.on); deduped. On Sat/Sun "weekend" means the next one (weekend of the coming Monday).
    calSuggestions() {
      const on = (this.draft.on || '').slice(0, 10);
      const seen = new Set();
      const now = new Date();
      const weekendNext = [0, 6].includes(now.getDay());
      const hint = (iso, long) => new Date(iso + 'T00:00').toLocaleDateString([], long ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short' });
      return [
        { key: 'today', label: 'Today', icon: 'cal', iso: quickDate('today') },
        { key: 'tomorrow', label: 'Tomorrow', icon: 'sun', iso: quickDate('tomorrow') },
        { key: 'weekend', label: weekendNext ? 'Next weekend' : 'This weekend', icon: 'sofa', iso: quickDate('weekend', weekendNext ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + (8 - now.getDay()) % 7) : now) },
        { key: 'nextweek', label: 'Next week', icon: 'arrow', iso: quickDate('nextweek'), long: true },
      ].filter(s => { if (s.iso === on || seen.has(s.iso)) return false; seen.add(s.iso); return true; }).map(s => ({ ...s, hint: hint(s.iso, s.long) }));
    },
    calSugApply(iso) { this.draft.on = iso; this.dreg = 'on'; this.pop = null; },
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
      _dlAuto = '';   // a dragged range is a chosen date, even ending on the derived day
      this.draft.available_from = lo.iso; this.draft.deadline_at = hi.iso + (this.draft.deadline_at || '').slice(10); },
    pulseCal() { this.flash('calPulse', '_calPulseT', true, 800); },
    _nlpEl() { return _nlpFocus?.el || this.$refs.content; },
    _nlpDraft() { return _nlpFocus?.draft || this.draft; },
    // --- Inline-pill editor (contenteditable title) ---
    // draft.content = the editor's TEXT nodes only (pills excluded), whitespace-collapsed. WYSIWYG: this
    // is the title verbatim; fields come only from pills (Task 3), never a submit-time re-parse.
    syncTitle(composing) {
      const el = this._nlpEl(), d = this._nlpDraft(); if (!el) return;
      if (!composing) this._pillDraw(el);   // an IME's text draws at compositionend
      const w = this._chipWalker(el); let text = '', n;
      while ((n = w.nextNode())) if (n.nodeType === 3) text += n.nodeValue;
      d.content = text.replace(/\s+/g, ' ').trim();
      const empty = !el.querySelector('.nlp-pill') && d.content === '';
      this._nlpTrack(el);
      if (!_nlpFocus) this.titleEmpty = empty;   // titleEmpty is title-only placeholder state
      else if (_nlpFocus.ghost) this.subGhost = el.textContent.trim();   // ghost's active-state + submit-flush + autosave mirror
      if (empty && el.childNodes.length) {     // emptied (stray <br>/whitespace) → reset clean, caret to start
        el.textContent = '';
        this._caret(el, 0);
      }
    },
    setEditorText(text) { const el = this.$refs.content; if (el) { el.innerHTML = titleLive(text); this.titleEmpty = !el.querySelector('.nlp-pill') && (text || '') === ''; this._noPillOnce = false; el._hist = { undo: [], redo: [], prev: this._nlpSnap(el) }; } },
    // Minting/removing a pill is ONE ⌘Z step together with the raw text it consumed: snapshot a pill editor (title,
    // subtask row) after every edit into its own el._hist. ⌘Z outside the field never touches it: a wholesale restore would wipe later words.
    _nlpSnap(el) { return { html: el.innerHTML, sig: [...el.querySelectorAll('.nlp-pill')].map(p => p.dataset.kind + ':' + p.dataset.value).join('|'), f: Object.fromEntries(PILL_KINDS.map(k => [k, PILL_SPEC[k].snapshot(this, this._nlpDraft())])), caret: this._caretOffset(el) }; },
    _nlpTrack(el) {
      const snap = this._nlpSnap(el), h = el._hist ||= { undo: [], redo: [] }, kind = this._tKind, caret = this._tCaret; this._tKind = this._tCaret = null;
      this._histStep(h, snap, h.prev && h.prev.html !== snap.html, h.prev?.sig === snap.sig && kind, caret);   // a chip change is its own step
    },
    // In-field ⌘Z steps (title, subtask rows, description): one per word typed (its space included) or run of ⌫/⌦; a caret
    // jump or any other edit starts a new one. `caret`: where this edit began, where its undo lands.
    _histStep(h, snap, changed, kind, caret) {
      if (changed) {
        const run = /^(insertText|insertComposition|deleteContent|space)/.test(kind) ? kind : null, prev = h.prev;
        if (!run || caret !== prev.caret || !(run === h.run || run === 'space' && /^insert/.test(h.run))) h.undo.push({ ...prev, caret: caret ?? prev.caret });
        h.redo = []; h.run = run === 'space' ? null : run;
      }
      h.prev = snap;
    },
    // ⌘Z/⌘⇧Z in a pill editor restore its exact snapshots (html + pill fields). Never native undo: it can't see pill edits
    // made through the DOM and replays stale steps around them (duplicated text, chips glued to words).
    nlpHistory(dir, target) {   // target: the key's own editor — a slow row save aims the engine at the title meanwhile
      const el = this._nlpEl(), h = el._hist, s = target === el && h?.[dir < 0 ? 'undo' : 'redo'].pop();
      if (!s) return;
      h[dir < 0 ? 'redo' : 'undo'].push(this._nlpSnap(el)); h.run = null;
      for (const t in PICKERS) this[PICKERS[t].key].open = false;   // an open picker's text node is about to be replaced
      this._nlpRestore(s, el); this._setCaret(el, s.caret ?? 1e9);
    },
    _nlpRestore(s, el) {
      // Only kinds whose chips differ: a popover's later edit to another field (Size, date…) must survive the undo.
      const chips = (sig, k) => sig.split('|').filter(x => x.startsWith(k + ':')).join('|'), now = this._nlpSnap(el).sig;
      el.innerHTML = s.html;
      for (const k of PILL_KINDS) if (chips(now, k) !== chips(s.sig, k)) this._restoreField(k, s.f[k]);
      el._hist.prev = s; this.syncTitle();
    },
    // --- The description is live Markdown, focused or not (mdLive): a token's markers show only while the caret touches it
    // (liveReveal), and an edit redraws what changed (onDescInput). A trailing <br> gives an empty last line a caret home;
    // textContent ignores it, so the DOM always holds the exact source. ---
    // A huge one renders as blocks of whole lines that skip layout and paint off screen (.desc-block). Only the first and the
    // always laid out last start with their markdown; the rest get theirs near the screen (init), so opening it styles about a screen, not 70K spans.
    // Few top-level nodes also keep Alpine's MutationObserver cheap: it tests each removed node against each added one,
    // so reopening a 500K one (70K spans replaced by 70K) hung 46s. A block not yet drawn holds the height _descSize estimates.
    _descHtml(text) {
      const tail = text.endsWith('\n') ? '<br>' : '';   // inside the last block, so a redraw of it keeps the closing line
      if (text.length <= DESC_BLOCK) return mdLiveRender(text) + tail;
      let html = '';
      for (let at = 0, end; at < text.length; at = end) {
        end = mdCut(text, at, DESC_BLOCK);
        const part = text.slice(at, end);
        html += `<div class="desc-block">${at && end < text.length ? escHtml(part) : mdLiveRender(part)}${end < text.length ? '' : tail}</div>`;
      }
      return html;
    },
    _blockHtml(block, plain) {
      const text = block.textContent;
      return (plain ? escHtml(text) : mdLiveRender(text)) + (!block.nextElementSibling && text.endsWith('\n') ? '<br>' : '');
    },
    _plainHtml(text) { return escHtml(text) + (text.endsWith('\n') ? '<br>' : ''); },
    _rowHtml(text) { return chkLiveRender(text, text.endsWith('\n') ? '<br>' : ''); },   // a focused checklist row
    // Each unsized block's lines wrapped at the field's width (ceiling: one average char width from the first block, off
    // for code or wide glyphs; measure per block if a first scroll is seen to jump).
    _descSize(el) {
      const blocks = el.querySelectorAll(':scope > .desc-block:not([style])'), sample = blocks[0]?.textContent;
      if (!sample || !el.clientWidth) return;
      _textWidth.font = getComputedStyle(el).font;
      const cols = Math.floor(el.clientWidth / (_textWidth.measureText(sample).width / sample.length));
      for (const block of blocks) {
        const text = block.textContent; let lines = 0;
        for (let at = 0, end; at < text.length; at = end + 1) {   // a closing newline starts no line
          end = text.indexOf('\n', at); if (end < 0) end = text.length;
          lines += Math.ceil((end - at) / cols) || 1;
        }
        block.style.setProperty('--h', lines + 'lh');
      }
    },
    setDescText(text) {
      const el = this.$refs.desc; if (!el) return;
      this._descPaint(el, text || '');
      el._hist = { undo: [], redo: [], prev: { text: text || '', caret: null } };
    },
    _descPaint(el, text, frag) {   // frag: _descHtml(text) already parsed
      if (frag) el.replaceChildren(frag);
      else el.innerHTML = this._descHtml(text);
      _liveOn = [];
      queueMicrotask(() => this._descSize(el));   // opening: the composer shows in Alpine's flush
    },
    // Repaint every idle row's text from the draft (after undo/restore rewrote it wholesale).
    syncChkRows() { this.paintChk(document.querySelector('.composer-entries .entry-list > .entry.chk.ghost')?.parentElement, true); },
    // An edit redraws the field (a huge one: the caret's block) only when its markdown changed, so plain typing keeps its
    // nodes. The caret is kept by offset. Never mid-composition: an IME's text redraws at compositionend.
    onDescInput(e) {
      if (e?.isComposing) return;
      const el = this.$refs.desc; if (!el) return;
      if (e?.inputType?.startsWith('history')) return this._liveUndo(el, e.inputType);
      const text = this.draft.notes = el.textContent;
      const a = getSelection().anchorNode, block = (a?.nodeType === 1 ? a : a?.parentElement)?.closest('.desc-block'), part = block?.parentNode === el ? block : el;
      this._redraw(part, part === el ? this._descHtml(text) : this._blockHtml(part), part === el && (frag => this._descPaint(el, text, frag)));
      this._liveStep(el, text, e);
    },
    // A live field (the description, a checklist row) redraws only when its markdown changed, so plain typing keeps its nodes.
    _redraw(part, html, paint) {
      for (const t of _liveOn) t.classList.remove('on');
      _canon.innerHTML = html;   // parsed, so it compares as the DOM serializes
      if (part.innerHTML === _canon.innerHTML) return;
      const off = this._caretOffset(part);
      paint ? paint(_canon.content) : part.replaceChildren(_canon.content);
      this._setCaret(part, off);
    },
    _liveStep(el, text, e) {
      this.liveReveal();
      const h = el._hist, caret = this._tCaret; this._tCaret = null;   // no beforeinput (execCommand): it began where the last ended
      if (h) this._histStep(h, { text, caret: this._caretOffset(el) }, h.prev.text !== text, e?.inputType === 'insertText' && /\s/.test(e.data) ? 'space' : e?.inputType, caret ?? h.prev.caret);
    },
    _liveUndo(el, type) { this._liveRestore(el); this.liveHistory(el, type === 'historyUndo' ? -1 : 1); },   // Chrome's own undo ran with no beforeinput
    // ⌘Z inside a live field steps its own history: a redraw replaces nodes native undo would replay against.
    liveBeforeInput(e) {
      const type = e.inputType || '';
      if (type.startsWith('history')) { e.preventDefault(); return this.liveHistory(e.target, type === 'historyUndo' ? -1 : 1); }
      this._tCaret = this._caretOffset(e.target);
    },
    liveHistory(el, dir) {
      const h = el?._hist, s = h?.[dir < 0 ? 'undo' : 'redo'].pop();
      if (!s) return;
      h[dir < 0 ? 'redo' : 'undo'].push({ text: el.textContent, caret: this._caretOffset(el) }); h.run = null;
      h.prev = s;
      this._liveRestore(el);
    },
    _liveRestore(el) {
      const s = el._hist.prev, item = this._chkItem(el);
      if (item) el.innerHTML = this._rowHtml(item.text = s.text); else this._descPaint(el, this.draft.notes = s.text);
      this._setCaret(el, s.caret ?? s.text.length);
      this.liveReveal();
    },
    // ⌘Z / ⌘⇧Z (Ctrl+Y on Windows and Linux) → -1 / 1, else 0. key?: autofill fires key-less keydowns.
    _undoKey(e) { const k = e.key?.toLowerCase(); return (e.metaKey || e.ctrlKey) && !e.altKey && (k === 'z' || k === 'y' && e.ctrlKey && !MAC) ? k === 'y' || e.shiftKey ? 1 : -1 : 0; },
    // The tokens whose markers show: those the caret (each end of a selection) touches, inside one or at its edge on the
    // same line. Waits for a press's release: shown sooner, the markers would move the text out from under the pointer.
    liveReveal() {
      const el = document.activeElement, s = getSelection();
      if (_press) return;
      const on = el !== _opened && el?.matches('.composer :is(.desc, .content, .entry-txt)') && s.rangeCount ? this._liveToks(el, s.anchorNode, s.anchorOffset).concat(this._liveToks(el, s.focusNode, s.focusOffset)) : [];
      for (const t of _liveOn) if (!on.includes(t)) t.classList.remove('on');
      for (const t of on) t.classList.add('on');
      _liveOn = on;
    },
    // A press past a line's end leaves the caret at its last visible spot, before the hidden markers that close the line
    // (a link's `](url)`): typing there would join the link's text. The end of a line means after them.
    _pastMarks() {
      const el = document.activeElement, s = getSelection();
      if (!el?.matches('.composer :is(.desc, .content, .entry-txt)') || !s.isCollapsed || s.focusNode.nodeType !== 3 || s.focusOffset < s.focusNode.length || !el.contains(s.focusNode)) return;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, last = null;
      w.currentNode = s.focusNode;
      while ((n = w.nextNode()) && n.parentElement.closest('.dm-mark')?.getClientRects()[0]?.width === 0) last = n;
      if (last && (!n || n.nodeValue[0] === '\n' && !n.parentElement.closest('.nlp-pill'))) s.collapse(last, last.length);
    },
    _liveToks(el, node, off) {
      if (!el.contains(node)) return [];
      if (node.nodeType === 3 && (!off || off === node.length)) {   // at a text's edge: the point between it and its neighbours
        off = [].indexOf.call(node.parentNode.childNodes, node) + (off && 1); node = node.parentNode;
      }
      const toks = [], prev = node.childNodes?.[off - 1], next = node.childNodes?.[off];
      for (let n = node; n !== el; n = n.parentNode) if (n.classList?.contains('dm-tok')) toks.push(n);
      if (prev?.classList?.contains('dm-tok') && !prev.textContent.endsWith('\n')) toks.push(prev);   // a fence's last line break: the caret starts the next line
      if (next?.classList?.contains('dm-tok')) toks.push(next);
      return toks;
    },
    // Blur is the draft's commit boundary: one ⌘Z step per focus session, however much was typed; inside the field ⌘Z is
    // its own history (liveHistory), fresh each focus.
    onDescFocus(el) {
      this._descBefore = this.draft.notes || '';
      el._hist = { undo: [], redo: [], prev: { text: this._descBefore, caret: null } };
    },
    onDescBlur() {
      this.liveReveal();
      const after = this.draft.notes || '';
      if (this._descBefore != null && this._descBefore !== after) this._pushDraftEdit('Description edit', 'desc-edit', { before: this._descBefore, after });
      this._descBefore = null;
    },
    descKeydown(e) {
      // ArrowDown out of an EMPTY description continues the ladder into the entry rows; with text in it, down
      // still moves the caret through the lines (the field owns the key).
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!this.$refs.desc?.textContent.trim() && (e.key === 'ArrowDown' ? this.focusFirstEntry() : this._focusEntry(this.$refs.content))) e.preventDefault(); return; }
      const dir = this._undoKey(e);
      if (dir) { e.preventDefault(); return this.liveHistory(this.$refs.desc, dir); }
      // Enter AND Shift+Enter both newline here — a description is multi-line, and only ⌘/Ctrl+Enter ever saves
      // (caught by the composer's capture handler before this runs, so there's no modifier case left to handle).
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      this.insertPlainText('\n');
    },
    // Escaped HTML inserts literal newlines (insertText creates div/brs that textContent loses) and replaces the selection.
    // Only the trailing caret sentinel is markup.
    insertPlainText(str) { document.execCommand('insertHTML', false, this._plainHtml(str)); },
    descPaste(e) { e.preventDefault(); this.insertPlainText(e.clipboardData.getData('text/plain')); },
    // Copy takes the source, hidden markers included: the browser's own copy leaves out a hidden fence.
    descCopy(e) {
      const s = getSelection(); if (s.isCollapsed) return;
      e.preventDefault(); e.clipboardData.setData('text/plain', s.getRangeAt(0).toString());
      if (e.type === 'cut') document.execCommand('delete');
    },
    // stable across innerHTML re-render (mdLive never changes text, only wraps it)
    _caretOffset(el) {
      const s = getSelection(); if (!s || !s.rangeCount) return null;
      const r = s.getRangeAt(0); if (!el.contains(r.endContainer)) return null;
      const pre = r.cloneRange(); pre.selectNodeContents(el); pre.setEnd(r.endContainer, r.endOffset);
      let len = pre.toString().length;   // a chip counts as ONE caret step (its label length varies), as in _setCaret
      for (const p of el.querySelectorAll('.nlp-pill')) if (pre.intersectsNode(p)) len -= p.textContent.length - 1;
      return len;
    },
    // A pill editor's text nodes and chips, in order (a chip's own label skipped).
    _chipWalker(el) { return document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: x => x.nodeType === 3 ? (x.parentElement.closest('.nlp-pill') ? 2 : 1) : x.classList.contains('nlp-pill') ? 1 : 3 }); },
    // A title's (or subtask row's) text is live Markdown between its chips: a token never spans one. The chips keep their nodes.
    _pillDraw(el) {
      const w = this._chipWalker(el), pills = [];
      let html = '', text = '', n;
      while ((n = w.nextNode())) if (n.nodeType === 3) text += n.nodeValue; else { pills.push(n); html += titleLive(text) + n.outerHTML; text = ''; }
      this._redraw(el, html + titleLive(text), frag => { frag.querySelectorAll('.nlp-pill').forEach((p, i) => p.replaceWith(pills[i])); el.replaceChildren(frag); });
    },
    _setCaret(el, off) { if (off != null) this._caret(...this._pointAt(el, off)); },
    linkOpen() { this.pop = null; window.open(this.linkUrl, '_blank', 'noopener'); },
    linkCopy() { this.pop = null; return this._copyText(this.linkUrl, 'Link copied'); },
    // Edit: the caret goes where the link was pressed, which shows its markers.
    linkEdit() {
      const { el, from } = _linkCard;
      this.pop = null;
      if (!from?.offsetNode.isConnected) return;
      getSelection().collapse(from.offsetNode, from.offset);
      const off = this._caretOffset(el);   // a checklist row redraws as its focus turns it editable
      el.focus({ preventScroll: true });
      this._setCaret(el, off);
    },
    // The DOM point `off` caret steps into el (its end past the last).
    _pointAt(el, off) {
      const w = this._chipWalker(el);
      let n = 0, node;
      while ((node = w.nextNode())) {
        if (node.nodeType === 1) { if (off <= n) return [node.parentNode, [...node.parentNode.childNodes].indexOf(node)]; n++; continue; }   // a chip: one step
        const len = node.nodeValue.length;
        if (n + len >= off) return [node, off - n];
        n += len;
      }
      return [el, el.childNodes.length];
    },
    // The selection's ends, anchor first (null when neither is in el): an offset into el when inside it, so it survives el's
    // redraw, else the DOM point. Read off the range: Chrome reports anchorNode in a skipped block at the block's start.
    _selOffsets(el) {
      const s = getSelection(), r = s.rangeCount ? s.getRangeAt(0) : null;
      if (!r || !el.contains(r.startContainer) && !el.contains(r.endContainer)) return null;
      const ends = [[r.startContainer, r.startOffset], [r.endContainer, r.endOffset]];
      if (s.direction === 'backward') ends.reverse();
      return ends.map(([node, at]) => {
        if (!el.contains(node)) return [node, at];
        const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, at);
        return r.toString().length;
      });
    },
    _setSel(el, ends) {
      const [anchor, focus] = ends.map(end => typeof end === 'number' ? this._pointAt(el, end) : end);
      getSelection().setBaseAndExtent(...anchor, ...focus);
    },
    // Set caret: off == null → collapse to end of n (selectNodeContents); else → setStart at offset.
    _caret(n, off) { const r = document.createRange(); if (off == null) { r.selectNodeContents(n); r.collapse(false); } else { r.setStart(n, off); r.collapse(true); } const s = getSelection(); s.removeAllRanges(); s.addRange(r); },
    commitPill(kind, v) { PILL_SPEC[kind].commit(this, this._nlpDraft(), v); },
    // Revert the field a removed pill had set. `raw` is the pill's data-value (string form).
    clearPillField(kind, r) { PILL_SPEC[kind].clear(this, this._nlpDraft(), r); },
    // Snapshot the draft field(s) a `kind` pill owns — stored on the pill at insert, restored on backspace.
    _fieldSnapshot(kind) { return PILL_SPEC[kind].snapshot(this, this._nlpDraft()); },
    _restoreField(kind, s) { PILL_SPEC[kind].restore(this, this._nlpDraft(), s); },
    // Build a configured pill span (no DOM insertion). Single source of truth for pill markup.
    makePill(kind, value, token, frag) {   // frag: the off-DOM fragment a paste builds its chips in
      const pill = document.createElement('span');
      pill.className = 'nlp-pill inline-flex items-center'; pill.dataset.kind = kind;
      pill.dataset.value = PILL_SPEC[kind].json ? JSON.stringify(value) : String(value);
      pill.dataset.token = token; pill.contentEditable = 'false'; pill.textContent = PILL_SPEC[kind].label(this, value);
      // A repeat multi chip adds nothing, so it shares its twin's pre-chip list: its own would hold the twin's value.
      const q = `.nlp-pill[data-kind="${kind}"][data-value="${CSS.escape(pill.dataset.value)}"]`, twin = PILL_SPEC[kind].multi && (this._nlpEl()?.querySelector(q) || frag?.querySelector(q));
      pill.dataset.prior = twin ? twin.dataset.prior : JSON.stringify(this._fieldSnapshot(kind));   // field value BEFORE this chip — restored on backspace (non-destructive)
      pill.dataset.at = Date.now();   // creation order, for _settlePills
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
      for (const t in PICKERS) if (this[PICKERS[t].key].node === textNode) this[PICKERS[t].key].open = false;   // its node is gone: a Space would pick into it
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
      const start = tok ? tok.start : pending.search(/\S+$/);   // a non-token word may still fold: [Fri 4:00] + "PM"
      if ((!tok || tok.kind === 'date') && start >= 0 && this.swallowIntoPrevDate(node, start, pending.slice(start), off)) return true;   // [next week] + "sun" → [next week sunday]
      if (!tok) return false;
      const token = pending.slice(tok.start);
      if (tok.kind === 'area') return this.pillifyArea(node, tok, token, off);         // area tokens carry a NAME → resolve to an id first; the promise lets Enter wait
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
    // A word right after a date pill MERGES into it when foldIntoDate reads "<pill token> <word>" as one date:
    // swap the pill for the combined one and drop the word. [next week] + "sun" → next week's Sunday.
    swallowIntoPrevDate(node, start, token, end = node.textContent.length) {
      if (node.textContent.slice(0, start).trim() !== '') return false;          // the word must sit directly after the pill
      let prev = node.previousSibling;
      while (prev && prev.nodeType === 3 && /^\s*$/.test(prev.textContent)) prev = prev.previousSibling;
      if (!prev || prev.nodeType !== 1 || !prev.classList?.contains('nlp-pill') || prev.dataset.kind !== 'date') return false;
      const fold = foldIntoDate(prev.dataset.token, token.trim(), new Date(), this.locNames());
      if (!fold) return false;
      const merged = this.makePill('date', fold.value, fold.token);
      // One chip now holds both words: removing it returns to the date before the first, never to that word's date.
      merged.dataset.prior = prev.dataset.prior; merged.dataset.at = prev.dataset.at;
      this._nlpEl().replaceChild(merged, prev);
      node.textContent = node.textContent.slice(end);   // word now inside the pill; keep any tail. No space: a chip owns none, so one ⌫ un-chips
      this._caret(node, 0);
      this._restoreField('date', JSON.parse(prev.dataset.prior ?? 'null'));   // the merged chip replaces the first: "4:00" committed 04:00's day, "p.m." makes it 16:00's
      this.commitPill('date', fold.value); this.syncTitle();
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
      this._unchip(prev, true);
      this._noPillOnce = true;   // just un-chipped on purpose → the next space must NOT re-chip it
      return true;
    },
    // Replace a pill with its token text (asText) or nothing; fields revert to the pills left, else to its prior value.
    _unchip(pill, asText) {
      // A chip owns no space, so it may sit flush against words: its token reverts spaced ("kid 45m x", never "kid45mx").
      const side = (before) => { const r = document.createRange(); r.selectNodeContents(this._nlpEl()); before ? r.setEndBefore(pill) : r.setStartAfter(pill); return r.toString(); };
      const token = asText ? (/\S$/.test(side(true)) ? ' ' : '') + (pill.dataset.token || pill.textContent) : '';
      const text = document.createTextNode(token + (asText && /^\S/.test(side(false)) ? ' ' : ''));
      pill.replaceWith(text);
      this._settlePills([pill]);
      this._caret(text, token.length);   // caret at the end of the restored token text
      this.syncTitle();
    },
    // Fields after chips leave the DOM. A removed multi chip takes its value along, unless the value predates it (Areas
    // button, the saved task) — else Save strips it. A single kind replays the chips left; with none, it returns to what
    // it held before the OLDEST removed chip (by creation time: a chip typed mid-title sits before older ones).
    _settlePills(pills) {
      for (const p of pills) if (PILL_SPEC[p.dataset.kind].multi && !JSON.parse(p.dataset.prior ?? 'null')?.includes(p.dataset.value)) this.clearPillField(p.dataset.kind, p.dataset.value);
      const kinds = new Set(pills.map(p => p.dataset.kind));
      this._recommitPills(kinds);
      for (const k of kinds) {
        if (PILL_SPEC[k].multi || this._nlpEl().querySelector('.nlp-pill[data-kind="' + k + '"]')) continue;
        const oldest = pills.filter(p => p.dataset.kind === k).reduce((a, b) => +b.dataset.at < +a.dataset.at ? b : a);
        this._restoreField(k, JSON.parse(oldest.dataset.prior ?? 'null'));
      }
    },
    // A title chip mirrors the field it set (x-effect on the title). el._hist.prev.f is the fields as the title's own last edit
    // left them, so a difference is a picker's write: the newest chip of that kind relabels to it, a cleared field drops its chips,
    // a multi kind drops the chips whose value left its list. The relabel is a title ⌘Z step: the undo puts chip and field back.
    mirrorPills() {
      const el = this.$refs.content, d = this.draft, now = PILL_KINDS.map(k => JSON.stringify(PILL_SPEC[k].snapshot(this, d)));   // reads every field: the effect's deps
      const f = el?._hist?.prev?.f; if (!f) return;
      let hit = false;
      PILL_KINDS.forEach((k, i) => {
        const sp = PILL_SPEC[k], pills = now[i] === JSON.stringify(f[k]) ? [] : [...el.querySelectorAll(`.nlp-pill[data-kind="${k}"]`)];
        if (!pills.length) return;
        hit = true;
        const v = !sp.multi && sp.read(this, d);
        if (sp.multi || v == null) { for (const p of pills) if (!sp.multi || !d[sp.multi].includes(pillValue(k, p.dataset.value))) p.remove(); return; }
        const p = pills.reduce((a, b) => +b.dataset.at > +a.dataset.at ? b : a);
        p.dataset.value = sp.json ? JSON.stringify(v) : String(v); p.textContent = sp.label(this, v);
      });
      if (hit && !_nlpFocus) this._nlpTrack(el);
    },
    // Clear the touched single kinds, then replay every surviving pill so fields reflect exactly the pills left
    // in the DOM (a multi kind keeps its list: _settlePills took the removed chips' values out).
    _recommitPills(kinds) {
      for (const k of kinds) if (!PILL_SPEC[k].multi) this.clearPillField(k, null);
      for (const p of this._nlpEl().querySelectorAll('.nlp-pill')) {
        const pr = p.dataset.value, kind = p.dataset.kind;
        this.commitPill(kind, pillValue(kind, pr));
      }
    },
    // Deletions route through beforeinput, NOT keydown: it fires for hardware keys AND soft-keyboard/IME
    // input (Android sends deleteContentBackward with no 'Backspace' keydown), on both Blink and WebKit. Own
    // any delete that would touch a pill so native deletion never strands a pill's field or eats the block.
    onEditorBeforeInput(e) {
      const type = e.inputType || '';
      // ⌘Z is nlpHistory: the Edit menu / context menu land here, keys in _pillKeydown
      // Unfocused: Chrome aims Edit ▸ Undo at the last-edited editor even after focus left it — words typed since would go.
      if (type.startsWith('history')) { e.preventDefault(); return e.target === document.activeElement && this.nlpHistory(type === 'historyUndo' ? -1 : 1, e.target); }
      this._tKind = type === 'insertText' && /\s/.test(e.data) ? 'space' : type; this._tCaret = this._caretOffset(this._nlpEl());
      if (!type.startsWith('delete')) return;
      const sel = getSelection(); if (!sel.rangeCount) return;
      if (sel.isCollapsed && type === 'deleteContentBackward' && this.unchipPillBefore()) return e.preventDefault();   // pill before caret → non-destructive revert
      const t = sel.isCollapsed ? e.getTargetRanges()[0] : sel.getRangeAt(0); if (!t) return;
      const range = document.createRange(); range.setStart(t.startContainer, t.startOffset); range.setEnd(t.endContainer, t.endOffset);
      const pills = [...this._nlpEl().querySelectorAll('.nlp-pill')].filter(p => range.intersectsNode(p));
      if (!pills.length) return;                                       // plain text → let native delete it
      e.preventDefault();
      // Char/word deletes stop at a chip: text up to it goes first, then the chip alone (with its field) on the next press.
      if (sel.isCollapsed && !/Line/.test(type)) {
        const back = /Backward/.test(type), pill = back ? pills.at(-1) : pills[0];
        back ? range.setStartAfter(pill) : range.setEndBefore(pill);
        if (!range.toString()) return this._unchip(pill, false);     // nothing but the chip left to take
        range.deleteContents(); return this.syncTitle();
      }
      range.deleteContents();                                          // a selection or line delete takes text + chips together
      this._settlePills(pills); this.syncTitle();
    },
    _seqMatch(name, frag) { return _seqIn(name.toLowerCase(), frag.toLowerCase()); },
    // Rank/filter over the area OBJECTS (by id), not names — so duplicate names stay distinct and the @ menu
    // renders the same deduped set as the id-keyed popups. fuzzyRank returns indices into this.areas.
    areaMatches() {
      const frag = this.areaPicker.frag; if (!frag) return this.areas;
      const names = this.areas.map(t => t.name);
      this._areaFuzzy = this._areaFuzzy || makeFuzzy();
      const ranked = fuzzyRank(this._areaFuzzy, names, frag);
      if (ranked) return ranked.map(i => this.areas[i]);
      // Subsequence fallback for short abbreviations uFuzzy won't match.
      return this.areas.filter(a => this._seqMatch(a.name, frag));
    },
    // "#" means file it under a project — overview projects + the default, not every task that happens to have children.
    projMatches() { if (!this.projPicker.open) return []; const def = this.store.defaultProject(); const shelved = this._shelved(); return this.pickerMatches(this._relIdx().proj ??= this.tasks.filter(t => t.overview && !shelved.has(t.id) || t.id === def), this.projPicker.frag); },   // closed → [] (every open resets the picker, re-running its hidden x-for)
    locMatches() { const q = this.locPicker.frag.trim().toLowerCase(); return this.locations.filter(l => !q || l.name.toLowerCase().includes(q)); },
    // Dependencies autocomplete over EXISTING open tasks — a dependency on something that doesn't exist yet
    // is a note, and notes already have a field.
    linkMatches(frag) { const def = this.store.defaultProject(); return this.pickerMatches(this._relIdx().link ??= this.tasks.filter(t => t.id !== this.editing && !t.overview && t.id !== def && !t.completed_at && !t.archived_at), frag).slice(0, 8); },   // pool per _relIdx: a keystroke reuses its haystack
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
    locOpenCount(id) { return this.tasks.filter(t => !t.completed_at && !t.archived_at && !inNotes(t) && (t.location?.ids || []).includes(id)).length; },
    // Open, then immediately re-derive at/frag from the node — the trigger keydown lands before its own character
    // is inserted, so anything already typed past it (a paste, a fast burst) would otherwise be missed.
    openPicker(type, node, at) { const sp = PICKERS[type], p = this[sp.key]; Object.assign(p, { open: true, frag: '', sel: 0, node, at, left: 0, top: 0 }); this._refreshPicker(p, sp, sp.sel); },
    refreshPicker(type) { const sp = PICKERS[type]; this._refreshPicker(this[sp.key], sp, sp.sel); },
    pickPill(type, id) {
      const sp = PICKERS[type], p = this[sp.key], node = p.node, L = sp.char.length;
      this.insertPill(node, p.at, sp.kind, id, sp.char + (sp.name(this, id) || ''), p.at + L + p.frag.length);
      p.open = false;
      if (_nlpFocus?.c) this._nlpEl().focus();
    },
    // Keys while an autocomplete popup is open (the ONE popup key ladder — every picker is a PICKERS spec).
    // `grid` adds ←/→ to the ladder (the area menu wraps); `noSpace` lets Space type through (those fragments
    // contain spaces); Enter with nothing to pick falls through to the spec's create path.
    pickerKeydown(type, e) {
      const sp = PICKERS[type], p = this[sp.key]; if (!p.open) return false;
      const s = getSelection();   // the query runs from the trigger to the caret: moved off its end (arrows, End), Enter would pick the title's words
      if (s.anchorNode !== p.node || !s.isCollapsed || s.anchorOffset !== p.at + sp.char.length + p.frag.length) { p.open = false; return false; }
      if (e.key === 'Escape') { p.open = false; return true; }
      const matches = sp.matches(this);
      if (e.key === 'ArrowDown' || (sp.grid && e.key === 'ArrowRight')) { p.sel = Math.min(p.sel + 1, Math.max(0, matches.length - 1)); return true; }
      if (e.key === 'ArrowUp' || (sp.grid && e.key === 'ArrowLeft')) { p.sel = Math.max(p.sel - 1, 0); return true; }
      if ((e.key === 'Enter' || (e.key === ' ' && !sp.noSpace)) && matches.length) { const m = matches[p.sel] || matches[0]; this.pickPill(type, sp.val ? sp.val(m) : m.id); return true; }
      if (e.key === 'Enter' && sp.onCreate) return sp.onCreate(this);
      return false;
    },
    refreshPickers() {
      // The caret's anchorNode can be the editor ELEMENT (fresh/empty row), whose mixed textContent indexes wrong
      // and whose text pickPill would overwrite — so walk down to the text node that actually holds the char.
      const key = _trigKey; _trigKey = null; let node = key && getSelection()?.anchorNode;
      if (node?.nodeType === 1) { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.includes(key)) { node = n; break; } }
      const at = node ? node.textContent.lastIndexOf(key) : -1;
      if (at >= 0) return this.openPicker(key === '@' ? 'area' : 'proj', node, at);
      for (const t in PICKERS) if (this[PICKERS[t].key].open) this.refreshPicker(t);
    },
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
      const s = getSelection(); if (s?.anchorNode !== p.node) { p.open = false; return; }
      const txt = p.node.textContent.slice(0, s.anchorOffset), idx = sp.find ? sp.find(txt) : txt.lastIndexOf(sp.char);   // the query ends at the caret: never the title's words after it
      if (idx < 0) { p.open = false; return; }
      p.at = idx; p.frag = txt.slice(idx + sp.char.length); p.sel = 0;
      this._positionPicker(p, sel);
    },
    async createAreaFromPicker() {
      const id = await this.ensureAreaId(this.areaPicker.frag);   // reuse-or-create by name → id
      if (id) this.pickPill('area', id);
    },
    // Pill-editor keydown shared by the title + every subtask row: pickers, trigger chars, and space→pill.
    // Returns true when fully consumed (pickers / trigger chars); Enter is left to the caller (submit vs commit-row).
    _pillKeydown(e) {
      const dir = this._undoKey(e);
      if (dir) { e.preventDefault(); this.nlpHistory(dir, e.target); return true; }
      for (const t in PICKERS) if (this[PICKERS[t].key].open && this.pickerKeydown(t, e)) { e.preventDefault(); e.stopPropagation(); return true; }
      // Trigger chars open their picker on their own input event — the char isn't in the DOM when keydown fires,
      // and a deferred tick can run after later keys (a transition holds $nextTick), opening on an older '@'.
      if (e.key === '@' || e.key === '#') { _trigKey = e.key; return true; }
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
    // Enter pills the word it ends on, as a space would ("call mom tmrw" saves dated; an un-chipped word stays text), then saves.
    _pillThen(done) { const pilled = !this._noPillOnce && this.pillifyTrailing(); if (pilled instanceof Promise) pilled.then(done); else done(); },
    editorKeydown(e) {
      if (this.sticky && this._stickyKey(e)) return;
      if (this._pillKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this._pillThen(() => this.submitComposer()); return; }
      // ArrowDown ladder: the title wraps, so down means "next field" only from its last line. A caret that measures 0×0 (empty title, beside a chip) counts as there.
      const caret = e.key === 'ArrowDown' && !e.shiftKey && getSelection().rangeCount && getSelection().getRangeAt(0).getBoundingClientRect();
      if (caret && (!caret.height || caret.bottom > e.target.getBoundingClientRect().bottom - caret.height / 2)) { const d = this.$refs.desc; if (d) { e.preventDefault(); d.focus(); this._setCaret(d, 0); } }
      // ↑ in an untouched add composer fixes the task just added: an empty title has no caret to move, and any typed field keeps the key
      const last = e.key === 'ArrowUp' && !e.shiftKey && !this.editing && this._draftSig() === this._draftBase && this.byId.get(_lastAdded);
      if (last) { e.preventDefault(); this.editTask(last); }
    },
    // An add hands its draft to its own slot at the press (addTask): presses never collide. An edit's save is async and its
    // draft isn't cleared until it resolves — a second ⌘⏎ (or a held key auto-repeating) would save it again. Latch it.
    async submitComposer(extra, close) {
      if (!this.editing) return !this._closingComposer && this._submit(extra, close);   // closing: ⌘⏎ handed this draft on at its press
      if (_submitting) return false;
      _submitting = this._draftSid;
      try { return await this._submit(extra, close); } finally { _submitting = null; }
    },
    // extra: fields that ride the same save (Show in Overview's flag) — one write, one ⌘Z. close: a new task closes, not resets. Returns true ONLY once it saved.
    async _submit(extra, close) {
      if (!this.draft.content.trim()) {   // contenteditable has no `required`; nothing typed at all = nothing to lose
        if (this._draftSig() === this._draftBase) return true;
        this.toast('Add a title to save'); return false;
      }
      const sc = this._listScroller(), stBefore = sc ? sc.scrollTop : 0, sid = this._draftSid, d = this.draft;   // at the press: a scroll during the subtask flush below is the user's too
      if (this.editing && this.subGhost.trim()) this.commitSubGhost();   // Save takes the ghost's typing as a row, Enter or not
      if (this.chkGhost.trim()) this.commitChkGhost();   // save in-progress ghost inputs on Save, even without Enter
      this.draft.checklist = this.draft.checklist.filter(c => (c.text || '').trim());   // prune whitespace-only items (transient while editing)
      if (!this.editing) {
        const fields = this.draftFields();
        if (!fields.project && !fields.parent_id && !this.store.defaultProject()) {
          this.flash('projRequired', '_projReqT', true, 800);
          return false;
        }
      }
      if (this.editing) {
        // Capture before close (closeComposer resets draft/editing async via _growClose callback)
        const editId = this.editing, draft = this.draft, base = this._draftBase, before = this.byId.get(this.editing), from = _draftFrom, saveBase = _saveBase;
        // only what this draft changed: a field edited elsewhere since it opened (another device, a list drag) keeps that edit.
        // ceiling: a field both changed is last-write-wins (areas, goals, places, a checklist item's tick or text); add per-field conflict notices once a user reports an edit lost to another device's
        const fields = this._childPatch({ ...this.draftFields(), ...extra }, this.draftFields(saveBase));
        // the draft's checklist written: an item another tab or device added since open was never on screen to delete, so it stays
        if (fields.checklist === draft.checklist) { const seen = new Set([...saveBase.checklist, ...draft.checklist].map(c => c.id));
          fields.checklist = [...(before.checklist || []).filter(c => !seen.has(c.id)), ...draft.checklist]; }
        // draft.wasDone: set by a save whose checklist landed but completion failed — its retry must still complete, while the task is as that save left it
        const wasDone = draft.savedAt && draft.savedAt === before.updated_at ? draft.wasDone : !!(before.checklist?.length && before.checklist.every(c => c.done));
        // A save is ALWAYS slow enough to warrant feedback (composer collapse + reloadAll dominate; the store write
        // itself is quick, so the only-if-slow 150ms gate never tripped). Spin the checkmark IMMEDIATELY and let it
        // span the whole save — the post-save morph re-renders the row (clearing it) exactly when the saved data shows.
        this._setCheckPending(editId, true);
        // Where the row sits: its list (completing moves it to Done) and the flat rows either side, OUTSIDE its own subtree. Not its
        // INDEX — a row added or removed above shifts that while the row stays put — nor its parent or siblings (a new project in the
        // All view is not a move; its siblings are not its neighbours there) (B7). A move changes both neighbours, a neighbour's change one.
        const at = () => { this.visibleRows(); const o = _rowMap.get(editId), r = o ?? _doneMap.get(editId), rows = o ? _visMemo : _doneMemo;
          let n = (r?.i ?? -2) + 1; while (rows[n]?.depth > r?.depth) n++;   // past its own subtree
          return [!o, rows[r?.i - 1]?.t.id, rows[n]?.t.id]; }, at0 = at();
        const closed = this.closeComposer('pre');
        // The edit and the completion it triggers land as ONE entry; an edit that landed stays undoable though its completion failed.
        const j = [], opts = { ops: j, fail: null }, drops = [];   // the failure branch below says it, once
        let updated;
        const landed = await this._journalRowChange('Saved task', 'task', editId, async () => updated = await this.store.tasks.update(editId, fields), opts);
        const cl = updated?.checklist || [], done = cl.length > 0 && cl.every(c => c.done);
        // Only a newly finished checklist advances recurrence; later text edits must not complete it again.
        const completes = landed && !updated.checklist_plain && !this.hasChildren(editId) && cl.length && (updated.completed_at ? !done : done && !wasDone);
        const saved = landed && (!completes || await this._journalRowChange('Saved task', 'task', editId, () => this.store.tasks.setCompleted(editId, done), opts));
        // the ON register lands as a date-item, never as recur_from; a date the draft didn't change keeps one moved elsewhere. fail: null — the failure branch says it, once
        const added = draft.subs.some(s => s.add && !this.byId.has(s.id)), subbed = saved && await this._saveSubs(editId, draft, saveBase, j, drops);
        const when = x => [x.on, x.dueTime, !x.recurrence].join('|'), placed = subbed && (when(draft) === when(saveBase) || await this._saveSched(editId, draft, null, j, null) !== false);
        const kept = subbed && await this._saveReminders(editId, draft, saveBase, j, drops) && placed;   // a lost date is a failed save: its draft comes back
        // landed: this draft is the stored task now, but for a date that didn't land — the base a later save of it diffs against, so an edit undone is written back
        const nextBase = landed ? { ...JSON.parse(JSON.stringify(draft)), ...!placed && { on: saveBase.on, dueTime: saveBase.dueTime, recurrence: saveBase.recurrence }, reminders: saveBase.reminders,
          subs: subbed ? draft.subs.map(s => ({ id: s.id, done: s.done })) : saveBase.subs, subMoves: {} } : saveBase;
        if (kept) await this._applyDraftLinks(editId, draft, j);
        // a new subtask: an add's Bin row, so a ⌘Z puts it in the Bin (a deleted one has its own, _saveSubs)
        if (j.length) this._pushOps('Saved task', 'task', j, { silent: !kept, bin: subbed && added, restored: subbed && added });
        else if (kept) this.notify('Saved task');   // nothing the task row changed (signed in, an empty write stamps nothing): still said
        for (const drop of drops) drop();
        if (_draftFrom === sid) _saveBase = nextBase;   // the open draft continues this one (reopened mid-save): after every await, any reopen
        if (!kept) {
          // Save failed — the user's unsaved edits come back so nothing is silently lost: the composer reopens with them, or,
          // when another composer is open (being typed in), they go to the Bin — a reopen would steal its typing mid-word.
          this._setCheckPending(editId, false);   // drop the spinner; the composer takes over again
          if (landed) Object.assign(draft, { wasDone, savedAt: updated.updated_at });
          // the open draft continues this one (restored from it mid-save) and holds its typing: nothing to keep apart
          const binned = this.composer.open && !this._closingComposer && _draftFrom !== sid;
          this.toast(binned ? `${!saved ? landed ? 'Failed completing' : 'Failed saving' : !subbed ? 'Failed saving the subtasks of' : placed ? 'Failed saving the reminders of' : 'Failed scheduling'} “${before.content}”. Kept in the Bin` : !saved ? 'Failed saving. Try again?' : !subbed ? 'Failed saving subtasks. Try again?' : placed ? 'Failed saving a reminder. Try again?' : 'Failed scheduling. Try again?');
          if (binned) this._pushDraftBin(editId, { editing: editId, ...this._draftState({ draft }), base: nextBase, sid, ts: Date.now() });
          if (this.composer.open && !this._closingComposer) return false;
          this.subGhost = this.chkGhost = ''; this._clearEditor(this._ghostEl('sub'));   // its ghosts were committed before the save
          this.editing = editId; _editPin = editId; this.draft = draft; this._draftSid = sid; _draftFrom = null; _saveBase = nextBase;
          this._draftBase = landed && !saved ? this._draftSig() : base;   // only the completion failed: the edits are saved, so an Esc has nothing more to keep
          this.openComposer();
          return false;
        } else {
          // No scroll-hold: closeComposer turns anchoring OFF for the collapse (B2's scoped exception) and back on two
          // frames after, when it absorbs a later re-render. Spinner + flash are cosmetic: on once the write is confirmed.
          this._clearPending(editId, sid, this._draftSig({ draft }));   // saved → discard the pending draft so it can't resurrect over the save
          if (from) this._clearPending(editId, from);   // this draft continues that one: its rows are superseded
          this.$nextTick(() => { this._setCheckPending(editId, false); this._flashSaved(editId); });
          // Only a save that MOVED the row carries the reader to it (composer.md §STAY rule) — a tall row you had
          // scrolled past is off-screen too, and revealing it glided the list ~1000px (B2). Judged once the save has
          // landed AND the collapse settled (a signed-in save outlasts it), and not if the reader scrolled >300px since.
          closed.then(() => requestAnimationFrame(() => { const a = at();
            if ((a[0] !== at0[0] || a[1] !== at0[1] && a[2] !== at0[2]) && !(sc && Math.abs(sc.scrollTop - stBefore) > 300)) this._revealRow(editId); }));
        }
        return true;
      }
      return !!await this.addTask(close);
    },
    // Ctrl/Cmd+Enter: submit then close. A save closes on its own; a composer open by the time it lands is another draft's.
    async submitAndClose() { const d = this.draft; if (await this.submitComposer(undefined, true) === true && this._live(d)) this.closeComposer(); },
    onKey(e) {
      this.kbd = true;
      if (this.sticky && this._stickyKey(e)) return;
      // A real scrolling key we leave to the browser (PageUp/Down, Home/End, ⌥↓, Space, Tab's focus scroll) drops our step's
      // target, so the settle never pulls that scroll back. Read after this handler, so our own keys keep a pending step. Any
      // other key (Escape, z, a bare Shift) scrolls nothing: the glide runs on, and a settle due mid-glide still lands its target.
      // ceiling: find-in-page and screen-reader scrolls send no event, so a step pending then still pulls them back — clear the target on a scroll heading away from it if that's reported.
      if (this.clView === 'month' && e.isTrusted && /^(Arrow\w+|Page(Up|Down)|Home|End|Tab| )$/.test(e.key)) queueMicrotask(() => e.defaultPrevented || (this._clMTo = null));
      const tag = (e.target.tagName || '').toLowerCase();
      // ⌘/Ctrl+Z in a field is the field's own: native text undo, or nlpHistory in a pill editor (_pillKeydown);
      // the app undo stack only takes over outside fields (list-level actions: complete, delete, move…).
      const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const dialogs = OVERLAYS.filter(([open, , dialog]) => dialog && open(this)).length;
      // The ? sheet teaches its keys: one it lists closes it and runs, like its ↗ launchers. Settings and any other dialog keep them dead.
      const sheetOnly = this.shortcutsOpen && !this.settingsOpen && dialogs === 1;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        if (inField) return;   // let the browser's native text undo/redo run
        e.preventDefault();   // Chrome's own Undo would rewrite the last-edited editor, focused or not
        // A modal keeps ⌘Z off what's behind it; the Bin, block editor and places manager journal their own controls' actions.
        if (this.modalOpen() && !sheetOnly && !(dialogs === 1 && (this.trashOpen || this.blockEdit || this.locMgr))) return;
        // composer open → only its OWN draft edits step; task-level ones stay blocked. A closing one (open stays true through the 240ms collapse) is shut.
        if (this.composer.open && !this._closingComposer && !DRAFT_KINDS.includes(this._journalPeek(e.shiftKey ? 1 : -1)?.kind)) return;
        e.shiftKey ? this.redo() : this.undo();   // ⌘⇧Z = redo
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && this.composer.open && !this.modalOpen() && this.chkDelSel(e)) return;
      // ⌘/Ctrl+Enter saves & closes the open composer from anywhere but the palette, whose ↵ is its own, and a dialog's field — no input focus needed.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.composer.open && !this.palette.open && !(inField && e.target.closest('[role=dialog]'))) { e.preventDefault(); this.submitAndClose(); return; }
      // ⌘/Ctrl+K opens the everything-nav palette from anywhere but a modal, even mid-typing (Space does it outside typing).
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); if (sheetOnly) this.shortcutsOpen = false; if (!this.modalOpen()) this.openPalette(); return; }
      // ⌘/Ctrl+F on Lists is `/`, even mid-typing: the Done list windows its rows, so the browser's find misses them.
      // An open composer or modal keeps the browser's find; in the search, it selects the query, as the find bar does.
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey && !e.altKey && this.listView() && !this.composer.open && (!this.modalOpen() || sheetOnly)) { e.preventDefault(); this.shortcutsOpen = false; return this.openListSearch(true); }
      // Plan claims ⌘/Ctrl+↑/↓ as well: the native binding is "scroll to the end of the document", and the
      // month scroller is virtualized to ~670k px, so it read as an uncontrollable fling. One period, morphed —
      // the same readable jump as Shift.
      // (no composer guard: the composer lives on Lists, and a stale-open one must not hand the fling back)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.surface === 'plan'
          && (!this.modalOpen() || sheetOnly) && !this.overview) {
        e.preventDefault(); this.shortcutsOpen = false; this.clStep(e.key === 'ArrowDown' ? 1 : -1, true); return;
      }
      // Single-key shortcuts — only when not typing, composing, or under a modal (Settings or a dialog), and unmodified.
      if (e.metaKey || e.ctrlKey || e.altKey || this.composer.open || (this.modalOpen() && !sheetOnly)
          || (sheetOnly && e.key === 'Enter' && e.target.closest?.('button'))   // a sheet control's Enter is its own (↗, ×), as natively
          || tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (this.overview) {   // the overview deck owns the keys while it's open
        if (this.ovSel === 0 && ['ArrowDown', 'j'].includes(e.key)) { e.preventDefault(); return this.rollerMove(1); }
        if (this.ovSel === 0 && ['ArrowUp', 'k'].includes(e.key))   { e.preventDefault(); return this.rollerMove(-1); }
        if (['ArrowRight', 'l'].includes(e.key)) { e.preventDefault(); this.ovMove(1); }
        else if (['ArrowLeft', 'h'].includes(e.key)) { e.preventDefault(); this.ovMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.ovSel === 0 ? this.rollerOpen() : this.diveTo(this.surfaceOrder[this.ovSel]); }
        else if (this.surfaceOrder[e.key - 1]) { e.preventDefault(); this.diveTo(this.surfaceOrder[e.key - 1]); }   // 1..n: the shipped surfaces (SURFACES)
        else if (e.key === 'o') { e.preventDefault(); this.closeOverview(); }
        if (!['?', ' ', 'q', 'b', 'g', 'a'].includes(e.key)) {   // the sheet's Global keys still run: the help opens over the deck, the rest leave it
          if (sheetOnly && e.defaultPrevented) this.shortcutsOpen = false;   // a deck key the sheet lists closes it, as below
          return;
        }
        if (e.key !== '?') this.closeOverview();
      }
      if (e.key === 'q') { e.preventDefault(); this.quickAdd(); }
      else if (e.key === 'b') { e.preventDefault(); this.trashOpen = true; }   // Bin (Recently Deleted) — recover anything
      else if (e.key === 'g') { e.preventDefault(); this.setNav('backlog'); }
      else if (e.key === 'a') { e.preventDefault(); this.setNav('all'); }
      // d / w / m switch the calendar's view, Plan-only — the same letters as the on-screen switcher, so the
      // keys teach themselves. `d` is free for this because the Bin moved to `b`.
      else if (this.surface === 'plan' && 'dwm'.includes(e.key)) { e.preventDefault(); this.clSetView({ d: 'day', w: 'week', m: 'month' }[e.key]); }
      // A focused month day walks the days: the month is one Tab stop, so this is how the keyboard reaches the rest.
      else if (e.target.classList?.contains('cl-date') && !e.shiftKey && CL_WALK[e.key]) { e.preventDefault(); this.clWalkDay(CL_WALK[e.key]); }
      // Plan has no list of rows to walk, so ↑/↓ drive the timeline itself — and by a UNIT you can name (an
      // hour, a week row), never a raw pixel nudge, so you always land somewhere you can read off the gutter.
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.surface === 'plan') {
        e.preventDefault(); const dir = e.key === 'ArrowDown' ? 1 : -1;
        // Shift travels a whole period and MORPHS, like a view switch: a deliberate jump should read as
        // movement. A held plain arrow's period steps turn the page as the wheel does (decision #75).
        e.shiftKey ? this.clStep(dir, true) : this.clArrow(dir, e.repeat);
      }
      else if (e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); this.selExtend(1); }   // Shift+↑/↓ extends the multi-select
      else if (e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); this.selExtend(-1); }
      else if ((e.key === 'j' || e.key === 'ArrowDown') && this.listView()) { e.preventDefault(); this.moveFocus(1); }   // off Lists the rows are hidden
      else if ((e.key === 'k' || e.key === 'ArrowUp') && this.listView()) { e.preventDefault(); this.moveFocus(-1); }
      else if ((e.key === 'Enter' || e.key === 'e') && this.focusId) { e.preventDefault(); this.openFocused(); }
      else if (e.key === 'x' && this.focusId && this.listView()) { e.preventDefault(); this.toggleFocused(); }   // complete focused row (Space now opens the palette)
      else if (e.key === '?') { e.preventDefault(); this.shortcutsOpen = true; }
      else if (e.key === '/' && this.listView()) { e.preventDefault(); this.openListSearch(); }
      else if (e.key === 'f' && this.listView()) { e.preventDefault(); if (this.sel.length) this.clearSel(); this.listMenu = this.listMenu === 'add' ? null : 'add'; }   // f → filter sentence menu (clears a selection, as / does)
      else if (this.surfaceOrder[e.key - 1]) { e.preventDefault(); this.goSurface(this.surfaceOrder[e.key - 1]); }   // 1..n jump to a surface; only digits index it
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.goSurface(this.surfaceOrder[Math.max(0, this.surfaceIndex() - 1)]); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.goSurface(this.surfaceOrder[Math.min(this.surfaceOrder.length - 1, this.surfaceIndex() + 1)]); }
      else if (e.key === ' ' && !e.target.isContentEditable && !e.target.closest?.('button, [role=button], a, summary')) { e.preventDefault(); this.openPalette(); }   // Space → the everything-nav palette; a focused control keeps its own Space
      else if (e.key === 'o') { e.preventDefault(); this.openOverview(); }   // o → zoom-out overview deck
      if (sheetOnly && e.defaultPrevented && e.key !== '?') this.shortcutsOpen = false;
    },
    _syncHist() {   // exactly one history entry while any overlay is open (init's popstate)
      const open = OVERLAYS.some(([o]) => o(this));
      if (open && !history.state?.overlay) history.pushState({ overlay: 1 }, '');
      else if (!open && history.state?.overlay && !_histPop) { _histPop = true; history.back(); }   // hand the entry back without navigating
    },
    // The sticky note's keys (contract: ops/shared/sticky-typing-contract.md): from the title ↓ walks the matches; on a
    // match Space completes, Enter opens, ↑ off the first returns, any other key types into the title again. Esc clears the
    // title; on an empty one it hands the foreground back. Its composer is always open, so onKey's list keys never run.
    // IME: composing keydowns never get here (init's capture listener stops them).
    _stickyKey(e) {
      const title = this.$refs.content, inTitle = e.target === title;
      if (e.metaKey || e.ctrlKey || e.altKey || (inTitle && Object.values(PICKERS).some(p => this[p.key].open))) return false;   // an open # / @ picker keeps its keys
      const take = () => { e.preventDefault(); e.stopPropagation(); return true; };
      if (document.documentElement.classList.contains('folded')) return take();   // folded, the rows and line are hidden: no key acts on them unseen
      // Esc's clear is one ⌘Z step in the line: the pre-clear snapshot goes onto the fresh editor's history
      if (inTitle && e.key === 'Escape') { if (this.titleEmpty) desktopWindow('back'); else { const was = this._nlpSnap(title); this.resetDraft(); this.setEditorText(''); title._hist.undo.push(was); } return take(); }
      if (inTitle && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.visibleRows().length) { title.blur(); this.moveFocus(e.key === 'ArrowDown' ? 1 : -1); return take(); }   // the line sits under the rows: ↑ takes the one above it, ↓ the first
      if (inTitle) return false;
      if (e.key === 'Escape' || this.focusId && e.key === 'ArrowDown' && this.visibleRows().at(-1)?.t.id === this.focusId) { this._setKbFocus(null); title.focus(); return take(); }
      if (this.focusId && e.key === ' ') { this.toggleFocused(); return take(); }
      if (this.focusId && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { this.moveFocus(e.key === 'ArrowDown' ? 1 : -1); return take(); }
      if (this.focusId && e.key === 'Enter') { this.openFocused(); return take(); }
      // any other key types into the line — never an app shortcut: the line is the note's only keyboard target
      if (e.key.length === 1) { this._setKbFocus(null); title.focus(); getSelection().selectAllChildren(title); getSelection().collapseToEnd(); }   // the key lands there
      return false;
    },
    escape() {
      // Escape from inside a menu hands focus back to its trigger — the control that says it is expanded.
      // ceiling: the FIRST expanded trigger in DOM order — the filter menu has three, so Escape may land on "everything",
      // not the chip that opened it; remember the opener per menu if that is reported or a menu shares triggers across rows.
      const trigger = document.activeElement?.closest('.pop') && document.querySelector('[aria-haspopup][aria-expanded="true"]');
      const o = OVERLAYS.find(([open]) => open(this));
      if (o) o[1](this); else if (this.focusId) this._setKbFocus(null);
      trigger?.focus();
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

    // unreachable: keep the last good rows (the failed write says so itself). The rows a write or realtime changed land
    // through _patchTask; anything it can't patch (a row added or gone, a moved one) replaces the list.
    async loadTasks() {
      const tasks = await this.store.tasks.list().catch(() => null); if (!tasks) return;
      const gen = ++_tasksGen;
      await this._loadFiles(tasks.flatMap(t => t.attachments ?? []));   // before the rows publish: a chip never draws nameless
      if (gen !== _tasksGen) return;   // a later load's list is newer
      this._defId = this.store.defaultProject();
      const had = window.Alpine.raw(this.byId), changed = tasks.length === had.size && tasks.filter(t => { const o = had.get(t.id); return o !== t && JSON.stringify(o) !== JSON.stringify(t); });
      if (changed && (!changed.length || this._patchTask(changed))) return;
      _rowStale = changed && _visBP && changed.every(r => had.get(r.id) && had.get(r.id).parent_id === r.parent_id) ? this._rowsReading(changed.map(r => r.id), true) : null;   // a move or a row not seen before: rebuild all
      this._rowV++; _calDataV++; this.tasks = tasks; this.byId = new Map(tasks.map(t => [t.id, t])); this.parentIds = new Set(tasks.map(t => t.parent_id).filter(Boolean));
      if (this.navSel.type === 'project' && !this.byId.has(this.navSel.id)) this.setNav('all');   // its project went (another device's delete)
    },
    // Ids of the rows that read these tasks: their own, their subtrees' (project name, Notes), every row they block and,
    // with `up`, their ancestors' (progress, rolled-up estimate). Reads the index of the rows as rendered, so call it before a _rowV bump.
    _rowsReading(ids, up) {
      const out = new Set(), inv = this._taskIdx().inv;
      const down = id => { if (out.has(id)) return; out.add(id); for (const c of _visBP.get(id) || []) down(c.id); };
      for (const id of ids) down(id);   // every subtree before any other row: one already in `out` ends the walk at it
      for (const id of ids) {
        for (const b of inv.get(id) ?? []) out.add(b);
        if (up) for (const a of this._chain(this.byId.get(id).parent_id)) out.add(a);
      }
      return out;
    },
    async loadAreas() { const areas = await this.store.areas.list(); this._rowV++; this.areas = areas; this._pruneQfAreas(); },
    _pruneQfAreas() {   // a gone area left in the filter hides every task (here, elsewhere, or under another account)
      const has = id => this.areas.some(a => a.id === id), all = [...this.qfAreas, ..._qfGone.filter(id => !this.qfAreas.includes(id))];
      const live = all.filter(has);
      _qfGone = all.filter(id => !has(id));
      if (live.join() !== this.qfAreas.join()) { this.qfAreas = live; this._saveView(); }
    },
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
        task: () => this.loadTasks(), area: () => this.loadAreas(), message: () => this.chatReload(),
        event: () => this.loadEvents(), block: () => this.loadBlocks(),
        filter: () => this.loadFilters(),
        location: async () => { this.locations = await st.locations.list(); this._rowV++; this.homeLocationId = st.homeLocationId(); this.currentRegion = st.currentRegion(); },   // _rowV: rows bake rowLoc's place name into the row cache
        // a date-item IS a row's date: only the rows whose placement changed repaint — all of them when the view sorts or groups by date
        scheduleItem: async () => {
          const si = await st.scheduleItems.list(), was = this._placedMap(); _calDataV++; this.scheduleItems = si;
          const now = this._placedMap(), ids = new Set([...was.keys(), ...now.keys()].filter(id => was.get(id) !== now.get(id)));
          if (!ids.size) return;   // a block attachment: no row reads it
          const kids = this._taskIdx().kids;   // and the subtasks showing a placed row's date, or showing it until now (_follows)
          for (const id of [...ids]) for (const d of descendantIds(this.tasks, id, kids).slice(1)) if (this._follows(this.byId.get(d), now) || this._follows(this.byId.get(d), was)) ids.add(d);
          if (this._canPatch() && ![...VIEW_KEYS[this.sortBy] || [], ...VIEW_KEYS[this.groupBy] || []].includes('recur_from')) this._patchRows(ids);
          else this._rowV++;
        },
        reminder: async () => { this.reminders = await st.reminders.list(); },   // no row renders reminders — no repaint
        dayNote: async () => { this.dayNotes = await st.dayNotes.list().catch(() => this.dayNotes); },   // a failed read keeps the names, unsaid: a DB without the table must still run
        blockDay: async () => { const bd = await st.blockDays.list(); _calDataV++; this.blockDays = bd; },   // bump first: an effect running on the write must miss clBlocks' memo
      };
    },
    // An unknown kind falls back to the whole account — and 'all' is exactly that on purpose: it's what the
    // store sends when realtime dropped and came back, i.e. the one moment we know there may be a hole.
    // A failed re-read keeps its list's last good rows, never throws past the caller (realtime, a save's journal write or
    // toast), and is said + retried by the minute tick, as reloadAll's.
    _reloadFor(kind) { return (this._loaders()[kind] || (() => this.reloadAll()))().catch(() => { if (!this._loadFailed) this.toast('Couldn’t load, retrying'); this._loadFailed = true; }); },
    // After _apply: each list its ops touched, once — never the whole account. An op carrying rows (a reinsert, or the remove
    // taking one back) moved rows out or in, and with them what points at them: a delete's cascade or scrub (Postgres FKs and
    // delete_area/delete_location, LocalStore's prune), a reinsert's `also`.
    async _reloadAfter(inv) {
      const deps = o => o.kind === 'reinsert' || o.rows ? { task: ['task', 'scheduleItem', 'reminder'], block: ['block', 'scheduleItem', 'blockDay', 'reminder'],
        area: ['area', 'task', 'block'], location: ['location', 'task', 'block', 'event'] }[o.target] || [o.target] : [o.target];
      await Promise.all([...new Set((inv.kind === 'composite' ? inv.ops : [inv]).flatMap(deps))].map(k => this._reloadFor(k)));
    },
    areaById(id) { return byIdIn(this.areas).get(id); },
    // The ? sheet's rows — also the coach's key lookup (_coach), so a tip can't drift from the sheet.
    shortcutGroups() {
      return [
        {l:'Global',r:[['<kbd>␣</kbd>','Go to anything'],['<kbd>⌘</kbd><kbd class=sk-letter>k</kbd>','Go to anything (works while typing)'],...this.surfaceOrder.map((s, i) => ['<kbd>' + (i + 1) + '</kbd>', 'Go to ' + SURF_META[s].label]),['<kbd class=sk-arrow>←</kbd><kbd class=sk-arrow>→</kbd>','Step surfaces'],['<kbd class=sk-letter>q</kbd>','New task'],['<kbd class=sk-letter>g</kbd>','Backlog'],['<kbd class=sk-letter>a</kbd>','All'],['<kbd>⌘</kbd><kbd class=sk-letter>z</kbd> · <kbd>⌘</kbd><kbd class=sk-mod>⇧</kbd><kbd class=sk-letter>z</kbd>','Undo / redo'],['<kbd class=sk-letter>b</kbd>','Bin'],['<kbd class=sk-letter>o</kbd>','Overview'],['<kbd>?</kbd>','This help'],['<kbd>esc</kbd>','Close any open overlay']]},
        {l:'Overview',r:[['<kbd class=sk-letter>h</kbd>/<kbd class=sk-letter>l</kbd> · <kbd class=sk-arrow>←</kbd><kbd class=sk-arrow>→</kbd>','Move across surfaces'],['<kbd class=sk-letter>j</kbd><kbd class=sk-letter>k</kbd> · <kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','Move through Lists destinations'],['<kbd>↵</kbd>','Open overview selection'],['<kbd>1</kbd>–<kbd>' + this.surfaceOrder.length + '</kbd>','Open surface directly'],['<kbd class=sk-letter>o</kbd>','Close overview']]},
        {l:'Finder',r:[['<kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','Move finder selection'],['<kbd>↵</kbd>','Open finder selection'],['<kbd>⌘</kbd><kbd class=sk-letter>s</kbd>','Save query as filter']]},
        {l:'Task list',r:[['<kbd class=sk-letter>j</kbd><kbd class=sk-letter>k</kbd> · <kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','Move focus'],['<kbd>↵</kbd>/<kbd class=sk-letter>e</kbd>','Open focused'],['<kbd class=sk-letter>x</kbd>','Complete focused'],['<kbd class=sk-mod>⇧</kbd><kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','Extend selection'],['<kbd>/</kbd> · <kbd>⌘</kbd><kbd class=sk-letter>f</kbd>','Search tasks'],['<kbd class=sk-letter>f</kbd>','Filter tasks']]},
        {l:'Plan',r:[['<kbd class=sk-letter>d</kbd>/<kbd class=sk-letter>w</kbd>/<kbd class=sk-letter>m</kbd>','Day / week / month'],['<kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','Scroll an hour · hold 3s to travel'],['<kbd class=sk-mod>⇧</kbd><kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>/<kbd>⌘</kbd><kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','Travel a day / week / month'],['<kbd class=sk-arrow>←</kbd><kbd class=sk-arrow>→</kbd><kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>','On a month day: the next day / week']]},
        {l:'Composer',r:[['<kbd>↵</kbd>','Save / add another'],['<kbd>⌘</kbd><kbd>↵</kbd>','Save & close'],['<kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>/<kbd>⇥</kbd>','Move between fields'],['<kbd class=sk-arrow>↑</kbd> in an empty title','Edit the task just added'],['<kbd>esc</kbd>','Close']]},
        {l:'Composer entries',r:[['<kbd>↵</kbd>','Add next entry'],['<kbd class=sk-mod>⇧</kbd><kbd>↵</kbd>','New line in entry'],['<kbd class=sk-arrow>↑</kbd><kbd class=sk-arrow>↓</kbd>/<kbd class=sk-arrow>←</kbd><kbd class=sk-arrow>→</kbd>','Navigate open picker'],['<kbd>↵</kbd>','Choose picker option'],['<kbd>⌘</kbd><kbd class=sk-mod>⇧</kbd><kbd class=sk-letter>v</kbd>','Paste lines as one entry'],['<kbd>⌫</kbd> on rows dragged across','Delete selected entries']]},
        {l:'Syntaxes'},
        {l:'Composer syntax',r:[
          ['<b>!</b> · <b>!!</b> · <b>~</b>','Importance symbols'],['<b>focus on</b> · <b>must</b> · <b>someday</b>','Importance words'],
          ['<b>tomorrow</b> · <b>fri</b> · <b>next week</b>','Schedule a day or window'],['<b>in 3 days</b> · <b>aug 10</b> · <b>2026-12-25</b>','Schedule relative to now'],
          ['<b>5pm</b> · <b>noon</b>','Set a time'],['<b>30m</b> · <b>1h30m</b>','Set duration'],
          ['<b>by fri</b> · <b>due tomorrow</b> · <b>^ aug 10</b>','Set deadline'],['<b>only tue</b>','Restrict to one day'],
          ['<b>#project</b>','Choose project'],['<b>@area</b>','Add area'],['<b>at Office</b>','Require a location'],['<b>away from Home</b>','Exclude a location'],
          ['<b>needs Report</b> · <b>needed by Launch</b>','Add dependency'],['<b>Item :: detail</b>','Checklist description only']]},
        {l:'Filter syntax',r:[
          ['<b>#work</b> · <b>##work</b>','Project / descendants'],['<b>@errands</b>','Area'],['<b>importance:must,focus</b>','Importance'],
          ['<b>due:overdue</b> · <b>due:today..eow</b>','Due date'],['<b>deadline:any</b> · <b>deadline:eow</b>','Deadline'],
          ['<b>is:open</b> · <b>is:recurring</b> · <b>is:blocked</b> · <b>is:note</b>','State'],['<b>in:title</b> · <b>in:description</b>','Search field'],
          ['<b>AND</b> · <b>OR</b> · <b>NOT</b> · <b>( )</b> · <b>-@home</b>','Combine / negate'],
          ['<b>#work importance:must due:overdue</b>','Example: urgent overdue work'],
          ['<b>(is:blocked OR deadline:today) is:open</b>','Example: blocked or due today'],
          ['<b>report in:description -@home</b>','Example: description away from home']]},
        {l:'Recurrence syntax',r:[
          ['<b>every day</b> · <b>every 2 weeks</b>','Repeat on an interval'],['<b>every! week</b>','Repeat from completion'],
          ['<b>every 2 weeks on mon wed at 9am</b>','Choose repeat days and time'],['<b>every day, 3 times</b>','End after a count'],
          ['<b>every week ending sep 1</b>','End on a date']]},
        {l:'Description Markdown',r:[
          ['<b>**bold**</b> · <b>*italic*</b> · <b>~~strike~~</b>','Bold / italic / strike'],['<b>`code`</b>','Inline code'],
          ['<b>```code```</b>','Code block'],['<b>[label](https://example.com)</b>','Link'],['<b># Heading</b> · <b>- Item</b>','Heading / bullet']]}
      ];
    },
    // The 2nd mouse use of one action in a session shows its key — once ever per action, never blocking.
    _coach(data) {   // the control's dataset: sk = its sheet label, skKey = its own key where the row lists several (d/w/m)
      const label = data?.sk;
      _skKeys ??= new Map(this.shortcutGroups().flatMap(g => g.r || []).map(([k, d]) => [d, keyTip(k, this.mod)]));
      if (!_skKeys.has(label) || _tipsSeen.has(label)) return;
      const uses = (_skUses.get(label) || 0) + 1;
      _skUses.set(label, uses);
      if (uses < 2) return;
      _tipsSeen.add(label);
      localStorage.setItem('adherod.tipsSeen', JSON.stringify([..._tipsSeen]));
      this.notify(`Tip: ${data.skKey || _skKeys.get(label)} does this`, { actions: [{ label: 'Got it', fn: () => {} }, { label: 'Stop tips', fn: () => this.setFlag('shortcutTips', false) }] });
    },
    setFlag(key, on) { this[key] = on; localStorage.setItem('adherod.' + key, on ? '1' : '0'); },   // a Settings On/Off
    setCelebrations(mode) { this.celebrations = mode; localStorage.setItem('adherod.celebrations', mode); },
    toast(msg) { return this.notify(msg); },   // thin wrapper: a plain message with no actions
    // Push a card onto the bottom-right stack. With action buttons it lingers longer (8s) so the Undo is reachable.
    notify(msg, { actions = [], timeout = actions.length ? 8000 : 4000 } = {}) {
      const id = crypto.randomUUID();
      this.notifs.push({ id, msg, actions, leaving: false });
      // cap the visible stack (a leaving card is already going), never the card just pushed — the user must see it:
      // oldest older card without Undo/Redo first (plain, a tip), an Undo card only when all older ones carry one (⌘Z still reaches it)
      const older = this.notifs.filter(n => !n.leaving && n.id !== id);
      if (older.length > 2) this._dismissNotif((older.find(n => !n.actions.some(a => a.jid)) || older[0]).id);
      _notifTimers.set(id, { left: timeout, holds: new Set() });
      this._notifRun(id);
      return id;
    },
    _notifRun(id) { const t = _notifTimers.get(id); t.at = Date.now(); t.timer = setTimeout(() => this._dismissNotif(id), t.left); },
    // The pointer on a card or focus in it holds its timer: it must not vanish mid-reach and drop its focused Undo to the page.
    _notifHold(id, why, on) {
      const t = _notifTimers.get(id); if (!t) return;
      if (on && !t.holds.size) { clearTimeout(t.timer); t.left -= Date.now() - t.at; }
      if (on) t.holds.add(why);
      else if (t.holds.delete(why) && !t.holds.size) this._notifRun(id);
    },
    _dismissNotif(id) {
      clearTimeout(_notifTimers.get(id)?.timer); _notifTimers.delete(id);
      const n = this.notifs.find(x => x.id === id); if (!n || n.leaving) return;
      n.leaving = true;                                                    // triggers the exit transition
      setTimeout(() => { this.notifs = this.notifs.filter(x => x.id !== id); }, 260);
    },
    _runNotifAction(n, a) { a.fn(); this._dismissNotif(n.id); },           // action fires, then the card leaves
    // --- Composer draft safety ---
    // Nothing typed is ever lost to a mispress: the whole draft is persisted (adherod.draftPending,
    // keyed by editing id or this tab's _newKey) on EVERY change while the composer is open (x-effect → persistDraft).
    // Closing a dirty+unsaved draft KEEPS it (persisted) + makes it ⌘Z-undoable; reopening restores it.
    _pendingMap() { try { return JSON.parse(localStorage.getItem('adherod.draftPending')) || {}; } catch { return {}; } },
    _writePending(map) {
      try { localStorage.setItem('adherod.draftPending', JSON.stringify(map)); this._pSaveFailed = false; return true; }
      catch { if (!this._pSaveFailed) this.toast('Storage is full. This draft won’t survive a reload'); this._pSaveFailed = true; return false; }
    },
    // Clearing a pending draft with its `sid` means THAT draft LANDED (saved, or reverted to the saved state) → its pending
    // slot and bin rows are stale: a "Restore" that re-applies text already on the task is worse than no row at all. Another
    // draft's — and every row when there's no sid (the explicit Discard) — stay: the bin may hold their only copy.
    // saved: the landed draft's sig — any copy of exactly that under key is stale too (an open one turns clean)
    _clearPending(key, sid, saved) {
      const m = this._pendingMap(), same = (p, k = key) => p?.sid === sid || !!saved && k === key && this._draftSig(p) === saved;
      if (key in m && (!sid || same(m[key]))) { delete m[key]; this._writePending(m); }
      if (!sid) return;
      if (saved && this.composer.open && !this._closingComposer && this._draftKey() === key && this._draftSig() === saved) this._draftBase = saved;
      let hit = false;
      for (const e of this.journal) if (e.kind === 'draft' && e.bin && !e.restored && same(e.payload, e.payload?.key)) { e.restored = e.detached = true; hit = true; }
      if (hit) this._journalSave();
    },
    _draftKey() { return this.editing || this._newKey(); },
    _newKey(acct = this._acct()) { return (acct ? 'new:' + acct : 'new') + '@' + _tab; },   // per account and tab: task ids are already unique
    _live(d) { return this.composer.open && !this._closingComposer && this.draft === d; },   // after every composer await: still draft d, open? (its object: a restored draft shares its sid)
    // The full composer input state — draft fields PLUS the uncommitted ghost buffers. This is the unit of
    // loss-protection: everything the user has typed, committed or not. Reading it also subscribes the
    // x-effect to all three, so persistDraft re-fires when you type in a ghost box (not just the draft).
    _draftState(s = this) { return { draft: s.draft, chkGhost: s.chkGhost || '', subGhost: s.subGhost || '' }; },
    _draftSig(s) { return JSON.stringify(this._draftState(s)); },   // s: a pending entry (default: the live composer)
    // TWO x-effects on the composer re-run this on any edit: persistDraft() on the li subscribes to every draft field +
    // both ghost buffers + editing, and persistDraft(true) on .composer-grow to the checklist alone — so a title
    // keystroke never walks a 120-item checklist (it stringified the whole draft per key, ~1ms at 4× CPU).
    // Writes are debounced (~300ms) to avoid N serializations per keystroke; flush fires synchronously on pagehide/
    // visibilitychange (registered in init below) so no data is lost when the page closes between keystrokes.
    persistDraft(chk) {
      const cl = this.draft.checklist;
      if (chk) _touch(cl); else { _touch(this._draftState(), cl); void this.editing; }
      // open flips to false only in the async grow-close callback, so guard the whole close window here —
      // otherwise a save/close that just cleared the pending gets it re-written by this effect mid-animation.
      if (!this.composer.open || this._closingComposer) return;
      clearTimeout(_draftT);
      _draftT = setTimeout(() => this._flushDraftNow(), 300);
    },
    _draftEntry() { return { editing: this.editing, ...this._draftState(), base: _saveBase, sid: this._draftSid, ts: Date.now() }; },
    _flushDraftNow() {
      if (!this.composer.open || this._closingComposer) return;
      const s = this._draftSig(), map = this._pendingMap(), key = this._draftKey();
      if (s !== this._draftBase) map[key] = this._draftEntry();
      else if (map[key]?.sid === this._draftSid) delete map[key]; else return;   // clean → drop this draft's stale copy; another tab's composer on the same task shares the key
      this._writePending(map);
    },
    // Ends the open draft — on a close, and before a composer opens over it (editTask/startAdd/_reopenDraft swap the
    // draft in place). A drop that ISN'T a save/delete keeps unsaved edits pending, so reopening restores them; a
    // saved/handled one clears the pending draft so it can't resurrect over the save.
    _endDraft(saved) {
      if (this.composer.open && !this._closingComposer) {
        // Make the pending map EXACT before branching: the debounce may still hold the last <300ms of typing
        // (or the cleanup flush that marks a re-cleaned draft), and every branch below reads the map's truth.
        clearTimeout(_draftT); this._flushDraftNow();
        const key = this._draftKey();
        if (saved === true || this._draftSig() === this._draftBase) this._clearPending(key, this._draftSid);
        // dropped-but-kept dirty draft → a recoverable "Draft" bin row + ⌘Z reopen (pending autosave stays too)
        else if (saved !== 'pre') this._pushDraftBin(key);
        // 'pre': save in progress — don't consume journal entry; caller calls _clearPending on confirmed success
      }
      this._closingComposer = true;   // stop persistDraft re-writing it (the async grow-close; an open re-arms it) — and a 2nd end is a no-op
    },
    // Called from startAdd/editTask AFTER the pristine draft is built: record the baseline, then restore a
    // newer unsaved draft for this key if one exists (and it actually differs from the pristine state).
    _initDraftSafety() {
      this._draftBase = this._draftSig();
      const m = this._pendingMap(), key = this._draftKey();
      const out = this._newKey(null);
      if (m[out] && !this.editing && !m[key]) { m[key] = m[out]; delete m[out]; this._writePending(m); }   // signed out's draft: this tab's first signed-in add-composer takes it
      // an entry from before a draft field existed; one from before `subs` has the stored subtasks — [] would delete them all on Save
      const base = JSON.parse(this._draftBase).draft, fill = (d, held) => { const { subHeld, ...x } = d || {}; return { ...emptyDraft(), subs: [...held ? (subHeld || []).map(h => ({ ...h, add: true, done: false })) : [], ...base.subs], ...x }; };
      const raw = _handoff?.key === key ? _handoff.payload : m[key], p = raw && { ...raw, draft: fill(raw.draft, true) };
      const r = p && this._draftSig(p) !== this._draftBase;
      if (_handoff?.key === key) _handoff = null;
      // THIS draft's identity (every add-composer has editing === null, so a task id can't tell two blank drafts
      // apart); a restored draft keeps its own, so saving it retires the Bin row its close left — unless that draft
      // is mid-save: then this is another draft, whose rows that save mustn't retire
      const mid = r && p.sid === _submitting;
      this._draftSid = r && !mid && p.sid || crypto.randomUUID(); _draftFrom = mid ? p.sid : null;
      _saveBase = r && p.base ? fill(p.base) : base;   // an entry from before `base`: the task as stored now
      if (r) {
        this.draft = p.draft; this.chkGhost = p.chkGhost || ''; this.subGhost = p.subGhost || ''; this.draftRestored = true;
        // A restored ghost buffer auto-fills via x-model; put the caret back at its end so typing resumes in place.
        this.$nextTick(() => {
          if (!this.composer.open) return;
          const kind = this.chkGhost ? 'chk' : this.subGhost ? 'sub' : null;
          const el = kind && this._ghostEl(kind);
          if (kind === 'sub') el.textContent = this.subGhost;   // subGhostSync skips a focused ghost, and openComposer focused it first
          if (el) this._focusEntry(el);   // handles both shapes: the chk ghost is a textarea, the subtask ghost contenteditable
        });
      } else this.draftRestored = false;
    },
    // Banner "Discard": drop the recovered draft, revert to the saved/pristine state (composer stays open).
    discardDraft() {
      clearTimeout(_draftT);   // cancel any pending debounce so it can't re-add after _clearPending
      this._clearPending(this._draftKey()); this._draftSid = crypto.randomUUID();   // the bin keeps the last copy; what's typed next is another draft
      this.draftRestored = false;
      this.draft = JSON.parse(this._draftBase).draft; this.chkGhost = ''; this.subGhost = '';
      this.setEditorText(this.draft.content); this.setDescText(this.draft.notes);
      this.$nextTick(() => this.syncChkRows());
    },
    // --- Recently deleted (persistent trash bin) ---
    // A VIEW over the journal (trashView, recovery.js): any bin:true, unrestored entry ≤30d old, of this account (_mine).
    // Restore applies the entry's inverse out-of-band and detaches it so linear ⌘Z can't re-touch it.
    trashItems() {   // reactive on _jV
      void this._jV; let rem, dated, siIds;
      // a removed reminder or checklist item that is live again (⌘Z, another copy put back) is no deletion: hidden, kept for when it goes again.
      // An item gone from the open draft (deleted, not yet saved) is shown: Put it back returns it there (#389).
      const has = (cl, id) => !!cl?.some(c => c.id === id), chkBack = ({ taskId, item }) => has(this.byId.get(taskId)?.checklist, item.id) && (this.editing !== taskId || has(this.draft.checklist, item.id));
      // a save's deleted subtasks' copy (_saveSubs) too; a task's own Bin row keeps its older copy over a live row (Already back)
      const ids = e => e.target === 'reminder' ? rem ??= new Set(this.reminders.map(x => x.id)) : e.label === 'Deleted subtask' && this.byId;
      // a small change whose task no longer holds what it changed to (⌘Z, a later edit, the task gone): nothing to undo, hidden.
      // A date compares its day only: a time-only move makes no row, so it must not hide the day's. One task → date-item Map per call.
      const siOf = id => (dated ??= new Map(this.scheduleItems.filter(x => !x.block_id && x.date && x.task_id).reverse().map(x => [x.task_id, x]))).get(id) ?? null;
      const day = (e, v) => e.payload.field === 'date' && v ? v.slice(0, 10) : v;
      // a date whose made date-item is gone (a same-day re-time elsewhere): its Undo can only say "changed since"
      const gone = e => e.payload.field === 'date' && e.op.ops.some(o => o.kind === 'remove' && !(siIds ??= new Set(this.scheduleItems.map(x => x.id))).has(o.id));
      const back = e => e.kind === 'small' ? JSON.stringify(day(e, this._smallVal(e.payload.field, e.payload.taskId, e.payload.item, siOf))) !== JSON.stringify(day(e, e.payload.now)) || gone(e) : e.kind === 'checklist-item' ? chkBack(e.payload) : !!ids(e) && this._entryOps(e).every(o => o.kind === 'reinsert' && o.rows.every(r => ids(e).has(r.id)));
      return trashView(this.journal, Date.now()).filter(e => this._mine(e) && !_ahead.has(e.id) && !back(e));
    },
    _taskSubtreeRows(id) { return descendantIds(this.tasks, id).map(x => this.byId.get(x)).filter(Boolean).map(t => JSON.parse(JSON.stringify(t))); },   // task + all descendants, for trash
    trashRelTime(ts) {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return 'just now'; const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60); if (h < 24) return h + 'h ago'; const d = Math.round(h / 24);
      return d === 1 ? 'yesterday' : d + 'd ago';
    },
    _entryOps(e) { return e.op?.ops || (e.op ? [e.op] : []); },   // composite → its ops; single op → a one-item list; nothing → empty
    // Bulk multi-select DELETE (≥2 reinsert ops — the journal stores a delete as its reinsert inverse).
    _bulkOps(e) { const ops = this._entryOps(e).filter(o => o.kind === 'reinsert'); return ops.length >= 2 ? ops : null; },   // a convert's checklist update rides along
    // A bin row is either a LOSS (it's gone) or a CHANGE (it still exists, moved or edited). Only losses earn red text
    // and "Put it back" — a move rendered as a deletion is alarming, and its Restore button ambiguous.
    trashIsChange(e) {
      const ops = this._entryOps(e);
      return ops.length > 0 && ops.every(o => o.kind === 'update' || o.kind === 'move' || o.kind === 'complete');
    },
    trashIcon(e) {   // the pencil means "changed"; a draft is a clipboard
      if (this.trashIsChange(e)) return 'i-edit';
      return { task: 'i-circle', 'checklist-item': 'i-check', project: 'i-hash', area: 'i-tag-tag', event: 'i-cal', block: 'i-cal', filter: 'i-search', location: 'i-pin', draft: 'i-clipboard' }[e.target] || 'i-trash';
    },
    // ONE chronological list: the row says which kind it is (icon, red text vs muted, and this verb) — sections by kind
    // would throw away the only order the bin exists to show, "what did I just do?".
    trashVerb(e) { return this.trashIsChange(e) ? 'Undo' : 'Put it back'; },
    // A Restore that CANNOT work must not look like it works: a checklist item or reminder whose task is gone (never saved,
    // or since deleted) has nowhere to go back to → name the reason in the row and disable the button.
    trashBlocked(e) {
      const gone = e.kind === 'checklist-item' || e.kind === 'held-sub' ? !this.byId.get(e.payload?.taskId) : e.target === 'reminder' && this._entryOps(e).some(o => o.rows?.some(r => r.ref_id && !this.byId.has(r.ref_id)));
      return gone ? 'its task is gone' : '';
    },
    // The Bin's day sections, newest first (local days): { key, label, items }.
    trashDays() {   // the Bin's only reader of trashItems(): one read per render
      const days = [], today = new Date().setHours(0, 0, 0, 0);
      for (const e of this.trashItems()) {
        const key = new Date(e.ts).setHours(0, 0, 0, 0), ago = Math.round((today - key) / 864e5);
        if (days.at(-1)?.key !== key) days.push({ key, label: ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : new Date(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), items: [] });
        const day = days.at(-1);
        if (e.kind !== 'small') day.items.push(e);
        else if (day.small) day.small.items.push(e);
        else day.items.push(day.small = { id: 'small-' + key, kind: 'smalls', key, items: [e] });   // ONE row, at its newest change
      }
      return days;
    },
    // Read-only preview for a bin row: { title, detail (kind · its task · counts), peek: ONE line of what comes back, [{ text, cls }] }.
    // Colour is the text's own: trash-del = gone (red), trash-add = a dropped draft that was being added (green), '' = a change (muted).
    trashPreview(e) {
      const clip = (s, n = 72) => { s = (s ?? '').toString().replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
      const peek = (texts, cls) => texts.map(t => clip(t)).filter(Boolean).slice(0, 8).map(text => ({ text, cls }));   // a single truncated line: 8 is past its width
      const n = (k, one, many = one + 's') => k ? [k + ' ' + (k > 1 ? many : one)] : [];
      const out = (title, detail, lines = []) => ({ title: title || e.label || '(untitled)', detail, peek: lines });
      if (e.kind === 'draft') {
        const d = e.payload?.draft || {}, ghost = (e.payload?.chkGhost || e.payload?.subGhost || '').trim(), title = clip(d.content) || ghost || 'Untitled draft';
        const items = (d.checklist || []).map(i => i.text).filter(t => (t || '').trim());
        return out(title, ['Unsaved draft', ...n(items.length, 'item')].join(' · '), peek([...items, ghost !== title ? ghost : '', d.notes], 'trash-add'));
      }
      if (e.kind === 'checklist-item' || e.kind === 'held-sub') {
        const task = this.byId.get(e.payload?.taskId)?.content;
        return out(clip(e.payload?.item?.text), [e.kind === 'held-sub' ? 'Unsaved subtask' : 'Checklist item', this.trashBlocked(e) || clip(task, 40)].filter(Boolean).join(' · '));
      }
      const opRow = op => (op.rows && op.rows[0]) || this._rowById(op.target || 'task', op.id ?? op.fwd?.id) || {}, name = r => r.content ?? r.name ?? r.title ?? r.body;
      // a change (move / priority / completion): the rows still exist — the label's own sentence and the muted names it touched, never red
      if (this.trashIsChange(e)) return out(e.label, 'Changed', peek(this._entryOps(e).map(op => name(opRow(op)) || '(untitled)'), ''));
      if (e.target === 'reminder') {   // a save's removed reminders: one task's, named by it and each one's time
        const rows = this._entryOps(e).flatMap(o => o.rows || []);
        return out(clip(this.byId.get(rows[0]?.ref_id)?.content), [rows.length > 1 ? rows.length + ' reminders' : 'Reminder', this.trashBlocked(e)].filter(Boolean).join(' · '), peek(rows.map(r => this.remWhen(r, this.byId.get(r.ref_id) || {})), 'trash-del'));
      }
      // Bulk multi-select delete (≥2 ops): the COUNT + every affected item. Single-entity deletes model children re-parenting as
      // mixed-kind ops, so they fall through to the row preview below.
      const bulk = this._bulkOps(e);
      if (bulk) { const k = bulk.length, tgt = e.op.target || 'task'; return out(`${k} ${tgt}${k > 1 ? 's' : ''}`, k < this._entryOps(e).length ? e.label : 'Deleted', peek(bulk.map(op => name(opRow(op)) || '(untitled)'), 'trash-del')); }
      // every other bin entry is a deletion: its subtasks, checklist and description peek in red
      const rows = e.op?.rows || e.op?.ops?.find(o => o.rows)?.rows || [], root = rows[0] || {}, desc = (root.notes || '').trim(), items = (root.checklist || []).map(i => i.text).filter(t => (t || '').trim());
      if (e.target !== 'task') return out(clip(name(root)), { project: 'Project', area: 'Area', event: 'Event', block: 'Time block', filter: 'Filter', location: 'Location' }[e.target] || 'Item', peek([desc], 'trash-del'));
      const detail = ['Task', ...n(rows.length - 1, 'subtask'), ...n(items.length, 'checklist item'), ...desc ? ['description'] : [], ...root.recurrence && root.recur_from ? ['repeats from ' + this.fmt(root.recur_from)] : []];
      return out(clip(name(root)), detail.join(' · '), peek([...rows.slice(1).map(name), ...items, desc], 'trash-del'));
    },
    // The small-changes row's summary, each kind once, newest first: "dates, priority, a rename".
    trashSmallSum(items) {
      const one = { date: 'a date', deadline_at: 'a date', importance: 'priority', content: 'a rename', area_ids: 'an area', checklist: 'a checklist item' };
      const many = { 'a date': 'dates', 'a rename': 'renames', 'an area': 'areas', 'a checklist item': 'checklist items', priority: 'priority' }, count = new Map();
      for (const e of items) { const word = one[e.payload.field]; count.set(word, (count.get(word) || 0) + 1); }
      return [...count].map(([word, k]) => k > 1 ? many[word] : word).join(', ');
    },
    // One small change as [{ text, cls }]: "field old → new", old red (trash-del), new green (trash-add) — colour on the text only.
    trashSmallWhat({ payload: { field, old, now } }) {
      const q = v => '“' + (v.length > 48 ? v.slice(0, 47) + '…' : v) + '”';
      if (field === 'content') return [{ text: 'renamed from ' }, { text: q(old || ''), cls: 'trash-del' }];
      let show = v => v == null || v === '' || v === 'none' || v.length === 0 ? 'none' : field === 'importance' ? v[0].toUpperCase() + v.slice(1)
        : field === 'area_ids' ? v.map(id => this.areas.find(a => a.id === id)?.name).filter(Boolean).join(', ') || 'none' : this.fmt(v);
      if (field === 'checklist') show = q;   // its item's text
      return [{ text: { date: 'date', deadline_at: 'deadline', importance: 'priority', area_ids: 'area', checklist: 'checklist' }[field] + ' ' }, { text: show(old), cls: 'trash-del' }, { text: ' → ' }, { text: show(now), cls: 'trash-add' }];
    },
    // Append a journal entry: truncate any live redo tail, push (merging defaults), save (it moves the cursor).
    // callers read reactive deps before calling; pass only what differs from {id,ts,restored:false}.
    // Truncation must NEVER destroy a bin row: bin retention is independent of journal position, and the cursor can
    // walk OVER a skipped entry (a draft-kind delete with the composer shut) whose bin row is the only copy left.
    // Survivors are re-appended `detached` — still in the bin, permanently out of the linear ⌘Z timeline.
    _journalPush(e) {
      const kept = this.journal.slice(this.cursor).filter(x => !this._ownTab(x) || x.bin && !x.restored && (x.detached = true));   // another tab's: never this one's redo tail
      this.journal.length = this.cursor;
      this.journal.push(...kept, { id: crypto.randomUUID(), ts: _jTs = Math.max(Date.now(), _jTs + 1), restored: false, acct: this._acct(), tab: _tab, ...e });
      this._journalSave();
    },
    // An edit to the open composer draft. Undoable ONLY while that same draft is on screen (_jSkip) — these
    // entries mutate this.draft, so applying one to a different (or no) composer would corrupt it.
    _pushDraftEdit(label, kind, op) { this._journalPush({ label, target: 'draft', kind, op, bin: false, detached: false, editing: this.editing, sid: this._draftSid }); },
    // One checklist item (or held subtask: kind 'held-sub') added / renamed / deleted. A DELETE is ALSO a bin row so it survives
    // the composer closing — kind 'checklist-item'/'held-sub' is what the bin label + restore path key off. detached: bin-only.
    _pushChkItem(item, index, before, after, { kind = after == null ? 'checklist-item' : 'chk-item', taskId = this.editing, detached = false } = {}) {
      const del = after == null;
      this._journalPush({ label: del ? item.text : 'Checklist item', target: kind === 'held-sub' ? 'task' : 'checklist-item', kind,
        op: { id: item.id, index, before, after, item }, payload: del ? { taskId, index, item } : null, bin: del, detached, editing: taskId, sid: this._draftSid });
    },
    // Entries the timeline steps OVER: bin-only rows, and another draft's edits (or any draft edit with the composer shut).
    _jSkip(e) { return e.detached || (DRAFT_KINDS.includes(e.kind) && !(this.composer.open && !this._closingComposer && this._draftSid === e.sid)); },
    // The journal + pending drafts are device-wide; each entry belongs to the account (null: signed out) whose store it wrote.
    _acct() { return this.session?.user?.id ?? null; },
    _mine(e) { return !e.acct || e.acct === this._acct(); },   // the Bin: signed-out (null) and pre-acct entries can't name an account: everyone's
    _ownStep(e) { return (e.acct ?? null) === this._acct(); },   // ⌘Z/⌘⇧Z: only entries written against this store
    _ownTab(e) { return !e.tab || e.tab === _tab; },   // ⌘Z/⌘⇧Z: only this tab's; one stored before tabs were stamped is any tab's
    // move: the cursor steps over the skipped, up to the entry found (else the end)
    // another account's entry is a wall: stepping past it would leave it on the wrong side of the cursor
    _journalPeek(dir, move) {
      let i = dir < 0 ? this.cursor - 1 : this.cursor;
      while (this.journal[i] && (this.journal[i].detached || !this._ownTab(this.journal[i]) || this._ownStep(this.journal[i]) && this._jSkip(this.journal[i]))) i += dir;
      if (this.journal[i] && !this._ownStep(this.journal[i])) return;
      if (move) this.cursor = dir < 0 ? i + 1 : i;
      return this.journal[i];
    },
    // A dropped-but-kept dirty composer draft → a bin row that is ALSO in the linear ⌘Z timeline (detached:false),
    // so ⌘Z or "Restore" reopens the composer with the draft. The pending autosave stays as the same-composer restore.
    // detached: another tab's draft — in the Bin only, never this tab's ⌘Z.
    _pushDraftBin(key, p = this._draftEntry(), detached = false) {   // p: an explicit draft to bin instead of the open one (live: a failed autosave leaves storage stale)
      const label = 'Draft: ' + ((p.draft.content || '').trim() || (p.chkGhost || p.subGhost || '').trim() || 'Untitled draft');
      this._journalPush({ label, target: 'draft', kind: 'draft', op: null, payload: { key, ...p }, bin: true, detached, acct: p.acct ?? this._acct() });   // a swept save slot's row is its account's
    },
    // Through the pending slot, so the open restores the draft with its own sid. The pending draft it displaces is
    // binned first, unless the Bin already holds it.
    _reopenDraft(payload) {
      this._endDraft();   // an open composer's draft first — the map below must hold its last <300ms of typing
      const t = payload.editing && this.byId.get(payload.editing), key = t ? t.id : this._newKey(), m = this._pendingMap(), p = m[key], s = p && this._draftSig(p);
      if (s && s !== this._draftSig(payload) && !this.journal.some(e => e.kind === 'draft' && e.bin && !e.restored && this._draftSig(e.payload) === s)) this._pushDraftBin(key, p);
      const out = this._newKey(null);
      if (m[out]?.sid === payload.sid) delete m[out];   // handed over: a save clears only `key`, so the signed-out slot would resurrect it
      m[key] = payload; this._writePending(m); _handoff = { key, payload };   // in memory too: the write can fail
      if (t) this.editTask(t); else this.startAdd();
    },
    async restoreTrash(id) {
      const e = this.journal.find(x => x.id === id && x.bin && !x.restored); let applied;
      if (!e) return;
      if (e.kind === 'draft') {   // the Bin closes: the composer it reopens sits under the backdrop, inert while the Bin is up
        this.trashOpen = false;
        this._reopenDraft(e.payload); e.restored = true; e.detached = true; this._journalSave(); return;
      }
      const item = e.kind === 'checklist-item' || e.kind === 'held-sub', was = !item && this._savedDraft(); let op;
      // a renamed checklist item: only its text goes back against the live list — a tick or edit since stays
      const cl = e.kind === 'small' && e.payload.item && this.byId.get(e.payload.taskId)?.checklist;
      const fwd = cl ? { kind: 'update', target: 'task', id: e.payload.taskId, after: { checklist: cl.map(c => c.id === e.payload.item ? { ...c, text: e.payload.old } : c) }, was: { checklist: cl } } : e.op;
      // a date's inverse swaps whole date-items: after a re-date or delete elsewhere it would leave two, or an orphan:
      // stale on another day, or once the date-item it made is gone (a same-day re-time elsewhere), as trashItems hides it
      const day = v => v && v.slice(0, 10), redated = e.kind === 'small' && e.payload.field === 'date'
        && await this._reloadAfter({ kind: 'composite', ops: [e.op, { target: 'task' }] }).then(() => day(this._smallVal('date', e.payload.taskId)) !== day(e.payload.now)
          || e.op.ops.some(o => o.kind === 'remove' && !this.scheduleItems.some(x => x.id === o.id)));
      // a replayed save deletes rows again (an add's Bin row): their version now is stored first, its own Bin row once they go
      const copy = item || redated ? () => {} : await this._binAhead('Deleted subtask', { ...fwd }); if (!copy) return;
      try { op = redated ? { newer: 'all' } : await (e.kind === 'held-sub' ? this._restoreHeld(e.payload) : item ? this._restoreChecklistItem(e.payload) : this._apply(fwd)); } catch {}
      copy(!!op);
      if (!op) { if (!item) await this._reloadAfter(e.op); this.toast('Failed restoring. Try again?'); return; }   // the bin row stays; one toast
      const ops = item ? [] : [op, ...op.ops || []];
      if (ops.some(o => o.dropped)) { await this._reloadAfter({ kind: 'composite', ops: [e.op, { target: 'task' }] }); const blocked = this.trashBlocked(e); return this.toast(blocked ? 'Failed putting it back. ' + blocked : ops.find(o => o.dropped).dropped); }   // the row stays in the Bin; the tasks reload, so it names a task gone unseen
      if (this._kept(op)) { await this._reloadAfter(item ? { target: 'task' } : e.op); this._rebaseDraft(was); this.syncSubRows(); return this.notify('Already back. This copy stays in the Bin'); }
      if (op.newer === 'all') { await this._reloadAfter(e.op); this._rebaseDraft(was); return this.notify(`“${e.label}” not undone, it changed since`); }   // as _journalStep: the row stays until the reload hides it
      if (!item) [applied, e.op] = [fwd, op];
      e.restored = true; e.detached = true;
      this._journalSave(); await this._reloadAfter(item ? { target: 'task' } : e.op); this._rebaseDraft(was); this._finalizeFx(e.op);
      this.syncSubRows();
      this.notify('Restored' + this._skipNote(applied));
    },
    _kept(op) { return [op, ...op.ops || []].some(o => o.kept); },
    // What a reinsert couldn't bring back, read off the reloaded lists: a block attachment whose block went, a link whose
    // other task went, a reminder the store refused as past. '' when all of it is back.
    _skipNote(op) {
      const raw = window.Alpine.raw, ids = {}, has = (k, id) => (ids[k] ??= new Set(k === 'task' ? raw(this.byId).keys() : (raw(this[k + 's']) || []).map(r => r.id))).has(id);
      const n = { scheduleItem: 0, reminder: 0, noTask: 0 }, edges = new Map(), s = (c, one, many) => c > 1 ? many : one; let moved = 0, home;
      for (const o of op?.kind === 'composite' ? op.ops : [op]) if (o?.kind === 'reinsert') {
        // an attachment whose block is back lost its task instead
        for (const [k, rs] of [[o.target, o.rows], ...o.also || []]) if (k in n) for (const r of rs) if (!has(k, r.id)) n[k === 'scheduleItem' && r.block_id && has('block', r.block_id) ? 'noTask' : k]++;
        // edges in (links) and the rows' own; keyed so a relates pair, or an own edge a failed try's keep() copied into links, counts once
        const own = o.target === 'task' ? o.rows.flatMap(r => ['blocked_by', 'relates'].flatMap(e => (r[e] || []).map(x => [r.id, x, e]))) : [];
        for (const l of [...own, ...o.links || []]) edges.set(l[2] === 'relates' ? [l[0], l[1]].sort() + ',relates' : l.join(), l);
        // a task whose parent went since came back in the default project, or as a project when none is set
        if (o.target === 'task') for (const r of o.rows) if (r.parent_id && !has('task', r.parent_id) && has('task', r.id)) { moved++; home = raw(this.byId).get(raw(this.byId).get(r.id).parent_id)?.content; }
      }
      const link = [...edges.values()].filter(([a, b]) => !has('task', a) || !has('task', b)).length;
      return [moved && `${moved} ${s(moved, 'task', 'tasks')} came back ${home ? `in ${home}` : 'as a project'} (${s(moved, 'its parent was', 'their parents were')} deleted)`,
        n.scheduleItem && `${n.scheduleItem} ${s(n.scheduleItem, 'attachment', 'attachments')} couldn’t come back (${s(n.scheduleItem, 'its block was', 'their blocks were')} deleted)`,
        n.noTask && `${n.noTask} ${s(n.noTask, 'attachment', 'attachments')} couldn’t come back (${s(n.noTask, 'its task was', 'their tasks were')} deleted)`,
        link && `${link} ${s(link, 'link', 'links')} couldn’t come back (the other ${s(link, 'task was', 'tasks were')} deleted)`,
        n.reminder && `${n.reminder} ${s(n.reminder, 'reminder', 'reminders')} couldn’t come back (${s(n.reminder, 'its time', 'their times')} passed)`].filter(Boolean).map(t => ' · ' + t).join('');
    },
    // A deleted checklist item goes back onto its (still-existing) task's stored checklist at its old index.
    async _restoreChecklistItem(payload) {
      // the stored row, not the lists': an item another device added since (a realtime gap can hide it) stays
      const t = await this.store.tasks.get(payload.taskId); if (!t) return false;
      const cl = (t.checklist || []).slice(), at = list => Math.min(payload.index ?? list.length, list.length);
      // The STORED row can still hold the item while the open draft has dropped it (deleted, not yet saved) —
      // skipping the write is right, returning early was not: the draft on screen never got it back, so Restore
      // looked like it did nothing and the next save deleted it for real. Both halves are now independent.
      const kept = cl.some(c => c.id === payload.item.id);
      if (!kept) {
        cl.splice(at(cl), 0, payload.item);
        if (!await this.store.tasks.update(payload.taskId, { checklist: cl })) return false;
      }
      if (this.editing === payload.taskId && !this.draft.checklist.some(c => c.id === payload.item.id)) {
        this.draft.checklist.splice(at(this.draft.checklist), 0, payload.item);
        this.syncChkRows();
        return true;
      }
      return kept ? { kept: true } : true;   // kept: already back, so restoreTrash keeps the Bin copy
    },
    // A new subtask row taken out of a draft goes back to its task's open composer as a row, else is stored under it.
    async _restoreHeld({ taskId, item }) {
      if (this.editing === taskId) { if (!this.draft.subs.some(s => s.id === item.id)) this.draft.subs.unshift({ done: false, ...item, add: true }); return true; }   // a pre-`add` row is new too
      const t = await this.addSubtask(taskId, item.fields); if (t) await this._saveSched(t.id, item.sd, null, []);   // []: a restore, no ⌘Z step or small row
      return !!t;
    },
    // --- Inverse-op journal (recovery engine; ⌘Z/⌘⇧Z drive undo()/redo() below). ---
    _res(t) { return t === 'message' ? messageStore(sbClient()) : this.store[t + 's']; },                 // task→tasks, area→areas, event→events, block→blocks, filter→filters, location→locations
    _rowById(t, id) { return t === 'task' ? this.byId.get(id) : (t === 'message' ? this.chat.msgs : this[t + 's'] ?? []).find(r => r.id === id); },   // a message: the open thread's
    // What a task delete takes beyond its rows (the DB cascades, LocalStore prunes): links in from outside, schedule items, reminders.
    // ix: the refs keyed by the id they point at — one pass per action (a bulk delete shares it), not a scan per removed task.
    _taskRefs(rows, ix = this._refIndex()) {
      const gone = new Set(rows.map(r => r.id)), at = k => JSON.parse(JSON.stringify(rows.flatMap(r => ix[k].get(r.id) || [])));
      return { links: at('links').filter(([a]) => !gone.has(a)), also: [['scheduleItem', at('scheduleItem')], ['reminder', at('reminder')]] };
    },
    // A block delete cascades its attachments, reminders and day overrides (pg_mail/schema.js:299,318,349; LocalStore blocks.remove).
    _blockRefs(id) { return { also: ['scheduleItem', 'reminder', 'blockDay'].map(k => [k, JSON.parse(JSON.stringify(window.Alpine.raw(this[k + 's']).filter(r => r.block_id === id)))]) }; },
    _refIndex() {
      const ix = { links: new Map(), scheduleItem: new Map(), reminder: new Map() }, add = (m, id, v) => { const l = m.get(id); if (l) l.push(v); else m.set(id, [v]); }, raw = window.Alpine.raw;
      for (const t of raw(this.tasks)) for (const k of ['blocked_by', 'relates']) for (const x of t[k] || []) add(ix.links, x, [t.id, x, k]);
      for (const s of raw(this.scheduleItems)) add(ix.scheduleItem, s.task_id, s);
      for (const r of raw(this.reminders)) add(ix.reminder, r.ref_id, r);
      return ix;
    },
    // The references the store scrubs a deleted area or place from (store.js areas/locations.remove), as restore ops. was = the
    // scrubbed value: the entry is bin:true, restored out-of-band, so a later edit to that field is never overwritten.
    _stripRefs(t, id) {
      const drop = ids => ids.filter(x => x !== id), copy = v => JSON.parse(JSON.stringify(v));
      const op = (target, r, k, was) => ({ kind: 'update', target, id: r.id, after: { [k]: copy(r[k]) }, was: { [k]: was } });
      const at = r => r.location?.ids?.includes(id), place = r => ({ ...copy(r.location), ids: drop(r.location.ids) });
      if (t === 'area') return [...this.tasks.filter(r => r.area_ids?.includes(id)).map(r => op('task', r, 'area_ids', drop(r.area_ids))),
        ...this.blocks.filter(b => b.areas?.includes(id)).map(b => op('block', b, 'areas', drop(b.areas)))];
      return t !== 'location' ? [] : [...this.tasks.filter(at).map(r => op('task', r, 'location', place(r))), ...this.events.filter(at).map(r => op('event', r, 'location', place(r))),
        ...this.blocks.filter(b => b.location_id === id).map(b => op('block', b, 'location_id', null))];
    },
    _rowsForDelete(t, id, row) { const r = this._rowById(t, id) || row; return t === 'task' ? this._taskSubtreeRows(id) : r ? [JSON.parse(JSON.stringify(r))] : []; },
    async _createRow(t, fields, arrival) { const r = this._res(t); return t === 'task' ? this._newTask(fields, arrival) : r.create ? r.create(fields) : r.add(fields); },
    // Every task create goes through here: the signed-in store can land the row but lose its links (`lost: ['links']`).
    async _newTask(fields, arrival) {
      const t = await this.store.tasks.create(fields);
      if (t && arrival != null) {   // Off and other surfaces are checked when the row stamps
        _arrive.set(t.id, arrival);
        setTimeout(() => _arrive.delete(t.id), 1000);   // another list or off-window: never reward a later visit
      }
      if (!t?.lost) return t;
      this.toast(`Saved “${t.content}” without its ${t.lost.map(k => k.replaceAll('_', ' ')).join(', ')}`);
      delete t.lost; return t;
    },
    // Indexed now, as loadTasks would: a tick during its reload (a slow signed-in list) sweeps it and journals it.
    // Already there when another write's reload landed first.
    _indexNew(row) {
      if (!row || this.byId.has(row.id)) return;
      this._rowV++; _calDataV++; this.tasks.push(row); this.byId.set(row.id, row); if (row.parent_id) this.parentIds.add(row.parent_id);
    },

    // The localStorage journal moves in first; a failed move keeps it for the next boot.
    _journalLoad() { return jMigrate().catch(() => {}).then(() => this._journalSync(true)); },
    // This tab's place in its ⌘Z timeline: before its first undone step, else the end.
    _jCursor() { const i = this.journal.findIndex(e => e.undone && !e.detached && this._ownTab(e)); return i < 0 ? this.journal.length : i; },
    _jFail(err) {   // a delete is refused, the draft kept, the next write retries
      this._jFull = err?.name === 'QuotaExceededError';   // else hung, blocked or broken: not the user's storage to clear
      if (!this._jSaveFailed) this.toast(`${this._jFull ? 'Storage is full' : 'Couldn’t reach saved history'}. The Bin and undo won’t survive a reload`);
      this._jSaveFailed = true;
    },
    _journalFlush() {   // resolves once this tab's changes are stored or have failed
      if (!this._jSaveT && !this._jSaveFailed) return _jChain;
      clearTimeout(this._jSaveT); this._jSaveT = null;
      return this._jQueue(() => this._journalWrite());
    },
    _jQueue(run) { return _jChain = _jChain.then(run).catch(err => this._jFail(err)); },   // a step that throws fails alone: the next one still runs
    // A closing page drops an unfinished IndexedDB write: what this tab hasn't stored also goes, synchronously, to its own key
    // (never the shared one: two tabs closing at once) for the next boot's jMigrate. Removed once a write stores it all.
    // dropped: ids it dropped, so a truncated redo tail or a settled delete's Bin copy can't come back.
    _journalStash() {
      const key = 'adherod.journal.' + _tab, { put: entries, del: dropped } = this._jChanges(true);
      _jStashes++;
      try { entries.length || dropped.length ? localStorage.setItem(key, JSON.stringify({ epoch: _jEpoch, entries, dropped })) : localStorage.removeItem(key); } catch {}   // full: storage keeps what it committed
      this._journalFlush();   // the next write that lands clears the key
    },
    // What this tab added or changed since it last read or wrote, stamped `mt` (a stale copy elsewhere can't replace it), and the ids it dropped.
    // copy: a stash stamps copies — a live entry an in-flight write serialized must keep matching what that write snaps.
    _jChanges(copy) {
      const live = new Set(this.journal.map(e => e.id)), put = this.journal.filter(e => JSON.stringify(e) !== _jSnap.get(e.id)).map(e => copy ? { ...e } : e);
      for (const e of put) e.mt = _jMt = Math.max(Date.now(), _jMt + 1);
      return { put, del: [..._jSnap.keys()].filter(id => !live.has(id)) };
    },
    // One record per entry: this tab puts only the entries it added or changed and deletes only those it dropped since it last
    // read or wrote them — never another tab's copy. ceiling: one JSON pass over the journal per write; mark entries dirty where they change if a write shows in a profile.
    async _journalWrite() {
      const { put, del } = this._jChanges(), json = put.map(e => JSON.stringify(e)), stashes = _jStashes;
      try {
        if (put.length || del.length) {
          if (!await jWrite(_jEpoch, json.map(s => JSON.parse(s)), del)) return await this._journalSync() && this._journalWrite();   // JSON: a reactive proxy can't be cloned. false: a wipe since this tab read: what survives it
          for (const id of del) _jSnap.delete(id);
          put.forEach((e, i) => _jSnap.set(e.id, json[i]));
          _jBus.postMessage(0);
        }
        if (stashes && stashes === _jStashes) { localStorage.removeItem('adherod.journal.' + _tab); _jStashes = 0; }   // all the key held is stored: a tab back from the bfcache
        this._jSaveFailed = false;
      } catch (err) { this._jFail(err); }
    },
    // Storage is the truth for every entry this tab hasn't changed since it last read or wrote it. After a wipe ("Delete local
    // data", any tab) only what this tab added since and a running delete's Bin copy stay.
    async _journalSync(boot) {
      let read;
      try { read = await jRead(); } catch (err) { this._jFail(err); return false; }
      const wiped = read.epoch !== _jEpoch;
      if (wiped) { this.journal = this.journal.filter(e => e.ts >= read.epoch || _ahead.has(e.id)); _jSnap = new Map(); _jEpoch = read.epoch; }
      if (boot) for (const e of read.entries) {
        normalizeTaskOp(e.op);
        if (e.kind === 'title-nlp') e.detached = true;   // retired kind nothing replays; ceiling: delete 30 days after this lands (journal prune)
        if (e.target === 'event' && e.label?.startsWith('Imported ')) e.restored = this._entryOps(e).every(o => o.kind === 'remove');   // an import is an add: in the Bin while its events are gone. ceiling: delete 30 days after this lands (journal prune)
      }
      const held = new Map(this.journal.map(e => [e.id, e])), snap = new Map();
      const next = read.entries.flatMap(e => {
        const own = held.get(e.id), s = JSON.stringify(e);
        if (!own && _jSnap.has(e.id)) { snap.set(e.id, _jSnap.get(e.id)); return []; }   // dropped here since (a settled delete's Bin copy): its delete is queued
        held.delete(e.id);
        if (own && JSON.stringify(own) !== _jSnap.get(e.id)) return own;   // changed here since: its write is queued
        snap.set(e.id, s);
        if (own && JSON.stringify(own) !== s) { for (const k in own) delete own[k]; Object.assign(own, e); }   // in place: undo/restore hold the entry across awaits
        return own ?? e;
      });
      for (const e of held.values()) if (JSON.stringify(e) !== _jSnap.get(e.id)) next.push(e);   // added or changed here; an unchanged one another tab dropped
      _jSnap = snap;
      this.journal = next.sort((a, b) => a.ts - b.ts);   // getAll's order is by id
      this.cursor = this._jCursor(); this._jV++;
      if (wiped) this._journalSave();   // what stays is this tab's to store again (at boot: pruned)
      return true;
    },
    _journalSave() {
      this.journal = pruneJournal(this.journal, 0, Date.now(), e => this._ownTab(e) && !(e.kind === 'small' && !e.restored)).journal;   // a live small row: SMALL_CAP bounds it, never ⌘Z history
      this.cursor = this._jCursor();   // from the flags: a write mid-step may have moved it
      this._jV++;   // kept sync: trashItems() reactivity must update immediately
      this._jDeadCards();
      if (!this._jSaveT) this._jSaveT = setTimeout(() => this._journalFlush(), 0);
    },
    // a card's Undo/Redo steps the cursor: only while its entry is the next step that way does it take back what the card says
    _jDeadCards() { for (const n of this.notifs) if (n.actions.some(a => a.jid && this._journalPeek(a.dir)?.id !== a.jid)) n.actions = []; },

    // Diff helper for completion fx: which tasks' FX_FIELDS changed, before and after — only those keys, so the inverse writes
    // just what the action changed. seen: a row an earlier part of the same batch already restores is left to it.
    _fxDiff(byId, before, seen = new Set()) {
      const changed = [], pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o[k]]));
      for (const [id, b] of before) {
        const t = byId.get(id), a = t && FX_FIELDS(t, 'position' in b), ks = a ? Object.keys(b).filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k])) : [];
        if (ks.length && !seen.has(id) && seen.add(id)) changed.push({ id, before: pick(b, ks), after: pick(a, ks) });
      }
      return { changed };
    },
    // Reverse a captured completion delta: reopen every changed row. A field edited since (rows = the state it was captured
    // against, default the lists) keeps the edit. False = a reopen failed; the list then shows the store's truth.
    async _reverseFx(fx, rows = this.byId, completion = false) {
      // no after: an entry journaled before it was kept — only what the action wrote goes back, never its whole before-state: an
      // auto-complete writes completed_at, a completion DONE_FIELDS only on a row whose rule was active (store.js setCompleted).
      // ceiling: that legacy branch is dead once JOURNAL_MAX_AGE_MS passes after fx kept `after` — delete it on 2026-10-30. A row deleted since has nothing to reopen.
      const writes = (fx?.changed || []).filter(c => rows.has(c.id)).map(c => [c.id, c.after ? guardedFields(c.before, rows.get(c.id), c.after)
        : Object.fromEntries((completion && recActive(c.before.recurrence) ? DONE_FIELDS : ['completed_at']).filter(k => k in c.before).map(k => [k, c.before[k]]))]);
      const moved = writes.filter(([, f]) => 'position' in f);   // one write for every position: a LocalStore update re-serializes every task
      const placed = !moved.length || await this.store.tasks.reorder(moved.map(([id]) => id), moved.map(([, f]) => f.position));   // first: a signed-in update's read-back racing it could cache an old position
      const ok = (await Promise.all(writes.map(([id, { position, ...f }]) => !Object.keys(f).length || this.store.tasks.update(id, f)))).every(Boolean) && placed;
      if (!ok) await this.loadTasks();
      return ok;
    },

    _moving(ops) { return new Set(ops.flatMap(o => o.kind === 'move' ? [o.id] : [])); },
    // a deleted subtree's rows less those its action moves out first ("Move them"): the lists still show them under it
    _notMoved(rows, moving) {
      if (!moving?.size) return rows;
      const byId = new Map(rows.map(r => [r.id, r]));
      return rows.filter(r => { for (let x = r; x; x = byId.get(x.parent_id)) if (moving.has(x.id)) return false; return true; });
    },
    // Task delete ops → their reverses (null: still there), through ONE store remove. ctx: as _apply's.
    async _removeTasks(ops, ctx) {
      const ix = ctx ? ctx.ix ??= this._refIndex() : ops[0]._ix ?? this._refIndex(), parts = ops.map(op => {
        const f = !(ctx?.exact && op.rows) && this._rowsForDelete('task', op.id), rows = this._notMoved(f?.length ? f : op.rows || [], ctx?.moving);   // fresh: what goes now, incl. subtasks added since
        return { op, rows, fx: this._fxSnap(this._chain(this.byId.get(op.id)?.parent_id)), refs: this._taskRefs(rows, ix) };
      });
      // whole groups, top row first: a store reads a list's first id as its root, and a rollback's rows can be siblings under a root it skipped
      const groups = rows => { const byId = new Map(rows.map(r => [r.id, r])), out = new Map();
        for (const r of rows) { let top = r; while (byId.has(top.parent_id)) top = byId.get(top.parent_id); if (!out.has(top.id)) out.set(top.id, [top.id]); if (r !== top) out.get(top.id).push(r.id); }
        return [...out.values()]; };
      const lists = parts.flatMap(p => groups(p.rows));
      const live = lists.length > 0 && !await this.store.tasks.remove(lists) && await this.store.tasks.list().catch(() => null), still = live && new Set(live.map(t => t.id));
      // a lost answer can hide a landed delete: unless a fresh read still has its rows, journal it; no read either: may not have landed.
      // Its rows, not its root: a rollback's are only what it put back, and the root may be a newer version it skipped
      return parts.map(({ op, rows, fx, refs }) => still && rows.some(r => still.has(r.id)) ? null : { kind: 'reinsert', target: 'task', id: op.id, rows, _fxCapture: fx, ...refs, ...live === null && { unsure: true } });
    },
    // Applies one op, returns the op that reverses it. The reverse is what gets applied on the opposite action (undo↔redo toggle).
    // A task complete/move/remove's reverse carries `_fxCapture` until the caller has reloaded: _finalizeFx turns it into fx.
    // ctx: the composite running op — `back` holds every row it has put back, which the app's lists don't show until the reload; `ix` its _refIndex; `moving` the ids it moves;
    // `exact`: a rollback — it removes only the rows it put back, never a subtask whose move back out failed (its inverse is dropped).
    async _apply(op, ctx) {
      // A composite, or a lone reinsert/move carrying fx: every part lands, THEN the fx reverses once. All or nothing: a failed
      // part or reopen takes back what landed, and every completion captured goes back exactly — incl. what the store reopened
      // or re-completed on the way. The entry keeps its op for a retry. A complete's fx is its whole action: it reverses its own.
      if (op.kind === 'composite' || op.fx && !ctx && op.kind !== 'complete') {
        const one = op.kind !== 'composite', parts = one ? [op] : op.ops, invs = [];
        const fx = { changed: (one ? parts : [op, ...parts]).flatMap(o => o.kind !== 'complete' && o.fx?.changed || []) };   // a part's own: journaled before fx moved up
        // a move back out can leave its parent only done subtasks, and the store's move-out rule closes it and up: each open one stays open.
        // Not under a row this op removes: that remove's closes are its own (a redo's fx), and a write to a removed row fails the op.
        const moving = this._moving(parts), act = { back: new Set(), ix: op._ix, moving }, held = new Set(fx.changed.map(c => c.id)), done = t => t.completed_at || t.archived_at;
        const gone = new Set(parts.flatMap(o => o.kind === 'remove' || o.kind === 'delete' ? [o.id] : []));
        for (const p of new Set([...moving].map(id => this.byId.get(id)?.parent_id))) {
          const kids = this.childTasks(p), chain = this._chain(p);
          if (!kids.some(done) || !kids.every(k => moving.has(k.id) || done(k)) || chain.some(id => gone.has(id))) continue;
          for (const id of chain) if (!held.has(id) && !done(this.byId.get(id))) { held.add(id); fx.changed.push({ id, before: { completed_at: null }, after: { completed_at: null } }); }
        }
        // the ancestors of what comes back — a task whose parent went since, the default project's (it's re-homed there)
        const rs = parts.flatMap(o => o.kind === 'reinsert' && o.target === 'task' ? o.rows : []), mine = new Set(rs.map(r => r.id));
        const above = new Set(rs.flatMap(r => this._chain(!r.parent_id || this.byId.has(r.parent_id) || mine.has(r.parent_id) ? r.parent_id : this.store.defaultProject())));
        // cap: the rollback's — every row a part's fx, or the store's reopen over a restored row, can change; own: the inverse's fx
        const cap = this._fxSnap([...[op, ...parts].flatMap(o => o.fx?.changed || []).map(c => c.id), ...above]).before, own = new Map();
        let ok = true;
        // a bulk delete: one store remove for every part, not one per task. Its failed part may sit beside landed ones: each goes to the rollback
        const batch = !one && parts.every(o => o.target === 'task' && (o.kind === 'remove' || o.kind === 'delete')) && await this._removeTasks(parts, act);
        for (const [i, o] of parts.entries()) {
          const inv = batch ? batch[i] : await this._apply(o, act).catch(() => null); if (!inv) { ok = false; if (batch) continue; break; }   // a store call that throws: rolled back as a failure
          invs.push(inv);
          for (const [id, b] of inv._fxCapture?.before || []) { if (!cap.has(id)) cap.set(id, b); if (inv.kind !== 'complete' && !own.has(id)) own.set(id, b); }
          if (!one && inv.kind !== 'complete') delete inv._fxCapture;
        }
        if (act.lost) fx.changed = fx.changed.filter(c => above.has(c.id));   // a re-homed root reopens none of its old ancestors
        if (ok && await this._reverseFx(fx)) return one ? invs[0] : { kind: 'composite', target: op.target ?? 'task', ops: invs.reverse(), ...own.size && { _fxCapture: { before: own } } };
        const landed = { kind: 'composite', target: op.target ?? 'task', ops: invs.reverse() };
        await this._reloadAfter(landed);
        let whole = true; const again = { back: new Set(), exact: true }, out = [];   // one action too: its rows' links find each other
        // ceiling: a nested composite that failed drops out of `out` — revisit with the first composite built inside a composite
        for (const i of landed.ops) if (!await this._apply(i, again)) { whole = false; if (i.kind === 'reinsert') out.push(i); }
        await this._reloadAfter(landed);   // the rollback moved the store: the screen, and a retry's "already back?" check, read its truth
        if (!await this._reverseFx(this._fxDiff(this.byId, cap))) whole = false;
        // couldn't take it all back — the caller says so; `landed` = only rows still out, so a Bin Restore never re-removes one
        if (!whole) throw Object.assign(new Error('partly applied'), { partly: true }, out.length && { landed: { ...landed, ops: out } });
        return null;
      }
      if (op.kind === 'remove' || op.kind === 'delete') {
        // a rollback takes back only the rows its restore put back: none here — a row it skipped was live before it, for every type
        if (ctx?.exact && op.rows && !op.rows.length) return { kind: 'reinsert', target: op.target, id: op.id, rows: [] };
        if (op.target === 'task') return (await this._removeTasks([op], ctx))[0];
        const f = !(ctx?.exact && op.rows) && this._rowsForDelete(op.target, op.id), refs = op.target === 'block' && this._blockRefs(op.id), res = this._res(op.target);
        const strip = ctx ? [] : this._stripRefs(op.target, op.id);   // in a composite (a redo), its sibling updates carry them
        // ceiling: a reference added between ⌘Z and ⌘⇧Z of an area/place delete is scrubbed by the redo and not restored by the next ⌘Z — revisit if a user loses one
        // as _removeTasks: a lost answer can hide a landed delete — unless the store's fresh read still has the row, journal it; no read either: may not have landed
        const live = !await res.remove(op.id) && (!res.get || await res.get(op.id).then(Boolean, () => null));
        const back = !live && { kind: 'reinsert', target: op.target, id: op.id, rows: f?.length ? f : op.rows || [], ...refs, ...live === null && { unsure: true } };
        return back && strip.length ? { kind: 'composite', target: op.target, ops: [back, ...strip] } : back;
      }
      if (op.kind === 'create') {
        const row = await this._createRow(op.target, op.fields, op.arrival);
        if (op.target === 'task') this._indexNew(row);
        return row && { kind: 'remove', target: op.target, id: row.id };
      }
      if (op.kind === 'reinsert') {
        // a failed write can land rows without their edges: the entry keeps exactly the edges not written, so a retry
        // links those and never one the user removed since
        const links = op.links || [], keep = ls => { op.links = ls; this._journalSave(); return null; };
        const back = ctx?.back ?? new Set(), has = id => this.byId.has(id) || back.has(id); for (const r of op.rows) back.add(r.id);
        let refIds, unread = false;
        const kept = new Set(), landed = new Set(), dropped = new Set();   // kept: stored in another version, skipped, so the Bin keeps the copy; dropped: its parent is gone
        for (const [k, rs] of [[op.target, op.rows], ...op.also || []]) {   // rows first: what else comes back points at them
          // A task whose parent went since comes back in the default project (as store.js repairTree; signed in, the FK refuses it) and
          // reopens none of its old ancestors; the store drops any other such row (liveRefs)
          if (!rs.length) continue;
          const rehomed = new Set(), written = r => liveRefs(k, [r], refIds ??= { task: new Set([...this.byId.keys(), ...back]), block: new Set(this.blocks.map(b => b.id)), location: new Set(this.locations.map(l => l.id)) })[0] ?? r;
          const rows = rs.map(r => {
            const rehome = k === 'task' && r.parent_id && !has(r.parent_id);
            if (rehome) rehomed.add(r.id);
            return rehome ? { ...r, parent_id: this.store.defaultProject() } : k !== 'reminder' ? r : isPassed(r) ? { ...r, paused: true } : { ...r, at: nextAt(r) };   // a reminder whose time went by never fires late
          });
          // the store checks what's stored, never the lists or a cache: a write their re-read missed (another tab's, a realtime gap) leaves them stale.
          // A row already stored stays as it is (live): this entry's own earlier try, or another version — compared as this restore writes it
          const live = new Set();
          if (!await (k === 'message' ? this._res(k) : this.store).reinsert(k, rows, live)) return keep([...k === 'task' ? rows.filter(r => !live.has(r.id)).flatMap(r => ['blocked_by', 'relates'].flatMap(e => (r[e] || []).map(x => [r.id, x, e]))) : [], ...links]);
          // a removed reminder's own Bin row: the store's answer decides it landed — it drops one whose task went unseen, or (signed in) one long past
          const own = k === 'reminder' && k === op.target, read = (live.size || own) && await this._res(k).list().catch(() => null), stored = new Map((read || []).map(r => [r.id, r]));   // unread: kept, dropped — the Bin keeps it
          unread ||= own && !read;
          for (const r of rows) if (live.has(r.id) && !sameRow(stored.get(r.id) ?? {}, written(r))) kept.add(r.id);
          for (const r of rows) if (!live.has(r.id)) { if (k === op.target) landed.add(r.id); if (own && !stored.has(r.id)) dropped.add(r.id); if (rehomed.has(r.id) && ctx) ctx.lost = true; }
        }
        // an edge dropped with the row that came back first (the store keeps none to a missing row) is linked here, by its other end
        for (let i = 0; i < links.length; i++) if (has(links[i][0]) && has(links[i][1]) && !await this.store.tasks.link(...links[i])) return keep(links.slice(i));
        // rows: all but what was live before — a rollback never removes one of those; a dropped row stays, so the entry keeps its data
        return { kind: 'remove', target: op.target, id: op.id ?? op.rows[0]?.id, rows: op.rows.filter(r => landed.has(r.id)), ...kept.size && { kept: [...kept] }, ...dropped.size && { dropped: unread ? 'Failed checking that it came back' : 'Failed putting it back. Its time passed' } };   // dropped: what the toast says
      }
      if (op.kind === 'update') {
        const res = this._res(op.target), guard = row => op.was ? guardedFields(op.after, row, op.was) : op.after;   // guard on reversal, full-apply on forward
        const listed = this._rowById(op.target, op.id) || {}, shown = guard(listed), next = { ...listed, ...shown };
        // the reopen shows at once, off the lists' row: the fresh read below gates only the write, and the caller's reload settles a wrong guess
        if (Object.keys(shown).length && op.target === 'task' && !next.completed_at && !next.archived_at) this._reopenNow(next.parent_id);
        // a reversal guards against the stored row where the store reads one fresh: another device's edit the lists missed stays
        let cur; try { cur = (op.was && res.get ? await res.get(op.id) : listed) || {}; } catch { await this._reloadFor(op.target); return null; }   // unread: not undone, never a guess
        const before = {}; for (const k in op.after) before[k] = JSON.parse(JSON.stringify(cur[k] ?? null));
        // nothing left to write (the row went, or was edited since): skip it — an empty write fails on a gone row and rolls back the whole restore
        const fields = guard(cur), write = Object.keys(fields).length > 0, data = k => k !== 'updated_at';   // a row-change entry carries the stamp: no edit of anyone's
        const left = Object.keys(op.after).some(k => data(k) && !(k in fields));
        if (write && !await res.update(op.id, fields)) { await this._reloadFor(op.target); return null; }   // reload: reconcile the optimistic reopen
        return { kind: 'update', target: op.target, id: op.id, after: before, was: op.after, ...left && { newer: Object.keys(fields).some(data) ? 'part' : 'all' } };
      }
      if (op.kind === 'move') {
        // a reversal over a task moved again since (another device; the lists can miss it) leaves it where it went
        let moved; try { moved = op.was && ((await this.store.tasks.get(op.id))?.parent_id ?? null) !== op.was.parent; } catch { return null; }
        if (moved) return { kind: 'move', target: 'task', id: op.id, after: op.was, was: op.after, newer: 'all' };
        const cur = this._rowById('task', op.id) || {};
        const before = { parent: cur.parent_id ?? null, pos: cur.position };
        const sibs = this.tasks.filter(t => (t.parent_id ?? null) === (cur.parent_id ?? null) || (t.parent_id ?? null) === op.after.parent).map(t => t.id);   // the drop renumbers these
        const fx = this._fxSnap([op.id, ...this._chain(cur.parent_id), ...this._chain(op.after.parent), ...sibs], true);   // old chain auto-completes, new chain reopens
        if (!await this.store.tasks.move(op.id, op.after.parent, op.after.pos)) return null;
        return { kind: 'move', target: 'task', id: op.id, after: before, was: op.after, _fxCapture: fx };
      }
      if (op.kind === 'complete') {
        // Forward: (re)run setCompleted, capturing the full completion delta so the reverse can undo the whole sweep, not just the target.
        if (op.mode === 'forward') {
          const { id, done } = op.fwd, kids = this._taskIdx().kids, chain = this._chain(this.byId.get(id)?.parent_id);
          const reopens = [id, ...chain].filter(x => recActive(this.byId.get(x)?.recurrence)).flatMap(x => descendantIds(this.tasks, x, kids));   // a repeating occurrence reopens its subtasks
          const fx = this._fxSnap([id, ...pendingSweep(this.tasks, id, this.byId, kids), ...chain, ...reopens]);
          if (!done) this._reopenNow(this.byId.get(id)?.parent_id);
          if (!((!done || op.fwd.ticked || await this._checkAllItems(id)) && await this._withPending(id, () => this.store.tasks.setCompleted(id, done)))) {
            const ts = await this.store.tasks.list().catch(() => null), now = ts && new Map(ts.map(t => [t.id, t]));   // unreadable: a throw would skip a batch's rollback
            if (now) await this._reverseFx(this._fxDiff(now, fx.before), now);   // all or nothing: a ticked checklist goes back too
            return null;
          }
          return { kind: 'complete', target: 'task', mode: 'reverse', fwd: op.fwd, _fxCapture: fx };
        }
        // Reverse: reopen every swept/target row.
        if (!await this._reverseFx(op.fx, this.byId, true)) return null;
        return { kind: 'complete', target: 'task', mode: 'forward', fwd: op.fwd };
      }
    },

    // The [label, op]s an `ops` collector gathered, as ONE `target` entry (a save's lone date part too). A composite part (a date's) flattens in: its ops are already in undo order.
    _pushOps(label, target, j, opts) { if (j.length) this._pushEntry(label, j.length > 1 || j[0][1].target !== target ? { kind: 'composite', target, ops: j.map(x => x[1]).reverse().flatMap(o => o.kind === 'composite' ? o.ops : o) } : j[0][1], opts); },
    _pushEntry(label, entryOp, { bin = false, silent = false, restored = false, msg = label, actions = [] } = {}) {
      this._journalPush({ label, target: entryOp.target, kind: entryOp.kind, op: entryOp, bin: !!bin, restored });
      // silent = frequent actions (completion) that shouldn't toast on every press (emil: don't notify 100×/day).
      if (!silent) this.notify(msg, { actions: [this._cardStep(-1, this.journal.at(-1).id), ...actions] });
      if (!bin && !restored) this._pushSmall(entryOp);
    },
    // A task field's live value as a small change records it; 'date' = its date-item's day (+ 'T' start); item = that checklist item's text.
    // undefined: the task (or item) is gone.
    _smallVal(field, id, item, siOf = x => this._siOf(x)) {
      const t = this.byId.get(id), si = t && field === 'date' && siOf(id);
      return !t ? undefined : item ? t.checklist?.find(c => c.id === item)?.text : field !== 'date' ? t[field] ?? null : si ? si.date + (si.start ? 'T' + si.start : '') : null;
    },
    // ONE task's field edits are ALSO quiet Bin rows (kind 'small', bin-only): one per task + field per day — a repeat edit folds into it
    // (first old value, latest new), and one edited back to where it began leaves. Undo = restoreTrash → _apply of the op, guarded.
    _pushSmall(entryOp) {
      const ops = entryOp.ops || [entryOp], si = id => this.scheduleItems.find(x => x.id === id), row = o => o.kind === 'reinsert' ? o.rows?.[0] : si(o.id);
      const dated = ops.filter(o => o.target === 'scheduleItem' && (o.kind !== 'update' || 'date' in o.after) && row(o)?.date && !row(o).block_id);
      const edits = ops.filter(o => o.target === 'task' && o.kind === 'update' && o.was), ids = new Set([...edits.map(o => o.id), ...dated.map(o => row(o).task_id)]);
      if (ids.size !== 1) return;   // a bulk change is a full Bin row already
      const [id] = ids, eq = (a, b) => JSON.stringify(a) === JSON.stringify(b), changes = [];
      // a checklist counts only when an item's TEXT changed in place: a tick, an add, a removal or a reorder is no small change
      const same = (a = [], b = []) => a.length === b.length && a.every((x, i) => x.id === b[i].id);
      for (const o of edits) for (const field of SMALL_FIELDS) if (field in o.after && (field !== 'checklist' || same(o.after.checklist, o.was.checklist))) {
        if (field !== 'checklist') changes.push({ field, old: o.after[field], now: o.was[field], op: { kind: 'update', target: 'task', id, after: { [field]: o.after[field] }, was: { [field]: o.was[field] } } });
        else for (const [i, c] of o.was.checklist.entries()) if (c.text !== o.after.checklist[i].text) changes.push({ field, item: c.id, old: o.after.checklist[i].text, now: c.text, op: { kind: 'update', target: 'task', id } });   // one per renamed item; Undo builds its op off the live list
      }
      const back = dated.find(o => o.kind !== 'remove'), was = back && (back.kind === 'reinsert' ? back.rows[0] : { ...si(back.id), ...back.after });
      if (dated.length) changes.push({ field: 'date', old: was ? was.date + (was.start ? 'T' + was.start : '') : null, now: this._smallVal('date', id), op: { kind: 'composite', target: 'scheduleItem', ops: dated } });
      const today = new Date().setHours(0, 0, 0, 0);
      for (const change of changes) {
        const day = this.journal.filter(e => e.kind === 'small' && !e.restored && new Date(e.ts).setHours(0, 0, 0, 0) === today);
        const prev = day.find(e => e.payload.taskId === id && e.payload.field === change.field && e.payload.item === change.item);
        if (prev) {   // replaced: when it ends where this edit began, this one folds it in
          this.journal.splice(this.journal.indexOf(prev), 1);
          if (eq(prev.payload.now, change.old)) [change.old, change.op] = [prev.payload.old, change.op.kind === 'update' ? { ...change.op, after: prev.op.after } : { ...change.op, ops: this._foldParts([...change.op.ops, ...prev.op.ops]) }];
        } else if (day.length >= SMALL_CAP) this.journal.splice(this.journal.indexOf(day[0]), 1);
        this.cursor = this._jCursor();   // a splice moved it
        if (eq(change.old, change.now)) this._journalSave();   // net zero: no row
        else this._journalPush({ label: 'Small change', target: change.op.target, kind: 'small', op: change.op, payload: { taskId: id, field: change.field, item: change.item, old: change.old, now: change.now }, bin: true, detached: true });
      }
    },
    // Two date edits' inverses as one, newer first: a row the newer put back that the older removes cancels out; two updates of a row merge.
    _foldParts(parts) {
      const out = [];
      for (const part of parts) {
        const i = out.findIndex(o => o.id === part.id), newer = out[i];
        if (newer?.kind === 'reinsert' && part.kind === 'remove') out.splice(i, 1);
        else if (newer?.kind === 'update' && part.kind === 'update') out[i] = { ...newer, after: part.after };
        else if (newer?.kind === 'update' && part.kind === 'remove') out[i] = part;
        else out.push(part);
      }
      return out;
    },
    // A card's Undo/Redo acts only while its entry is the next step that way: closing the composer moves that without a save
    _cardStep(dir, jid) { return { label: dir < 0 ? 'Undo' : 'Redo', fn: () => this._serial('journal', () => this._journalPeek(dir)?.id === jid && this._journalStep(dir)), jid, dir }; },
    // Wrap ANY in-place mutation of one saved row: run it, diff before/after, journal only what changed —
    // a failed one too: a write that partly landed (signed in, one of several) stays undoable.
    // Use for edits/archive/complete/etc. A mutate returning the task fields it wrote is patched in place if the list's shape allows.
    // ops: collect [label, entryOp] instead of pushing, so a caller can land several writes as ONE entry
    // id: one row, or several one write changes (a cascade) — journaled as one entry.
    // only: the ids the write changed, read after it (false: unknown, so every row) — a held write skips rows another device changed, which aren't this step's to undo.
    async _journalRowChange(label, target, id, mutate, { bin = false, silent = false, ops, only, actions, fail = `Failed saving “${label}”. Try again?` } = {}) {
      const ids = [id].flat(), befores = ids.map(x => JSON.parse(JSON.stringify(this._rowById(target, x) || {})));
      const row = await mutate(); if (!(target === 'task' && this._patchTask([row]))) await this._reloadFor(target);
      const failed = row === false || row === null, keep = only?.();
      const parts = ids.map((x, i) => {
        const before = befores[i], after = this._rowById(target, x) || {};
        // normalize: treat missing array fields as empty so undefined→[] isn't a spurious diff
        for (const k of Object.keys(after)) if (before[k] === undefined && Array.isArray(after[k])) before[k] = [];
        const rollback = {}, forward = {};
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
          if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { rollback[k] = before[k] ?? null; forward[k] = after[k] ?? null; }
        return { kind: 'update', target, id: x, after: rollback, was: forward };
      }).filter(op => (!keep || keep.includes(op.id)) && Object.keys(op.after).some(k => k !== 'updated_at'));   // only data that landed: the store's own stamp bump (an unchanged save, a failed write's undone part) is nothing to undo
      const kept = parts.length > 0, op = parts.length > 1 ? { kind: 'composite', target, ops: parts } : parts[0];
      if (kept) ops ? ops.push([label, op]) : this._pushEntry(label, op, { bin, silent: silent || failed, actions: actions?.() });
      if (failed && fail) this.toast(kept ? `“${label}” didn’t fully save. The list shows what’s saved` : fail);
      return !failed;
    },
    // Saved rows merged into their live tasks IN PLACE — instead of re-reading the whole table and rebuilding
    // every row (one 600ms+ task at 5000 tasks on a phone) — when the saves left the list's shape alone. Rebuilt per row:
    // its own, its subtree's (project name / Notes context), every row naming it as a blocker and, when it was done or
    // archived, its parent's (the progress roll-up). Done/archived moves only a scope ROOT (or a project's child): one leaving for a hidden Done
    // list drops out with its subtree; any other move reloads (ceiling: so does a root into a SHOWN Done list or back —
    // a full rebuild; splice it in if ticking with Done shown lags). A position change re-lays its parent's children,
    // rebuilding no row — only under a rendered parent in a flat list. false → the caller reloads. The store reopens a
    // completed ancestor of an open task (the resolver): a batch without that ancestor reloads. So does any _rowV bump
    // the memo hasn't rendered yet (other than an earlier patch, which this one joins): a patch must never hide it.
    _patchTask(rows) {
      if (!this._canPatch()) return false;
      const shape = [...SHAPE, ...VIEW_KEYS[this.sortBy] || [], ...VIEW_KEYS[this.groupBy] || []], fold = ['completed_at', 'archived_at'];
      const by = new Map(rows.map(r => [r?.id, r])), at = (x, k) => { const r = by.get(x.id); return r && k in r ? r[k] : x[k]; };
      // flat: no section counts or progress pies, and no root nested under another (an area view's)
      const flat = !_secMemo.length && this.navSel.type !== 'area', drop = new Set(_rowPatch?.drop), sort = new Set(_rowPatch?.sort), edits = [];
      for (const row of rows) {
        const t = row && this.byId.get(row.id); if (!t || t.overview) return false;
        const changed = Object.keys(row).filter(k => JSON.stringify(row[k]) !== JSON.stringify(t[k])), folds = changed.some(k => fold.includes(k)), counts = folds || changed.includes('task_type');   // counts: a note leaves its parent's ring
        if (changed.some(k => shape.includes(k) && !fold.includes(k) && k !== 'position')) return false;
        if (changed.includes('position') && !(flat && _rowMap.has(t.parent_id) && sort.add(t.parent_id))) return false;
        if (folds && (_visRoots.has(t.id) || this.byId.get(t.parent_id)?.overview)) {   // a root or a project's child (walk's `top`): only an open one leaving for a hidden Done list
          if (!this._dropsRoot(t.id, at(t, 'archived_at'), at(t, 'completed_at'))) return false;
          if (!_cele.has(t.id)) drop.add(t.id);   // a celebrating root stays, patched done, until _celebrate ends
        } else if (counts && _secMemo.some(s => 'pct' in s)) return false;
        for (let a = this.byId.get(t.parent_id), n = 0; a && n < 200; a = this.byId.get(a.parent_id), n++) if (at(a, 'completed_at') && !at(t, 'completed_at')) return false;
        edits.push([t, row, changed, folds, counts]);
      }
      const ids = this._rowsReading(edits.filter(([, , changed]) => changed.some(k => k !== 'position')).map(([t]) => t.id));   // a move alone renders nothing new
      let cal = false;
      for (const [t, row, changed, , counts] of edits) {
        if (counts) ids.add(t.parent_id);
        cal ||= onCalendar(t, this._placedMap());   // on the calendar before the edit…
        for (const k of changed) t[k] = row[k];   // changed fields only: an equal-but-new object still wakes every effect that read it
        cal ||= onCalendar(t, this._placedMap());   // …or after it
      }
      if (cal) _calDataV++;   // an undated edit leaves every calendar memo standing
      const idx = !edits.some(([, , changed]) => changed.some(k => k === 'position' || k === 'blocked_by')) && _taskIdxMemo.get(this._rowV);
      this._patchRows(ids, drop, sort);
      if (idx) _taskIdxMemo.set(this._rowV, idx);   // children and blockers as they were: the index holds the patched objects themselves
      return true;
    },
    // A shown root leaving for a hidden Done list, in a flat list: the patch drops it with its subtree.
    _dropsRoot(id, arch, done) { return (arch ? !this.qfArchived : !!done && !this.showCompleted) && !_secMemo.length && this.navSel.type !== 'area' && _rowMap.get(id)?.depth === 0; },
    // A filter reads anything, so it never patches; nor while a _rowV bump the memo hasn't rendered stands (a patch must never hide it).
    _canPatch() { return !!_visKey && this.navSel.type !== 'filter' && !this.filtering() && (_rowPatch ? _rowPatch.v : +_visKey.slice(0, _visKey.indexOf('|'))) === this._rowV; },
    // The next visibleRows rebuilds only these rows (+ an unrendered earlier patch's); the tray drops just their html.
    _patchRows(ids, drop = new Set(_rowPatch?.drop), sort = new Set(_rowPatch?.sort)) {
      if (_rowPatch) for (const id of _rowPatch.ids) ids.add(id);
      const sideOk = _clSideV === this._rowV;
      this._rowV++; _rowPatch = { ids, drop, sort, key: _visKey, v: this._rowV };
      if (sideOk) { for (const side of Object.values(_clSideOut)) for (const id of ids) side.html.delete(id); _clSideV = this._rowV; }
    },
    // Perform a user mutation and record how to reverse it. op.kind ∈ {delete, create, update, move, composite}.
    async perform(label, op, { bin = [op, ...op.ops || []].some(o => o.kind === 'delete'), silent = false, restored = false, ops, fail = `Failed saving “${label}”. Try again?` } = {}) {   // a composite that deletes is Bin-backed too
      const settled = bin ? await this._binAhead(label, op) : () => {};
      if (!settled) return false;
      let entryOp, partial;
      try { entryOp = await this._apply(op); } catch (e) { entryOp = e.landed; partial = e.partly; }   // a rollback that failed leaves what landed for the Bin
      // no entry to undo: nothing happened — or, partly applied with no rows left out, part may stand (a created row), so no "try again" (a retry could duplicate it)
      if (!entryOp) { settled(); await this._reloadFor(op.target); if (partial || fail) this.toast(partial ? `“${label}” didn’t fully save. The list shows what’s saved` : fail); return false; }
      partial ||= [entryOp, ...entryOp.ops || []].some(o => o.unsure);
      await this._reloadAfter(entryOp);
      this._finalizeFx(entryOp);
      settled();   // the entry below holds what landed
      ops ? ops.push([label, entryOp]) : this._pushEntry(label, entryOp, { bin: !!bin, silent: silent || partial, restored });   // ops: as _journalRowChange's
      if (partial) this.toast(`“${label}” didn’t fully save. What went is in the Bin`);
      return !partial;
    },
    // Write-ahead: the rows a delete takes are stored as a Bin row before it runs, so a page that dies mid-delete or during its
    // re-read keeps them. Returns the drop for once it settles — null when storage refused the copy: the delete must not run.
    // only: the rows a lone delete takes, when not its whole subtree.
    async _binAhead(label, op, only) {
      let ix;   // op._ix: the delete reuses it — one read of the lists per action
      const moving = this._moving(op.ops || []), ops = [op, ...op.ops || []].filter(o => o.kind === 'delete' || o.kind === 'remove').flatMap(o => {
        const rows = only ?? this._notMoved(this._rowsForDelete(o.target, o.id), moving), refs = o.target === 'task' ? this._taskRefs(rows, ix ??= this._refIndex()) : o.target === 'block' && this._blockRefs(o.id);
        return rows.length ? [{ kind: 'reinsert', target: o.target, id: o.id, rows, ...refs }, ...this._stripRefs(o.target, o.id)] : [];
      });
      op._ix = ix;
      if (!ops.length) return () => {};
      const e = { id: crypto.randomUUID(), ts: _jTs = Math.max(Date.now(), _jTs + 1), restored: false, acct: this._acct(), tab: _tab, label, target: op.target, bin: true, detached: true,
        ...ops.length > 1 ? { kind: 'composite', op: { kind: 'composite', target: op.target, ops } } : { kind: 'reinsert', op: ops[0] } };
      _ahead.add(e.id); this.journal.push(e); this._journalSave(); await this._journalFlush();
      const drop = (keep) => {   // keep: the copy stays as its own Bin row
        const i = keep ? -1 : this.journal.findIndex(x => x.id === e.id);   // by id: the journal holds its reactive proxy
        if (i >= 0) this.journal.splice(i, 1);
        _ahead.delete(e.id); this._journalSave();
      };
      if (_jSnap.has(e.id)) return drop;   // committed
      drop(); this.toast(this._jFull ? `Storage is full. “${label}” didn’t run: the Bin couldn’t keep a copy` : `Failed reaching saved history. “${label}” didn’t run. Try again?`);
      return null;
    },
    // Deferred fx: captured before the write, diffed once the caller has reloaded — one reload per action, not per op.
    _finalizeFx(e) { const seen = new Set(); for (const o of [e, ...e.ops || []]) { if (o._fxCapture) o.fx = this._fxDiff(this.byId, o._fxCapture.before, seen); delete o._fxCapture; } },
    // The rows a complete/move/remove can change — target, its sweep, the ancestor chains, a move's siblings (pos: their order too).
    _fxSnap(ids, pos) { return { before: new Map(ids.filter(id => this.byId.has(id)).map(id => [id, FX_FIELDS(this.byId.get(id), pos)])) }; },
    // Shared undo/redo body; dir=-1 = undo, dir=1 = redo. Draft branch is asymmetric: undo reopens, redo skips.
    async _journalStep(dir) {
      const e = this._journalPeek(dir, true); if (!e) return;
      if (e.kind === 'draft') { if (dir < 0) { this._reopenDraft(e.payload); e.restored = true; e.detached = true; } else e.undone = false; this._journalSave(); return; }
      let note = '';
      if (DRAFT_KINDS.includes(e.kind)) {
        const was = dir < 0 ? e.op.before : e.op.after;
        // a row in neither snapshot came in outside this step (a Bin "Put it back"): it stays where it is
        const snap = (now, k) => { const at = x => k ? x[k] : x, ids = new Set([...at(e.op.before), ...at(e.op.after)].map(x => x.id)), rows = JSON.parse(JSON.stringify(at(was)));
          now.forEach((x, i) => { if (!ids.has(x.id)) rows.splice(Math.min(i, rows.length), 0, x); }); return rows; };
        if (e.kind === 'chk-multi') this.draft.checklist = snap(this.draft.checklist);
        else if (e.kind === 'sub-multi') this.draft.subs = snap(this.draft.subs);   // new rows: paintSubs refills them
        else if (e.kind === 'convert') Object.assign(this.draft, JSON.parse(JSON.stringify(was)), { checklist: snap(this.draft.checklist, 'checklist'), subs: snap(this.draft.subs, 'subs') });
        else if (e.kind === 'desc-edit') this.setDescText(this.draft.notes = was);
        else {   // one item: null text = it did not exist then, so undo/redo removes or re-inserts it where it was
          const sub = e.kind === 'held-sub', cl = sub ? this.draft.subs : this.draft.checklist, i = cl.findIndex(c => c.id === e.op.id);
          if (was == null) { if (i >= 0) cl.splice(i, 1); }
          else if (i >= 0) cl[i].text = was;
          else cl.splice(Math.min(e.op.index, cl.length), 0, !sub ? { ...e.op.item, text: was } : e.bin ? { done: false, ...e.op.item, add: true } : e.op.item);   // a Bin one is new (a pre-`add` row too)
        }
        if (e.bin) e.restored = dir < 0;
        e.undone = dir < 0;
        this.syncChkRows();   // a row that lost focus mid-edit has no live x-effect dep on item.text — repaint it from the draft
        this._journalSave();
      } else {
        const verb = dir < 0 ? 'undo' : 'redo', applied = e.op; let inverse, partial;
        const was = this._savedDraft(), all = await this._binAhead(e.label, { ...e.op });   // a redone delete (an undone add): its rows stored before they go. A copy: _ix stays off the entry
        // a save's removed reminders: its entry is no Bin row and the cap can evict it, so their copy stays its own Bin row, as the save's (_saveReminders)
        const rem = all && await this._binAhead('Removed reminder', { kind: 'composite', target: 'reminder', ops: [applied, ...applied.ops || []].filter(o => o.target === 'reminder' && (o.kind === 'delete' || o.kind === 'remove')) });
        if (!rem) return all?.();
        const settled = (keep) => { all(); rem(keep); };
        try { inverse = await this._apply(e.op); }
        catch (x) {   // a rollback that failed: the entry keeps its op for a retry — unless rows went, which then exist only in what landed
          if (!x.landed) { settled(); return this.toast(`Failed fully ${verb}ing “${e.label}”. The list shows what’s saved`); }
          inverse = x.landed; partial = true;
        }
        if (!inverse) { settled(); return this.toast(`Failed ${verb}ing “${e.label}”`); }
        const kept = !partial && this._kept(inverse);   // a row live in another version: this entry stays its copy's only home, as a partial's
        if (!kept) e.op = inverse;
        if (partial || kept) e.bin = e.detached = true;   // what went lives only in this entry: the Bin shows it, truncation keeps it, redo steps over it
        if (e.bin) e.restored = !partial && !kept && !e.restored;   // its rows flip between gone (the Bin shows them) and back: a delete's undo brings them back, an add's takes them
        e.undone = dir < 0;
        this._journalSave(); settled(true); await this._reloadAfter(inverse); this._finalizeFx(inverse); this._journalSave();
        this._rebaseDraft(was);
        this.syncSubRows();   // an open composer's idle subtask rows show what the step wrote (their editors hydrate once)
        if (partial) return this.toast(`Failed fully ${verb}ing “${e.label}”. What went is in the Bin`);
        if (e.target === 'task') this._landOn(e.op?.id ?? e.op?.fwd?.id ?? e.op?.ops?.map(o => o.target === 'task' ? o.id : o.rows?.[0]?.task_id).find(Boolean));   // a save's date-items name its task
        if (inverse.newer === 'all') return this.notify(`“${e.label}” not ${verb}ne, it changed since`, { actions: [this._cardStep(-dir, e.id)] });
        note = kept ? ' · already back, this copy stays in the Bin' : [inverse, ...inverse.ops || []].some(o => o.newer) ? ' · what changed since stays' : this._skipNote(applied);
      }
      this.notify(e.label + (dir < 0 ? ' undone' : '') + note, { actions: [this._cardStep(-dir, e.id)] });
    },
    // One at a time per key: a run waits for the one queued before it — overlapping, a step or tick reads the row the last
    // one is still writing, and its write is lost.
    _serial(key, fn) {
      const run = (_serialQ.get(key) || Promise.resolve()).then(fn, fn), drop = () => _serialQ.get(key) === run && _serialQ.delete(key);
      _serialQ.set(key, run); run.then(drop, drop);
      return run;
    },
    async undo() { await this._serial('journal', () => this._journalStep(-1)); },
    async redo() { await this._serial('journal', () => this._journalStep(1)); },
    // Shared transient flash: `this[prop] = id` for `ms`. A re-flash restarts it — off, then on next frame
    // (keyframes replay) — and clears the old timer so it can't end the new pulse early.
    flash(prop, timerProp, id, ms) {
      this[prop] = null; clearTimeout(this[timerProp]);
      requestAnimationFrame(() => { this[prop] = id; this[timerProp] = setTimeout(() => { this[prop] = null; }, ms); });
    },
    async loadFilters() {
      this.filters = await this.store.filters.list(); this._rowV++;   // a filter's query drives the filter view's rows — invalidate the visibleRows memo
      if (this.navSel.type === 'filter' && !this.activeFilter()) this.setNav('backlog');   // its filter went (an undone add, a redone delete)
    },
    async loadLocations() { await this._reloadFor('location'); },
    isHomeLocation(id) { return this.homeLocationId === id; },
    async setHomeLocation(id) { if (!await this.store.setHomeLocation(id)) this.toast('Failed setting home. Try again?'); await this.loadLocations(); },   // toggles home in the store; loadLocations refreshes the reactive mirror
    // NLP name list: real place names + a synthetic "home" alias (unless a place is literally named "home") so "at home" resolves.
    locNames() { const n = this.locations.map(l => l.name); if (this.homeLocationId && this.locations.some(l => l.id === this.homeLocationId) && !n.some(x => x.toLowerCase() === 'home')) n.push('home'); return n; },
    locByName(nm) { const low = String(nm).toLowerCase(); return this.locations.find(x => x.name.toLowerCase() === low) || (low === 'home' && this.homeLocationId ? this.locations.find(x => x.id === this.homeLocationId) : null) || null; },
    async addLocation(name, region) {
      if (!name?.trim()) return;
      const l = await this.store.locations.add({ name: name.trim(), region: region || this.currentRegion }); await this.loadLocations();
      // its undo is a top-level remove: _apply scrubs and captures its references as Delete does, so a redo puts them back
      l ? this._pushEntry('Added location', { kind: 'remove', target: 'location', id: l.id, rows: [l] }) : this.toast('Failed adding the place. Try again?');
    },
    patchLocation(id, fields) { return this._journalRowChange('Edited location', 'location', id, () => this.store.locations.update(id, fields)); },
    async deleteLocation(id) { if (this.locations.some(l => l.id === id)) return this.perform('Deleted location', { kind: 'delete', target: 'location', id }); },
    locName(id) { const l = this.locations.find(x => x.id === id); return l ? l.name : id; },
    // Row badge: first pinned location's name (+N when several), '' when the task isn't location-scoped or names aren't loaded.
    rowLoc(t) {
      // The PICKED SET is what makes a task location-scoped — an empty set is "anywhere", whatever `mode` says
      // (the same rule as locPolarity). Trusting mode hid the badge on every task saved with the default 'any'.
      const L = t.location; if (!L || !(L.ids || []).length) return '';
      const l = byIdIn(this.locations).get(L.ids[0]); if (!l) return '';
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
      const inst = blocksInRange(this.blocks || [], iso, iso).find(i => i.location_id && (i.allDay ? i.start.slice(0, 10) <= iso && iso <= i.end : new Date(i.start) <= now && now < new Date(i.end)));
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
      const j = [];   // one entry: each place's write diffed as it lands
      for (const l of this.locationsIn(oldName)) await this._journalRowChange('Renamed region', 'location', l.id, () => this.store.locations.update(l.id, { region: newName }), { ops: j });
      this._pushOps('Renamed region', 'location', j);
    },

    // --- Saved filters ---
    activeFilter() { return this.navSel.type === 'filter' ? this.filters.find(f => f.id === this.navSel.id) : null; },
    isFilterQuery(q) { return FILTER_RE.test((q || '').trim()); },
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
      if (f.id) { if (!await this._journalRowChange('Edited filter', 'filter', f.id, () => this.store.filters.update(f.id, fields))) return; }   // the editor keeps its edits
      else {
        const created = await this.store.filters.add(fields); await this._reloadFor('filter');
        if (!created) return this.toast('Failed saving “Added filter”. Try again?');
        this._pushEntry('Added filter', { kind: 'remove', target: 'filter', id: created.id, rows: [created] });
        this.setNav('filter', created.id);   // a brand-new filter navigates to itself
      }
      this.filterEdit = null;
    },
    async deleteFilter() {
      const id = this.filterEdit?.id;
      if (id && !await this.perform('Deleted filter', { target: 'filter', kind: 'delete', id })) return;   // a failed delete keeps the editor and the view
      this.filterEdit = null;
    },
    filterMatches() { return this.filterEdit ? _memo(_filterMemo, this.filterEdit.query + '|' + this._rowV + '|' + this._nowDay, () => this.store.runFilter(this.filterEdit.query).map(id => this.byId.get(id)).filter(Boolean), 1) : []; },   // 4 bindings read it per keystroke
    filterMatchCount() { return this.filterMatches().length; },

    async addTask(close) {
      const d = this.draft, sid = this._draftSid, fields = this.draftFields(d), key = 'save:' + sid;   // held: the press hands the composer on below
      // One save = one slot: the draft moves to save:<sid> before the composer lets go of it. Refused (storage full: toasted),
      // the add still runs and the in-memory slot carries a failure back — only a reload mid-save loses it
      const slot = JSON.parse(JSON.stringify({ ...this._draftEntry(), acct: this._acct() })), m = this._pendingMap();
      m[key] = slot; delete m[this._newKey()];
      this._writePending(m);
      clearTimeout(_draftT);
      if (close) { this._draftSid = crypto.randomUUID(); this._draftBase = this._draftSig(); this.closeComposer(true); }   // clean under a new identity: the collapse shows A and files nothing
      else {
        this.resetDraft(); this._draftBase = this._draftSig();
        this.setEditorText(''); this.setDescText('');   // now, not next tick: the next key is the next draft's
        // Rapid add never scrolls away (ux-small-things): the reader's place is the composer they're still typing in. A
        // sort files the new row anywhere — gliding to it, then the next key's caret-scroll yanking the list back, was
        // B4's spurious scroll. Only keep the whole composer in view (the row it adds may push it down).
        this.$refs.content?.focus({ preventScroll: true });   // now: deferred, it took the title back from a ↓ already pressed into the rows (Alpine holds $nextTick behind a starting transition)
        this.$nextTick(() => this._showComposer());
      }
      // Created at the end of its siblings (the parent the store resolves), so it appears just above the composer.
      const pid = fields.parent_id !== undefined ? fields.parent_id : fields.project ? this.tasks.find(t => t.parent_id === null && t.content === fields.project && !t.archived_at)?.id : this.store.defaultProject();
      const sibs = pid === undefined ? [] : this.tasks.filter(t => (t.parent_id ?? null) === pid);
      // the add reopens completed ancestors (resolver): journal their completion with it, as _saveSubs does
      const reopen = this._reopenIds(pid).map(x => ({ kind: 'update', target: 'task', id: x, after: { completed_at: this.byId.get(x).completed_at } }));
      if (sibs.length) fields.position = Math.max(...sibs.map(t => t.position ?? 0)) + 1;
      const row = await this._newTask(fields, 0);
      if (!row) return this._addFailed(slot);
      // Whole or not at all, in order, stopping at the first failure: it takes the task back, and with it what landed (its date,
      // reminders, links go with it). The completion runs last — it sweeps the open blockers (pendingSweep), which a removal can't take back.
      const id = row.id, done = !row.checklist_plain && row.checklist?.length && row.checklist.every(c => c.done), fx = this._fxSnap([...d.needs || [], ...this._chain(row.parent_id)]);   // its sweep + the parents it auto-completes
      const writes = [...d.on && !d.recurrence ? [() => this.store.scheduleItems.add({ task_id: id, date: d.on.slice(0, 10), start: d.dueTime || null })] : [],   // the ON register lands as a date-item, never as recur_from
        ...(d.reminders || []).map(r => () => this.store.reminders.add({ ...r, task_id: id })),
        ...(d.needs || []).map(o => () => this.store.tasks.link(id, o)), ...(d.neededBy || []).map(o => () => this.store.tasks.link(o, id)),
        ...done ? [() => this.store.tasks.setCompleted(id, true)] : []];
      let ok = true; for (const w of writes) if (!(ok = !!await w())) break;
      const reload = () => Promise.all(['task', 'area', d.on && 'scheduleItem', d.reminders?.length && 'reminder'].filter(Boolean).map(k => this._reloadFor(k)));
      if (!ok && await this.store.tasks.remove(id)) { for (const o of reopen) await this._apply(o); await reload(); return this._addFailed(slot); }   // whole or not at all: the reopened ancestors too
      if (!ok) this.toast(`Added “${row.content}”, but couldn’t attach everything. Check it`);   // the take-back failed: it's added, and ⌘Z removes it
      // Checklist items deleted while this draft was still unsaved left bin rows with no task to restore into
      // (this.editing was null). The task exists now — bind them, or the bin holds a Restore that can never work.
      let bound = false;
      for (const e of this.journal) if (e.kind === 'checklist-item' && e.sid === sid && e.payload && !e.payload.taskId) { e.payload.taskId = id; bound = true; }
      if (bound) this._journalSave();
      this._indexNew(row);
      // its files by a follow-up write (never the INSERT: the column is new), kept apart from the add: a failed one keeps the task and its pending files
      for (const f of this.attach) if (f.sid === sid && !f.taskId) f.taskId = id;
      await this._attachFiles(id, true);
      await reload();   // _reloadFor task + area, and the date/reminders it wrote
      // ONE silent entry (no toast, as before): ⌘Z reopens what the completion swept, deletes the task (its date, reminders and
      // links go with it), and re-completes the ancestors the add reopened
      const entry = { kind: 'composite', target: 'task', ops: [...ok && done ? [{ kind: 'complete', target: 'task', mode: 'reverse', fwd: { id, done: true }, _fxCapture: fx }] : [],
        { kind: 'remove', target: 'task', id, rows: this._rowsForDelete('task', id) }, ...reopen] };
      // Bin-backed, rows present (restored): its ⌘Z is a delete, so the Bin keeps the task past the next action, as any delete's
      this._finalizeFx(entry); this._pushEntry('Added task', entry, { bin: true, restored: true, silent: true });
      this._clearPending(key, sid);   // landed: its slot and Bin rows are spent; the composer is the next draft's
      _lastAdded = id;
      if (this.sticky) {   // the note marks where the row landed, or toasts its Undo when it's out of view (Mac contract)
        const jid = this.journal.at(-1).id;
        this.$nextTick(() => this._rowEl(id) && !this._rowAway(id) ? this._flashSaved(id) : this.notify('Added task', { actions: [this._cardStep(-1, jid)] }));
      }
      return row;
    },
    // A failed add comes back whole, once: into the composer when none is open or the open one is a blank add (nothing
    // typed since the press), else into the Bin — taking over would steal what's being typed. Its slot goes once it's home.
    _addFailed(entry) {
      const key = 'save:' + entry.sid, open = this.composer.open && !this._closingComposer;
      if (open && (this.editing || this._draftSig() !== this._draftBase)) { this.toast(`Failed adding “${entry.draft.content.trim()}”. Kept in the Bin`); return this._binSave(key, entry); }
      this.toast('Failed adding task. Try again?');
      this._reopenDraft(entry);
      if (!this._pSaveFailed) this._clearPending(key);   // its autosave holds it now; refused, only the screen does: the slot stays
    },
    // Bin first, slot after: a refused journal write keeps save:<sid>, which the next boot bins again (worst case a duplicate)
    async _binSave(key, entry, detached) { this._pushDraftBin(this._newKey(), entry, detached); await this._journalFlush(); if (!this._jSaveFailed) this._clearPending(key); },

    // ONE pass per data version (_rowV bumps on every tasks write): children in position order + whom each task blocks.
    // A composer open used to scan every task ~7× (each childTasks template, the progress ring, descendants, relations).
    _taskIdx() {
      return _memo(_taskIdxMemo, this._rowV, () => { const inv = new Map(), arch = [];
        for (const o of this.tasks) {
          for (const b of o.blocked_by ?? []) inv.has(b) ? inv.get(b).push(o.id) : inv.set(b, [o.id]);
          if (o.archived_at) arch.push(o.id);
        }
        return { kids: buildByParent(this.tasks), inv, arch }; }, 1);
    },
    childTasks(id) { return (this._taskIdx().kids.get(id) ?? []).filter(t => t.id !== id); },
    // every archived row and all under it: an archived project's subtree leaves Overview, the pickers and the Lists nav
    _shelved() { const ix = this._taskIdx(); return ix.shelved ??= new Set(ix.arch.flatMap(id => descendantIds(this.tasks, id, ix.kids))); },
    addChecklistItem(text) {   // a checklist adds on top; steps append, in the order they're done
      if (!text.trim()) return;
      const it = { id: crypto.randomUUID(), text: text.trim(), done: false }, cl = this.draft.checklist, at = this.chkSteps() ? cl.length : 0;
      cl.splice(at, 0, it); this._pushChkItem(it, at, null, it.text);
    },
    // Bucket only the display: unchecking restores the item's saved position. Steps keep stored order.
    checklistRows() { return this.chkSteps() ? this.draft.checklist : chkVisible(this.draft.checklist, this.chkPlain(), true, _chkHeld?.key === 'draft' ? _chkHeld.done : null).rows; },
    // The composer's entry rows are plain DOM, not x-fors: mounting ~12 Alpine directives per row made a long list the
    // open's longest frame. One effect per list paints them keyed by id, after the list's ghost; a row keeps its element
    // and rewrites only what changed. Every row renders: drag, ↓/Tab, the grow's measure, zebra, copy and find read them all.
    _paintKeyed(list, items, mk, set) {
      const want = new Set(items.map(x => x.id)), old = new Map();
      for (const el of [...list.children]) if (el.dataset.id) want.has(el.dataset.id) ? old.set(el.dataset.id, el) : el.remove();   // leavers first: no row shuffles past them
      let at = list.querySelector(':scope > .ghost') || list.firstElementChild;   // the sub ghost's x-if may mount after this paint: its <template> anchors, and it mounts right after that
      for (const x of items) { let el = old.get(x.id); if (!el) { el = mk(); el.dataset.id = x.id; } set(el, x); if (at.nextElementSibling !== el) at.after(el); at = el; }
    },
    paintChk(list, force) {
      if (!list?.isConnected) return;
      _chkDraftList = list;
      const plain = this.chkPlain(), find = this.chkFind(), grip = this.editing && !this.chkGhost.trim(), ae = document.activeElement;   // ae: the row being typed in
      const cur = this.chkSteps() ? this.draft.checklist.find(x => !x.done) : null;
      this._paintKeyed(list, this.checklistRows(), () => { const el = CHK_ROW.cloneNode(true); el._r = el.firstChild; el._t = el._r.nextSibling; return el; }, (el, item) => {
        el._item = item;   // the row's events read it back: no per-event scan of the checklist
        const done = !!item.done && !plain, g = grip && (!item.done || plain);   // !!: an item stored without done would make toggle() flip, not set
        el.classList.toggle('done', done); el.classList.toggle('chk-hit', !!find?.has(item.id)); el.classList.toggle('cur', item === cur);
        el._r.classList.toggle('done', done); el._r.classList.toggle('plain', plain);
        if (!g !== !el._g) g ? el.prepend(el._g = CHK_GRIP.cloneNode(true)) : (el._g.remove(), el._g = null);
        // text is read raw: tracked, the row read before it took focus re-ran this whole paint on its first key.
        // Text written outside the row's own editor (undo) repaints via syncChkRows.
        if (!el._t.contains(ae)) { const h = this.chkHl(window.Alpine.raw(item)); if (force || el._t._h !== h) el._t.innerHTML = el._t._h = h; }
      });
    },
    // The draft's subtask rows: stored ones still stored (another device may delete one), and new ones.
    shownSubs() { return this.editing ? this.draft.subs.filter(s => s.add || this.byId.has(s.id)) : []; },
    // A row's pill editor hydrates once per draft (a reopen re-reads the store), then shows the draft's edit of it; later store writes re-hydrate via syncSubRows.
    paintSubs(list) {
      if (!list?.isConnected) return;
      const sid = this._draftSid, fresh = [];
      this._paintKeyed(list, this.shownSubs(), () => { const el = SUB_ROW.cloneNode(true); [, el._c, el._t, el._k] = el.children; return el; }, (el, s) => {
        const c = this.byId.get(s.id);
        el.classList.toggle('done', s.done); el._k.style.display = c && this.childTasks(c.id).length ? '' : 'none';
        const h = this.entryCheckHtml({ ...c || { ...s.fields, id: s.id }, completed_at: s.done || null }); if (el._c._h !== h) el._c.innerHTML = el._c._h = h;
        if (el._sid !== sid || el._s !== s) { el._sid = sid; el._s = s; fresh.push([el._t, c, s]); }   // a new row object: a ⌘Z step's
      });
      // untracked: the pill build reads (and writes) state this paint must not depend on
      if (fresh.length) queueMicrotask(() => { for (const [t, c, s] of fresh) { if (c) this.hydrateSubEditor(t, c); else t._base = null; if (s.html) t.innerHTML = s.html; } });
    },
    // The painted subtask rows' events, delegated from the list (the ghost has no data-id and keeps its own handlers).
    subRowEv(e) {
      const el = e.target.closest?.('.entry[data-id]'), s = el && this.draft.subs.find(x => x.id === el.dataset.id), c = s && this.byId.get(s.id), t = el?._t, y = e.type; if (!s) return;
      if (y === 'click') return e.target.closest('.entry-chk') ? this.tickSub(s, c) : e.target.closest('.entry-kids') ? (e.stopPropagation(), c && this.editTask(c)) : e.target.closest('.entry-del') && this.removeChild(s);
      if (e.target !== t) return;
      if (y === 'focus') { t._was = t.innerHTML; t._subs = this._subsSnap(); }   // what Escape puts back; the rows a ⌘Z step goes back to
      if (y !== 'keydown') return y === 'focus' ? this.focusSubEditor(t, c || s) : y === 'blur' ? this.areaPicker.open || (this._snapSub(t, c, s, true), this._pushSubs('Edited subtask', t._subs))
        : y === 'input' ? (this.pillInput(e), this._snapSub(t, c, s)) : y === 'paste' ? this.onPaste(e) : this.onEditorBeforeInput(e);
      this.entryKey(e); this.subEditorKeydown(e, s); if (e.key === 'Escape') this.entryEscape(e, () => { t.innerHTML = t._was; });   // its blur re-reads the row
      if (e.key === 'Backspace' || e.key === 'Delete') this.entryBackspace(e, () => this.removeChild(s));   // its own subtasks → removeChild's dialog
      e.stopPropagation();   // the row's keys are its own
    },
    // A stored row with open subtasks of its own asks first, as the list's tick does; Save's complete op sweeps them.
    tickSub(s, c) {
      if (inNotes(c ?? s.fields)) return;   // its tack is inert: a note never completes
      if (c?.archived_at) return this.toast('Archived. Unarchive from the task menu');   // as the list's tick
      const before = this._subsSnap(), tick = () => { s.done = !s.done; this._pushSubs('Ticked subtask', before); }; return !s.done && c ? this.confirmSweep(c.id, tick).then(asked => asked || tick()) : tick(); },
    _chkItem(el) { return el.closest?.('.entry.chk')?._item ?? null; },
    // The painted rows' events, delegated from the list (the ghost row has no data-id and keeps its own handlers).
    chkRowEv(e) {
      const item = this._chkItem(e.target); if (!item) return;
      if (e.type === 'click') return e.target.closest('.chk-rect') ? this.chkPlain() || this.toggleChecklistItem(item) : e.target.closest('.entry-del') && this.removeChecklistItem(item);
      const txt = e.target.closest('.entry-txt'); if (!txt) return;
      if (e.type === 'pointerdown') return this.chkRowDown(e);
      if (e.type === 'pointerup') return this.chkRowUp(txt, e);
      if (e.type === 'paste') return this.chkPaste(e, item);
      if (e.type === 'beforeinput') return this.liveBeforeInput(e);
      if (e.type !== 'keydown') return this.chkInput(item, e);   // input / compositionend
      const dir = this._undoKey(e);
      if (dir) { e.preventDefault(); this.liveHistory(txt, dir); }
      this.entryKey(e);
      if (e.key === 'Backspace' || e.key === 'Delete') this.chkDelSel(e) || this.entryBackspace(e, () => this.removeChecklistItem(item));
      else if (e.key === 'Enter') this.chkEnter(e, item);
      else if (e.key === 'Escape') this.entryEscape(e, () => txt.innerHTML = txt._h = this.chkHl(item));
      e.stopPropagation();   // the row's keys are its own (was @keydown.stop)
    },
    // Uncheckable: the checklist renders as a plain notes list (no boxes, no done styling) everywhere
    chkPlain() { return this.draft.checklist_plain; },
    chkSteps() { return !this.draft.checklist_plain && this.draft.task_type === 'steps'; },
    // Steps is picked by typing into the empty composer's "First step" ghost; it and the plain toggle are draft, like every field: nothing lands before Save. Plain and Steps exclude each other.
    toggleChecklistPlain(asked) {
      if (!asked && this.chkSteps()) return this.askConfirm({ message: 'Turn these steps into an uncheckable list?', confirmLabel: 'Make list uncheckable', onConfirm: () => this.toggleChecklistPlain(true) });   // Steps leave only through a confirm (msg 15)
      const d = this.draft, before = this._shapeSnap(); d.checklist_plain = !d.checklist_plain; if (d.checklist_plain) this.setTaskType(null);
      this._pushDraftEdit(d.checklist_plain ? 'Made list uncheckable' : 'Made list checkable', 'convert', { before, after: this._shapeSnap() });
    },
    _shapeSnap() { const d = this.draft; return JSON.parse(JSON.stringify({ checklist: d.checklist, subs: d.subs, task_type: d.task_type, checklist_plain: d.checklist_plain })); },
    setTaskType(type) {   // a note stays one: the checklist's mode is what it turns back into as a task (typeTap)
      const d = this.draft;
      if (d.task_type !== 'note') d.task_type = type;
      else if (type) d.typeBeforeNote = type;
      else delete d.typeBeforeNote;   // absent = null on the way back, and keeps the draft equal to its base
      if (type) d.checklist_plain = false;
    },
    toggleChecklistItem(item) { this._holdChk('draft', item.id, !!item.done); item.done = !item.done; },
    removeChecklistItem(item) { const i = this.draft.checklist.indexOf(item); if (i >= 0) this.draft.checklist.splice(i, 1); if ((item.text || '').trim()) this._pushChkItem(item, i, item.text, null); },
    // Backspace on an empty entry row (checklist item or subtask) deletes it and lands the caret on the neighboring entry.
    // A fresh press only: the caret lands at the end of the row above, so a held key would erase and delete up the list.
    entryBackspace(e, remove) {
      if (e.repeat || e.target.textContent !== '') return;
      e.preventDefault();
      this.moveEntryFocus(e.target, -1) || this.moveEntryFocus(e.target, 1);
      remove();
    },
    // Backspace/Delete with ≥2 tinted (chk-sel) rows deletes them all as ONE ⌘Z step. Rows call it first; onKey
    // too, since a drag that started off every row leaves focus outside them. Returns true when it took the key.
    chkDelSel(e) {
      const selRows = document.querySelectorAll('.composer-entries .entry.chk.chk-sel');
      if (selRows.length >= 2) {
        e.preventDefault();
        const idSet = new Set([...selRows].map(el => el.dataset.id));
        const before = JSON.parse(JSON.stringify(this.draft.checklist));
        this.draft.checklist = this.draft.checklist.filter(c => !idSet.has(c.id));
        this._binChkItems(this.editing, before, before.filter(c => idSet.has(c.id)));
        this._pushDraftEdit('Deleted checklist items', 'chk-multi', { before, after: JSON.parse(JSON.stringify(this.draft.checklist)) });
        return true;
      }
    },
    // Bin-only row per deleted item (detached: ⌘Z steps over it; trashView/restoreTrash handle each), so it stays
    // restorable after the undo stack ages out. A null taskId is late-bound on save (#388).
    _binChkItems(taskId, list, items) { for (const it of items) this._pushChkItem(it, list.indexOf(it), it.text, null, { taskId, detached: true }); },
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
      if (!this._chkDownAt || !e.buttons || !a?.isContentEditable || !a.matches('.entry.chk:not(.ghost) .entry-txt')) return;
      const r = a.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) a.contentEditable = 'false';
    },
    chkRowUp(el, e) {
      const d = this._chkDownAt; this._chkDownAt = null; this._chkPointer = false;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;   // a drag-select (or one begun off this row) → keep the selection, don't edit
      if (e.target.closest('a.dm-link')) return;   // its link card opens instead
      if (el.isContentEditable) return;   // already editing (2nd click of dblclick) — let browser word-select natively
      const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      const off = this._caretOffset(el);   // the clicked source position, kept through the live redraw
      this.chkFocus(el); el.focus(); this._setCaret(el, off);
    },
    // Rows are tabbable (tabindex=0) so keyboard Tab reaches the item title — but a MOUSE press must NOT enter edit
    // mode on focus (that would trap a cross-row drag-select in one contenteditable). _chkPointer marks the mouse path;
    // chkRowUp then decides click-to-edit vs drag. Keyboard focus (no pointer) falls through and enables editing.
    chkFocus(el) {
      if (this._chkPointer || el.isContentEditable) return;   // mouse path: chkRowUp decides click-to-edit vs drag
      el.contentEditable = 'plaintext-only';
      el.innerHTML = this._rowHtml(el.textContent);   // a find hit's highlight gives way to the live markdown
      el._hist = { undo: [], redo: [], prev: { text: el.textContent, caret: null } };   // its own ⌘Z, fresh each edit (liveHistory)
      // A div that becomes editable while already focused has NO caret inside it, so keystrokes do nothing —
      // place a collapsed caret at the end so keyboard Tab-in is immediately typable.
      this._caret(el);
    },
    // Enter → sibling item below · Shift+Enter → plain newline · ⌘/Ctrl+Enter → save & close.
    chkEnter(e, item) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) return this.submitAndClose();
      if (!e.shiftKey) return this.insertChkAfter(item);
      this.insertPlainText('\n');
    },
    // Checklist ghost: Shift+Enter falls through to the native newline; Enter commits and keeps the caret there (survives the empty→list swap:
    // a microtask, since the swap's x-transitions hold $nextTick and keys typed meanwhile hit the page).
    ghostEnter(e) { if (e.shiftKey) return; e.preventDefault(); if (e.metaKey || e.ctrlKey) this.submitAndClose(); else { this.commitChkGhost(); queueMicrotask(() => this._ghostEl('chk')?.focus()); } },
    // Enter on a checklist row inserts a new empty OPEN item just below it and focuses it. A new open item can't
    // live in the done bucket, so a row Entered from the done bucket lands at the end of the open bucket (the stable re-sort pulls it up).
    insertChkAfter(item) {
      const it = { id: crypto.randomUUID(), text: '', done: false };
      this.draft.checklist.splice(this.draft.checklist.indexOf(item) + 1, 0, it);
      this.$nextTick(() => document.querySelector(`.composer-entries .entry.chk[data-id="${it.id}"] .entry-txt`)?.focus());
    },
    // --- Subtask rows are pill editors too: the SAME title engine, aimed via _nlpFocus at the focused row. ---
    // On focus, point the engine at this row and rebuild its sub-draft from the pills already in its DOM (the
    // DOM is the record — survives blur→picker-click→re-focus). c = the child row; null = the "new subtask" ghost.
    focusSubEditor(el, c) {
      _nlpFocus = { el, draft: this.subDraft = this._rowDraft(el, c), ghost: !c, c };
      this.syncTitle();                     // mirrors subGhost for the ghost
    },
    // A row's DOM → a fresh draft (text + pills), leaving the engine aimed where it was.
    _rowDraft(el, c) {
      const prev = _nlpFocus, d = emptyDraft();
      d.goal_ids = [...(c?.goal_ids || [])];   // goals have no pill (R4) — carry the row's own, else a commit writes [] over them
      // No area fallback from the task: a row hydrated before its areas were set diffs [] vs [] (nothing written, see
      // _childPatch), while one the user un-chipped must write [] — the fallback made removing an area chip a no-op.
      _nlpFocus = { el, draft: d, c }; this._recommitPills(PILL_KINDS); this.syncTitle(); _nlpFocus = prev;
      return d;
    },
    focusTitle() { _nlpFocus = null; },     // title regains the default target when it (re)gains focus
    // pillInput: the focus an Undo from outside brings (focusin lands after its input). A row's focus handler re-tracks
    // the undone DOM before the input, so its history is kept as it stood.
    markFocus(e) {
      const el = e.target;
      el._focusFrom = { el: e.relatedTarget || document.body, hist: el._hist && { ...el._hist, undo: [...el._hist.undo] } };
      setTimeout(() => el._focusFrom = null);
    },
    // The ghost editor carries no x-model — mirror the (kept/restored) subGhost text into its DOM when it's idle
    // (x-effect on the row: re-runs when subGhost changes, but never clobbers what the user is actively typing).
    subGhostSync(el) { if (document.activeElement !== el && (el.textContent || '') !== (this.subGhost || '')) el.textContent = this.subGhost || ''; },
    _resetSubDraft() { this.subDraft = emptyDraft(); if (_nlpFocus) _nlpFocus.draft = this.subDraft; },
    _ghostEl(kind) {   // the "new subtask" / "new item" prompt row's editor; an empty Steps draft types into "First step"
      const chk = this.chkSteps() && !this.draft.checklist.length ? '.chk.step-ghost' : '.chk:not(.step-ghost)';
      return document.querySelector('.composer-entries .entry' + (kind === 'sub' ? ':not(.chk)' : chk) + '.ghost .entry-txt');
    },
    _clearEditor(el) { if (el) { el.textContent = ''; el._hist = null; } },   // a fresh ghost: ⌘Z must not bring back the subtask just added
    // Pill editors (title, subtask rows). Chrome undoes a native ⌫/typing run with no beforeinput — only this input. Put
    // our snapshot back, then step our own history; an Undo from outside focused the editor in this same task: focus goes back.
    pillInput(e) {
      const el = e.target, history = e.inputType?.startsWith('history');
      const from = history && (el._focusFrom || document.activeElement !== el && { el: document.activeElement, hist: el._hist });   // Chrome can aim it here without focusing
      if (from) el._hist = from.hist;
      if (history && el._hist?.prev) {
        this._nlpRestore(el._hist.prev, el);
        if (!from) this.nlpHistory(e.inputType === 'historyUndo' ? -1 : 1, el);
        else if (from.el === document.body) el.blur();
        else from.el.focus();
      } else this.syncTitle(e.isComposing);
      this.refreshPickers();
    },
    subEditorKeydown(e, c) {
      if (this._pillKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this._pillThen(() => c ? this.focusEntryGhost(e.target) : this.commitSubGhost()); }
    },
    // A sub-draft → child task fields. A subtask's parent is the editing task (not a project); it has no checklist of its own.
    _subFields(d) { const f = this.draftFields(d); delete f.project; delete f.project_id; delete f.checklist; f.parent_id = this.editing; return f; },
    // The ghost's typing → a new row at the head of the draft (right under the ghost). Its own row, never merged into the ghost —
    // prepending there turned "sub1 30m" + "sub2 1h" into ONE task and dropped the 30m.
    commitSubGhost() {
      const el = this._ghostEl('sub');
      // Rebuild the sub-draft from the ghost's DOM — covers Save, where focus may never have entered the row.
      if (el) this.focusSubEditor(el, null);
      const d = this.subDraft, s = { id: crypto.randomUUID(), add: true, done: false, html: el?.innerHTML || '', fields: this._subFields(d), sd: { on: d.on, dueTime: d.dueTime, recurrence: d.recurrence } };
      s.text = s.fields.content;
      this.subGhost = '';
      // Enter leaves you typing in this same element. Re-aim the engine at the row here too — .focus() on an already-focused
      // element fires no focus event, so nothing else re-points it and the typing would land in the task title.
      this._clearEditor(el); this._resetSubDraft();
      if (el && document.activeElement === el) this.focusSubEditor(el, null); else _nlpFocus = null;
      if (this.editing && s.text) { const before = this._subsSnap(); this.draft.subs.unshift(s); this._pushSubs('Added subtask', before); }
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
      if (c.location?.ids?.length) { const nm = this.locations.find(l => l.id === c.location.ids[0])?.name; if (nm) add('loc', (c.location.mode === 'except' ? 'away from ' : '') + nm); }   // the picked set scopes it, whatever `mode` says (rowLoc)
      _nlpFocus = prev;
      el._hist = null;   // history restarts at the stored row: ⌘Z must not bring back what the store replaced (a blur would write it over)
      el._base = this._rowDraft(el, c); el._html = el.innerHTML;   // what the row showed as filled — a commit writes only what differs from it
    },
    // Rows keep their element across reloads → refresh each idle child editor's pills from the store. Only rows still as
    // filled, plus `id` (the row just saved or reverted): a row holding an unsaved or failed edit keeps it — a sibling's
    // save re-hydrating it wiped the text its toast had promised to keep.
    syncSubRows(id) {
      if (!this.editing) return;
      document.querySelectorAll('.composer-entries .entry[data-id] .entry-txt.sub-ce').forEach(el => {
        if (document.activeElement === el) return;
        const c = this.byId.get(el.closest('.entry')?.dataset.id);
        if (c && (id === c.id || el.innerHTML === el._html)) this.hydrateSubEditor(el, c);
      });
    },
    // The fields a draft changed against its base (a child row's, or the composer's on Save): an untouched one writes
    // nothing, and an edit never nulls what a row can't show (description, a from-date without a date chip).
    _childPatch(a, b) {
      return Object.fromEntries(Object.keys(a).filter(k => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).map(k => [k, a[k]]));
    },
    // A row's editor → its draft row: what differs from the stored task (a new row: all of it); an edit undone leaves nothing to save.
    // Emptied: on blur it shows again what it showed when focused (never a blank title).
    _snapSub(el, c, s, done) {
      const d = this._rowDraft(el, c || s), f = this._subFields(d), b = el._base;
      if (!f.content) { if (done && el._was) { el.innerHTML = el._was; this._snapSub(el, c, s); } return; }
      const sd = { on: d.on, dueTime: d.dueTime, recurrence: d.recurrence };
      if (!b) return Object.assign(s, { html: el.innerHTML, text: f.content, fields: f, sd });
      const patch = this._childPatch(f, this._subFields(b)), moved = d.on !== b.on || d.dueTime !== b.dueTime, edited = moved || Object.keys(patch).length > 0;
      Object.assign(s, { html: edited ? el.innerHTML : undefined, text: edited ? f.content : undefined, patch: edited ? patch : undefined, sd: moved ? sd : undefined });
    },
    // The draft's rows as ONE part of the save: creates first, then edits, moves and ticks, deletes last. All or nothing:
    // a failed part takes back what landed, so the stored subtasks stay as they were and the draft comes back.
    async _saveSubs(id, draft, base, j, drops) {
      // fresh: a new row not stored yet — one whose create landed (a failed save's retry, its Bin draft, a reopen mid-save) is never created twice
      const subs = draft.subs.filter(s => s.add || this.byId.has(s.id)), fresh = s => s.add && !this.byId.has(s.id), keep = new Set(subs.map(s => s.id)), was = new Map(base.subs.map(s => [s.id, s.done]));
      const adds = subs.filter(fresh), gone = base.subs.filter(s => !keep.has(s.id) && this.byId.has(s.id)).map(s => s.id), kept = base.subs.filter(s => keep.has(s.id));
      const order = adds.length > 0 || subs.filter(s => !fresh(s)).some((s, i) => s.id !== kept[i]?.id);   // else positions stay as stored: untouched rows write nothing
      // a new subtask reopens this task and its completed ancestors: journaled as part of it, so ⌘Z completes them again
      const ops = adds.length ? this._reopenIds(id).map(r => ({ kind: 'update', target: 'task', id: r, after: { completed_at: null } })) : [], ticks = [];
      let arrival = 0;
      subs.forEach((s, position) => {
        if (fresh(s)) ops.push({ kind: 'create', target: 'task', arrival: arrival++, fields: { ...s.fields, id: s.id, parent_id: id, position } });
        else { const after = { ...s.patch, ...order && this.byId.get(s.id).position !== position && { position } }; if (Object.keys(after).length) ops.push({ kind: 'update', target: 'task', id: s.id, after }); }
        if (s.sd) ops.push(...this._schedParts(s.id, s.sd));
        if (s.done !== (was.get(s.id) ?? false)) ticks.push({ kind: 'complete', target: 'task', mode: 'forward', fwd: { id: s.id, done: s.done } });
      });
      for (const g of gone) { const to = draft.subMoves?.[g]; if (to) ops.push(...this.childTasks(g).map(k => ({ kind: 'move', target: 'task', id: k.id, after: { parent: to, pos: k.position } }))); }   // "Move them" answered at delete
      ops.push(...ticks, ...gone.map(g => ({ kind: 'delete', target: 'task', id: g })));
      // the deleted rows' own Bin row (Put it back: just them), kept until the save's entry holds them — as _saveReminders'
      const copy = await this._binAhead('Deleted subtask', { kind: 'composite', target: 'task', ops });   // its deletes, less the rows its moves take out
      if (!copy) return false;   // storage refused it: nothing runs
      const ok = !ops.length || await this.perform('Saved task', { kind: 'composite', target: 'task', ops }, { ops: j, fail: null, bin: false });
      drops.push(() => copy(gone.some(g => !this.byId.has(g))));   // kept while one is gone: a partial save's entry is no Bin row
      return ok;
    },
    commitChkGhost() { const v = this.chkGhost.trim(); this.chkGhost = ''; if (v) this.addChecklistItem(v); },
    // Up/Down hop editing focus to the prev/next entry row, but only when the caret is already at the text boundary.
    // Handles both <input> (subtask/ghost) and the checklist item's contenteditable (live "::" editor).
    entryKey(e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const el = e.target, ce = el.isContentEditable;
      // A selection spanning whole rows makes the ROW the keydown target, not an editor — it has no caret to
      // reason about (and no .value, which used to throw and kill ⌘C over a multi-item selection).
      if (!ce && typeof el.value !== 'string') return;
      const down = e.key === 'ArrowDown', s = getSelection();
      if (ce ? !s?.isCollapsed : el.selectionStart !== el.selectionEnd) return;
      if (ce) {   // a live row's edge is its last visible character: the markers past it hide once the caret leaves (3B)
        const r = document.createRange(); r.selectNodeContents(el);
        if (down) r.setStart(s.focusNode, s.focusOffset); else r.setEnd(s.focusNode, s.focusOffset);
        const rest = r.cloneContents();
        for (const m of rest.querySelectorAll('.dm-mark')) m.remove();
        if (rest.textContent) return;
      } else if (el.selectionStart !== (down ? el.value.length : 0)) return;
      if (down ? this.moveEntryFocus(el, 1) : this.moveEntryFocus(el, -1) || this._focusEntry(this.$refs.desc)) e.preventDefault();
    },
    // VISUAL order (ghost → open bucket → done bucket) — sort by on-screen top so the CSS-ordered ghost-on-top
    // layout is respected regardless of DOM order.
    _entryFields(list) { return [...list.querySelectorAll('.entry-txt')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top); },
    // One rung of the focus ladder (entries ↔ description ↔ title), either direction. The caret always lands at the
    // END: on the way UP you're arriving from below, where the down-ladder lands it at 0.
    _focusEntry(next) {
      if (!next) return false;
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
    // Never repaint an active editor: native typing/selection/undo own its DOM until blur.
    chkInput(item, e) {
      if (e.isComposing) return;
      const el = e.target;
      if (e.inputType?.startsWith('history')) return this._liveUndo(el, e.inputType);
      this._redraw(el, this._rowHtml(item.text = el.textContent));
      this._liveStep(el, item.text, e);
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
      // ghost paste lands where addChecklistItem adds; pasting onto an item inserts right after it
      const at = item ? this.draft.checklist.indexOf(item) + 1 : this.chkSteps() ? this.draft.checklist.length : 0;
      const before = JSON.parse(JSON.stringify(this.draft.checklist));
      this.draft.checklist.splice(at, 0, ...items);
      this._pushDraftEdit('Pasted checklist items', 'chk-multi', { before, after: JSON.parse(JSON.stringify(this.draft.checklist)) });   // ONE ⌘Z step for the whole paste, not one per item
    },
    // Splice text in at the caret, verbatim. item=null ⇒ the ghost (a textarea on x-model), else a live item editor.
    _chkPasteRaw(el, item, text) {
      if (item) return this.insertPlainText(text);
      const at = el.selectionStart ?? el.value.length;
      const src = el.value, end = el.selectionEnd ?? at;
      const next = src.slice(0, at) + text + src.slice(end);
      this.chkGhost = next; this.$nextTick(() => el.setSelectionRange(at + text.length, at + text.length));
    },
    // tint the checklist rows a cross-row selection spans — previews what ⌘C will copy (chkCopy kicks in at ≥2 rows)
    _chkSelTint() {
      const sel = getSelection(), r = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!this.composer.open || !r && !_chkTinted) return;   // collapsed caret, nothing tinted = every keystroke: skip the row query
      const rows = document.querySelectorAll('.composer-entries .entry.chk:not(.ghost)');
      const hit = r ? [...rows].filter(el => r.intersectsNode(el.querySelector('.entry-txt'))) : [];
      const on = hit.length >= 2 ? new Set(hit) : null;
      for (const el of rows) el.classList.toggle('chk-sel', !!on?.has(el));
      _chkTinted = !!on;
    },
    // a selection spanning ≥2 checklist items copies as a plain "- item" list (round-trips with chkPaste's bullet-strip).
    chkCopy(e) {
      const sel = getSelection(); if (!e.clipboardData || !sel?.rangeCount || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const items = [...e.currentTarget.querySelectorAll('.entry.chk:not(.ghost) .entry-txt')].filter(el => range.intersectsNode(el));
      if (!items.length) return;   // the ghost's textarea, a subtask row: native
      e.clipboardData.setData('text/plain', items.length < 2 ? range.toString() : items.map(el => '- ' + el.textContent.trim()).join('\n'));   // one item: its source, hidden markers included
      e.preventDefault();
    },
    // Task → markdown: a checkbox line per task, description indented under it, checklist items and subtasks
    // nested below. Copies what's ON SCREEN (the draft, in the display's open-first order), so an edit you can see is an edit you paste.
    taskMd(t, depth = 0) {
      const pad = '  '.repeat(depth), box = (d) => d ? '[x]' : '[ ]';
      const out = [`${pad}- ${box(!!t.completed_at)} ${t.content}`];
      if (t.notes) out.push(...String(t.notes).split('\n').map(l => pad + '  ' + l));
      for (const c of chkVisible(t.checklist || [], t.checklist_plain, true).rows) out.push(`${pad}  - ${box(c.done)} ${(c.text || '').replace(/\n/g, ' ')}`);
      for (const k of this.childTasks(t.id)) out.push(this.taskMd(k, depth + 1));
      return out.join('\n');
    },
    copyEditingMd() {
      const t = this.editingTask(); if (!t) return;
      const md = this.taskMd({ ...t, content: this.draft.content || t.content, notes: this.draft.notes, checklist: this.draft.checklist });
      return this._copyText(md, 'Copied as markdown');
    },
    // A row out of the draft: Save deletes it. A new row exists nowhere else, so it goes to the Bin too. One with its own
    // subtasks asks first (askDeleteTask); `to`: the answer — where they move, null = they go with it.
    removeChild(s, to) {
      const c = this.byId.get(s.id), subs = this.draft.subs, i = subs.indexOf(s), text = s.text || c?.content || '';
      if (i < 0 || to === undefined && c && this.askDeleteTask(c.id, 'child')) return;
      subs.splice(i, 1); if (to) this.draft.subMoves[s.id] = to;
      if (s.add) this._pushChkItem(s, i, text, null, { kind: 'held-sub' });
      else this._pushDraftEdit(text, 'held-sub', { id: s.id, index: i, before: text, after: null, item: JSON.parse(JSON.stringify(s)) });
    },
    // Drag-to-reorder the composer's rows (grip handle; a finger holds the row instead). Subtasks always; the checklist only while EDITING a
    // SAVED task — that is the scope of "no grip in the composer": it was asked for on the NEW-task composer,
    // where nothing is saved yet and the grip crowds the row. Removing it from both took it off saved tasks too.
    initEntrySort(el, kind) {
      makeSortable(el, { itemSel: kind === 'sub' ? '.entry:not(.ghost)' : '.entry:not(.ghost):not(.done)', handleSel: '.entry-grip',
        onCommit: (from, to) => kind === 'sub' ? this.reorderSubtasks(from, to) : this.reorderChecklist(from, to) });
    },
    _reorderChecklist(cl, from, to, plain) {
      const open = cl.filter(c => plain || !c.done); open.splice(to, 0, open.splice(from, 1)[0]);
      let i = 0; return cl.map(c => plain || !c.done ? open[i++] : c);
    },
    reorderChecklist(from, to) {   // Save writes it
      const d = this.draft, before = JSON.parse(JSON.stringify(d.checklist)); d.checklist = this._reorderChecklist(d.checklist, from, to, this.chkPlain());
      this._pushDraftEdit('Reordered checklist', 'chk-multi', { before, after: JSON.parse(JSON.stringify(d.checklist)) });
    },
    reorderSubtasks(from, to) { const before = this._subsSnap(), subs = this.shownSubs(); subs.splice(to, 0, subs.splice(from, 1)[0]); this.draft.subs = subs; this._pushSubs('Reordered subtasks', before); },   // Save writes the positions
    _subsSnap() { return JSON.parse(JSON.stringify(this.draft.subs)); },
    // a ⌘Z step back to `before`, when the rows changed (a blur after no edit is none)
    _pushSubs(label, before) { const after = this._subsSnap(); if (JSON.stringify(after) !== JSON.stringify(before)) this._pushDraftEdit(label, 'sub-multi', { before, after }); },
    // IMPERATIVE hover-block (hovered task + direct children): reading a reactive hover id in 1000 rows' :class costs ~16ms/hover
    hoverRow(r, e) {
      this.clearHover();
      const h = _hoverId = r.t.id, inb = (id, pid) => id === h || pid === h;
      for (const row of [r, ...(_parentMap?.get(h) || [])]) {
        const li = this._rowEl(row.t.id); if (!li) continue;
        li.classList.add('inblock');
        li.classList.toggle('rb-top', !inb(row.prevId, row.prevPid));
        li.classList.toggle('rb-bottom', !inb(row.nextId, row.nextPid));
        _hoverEls.push(li);
      }
    },
    _rehover() { const r = _rowMap?.get(_hoverId) ?? _doneMap?.get(_hoverId); if (r) this.hoverRow(r); },   // a re-rendered block row comes back without its classes
    clearHover() { for (const li of _hoverEls) li.classList.remove('inblock', 'rb-top', 'rb-bottom'); _hoverEls = []; _hoverId = null; },
    _rowEl(id) { return document.querySelector('.surface-lists .list .item[data-id="' + id + '"]'); },
    // drag "nest here" outline — one element, not a reactive :class on every row. dwell: .drop-dwell while the pointer waits out
    // DWELL on it, then .drop-into. No row: no dwell either.
    _setDropInto(id, dwell = false) {
      if (!id) _intoAt = null;
      if (_dropEl?.dataset.id !== id) {
        _dropEl?.classList.remove('drop-into', 'drop-dwell');
        _dropEl = id ? this._rowEl(id) : null;
      }
      _dropEl?.classList.toggle('drop-dwell', dwell);
      _dropEl?.classList.toggle('drop-into', !dwell);
    },
    _clearDrag() {
      const list = document.querySelector('.surface-lists .list');
      if (list) for (const li of list.querySelectorAll('.dragging, .row-hidden, .drop-into, .drop-dwell')) li.classList.remove('dragging', 'row-hidden', 'drop-into', 'drop-dwell');
      _dropEl = _dragDescs = _dragIds = _dragGrab = _dragParents = _dragProjs = _intoAt = _ghostAt = null; _ghostGrown = _sortRefused = false; this._reflow();   // the subtree windows back in, fitted
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
      if (_kbEl) this._revealRow(id, 0);   // keyboard steps settle immediately, including same-frame key repeats
    },
    // --- Delegated row events (bound once on the <ul>, resolve the row by data-id) — see the list markup ---
    _rowFromEl(el) { return el ? (_rowMap?.get(el.dataset.id) ?? _doneMap?.get(el.dataset.id) ?? null) : null; },   // O(1) via Maps maintained in visibleRows(); active OR Done list
    listOver(e) {
      if (e.target.closest('a, code, .md-code, .chk-more, .chk-rect, .chk-rect:not(.plain) + .chk-txt, .row-rel')) return this.clearHover();   // they own their clicks (an item's box/text ticks it) — styles.css .item:hover mirrors
      const el = e.target.closest?.('.item'), id = el?.dataset.id;
      if (id === _hoverId) return;                  // mouseover fires per child element — skip if same row
      const r = id ? this._rowFromEl(el) : null;
      r ? this.hoverRow(r, e) : this.clearHover();
    },
    listClick(e) {
      const sec = e.target.closest?.('.sec-row');
      if (sec) return this.toggleSec(sec.dataset.sec);
      const r = this._rowFromEl(e.target.closest?.('.item')); if (r) this.onRowClick(r, e);
    },
    listDragStart(e) { if (sorting || e.target.closest('.chk-row, code, .md-code')) return e.preventDefault(); const r = this._rowFromEl(e.target.closest?.('.item')); if (r) this.dragStart(r.t, e); },   // native selection, checklist sorting and a held row (touch) own their drags
    // Pointer-drag a task's checklist rows to reorder — scoped to that one task's .chk-list (never leaks / reparents).
    // A finger has no HTML drag, so the rows themselves also sort by hold-then-drag: above/below the row it lands
    // on, or into it after a rest (dwell), through the same drop() the mouse uses. Registered after the checklist, which owns its presses.
    initListSort(el) {
      makeSortable(el, { itemSel: '.chk-row[data-ci]:not(.done)', scopeSel: '.chk-list', onCommit: (from, to, scope) => this.reorderTaskChecklist(from, to, scope) });
      // A phone row has no chevron (CSS): a still hold folds it instead. A held parent's subtree leaves the list as on desktop;
      // the gap opens where drop() lands it ('below' a parent shown open is after its subtree) and the lifted row shifts to the depth it lands at.
      const depth = el => this._rowFromEl(el).depth;
      const span = (to, items) => { const d = depth(items[to]); while (items[to + 1] && depth(items[to + 1]) > d) to++; return to; };
      const outOf = el => { const par = this.byId.get(this.byId.get(el.dataset.id)?.parent_id); return par && this.taskProj(par) ? par : null; };   // a project's row, or the Inbox's, has none
      let land = null;   // sorted: the row's landing (_sortLand) and the row the gap opened by, read only while sortable's `cut` holds
      makeSortable(el, { itemSel: '.item[data-id]:not(.row-hidden)', touchOnly: true, enabled: () => !this.composer.open, fixed: () => this.navSel.type === 'area',
        // #97, user: "the finger moves left by 15% of the screen width … and the row under the finger unindents" — desktop's rule (_dragFar,
        // dragOver): the slot's row lands after its parent, a level up; a root row has no parent to leave
        far: x => this._dragFar(x),   // ceiling: a hold starting under 15% of the width from the left edge (58.5px on a 390px phone) can't unindent; revisit if users grab near the checkbox
        pinned: (to, items, from, far) => { const up = far && outOf(items[to]); return (!!up || to !== from) && this._sortPins(up ? up.parent_id : this.byId.get(items[to].dataset.id)?.parent_id); },
        refused: () => this._sortHint(),
        onHold: item => { const chev = item.querySelector('.row-chev'), fold = !!chev && !chev.checkVisibility(); if (fold) this.toggleTaskCollapse(item.dataset.id); return fold; },
        lift: (item, x0) => { this._dragX0 = x0; this._liftSubtree([item.dataset.id]); return () => { item.style.translate = ''; this._clearDrag(); }; },
        // ceiling: past an open parent with 2+ subtasks the gap steps back (after its subtree, then after its first subtask): drop()'s
        // landings go in that order. Revisit if phone drags read as jumpy; a fix moves where a drop below an open parent lands (user's OK)
        span,
        // sorted, a slot under another parent opens the gap where the row lands among that parent's rows (desktop: dragOver)
        redirect: (to, items, from, far) => {
          const t = this.byId.get(items[to].dataset.id), up = far && outOf(items[to]);
          if (!up && (to === from || this.sortBy === 'manual')) return null;
          // manual, an unindent is drawn below its parent's subtree; a parent not drawn (a filter's head) keeps the slot. ceiling: desktop's ghostPos places that one
          const at = up && this.sortBy === 'manual' ? { id: t.id, mode: 'outdent', at: { id: up.id, mode: 'below' } }
            : this._sortLand(up || t, up || to > from ? 'below' : 'above', items[from].dataset.id), drawn = at.at ?? at;
          const k = items.findIndex(el => el.dataset.id === drawn.id);   // ceiling: a row scan per move while far or sorted; index items by id if long lists drag slowly
          if (k < 0) return null;
          land = { id: at.id, mode: at.mode, el: items[k] };
          return drawn.mode === 'above' ? k : span(k, items) + 1;
        },
        // up onto an open parent's first subtask the slot is before the parent, unless it's the lifted row's own ancestor (a subtask
        // keeps first place among its siblings): a row nests only by resting on it (dwell), never past MAX_DEPTH
        above: (to, items, from) => { const chain = this._chain(this.byId.get(items[from].dataset.id)?.parent_id);
          while (to > 0 && depth(items[to]) > depth(items[to - 1]) && !chain.includes(items[to - 1].dataset.id)) to--; return to; },
        dwell: (item, done) => { const id = item && projectDepth(this.tasks, item.dataset.id) + _dragSubDepth <= MAX_DEPTH ? item.dataset.id : null; this._setDropInto(id, !done); return !!id; },
        preview: (item, to, items, into, cut) => { item.style.translate = (into ? depth(into) + 1 - depth(item) : depth(cut ? land.el : items[to]) - depth(item)) * 22 + 'px 0'; },
        onCommit: (from, to, _, items, into, cut) => {
          this.dragId = items[from].dataset.id;
          this.taskDropHint = into ? { id: into.dataset.id, mode: 'into' } : cut ? { id: land.id, mode: land.mode } : { id: items[to].dataset.id, mode: to > from ? 'below' : 'above' };
          this.drop();
        } });
    },
    async reorderTaskChecklist(from, to, scope) {
      const id = scope.closest('.item')?.dataset.id, t = this.byId.get(id); if (!t) return;
      const next = this._reorderChecklist(t.checklist || [], from, to, t.checklist_plain);
      // Journal against the captured id so ⌘Z reverses THIS reorder — not an earlier action on another task.
      await this._journalRowChange('Reordered checklist', 'task', id, () => this.store.tasks.update(id, { checklist: next }));
    },
    // Zones read the rows as drawn. Off every row (the ghost's gap is pointer-events:none, a section head, the list's padding) the
    // drop keeps the slot it shows, its mode and depth, so aiming at the gap never reads the next row; a drag left there still outdents.
    // Halves can't flip under a still pointer: the ghost opening beside a row moves that row away from the pointer, deeper into the half.
    // Into closes the gap its wait held open above the parent, sliding the parent up from under the pointer: the parent is read
    // where it sat when into was earned, so only the pointer moves it off.
    listDragOver(e, glide = false) {
      const sc = document.querySelector('.surface-lists .app');
      if (this.dragId && !glide) this._listEdgeGlide(sc, e.clientX, e.clientY);
      const dy = this.taskDropHint?.mode === 'into' && _intoAt?.top != null && _dropEl ? _dropEl.offsetTop - _intoAt.top : 0, y = e.clientY + dy, pr = dy && _dropEl.getBoundingClientRect();
      const itemEl = pr && y >= pr.top && y < pr.bottom ? _dropEl : e.target.closest?.('.item'), r = this._rowFromEl(itemEl);
      if (r) this.dragOver(r.t, { clientY: itemEl === _dropEl ? y : e.clientY, clientX: e.clientX, currentTarget: itemEl, dataTransfer: e.dataTransfer }, r.depth);
      else if (_dropSlot && this.taskDropHint) {
        this._setDropInto(null);
        this.dragOver(_dropSlot.t, e, _dropSlot.depth, _dropSlot.mode);
      }
    },
    // The edge zone travels every frame from the last dragover's pointer: a still pointer's come ~20/s, and a step per dragover
    // judders ~30px every third frame. edgeScrollStep is rate × elapsed, so px/s holds. Each step re-reads the slot the rows put
    // under the pointer, so the ghost never trails them and a release lands where it's drawn. Ends 100ms after the last dragover,
    // the hold kept: Chrome's autoscroll would run on under a pointer left in the zone.
    _listEdgeGlide(sc, x, y) {
      const t0 = performance.now(); this._dndHold(edgeSpeed(sc, y) ? sc : null);   // before the dragover reads a row: the move into the zone marks none
      motion.run('listEdge', () => {
        const v = !!this.dragId && !!edgeScrollStep(sc, y); this._dndHold(v ? sc : null);
        if (v) this.listDragOver({ target: document.elementFromPoint(x, y) || sc, clientX: x, clientY: y }, true);
        return v && performance.now() - t0 < 100;   // edgeScrollStep's clock
      });
    },
    // Chrome's own DnD autoscroll runs on any user-scrollable box under a pointer near its edge, ~5x our zone's speed on top
    // of it. overflow-y:hidden stops it and scrollTop still moves; held only while in our zone, so a wheel mid-drag still scrolls.
    _dndHold(el) {
      if (el === _dndHeld) return;
      _dndHeld?.style.removeProperty('overflow-y');
      (_dndHeld = el)?.style.setProperty('overflow-y', 'hidden');
    },
    // No row lookup: the drop lands wherever the pointer happens to be — the gap between rows, the list's own
    // padding, or the drop-ghost (an .item with NO data-id, rendered exactly where you're aiming). Gating on
    // "the release resolved to a row" threw those away, which is why some drags silently did nothing. The last
    // dragOver already recorded the intent in taskDropHint, and drop() reads only that.
    listDrop(e) {
      if (this.taskDropHint?.mode === 'into' && performance.now() - _intoSeen.t < INTO_SEEN) this.dragOver(_dropSlot.t, e, _dropSlot.depth, _intoSeen.half);   // unseen: the slot it would have shown
      this.drop();
    },
    hasProgress(t) { return this.hasChildren(t.id) && this._taskIdx().kids.get(t.id)?.some(c => c.id !== t.id && !inNotes(c)) || (t.checklist || []).length > 0; },   // a note child never fills the ring
    rowProgress(t, kids = this.childTasks(t.id)) {
      let count = 0, closed = 0, mins = 0, minsClosed = 0, timed = true;
      for (const c of kids) {
        if (inNotes(c)) continue;
        const shut = c.completed_at || c.archived_at; count++; if (shut) closed++;
        if (c.est_minutes > 0) { mins += c.est_minutes; if (shut) minsClosed += c.est_minutes; } else timed = false;
      }
      if (count) return Math.round(timed ? minsClosed / mins * 100 : closed / count * 100);
      const cl = t.checklist || [];
      return cl.length ? Math.round(cl.filter(c => c.done).length / cl.length * 100) : 0;
    },
    toggleChk(taskId, i) {
      const t = this.byId.get(taskId), cl = t?.checklist ?? [], tick = () => this._serial(taskId, () => this._toggleChk(taskId, i));   // a task's ticks: each reads the list the last one wrote
      this._holdChk(taskId, i, !!cl[i]?.done);
      // the tick that finishes the task completes its blockers and subtasks with it (store setCompleted): it asks first, like the task's own check
      const finishes = t && !t.completed_at && !cl[i]?.done && cl.every((x, j) => j === i || x.done);
      return finishes ? this.confirmSweep(taskId, tick).then(asked => asked || tick()) : tick();
    },
    // A tick shows in place, struck through, and its list sorts once, when the pointer leaves the list or 1.5s after the
    // last tick: quick ticks each land on the row they aimed at. key: the task id, or 'draft' for the composer's list;
    // item: the item's id, or a row's ci (its stored index, which a tick never moves). done: what it showed before.
    _holdChk(key, item, done) {
      if (_chkHeld?.key !== key) {
        this._releaseChk();
        _chkHeld = { key, done: new Map() };
        addEventListener('pointerover', _chkOut ??= e => this._chkPointerIn(e) || this._releaseChk(e.buttons > 0), { passive: true });
      }
      if (!_chkHeld.done.has(item)) _chkHeld.done.set(item, done);
      clearTimeout(_chkHeldT);
      _chkHeldT = setTimeout(() => this._releaseChk(), 1500);
    },
    _chkListEl(key = _chkHeld?.key) { return key === 'draft' ? _chkDraftList : document.querySelector(`.item:not(.composer)[data-id="${key}"] .chk-list`); },
    // by the list's box, not the event's target: a landed tick repaints the row under a still pointer, which fires pointerover on the row
    _chkPointerIn(e) { const r = this._chkListEl()?.getBoundingClientRect(); return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; },
    // pressed: a press is under way. Its row repainted now, the press's element goes and its click with it, so the release waits it out.
    _releaseChk(pressed = !!document.querySelector(':active')) {
      if (!_chkHeld) return;
      if (pressed) {
        const held = _chkHeld;
        clearTimeout(_chkHeldT);
        _chkHeldT = 0;   // a tick by this press re-arms it, and the hold goes on
        return void addEventListener('pointerup', () => setTimeout(() => _chkHeld === held && !_chkHeldT && this._releaseChk(false)), { once: true });
      }
      const id = _chkHeld.key, rows = () => [...this._chkListEl(id)?.querySelectorAll(':scope > [data-id], :scope > [data-ci], :scope > .chk-more') ?? []], key = el => el.dataset.id || el.dataset.ci || 'more';
      const before = new Map(rows().map(el => [key(el), el.getBoundingClientRect().top]));
      clearTimeout(_chkHeldT);
      removeEventListener('pointerover', _chkOut);
      _chkHeld = null;
      if (id === 'draft') this.paintChk(_chkDraftList);
      else { this._dropRowHtml(id); this._paintRows(); }
      const els = rows(), tops = els.map(el => el.getBoundingClientRect().top);   // all reads first: an animate() between two reads forces a layout each
      for (const [i, el] of els.entries()) {   // the one slide, each row from where it showed; one arriving ("…N more") fades in
        const from = before.get(key(el)), dy = from - tops[i];
        if (from == null || dy) motion.soften(el.animate(from == null ? { opacity: [0, 1] } : { translate: [`0 ${dy}px`, '0 0'] }, { duration: 200, easing: DESIGN.ease['in-out'] }));
      }
    },
    async _toggleChk(taskId, i) {
      const task = this.byId.get(taskId); if (!task) return;
      const list = task.checklist || [], item = list[i]; if (!item) return;
      const done = !item.done, allDone = list.every((x, j) => j === i ? done : x.done), label = done ? 'Checked item' : 'Unchecked item', ops = [];
      // ONE silent entry against taskId (⌘Z reverses THIS toggle, never another task's action): the item, then, when the
      // list's state flips the task's, the completion's own op, whose snapshot takes back all it did (a sweep, parents,
      // a repeating occurrence and what it reopened). ticked: the item write already ticked the list.
      await this._journalRowChange(label, 'task', taskId, async () => {
        const at = await this.store.tasks.setChecklistItem(taskId, item.id, done); if (!at) return false;
        if (allDone === !!task.completed_at) return { id: taskId, checklist: list.map((x, j) => j === i ? { ...x, done } : x), updated_at: at };   // what the write changed
        if (await this.perform(label, { kind: 'complete', target: 'task', mode: 'forward', fwd: { id: taskId, done: allDone, ticked: true } }, { ops, fail: null })) return true;   // → a full reload
        await this.store.tasks.setChecklistItem(taskId, item.id, !done); return false;   // untick: the "didn't save" toast is then true
      }, { silent: true, ops });
      this._pushOps(label, 'task', ops, { silent: true });
    },
    // parentId and its ancestors, bottom-up — O(depth) over byId (store.js ancestorIds scans every row per level).
    _chain(parentId) { const out = []; for (let a = this.byId.get(parentId); a && !out.includes(a.id); a = this.byId.get(a.parent_id)) out.push(a.id); return out; },
    // Resolver ids: the completed ancestors an OPEN task landing under parentId reopens (store.js ancestorsToReopen).
    _reopenIds(parentId) { return this._chain(parentId).filter(id => this.byId.get(id).completed_at); },
    // Optimistic: un-tick them NOW, before the store round-trip (2 on the cloud path); the reload after the write reconciles.
    // Copy-on-write: the signed-in store's cache holds these same row objects — mutating them made the store think the
    // parent was already open, so the DB never reopened it.
    _reopenNow(parentId) {
      const ids = this._reopenIds(parentId);
      for (const id of ids) { const i = this.tasks.findIndex(t => t.id === id), t = { ...this.tasks[i], completed_at: null }; this.tasks[i] = t; this.byId.set(id, t); }
      if (ids.length) this._rowV++;
    },
    // arg is a plain content string OR a full fields object (subtask NLP → due/prio/area/… land on the child).
    async addSubtask(parentId, arg) {
      const fields = typeof arg === 'string' ? { content: arg } : { ...arg };
      fields.content = (fields.content || '').trim(); if (!fields.content) return;
      this._reopenNow(parentId);
      // created at the TOP of its siblings (the stores' default: above every row), right under the "New subtask" ghost — mirrors the checklist ghost
      const task = await this._newTask({ ...fields, parent_id: parentId }, 0);
      this._indexNew(task);
      await this.loadTasks();   // a failed create: reconciles the optimistic reopen
      return task;
    },
    // Overflow menu: subtasks → checklist items, or subtasks/checklist ↔ Steps — Steps only behind its confirm (msg 15). A draft
    // change like the rest: Save lands the checklist first and deletes the subtasks last; until then it's one ⌘Z step.
    convertTo(type, asked) {
      const d = this.draft, subs = this.shownSubs(), steps = type === 'steps', nested = subs.reduce((n, s) => n + this.descendantCount(s.id), 0);
      const what = subs.length ? (subs.length > 1 ? `these ${subs.length} subtasks` : 'this subtask') : steps ? 'this checklist' : 'these steps';
      // only the subtasks become items: what's nested in them goes to the Bin with them — said first
      if (!asked && (nested || steps !== this.chkSteps())) return this.askConfirm({ danger: !!nested, onConfirm: () => this.convertTo(type, true),
        message: `Turn ${what} into ${steps ? 'steps' : 'a checklist'}?` + (nested ? ` ${this._nTasks(nested)} nested in them will go to the Bin when you save.` : ''),
        confirmLabel: steps ? 'Convert to steps' : 'Convert to checklist' });
      const before = this._shapeSnap();
      const items = subs.map(s => { const f = { ...this.byId.get(s.id), ...s.fields, ...s.patch }; return { id: crypto.randomUUID(), text: f.notes ? `${f.content}::${f.notes}` : f.content, done: s.done }; });
      Object.assign(d, { checklist: [...d.checklist, ...items], subs: [] }); this.setTaskType(steps ? 'steps' : null);   // subMoves stay: a row deleted with "Move them" still moves them
      this._pushDraftEdit(steps ? 'Converted to steps' : 'Converted to checklist', 'convert', { before, after: this._shapeSnap() });
    },
    // A convert (or undo) persisted these fields: fold ONLY them into the saved state — other unsaved edits (the title, held subtasks) stay a draft.
    _landDraft(fields) {
      const b = JSON.parse(this._draftBase); Object.assign(b.draft, fields); this._draftBase = JSON.stringify(b);
      if (_saveBase) Object.assign(_saveBase, JSON.parse(JSON.stringify(fields)));   // stored now: Save diffs against them, else converted subtasks read as new ticks and complete the task
      if (this._draftSig() === this._draftBase) this._clearPending(this._draftKey(), this._draftSid); else this._flushDraftNow();
    },
    // The open task as saved, before an undo/redo/restore: _rebaseDraft diffs it against the task after.
    _savedDraft() { const t = this.composer.open && !this._closingComposer && this.byId.get(this.editing); return t && { draft: this.draft, saved: this.taskToDraft(t) }; },
    // An undo/redo/restore rewrote the open task: each field it changed and the user hadn't takes the saved value, else the next
    // Save writes the stale draft back over it. A field with unsaved typing keeps it, now unsaved against the new value.
    _rebaseDraft(was) {
      const t = was && this._live(was.draft) && this.byId.get(this.editing); if (!t) return;
      const now = this.taskToDraft(t), changed = Object.keys(now).filter(k => JSON.stringify(now[k]) !== JSON.stringify(was.saved[k]));
      if (!changed.length) return;
      const base = JSON.parse(this._draftBase).draft, clean = changed.filter(k => JSON.stringify(this.draft[k]) === JSON.stringify(base[k]));
      for (const k of clean) this.draft[k] = now[k];
      // a subtask back in the store (Put it back, Undo) joins rows with unsaved edits, else it's hidden and Save deletes it again
      if (changed.includes('subs') && !clean.includes('subs')) now.subs.forEach((s, i) => this.draft.subs.some(x => x.id === s.id) || was.saved.subs.some(x => x.id === s.id) || this.draft.subs.splice(i, 0, s));
      if (clean.includes('content')) this.setEditorText(now.content);
      if (clean.includes('notes')) this.setDescText(now.notes);
      if (clean.includes('checklist')) this.syncChkRows();
      this._landDraft(Object.fromEntries(changed.map(k => [k, now[k]])));
    },
    // Overflow menu: checklist → subtasks. CREATE FIRST, DELETE LAST: the checklist is cleared only after
    // every subtask verifiably exists; any failure rolls back the created tasks and leaves the checklist
    // untouched. Worst case is a duplicate, never a loss.
    async convertToSubtasks(asked) {
      const id = this.editing; if (!id || _converting.has(id)) return;
      if (!asked && this.chkSteps()) return this.askConfirm({ message: 'Turn these steps into subtasks?', confirmLabel: 'Convert to subtasks', onConfirm: () => this.convertToSubtasks(true) });
      _converting.add(id);
      try { return await this._convertToSubtasks(id, this.draft); } finally { _converting.delete(id); }
    },
    async _convertToSubtasks(id, d) {   // held: the composer may close or move on mid-convert
      const items = d.checklist.filter(i => i.text.trim());
      if (!items.length) return;
      const beforeChecklist = JSON.parse(JSON.stringify(d.checklist)), beforeType = d.task_type ?? null, type = inNotes(d) ? 'note' : null;   // a note stays one
      // a new subtask reopens this task and its completed ancestors: a failed convert puts each one's completed_at back, and so
      // does one that leaves this task completed (an open task rightly keeps its ancestors open)
      const was = new Map();
      for (let t = this.byId.get(id); t; t = this.byId.get(t.parent_id)) was.set(t.id, t.completed_at ?? null);
      const wasCompletedAt = was.get(id);
      const made = [];
      let ok = false;
      try {
        for (const item of items) {
          const sep = item.text.indexOf('::');
          const content = sep >= 0 ? item.text.slice(0, sep).trim() : item.text;
          const desc = sep >= 0 ? item.text.slice(sep + 2).trim() : null;
          const task = await this._newTask({ content, parent_id: id, ...(desc ? { notes: desc } : {}) }, made.length);
          if (!task) throw 0;
          made.push(task.id);
        }
        await this.store.tasks.reorder(made);   // creates prepend — restore the checklist's order
        for (let i = 0; i < items.length; i++) if (items[i].done && !await this.store.tasks.setCompleted(made[i], true)) throw 0;
        // every subtask exists — only NOW is the destructive step safe. completed_at pins the task's own state (the last done
        // child auto-completed it): converting never completes it — complete only if it was AND every item was done.
        // ceiling: [] also drops an item another tab or device added since this composer opened, unbinned; revisit if a cross-device checklist loss is reported
        if (!await this.store.tasks.update(id, { checklist: [], task_type: type, completed_at: items.every(i => i.done) ? wasCompletedAt : null })) throw 0;
        // only the draft that asked: a reopened one is the user's newer typing, never cleared. Items typed meanwhile stay, shown.
        if (this._live(d)) d.checklist = d.checklist.filter(c => c.text.trim() && !items.some(i => i.id === c.id));
        ok = true;
      } catch {
        // undo partial creates; checklist intact. A take-back that fails leaves its subtask: said, never a clean rollback.
        const left = (await Promise.allSettled(made.map(k => this.store.tasks.remove(k)))).flatMap((r, i) => r.value ? [] : [`“${items[i].text.split('::')[0].trim()}”`]);
        this.toast('Failed converting to subtasks. Checklist kept' + (left.length ? `, and ${left.join(', ')} stayed as ${left.length > 1 ? 'subtasks' : 'a subtask'}` : ''));
      }
      await this.loadTasks();
      // ceiling: compares against pre-convert state, so a completion made elsewhere during the convert is reset; window = one convert; revisit with a busy lock or realtime conflict reports
      if (!ok || this.byId.get(id)?.completed_at) {
        const moved = [...was].filter(([k, at]) => this.byId.has(k) && (this.byId.get(k).completed_at ?? null) !== at);
        if (moved.length) { await Promise.all(moved.map(([k, at]) => this.store.tasks.update(k, { completed_at: at }))); await this.loadTasks(); }
      }
      if (ok) this._pushEntry('Converted to subtasks', { kind: 'composite', target: 'task', ops: [
        ...made.map(k => ({ kind: 'remove', target: 'task', id: k })).reverse(),
        { kind: 'update', target: 'task', id, after: { checklist: beforeChecklist, task_type: beforeType, completed_at: wasCompletedAt } },   // removing done kids can auto-complete it — pin it back
      ] });
      if (ok && this._live(d)) {   // a failed convert saved nothing: the checklist stays a draft
        // only the new rows land: a subtask the draft deleted (or converted) stays an unsaved delete, else it's back beside its copy
        const rows = made.map((k, i) => ({ id: k, done: !!items[i].done })), base = JSON.parse(this._draftBase).draft.subs;
        d.subs = [...d.subs.filter(s => s.add), ...rows, ...d.subs.filter(s => !s.add)]; this.setTaskType(null);
        this._landDraft({ checklist: [], subs: [...rows, ...base], task_type: type });
      }
      return ok;
    },
    // Overflow menu: duplicate the edited task, open edits saved first, from the SAVED row (byId) —
    // fresh checklist ids, drop identity/status/subtree. Routed through perform() so ⌘Z removes the copy.
    async duplicateEditing() {
      const id = this.editing, d = this.draft; if (!this.byId.get(id) || !await this._saveOpenEdits(d)) return;
      const src = this.byId.get(id), f = { checklist: (src.checklist || []).map(c => ({ ...c, id: crypto.randomUUID() })) };   // fresh item ids; identity/status/subtree deliberately absent from the whitelist
      for (const k of ['content', 'notes', 'importance', 'recur_from', 'available_from', 'deadline_at', 'est_minutes', 'parent_id',
        'area_ids', 'goal_ids', 'color', 'favorite', 'place', 'location', 'recurrence', 'milestone', 'checklist_plain', 'task_type']) f[k] = src[k];
      if (this._live(d)) this.closeComposer(true);   // a clean draft is still open: close first (saved=true → don't keep a draft)
      await this.perform('Duplicated task', { target: 'task', kind: 'create', fields: f });
    },
    anyDialog() { return OVERLAYS.some(([open, , dialog]) => dialog && open(this)); },
    modalOpen() { return this.settingsOpen || this.anyDialog(); },   // the page behind is inert while true
    closeDialogs() { for (const [open, close, dialog] of OVERLAYS) if (dialog && open(this)) close(this); },
    // Focus moves in once Alpine shows it (closing hands it back: _modalFrom); a stray Enter must never be what destroys data.
    // $refs read now: Alpine resolves it from the element that called, and a menu item asking is gone by the microtask
    askConfirm(opts) { this.confirm = opts; const refs = this.$refs; queueMicrotask(() => refs[opts.danger ? 'confirmNo' : 'confirmYes'].focus()); },
    async confirmYes(k = 'onConfirm') { const c = this.confirm; this.confirm = null; if (c?.[k]) await c[k](); },   // 'onAlt' = the optional left secondary
    confirmNo() { const c = this.confirm; this.confirm = null; if (c?.onCancel) c.onCancel(); },
    onPaste(e) {
      const text = e.clipboardData?.getData('text') || '';
      if (!text) return;
      // A structured payload takes the whole paste — it can never be a title. The sentinel is what makes
      // this safe to intercept: ordinary text, markdown and unrelated JSON all fall through untouched.
      if (looksLikePayload(text)) { e.preventDefault(); return this.openImport('tasks', text); }
      // Never the browser's paste: syncTitle reads only text nodes, so pasted formatting was shown but not saved, and a
      // title is one line — pasted line breaks become spaces.
      e.preventDefault();
      const line = text.replace(/\s*[\r\n]+\s*/g, ' '), segs = tokenizeAll(line, new Date(), this.locNames());
      const sel = getSelection(); const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      if (!segs.some(s => s.kind)) return this.insertAtRange(range, document.createTextNode(line));
      this.askConfirm({
        message: 'This text has tokens. Turn them into chips?',
        confirmLabel: 'Make chips',
        cancelLabel: 'Keep as text',
        onConfirm: () => this.insertSegments(segs, range),
        onCancel: () => this.insertAtRange(range, document.createTextNode(line)),
      });
    },
    // ─── Import — dropped .ics calendars and pasted {"adherod":1} payloads ────────────────────────
    // Both paths land in ONE preview. Nothing is written until the payload validates clean and you press
    // the button: a partly-applied bad import is the worst outcome this feature can have.
    _importCtx() {
      return { lists: this.tasks.filter(t => t.overview).map(t => t.content), areas: this.areas.map(a => a.name),
               places: this.locNames(), today: isoDate(new Date()) };
    },
    openImport(kind, text, name = '') {
      const r = kind === 'ics' ? parseICS(text) : parsePayload(text, this._importCtx());
      if (kind === 'ics' && !r.items.length && !r.problems.length) return this.toast('No events in that file');
      this.importPreview = { kind, name, items: r.items, problems: r.problems, busy: false };
    },
    // Preview rows draw with the SAME component as the palette, the sweep dialog and the relation wells —
    // rowBodyHtml in minimal mode. This is taskLine's sibling: taskLine adapts a SAVED row (byId lookups for
    // parent and areas), and an import item has no id, no byId entry, and a list that may not exist yet.
    importLine(it) {
      const f = it.fields || {};
      const t = { content: it.content, completed_at: null, archived_at: null, recurrence: f.recurrence ?? null, checklist: f.checklist || [] };
      const known = new Map((this.areas || []).map(a => [a.name.trim().toLowerCase(), a]));
      return rowBodyHtml({
        t, pc: this.pc(f.importance || 'none'), titleHtml: mdTitleFn(it.content),
        // A declared-but-not-yet-created area has no row to read a colour off — fall back to the default
        // rather than dropping the chip, so the preview shows what you are agreeing to either way.
        areas: (it.areaNames || []).map(n => { const a = known.get(n.trim().toLowerCase()); return { name: n, icon: a?.icon, color: a?.color || this.areaDefault }; }),
        projName: it.listName || '', isDefaultProj: false, note: inNotes(f), rels: [], chk: f.checklist || [],
      }, { minimal: true });
    },
    // Only what the row itself does NOT already say: the check carries importance, the chip carries the
    // list, the area chips carry areas. Repeating them here was noise.
    importRowMeta(it) {
      if (it.kind === 'event') return [it.starts_at.replace('T', ' '), it.recurrence ? 'repeats' : '', it.detached_from ? 'moved occurrence' : ''].filter(Boolean).join(' · ');
      const f = it.fields || {};
      return [it.on ? 'on ' + it.on.date + (it.on.time ? ' ' + it.on.time : '') : '',
        f.deadline_at ? 'by ' + f.deadline_at : '', f.recurrence ? 'repeats' : '',
        f.est_minutes ? f.est_minutes + 'm' : '',
        it.needs?.length ? 'needs ' + it.needs.length : '', it.reminders?.length ? 'reminder' : ''].filter(Boolean).join(' · ');
    },
    guideExample() { return JSON.stringify(PROMPT_EXAMPLE, null, 2); },
    copyPrompt() { return this._copyText(importPrompt(this._importCtx()), 'Prompt copied. Paste it to your assistant'); },
    importTitle() {
      const p = this.importPreview; if (!p) return '';
      return p.kind === 'ics' ? (p.name || 'Calendar') : 'Add tasks';
    },
    async _copyText(text, msg) {
      try { await navigator.clipboard.writeText(text); }
      catch { const ta = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }   // no clipboard permission → the old way still works
      if (msg) this.toast(msg);
    },
    copyCode(e) {
      const button = e.target.closest('.code-copy'); if (!button) return;
      e.preventDefault(); e.stopPropagation();
      return this._copyText(button.closest('code, .md-code').textContent, 'Copied');
    },
    codeKey(e) {
      if (e.target.closest('.code-copy') && !e.metaKey && !e.ctrlKey && e.key !== 'Escape') return e.stopPropagation();   // button keys must never edit/delete the containing row
      // Editing uses raw text; restore decoration before Tab searches for the copy control.
      if (e.key !== 'Tab' || e.shiftKey || !e.target.matches('.desc, .entry.chk .entry-txt') || !e.target.textContent.includes('```')) return;
      const el = e.target; el.blur();
      const button = el.querySelector('.code-copy'); if (button) { e.preventDefault(); button.focus(); }
    },
    // Naming every problem only pays off if you can hand the list back to whatever wrote the payload.
    copyProblems() {
      const p = this.importPreview; if (!p?.problems.length) return;
      const head = `${p.problems.length} problem${p.problems.length === 1 ? '' : 's'} with this import. Fix them and resend the whole payload:`;
      return this._copyText([head, ...p.problems.map(x => `- ${x.path}: ${x.message}`)].join('\n'), 'Problems copied');
    },

    // Page-wide file drop. Gated on a FILE drag so it never steals the task/event drags, and on the
    // extension so an unrelated file is left unclaimed — the OS then shows its own bounce-back, which is
    // the honest answer. A .ics we CAN'T read says so out loud instead of doing nothing.
    onFileDragOver(e) {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault(); this.fileDrag = true;
    },
    onFileDragLeave(e) { if (!e.relatedTarget) this.fileDrag = false; },   // null relatedTarget = left the window, not a child
    async onFileDrop(e) {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault(); this.fileDrag = false;
      if (this.chatDrop()) return this.addFiles(e.dataTransfer.files);   // an open chat takes any file
      const dropped = [...(e.dataTransfer.files || [])], files = dropped.filter(f => f.name.toLowerCase().endsWith('.ics'));
      if (this.composerDrop() && files.length < dropped.length) return this.attachFiles(dropped);   // so does an open composer, but calendar files still import
      if (!files.length) return;   // not ours — stay silent, same as a non-.ics drop on macOS
      try { this.openImport('ics', (await Promise.all(files.map(f => f.text()))).join('\n'), files.map(f => f.name).join(', ')); }
      catch { this.toast('Failed reading that calendar'); }   // unreadable file, or a time parseICS can't place
    },

    async applyImport() {
      const p = this.importPreview;
      if (!p || p.problems.length || p.busy || !p.items.length) return;
      p.busy = true;
      try { await (p.kind === 'ics' ? this._importEvents(p.items) : this._importTasks(p.items)); this.importPreview = null; }
      finally { if (this.importPreview) this.importPreview.busy = false; }
    },
    _nEvents(n) { return n + (n === 1 ? ' event' : ' events'); },
    // New UIDs are created; an existing UID refreshes ONLY on a higher SEQUENCE, so re-dropping an older
    // export can't roll data back and re-dropping the same file can't clobber edits made since.
    async _importEvents(items) {
      const byKey = Map.groupBy((this.events || []).filter(e => e.external_id), e => e.external_id), taken = new Set(), ops = [], refresh = [];
      const pick = (key, ok = () => true) => byKey.get(key)?.find(e => !taken.has(e.id) && ok(e));
      for (const it of items) {
        const key = it.external_id, fields = { title: it.title, starts_at: it.starts_at, ends_at: it.ends_at, all_day: it.all_day, recurrence: it.recurrence ?? null, ics_seq: it.seq ?? null, external_id: key ?? null };
        // rows imported before uid#rid keys hold the bare UID on the series AND its moved occurrences: the series is the one that
        // repeats. A refresh writes the new key, so they migrate in place. ceiling: two legacy moved rows of one series pair up in list order.
        const prev = key && (pick(key, e => !e.recurrence === !it.recurrence) || pick(key) || it.detached_from && pick(key.split('#')[0], e => !e.recurrence));
        if (prev) taken.add(prev.id);
        if (!prev) ops.push({ kind: 'create', target: 'event', fields });
        else if (icsReplaces(prev.ics_seq, it.seq)) refresh.push([prev.id, fields]);
      }
      if (!ops.length && !refresh.length) return this.toast('Already imported, nothing changed');
      const steps = [], updated = `Updated ${this._nEvents(refresh.length)}`;
      for (const [id, fields] of refresh) await this._journalRowChange(updated, 'event', id, () => this.store.events.update(id, fields), { ops: steps });
      this._pushOps(updated, 'event', steps, { bin: true });   // one Bin row holding the old versions, one ⌘Z
      if (ops.length) await this.perform(`Imported ${this._nEvents(ops.length)}`, { kind: 'composite', target: 'event', ops }, { bin: true, restored: true });   // an add: its ⌘Z puts it in the Bin
      await this._reloadFor('event');
    },
    // Create-first, roll back on ANY failure — worst case is a no-op, never half a paste. Relations, placements
    // and reminders are separate checked passes: a link can name a later item, and create() carries none of the rest.
    async _importTasks(items) {
      const made = new Map(), created = [], lists = new Map(), rows = new Map();
      try {
        for (const it of items) {
          const fields = { ...it.fields, content: it.content };
          if (it.parentRef) fields.parent_id = rows.get(it.parentRef).id;   // the parent item: an id-less one nests too
          else if (it.listName) fields.parent_id = await this._importList(it.listName, lists, created);
          if (it.areaNames?.length) fields.areas = it.areaNames;            // names → find-or-create, both stores
          if (it.on && fields.recurrence) fields.recur_from = it.on.time ? `${it.on.date}T${it.on.time}` : it.on.date;   // a repeat's 'on' anchors the series, as addTask does
          if (it.fields.location) fields.location = { mode: it.fields.location.mode, ids: this._locIds(it.fields.location.names) };
          const row = await this._newTask(fields);
          if (!row) throw new Error(`could not create “${it.content}”`);
          created.push(row); rows.set(it, row); if (it.ref) made.set(it.ref, row);
        }
        for (const it of items) {
          const id = rows.get(it).id;
          const res = [];   // a lost link, date or reminder fails the import: the rollback below takes the tasks back
          for (const ref of it.needs) res.push(await this.store.tasks.link(id, made.get(ref).id));
          for (const ref of it.relates) res.push(await this.store.tasks.link(id, made.get(ref).id, 'relates'));
          if (it.on && !it.fields.recurrence) res.push(await this.store.scheduleItems.add({ task_id: id, date: it.on.date, start: it.on.time || null }));
          for (const r of it.reminders || []) res.push(await this.store.reminders.add({ task_id: id, ...r }));
          if (!res.every(Boolean)) throw new Error(`could not save the links, date or reminders of “${it.content}”`);
        }
      } catch (err) {
        // newest first; what stays is named. Areas stay: find-or-create can't tell one it inserted from one another tab or
        // device already had, and an empty leftover is a duplicate, never a loss.
        const left = [];
        for (const row of [...created].reverse()) if (!await this.store.tasks.remove(row.id).catch(() => false)) left.push(row.content);
        await Promise.all([this._reloadFor('task'), this._reloadFor('area')]);
        return this.toast(`Import failed: ${left.length ? `couldn’t take back ${left.map(n => `“${n}”`).join(', ')}` : 'no tasks were added'} (${err.message})`);
      }
      await Promise.all([this._reloadFor('task'), this._reloadFor('area')]);
      // One entry for the whole paste. Only the ROOTS are listed: removing a task takes its subtree with it.
      const roots = created.filter(r => !created.some(c => c.id === r.parent_id));
      this._pushEntry(`Added ${this._nTasks(created.length)}`, { kind: 'composite', target: 'task',
        ops: roots.map(r => ({ kind: 'remove', target: 'task', id: r.id, rows: this._rowsForDelete('task', r.id) })).reverse() }, { bin: true, restored: true });   // its ⌘Z puts it in the Bin
      await Promise.all([this._reloadFor('scheduleItem'), this._reloadFor('reminder')]);
    },
    async _importList(name, cache, created) {
      const key = name.trim().toLowerCase();
      if (cache.has(key)) return cache.get(key);
      const found = this.tasks.find(t => t.overview && !t.archived_at && t.content.trim().toLowerCase() === key);   // an archived one is retired, as the store's #project
      if (found) { cache.set(key, found.id); return found.id; }
      const row = await this._newTask({ content: name, overview: true, parent_id: null });
      if (!row) throw new Error(`could not create the list “${name}”`);
      created.push(row); cache.set(key, row.id); return row.id;
    },
    _locIds(names = []) {
      const by = new Map((this.locations || []).map(l => [l.name.trim().toLowerCase(), l.id]));
      return names.map(n => by.get(n.trim().toLowerCase())).filter(Boolean);
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
    async insertSegments(segs, range) {
      for (const seg of segs) if (seg.kind === 'area') seg.value = await this.ensureAreaId(seg.value);   // a NAME → its id (find-or-create), as a typed @name (pillifyArea)
      const frag = document.createDocumentFragment();
      for (const seg of segs) {
        if (seg.kind && seg.value != null) { frag.appendChild(this.makePill(seg.kind, seg.value, seg.token, frag)); this.commitPill(seg.kind, seg.value); }
        else if (seg.text ?? seg.token) frag.appendChild(document.createTextNode(seg.text ?? seg.token));   // an area that failed to save stays its words
      }
      if (frag.lastChild && frag.lastChild.nodeType === 1) frag.appendChild(document.createTextNode(' '));   // caret home after a trailing pill
      this.insertAtRange(range, frag);
    },
    // An Overview project keeps no checklist: one that has items must first delete them or convert them to subtasks.
    askShowInOverview() {
      // The flag rides the composer's normal save: pending edits land with it (nothing typed is lost), a failed save keeps
      // the composer + draft and flags nothing, and ⌘Z reverts the whole write (edits, flag, a deleted checklist).
      const d = this.draft, id = this.editing, n = d.checklist.filter(c => (c.text || '').trim()).length, flag = (f = {}) => this.submitComposer({ ...f, overview: true });
      this.askConfirm(n ? { message: `Overview projects don't keep a checklist. Turn its ${n} item${n > 1 ? 's' : ''} into subtasks, or delete ${n > 1 ? 'them' : 'it'}?`,
        // flags only once every subtask exists; a composer closed or moved on meanwhile isn't this draft: flag the task by id
        confirmLabel: 'Convert to subtasks', onConfirm: async () => await this.convertToSubtasks(true)
          && (this._live(d) ? flag() : this.perform('Showed in Overview', { target: 'task', kind: 'update', id, after: { overview: true } })),
        // its [] also drops an item another tab or device added since open: the Bin gets those too (as a save keeps them, submitComposer)
        altLabel: 'Delete checklist', onAlt: async () => { const own = this.draft.checklist, seen = new Set([..._saveBase.checklist, ...own].map(c => c.id)), cl = [...own, ...(this.byId.get(id)?.checklist || []).filter(c => !seen.has(c.id))];
          if (await flag({ checklist: [] }) === true) this._binChkItems(id, cl, cl.filter(c => (c.text || '').trim())); } }
        : { message: "Show this task in Overview? It'll stay in its current project.", confirmLabel: 'Show in Overview', onConfirm: () => flag() });
    },
    // Shared sweep-check: if completing `id` would also complete open dependents (children/blockers),
    // show the confirm dialog and return true — the caller must stop and let the dialog finish the job.
    // Returns false when there's nothing to sweep, so the caller completes it directly.
    async confirmSweep(id, complete = () => this.applyComplete(id, true)) {
      const sweep = pendingSweep(this.tasks, id, this.byId, this._taskIdx().kids);
      if (!sweep.length) return false;
      this.askConfirm({ message: 'Completing this will also complete:', bodyHtml: this._sweepHtml(sweep.map(x => this.byId.get(x)).filter(Boolean)), confirmLabel: 'Complete all', onConfirm: complete });
      return true;
    },
    _sweepHtml(items) { return `<div class="sweep-list">${items.map(it => `<div class="task-line">${this.taskLine(it)}</div>`).join('')}</div>`; },
    async toggle(t, row = null) {
      if (inNotes(t) && !t.completed_at) return;   // a note never completes (x, the row, the composer); one that came in done reopens
      if (t.archived_at) { this.toast('Archived. Unarchive from the task menu'); return; }   // dash checkbox is inert
      if (!t.completed_at && await this.confirmSweep(t.id)) return;
      const finish = !t.completed_at, id = t.id;
      const start = finish && row && this.celebrations !== 'off' ? this._celebrate(row) : null;   // before the write: its render holds the row
      await this.applyComplete(id, finish);
      start?.();
      if (finish && this.celebrations === 'full' && this.byId.get(id)?.completed_at) this._dayClearFx(id);
    },
    // The completion reward (docs/ui/task-list.md §Completion reward): the tick pops in the row's own slot, the row lingers
    // done, then a leaving one exits; full adds a warm ring and, on an effort-weighted roll, embers. Imperative row
    // state (_stampRow), so nothing re-renders for it. Returns the linger's start, run once the write lands.
    _celebrate(r) {
      const id = r.t.id, full = this.celebrations === 'full', leaves = !r.depth || this.navSel.type === 'filter' || this.isOverviewProject(this.byId.get(r.t.parent_id));   // a subtask of a task stays inline
      _cele.set(id, { mode: this.celebrations, leaves, leave: false, ember: full && !motion.gentle && motion.rand() < emberOdds(r.estSize) ? emberBurst() : '' });
      return () => {
        clearTimeout(_celeT);   // ONE linger, restarted by each tick: a burst exits together, never shifting rows under the pointer
        _celeT = setTimeout(() => this._celeExit(), motion.t(600));
      };
    },
    // A pointer tick on a Steps row (docs/ui/task-list.md §Steps, docs/ui/motion.md), one phase after another: the rail
    // fills down to the next step in the task's colour, that step's node lights, then the write lands and the next step's
    // text pushes the old one up out of the row while the step after rises in below. A tick on the preview's node lights
    // it and pushes the preview line alone. The step that finishes the task takes the completion reward instead. Keys and
    // ⌘Z never come here: they stay instant. A second tap hurries the first to its end (motion.seq), then ticks what's
    // current by then.
    _stepTick(id, preview = false) {
      let block, before, d = 0, p0 = 0, fs = 0, faint;
      return motion.seq('step:' + id,
        async s => {
          const r = _rowMap.get(id) ?? _doneMap.get(id), el = this._rowEl(id), step = preview ? r?.next : r?.step;   // a done task's row is in the Done list
          if (!step) return;
          if (!preview && !r.next) {   // the last step: the task's own reward, unless the tick has to ask first (toggleChk's sweep)
            const start = this.celebrations !== 'off' && !pendingSweep(this.tasks, id, this.byId, this._taskIdx().kids).length ? this._celebrate(r) : null;
            await this.toggleChk(id, step.ci); start?.(); return;
          }
          if (this.celebrations === 'off' || !el) return this.toggleChk(id, step.ci);
          block = el.querySelector(preview ? '.step-next' : '.step-block');
          const rect = sel => el.querySelector(sel).getBoundingClientRect();
          d = preview ? rect('.step-next').height : rect('.step-next-txt').top - rect('.row-step').top;   // one step's pitch
          const was = getComputedStyle(el.querySelector('.step-next-txt .chk-txt') ?? el.querySelector('.step-next-txt'));   // the preview's look, which the next step grows out of
          s.ci = step.ci; p0 = r.progress; fs = parseFloat(was.fontSize); faint = was.color;
          if (preview) return;
          const fill = block.appendChild(document.createElement('i'));
          fill.className = 'rail-fill';
          return motion.fill(s, fill);
        },
        s => block && motion.light(s, block.querySelector('.step-node'), preview ? 'done' : 'lit'),
        async s => {
          if (!block) return;
          const out = block.cloneNode(true);   // the old step, frozen; the moving preview text is the new row's own
          out.classList.add('push-out');
          out.querySelector(preview ? '.step-next-txt' : ':scope > .step-next .step-next-txt')?.remove();
          before = this._rowTops();
          const stamped = new Promise(res => _push.set(id, res));   // _stampRow hands over the re-rendered row
          await this.toggleChk(id, s.ci);
          const el = await Promise.race([stamped, new Promise(res => requestAnimationFrame(() => res(null)))]);
          _push.delete(id);
          const box = el?.querySelector(preview ? '.step-next' : '.step-block');
          if (!box) {   // the write failed, so the row stays: it drops what the first phases drew
            block.querySelector('.rail-fill')?.remove();
            block.querySelector('.step-node')?.classList.remove('lit', 'done');
            return;
          }
          box.prepend(out);
          const step = !preview && box.querySelector(':scope > .row-step'), chk = el.querySelector(':scope > .check'), o = { duration: DESIGN.motion.daily, easing: DESIGN.ease.drawer };
          const runs = motion.push(s, box, out, [...box.children].filter(c => c !== out && c !== step), d, step ? [step] : []);
          if (step) {   // the preview's text carries on, growing and darkening into the step line (its colour is the text's own)
            const txt = step.querySelector('.chk-txt') ?? step;
            runs.push(motion.go(s, step, { scale: [fs / parseFloat(getComputedStyle(step).fontSize), 1] }, o), motion.go(s, txt, { color: [faint, getComputedStyle(txt).color] }, o));
          }
          runs.push(motion.go(s, chk, { '--p': [p0, getComputedStyle(chk).getPropertyValue('--p')] }, o));   // the ring's pie takes the step
          this._glideFrom(before);
          return runs;
        });
    },
    _celeExit() {
      const held = [..._cele];
      for (const [id, fx] of held) if (fx.leaves && this.byId.get(id)?.completed_at) { fx.leave = true; this._rowEl(id)?.classList.add('leave'); }   // undone meanwhile: it stays
      setTimeout(() => {
        const left = held.filter(([, fx]) => fx.leave).map(([id]) => id), marked = held.map(([id, fx]) => [this._rowEl(id), fx]);
        for (const [id, fx] of held) if (_cele.get(id) === fx) _cele.delete(id);
        const unmark = () => {
          for (const [el, fx] of marked) {
            el?.classList.remove('cele', fx.mode, 'leave');   // a staying row keeps its element
            el?.querySelector('.ember')?.remove();
          }
        };
        // Unmarked after the list renders: dirtied before, the render's window read (_winOf) forces a layout the glide's
        // own read then repeats. Same task, so no frame shows the marks.
        if (left.length) { this._glideRows(left, () => { this._exitRows(left); queueMicrotask(unmark); }); this._clearIn(); }   // only a leaving row changes visibleRows: a staying one rebuilds nothing
        else unmark();
      }, motion.t(200));
    },
    // A pointer tick's exit may empty the list: if so, its All clear arrives (CSS, on .arrive — it runs once x-show
    // displays it). Only here: on load or after a key it's plain.
    _clearIn() {
      const el = document.querySelector('.surface-lists .empty'); if (!el) return;
      el.classList.add('arrive');
      setTimeout(() => el.classList.remove('arrive'), motion.t(1200));
    },
    // The ended rewards' rows leave: dropped from the rows as they stand when the patch can, else a full rebuild.
    _exitRows(left) {
      const t = id => this.byId.get(id);
      if (this._canPatch() && left.every(id => this._dropsRoot(id, t(id)?.archived_at, t(id)?.completed_at))) {
        _rowPatch ??= { ids: new Set(), drop: new Set(), sort: new Set(), key: _visKey, v: this._rowV };   // no _rowV bump: no row's data changed
        for (const id of left) _rowPatch.drop.add(id);
      } else _visKey = '';
      this._celeV++;
    },
    // FLIP around a change that drops rows: each row, the Add button and the Done head glide from where they stood; a row
    // with no before (the one arriving in Done) fades in. Keyed by id: the morph may rebuild a row. Reads the rendered
    // window only, animates on screen only. Alpine renders in its microtask flush, so ours, queued after, sees the new layout.
    _glideRows(left, change) {
      const before = this._rowTops();
      for (const id of left) before.delete(id);   // in Done it arrives, it doesn't travel
      change();
      queueMicrotask(() => this._glideFrom(before));
    },
    _rowTops() { return new Map([...document.querySelectorAll(GLIDE_ROWS)].map(el => [el.dataset.id || el, el.getBoundingClientRect().top])); },
    _glideFrom(before, enter = true) {
      const els = [...document.querySelectorAll(GLIDE_ROWS)], rects = els.map(el => el.getBoundingClientRect());   // all reads first: an animate() between two reads forces a layout each
      let dy = 0;   // a row with no before rides with the one above it
      for (const [i, el] of els.entries()) {
        const r = rects[i], from = before.get(el.dataset.id || el);
        if (from != null) dy = from - r.top;
        if (r.bottom < 0 || r.top > innerHeight || (!enter && from == null) || (from != null && !dy) || el.getAnimations().some(a => a.id === 'arrival')) continue;
        motion.soften(el.animate({ translate: [`0 ${dy}px`, '0 0'], ...from == null && { opacity: [0, 1] } }, { duration: 200, easing: DESIGN.ease['in-out'] }));
      }
    },
    // Clearing the day (_clCleared: every task planned for today done) by THIS completion: a one-shot moment over the
    // page, named in work done, never a count. Built and removed here: no state, nothing reactive.
    _dayClearFx(id) {
      const iso = isoDate(new Date()), day = this._clGroup(iso, iso)[iso] || [];
      const cleared = day.some(it => it.kind === 'task-block' && it.id === id) && this._clCleared(day);
      if (!cleared) return;
      const el = document.createElement('div');
      el.className = 'day-clear';
      el.innerHTML = '<span class="day-clear-t"></span>';
      el.firstChild.textContent = cleared.label;
      document.body.append(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), motion.t(200));
      }, motion.t(2000));
    },
    // Overflow menu: archive / unarchive the editing task (can't be completed anymore). Archive is a
    // terminal action — open edits land first, then the composer closes so it's visibly gone from the list; the undo
    // banner ("Archived task" + Undo) is the single truthful confirmation, so no extra toast.
    async toggleArchive() {
      const id = this.editing, t = this.byId.get(id), d = this.draft; if (!t || !await this._saveOpenEdits(d)) return;
      await this.archive(id, !t.archived_at, ok => { if (ok) { if (this._live(d)) this.closeComposer(true); }
        // ceiling: a save closes the composer, so a failed archive after one closes then reopens it — keep it open once a save can stay open
        else if (!this.composer.open || this._closingComposer) this.editTask(this.byId.get(id)); });   // the save closed it: the failure reopens it, edits saved — not over another composer
    },
    // Archive cascades as completion does: the open tasks inside go with it, after the same ask; done ones stay done. One store
    // write stamps them all with one instant, and that instant is what Unarchive reads back: it reopens only the rows under it
    // carrying it, never one archived on its own (another instant). One ⌘Z step either way.
    archive(id, val, then = () => {}) {
      const t = this.byId.get(id); if (!t) return;
      const kids = descendantIds(this.tasks, id, this._taskIdx().kids).slice(1).map(x => this.byId.get(x)).filter(k => cascades(t, k, val));
      const ids = [id, ...kids.map(k => k.id)], what = this.isOverviewProject(t) ? 'project' : 'task';
      let wrote;
      const set = async () => !!(wrote = await this.store.tasks.setArchived(ids, val));
      // Unarchive keeps the dates that passed meanwhile (user, tweak-11a: "the dates are still valuable information to understand the timeline
      // of the project"); its card offers clearing them, the open rows' past date-items re-read on the click: the card lingers 8s
      const passed = () => (wrote || []).map(x => this.byId.get(x)).filter(k => k && !k.completed_at && !k.archived_at)
        .map(k => this._siOf(k.id)).filter(si => si && si.date < isoDate(new Date()));
      const dates = n => `${n} passed date${n === 1 ? '' : 's'}`;
      const clear = () => { const ops = passed().map(si => ({ kind: 'remove', target: 'scheduleItem', id: si.id })); if (ops.length) this.perform(`Cleared ${dates(ops.length)}`, { kind: 'composite', target: 'scheduleItem', ops }); };
      const actions = () => { const n = val ? 0 : passed().length; return n ? [{ label: `Clear ${dates(n)}`, fn: clear }] : []; };
      const run = async () => then(await this._journalRowChange((val ? 'Archived ' : 'Unarchived ') + what, 'task', ids, set, { only: () => wrote, actions }));
      if (!val || !kids.length) return run();
      this.askConfirm({ message: 'Archiving this will also archive:', bodyHtml: this._sweepHtml(kids), confirmLabel: 'Archive all', onConfirm: run });
    },
    // Mark all checklist items done (inside the completion's fx snapshot, so undo takes it back).
    // Returns false if the store update failed — caller aborts setCompleted on failure to stay atomic.
    // Skips a repeating task: setCompleted advances its occurrence, which unticks the list, instead of closing it.
    async _checkAllItems(id) {
      const t = this.byId.get(id); const cl = t?.checklist;
      if (!cl?.length || inNotes(t) || cl.every(c => c.done)) return true;   // a note never completes (an old entry can name a row made a note since)
      if (recActive(t.recurrence) && !t.completed_at) return true;
      return !!await this.store.tasks.update(id, { checklist: cl.map(c => ({ ...c, done: true })) });
    },
    // silent: completion is a 100×/day action. The entry is the reverse, carrying the FULL completion delta (target + swept
    // dependents + auto-completed parents + the prior checklist mix) so ⌘Z reverses every affected row, not just id.
    async applyComplete(id, done) {
      await this.perform(done ? 'Completed' : 'Uncompleted', { kind: 'complete', target: 'task', mode: 'forward', fwd: { id, done } }, { silent: true });
    },

    // --- Relations ---
    // The edited task's edges and the composer pickers' pools, cached per (data-version × edited task): the pickers, the wells and the chips all read them,
    // and a scan for the inverse 'blocks' edge costs ~1s at 20k tasks — per render, and again per keystroke.
    _relIdx() {
      return _memo(_relMemo, this._rowV + '|' + this.editing, () => {
        const e = this.editingTask(), inv = this._taskIdx().inv.get(this.editing) ?? [];
        // 'blocks' = the INVERSE direction (this task sits in the other's blocked_by) — shown so it's managed from here too
        return { rels: [...(e?.blocked_by ?? []).map(id => ({ id, type: 'blocked_by' })), ...inv.map(id => ({ id, type: 'blocks' })), ...(e?.relates ?? []).map(id => ({ id, type: 'relates' }))] };
      }, 1);
    },
    relationCandidates() {
      // cap at 40; narrows as you type. The pool is built on the picker's first use, not on every composer open.
      return _memo(_candMemo, this._rowV + '|' + this.editing + '|' + this.pickerQ, () => { const r = this._relIdx(), def = this.store.defaultProject();
        return this.pickerMatches(r.open ??= this.tasks.filter(t => t.id !== this.editing && t.id !== def && !r.rels.some(x => x.id === t.id))).slice(0, 40); }, 1);
    },
    relChips() { return this._relIdx().rels; },
    // A row's blocker chip opens its task as the palette does, a file chip its file; a rolled one lists its kind (soc-2 c).
    relsFor: null,   // { taskId, kind }: the rolled chip whose list is open
    rowRelOpen(t, chip) {
      const kind = chip.dataset.kind;
      if (!chip.classList.contains('rolled')) return kind === 'file' ? this.openFileId(chip.dataset.rel) : this.openTaskById(chip.dataset.rel);
      this.relsFor = { taskId: t.id, kind };
      this.togglePop('rels', chip);
    },
    relsList() { const t = this.byId.get(this.relsFor?.taskId); return !t ? [] : this.relsFor.kind === 'file' ? t.attachments ?? [] : openBlockers(t, this.byId); },
    relItemName(id) { return this.relsFor?.kind === 'file' ? this.fileName(id) : this.byId.get(id)?.content; },
    fileName(id) { return this.files[id]?.name ?? 'File unavailable'; },
    openFileId(id) { return this.files[id] ? this.openFile(this.files[id]) : this.notify('File unavailable'); },
    // Remove to the Bin: the id leaves the task (Undo and the Bin put it back by id, recovery.js guardedFields); the file itself stays.
    removeAttachment(taskId, id) {
      const t = this.byId.get(taskId);
      return t && this._journalRowChange('Removed ' + this.fileName(id), 'task', taskId, () => this.store.tasks.update(taskId, { attachments: t.attachments.filter(x => x !== id) }), { bin: true });
    },
    attachFiles(list) {
      if (!this.session) return this.toast('Sign in to attach files');
      this.addFiles(list, this.attach, this.editing ? { taskId: this.editing } : { sid: this._draftSid, taskId: null });
    },
    composerPaste(e) {   // capture: a pasted file never reaches the title's or a row's own paste; text does
      if (!this.composerDrop() || !e.clipboardData?.files.length || e.clipboardData.types.includes('text/plain')) return;   // Excel and Word put a picture of copied text beside it
      e.preventDefault(); e.stopPropagation();
      this.attachFiles(e.clipboardData.files);
    },
    composerFiles() { return this.attach.filter(f => this.editing ? f.taskId === this.editing : !f.taskId && f.sid === this._draftSid); },
    retryFile(f) { return f.row ? this._attachFiles(f.taskId) : this._upload(f); },
    // Every landed file of the task's in one write. Failed, they stay pending: Retry re-sends the ids, never the files.
    // added: the add's own follow-up write (its Undo removes the task), so no entry of its own.
    // ceiling: a read-modify-write of the cached list; another device's attach in between is overwritten (server-side append if it bites)
    _attachFiles(taskId, added) { return this._serial('attach:' + taskId, () => this._attachNow(taskId, added)); },   // two uploads landing together write in turn
    async _attachNow(taskId, added) {
      const files = this.attach.filter(f => f.taskId === taskId && f.row), t = this.byId.get(taskId);
      if (!files.length || !t) return true;
      const ids = [...new Set([...t.attachments ?? [], ...files.map(f => f.row.id)])], write = () => this.store.tasks.update(taskId, { attachments: ids });
      const label = files.length > 1 ? `Attached ${files.length} files` : 'Attached ' + files[0].name;
      const row = added && await write();
      if (row && !this._patchTask([row])) await this._reloadFor('task');   // the next write in the queue reads this one's list
      const ok = added ? !!row : await this._journalRowChange(label, 'task', taskId, write, { fail: null });
      if (ok) this.attach = this.attach.filter(f => !files.includes(f));
      else {
        for (const f of files) f.failed = true;
        this.notify(added ? `Added “${t.content}” without its files` : 'File not attached', { actions: [{ label: 'Retry', fn: () => this._attachFiles(taskId) }] });
      }
      return ok;
    },
    // A linked task in a well is still a TASK: it gets the same row the picker above it uses, so its state
    // (done, blocked, its areas, which project it's in) is readable without leaving the pop.
    relLine(id) { const t = this.byId.get(id); return t ? this.taskLine(t) : ''; },
    relTypeLabel(type) { return { blocked_by: 'blocked', blocks: 'blocks', relates: 'relates' }[type]; },
    editingTask() { return this.byId.get(this.editing) ?? null; },
    // Typed "needs / needed by" pills on a saved task, journaled into its save's entry (ops).
    // Same store call as the relation panel — one way a dependency gets written.
    async _applyDraftLinks(id, d, ops) {
      const lost = new Set(), link = (a, b, what) => this._journalRowChange('Saved task', 'task', a, () => this.store.tasks.link(a, b), { ops, fail: null }).then(ok => ok || lost.add(what));
      for (const o of d.needs || []) await link(id, o, 'needs');
      for (const o of d.neededBy || []) await link(o, id, 'needed by');
      if (lost.size) this.toast(`Saved “${d.content}” without its ${[...lost].join(', ')}`);
    },
    async addRelation(otherId, type) { if (otherId && await this._relChange('Added relation', 'link', otherId, type)) this.pickerQ = ''; },
    async dropRel(e, type) { const id = e.dataTransfer.getData('text/plain'); if (id && this.byId.has(id)) await this.addRelation(id, type); },
    removeRelation(otherId, type, from) { return this._relChange('Removed relation', 'unlink', otherId, type, from); },
    // 'blocks' is blocked_by on the OTHER task (swapped direction). 'relates' is symmetric, and the store mirrors a
    // relates write to the partner — so one row's diff undoes both sides.
    _relChange(label, verb, otherId, type, from = this.editing) {
      const [id, linkId] = type === 'blocks' ? [otherId, from] : [from, otherId];
      return this._journalRowChange(label, 'task', id, () => this.store.tasks[verb](id, linkId, type));
    },

    // --- Calendar (continuous Month · page-per-week Week/Day — iOS/macOS-Calendar-style) ---
    listView() { return this.surface === 'lists'; },   // task-list views (all/backlog/project/area/filter) live on the Lists surface
    // Open = not completed/archived/a project/a parent. Callers append their own clauses (block-fill adds unscheduled/overdue).
    _openLeaf(t) { return !t.completed_at && !t.archived_at && placeable(t) && !this.hasChildren(t.id); },
    async loadEvents() { const ev = await this.store.events.list(); _calDataV++; this.events = ev; },
    // must bust _calDataV too — without it a block added between two event loads never reaches the memo, and the
    // calendar keeps drawing the previous set until some unrelated task/event change happens to bump the sig
    async loadBlocks() { const bl = await this.store.blocks.list(); _calDataV++; this.blocks = bl; },
    _clDate() { return new Date(this.clAnchor + 'T00:00'); },
    // Where the view is heading, `dir` periods on: while a scroll is live, its target (a page turn's tween, a month step's
    // glide) or position; else clAnchor, which each landing (_clLand, _clMSettle, a tween's arrival) syncs. Every action
    // reads this, never clAnchor — a key beats the land. Month keeps the picked day: clamped to a short month, never shrunk by it.
    _clAt(dir = 0, live = this.clScrolling) {
      const a = this._clDate();
      if (this.clView === 'month') {
        const ym = (live ? this._clFocusAt(this._clMTo ?? _clMTop) : a.getFullYear() * 12 + a.getMonth()) + dir, y = Math.floor(ym / 12), m = ym % 12;
        return new Date(y, m, Math.min(this._clMPick(), new Date(y, m + 1, 0).getDate()));
      }
      const at = live ? this._periodDate(motion.running('clTween') ? Math.floor(this._clTo) : this.clPos.idx) : a;
      at.setDate(at.getDate() + dir * this._periodSpan());
      return at;
    },
    _clWeekStart(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; },   // Sunday
    // threadless items go WARM, never grey — grey is what made scheduled tasks read as disabled
    clItemColor(it) { return it.color || (it.kind === 'task-deadline' ? 'var(--deadline)' : it.kind === 'task-due' ? 'var(--accent-info)' : 'var(--accent)'); },
    _clTime(s) { return this.clAgTime(this._clMin(s)); },
    _monthLabel(d) { return this._lbl('m|' + (d.getFullYear() * 12 + d.getMonth()), () => d.toLocaleDateString([], { month: 'long', year: 'numeric' })); },
    _weekIdx(d) { return Math.round((this._clWeekStart(d).getTime() - CL_EPOCH.getTime()) / 604800000); },
    _weekDate(idx) { const d = new Date(CL_EPOCH); d.setDate(d.getDate() + idx * 7); return d; },
    clAnchorIdx() { return this._weekIdx(this._clDate()); },
    // Row height so exactly 6 weeks fill the page (macOS); rendered-row count = visible + buffer each side.
    clRecalc() {
      this._clM = null;   // BEFORE the read: this is the resize path, so the cached height is the stale one
      const h = this._clVH();
      this._clSize = document.documentElement.clientWidth + 'x' + h;   // what this fit is for: _clResized skips a resize that keeps it
      // phone floor 78: a busy cell keeps two chips (64 left one). Live MQ, not `narrow`: a resize event lands before the MQ change that flips it
      this.clRowH = Math.max(PHONE_MQ.matches ? 78 : 64, Math.floor((h - CL_BAR - CL_HEAD) / 6));
      this.clVisCount = Math.ceil(h / this.clRowH) + CL_BUFFER * 2;
      this.clVisStart = Math.max(0, this.clAnchorIdx() - CL_BUFFER);
      // computed from styles so it's right on every breakpoint (mobile uses a smaller title font)
      const bar = this.$root.querySelector('.cl-bar'), p = this.$root.querySelector('.cl-period');
      if (bar && p) { const ps = getComputedStyle(p); this._clBarY = bar.offsetHeight - parseFloat(ps.paddingBottom) - parseFloat(ps.fontSize); }
    },
    clTotalH() { return CL_TOTAL_WEEKS * this.clRowH; },
    // A resize changes only the SCALE: re-measure once, then repaint at the SAME place — the month row (in rows, not
    // px: scrollTop is px) or clPos (in periods, already scale-free) — this frame. Hidden, it only marks Plan stale:
    // address-bar collapse and a window-edge drag fire ~60/s, each a forced layout + repaint no one sees. Showing
    // Plan re-runs it ONCE (x-effect on .calendar).
    _clResized() {
      if (this._clHidden()) return void (this._clStale = true);
      this._clStale = false;
      this._clM = null;   // the port still moves: #shell is 100dvh
      // The phone URL bar resizes mid-scroll with clientWidth/Height unchanged: nothing to refit, and a month re-snap would kill the glide.
      if (this._clSize === document.documentElement.clientWidth + 'x' + this._clVH()) return;
      const el = this.$refs.clMonth, row = this.clView === 'month' && el && this.clRowH ? el.scrollTop / this.clRowH : null;
      this.clRecalc();
      if (row != null) this.clScrollToAnchor(8, row);
      else if (this.clView !== 'month') { this.clRecalcPages(); this._clSetPos(this.clPos.idx, this.clPos.frac); }
    },
    clOpenCalendar() {
      this.clRecalc();
      if (!this._clResize) { this._clResize = true; window.addEventListener('resize', () => this._clResized()); }
      if (this.clView === 'month') this.clScrollToAnchor(); else if (this.clView === 'week' || this.clView === 'day') { this.clRecalcPages(); queueMicrotask(() => this._clScrollToPeriod()); }   // mounts on a surface switch: not $nextTick
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
    clSetView(v, instant, frac) {   // frac: the hour to open at (_clScrollToPeriod)
      this._clSaveName();
      if (this.clView === 'month') this._clMAnchor(); else this.clAnchor = isoDate(this._clAt());   // a picked week/day sets clAnchor after
      if (this.clScrolling) { clearTimeout(_clScrollT); this._clMSettle(); }   // the switch is the land: left running, a month scroll's flag read the new view's period as live
      this._clWeekDropped = null;   // the week hour a phone width dropped; any switch, the user's or the width's, settles the view: widening restores nothing
      if (v === 'week' && this.narrow) v = 'day';
      // reset zoom to fit, never to 0 — a zero hour height makes clPeriodH 0, and a divide by it has no position
      this._withTransition(() => { this._clHalt(); this.clZoom = 1; this.clHourH = this._clFitHour(); this.clView = v; },
        () => { if (v === 'month') this.clScrollToAnchor(); else if (v === 'week' || v === 'day') { this.clRecalcPages(); this._clScrollToPeriod(8, frac); } this._clSettle(); }, instant);
    },
    _withTransition(setFn, afterFn, instant, every) {
      // Switches must not be able to land out of order: _vtSeq ensures a stale callback never applies over a newer one.
      // A step is relative (`every`): each lands, superseded or not — dropped, a held Shift+↓ ×12 travelled 1–11 weeks.
      const seq = this._vtSeq = (this._vtSeq || 0) + 1;
      let ran = false;
      this.clVT = true;   // names go on for the capture only — see the CSS note on permanent layer promotion
      // microtask flushes, not $nextTick: Alpine holds that while any x-transition starts, until a frame — and no frame
      // comes while this update callback runs, so a surface switch landing mid-morph froze the page for Chrome's 4s timeout
      const flush = () => new Promise(queueMicrotask);
      const run = async () => { if (ran || (!every && seq !== this._vtSeq)) return; ran = true; setFn(); await flush(); afterFn?.(); await flush(); };
      // hidden tabs abort (InvalidStateError) — guard with visibilityState
      if (!instant && document.startViewTransition && document.visibilityState === 'visible' && motion.scale) {   // zero motion: no cross-fade either
        const t = document.startViewTransition(run);
        // settle: clear CSS names once the animation finishes; also call run() in case the update callback was skipped.
        // A superseded transition settles as its successor starts — the names belong to the successor then.
        const settle = () => { if (seq === this._vtSeq) this.clVT = false; run(); };
        t.finished.then(settle, settle); t.updateCallbackDone.catch(run); t.ready.catch(() => {});
        setTimeout(run, 250);   // fallback: apply state if callback never fires; seq-guarded, never resets clVT
      } else { this.clVT = false; run(); }
    },

    // --- read-model (module scope — never triggers reactivity) ---
    _clGroup(fromIso, toIso) {
      // Register the reactive deps BEFORE the memo can short-circuit: on a hit we would otherwise return
      // without ever reading events/tasks, the render effect would record no dependency on them, and adding or
      // completing something would not repaint until an unrelated change happened to force it.
      void this.events; void this.tasks; void this.scheduleItems; void this._rowV;   // _rowV: a patched task changes in place
      // clPages re-derives every tick — cache to avoid full-set scans
      return _memo(_groupMemo, fromIso + '|' + toIso + '|' + _calDataV, () => {
        const map = {}, add = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
        for (const it of calendarItems(this.events, this.tasks, fromIso, toIso, this._placedMap())) {
          const s = it.start.slice(0, 10), end = it.end || it.start, e = !it.allDay && end.endsWith('T00:00') ? add(end.slice(0, 10), -1) : end.slice(0, 10);
          if (e <= s) (map[s] ||= []).push(it);
          // a multi-day all-day item (event or task band) explodes into connected segments; a timed one is filed on each day, _clPack slices it
          else for (let day = s < fromIso ? fromIso : s; day <= e && day <= toIso; day = add(day, 1))
            (map[day] ||= []).push(it.allDay ? { ...it, spanStart: day === s, spanEnd: day === e } : it);
        }
        return map;
      }, 12);
    },
    // Grouped over the window snapped OUT to 8-week bounds: a fling slides clVisStart a row at a time, and an
    // exact-window key re-ran calendarItems over every event and task on each slide; now ~one in eight misses.
    _clVisMap() {
      const a = this.clVisStart & ~7, b = a + this.clVisCount + 8;   // b follows a, so only a crossing moves the key
      return this._clGroup(isoDate(this._weekDate(a)), isoDate(this._weekDate(b)));
    },

    // --- MONTH: virtualized week rows in a fixed-height spacer (constant scroll height, no reflow; buffer prevents blanks on fast flings) ---
    // Rows are MEMOIZED per index. Scrolling one row shifts the window by one, but rebuilding every row's day
    // objects handed Alpine fresh identities for all of them, so every cell's bindings re-ran: 1585 DOM
    // mutations for a ONE-row shift, ~27k across a single fling. Returning the identical object makes x-for's
    // scope write a no-op, so only the row that actually entered costs anything. The signature carries
    // everything a row's contents depend on — the data and today. Never the height: a row is placed by --rowh in CSS
    // (top = key × --rowh), so a resize moves every row in one style pass and rebuilds none. A per-row px top left
    // rows a resize didn't re-bind at their old tops — overlapping, the viewport blank.
    clWeeks() {
      if (this.clView !== 'month' || this._clHidden()) return _clWkOut;   // hidden: keep the last rows; showing re-runs this
      if (!this.clRowH) this.clRecalc();
      const byDay = this._clVisMap(), out = [];
      // NOT keyed on clFocusYM: the dominant month changes at every month boundary (~4× a fling) and the only
      // thing that depends on it is the out-of-month fade. Cells carry their own `ym` and the template compares
      // it, so a focus change costs one class binding per cell instead of rebuilding every row.
      const todayIso = this._nowDay, narrow = this.narrow, sig = _calDataV + '|' + todayIso + '|' + narrow;
      if (_clWkSig !== sig || _clWkCache.size > 200) { _clWkSig = sig; _clWkCache.clear(); }   // size: a long scroll would otherwise keep every row it ever passed
      const end = Math.min(CL_TOTAL_WEEKS, this.clVisStart + this.clVisCount);
      for (let idx = Math.max(0, this.clVisStart); idx < end; idx++) {
        let row = _clWkCache.get(idx);
        if (!row) {
          const ws = this._weekDate(idx);
          const cols = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(ws); d.setDate(d.getDate() + i);
            const items = byDay[isoDate(d)] || [];
            return { d, bands: items.filter(it => it.spanStart !== undefined), rest: items.filter(it => it.spanStart === undefined) };
          });
          // a multi-day band keeps one slot across the row (week's lanes); a day it skips holds a pad there, or a single-day item
          const lane = new Map(this._clWeekBands(cols).map(b => [b.it.kind + b.it.id, b.row]));
          const days = cols.map(({ d, bands, rest }, i) => {
            const iso = isoDate(d), items = [];
            for (const it of bands) items[lane.get(it.kind + it.id)] = it;
            // phone (decision #65): tasks before daily items, and an overflowing day gives its third slot to "+N" — two-line chips don't fit 3 + "+N"
            const singles = narrow ? tasksFirst(rest) : [...rest];
            for (let k = 0; k < items.length; k++) items[k] ||= singles.shift() || { pad: true, kind: 'pad', id: k, title: '' };
            items.push(...singles);
            const shown = narrow && items.length > 3 ? 2 : 3;
            return {
              iso, day: d.getDate(), today: iso === todayIso, label: DAY_NAME.format(d), first: i === 0,
              weekend: i === 0 || i === 6, ym: d.getFullYear() * 12 + d.getMonth(),
              mlabel: d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short' }) : '',
              items, shown, more: items.slice(shown).filter(it => !it.pad).length
            };
          });
          _clWkCache.set(idx, row = { key: idx, days });
        }
        out.push(row);
      }
      return _clWkOut = out;
    },
    // Thursday's month = dominant; shared by scroll handler + jumps for consistent label
    _topMonthLabel(idx) { const d = this._weekDate(idx); d.setDate(d.getDate() + 3); return this._monthLabel(d); },
    _monthFirstIdx(d) { return this._weekIdx(new Date(d.getFullYear(), d.getMonth(), 1)); },   // week index of a month's 1st
    // The viewport line below which a title rides coupled to the body (a band); at or above it the overlay flies
    // it over the header into the bar. That fly runway is one week row in month; in day/week the incoming title
    // rises from the bottom edge instead, because a whole period of runway would be a mile.
    _clZoneTop() { return this.clView === 'month' ? this._clHeadH() + (this.clRowH || 1) : this._clVH() - CL_FOOT; },
    // Body bands: month titles glued to the grid (top=idx*rowH), only BELOW the zone. clZoneTitles picks them up overhead.
    // The month zone is one row deep, so rows through top+1 are in it: that depends on the TOP ROW alone, read off
    // clVisStart (top − CL_BUFFER), never the scrollTop — which re-ran this every scroll frame for an identical list.
    // ceiling: clVisStart clamps at 0, so in the first CL_BUFFER weeks (Jan–Mar 2000) bands below the zone go missing; a real top-row field if the epoch nears reachable dates
    clMonthBands() {
      if (!this.clRowH) this.clRecalc();
      const rowH = this.clRowH, out = [], end = Math.min(CL_TOTAL_WEEKS, this.clVisStart + this.clVisCount);
      for (let idx = Math.max(0, this.clVisStart + CL_BUFFER + 2); idx < end; idx++) {
        // A week holds at most one 1st: either it starts on one, or the month turns over inside it (so its last
        // day is already in the new month). Two Dates, not the seven a per-day scan built on every scroll event.
        const ws = this._weekDate(idx), we = new Date(ws); we.setDate(we.getDate() + 6);
        const first = ws.getDate() === 1 ? ws : we.getMonth() !== ws.getMonth() ? we : null;
        if (first) out.push({ name: this._monthLabel(first), top: idx * rowH - 34 });   // sits on the row above, clear of the 1st's label, as clZoneTitles hands it over
      }
      return out;
    },
    // Parallax clamp/shove/round shared by clZoneTitles and _periodZoneTitles.
    // Callers build list as [{name, vt}]; this applies the parallax, shoves overlaps, and filters.
    // LINEAR (not ease-out t*(2-t)): ease-out's zero slope at t=1 caused a visual "dip" at the band→overlay handoff.
    // `clear`: px a title keeps above its own start line in the runway — a week's riding all-day rail hangs just below
    // it, the outgoing week's deadline labels just above it. Never above the bar: there the rails are clipped under the head.
    _zoneLayout(list, head, zoneH, barY, clear = -Infinity, labelH = 46) {
      list.forEach(z => { z.y = z.vt <= head ? barY : Math.max(barY, Math.min(z.vt - clear, barY + (head + zoneH - barY) * ((z.vt - head) / zoneH))); });
      for (let i = list.length - 2; i >= 0; i--) list[i].y = Math.min(list[i].y, list[i + 1].y - labelH);
      // park out-of-zone titles at -999 instead of dropping them: the element must stay mounted so the
      // imperative positioner can bring it in mid-period without waiting for an x-for wake
      return list.map(z => ({ name: z.name, y: z.vt > head + zoneH || z.y <= -labelH ? -999 : Math.round(z.y), atBar: Math.abs(z.y - barY) < 3 }));
    },
    // `top` applied imperatively so it never lags. Membership follows the TOP ROW (clVisStart, as clMonthBands);
    // scrollTop is unreactive (_clMTop), so the template's x-for doesn't re-run every scroll frame for the same names
    // ceiling: clVisStart clamps at 0, so in the first CL_BUFFER weeks (Jan–Mar 2000) the titles don't re-list as you scroll; a real top-row field if the epoch nears reachable dates
    clZoneTitles() {
      if (!this.clRowH) return [];
      void this.clVisStart;
      const rowH = this.clRowH, head = this._clHeadH(), barY = this._clBarY != null ? this._clBarY : CL_BAR - 34 - 14, zoneH = this._clZoneTop() - head, scrollTop = _clMTop;   // barY = measured .cl-period top (matches the idle heading on every breakpoint)
      const top = this._weekDate(Math.max(0, Math.floor(scrollTop / rowH))); top.setDate(top.getDate() + 3);
      const list = [];
      for (let k = -2; k <= 1; k++) {   // one below the zone stays listed (_zoneLayout parks it): a mid-row entry needs it mounted
        const first = new Date(top.getFullYear(), top.getMonth() + k, 1);
        list.push({ name: this._monthLabel(first), vt: head + this._weekIdx(first) * rowH - scrollTop });
      }
      return this._zoneLayout(list, head, zoneH, barY, 34);   // 34: the .cl-mtitle line box, kept above the row that holds the 1st and its label
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
    _clFocusAt(scrollTop) {   // dominant month = the one at the vertical center of the grid → stays bright when idle
      const d = this._weekDate(Math.max(0, Math.floor((scrollTop + (this._clVH() - this._clHeadH()) / 2) / (this.clRowH || 1))));
      d.setDate(d.getDate() + 3);
      return d.getFullYear() * 12 + d.getMonth();
    },
    _clFocus(scrollTop) {
      this.clFocusYM = this._clFocusAt(scrollTop);
      if (!this.clFast) this.clDimYM = this.clFocusYM;
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
      const at = {}; for (const t of (list || (this.clView === 'month' ? this.clZoneTitles() : this._periodZoneTitles()))) at[t.name] = t;
      for (const el of box.children) { const t = at[el.dataset.name]; el.style.top = (t ? t.y : -999) + 'px'; el.classList.toggle('at-bar', !!t?.atBar); }   // no entry = not placeable yet; park it off-screen rather than leave it at a stale y
    },
    clMonthScroll(e) {
      // ONE scrollTop read, before any write: re-reading it after _clPositionZone's style writes forced a second
      // style+layout every scroll frame. (No rAF coalescing — scroll already fires once per frame, and the titles
      // must move THIS frame.)
      const y = e.target.scrollTop, topIdx = Math.max(0, Math.floor(y / (this.clRowH || 1)));
      this.clVisStart = Math.max(0, topIdx - CL_BUFFER);
      _clMTop = y;
      const zt = this.clZoneTitles();    // ONE layout pass, shared by the heading and the positioner — same rule as _clSetPos
      this._clScrollState(y, zt);
      this._clPositionZone(zt);   // sync: place the over-header titles THIS frame (reactive :style lags a frame → teleports on fast scroll)
      const t = performance.now();
      // our OWN settle glide: it still virtualizes, but it is not a gesture — re-lighting the chrome here is a flicker.
      // It still POSTPONES the settle: a ↓/Today step inside this window otherwise let a pending week-snap fire
      // mid-step and round it back to where it started.
      if (t < (this._clMGlide || 0)) { clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this._clMSettle(), motion.t(600)); return; }
      // TWO chrome states landing at different moments: the out-of-month DIM comes back as soon as the glide
      // slows to a crawl, the month band/title text holds until the scroll has STOPPED. Both are ONE-WAY per
      // scroll session (only _clMSettle re-arms them), because every rate gate we tried strobed — a decaying
      // glide jitters across any threshold, and the browser hands a wheel over in bursts that dip and spike.
      // dt is capped because speed means "distance moved in the last frame-ish window": an event's raw gap
      // spans the IDLE time before the gesture, so a coalesced 1038px jump read 0.33px/ms — a crawl.
      const dt = Math.min(t - (this._clMSt || 0), 100), v = Math.abs(y - this._clMSy) / dt;
      // phantom native scroll from an el.scrollTop assignment — position unchanged; skip the chrome update. `=== 0`,
      // never `!v`: the first sample is NaN (no previous position) and must record one, or no scroll ever lights.
      if (v === 0) return;
      if (!this._clMDone) {
        if (v > CL_MONTH_SLOW * CL_MONTH_WAKE) this._clMRest = false;
        else if (v <= CL_MONTH_SLOW) { this._clMRest = true; this._clMDone = true; }
      }
      this.clFast = !this._clMRest;
      if (!this.clFast) this.clDimYM = this.clFocusYM;   // the dim lands on the month in view, not the one held at lift-off
      this.clScrolling = true;
      this._clMSy = y; this._clMSt = t;
      clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this._clMSettle(), motion.t(600));   // backstop for a scroll whose scrollend never comes
    },
    // @scrollend, DEBOUNCED: a wheel's notches each END their own scroll, so settling on the bare event blinked
    // the month text off and back on 21ms later. Only a stop that lasts is a stop.
    // A FINGER's scrollend is final (it fires once the finger is up and the fling spent), so a touch lands flush
    // right then — waiting out the settle parked the grid off-row for a visible beat before it moved again.
    clMonthSnap() { if (this._clMTouch) this._clMFlush(); clearTimeout(_clScrollT); _clScrollT = setTimeout(() => this._clMSettle(), motion.t(CL_MONTH_SETTLE)); },
    // The settle drops the chrome, re-arms the dim for the next scroll — and snaps the grid to a week boundary
    // OURSELVES. CSS scroll-snap can only do this by arresting the fling mid-flight (it cut a 2400px trackpad
    // fling to 9px); doing it here, after the scroll has stopped, keeps the momentum free AND lands flush.
    _clMSettle() {
      this.clScrolling = false; this.clFast = false; this.clDimYM = this.clFocusYM; this._clMRest = true; this._clMDone = false;
      if (this.clView === 'month') { this._clMAnchor(0, true); this._clTabInView(); }
      this._clMFlush();
    },
    // clAnchor → _clAt, remembering the picked day: _clMDay outlives a short month's clamp while clAnchor is ours
    _clMPick() { return this._clMDay?.iso === this.clAnchor ? this._clMDay.day : this._clDate().getDate(); },
    _clMAnchor(dir = 0, live) { const day = this._clMPick(); this._clMDay = { iso: this.clAnchor = isoDate(this._clAt(dir, live)), day }; },
    _clMFlush() {
      const el = this.$refs.clMonth, h = this.clRowH;
      if (!el || !h || this._clMFinger) return;   // a RESTING finger stops the scroll and so trips the settle; its snap glided the grid out from under it
      const to = Math.round((this._clMTo ?? el.scrollTop) / h) * h;   // our glide still under way lands where it is GOING: a starved frame past the settle's wait rounded a ↓ back to its start
      if (Math.abs(to - el.scrollTop) < 1) return void (this._clMTo = null);   // landed: the target is spent here, not at scrollend (a glide can end short of it). 1px off still glides: a jump made in a glide's last frame rests there. A 0px glide would still fire scroll events
      this._clMGlide = performance.now() + motion.t(700);   // this glide is ours; clMonthScroll must not read it as a gesture
      el.scrollTo({ top: to, behavior: this.reduceMotion() ? 'auto' : 'smooth' });
    },
    // …and the hand always wins: a smooth scrollTo keeps animating THROUGH new input, so it fought anyone who
    // scrolled during the settle. Any real input aborts the glide (an instant scroll to where we
    // already are cancels the animation) and hands the scroll straight back.
    clMonthTake(e) {
      const ours = this._clMGlide || this._clMTo != null;   // a settle glide, or a step/↓ still gliding to its target
      this._clMFinger = this._clMTouch = e.type === 'touchstart' || e.pointerType === 'touch'; this._clMTo = null;
      if (!ours) return;
      this._clMGlide = 0;
      const el = this.$refs.clMonth; if (el) el.scrollTo({ top: el.scrollTop, behavior: 'auto' });
    },
    clScrollToAnchor(tries = 8, row = null) {   // row: a fractional week index to hold instead of the anchor's month
      const el = this.$refs.clMonth; if (!el) return;
      // A zero-height element SILENTLY IGNORES scrollTop, and the Plan surface can still be off-screen when a
      // view switch lands here (clSetView runs this in its after-callback). Nothing re-runs it, so the month
      // stayed parked at row 0 while clVisStart pointed at the anchor — a grid rendered outside its own
      // window, i.e. empty. Retry until layout exists; same guard _clScrollToPeriod already carries.
      if (!el.clientHeight && tries > 0) return void requestAnimationFrame(() => this.clScrollToAnchor(tries - 1, row));
      if (!this.clRowH) this.clRecalc();
      const target = row ?? this._monthFirstIdx(this._clDate()), top = Math.round(target * this.clRowH);
      this.clVisStart = Math.max(0, Math.floor(target) - CL_BUFFER);
      // A glide of ours runs on past the jump on slow frames: the jump takes its target, so the settle lands it. No glide, no
      // target; a wheel, touch, pointer (clMonthTake) or browser key (onKey) clears it, so the user's own scroll is never pulled back.
      // ceiling: on a slow device the old glide still swings off the jumped-to month before the settle glides it back — cancel it at the jump if that swing is reported.
      _clMTop = top; if (this._clMTo != null) this._clMTo = top;
      this._clScrollState(top);
      // seed the velocity sample FIRST: the jump's scroll event then reads v === 0 (ours), not a gesture that lights the chrome.
      // A microtask, not $nextTick: that waits a setTimeout, so a resize painted one frame of new --rowh at the old scrollTop — blank.
      queueMicrotask(() => { this._clMSy = top; el.scrollTop = top; this._clScrollState(top); this._clTabInView(); });
    },
    _clStepMonth() {
      const el = this.$refs.clMonth; if (!el) return this.clScrollToAnchor();
      if (!this.clRowH) this.clRecalc();
      el.scrollTo({ top: this._clMTo = Math.min(el.scrollHeight - el.clientHeight, Math.max(0, this._monthFirstIdx(this._clDate()) * this.clRowH)), behavior: this.reduceMotion() ? 'auto' : 'smooth' });
    },
    // A walk out of the rows in view scrolls the fewest whole rows, on clNudge's path, so the settle lands it flush.
    clWalkDay(n) {
      const d = new Date(this._clStop() + 'T00:00'); d.setDate(d.getDate() + n);
      this.clDayFocus = isoDate(d); this.clDayInView = null;
      const el = this.$refs.clMonth, h = this.clRowH, [at, rows] = this._clRowsInView(), idx = this._weekIdx(d);
      const top = Math.min(idx, Math.max(at, idx + 1 - rows));
      if (top !== at) el.scrollTo({ top: this._clMTo = top * h, behavior: this.reduceMotion() ? 'auto' : 'smooth' });
      this._clLandDay();
    },
    _clStop() { return this.clDayInView || this.clDayFocus || this._nowDay; },   // the month's one Tab stop, and where a walk starts
    // Focus follows the stop. A held arrow outruns the glide that draws the rows ahead, so its day lands once its row is drawn.
    _clLandDay() {
      const iso = this._clStop(), at = document.activeElement;
      if (at !== document.body && !at?.classList.contains('cl-date')) return;   // focus moved on (Tab, a dialog) stays there
      const cell = this.$refs.clMonth.querySelector(`.cl-date[aria-label="${DAY_NAME.format(new Date(iso + 'T00:00'))}"]`);
      if (cell) cell.focus({ preventScroll: true });
      else if (this._clMTo != null) requestAnimationFrame(() => iso === this._clStop() && this._clLandDay());   // our glide still drawing toward it
    },
    _clRowsInView() {   // [top row, whole rows on screen]
      const el = this.$refs.clMonth, h = this.clRowH;
      const band = PHONE_MQ.matches ? Math.max(0, el.getBoundingClientRect().bottom - document.querySelector('.canvas-dots').getBoundingClientRect().top) : 0;   // the phone's nav band covers the grid's foot; desktop's pill sits over its 6th row's empty bottom
      return [Math.round((this._clMTo ?? el.scrollTop) / h), Math.floor((el.clientHeight - CL_BAR - CL_HEAD - band) / h)];
    },
    // Set only where a scroll lands (settle, jump), never per frame: every day cell's tabindex reads it.
    _clTabInView() {
      if (!this.$refs.clMonth || !this.clRowH) return;
      // a focused day keeps the stop, so arrows walk from it — unless the stop moved off it (a walk outran its row, Today): focus follows
      if (this.$refs.clMonth.querySelector('.cl-date:focus')) return this._clLandDay();
      const idx = this._weekIdx(new Date((this.clDayFocus || this._nowDay) + 'T00:00'));   // a rendered stop is reachable: Tab scrolls it into view
      this.clDayInView = idx >= this.clVisStart && idx < this.clVisStart + this.clVisCount ? null : isoDate(this._weekDate(this._clRowsInView()[0]));   // first day in view: where reading, and Tab, enter a grid
    },
    clOpenWeekRow(idx) { this.clSetView('week'); this.clAnchor = isoDate(this._weekDate(idx)); },   // tap a week → expand

    // --- Continuous day/week timeline. NO SCROLLER: clPos is the position and the timeline is painted at
    // translateY(-clPosOff · --ph). Month keeps its native scroller — a bounded grid with no zoom has nothing
    // to fight — which is why _clMTop exists and means month, and only month. ---
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
    clPeriodH() { return this.clView === 'day' ? this._clDayH() + CL_FOOT : 24 * (this.clHourH || 40); },   // a day also spans the nav band, so the NEXT day never parks under the nav
    // one page = the scroller's VISIBLE area: .cl-pages already reserves the chrome with padding-top, so a
    // parked day starts below the header without the agenda insetting itself a second time
    _clDayH() { return Math.max(320, this._clVH() - this._clHeadH() - CL_FOOT); },
    // Pinned head cells: weekday names in month; weekday + DATE of the period currently on top in week view.
    // Dates can't ride the block — in a continuous timeline they'd scroll out of sight almost immediately.
    clHeadCells() {
      if (this.clView !== 'week') return WEEKDAYS.map(n => ({ key: n, name: n }));
      const ps = this._periodDate(this.clPos.idx), todayIso = this._nowDay;
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d);
        return { key: iso, name: WEEKDAYS[d.getDay()], day: d.getDate(), today: iso === todayIso, weekend: d.getDay() === 0 || d.getDay() === 6 };
      });
    },
    clDayLabel(iso) { return this.dayNotes.find(d => d.date === iso)?.label || ''; },
    // B·V3: the weekday slot IS the name field. An empty name deletes the row — a day with no name leaves no trace.
    // A failed write puts the field back to what's stored, so it never shows a name that isn't saved.
    async clSetDayLabel(iso, el) {
      const label = el.value.trim(), row = this.dayNotes.find(d => d.date === iso);
      if (label === (row?.label || '')) return;
      const ok = !row ? await this.perform('Named a day', { kind: 'create', target: 'dayNote', fields: { date: iso, label } })
        : label ? await this._journalRowChange('Renamed a day', 'dayNote', row.id, () => this.store.dayNotes.update(row.id, { label }))
        : await this.perform('Cleared a day name', { kind: 'delete', target: 'dayNote', id: row.id }, { bin: false });
      if (!ok) el.value = this.clDayLabel(iso);
    },
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
    // the head is about to re-key or go: blur a focused day name so it saves (no browser blurs a REMOVED field)
    _clSaveName() { document.querySelector('.cl-wh-n:focus')?.blur(); },
    _clSetPos(idx, frac) {
      const t = Math.max(0, Math.min(this._periodTotal() - 0.0001, idx + frac)), i = Math.floor(t);
      const crossed = i !== this.clPos.idx;
      if (crossed) {
        this._clSaveName();
        this.clPos.idx = i;
      }
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
      const from = this.clPos.idx + this.clPos.frac, to = this._clTo = Math.max(0, Math.min(this._periodTotal() - 0.0001, idx + frac)), called = performance.now();
      let t0 = 0;   // the clock starts at most a frame before the first frame drawn: a slow render after the input never eats the turn's opening
      // only an ARRIVING period stages in — not a nudge or a spring-back. ↓'s tween has no scroll land behind it, so the anchor
      // follows the page here even when THIS turn didn't cross: a held ↓'s crossing nudge is superseded before it lands.
      const arrive = () => {
        if (Math.floor(to) !== this._periodIdx(this._clDate())) this.clAnchor = isoDate(this._periodDate(Math.floor(to)));
        if (Math.floor(to) !== Math.floor(from)) this._clSettle();
      };
      if (this.reduceMotion()) {   // the turn lands at once; an arriving period still fades in
        motion.stop('clTween'); this._clSetPos(idx, frac); arrive();
        return;
      }
      ms = motion.t(ms);
      motion.run('clTween', () => {   // keyed run: a second turn supersedes, never races
        const now = performance.now(); t0 ||= Math.max(called, now - 16);   // not the frame's timestamp: on a busy thread it predates this step by the render
        const p = Math.max(0, Math.min(1, (now - t0) / ms)), at = from + (to - from) * EASE_OUT(p);
        this._clSetPos(Math.floor(at), at - Math.floor(at));
        if (p >= 1) arrive();
        return p < 1;
      });
    },
    _clHidden() { return this.surface !== 'plan' && !this.dragging; },   // a surface swipe shows Plan before it's current
    clRecalcPages() {
      this._clM = null;   // the scroller's height can have changed (view switch, resize) — re-measure once
      this.clHourH = Math.max(18, Math.round(this._clFitHour() * this.clZoom));
      this.clPVisCount = Math.ceil((this._clVH() - this._clHeadH()) / this.clPeriodH()) + 2;
      this.clPVisStart = Math.max(0, this.clPos.idx - 1);
    },
    // Pure per-day column (shared by clBlocks and the Peek Pane) — touches NO Plan scroll state. Scale-free: _clPack lays it out.
    _clColumn(iso, items = (this._clGroup(iso, iso)[iso] || [])) {
      const d = new Date(iso.slice(0, 10) + 'T00:00'), todayIso = isoDate(new Date());
      return { iso, day: d.getDate(), today: iso === todayIso, past: iso < todayIso, weekend: d.getDay() === 0 || d.getDay() === 6, items, blocks: this._dayBlocks(iso), ...this._clSplitDay(items), cleared: this._clCleared(items) };
    },
    // The scale-dependent part (tier, stacking read px per minute). H-presence: a block wholly covering something
    // shorter in its PLANNED span HOLDS it — it leaves the pack for the layer behind. Everything else (blocks holding
    // nothing included) lane-packs with events/tasks as peers, 16px right per holder it overlaps: held or crossing an
    // edge, else it buries the spine label or lands left of (over) a held child.
    // ceiling: O(blocks × items) per day on a pack miss; index by start if a day passes ~100 items
    _clPack(col, hourH = this.clHourH || 60) {
      const tRanges = col.items.filter(it => !it.allDay && it.start.length > 10).map(it => {   // over midnight: this day's slice, as _dayBlocks
        const sm = it.start < col.iso ? 0 : this._clMin(it.start), em = it.end.slice(0, 10) > col.iso ? 1440 : Math.max(this._clMin(it.end), sm + 20); return { it, sm, em };
      });
      const holds = (b, sm, em) => b._sm <= sm && b._pem >= em && b._pem - b._sm > em - sm;   // equal spans are peers
      const overlaps = (b, sm, em) => b._sm < em && b._pem > sm;
      const holders = col.blocks.filter(b => tRanges.some(r => holds(b, r.sm, r.em)) || col.blocks.some(o => holds(b, o._sm, o._pem)));
      // the DEEPEST spine it meets, not one per holder: back-to-back holders sit at one depth
      // an all-day block's spine is just its label, down from 00:00 (.is-terrain .cl-blk-t: 6px + up to ~10px a char): only what starts under it insets
      // ceiling: label length over-estimated from its characters (W ~9.6px, CJK ~9px; too long only insets more); measure it if a script runs longer
      const underLabel = (t, sm) => !t.it.allDay || sm * hourH / 60 < 6 + 10 * (t.it.title || '').length;
      const terrain = [], inset = (sm, em, near) => Math.max(0, ...terrain.filter(t => near(t.it, sm, em) && underLabel(t, sm)).map(t => t.offPx + 16));
      for (const b of holders.sort((a, b) => (b._pem - b._sm) - (a._pem - a._sm)))   // outermost first: its depth is set before what it holds, and draws under it
        terrain.push({ it: b, blk: true, terrain: true, topPct: b.topPct, hPct: b.hPct, offPx: inset(b._sm, b._pem, holds) });
      const packed = this._lanePack(tRanges, col.blocks.filter(b => !holders.includes(b)));
      for (const p of packed) p.offPx += inset(p.sm, p.em, overlaps);
      return { ...col, packedBlocks: [...terrain, ...packed.filter(p => p.blk)], timed: packed.filter(p => !p.blk) };
    },
    clBlocks() {
      if (this.clView === 'month' || this._clHidden()) return _clBlocksCache;   // hidden: keep the last pages; showing re-runs this
      void this.tasks; void this.events; void this.blocks; void this.byId; void this.blockDays; void this._rowV;   // register deps BEFORE the memo can short-circuit — else a hit records no dep and adds/edits don't repaint
      if (!this.clHourH) this.clRecalcPages();
      const span = this._periodSpan(), todayIso = this._nowDay, ph = this.clPeriodH();
      // The rendered window is just "around where you are" — there is no spacer to live inside, so no origin
      // to drift from, so nothing to recentre. It follows clPos for free.
      const start = Math.max(0, this.clPVisStart), end = Math.min(this._periodTotal(), start + this.clPVisCount);
      if (end <= start) return [];
      // The view-switch/scroll settle re-fires this effect ~100× against unchanged inputs. Return the SAME array
      // ref on a hit so Alpine's x-for no-ops instead of re-diffing every column/event. _calDataV busts on any data change.
      // scale key: the week packs by px-per-minute (tier, stacking); a day page is scale-free — its agenda tier binds in the template
      const scale = span === 1 ? 0 : this.clHourH;
      const sig = this.clView + '|' + start + '|' + end + '|' + scale + '|' + span + '|' + todayIso + '|' + _calDataV;   // no clock: an open band's foot follows it at render (clBandH)
      if (_clBlocksSig === sig) return _clBlocksCache;
      // Per period: a turn builds only the incoming one, and a zoom step only re-packs (scale), never re-reads a day.
      const dataSig = this.clView + '|' + span + '|' + todayIso + '|' + _calDataV;
      if (_clPgSig !== dataSig || _clPgCache.size > 60) { _clPgSig = dataSig; _clPgCache.clear(); }   // size: a long travel would keep every period it passed
      const from = this._periodDate(start), toD = this._periodDate(end - 1); toD.setDate(toD.getDate() + span - 1);
      const out = [];
      let byDay = null;   // one calendarItems pass over the window, only if a period misses
      for (let idx = start; idx < end; idx++) {
        let pg = _clPgCache.get(idx);
        if (!pg) {
          const ps = this._periodDate(idx);
          byDay ||= this._clGroup(isoDate(from), isoDate(toD));
          const days = Array.from({ length: span }, (_, i) => {
            const d = new Date(ps); d.setDate(d.getDate() + i); const iso = isoDate(d);
            return this._clColumn(iso, byDay[iso] || []);
          });
          _clPgCache.set(idx, pg = { days, bands: this._clWeekBands(days) });
        }
        if (pg.scale !== scale) {
          pg.scale = scale;
          pg.cols = pg.days.map(c => this._clPack(c));
          // Day stops being a grid, so it has no band layer at all: the agenda gives every mark and every all-day
          // item — including one that merely passes through today — a real row of its own.
          if (span === 1) for (const c of pg.cols) c.agenda = this._clAgenda(c);
        }
        out.push({ key: idx, rel: idx - start, cols: pg.cols, bands: pg.bands });   // top comes from --ph in CSS so it cannot drift from the height
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
      if (now - this._clHold.t0 < motion.t(CL_HOLD_MS)) return this.clNudge(dir, repeat);
      if (now - this._clHold.last < CL_HOLD_STEP) return;
      this._clHold.last = now; this.clStep(dir);
    },
    // ↑/↓: one hour in week/day, one week row in month. Smooth, so the move reads as movement and you keep your
    // place; it goes through the same scroller the wheel uses, so the snap and the midnight gate still apply.
    clNudge(dir, repeat) {
      // Month keeps the BROWSER's smooth scroll. It is a bounded grid with no zoom and no spacer — none of the
      // reasons day/week needed taking over apply — and its own virtualization re-render legitimately shifts
      // scrollTop, which a glide reads as someone else grabbing the wheel and gives up on.
      // A fresh press steps from the PENDING target (cleared once the settle finds it reached, or by the hand): stepping from the
      // live mid-glide scrollTop landed between rows, and the settle rounded two presses back to one. A key REPEAT
      // steps from live — piled onto the target, a held key ran the grid on for dozens of rows after the release.
      const el = this.$refs.clMonth;
      if (this.clView === 'month') return el && el.scrollTo({ top: this._clMTo = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, ((repeat ? null : this._clMTo) ?? el.scrollTop) + dir * this.clRowH)), behavior: this.reduceMotion() ? 'auto' : 'smooth' });
      const at = this.clPos.idx + this.clPos.frac + dir * (this.clHourH || 40) / this.clPeriodH();   // one hour, in periods
      this._clTween(Math.floor(at), at - Math.floor(at), 220);
    },
    // How far down the day the deadline bites. Date-only means "by the end of it", so the rule sits at the
    // day's close; the moment deadlines carry a time, the same rule simply moves up to that hour.
    clDlPct(it) { return timeOf(it.start) ? this._clMin(it.start) / 14.4 : 100; },
    clDlWhen(it) { const t = timeOf(it.start); return t ? this.fmtTime(t) : 'by end of day'; },
    // F2·P1: the label carries the time LEFT (the rule already says when it bites); a date-only deadline bites at the day's close
    // A2·B: up to three opted-in events count down on the title's line, nearest first. --prox (0 a fortnight out → 1 today)
    // grades size and warmth, so nearness is felt before it is read.
    clCountdowns() {
      const today = this._nowDay, t0 = new Date(today + 'T00:00'), now = new Date();
      return this.events.filter(e => e.countdown && e.starts_at?.slice(0, 10) >= today).sort((a, b) => a.starts_at < b.starts_at ? -1 : 1).slice(0, 3)
        .map(e => { const iso = e.starts_at.slice(0, 10);
          return { id: e.id, title: e.title, n: deadlineLeft(iso, now).label.split(' ')[0], prox: Math.max(0, 1 - (new Date(iso + 'T00:00') - t0) / 864e5 / 14) }; });
    },
    clDlLeft(it) { void this._nowTickV; return deadlineLeft(timeOf(it.start) ? it.start : it.start.slice(0, 10) + 'T23:59', new Date())?.label || ''; },
    // The page BOTH chrome rails describe: the week at the top of the viewport. Neither can be `position:
    // sticky` inside the grid — .cl-period-block sets `contain: paint`, which makes it the containing block
    // for its descendants, so a sticky layer sticks to the BLOCK and rides the transform off-screen with it.
    // Never null: a rail's x-for still evaluates its body while the rail is display:none, so an empty page
    // is what keeps a hidden rail from throwing on every view that isn't week.
    clAdPage() {
      if (this.clView !== 'week') return CL_NO_PAGE;   // day view is the agenda, which already gives each one a row
      const b = this.clBlocks();
      return b.find(p => p.key === this.clPos.idx) || b.find(p => p.key === this._periodIdx(this._clDate())) || b[0] || CL_NO_PAGE;
    },
    // Two rails, drawn from ONE template: the week at the top, and the one whose start line is rising toward
    // the pin. What makes the swap invisible is that they trade places at d=0 — the incoming rail is already
    // sitting exactly where the outgoing one was, so the index flip moves nothing. See _clAdPaint. Keyed by
    // week: on a turn the incoming rail BECOMES the pinned one instead of being redrawn into it.
    clAdPages() {
      const pg = this.clAdPage(), nx = this.clView === 'week' && this.clBlocks().find(p => p.key === this.clPos.idx + 1);
      return [pg, nx && nx !== pg ? nx : CL_NO_PAGE];   // one week twice would be a duplicate key
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
      return { mins, label: mins ? this.durFmt(mins) + ' of planned work, done' : 'Everything you planned, done' };
    },
    _clMin(iso) { const t = timeOf(iso, '00:00'); return (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)); },
    _dayBlocks(iso) {
      return blocksInRange(this.blocks, iso, iso, this.blockDays, localStamp(new Date())).map(b => {
        const sm = b.allDay || b.start < iso ? 0 : this._clMin(b.start), em = b.allDay || b.end.slice(0, 10) > iso ? 1440 : Math.min(1440, this._clMin(b.end));   // all-day: every day it covers, whole
        const live = b.bd?.status === 'running' && !this.clUnended(b.bd);
        return { id: b.id, title: b.title, color: b.color, allDay: b.allDay, src: b.src, start: b.start, planned: b.planned, bd: b.bd, live, tick: this.clBlkTick(b.bd), topPct: sm / 1440 * 100, hPct: Math.max(1.5, (em - sm) / 1440 * 100), _sm: sm, _em: em,
          _pem: b.open ? this._clMin(b.planned) : em };   // _pem: the planned end (a late run's clock isn't in the memo). src = the occurrence's OWN day (its block_days key), which is not the column it renders in once day-moved
      });
    },
    // §H H-bleed: still running past its planned end, today. A method, not it.open: a memoized object's plain field registers no dep for :class.
    clBandOpen(it) { return it.live && this._clPastPlan(it); },
    // Open: down to the clock, not the memo's build time. Memo fields only: reading blockDays would run this :style before
    // x-for hands it the new `p`, and Alpine never re-runs an effect twice in one flush (a moved band kept its old top).
    clBandH(it, h) { return this.clBandOpen(it) ? Math.max(h, (this.clNowMin() - it._sm) / 14.4) : h; },
    _clPastPlan(it) { if (!it.planned) return false; void this._nowTickV; return localStamp(new Date()) > it.planned; },   // the tick last: only a running band re-renders each minute
    // The band's grey tick (H-states-D1): "started 9:15am" while live, "didn't end" once its day passed, "✓ 9:15am – 10:40am" once stopped
    clBlkTick(bd) {
      const l = loggedOf(bd), t = ts => this.fmtTime(timeOf(ts));
      return l ? '✓ ' + t(l[0]) + ' – ' + t(l[1])
        : bd?.status !== 'running' || !bd.actual_start ? '' : this.clUnended(bd) ? "didn't end" : 'started ' + t(bd.actual_start);
    },
    // "⌘Z undo stop" rides under a stopped band for as long as that stop is what ⌘Z would take back
    clStopHint(col) {
      const e = this._journalPeek(-1), bd = e?.label === 'Stopped block' && this.blockDays.find(d => d.id === e.op.id);
      const p = bd && col.packedBlocks.find(p => p.it.id === bd.block_id && p.it.src === bd.date);
      return p ? p.topPct + p.hPct : null;
    },
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
    // ONE look per item wherever a day column renders (week grid, peek pane): state, stack/cascade, cover, bleed.
    clEvClass(p) { return p.it.kind + ' tier-' + p.tier + (p.stk ? ' cl-stk' : p.lane ? ' cl-casc' : '') + (this.clPlaced === p.it.id ? ' cl-placed' : '') + this.clTaskState(p.it) + (p.cov ? ' cl-cov' : ''); },
    clEvStyle(p, ix) { return 'top:' + p.topPct + '%;height:' + p.hPct + '%;' + this.clEvBox(p) + 'z-index:' + (2 + p.lane) + ';--i:' + ix + ';--cc:' + this.clItemColor(p.it); },
    clBlkClass(p) { const st = p.it.bd?.status;
      return { 'is-running': p.it.live, 'is-done': st === 'done', 'is-missed': st === 'missed', 'is-skipped': st === 'skipped', 'is-open': this.clBandOpen(p.it), 'is-terrain': p.terrain, 'cl-stk': !!p.stk }; },
    clBlkStyle(p) { return 'top:' + p.topPct + '%;height:' + this.clBandH(p.it, p.hPct) + '%;' + this.clEvBox(p) + 'z-index:' + (p.terrain ? 1 : 2 + p.lane) + ';--cc:' + (p.it.color || 'var(--accent)'); },
    clDlClass(m, mi) { return (mi === 0 ? 'lead' : '') + (m.start.length > 10 ? ' at' : '') + this.clTaskState(m); },
    // C5: rows flow at a readable height; gaps become named free slots; proportion moves to the rail.
    _clAgenda(col) {
      const rows = [];
      let end = -1;
      // A deadline is the sharpest thing on a day and it was invisible — a lane row that got clipped. Here it
      // is a row of its own, at the top, before anything you could get lost in.
      for (const it of [...col.deadlines, ...col.marks]) rows.push({ key: it.kind + it.id, it, mark: true, allday: true, min: 0, mins: 0 });
      // ...and an all-day item is simply a thing you are doing today, whether or not it also runs past today
      for (const it of col.bands) rows.push({ key: it.kind + it.id, it, allday: true, min: 0, mins: 0 });
      for (const p of [...col.timed].sort((a, b) => a.topPct - b.topPct || b.hPct - a.hPct)) {
        const min = Math.round(p.topPct * 14.4), mins = Math.max(1, Math.round(p.hPct * 14.4));
        // a timed due/deadline is still a MOMENT: it keeps its time but never claims a duration, nor splits a free gap
        if (this._clIsMark(p.it)) { rows.push({ key: p.it.kind + p.it.id + min, it: p.it, mark: true, min, mins: 0 }); continue; }
        if (end >= 0 && min - end >= CL_AG_GAP) rows.push({ key: 'free' + end, free: true, min: end, mins: min - end });
        rows.push({ key: p.it.kind + p.it.id + min, it: p.it, min, mins });
        end = Math.max(end, min + mins);
      }
      rows.sort((a, b) => a.min - b.min);   // stable: a gap's free row lands before a deadline inside it, all-day rows stay on top
      // Rows PACK from the top rather than stretching to fill 24h: an agenda's job is to be read, and a list
      // spaced by real proportion is mostly empty night. Scale stays on the rail, which is why it exists.
      // A packed day would outgrow its own block, and the block height is load-bearing (top = idx * periodH).
      // Shed the subtitle before anything gets clipped — same idea as B1's density tiers.
      // h: the full-tier height, "1h free" rows included (uncounted, a gappy day ran off its page). The template picks the tier
      // against the live page height, so a resize re-binds one class instead of rebuilding the day.
      // ceiling: a day too long even for compact still clips its tail unseen — what to drop is a design call, not made yet; revisit when a real day overflows compact
      const f = rows.filter(r => r.free).length;
      return { rows, h: (rows.length - f) * CL_AG_ROW + f * CL_AG_FREE };
    },
    // An agenda row is read on its own, so the time must be unambiguous — "2:00" beside "11:00" reads as 2am.
    clAgTime(m) { return (m % 60 ? this._clHM(m) : ((Math.floor(m / 60) + 11) % 12) + 1) + (m < 720 ? ' AM' : ' PM'); },
    _clIsMark(it) { return it.kind === 'task-due' || it.kind === 'task-deadline'; },
    clAgSub(r) {
      const a = this.areaObjs(this.byId.get(r.it.id)?.area_ids || [])[0];
      // a mark has no length to report, so it says what KIND of moment it is; an all-day item has no length
      // either, and the time column already said "All day" — so it carries only its area, or nothing.
      const lead = r.mark ? (r.it.kind === 'task-deadline' ? 'Deadline' : 'Due') : r.allday ? (r.it.spanStart === false ? 'Continues' : '') : this._clCross(r.it) ? this.clTimeLabel(r.it) : this.durFmt(r.mins);
      return lead + (a ? (lead ? ' · ' : '') + a.name : '');
    },
    clHours() { return CL_HOURS; },
    clHourLabel(h) { return h === 0 ? '' : h < 12 ? h + ' AM' : h === 12 ? 'Noon' : (h - 12) + ' PM'; },
    clNowPct() { return this.clNowMin() / 1440 * 100; },
    clNowMin() { void this._nowTickV; const n = new Date(); return n.getHours() * 60 + n.getMinutes(); },
    // The clock marks read the tick only on today's column, and not while Plan is hidden (peek shows off-Plan): each
    // tick restyled every column's hidden line. Showing Plan re-runs them off `surface`, so the line is never a minute late.
    clNowAt(col, prop, peek) { return col?.today && (peek || !this._clHidden()) ? 'display:block;' + prop + ':' + this.clNowPct() + '%' : 'display:none'; },
    clNowLabel(col) { return col?.today && !this._clHidden() ? this._clHM(this.clNowMin()) : ''; },
    clNowCuts(h, col) { return !!col?.today && !this._clHidden() && Math.abs(this.clNowMin() - h * 60) * this.clHourH / 60 < 15.5; },   // px: the now pill (−8…+7.5) meets the hour label (−7…+7.5)
    _clHM(m) { return `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`; },
    _clHMA(m) { return this._clHM(m) + (m < 720 ? ' AM' : ' PM'); },   // a landing time: keeps :00
    _clClock(iso) { return this._clHM(this._clMin(iso)); },
    // A moment has no range to state: a TIMED due date/deadline carries end === start, and so does an event
    // saved with no length. Both printed "3:00 – 3:00", which reads as a broken range rather than a moment.
    clTimeLabel(it) { if (it.allDay) return ''; const a = this._clClock(it.start);
      if (this._clCross(it)) {   // every day's slice states the whole range, AM/PM so "2:00" can't read as afternoon; past the next day, with weekdays
        const day = iso => new Date(iso.slice(0, 10) + 'T00:00'), far = day(it.end) - day(it.start) > 1.5 * 864e5;
        const at = iso => (far ? WEEKDAYS[day(iso).getDay()] + ' ' : '') + this.clAgTime(this._clMin(iso));
        return at(it.start) + ' – ' + at(it.end);
      }
      return it.end && this._clMin(it.end) !== this._clMin(it.start) ? a + ' – ' + this._clClock(it.end) : a; },
    _clCross(it) { return !it.allDay && (it.end || '').slice(0, 10) > it.start.slice(0, 10); },
    // A view switch or jump outranks motion in flight, whose frames would land in the new view's period space.
    _clHalt() { motion.stop('clTween'); motion.stop('clFling'); },
    // Park the anchor period under the chrome, opening at the waking hour — or at `frac`, the hour a keyboard step keeps.
    // clientHeight is 0 on first open, and _clMaxFrac needs it — retry until layout settles. One assignment; nothing to re-assert afterwards.
    _clScrollToPeriod(tries = 8, frac, turn) {   // turn: Today and a picked date turn the page as the wheel does (decision #75)
      this._clHalt(); const el = this.$refs.clPages; if (!el) return;
      if (!el.clientHeight) { if (tries > 0) requestAnimationFrame(() => this._clScrollToPeriod(tries - 1, frac, turn)); return; }
      if (!this.clHourH) this.clRecalcPages();
      // day: the whole day is on one page, so there is no waking-hours offset to scroll past. In week it is a
      // FRACTION of the period, so a zoom cannot move it.
      const idx = this._periodIdx(this._clDate()), to = frac ?? (this.clView === 'day' ? 0 : Math.min(this._clMaxFrac(), CL_WAKING_START / 24));
      const gap = idx + to - this.clPos.idx - this.clPos.frac;
      if (!turn || !gap) return this._clSetPos(idx, to);   // already there: no idle turn holding the page
      if (Math.abs(gap) > 1) this._clSetPos(idx - Math.sign(gap), to);   // from the period beside the target: months away is still one turn
      this._clTween(idx, to);
    },
    // E3: a period ARRIVING (view switch, scroll settle, jump) stages its events in. Off-then-on so the
    // animation restarts; the class rides .calendar so every child replays together.
    _clSettle() {
      const arm = () => {
        this.clSettling = true;
        clearTimeout(this._clSettleT); this._clSettleT = setTimeout(() => { this.clSettling = false; }, motion.t(450));   // felt time: a compressed or zero-motion run ends the stagger with its animation
      };
      // reduced motion: an arrival within the last one's 150ms fade keeps it — cl-rise starts at opacity 0, so a restart per key-repeat blanks the grid
      const now = performance.now(), burst = motion.gentle && this.clSettling && now - this._clSettleAt < 150;
      this._clSettleAt = now;
      if (burst) return arm();
      this.clSettling = false;
      this.$nextTick(arm);
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
      return this._zoneLayout(list, head, zoneH, barY, 34 + (this.clView === 'week' ? _clAdH : 0));   // 34: the .cl-mtitle line box; _clAdH: the top week's deadline rail
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
        if (step) return this._clTween(this.clPos.idx + step, this._clHour());   // #64: lands at the hour on screen, as a keyboard step
      }
      if (this._clGate?.turned) return;   // the rest of this gesture is momentum for a turn already made
      motion.stop('clTween');   // a hand mid-flight outranks a tween, same rule as _glide
      this._clSetPos(this.clPos.idx, Math.max(0, Math.min(maxF, this.clPos.frac + dy / ph)));
    },
    // A new gesture: CL_GESTURE_GAP of quiet ended slower than half the stream's last speed, or a SPEED rising out of
    // a decay — web's stand-in for ClPages' `.began` (the next swipe lands inside the last one's momentum). `t` is the
    // event's own time and speed is px/ms: a main-thread stall makes Chrome merge a frame-rate stream into ONE event
    // spanning it at about the stream's speed (a hand from rest is far slower), so that reads as the same hand, and a
    // coalesced burst (…17, 15, 38 over 48ms) is no rise. `spins` (pull-up): a free-spinning wheel's slowing clicks
    // continue their stream too, and a wheel's pause between strokes is a dip; the calendar keeps every click
    // CL_GESTURE_GAP apart a new gesture, and a trackpad stroke that hesitates one gesture (ClPages).
    // Mini-spec (`w`, the calendar's _clWheel or a caller's own state): a peak > .5px/ms ≥6 events back (`spins`:
    // ≥96ms — a stamp's jitter doesn't count), floor < peak/2, then speed > 2×floor + .25.
    // ceiling: a fast-decaying tail (~7%/frame) stalled ~400ms early on, or any stalled under .25px/ms, reads as a hand — loosen the ratio/floor if one turns a page or opens the overview.
    _clGestureFresh(dy, t, w = _clWheel, gated = !!this._clGate, spins = false) {
      const dt = t - (w.t ?? -Infinity), v = Math.abs(dy) / Math.max(dt, 1);
      const fresh = !gated || (dt > CL_GESTURE_GAP && v * 2 < (w.v ?? Infinity)) || ((spins ? t - w.hiT >= 96 : w.n >= 6) && w.hi > 0.5 && w.lo < w.hi / 2 && v > w.lo * 2 + 0.25);
      w.t = t;
      // nothing a stall could merge: a gesture's first speed spans the rest before it, a crawl or a sideways nudge (dy 0)
      // ends a stream, and outside `spins` a click is its own gesture
      w.v = fresh || v < 0.25 || !(spins || dt < 50) ? Infinity : v;
      if (fresh) w.hi = w.lo = w.n = 0; else if (v >= w.hi) { w.hi = w.lo = v; w.hiT = t; w.n = 0; } else if (dy) { w.lo = Math.min(w.lo, v); w.n++; }
      return fresh;
    },
    clPagesWheel(e) {
      if (e.ctrlKey || e.metaKey) return;   // pinch belongs to clZoomWheel, which already claimed it in capture
      if ((this.clView !== 'day' && this.clView !== 'week') || !e.cancelable) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * e.currentTarget.clientHeight : e.deltaY;
      this._clTravel(dy, this._clGestureFresh(dy, e.timeStamp));
      this._clScrolling();
    },
    // Touch. There is no scroller to pan, so the finger drives clPos itself. Under a finger a period is a PAGE:
    // the timeline follows it 1:1 — across the edge into the neighbour, at most one — and the release decides
    // (_clRelease). Claim only once the drag is clearly vertical, or the horizontal surface-swipe loses its
    // gesture. The hand catches whatever we were animating. Times are the EVENTS' own (swipe-velocity rule).
    // ONE finger drives: a second one landing, moving or lifting mid-drag is ignored (emil §10 multi-touch guard).
    clPagesTouch(e) {
      if (e.type === 'pointerdown') {
        if (this._clTouch || e.pointerType !== 'touch') return;
        motion.stop('clFling'); motion.stop('clTween');
        this._clTouch = { id: e.pointerId, x: e.clientX, y0: e.clientY, y: e.clientY, p0: this.clPos.idx + this.clPos.frac, v: 0, t: e.timeStamp, on: false };
        return;
      }
      const d = this._clTouch; if (!d || e.pointerId !== d.id) return;
      // no velocity from a finger that STOPPED before lifting (~4 frames still), nor from a system cancel —
      // an interruption lands on the NEAREST page (the Android pager does the same)
      if (e.type === 'pointerup' || e.type === 'pointercancel') { this._clTouch = null; return this._clRelease(e.type === 'pointercancel' || e.timeStamp - d.t > 64 ? 0 : d.v); }
      const dy = d.y0 - e.clientY;
      if (!d.on) { if (Math.abs(dy) < 6 || Math.abs(dy) <= Math.abs(e.clientX - d.x)) return; d.on = true; this._clGate = null; }
      const i0 = Math.floor(d.p0), p = Math.max(i0 - 1 + this._clMaxFrac(), Math.min(i0 + 1, d.p0 + dy / this.clPeriodH()));
      this._clSetPos(Math.floor(p), p - Math.floor(p));
      d.v = (d.y - e.clientY) / Math.max(1, e.timeStamp - d.t); d.y = e.clientY; d.t = e.timeStamp;
      this._clScrolling();
    },
    // A release. Inside a period's travel it coasts on its momentum, stopping at the period's edge; in the gap
    // between two periods it pages exactly like the surface swipe — a flick or past half-way commits the
    // neighbour, anything else springs back. So a finger never rests you straddling two periods.
    _clRelease(v) {
      const maxF = this._clMaxFrac(), i = this.clPos.idx, f = this.clPos.frac;
      if (f <= maxF) return Math.abs(v) > 0.05 && this._clFlingStep(v);
      const ph = this.clPeriodH(), next = this.snapTarget((maxF - f) * ph, (1 - maxF) * ph, -v, 0, 2);
      this._clTween(i + next, next ? 0 : maxF);
    },
    // Time-based: v (px/ms) decays by CL_FLING per 16ms and travels its mean over dt, so a 120Hz screen coasts as
    // far and as long as a 60Hz one (a per-frame decay ran it twice as fast for half the time; end-of-step speed
    // alone still undershot 60Hz by ~3%). dt caps at 64ms so a stalled frame can't lurch. First step is SYNCHRONOUS.
    _clFlingStep(v) {
      let last = performance.now() - 16;
      const step = now => { const dt = Math.min(64, Math.max(0, now - last)), v0 = v; last = now; v *= CL_FLING ** (dt / 16);
        if (Math.abs(v) < 0.02) return false; this._clTravel((v0 + v) / 2 * dt, false); this._clScrolling(); return true; };
      if (step(last + 16)) motion.run('clFling', step); else motion.stop('clFling');
    },
    // Nothing has landed while a finger is still down (however long it holds still) or a spring-back is mid-flight —
    // landing then anchored the day the timeline was merely passing through (T flashed mid-drag, or stuck after).
    _clScrolling() { if (!this.clScrolling) this.clScrolling = true; clearTimeout(_clScrollT); _clScrollT = setTimeout(() => { if (this._clTouch || motion.running('clTween')) return this._clScrolling(); this.clScrolling = false; this._clLand(); }, motion.t(600)); },
    // Landing settles the anchor on whatever period is on top. No scrollend to wait for — we know when we stopped.
    _clLand() {
      if (this.clView !== 'day' && this.clView !== 'week') return;
      const iso = isoDate(this._clAt(0, true));
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
      this._calTo(isoDate(this._clAt()));
    },
    _clWkKey(iso) { return isoDate(this._clWeekStart(new Date(iso + 'T00:00'))); },
    clPopSel(iso) { return this.clView === 'week' ? this._clWkKey(iso) === this._clWkKey(this.clAnchor) : iso === this.clAnchor; },
    clPopHot(iso) { return this.clView === 'week' && !!this.clPopHoverWk && this._clWkKey(iso) === this.clPopHoverWk; },
    clPickDate(iso) {
      this.pop = null; this.clPopHoverWk = '';
      this.clAnchor = this.clView === 'week' ? isoDate(this._clWeekStart(new Date(iso + 'T00:00'))) : iso;
      this.clRecalcPages(); this.$nextTick(() => this._clScrollToPeriod(8, undefined, true));
    },
    _clHour() { return motion.running('clTween') ? this._clTo % 1 : this.clPos.frac; },   // #23: the hour you scrolled to (or are heading to), as the Mac
    clStep(dir, vt) {
      const mo = this.clView === 'month', hour = this._clHour();
      const set = () => { mo ? this._clMAnchor(dir) : (this.clAnchor = isoDate(this._clAt(dir))); }, after = () => mo ? this._clStepMonth() : this._clScrollToPeriod(8, hour);
      if (vt) this._withTransition(set, () => { after(); if (this.reduceMotion()) this._clSettle(); }, false, true);   // Shift+↑/↓ — the same morph a view switch runs; without one the period fades in
      else if (!mo) { set(); this._clTween(this._periodIdx(this._clDate()), hour); }   // a held arrow's period turns the page as a wheel does (decision #75); the next step retargets it
      else { set(); after(); if (this.reduceMotion()) this._clSettle(); }   // month glides as Today does; reduced, it lands and fades in
    },
    // The strip's "T" shows only while today is OUT of view (user 2026-08-17 P4; Android planShowToday) — the
    // SETTLED day (clAnchor lands after a drag), never the live drag, which flashed it mid-gesture
    clShowToday() { const d = new Date(); return this.clView === 'month' ? this.clFocusYM !== d.getFullYear() * 12 + d.getMonth() : this.clAnchor !== isoDate(d); },
    clToday(turn = true) {
      const now = new Date(), gap = now.getFullYear() * 12 + now.getMonth() - this.clFocusYM;
      this.clAnchor = isoDate(now); this.clDayFocus = null;   // the Tab stop comes back with today
      if (this.clView !== 'month') return queueMicrotask(() => this._clScrollToPeriod(8, undefined, turn));   // not $nextTick: a surface switch holds that two frames
      if (!turn || !gap) return this.clScrollToAnchor();   // already in today's month: no idle glide leaving its target behind
      if (this.reduceMotion()) { this.clScrollToAnchor(); return this._clSettle(); }   // lands at once; today's month fades in
      // month turns on its arrows' glide (decision #75), from the month beside today's: months away is still one turn
      if (Math.abs(gap) > 1) this.clScrollToAnchor(8, this._monthFirstIdx(new Date(now.getFullYear(), now.getMonth() - Math.sign(gap), 1)));
      queueMicrotask(() => this._clStepMonth());   // after the jump's own microtask writes scrollTop: that write cancels a glide
    },
    clOpenDay(iso) { this.clSetView('day'); this.clAnchor = iso; },
    // --- Event editor (create / edit / delete) ---
    clNewEvent(date) {
      this.eventEdit = { title: '', date: date || isoDate(this._clAt()), start: '09:00', end: '10:00', span: 0, all_day: false, color: null, countdown: false };
    },
    clEditEvent(id) {
      const e = this.events.find(x => x.id === id); if (!e) return;
      this.eventEdit = { id: e.id, title: e.title, date: e.starts_at.slice(0, 10), span: this._adSpan(e), start: timeOf(e.starts_at, '09:00'), end: timeOf(e.ends_at, '10:00'), multi: e.starts_at.slice(0, 10) < e.ends_at.slice(0, 10), all_day: !!e.all_day, color: e.color || null, countdown: !!e.countdown };
    },
    clItemClick(it) { if (!it) return; if (it.kind === 'event') return this.clEditEvent(it.id); if (this.clIsTask(it)) return this.clOpenTaskSide(it.id); if (it.start) this.clOpenDay(it.start.slice(0, 10)); },
    clToggleTask(id) { const t = this.byId.get(id); if (t) this.toggle(t); },
    clKeyActivate(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    // ONE state class for every calendar mark of a task — chip, timeline event, agenda row, chapter band,
    // due/deadline mark. A finished deadline used to read exactly like a live one.
    clTaskState(it) { const t = this.clIsTask(it) && this.byId.get(it.id); return !t ? '' : t.archived_at ? ' archived' : t.completed_at ? ' done' : ''; },
    // checkHtml's row args for a task off the list (mkRow builds the list's) — same blocked/paused/prog states as list rows.
    // imp: the composer's check shows the DRAFT's importance, not the stored one.
    _chkArgs(t, imp = t.importance) {
      const hp = this.hasProgress(t);
      return { t, pc: this.pc(imp), note: inNotes(t), blocked: openBlockers(t, this.byId).length > 0, hasProgress: hp, progress: hp ? this.rowProgress(t) : 0 };
    },
    clCheckHtml(it, cls = 'cl-chip-check') { const t = this.byId.get(it.id); return t ? checkHtml(this._chkArgs(t), 'button', cls) : ''; },   // calendar task checkboxes
    entryCheckHtml(c) { return checkHtml(this._chkArgs(c), 'button', 'sm'); },   // composer subtask rows — adds archived/blocked/paused not covered by inline :class
    // The composer's type toggle (6th check site): tack = which layer. A new task has no row state, so only the draft's importance colours it.
    compCheckHtml(tack) { const t = this.editingTask(), imp = this.draft.importance; return checkHtml({ ...(t ? this._chkArgs(t, imp) : { t: {}, pc: this.pc(imp) }), note: tack }, 'span'); },
    typeFront(tack) { return tack === inNotes(this.draft); },
    typeLabel(tack) { return !this.typeFront(tack) ? (tack ? 'Make it a note' : 'Make it a task') : tack ? 'Note' : !this.editing ? 'Task' : this.editingTask()?.content; },   // editing: a checkbox named by its task, as the row's
    // Front check = complete (toggleEditing saves the draft first); the peek swaps the draft's type. Note → Task restores the
    // type it had (steps), and deleting the memo keeps a round trip's draft equal to its base (no phantom unsaved edit).
    typeTap(tack) {
      const d = this.draft;
      if (this.typeFront(tack)) return this._pillThen(() => this.toggleEditing());   // the done check saves the draft first, so it pills like Enter
      if (tack) { d.typeBeforeNote = d.task_type; d.task_type = 'note'; }
      else { d.task_type = d.typeBeforeNote ?? null; delete d.typeBeforeNote; }
    },
    clChipCls(it) {
      const st = this.clTaskState(it);
      if (it.spanStart === undefined || this.clView === 'day') return it.kind + st;   // one column ⇒ nothing to join across, so no span caps
      return it.kind + st + ' cl-span' + (it.spanStart ? ' cl-span-l' : '') + (it.spanEnd ? ' cl-span-r' : '') + (!it.spanStart && !it.spanEnd ? ' cl-span-mid' : '');
    },
    clSplitTitle(n) { const m = n.match(/^(.*?),?\s*(\d{4})$/); return m ? [m[1], ' ' + m[2]] : [n, '']; },   // trailing YEAR only — splitting on the first space mangled 'Jul 19 – Jul 25, 2026' down to 'Jul 19'
    clIsTask(it) { return it.kind === 'task-due' || it.kind === 'task-block' || it.kind === 'task-deadline'; },
    // all-day → date-only, keeping its day-span when the date moves; a single-day end before the start is the next day (22:00–02:00), a multi-day one is kept as typed; shared by event + block
    _evRange(e, date = e.date) {
      const end = new Date(date + 'T00:00');
      if (e.all_day) { end.setDate(end.getDate() + Math.max(0, e.span || 0)); return { starts_at: date, ends_at: isoDate(end) }; }   // the All-day editor hides a backwards end date, so it shows and saves one day
      end.setDate(end.getDate() + (e.multi ? e.span : +(e.end < e.start)));   // multi: the end date the event editor shows, exactly as typed (< 0 mid-typing)
      return { starts_at: date + 'T' + e.start, ends_at: isoDate(end) + 'T' + e.end };
    },
    // days an all-day row runs past its start: ends_at is INCLUSIVE (import.js finishEvent); an end before the start reads as 0
    _adSpan(it) { return Math.max(0, Math.round((new Date(it.ends_at.slice(0, 10)) - new Date(it.starts_at.slice(0, 10))) / 86400000)); },
    _toggleIn(arr, v) { const i = arr.indexOf(v); i < 0 ? arr.push(v) : arr.splice(i, 1); },
    async clSaveEvent() {
      const e = this.eventEdit; if (!e) return;
      const fields = { title: e.title.trim() || 'Untitled', all_day: e.all_day, color: e.color || null, countdown: e.countdown, ...this._evRange(e) };
      if (fields.ends_at <= fields.starts_at && e.multi && !e.all_day) return this.toast('The end is before the start');   // stored as typed it would collapse the event
      // a failed write keeps the editor and its edits
      let id = e.id;
      if (id) {
        if (!await this._journalRowChange('Edited event', 'event', id, () => this.store.events.update(id, fields))) return;
      } else {
        const ev = await this.store.events.add(fields);
        await this._reloadFor('event');
        if (!ev) return this.toast('Failed saving “Added event”. Try again?');
        this._pushEntry('Added event', { kind: 'remove', target: 'event', id: ev.id, rows: this._rowsForDelete('event', ev.id, ev) });   // ev: the re-read may have failed
        id = ev.id;
      }
      this.eventEdit = null;
    },
    async clDeleteEvent() { const e = this.events.find(x => x.id === this.eventEdit?.id); if (!e || await this.perform('Deleted event', { target: 'event', kind: 'delete', id: e.id })) this.eventEdit = null; },   // a failed delete keeps the editor and its edits

    // --- Blocks: drag a span on the week/day grid to create; click a band to edit ---
    clBlockDragStart(e, iso) {
      // A finger dragging the grid is SCROLLING the day; stealing that gesture to draw a block makes the
      // calendar feel broken, so touch draws no blocks here. Pen still draws (it points).
      if (e.pointerType === 'touch' || e.button !== 0 || e.target.closest('.cl-event, .cl-block')) return;   // drag only on empty grid
      const col = e.currentTarget; col.setPointerCapture?.(e.pointerId);
      this._blkDrag = { iso, rect: col.getBoundingClientRect(), y0: e.clientY, y1: e.clientY };
      this.clDragBand = this._blkBand();
    },
    clBlockDragMove(e) { if (!this._blkDrag) return; this._blkDrag.y1 = e.clientY; this.clDragBand = this._blkBand(); },
    clBlockDragEnd() {
      const d = this._blkDrag, s = d && this._blkSpan(d); this._blkDrag = null; this.clDragBand = null; if (!s) return;
      this.clNewBlock(d.iso, this._fmtMin(s[0]), this._fmtMin(s[1] % 1440));   // 24:00 → 00:00, which _evRange rolls to the next day
    },
    // [start, end] minutes the drag spans, snapped 15 within its day — the band draws exactly the block it saves; null for a click
    _blkSpan(d) {
      if (Math.abs(d.y1 - d.y0) < 8) return null;
      const snap = y => Math.round((y - d.rect.top) / d.rect.height * 96) * 15;
      const a = Math.max(0, Math.min(1425, snap(Math.min(d.y0, d.y1))));
      return [a, Math.max(a + 15, Math.min(1440, a + 1425, snap(Math.max(d.y0, d.y1))))];   // under a day: 00:00–24:00 would save zero-length
    },
    _blkBand() { const d = this._blkDrag, s = this._blkSpan(d); return s && { iso: d.iso, topPct: s[0] / 14.4, hPct: (s[1] - s[0]) / 14.4 }; },

    // --- Drag-to-(re)schedule (HTML5 DnD) — wall-clock local strings, never toISOString (tz shift) ---
    _fmtMin: m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'),
    clDragStart(e, kind, id, srcIso, start = srcIso, end) {   // start/end: the occurrence's drawn slot (an event's srcIso is its start)
      if (!kind) return;
      // dim the SOURCE element (the hole it left behind) while its copy rides the pointer
      const el = this._clLifted = e.target?.closest?.('.cl-event, .cl-chip, .cl-block, .item, .cl-ch, .cl-ag-row'), col = el?.closest('.cl-pcol'), img = el?.cloneNode(true);
      el?.classList.add('cl-lift');
      const r = el?.getBoundingClientRect();   // after the lift: it drops :active's press scale
      if (img && e.dataTransfer) { img.style.cssText += `;top:0;left:0;width:${r.width}px;height:${r.height}px`; img.setAttribute('x-ignore', ''); dragImage(e, img.outerHTML, r); }   // x-ignore: Alpine would init the copy's directives
      // grab: minutes from the item's real start to the pointer, not from its drawn top (a stacked peer steps down) — the
      // drop keeps it, so a sideways move keeps the time. lead: how far that start sits above this column — a tail drawn from 00:00 began the day before.
      const at = col && start?.length > 10 ? minutesBetween(col.dataset.iso + 'T00:00', start) : null, cr = col?.getBoundingClientRect();
      const lead = at != null && (kind === 'event' || kind === 'block') ? Math.max(0, -at) : 0;
      const grab = col ? Math.max(0, (e.clientY - cr.top) / cr.height * 1440 - (at ?? (r.top - cr.top) / cr.height * 1440)) : 0;   // never above the start: a synthetic dragstart has clientY 0
      this._clDnd = { kind, id, grab, lead, ...(srcIso && { date: srcIso.slice(0, 10) }), ...(end && { span: { starts_at: start, ends_at: end } }) };   // date: the occurrence's own day (block/event)
      this._clDnd.allDay = (kind === 'event' || kind === 'block') && !!this._dndRow(this._clDnd)?.all_day;   // clDropOn keeps it all-day wherever it lands
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); }
    },
    clDragEndSchedule() { this._clDnd = null; this.clDropHint = null; this._clDropCell(null); this.clDropPreview = null; this._clLifted?.classList.remove('cl-lift'); this._clLifted = null; this._dndHold(null); dragImageEnd(); },
    // The month cell under a drag, lit imperatively: a reactive hint re-ran every rendered cell's :class per dragenter.
    _clDropCell(el) { if (el === this._clDropEl) return; this._clDropEl?.classList.remove('cl-drop'); (this._clDropEl = el)?.classList.add('cl-drop'); },
    // F4: what you just placed settles into its slot, so the release reads as a landing and not a repaint
    _clPlaced(id) { this.flash('clPlaced', '_clPlacedT', id, 420); },
    _dropMin(e, grab = 0, lead = 0) {   // the start's minutes-of-day (snapped 15; down to -lead: the day before) when dropped inside a week/day column; null on a month cell
      const col = e.target.closest?.('.cl-pcol'); if (!col) return null;
      const r = col.getBoundingClientRect();
      return Math.max(-lead, Math.min(1425, Math.round(((e.clientY - r.top) / r.height * 1440 - grab) / 15) * 15));
    },
    _dndRow(d) { return (d.kind === 'event' ? this.events : this.blocks).find(x => x.id === d.id); },   // the row a dragged event/block came from
    // the dragged occurrence's own slot as its chip drew it: a repeating block's day can carry its own times (block_days), on any date
    _dndSpan(d, it) { return it.recurrence && d.span || it; },
    // Sizes AND names the preview ghost in one read, so it lands as the thing you dragged and not just a time:
    // an event/block keeps its own length and title, a task its est_minutes and content, a due chip a marker
    // height — 60 being that marker, i.e. the one-hour default every durationless or all-day drag falls back to.
    _dragGhost() {
      const d = this._clDnd; if (!d) return { h: 60, t: '' };
      if (d.kind === 'event' || d.kind === 'block') {
        const it = this._dndRow(d), span = it && this._dndSpan(d, it);
        return { h: it && !it.all_day ? Math.max(15, minutesBetween(span.starts_at, span.ends_at)) : 60, t: it?.title || '' };   // days included
      }
      const t = this.byId.get(d.id);
      return { h: d.kind === 'task' ? t?.est_minutes || 60 : 60, t: t?.content || '' };
    },
    // The week/day edge zone travels every frame from the last dragover's pointer, not per dragover (a still pointer's come
    // ~20/s): edgeScrollStep is rate × elapsed, so px/s holds. It ends 100ms after the last one, or on entering anything but a day column.
    _clEdgeGlide(x, y) {
      const t0 = performance.now();
      addEventListener('dragenter', clEdgeOut, true);   // stays through in-grid dragenters; the same fn is added once
      motion.run('clEdge', now => {
        const el = now - t0 < 100 && this._clDnd ? document.elementFromPoint(x, y) : null, col = el?.closest('.cl-pcol');
        return !!col && !!this.clDropOver({ target: el, clientX: x, clientY: y }, col.dataset.iso, true) || clEdgeEnd();
      });
    },
    clDropOver(e, iso, glide = false) {
      if (!this._clDnd) return;
      if (!glide && motion.running('clEdge')) return this._clEdgeGlide(e.clientX, e.clientY);   // the next frame travels and previews from here
      // scroll FIRST, so the preview reads the grid the drop will. .cl-pages is overflow:clip under pinned chrome: its edge
      // zone starts below the chrome, and travel means clPos — only in a glide frame, which paints the preview it reads:
      // a dragover's step lands the drop it comes before (Chrome sends one) where no frame showed.
      const sc = e.target?.closest?.('.cl-pages, .cl-month, .peek-body'), pg = sc === this.$refs.clPages, v = edgeScrollStep(sc, e.clientY, false, pg ? this._clHeadH() : 0);
      if (v && pg && glide) this._clSetPos(this.clPos.idx, Math.max(0, Math.min(this._clMaxFrac(), this.clPos.frac + v / this.clPeriodH())));
      this._dndHold(v && !pg ? sc : null);   // .cl-pages is overflow:clip — no native autoscroll to hold off
      if (v && pg && !glide) this._clEdgeGlide(e.clientX, e.clientY);
      const min = this._dropMin(e, this._clDnd.grab, this._clDnd.lead), p = this.clDropPreview, inBlk = this._dropBlock(e, this._clDnd);
      this.clDropHint = null; this._clDropCell(this._clDnd.allDay && min != null ? e.target.closest('.cl-pcol') : null);   // timed preview and the all-day/month highlight are mutually exclusive
      if (min == null || this._clDnd.allDay) { this.clDropPreview = null; return v; }   // an all-day item lands date-only: its day lights, no time
      const clock = inBlk && !inBlk.timed ? null : this._clHMA((min % 1440 + 1440) % 1440), name = inBlk?.blk.title || 'block';   // the bin sets no time
      const label = !inBlk ? clock : clock ? clock + ' · ' + name : 'Attach to ' + name;
      const top = Math.max(0, min);   // a tail (its start days above, on a later day's slice) draws from this day's 00:00, not up under the pinned header; the label keeps the real start
      if (p?.iso !== iso || p.min !== top || p.label !== label) { const g = this._dragGhost(); this.clDropPreview = { iso, min: top, clock, label, ...g, h: Math.min(1440, g.h + min) - top }; }   // the slice it lands as, ending at this day's foot   // same slot: no write (dragover fires per frame)
      return v;
    },
    // A task over a block: the half on its spine (left, where the label sits) is the bin — attach, no time; the far half is timed.
    _dropBlock(e, d) {
      const el = d?.kind === 'task' && e.target?.closest?.('.cl-block'), id = el?.dataset?.id; if (!id) return null;
      const r = el.getBoundingClientRect();
      return { blk: this.blocks.find(x => x.id === id) || { id }, timed: e.clientX > r.left + r.width / 2 };
    },
    _dndKind(kind) { return ({ 'task-deadline': 'deadline', 'event': 'event', 'task-due': 'due', 'block': 'block' })[kind] ?? 'task'; },
    async clDropOn(e, iso, allDay = false) {   // allDay: a list task dropped on the Peek's all-day strip or month → date only
      const d = this._clDnd; this.clDragEndSchedule();
      if (!d || !iso) return;
      this._clPlaced(d.id);
      const dm = allDay ? null : this._dropMin(e, d.grab, d.lead);   // null ⇒ month cell or all-day row (date only)
      if (this.dragId) this.dragEnd();   // capture drop geometry before closing the list's Peek Pane
      const stamp = dm == null ? iso : iso + 'T' + this._fmtMin(dm);
      if (d.kind === 'task' || d.kind === 'due' || d.kind === 'deadline') {
        const { blk, timed } = this._dropBlock(e, d) || {}, attached = 'Attached to ' + (blk?.title || 'block'), has = blk && this.scheduleItems.some(x => x.block_id === blk.id && x.task_id === d.id);
        if (blk && !timed) return has || this.perform(attached, { kind: 'create', target: 'scheduleItem', fields: { task_id: d.id, block_id: blk.id } }, { fail: 'Failed attaching. Try again?' });   // attached once
        if (blk) return this._saveSched(d.id, { on: iso, dueTime: this._fmtMin(dm), block: has ? null : blk.id }, has ? 'Rescheduled task' : attached + ' at ' + this._clHMA(dm));   // a drop on a block is always in a column: dm is set
        if (d.kind === 'deadline' || d.kind === 'due') {
          const field = d.kind === 'deadline' ? 'deadline_at' : 'recur_from';
          await this.perform('Rescheduled ' + (d.kind === 'deadline' ? 'deadline' : 'due date'), { kind: 'update', target: 'task', id: d.id, after: { [field]: stamp } });
        } else await this._saveSched(d.id, { on: iso, dueTime: dm == null ? null : this._fmtMin(dm) }, 'Rescheduled task');   // plain task drop → its date-item
      } else {
        const it = this._dndRow(d); if (!it) return;
        const span = this._dndSpan(d, it);
        let fields;
        if (it.all_day) {
          const end = new Date(iso + 'T00:00:00'); end.setDate(end.getDate() + this._adSpan(it));   // local parse (not UTC) so the day doesn't drift
          fields = { all_day: true, starts_at: iso, ends_at: isoDate(end) };
        } else {
          const starts_at = addMinutes(iso + 'T00:00', dm ?? this._clMin(it.starts_at));   // dropped time (before 00:00 = the day before), else keep tod
          fields = { starts_at, ends_at: addMinutes(starts_at, Math.max(15, minutesBetween(span.starts_at, span.ends_at))) };   // its whole length, days included
        }
        // Recurring block: override only this occurrence via block_days; non-recurring: update the base block.
        if (d.kind === 'block' && it.recurrence) {
          // The override row stays keyed on the occurrence's own day and points planned_start at wherever it landed,
          // so a cross-day drop is the same one write: the source day stops resolving it, the target day gains it.
          if (!d.date) { this.notify('Drag this occurrence from the week or day view to move it'); return; }   // no source-date on record (month/agenda chip); can't tell which occurrence
          if (span.starts_at === fields.starts_at && span.ends_at === fields.ends_at) return;   // dropped where it already is
          await this._clMoveBlockDay(d.id, d.date, fields);
        } else if (d.kind === 'event' && it.recurrence?.freq) {
          // Recurring event: ONE occurrence moves as calendar.js represents it — the series exdates that day and a
          // standalone copy lands on the drop. Copy FIRST and verify; a failed series write deletes the copy again.
          if (!d.date) { this.notify('Drag this occurrence from the week or day view to move it'); return; }
          if (fields.starts_at === (it.all_day ? d.date : d.date + 'T' + this._fmtMin(this._clMin(it.starts_at)))) return;   // dropped where it already is
          const fail = async (msg = 'Failed moving this occurrence. Try again?') => { await this._reloadFor('event'); this.notify(msg); };
          const copy = await this.store.events.add({ title: it.title, notes: it.notes, color: it.color, location: it.location, countdown: it.countdown, all_day: false, ...fields }).catch(() => null);
          if (!copy) return fail();
          const was = { recurrence: it.recurrence }, after = { recurrence: { ...it.recurrence, exdates: [...(it.recurrence.exdates || []), d.date] } };
          // A lost response (cloud patch → null) can hide a write that landed: re-read before rolling back, or the
          // copy goes while the series already skips the day — and the occurrence is gone.
          const landed = await this.store.events.update(it.id, after).catch(() => null)
            || (await this.store.events.get(it.id).catch(() => null))?.recurrence?.exdates?.includes(d.date);
          if (!landed) return fail(await this.store.events.remove(copy.id).catch(() => false) ? undefined : 'Failed moving this occurrence. It may show twice, delete the extra');
          await this._reloadFor('event');
          this._pushEntry('Moved event occurrence', { kind: 'composite', target: 'event', ops: [   // ⌘Z: series back FIRST, then the copy goes
            { kind: 'update', target: 'event', id: it.id, after: was, was: after }, { kind: 'remove', target: 'event', id: copy.id, rows: this._rowsForDelete('event', copy.id) }] });
        } else if (Object.keys(fields).some(k => fields[k] !== it[k])) {   // dropped where it already is: no write, no undo step
          await this.perform('Moved ' + d.kind, { kind: 'update', target: d.kind, id: d.id, after: fields });   // one entry per drop → ⌘Z puts it back
        }
      }
    },
    // task_id → placement ISO (the ONE date fact). Cached on _calDataV — every scheduleItems write bumps it,
    // and it is read once per row in the list pipeline, so rebuilding it per call is not free.
    _placedMap() { void this.scheduleItems; return _memo(_placedMemo, 'p|' + _calDataV, () => placedMap(this.scheduleItems), 1); },
    // THE date a task sits on. The placement is the whole answer for a plain task; recur_from is consulted ONLY
    // for a repeat, where it is the rule anchor rather than a placement; a task with neither follows its repeating project.
    whenOf(t, pm = this._placedMap()) { const lead = this._follows(t, pm); return lead ? this.whenOf(lead, pm) : pm.get(t.id) || (t.recurrence ? t.recur_from : null) || ''; },
    // The repeating project whose date a subtask without its own follows: the nearest repeating ancestor, the set
    // store.js completionPatches reopens. An ancestor with its own date, an archive or a paused repeat ends it.
    _follows(t, pm) {
      if (t.recurrence || t.deadline_at || pm.has(t.id)) return null;
      for (let a = this.byId.get(t.parent_id), hops = 0; a && hops < MAX_DEPTH; a = this.byId.get(a.parent_id), hops++) {
        if (a.recurrence) return recActive(a.recurrence) ? a : null;
        if (a.archived_at || a.deadline_at || pm.has(a.id)) return null;
      }
      return null;
    },
    // DELIBERATE FORK, never merge: whenOf is the SELECTION fact (sort, filters, Reschedule), where a repeat stays its
    // anchor so a slipped one keeps surfacing; whenShown is what the ROW SAYS — today's occurrence, else the anchor
    // while behind (user, tweak-7: "Last Mon"), else the next, at the rule's time. Asked from yesterday so today
    // counts (`inclusive` admits only an anchor ≥ the from-day).
    // from_completion has no next until this one is done: it is the anchor, due today once slipped (counted from
    // now, the row showed where completing lands, so completing never moved it).
    whenShown(t, pm) {
      const lead = this._follows(t, pm); if (lead) return this.whenShown(lead, pm);
      const placed = pm.get(t.id); if (placed || !t.recurrence || !t.recur_from) return placed || '';
      const key = t.recur_from + '|' + JSON.stringify(t.recurrence) + '|' + this._nowDay;
      let v = _nextMemo.get(key);
      if (v === undefined) {
        if (_nextMemo.size > 2000) _nextMemo.clear();
        if (recRules(t.recurrence).some(r => r.from_completion && !r.paused)) v = t.recur_from.slice(0, 10) < this._nowDay ? this._nowDay + t.recur_from.slice(10) : t.recur_from;
        else {
          const from = new Date(); from.setDate(from.getDate() - 1);   // calendar day, not 24h: DST
          const best = nextAcrossRules(t.recurrence, t.recur_from, from, { inclusive: true });
          const behind = t.recur_from.slice(0, 10) < this._nowDay && !(best?.iso <= this._nowDay);
          v = best && !behind ? best.iso + t.recur_from.slice(10) : t.recur_from;   // rule spent → its anchor is all there is
        }
        _nextMemo.set(key, v);
      }
      return v;
    },
    _siOf(id) { return this.scheduleItems.find(x => !x.block_id && x.date && x.task_id === id) || null; },   // that one task's date-item
    // Persist a task's ONE date-item (the composer's ON register, a calendar drop). One composite, CREATE first:
    // a failed remove rolls the new one back, so the old placement is never lost, and ⌘Z puts it back first.
    // No label = silent: the composer already announces the save.
    _schedParts(id, d) {   // a placement's writes; [] when it stands
      if (d.recurrence) return [];   // repeat mode: recur_from IS the rule anchor, not a placement
      const have = this._siOf(id), want = d.on ? { task_id: id, date: d.on.slice(0, 10), start: d.dueTime || null } : null;
      const same = want ? have && have.date === want.date && (have.start || null) === want.start : !have;
      const attach = !!d.block;   // d.block: also attach to that block
      if (same && !attach) return [];
      return [...want && !same ? [{ kind: 'create', target: 'scheduleItem', fields: want }] : [], ...attach ? [{ kind: 'create', target: 'scheduleItem', fields: { task_id: id, block_id: d.block } }] : [],
        ...have && !same ? [{ kind: 'remove', target: 'scheduleItem', id: have.id }] : []];
    },
    async _saveSched(id, d, label, ops, fail = 'Failed scheduling. Try again?') {
      const parts = this._schedParts(id, d); if (!parts.length) return;
      return this.perform(label || (d.on ? 'Scheduled task' : 'Unscheduled task'), { kind: 'composite', target: 'scheduleItem', ops: parts }, { silent: !label, ops, fail });
    },
    // no date at all, newest first; cap for perf
    clUnscheduled() {
      const pm = this._placedMap();
      return this.tasks.filter(t => this._openLeaf(t) && !this.whenOf(t, pm))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 50);
    },
    _overdue(t, b, pm) { const w = this.whenOf(t, pm); return !!w && (timeOf(w) ? w < b.at : w.slice(0, 10) < b.today); },
    // local wall-clock, never UTC
    clReschedule() {
      void this._nowTickV;   // refresh as the clock passes each task's time
      const at = localStamp(new Date()), b = { today: at.slice(0, 10), at }, pm = this._placedMap();
      return this.tasks.filter(t => this._openLeaf(t) && this._overdue(t, b, pm))
        .sort((x, y) => this.whenOf(x, pm).localeCompare(this.whenOf(y, pm)));   // the moment it slipped past
    },
    clSideVisible() { return this.clSideOpen || (this.clView === 'day' && !this.clSideOver); },   // the panel is up in day view (auto) or when toggled — but where it OVERLAYS, auto-opening would bury the day you just opened
    _clRowsHtml(tasks, cache) {
      const now = new Date(), byId = this.byId, def = this.store.defaultProject(), pm = this._placedMap(); let byParent;
      return tasks.map(t => {
        let html = cache.get(t.id); if (html) return { id: t.id, html };
        const w = this.whenOf(t, pm);   // >10 chars only when the placement carries a clock time — that's the timed chip
        html = this._itemLi(this.mkRow(t, 0, byParent ||= buildByParent(this.tasks), byId, def, now, undefined, pm), { drag: ' draggable="true"', proj: true, tray: true, schedTime: w.length > 10 ? this._clTime(w) : null });
        if (!(t.deadline_at?.length > 10)) cache.set(t.id, html);   // a timed deadline counts down by the minute
        return { id: t.id, html };
      });
    },
    // One build per change, shared by the list, its x-if/x-show and its rows. Hidden (panel shut or Plan away):
    // keep the last rows and read no task, so a Lists edit wakes nothing; showing re-runs this.
    clSideRows(kind) {
      const side = _clSideOut[kind]; if (!this.clSideVisible() || this._clHidden()) return side.rows;
      const res = kind === 'res', clock = res ? isoDate(new Date()) + '|' + this._nowTickV : this._nowDay, key = this._rowV + '|' + clock + '|' + this._nowTickV + '|' + this._foldV;   // the tick: re-list for the timed deadlines it left uncached
      if (side.key === key) return side.rows;
      if (_clSideV !== this._rowV) { for (const s of Object.values(_clSideOut)) s.html.clear(); _clSideV = this._rowV; }   // not only patches since: any row may differ
      if (side.clock !== clock) side.html.clear();   // rows read the clock (due and deadline badges)
      return Object.assign(side, { key, clock, rows: this._clRowsHtml(res ? this.clReschedule() : this.clUnscheduled(), side.html) }).rows;
    },
    clRowClick(e) { const el = e.target.closest?.('.item'); const t = el && this.byId.get(el.dataset.id); if (t) this.onRowClick({ t }, e); },
    clSideDragStart(e) { const el = e.target.closest?.('.item'); if (el) this.clDragStart(e, 'task', el.dataset.id); },
    clOpenTaskSide(id) { const t = this.byId.get(id); if (!t) return; this.clSideOpen = true; this.$nextTick(() => this.editTask(t)); },
    clBlockWeekdays: [{ d: 0, l: 'S' }, { d: 1, l: 'M' }, { d: 2, l: 'T' }, { d: 3, l: 'W' }, { d: 4, l: 'T' }, { d: 5, l: 'F' }, { d: 6, l: 'S' }],
    clNewBlock(date, start, end) { this.blockEdit = { date: date || isoDate(this._clAt()), start: start || '09:00', end: end || '10:00', all_day: false, weekdays: [], location_id: null, areas: [], color: null, title: '', est_minutes: null }; },
    clEditBlock(id, viewIso) {
      const b = this.blocks.find(x => x.id === id); if (!b) return;
      const start = timeOf(b.starts_at, '09:00'), end = timeOf(b.ends_at, '10:00'), bd = this.clBlockDay(b.id, viewIso), p = plannedOf(bd);
      // Occurrence⇄rule duality: opened from one of its days, the When fields are THAT day (occ) and move it alone;
      // the series' own times ride the Repeat row (rule) and move every day.
      const occ = b.recurrence && viewIso && !b.all_day ? { date: (bd?.planned_start || bd?.actual_start || viewIso).slice(0, 10), start: timeOf(p?.[0] || '', start), end: timeOf(p?.[1] || '', end) } : null;
      this.blockEdit = { id: b.id, title: b.title || '', date: b.starts_at.slice(0, 10), start, end, ...occ, occ, rule: { start, end }, all_day: !!b.all_day, span: this._adSpan(b),
        weekdays: (b.recurrence?.weekdays || []).slice(), location_id: b.location_id || null, areas: (b.areas || []).slice(), color: b.color || null, est_minutes: b.est_minutes ?? null,
        viewIso: viewIso || null };
    },
    // ONE day of a repeating block moves by an override keyed on its own day (src) — drag and editor alike, never the series.
    async _clMoveBlockDay(id, src, { starts_at, ends_at }, ops) {
      // A started occurrence stays where it happened.
      if (this.clStarted(id, src)) return this.notify('Already started this occurrence. Undo it to move it');
      // A skip answers the DAY it was given: carried to another day it would arrive pre-answered on a day the
      // user never answered. Cleared in the SAME write, so one ⌘Z restores both the day and the answer.
      await this.clSetBlockDay(id, { planned_start: starts_at, planned_end: ends_at, ...(src !== starts_at.slice(0, 10) && { status: 'pending' }) }, src, 'Moved block occurrence', ops);
    },
    async clSaveBlock() {
      const e = this.blockEdit; if (!e) return;
      const b = this.blocks.find(x => x.id === e.id), o = e.occ, moved = o && (e.date !== o.date || e.start !== o.start || e.end !== o.end);
      const s = o ? { ...e, date: b.starts_at.slice(0, 10), ...e.rule } : e;   // opened on one day: the series keeps its anchor and takes the Repeat row's times
      // the Repeat row only authors weekly rules: one it can't (daily, every 2 weeks, exdates) survives a save that leaves its days alone
      const wds = e.weekdays.slice().sort((a, b) => a - b), rule = b?.recurrence, keep = rule && `${wds}` === `${(rule.weekdays || []).slice().sort((a, b) => a - b)}`;
      let date = s.date, recurrence = keep ? rule : wds.length ? { freq: 'week', interval: 1, weekdays: wds } : null;
      if (recurrence?.weekdays?.length) {   // weekly: anchor on the first selected weekday on/after the chosen date so expansion is correct
        const d0 = new Date(date + 'T00:00');
        for (let i = 0; i < 7 && !recurrence.weekdays.includes(d0.getDay()); i++) d0.setDate(d0.getDate() + 1);
        date = isoDate(d0);
      }
      const est_minutes = e.est_minutes === '' || e.est_minutes == null ? null : +e.est_minutes;
      const core = { title: e.title.trim(), all_day: e.all_day, recurrence, location_id: e.location_id || null, areas: e.areas, color: e.color || null, est_minutes, ...this._evRange(s, date) };
      if (e.id) {
        const j = [];   // journaled by hand: the series and the day land as ONE entry, one ⌘Z takes back both
        if (Object.keys(core).some(k => JSON.stringify(core[k]) !== JSON.stringify(b?.[k] ?? null))
          && !await this._journalRowChange('Edited block', 'block', e.id, () => this.store.blocks.update(e.id, core).catch(() => null), { ops: j, fail: 'Failed saving block. Try again?' })) return;   // the editor stays open, edits intact
        if (moved) await this._clMoveBlockDay(e.id, e.viewIso, this._evRange(e), j);
        if (j.length) this._pushEntry(j.length > 1 ? 'Edited block' : j[0][0], j.length > 1 ? { kind: 'composite', target: 'block', ops: j.map(x => x[1]).reverse() } : j[0][1]);
      } else {
        const b = await this.store.blocks.add(core);
        await this._reloadFor('block');
        if (!b) return this.toast('Failed saving “Added block”. Try again?');   // the editor stays open, edits intact
        this._pushEntry('Added block', { kind: 'remove', target: 'block', id: b.id, rows: this._rowsForDelete('block', b.id, b) });   // b: the re-read may have failed
      }
      this.blockEdit = null;
    },
    async clDeleteBlock() { const b = this.blocks.find(x => x.id === this.blockEdit?.id); if (!b || await this.perform('Deleted block', { target: 'block', kind: 'delete', id: b.id })) this.blockEdit = null; },   // a failed delete keeps the editor and its edits
    clBlockPreset(p) {
      const pre = { work: { title: 'Work', start: '08:15', end: '16:30', weekdays: [1,2,3,4,5], est_minutes: null }, lunch: { title: 'Lunch', start: '12:00', end: '13:00', weekdays: [1,2,3,4,5], est_minutes: 15 }, evening: { title: 'Evening', start: '18:00', end: '22:00', weekdays: [], est_minutes: null } }[p];
      if (!pre || !this.blockEdit) return;
      Object.assign(this.blockEdit, pre);
    },
    clAttachedTasks() { const id = this.blockEdit?.id; if (!id) return []; return this.scheduleItems.filter(s => s.block_id === id); },
    clCycleRole(itemId) {   // silent: a quick repeated tap, ⌘Z still steps back
      const item = this.scheduleItems.find(x => x.id === itemId);
      if (item) return this.perform('Changed role', { kind: 'update', target: 'scheduleItem', id: itemId, after: { role: { before: 'during', during: 'after', after: 'before' }[item.role] || 'during' } }, { silent: true });
    },
    clRemoveAttached(itemId) { return this.perform('Detached task', { kind: 'remove', target: 'scheduleItem', id: itemId }); },

    // --- Block day (start-ask answered from the web; the phone writes the same rows) ---
    // A repeating block draws one instance PER DAY, so the status has to be looked up for THAT day. Defaulting
    // to today made Monday's run-state light up every Tuesday, next week and last week too — the block editor is
    // the only caller that genuinely means "today", and it's the one that omits the date.
    clBlockDay(blockId, iso) { const d = iso || isoDate(new Date()); return this.blockDays.find(x => x.block_id === blockId && x.date === d) || null; },
    async clSetBlockDay(blockId, fields, iso, label, ops) {
      iso ||= isoDate(new Date());   // callers pass blockEdit.viewIso, which is NULL outside a calendar chip — and a default only catches undefined
      const prev = this.clBlockDay(blockId, iso);
      // ONE row carries the whole per-occurrence answer (day-move included), so there is nothing to delete first —
      // a failed write (null) leaves the occurrence exactly where it was, and we say so.
      const row = await this.store.blockDays.set({ block_id: blockId, date: iso, ...fields });
      await this._reloadFor('blockDay');   // reloads blockDays + bumps _calDataV so clBlocks() memo busts and DOM repaints
      const cur = this.clBlockDay(blockId, iso);
      // a lost response (cloud upsert → null) can hide a write that landed: the re-read says which
      if (!row && !(cur && Object.keys(fields).every(k => (cur[k] ?? null) === (fields[k] ?? null)))) return this.toast('Failed updating this day. Try again?');
      if (!cur?.id) return;
      const lbl = label ?? ({ running: 'Started block', skipped: 'Skipped block', done: 'Stopped block', missed: "Marked didn't happen" }[fields.status] || 'Undid block day');
      const rollback = Object.fromEntries(Object.keys(fields).map(k => [k, prev?.[k] ?? (k === 'status' ? 'pending' : null)]));
      const op = { kind: 'update', target: 'blockDay', id: cur.id, after: rollback, was: fields };
      if (Object.keys(rollback).length) ops ? ops.push([lbl, op]) : this._pushEntry(lbl, op);
    },
    // The Start/Skip panel says "today", so it may only appear for the occurrence that LIVES today — the one you
    // opened, wherever its row is keyed. A chip moved onto today counts; today's own, moved away, no longer does.
    // A passed day still running gets it too — for its Undo.
    clDayPanel(b, iso) {
      const bd = b && iso && this.clBlockDay(b.id, iso);
      const today = isoDate(new Date());
      return !b ? false : !iso ? !b.all_day && blocksInRange([b], today, today, this.blockDays).some(x => x.start >= today) : (bd?.planned_start || bd?.actual_start || iso).slice(0, 10) === today || this.clUnended(bd);
    },
    clUnended(bd) { return unended(bd, bd && this.blocks.find(b => b.id === bd.block_id), isoDate(new Date())); },
    clStarted(blockId, iso) { return ['running', 'done'].includes(this.clBlockDay(blockId, iso)?.status); },
    // What "Reset this day" would undo: a time nudge, or a whole day-move (named, so the note isn't a lie). Never offered
    // once started: Reset clears actual_* too (a legacy plan's home), which would erase the start and leave it running.
    clOverrideNote(blockId, iso) {
      const a = plannedOf(this.clBlockDay(blockId, iso))?.[0];
      return !a || this.clStarted(blockId, iso) ? '' : a.slice(0, 10) === iso ? 'Time adjusted for this day'
        : 'Moved to ' + new Date(a.slice(0, 10) + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    },
    // These three answer ONE occurrence — the one on screen (iso), not whichever of them today happens to hold.
    // Start records the real clock time on the day that occurrence now LIVES, so starting it never un-moves it.
    // A plan still living in actual_* (legacy) moves to planned_* in the same write, so the clock can't take it.
    // ceiling: the actual_* → planned_* move here pairs with plannedOf's legacy branch; delete both once LocalStore migrates them
    clStartBlock(blockId, iso) {
      const n = new Date(), bd = this.clBlockDay(blockId, iso), p = plannedOf(bd);
      return this.clSetBlockDay(blockId, { status: 'running', actual_start: (p?.[0] || iso || isoDate(n)).slice(0, 10) + localStamp(n).slice(10),
        ...p && p[0] === bd.actual_start && { planned_start: p[0], planned_end: p[1] } }, iso);
    },
    clSkipBlock(blockId, iso) { return this.clSetBlockDay(blockId, { status: 'skipped' }, iso); },
    // `missed` is ANSWERED, never inferred (auto-closing would ash every block you didn't press a button on), and only
    // once the occurrence's planned end has gone by: before that "didn't happen" is a guess about the future.
    clBlockEnded(blockId, iso) { void this._nowTickV; const n = new Date(), d = iso || isoDate(n);   // the tick: an open editor offers it once the end goes by
      const end = plannedOf(this.clBlockDay(blockId, d))?.[1] || blocksInRange(this.blocks.filter(b => b.id === blockId), d, d, this.blockDays).find(x => x.src === d)?.planned;
      return !!end && end <= localStamp(n); },
    // Stop records the stop moment itself — its own date too, so a Stop drawn before midnight and clicked after it never
    // ends before it started. Only offered while the day it lives is today: a passed day's end isn't today's clock.
    clStopBlock(blockId, iso) { return this.clSetBlockDay(blockId, { status: 'done', actual_end: localStamp(new Date()) }, iso); },
    // Only a START clears actual_* (actual_end with it: orphaned, it stretched a 1-hour block down to midnight) —
    // on a skipped day they can hold a legacy move, and a skip's undo must not erase it.
    // A DONE day's Undo takes back the stop only (as ⌘Z does), back to running.
    clUndoBlockDay(blockId, iso) {
      if (this.clBlockDay(blockId, iso)?.status === 'done') return this.clSetBlockDay(blockId, { status: 'running', actual_end: null }, iso, 'Undid stop');
      return this.clSetBlockDay(blockId, { status: 'pending', ...this.clStarted(blockId, iso) && { actual_start: null, actual_end: null } }, iso);
    },
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
    async _migrateNotes() {
      // One-shot: things under a root 'Notes' project become task_type 'note' (the root stays a project; 'steps' there was a note too; another type is kept).
      // ceiling: a done-key read every boot and a fixed cutoff; delete both once every device has booted past 2026-10-06
      const key = 'adherod.notesMigrated.' + (this._acct() ?? 'local');
      if (localStorage.getItem(key) || this._loadFailed) return;   // a failed load holds no rows to judge by: retry next boot
      const underNotes = t => { let r = t; for (let d = 0; r?.parent_id && d < 200; d++) r = this.byId.get(r.parent_id); return !!r && !r.parent_id && r.content?.trim().toLowerCase() === 'notes'; };
      // The done-key is per device: a row touched since the release (another device migrated it, then the user chose otherwise) is the user's.
      const cutoff = Date.parse('2026-10-06T00:00:00Z');
      const due = t => !!t?.parent_id && (t.task_type == null || t.task_type === 'steps') && Date.parse(t.updated_at) < cutoff && underNotes(t);
      const todo = this.tasks.filter(due);
      // ceiling: one store update (~2 cloud round trips) per row, off the boot path; add a bulk tasks write if a Notes tree past ~200 rows is reported slow
      let ok = true;
      for (const t of todo) if (due(this.byId.get(t.id)) && !await this.store.tasks.update(t.id, { task_type: 'note' })) ok = false;   // live sync can move or retype it mid-run
      if (ok) localStorage.setItem(key, '1');   // a failed write retries next boot
      if (todo.length) await this.loadTasks();
    },

    async reloadAll(quiet) {
      const store = this.store, gen = ++this._loadGen;
      // ONE parallel round-trip set (cloud): the whole account in a single query + the two side lists
      const [b, si, bd, rem, dn] = await Promise.allSettled([store.bootstrap(), store.scheduleItems.list(), store.blockDays.list(), store.reminders.list(), store.dayNotes.list()]);
      if (b.value) await this._loadFiles(b.value.tasks.flatMap(t => t.attachments ?? []));   // as loadTasks
      if (gen !== this._loadGen) return;   // superseded — by the minute retry or a reconnect's 'all'
      // What landed is applied; a failed part keeps its last good state and stays unloaded in the store, so it's re-pulled.
      const failed = !b.value || !si.value || !bd.value || !rem.value;
      if (failed && !this._loadFailed && !quiet) this.toast('Couldn’t load, retrying');
      this._loadFailed = failed;
      // ALL awaits above, ONE synchronous block below: Alpine flushes effects during an await, so a reactive
      // write followed by an awaited gap ran renders against the OLD memo keys — and the version bumps after
      // the gap are module-scope, so nothing re-woke (month chips stayed stale after an event edit).
      this._rowV++; _calDataV++;   // bust memos before the reactive writes so the flush sees fresh keys
      if (si.value) this.scheduleItems = si.value; if (bd.value) this.blockDays = bd.value; if (rem.value) this.reminders = rem.value;
      if (dn.value) this.dayNotes = dn.value;   // not in `failed`: a DB without the table must run, not retry every minute
      const d = b.value; if (!d) return;
      this.areas = d.areas; this._pruneQfAreas();
      this.tasks = d.tasks; this.byId = new Map(d.tasks.map(t => [t.id, t])); this.parentIds = new Set(d.tasks.map(t => t.parent_id).filter(Boolean));   // ← list renders (reactive) from here
      this.filters = d.filters; this.locations = d.locations;
      if (this.navSel.type === 'filter' && !this.activeFilter()) this.setNav('backlog');   // as loadFilters: its filter went
      if (this.navSel.type === 'project' && !this.byId.has(this.navSel.id)) this.setNav('all');   // as loadTasks: its project went
      this.events = d.events; this.blocks = d.blocks;
      this.homeLocationId = this.store.homeLocationId(); this.currentRegion = this.store.currentRegion();
      this._defId = this.store.defaultProject();
      this.colorTheme = savedColorTheme(this.store.theme());
      applyTheme(this.theme, this.colorTheme);
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
    // Another account (or none) reloads: boot picks the store from the saved session, so no save still running on this page
    // can land in the next account. this.session stays until then: pagehide files the draft and journal under this account.
    async onAuth(session) {
      if ((session?.user?.id ?? null) === this._acct()) { this.session = session; return; }   // Supabase re-emits SIGNED_IN on every tab focus: same uid, a fresh token
      // Requests already sent land and journal first: idle = no request across one tick, so an action's next step gets its turn.
      // ceiling: a chained action's steps sent after another account takes the shared session are refused (the token switches
      // with or without a reload), and past 3s the reload cuts the rest; revisit when chained actions become one server-side request
      for (let idle = 0, end = Date.now() + 3000; idle < 2 && Date.now() < end;) { idle = _inFlight ? 0 : idle + 1; await new Promise(r => setTimeout(r)); }
      location.reload();
    },
    // realtime → app: the channel names the kind that changed, and it re-reads exactly that list. Same map as
    // our own writes use, so a remote change and a local one leave the app in the same state.
    _subscribeStore() { this.store.subscribe?.(kind => this._reloadFor(kind)); },
    async signOut() { const sb = sbClient(); if (sb) await sb.auth.signOut(); },   // onAuthStateChange → onAuth(null)

    // --- Account & settings popup (corner gear). Sign-in/phone reuse the auth machine above; surfaces + theme persist locally. ---
    settingsOpen: false,
    online: navigator.onLine,         // gear status dot + account-row sub (listeners live on the popup markup)
    updateUrl: null,                  // Windows app only: a newer installer's download → gear arrow + "Update available" row
    desk: null,                       // Windows app only: the sticky note's Settings switches, { on, share } (desktop/main.cpp)
    setDesk(key, v) { this.desk[key] = v; desktopWindow('desk', key, v); },
    theme: savedAppearance(),
    colorTheme: savedColorTheme(),
    themeColors: THEME_COLORS,
    // Wipe this device's local copy and reload — the escape hatch when local storage is stale (e.g. a re-seeded
    // demo won't overwrite existing data). Signed-in accounts re-sync from the cloud; local-only data is gone.
    resetLocalData() {
      let local = 0;   // signed in, the wipe also takes what the cloud never had: signed-out tasks, the Bin, unsaved drafts
      try { const def = JSON.parse(localStorage.getItem('adherod.meta'))?.default_project_id; local = JSON.parse(localStorage.getItem('adherod.tasks') || '[]').filter(t => t.id !== def).length; } catch {}   // not the seeded Backlog; catch: a broken store's escape hatch still opens
      const all = trashView(this.journal, Date.now()), smallDays = new Set(all.filter(e => e.kind === 'small').map(e => new Date(e.ts).setHours(0, 0, 0, 0)));   // every account's: jWipe clears the whole journal
      const bin = all.filter(e => e.kind !== 'small').length + smallDays.size, drafts = Object.keys(this._pendingMap()).length;   // a day's small changes are one row, as trashDays shows them
      const also = [local && `${this._nTasks(local)} saved on this device while signed out`, bin && `${bin} item${bin === 1 ? '' : 's'} in the Bin`, drafts && `${drafts} unsaved draft${drafts === 1 ? '' : 's'}`].filter(Boolean);
      this.askConfirm({
        message: this.session
          ? "Clear this device's local copy? Your account data stays in the cloud and re-syncs when the page reloads." + (also.length ? ` Also deletes ${new Intl.ListFormat('en').format(also)}.` : '')
          : "Delete everything stored on this device? This can't be undone.",
        confirmLabel: 'Delete', danger: true,
        onConfirm: async () => {
          _wiping = true;
          clearTimeout(_draftT);   // a slow reload would let the draft autosave write back what was just wiped
          try { await jWipe(); } catch { _wiping = false; return this.toast('Failed deleting the Bin and undo history. Nothing was deleted. Try again?'); }
          _jBus.postMessage(0);   // every tab drops what it held from before
          for (const k of Object.keys(localStorage)) if (k.startsWith('adherod.')) localStorage.removeItem(k);
          location.reload();
        },
      });
    },
    setTheme(t) {
      this.theme = t;
      t === 'system' ? localStorage.removeItem('adherod.theme') : localStorage.setItem('adherod.theme', t);
      applyTheme(t, this.colorTheme);
    },
    async setColorTheme(id) {
      if (!THEME_COLORS.some(t => t.id === id)) return;
      this.colorTheme = id;
      localStorage.setItem('adherod.colorTheme', id);
      applyTheme(this.theme, id);
      if (!(await this.store.setTheme(id)) && this.colorTheme === id) this.notify('Theme saved locally; account default could not sync.');
    },
  }));
});
