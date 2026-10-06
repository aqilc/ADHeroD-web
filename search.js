// uFuzzy ranking + the AQL query language.
import uFuzzy from './vendor/uFuzzy.esm.js';
import { parseDate, isoDate, impRank } from './nlp.js';
import { esc } from './ui.js';

const SEP = '';   // field separator: a word boundary uFuzzy won't match across, kept out of display

export const makeFuzzy = () => new uFuzzy({ intraMode: 1 });

// ranked index array or null when no match (used by pickerMatches + areaMatches)
export const fuzzyRank = (uf, hay, q) => {
  const [idxs, info, order] = uf.search(hay, q, 1, 1e4);
  if (!idxs || !idxs.length) return null;
  return (info && order) ? order.map(o => info.idx[o]) : idxs;
};

// A task's typed text past its title: description · checklist (a step's `::` description rides in its text) · legacy free-text place.
export const bodyText = t => [t.notes || '', (t.checklist || []).map(c => c.text).join(' '), t.place || ''].join(SEP);

// field order = rank order: title · areas · places · path · description · checklist · place
export function buildSearchDocs(tasks, areas, defaultProjectId, locations = []) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const areaMap = new Map(areas.map(g => [g.id, g.name]));
  const areaName = id => areaMap.get(id) || '';
  const placeMap = new Map(locations.map(l => [l.id, l.name]));
  const pathOf = t => { const parts = []; let cur = t; const seen = new Set(); while (cur && !seen.has(cur.id)) { seen.add(cur.id); parts.unshift(cur.content); cur = byId.get(cur.parent_id); } return parts.join(' / '); };
  const haystack = [], meta = [];
  for (const t of tasks) {
    if (t.id === defaultProjectId) continue;
    const title = t.content || '';
    if (t.overview) {
      haystack.push([title, pathOf(t), t.parent_id ? bodyText(t) : ''].join(SEP));   // a top-level project's body is shown nowhere
      meta.push({ id: t.id, type: 'project', completed: !!t.completed_at, titleLen: title.length, title });
      continue;
    }
    const areaNames = (t.area_ids || []).map(areaName).join(' ');
    const parent = byId.get(t.parent_id);
    const path = parent && parent.id !== defaultProjectId ? pathOf(parent) : '';
    const places = (t.location?.ids || []).map(id => placeMap.get(id) || '').join(' ');
    haystack.push([title, areaNames, places, path, bodyText(t)].join(SEP));
    meta.push({ id: t.id, type: 'task', completed: !!t.completed_at, titleLen: title.length, title });
  }
  for (const g of areas) {
    haystack.push(g.name || '');
    meta.push({ id: g.id, type: 'area', completed: false, titleLen: (g.name || '').length, title: g.name || '' });
  }
  return { haystack, meta };
}

// tier: 0 exact title, 1 title starts with query, 2 title contains query, 3 fuzzy hit inside title, 4 match only outside title
const titleTier = (title, ql, ranges, titleLen) => {
  const t = (title || '').toLowerCase();
  if (t === ql) return 0;
  if (t.startsWith(ql)) return 1;
  if (t.includes(ql)) return 2;
  if (ranges.length && ranges[0] < titleLen) return 3;
  return 4;
};

// completed tasks partitioned to the bottom; within each block: title-tier, then overview projects/areas over tasks, then uFuzzy order/shorter title
export function rankDocs(uf, haystack, meta, query, limit = 50) {
  const q = (query || '').trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const [idxs, info, order] = uf.search(haystack, q, 1, 1e4);
  if (!idxs || !idxs.length) return [];
  const ranked = (info && order)
    ? order.map(oi => ({ ...meta[info.idx[oi]], ranges: info.ranges[oi] || [] }))
    : idxs.map(i => ({ ...meta[i], ranges: [] }));
  const cmp = (a, b) => titleTier(a.title, ql, a.ranges, a.titleLen) - titleTier(b.title, ql, b.ranges, b.titleLen)
    || (a.type === 'task') - (b.type === 'task') || a.titleLen - b.titleLen;
  const open = ranked.filter(r => !r.completed).sort(cmp), done = ranked.filter(r => r.completed).sort(cmp);
  return [...open, ...done].slice(0, limit);
}

// recents first, then open, then completed; ranges always []
export function defaultDocs(meta, recentIds = [], limit = 50) {
  const byId = new Map(meta.map(m => [m.id, m]));
  const seen = new Set(), out = [];
  for (const id of recentIds) { const m = byId.get(id); if (m && !seen.has(id)) { seen.add(id); out.push({ ...m, ranges: [] }); } }
  const rest = meta.filter(m => !seen.has(m.id));
  for (const m of [...rest.filter(m => !m.completed), ...rest.filter(m => m.completed)]) out.push({ ...m, ranges: [] });
  return out.slice(0, limit);
}

// only ranges within [0, titleLen) — area/path ranges excluded
// open/close: wrap tokens (default <mark>); escape=false skips esc() for sentinel-mark-then-render flows
export function markTitle(title, ranges, titleLen, open = '<mark>', close = '</mark>', escape = true) {
  const t = title || '', e = s => escape ? esc(s) : s;
  if (!ranges || !ranges.length) return e(t);
  let out = '', pos = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const a = ranges[i]; let b = ranges[i + 1];
    if (a >= titleLen) break;
    b = Math.min(b, titleLen);
    if (a < pos) continue;
    out += e(t.slice(pos, a)) + open + e(t.slice(a, b)) + close;
    pos = b;
  }
  return out + e(t.slice(pos));
}

// --- AQL query language (merged from query.js) ---

const TOKEN_RE = /[^\s()"]*"[^"]*"|[^\s()"]+|[()]/g;
const EMPTY_SET = new Set();
const unq = s => s.replace(/^"(.*)"$/, '$1');
export function tokenize(str) { return String(str || '').match(TOKEN_RE) || []; }

export const KEYS = ['importance', 'due', 'deadline', 'is', 'in'];
function leaf(t) {
  if ((t[0] === '-' || t[0] === '!') && t.length > 1) return { op: 'not', kid: leaf(t.slice(1)) };
  if (t[0] === '#') { const sub = t[1] === '#'; return { q: 'project', sub, val: unq(t.slice(sub ? 2 : 1)) }; }
  if (t[0] === '@') return { q: 'area', val: unq(t.slice(1)) };
  const c = t.indexOf(':');
  if (c > 0) { const k = t.slice(0, c).toLowerCase(); if (KEYS.includes(k)) return { q: k === 'importance' ? 'imp' : k, val: unq(t.slice(c + 1)).toLowerCase() }; }
  return { term: unq(t).toLowerCase() };
}
// importance:must|focus|none|someday (comma-separated OR); absent flag reads as 'none'
const impMatch = (imp, spec) => spec.split(',').includes(imp || 'none');

// Tiny recursive descent: or → and → not → atom. OR loosest, NOT tightest. Never throws.
export function parseQuery(str) {
  const tk = tokenize(str); let i = 0;
  const at = () => tk[i];
  const isOr = t => t === '|' || (t && t.toLowerCase() === 'or');
  const isAnd = t => t === '&' || (t && t.toLowerCase() === 'and');
  const isNot = t => t === '!' || (t && t.toLowerCase() === 'not');
  const or = () => { let n = and(); while (isOr(at())) { i++; n = { op: 'or', kids: [n, and()] }; } return n; };
  const and = () => { let n = not(); while (at() != null && at() !== ')' && !isOr(at())) { if (isAnd(at())) i++; n = { op: 'and', kids: [n, not()] }; } return n; };
  const not = () => { if (isNot(at())) { i++; return { op: 'not', kid: not() }; } return atom(); };
  const atom = () => { const t = at(); if (t === '(') { i++; const n = or(); if (at() === ')') i++; return n; } if (t == null || t === ')') { i++; return { term: '' }; } i++; return leaf(t); };
  return or() || { term: '' };
}
// The Lists quick filters + lenses as AQL ("Save as filter"): the rows qfPass + the lenses keep among top-level tasks.
// areas are names; overdue is is:overdue (open only), like the live filter.
// ceiling: the live view filters top-level tasks and shows their subtrees, a filter matches at any depth; project/Backlog
// scope and search text aren't saved — revisit when a saved filter must reproduce those views.
// scope: the area the view sits in, or null.
export function qfQuery({ imp, areas, due, done, archived, scope }) {
  const name = n => '@' + (/[\s()]/.test(n) ? `"${n}"` : n), parts = scope ? [name(scope)] : [], at = areas.map(name);
  if (imp.length) parts.push('importance:' + imp.join(','));
  if (at.length) parts.push(at.length > 1 ? `(${at.join(' OR ')})` : at[0]);
  if (due) parts.push(due === 'overdue' ? 'is:overdue' : 'due:' + (due === 'has' ? 'any' : due));
  if (done || archived) parts.push(done && archived ? 'is:any' : done ? '(is:open OR is:done)' : 'is:any (is:open OR is:archived)');   // is:any lifts the done gate: a done+archived task is archived first, as in the live view
  return parts.join(' ');
}

const todayISO = now => isoDate(new Date(now));
function resolveDate(word, now) {
  const w = (word || '').trim().toLowerCase(), d = new Date(now); d.setHours(0, 0, 0, 0);
  const add = n => { const x = new Date(d); x.setDate(x.getDate() + n); return isoDate(x); };
  if (w === 'sow') return add(-d.getDay());
  if (w === 'eow') return add(6 - d.getDay());
  if (w === 'som') return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
  if (w === 'eom') return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const m = w.match(/^([+-]\d+)d$/); if (m) return add(+m[1]);
  return parseDate(word, d) || null;   // d, not now: the stores pass now as ISO text
}
function cmpDate(iso, spec, now) {
  const has = !!iso, day = has ? iso.slice(0, 10) : null;
  if (spec === 'none') return !has;
  if (spec === 'any') return has;
  if (!has) return false;
  if (spec === 'overdue') return day < todayISO(now);
  if (spec === 'today') return day === todayISO(now);
  if (spec.includes('..')) { const [a, b] = spec.split('..').map(s => resolveDate(s, now)); return !!a && !!b && day >= a && day <= b; }
  const m = spec.match(/^(>=|<=|>|<|=)(.+)$/);
  if (m) { const v = resolveDate(m[2], now); if (!v) return false; const op = m[1]; return op === '=' ? day === v : op === '>' ? day > v : op === '>=' ? day >= v : op === '<' ? day < v : day <= v; }
  const v = resolveDate(spec, now); return v ? day === v : false;
}

function walk(n, fn) { if (!n) return; fn(n); if (n.kids) n.kids.forEach(k => walk(k, fn)); if (n.kid) walk(n.kid, fn); }

export function matchQuery(query, tasks, ctx) {
  const ast = typeof query === 'string' ? parseQuery(query) : query;
  // `due:` asks about the date a task SITS on — its placement (ctx.placed, from the caller's date-items).
  // recur_from is only a recurrence anchor now, so it answers for repeats and nothing else.
  const when = t => ctx.placed?.get(t.id) || (t.recurrence ? t.recur_from : null) || '';
  const byId = new Map(tasks.map(t => [t.id, t]));
  const hasChild = new Set(tasks.map(t => t.parent_id).filter(Boolean));
  let scope = null; walk(ast, n => { if (n.q === 'in') scope = n.val; });
  const termSets = {}; walk(ast, n => { if (n.term != null && n.term !== '' && !(n.term in termSets)) termSets[n.term] = ctx.freeText(n.term, scope); });
  const projCache = {};
  const projIds = name => projCache[name] || (projCache[name] = new Set(tasks.filter(t => t.overview && t.id !== ctx.defaultProjectId && (t.content || '').toLowerCase().includes(name.toLowerCase())).map(t => t.id)));
  const inProject = (t, name, sub) => { const ps = projIds(name); if (!sub) return ps.has(t.parent_id); let c = byId.get(t.parent_id), seen = new Set(); while (c && !seen.has(c.id)) { if (ps.has(c.id)) return true; seen.add(c.id); c = byId.get(c.parent_id); } return false; };
  // @: an exact name (any case) wins, else every name it prefixes — never a substring, so @Work never takes Homework
  const areaIds = name => {
    const n = name.toLowerCase(), lc = ctx.areas.map(a => [a.id, a.name.toLowerCase()]), exact = lc.filter(([, l]) => l === n);
    return new Set((exact.length ? exact : lc.filter(([, l]) => l.startsWith(n))).map(([id]) => id));
  };
  const today = todayISO(ctx.now), open = t => !t.completed_at && !t.archived_at;
  const flags = {   // once per query: compile picks one per is: leaf
    done: t => !!t.completed_at, open, archived: t => !!t.archived_at, any: () => true,
    recurring: t => !!t.recurrence, project: t => !!t.overview, leaf: t => !hasChild.has(t.id),
    must: t => t.importance === 'must', focus: t => t.importance === 'focus', someday: t => t.importance === 'someday',
    daily: t => t.recurrence?.freq === 'day', weekly: t => t.recurrence?.freq === 'week',
    monthly: t => t.recurrence?.freq === 'month', yearly: t => t.recurrence?.freq === 'year',
    blocked: t => (t.blocked_by || []).some(id => { const b = byId.get(id); return b && open(b); }),
    overdue: t => { const day = when(t).slice(0, 10); return !!day && day < today && open(t); },
    today: t => { const day = when(t).slice(0, 10); return !!day && day === today; },
  };
  const compile = n => {
    if (n.op === 'or') { const k = n.kids.map(compile); return t => k.some(f => f(t)); }
    if (n.op === 'and') { const k = n.kids.map(compile); return t => k.every(f => f(t)); }
    if (n.op === 'not') { const f = compile(n.kid); return t => !f(t); }
    if (n.term != null) { if (n.term === '') return () => true; const s = termSets[n.term] || EMPTY_SET; return t => s.has(t.id); }
    if (n.q === 'project') return t => inProject(t, n.val, n.sub);
    if (n.q === 'area') { const ids = areaIds(n.val); return t => (t.area_ids || []).some(id => ids.has(id)); }   // resolved once per leaf
    if (n.q === 'imp') return t => impMatch(t.importance, n.val);
    if (n.q === 'due') return t => cmpDate(when(t), n.val, ctx.now);
    if (n.q === 'deadline') return t => cmpDate(t.deadline_at, n.val, ctx.now);
    if (n.q === 'in') return () => true;
    if (n.q === 'is') return flags[n.val] || (() => false);
    return () => true;
  };
  let includeDone = false, includeArchived = false, wantProject = false;
  walk(ast, n => { if (n.q === 'is' && (n.val === 'done' || n.val === 'any')) includeDone = true; if (n.q === 'is' && (n.val === 'archived' || n.val === 'any')) includeArchived = true; if (n.q === 'is' && n.val === 'project') wantProject = true; });
  const pred = compile(ast);
  // Archived excluded by default (like completed); surfaced only via is:archived / is:any.
  const res = tasks.filter(t => t.id !== ctx.defaultProjectId && (includeDone || !t.completed_at) && (includeArchived || !t.archived_at) && (wantProject || !t.overview) && pred(t));
  const keyed = res.map(t => [[t.completed_at ? 1 : 0, when(t).slice(0, 10) || '9999', impRank(t.importance)].join('|'), t.id]);   // key once per task, not per comparison
  return keyed.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(k => k[1]);
}
