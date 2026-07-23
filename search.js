import uFuzzy from './vendor/uFuzzy.esm.js';
import { parseDate, isoDate } from './nlp.js';

const SEP = '';   // field separator: a word boundary uFuzzy won't match across, kept out of display

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const makeFuzzy = () => new uFuzzy({ intraMode: 1 });

// ranked index array or null when no match (used by pickerMatches + resolveArea)
export const fuzzyRank = (uf, hay, q) => {
  const [idxs, info, order] = uf.search(hay, q, 1, 1e4);
  if (!idxs || !idxs.length) return null;
  return (info && order) ? order.map(o => info.idx[o]) : idxs;
};

// field order = rank priority: title · areas · path · notes · checklist
export function buildSearchDocs(tasks, areas, defaultProjectId) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const areaName = id => (areas.find(g => g.id === id) || {}).name || '';
  const pathOf = t => { const parts = []; let cur = t; const seen = new Set(); while (cur && !seen.has(cur.id)) { seen.add(cur.id); parts.unshift(cur.content); cur = byId.get(cur.parent_id); } return parts.join(' / '); };
  const haystack = [], meta = [];
  for (const t of tasks) {
    if (t.id === defaultProjectId) continue;
    const title = t.content || '';
    if (t.sidebar) {
      haystack.push(title + SEP + pathOf(t));
      meta.push({ id: t.id, type: 'project', completed: !!t.completed_at, titleLen: title.length });
      continue;
    }
    const areaNames = (t.area_ids || []).map(areaName).join(' ');
    const parent = byId.get(t.parent_id);
    const path = parent && parent.id !== defaultProjectId ? pathOf(parent) : '';
    const checklist = (t.checklist || []).map(c => c.text).join(' ');
    haystack.push([title, areaNames, path, t.notes || '', checklist].join(SEP));
    meta.push({ id: t.id, type: 'task', completed: !!t.completed_at, titleLen: title.length });
  }
  for (const g of areas) {
    haystack.push(g.name || '');
    meta.push({ id: g.id, type: 'area', completed: false, titleLen: (g.name || '').length });
  }
  return { haystack, meta };
}

// completed tasks partitioned to the bottom, relevance preserved within each block
export function rankDocs(uf, haystack, meta, query, limit = 50) {
  const q = (query || '').trim();
  if (!q) return [];
  const [idxs, info, order] = uf.search(haystack, q, 1, 1e4);
  if (!idxs || !idxs.length) return [];
  const ranked = (info && order)
    ? order.map(oi => ({ ...meta[info.idx[oi]], ranges: info.ranges[oi] || [] }))
    : idxs.map(i => ({ ...meta[i], ranges: [] }));
  const open = ranked.filter(r => !r.completed), done = ranked.filter(r => r.completed);
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
export function markTitle(title, ranges, titleLen) {
  const t = title || '';
  if (!ranges || !ranges.length) return esc(t);
  let out = '', pos = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const a = ranges[i]; let b = ranges[i + 1];
    if (a >= titleLen) break;
    b = Math.min(b, titleLen);
    if (a < pos) continue;
    out += esc(t.slice(pos, a)) + '<mark>' + esc(t.slice(a, b)) + '</mark>';
    pos = b;
  }
  return out + esc(t.slice(pos));
}

// --- AQL query language (merged from query.js) ---

const TOKEN_RE = /[^\s()"]*"[^"]*"|[^\s()"]+|[()]/g;
const EMPTY_SET = new Set();
const unq = s => s.replace(/^"(.*)"$/, '$1');
export function tokenize(str) { return String(str || '').match(TOKEN_RE) || []; }

const KEYS = ['p', 'priority', 'due', 'deadline', 'is', 'in'];
function leaf(t) {
  if ((t[0] === '-' || t[0] === '!') && t.length > 1) return { op: 'not', kid: leaf(t.slice(1)) };
  if (t[0] === '#') { const sub = t[1] === '#'; return { q: 'project', sub, val: unq(t.slice(sub ? 2 : 1)) }; }
  if (t[0] === '@') return { q: 'area', val: unq(t.slice(1)) };
  const c = t.indexOf(':');
  if (c > 0) { const k = t.slice(0, c).toLowerCase(); if (KEYS.includes(k)) return { q: k === 'priority' ? 'p' : k, val: unq(t.slice(c + 1)).toLowerCase() }; }
  return { term: unq(t).toLowerCase() };
}

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

const todayISO = now => { const d = new Date(now); d.setHours(0,0,0,0); return isoDate(d); };
function resolveDate(word, now) {
  const w = (word || '').trim().toLowerCase(), d = new Date(now); d.setHours(0, 0, 0, 0);
  const add = n => { const x = new Date(d); x.setDate(x.getDate() + n); return isoDate(x); };
  if (w === 'today') return add(0);
  if (w === 'tomorrow') return add(1);
  if (w === 'yesterday') return add(-1);
  if (w === 'sow') return add(-d.getDay());
  if (w === 'eow') return add(6 - d.getDay());
  if (w === 'som') return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
  if (w === 'eom') return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const m = w.match(/^([+-]\d+)d$/); if (m) return add(+m[1]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  return parseDate(word, now) || null;
}
function cmpNum(n, spec) {
  if (n == null) return false;
  return spec.split(',').some(p => {
    if (p.includes('..')) { const [a, b] = p.split('..').map(Number); return n >= a && n <= b; }
    const m = p.match(/^(>=|<=|>|<|=)?(\d+)$/); if (!m) return false; const v = +m[2], op = m[1] || '=';
    return op === '=' ? n === v : op === '>' ? n > v : op === '>=' ? n >= v : op === '<' ? n < v : n <= v;
  });
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
  const byId = new Map(tasks.map(t => [t.id, t]));
  const hasChild = new Set(tasks.map(t => t.parent_id).filter(Boolean));
  let scope = null; walk(ast, n => { if (n.q === 'in') scope = n.val; });
  const termSets = {}; walk(ast, n => { if (n.term != null && n.term !== '' && !(n.term in termSets)) termSets[n.term] = ctx.freeText(n.term, scope); });
  const projCache = {};
  const projIds = name => projCache[name] || (projCache[name] = new Set(tasks.filter(t => t.sidebar && t.id !== ctx.defaultProjectId && (t.content || '').toLowerCase().includes(name.toLowerCase())).map(t => t.id)));
  const inProject = (t, name, sub) => { const ps = projIds(name); if (!sub) return ps.has(t.parent_id); let c = byId.get(t.parent_id), seen = new Set(); while (c && !seen.has(c.id)) { if (ps.has(c.id)) return true; seen.add(c.id); c = byId.get(c.parent_id); } return false; };
  const areaMatch = (ids, name) => (ids || []).some(id => { const g = ctx.areas.find(x => x.id === id); return g && g.name.toLowerCase().includes(name.toLowerCase()); });
  const isFlag = (t, f) => ({
    done: () => !!t.completed_at, open: () => !t.completed_at && !t.archived_at, archived: () => !!t.archived_at, any: () => true,
    recurring: () => !!t.recurrence, project: () => !!t.sidebar, leaf: () => !hasChild.has(t.id),
    daily: () => t.recurrence?.freq === 'day', weekly: () => t.recurrence?.freq === 'week',
    monthly: () => t.recurrence?.freq === 'month', yearly: () => t.recurrence?.freq === 'year',
    blocked: () => (t.blocked_by || []).some(id => { const b = byId.get(id); return b && !b.completed_at && !b.archived_at; }),
    overdue: () => !!t.due_at && t.due_at.slice(0, 10) < todayISO(ctx.now) && !t.completed_at && !t.archived_at,
    today: () => !!t.due_at && t.due_at.slice(0, 10) === todayISO(ctx.now),
  }[f] || (() => false))();
  const compile = n => {
    if (n.op === 'or') { const k = n.kids.map(compile); return t => k.some(f => f(t)); }
    if (n.op === 'and') { const k = n.kids.map(compile); return t => k.every(f => f(t)); }
    if (n.op === 'not') { const f = compile(n.kid); return t => !f(t); }
    if (n.term != null) { if (n.term === '') return () => true; const s = termSets[n.term] || EMPTY_SET; return t => s.has(t.id); }
    if (n.q === 'project') return t => inProject(t, n.val, n.sub);
    if (n.q === 'area') return t => areaMatch(t.area_ids, n.val);
    if (n.q === 'p') return t => cmpNum(t.priority, n.val);
    if (n.q === 'due') return t => cmpDate(t.due_at, n.val, ctx.now);
    if (n.q === 'deadline') return t => cmpDate(t.deadline_at, n.val, ctx.now);
    if (n.q === 'in') return () => true;
    if (n.q === 'is') return t => isFlag(t, n.val);
    return () => true;
  };
  let includeDone = false, includeArchived = false, wantProject = false;
  walk(ast, n => { if (n.q === 'is' && (n.val === 'done' || n.val === 'any')) includeDone = true; if (n.q === 'is' && (n.val === 'archived' || n.val === 'any')) includeArchived = true; if (n.q === 'is' && n.val === 'project') wantProject = true; });
  const pred = compile(ast);
  // Archived excluded by default (like completed); surfaced only via is:archived / is:any.
  const res = tasks.filter(t => t.id !== ctx.defaultProjectId && (includeDone || !t.completed_at) && (includeArchived || !t.archived_at) && (wantProject || !t.sidebar) && pred(t));
  const key = t => [t.completed_at ? 1 : 0, t.due_at ? t.due_at.slice(0, 10) : '9999', t.priority].join('|');
  return res.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0).map(t => t.id);
}
