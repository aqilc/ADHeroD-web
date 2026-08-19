// Shared UI primitives — pure string builders (no DOM, no Alpine, no `this`). html auto-escapes for Alpine x-html; raw() bypasses.

export const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Sanitize link: only http(s)/mailto allowed (bare email → mailto, www. → https); anything else (javascript: etc.) rejected.
const _mdUrl = u => /^(https?:\/\/|mailto:)/i.test(u) ? u
  : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u) ? 'mailto:' + u
  : /^www\.[^\s]+$/i.test(u) ? 'https://' + u : '';
const _link = (url, text) => { const u = _mdUrl(url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text); };
// XSS-safe markdown for task notes (headings, bold, italic, code, links, bullets). Inline-styled spans, not a document renderer.
export const md = (src, opts = {}) => {
  if (src == null || src === '') return '';
  const codes = [];
  // pull inline code out first so its content isn't touched by later rules
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => `\uE000${codes.push(`<code>${esc(c)}</code>`) - 1}\uE000`);
  const inline = (t) => {
    const links = [];
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `\uE001${links.push(_link(url, txt)) - 1}\uE001`);
    t = t.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<)]+)/gi, (_, pre, url) => `${pre}\uE001${links.push(_link(url, url)) - 1}\uE001`);
    t = esc(t);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, '$1<em>$2</em>');
    return t.replace(/\uE001(\d+)\uE001/g, (_, i) => links[+i]);
  };
  // opts.inline: one line, strips heading/bullet markers; opts.literal: heading/bullet stay as-is
  s = s.split('\n').map(line => {
    if (!opts.literal) {
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) return opts.inline ? inline(h[2]) : `<span class="md-h md-h${h[1].length}">${inline(h[2])}</span>`;
      const b = line.match(/^\s*[-*]\s+(.*)$/);
      if (b) return opts.inline ? inline(b[1]) : `<span class="md-li">${inline(b[1])}</span>`;
    }
    return inline(line);
  }).join(opts.inline || opts.literal ? ' ' : '<br>');
  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => codes[+i]);
};

// Overlay for composer desc: textContent(mdLive(t))===t keeps caret aligned; .dm-mark fades markers behind the transparent contenteditable.
export const mdLive = (src) => String(src ?? '').split('\n').map(_dLine).join('\n');
const _dLine = (line) => {
  const parts = [], S = '\uE000', E = '\uE001';
  const stash = (html) => S + (parts.push(html) - 1) + E;   // pull code/links out so their text isn't bold/italic-scanned
  let t = line.replace(/`([^`\n]+)`/g, (_, c) => stash(`<span class="dm-mark">\`</span><code>${esc(c)}</code><span class="dm-mark">\`</span>`));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    const u = _mdUrl(url), a = s => u ? `<a class="dm-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(s)}</a>` : esc(s);
    return stash(`<span class="dm-mark">[</span>${a(txt)}<span class="dm-mark">](</span>${a(url)}<span class="dm-mark">)</span>`);
  });
  t = esc(t);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<span class="dm-mark">**</span><strong>$1</strong><span class="dm-mark">**</span>');
  t = t.replace(/~~([^~\n]+)~~/g, '<span class="dm-mark">~~</span><s>$1</s><span class="dm-mark">~~</span>');
  t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<span class="dm-mark">*</span><em>$2</em><span class="dm-mark">*</span>');
  t = t.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, '$1<span class="dm-mark">_</span><em>$2</em><span class="dm-mark">_</span>');
  const li = t.match(/^([-*] |\d+\. )/);
  if (li) { t = `<span class="dm-mark">${li[1]}</span>` + t.slice(li[1].length); }
  else { const h = t.match(/^(#{1,3})(\s[\s\S]*)?$/); if (h) t = `<span class="dm-mark">${h[1]}</span><span class="dm-h">${h[2] || ''}</span>`; }
  return t.replace(new RegExp(S + '(\\d+)' + E, 'g'), (_, i) => parts[+i]);
};

// Shared open-first/done-last comparator (stable) — the composer checklist and the row checklist bucket identically.
export const byDone = (a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0);

// Which checklist items a list row actually shows: 3+ done collapse behind "…N more" (open items unaffected;
// plain = no collapse); `open` reveals them. `more` = the toggle exists at all. Shared with app.js's row-height
// estimate for contain-intrinsic-size, so the rendered count and the estimated count can't drift.
export function chkVisible(cl, plain, open) {
  if (plain) return { rows: cl, hidden: 0, more: 0 };
  const view = cl.slice().sort(byDone), done = view.filter(x => x.done), more = Math.max(done.length - 2, 0);
  return { rows: !more || open ? view : view.filter(x => !x.done).concat(done.slice(0, 2)), hidden: open ? 0 : more, more };
}

// Live editor for a composer checklist item: everything after the first "::" renders small/faded inline (the ::
// is a dimmed marker). textContent(chkLive(t)) === t so the contenteditable caret math holds (same contract as mdLive).
export const chkLive = (text) => {
  const s = String(text ?? ''), i = s.indexOf('::');
  return i < 0 ? mdLive(s)
    : `${mdLive(s.slice(0, i))}<span class="dm-mark">::</span><span class="chk-idesc">${mdLive(s.slice(i + 2))}</span>`;
};

// Inline markdown for task titles: bold/italic/strike/code/links; no headings/bullets (-/# stay literal); markers removed.
export const mdTitle = src => md(src, { literal: true });

const RAW = Symbol('raw');
export const raw = s => ({ [RAW]: String(s ?? '') });

const part = v => Array.isArray(v) ? v.map(part).join('')
  : (v && v[RAW] !== undefined) ? v[RAW]
  : esc(v);

export const html = (strings, ...values) =>
  strings.reduce((out, s, i) => out + part(values[i - 1]) + s);

// color is a trusted palette token; name + icon id are escaped
export const areaChipHtml = ({ name, icon, color }) => html`<span class="area" style="--tc:${color}">${raw(
  `<svg class="ico${icon ? '' : ' ico-default'}"><use href="#${esc(icon || 'i-tag-tag')}"/></svg>`
)}<span class="nm">${name}</span></span>`;

// Shared proj chip — used by both rowBodyHtml (full row) and minimal task lines. tintAttr is a style="…" attribute string or ''.
export const projChipHtml = (name, isDefault, tintAttr = '') => (name || isDefault)
  ? `<span class="proj${isDefault ? ' proj-inbox' : ''} inline-flex items-center gap-2 min-w-0 flex-none"${tintAttr}>${isDefault
    ? `<svg class="proj-ico ico flex-none"><use href="#i-backlog"/></svg>`
    : `<span class="proj-in flex-none">in</span><span class="proj-nm">${esc(name)}</span>`}</span>`
  : '';

// The task's OWN checkbox — one builder so every surface showing a task (list row, link picker) agrees on
// what its state looks like. tag='span' renders it inert (a picker row is not a place to tick something off).
export const checkHtml = (r, tag = 'button', extra = '') => {
  const t = r.t, done = !!t.completed_at, archived = !done && !!t.archived_at;
  // A note's slot mark: slanted tack pin — inert, same slot (never bare, never a box, never pressable).
  if (r.note) return `<span class="check note${extra ? ' ' + extra : ''}${done ? ' done' : ''}"><svg class="ico"><use href="#i-tack"/></svg></span>`;
  const recArr = Array.isArray(t.recurrence) ? t.recurrence : t.recurrence ? [t.recurrence] : [];
  const isPaused = !done && !archived && recArr.length > 0 && recArr.every(x => x.paused);
  // archived → inert archive glyph (means "set aside"); suppress done/prog/blocked/paused overlays.
  const cls = ['check', extra, done && 'done', archived && 'archived', !archived && r.hasProgress && !done && 'prog', !archived && r.blocked && !done && 'blocked', isPaused && 'paused'].filter(Boolean).join(' ');
  const lock = !archived && r.blocked && !done ? '<svg class="ico lock-ico"><use href="#i-lock"/></svg>' : '';
  const pause = isPaused ? '<svg class="ico pause-ico"><use href="#i-pause"/></svg>' : '';
  const act = tag === 'button' ? ' data-act="check"' : '';
  return `<${tag} class="${cls}"${act} style="--pc:${esc(r.pc)}${r.hasProgress ? ';--p:' + r.progress : ''}">${lock}${pause}</${tag}>`;
};

// static body kills per-row x-for/x-show cost; shell bindings stay reactive; clicks via data-act/data-ci
export const rowBodyHtml = (r, opts = {}) => {
  const t = r.t, done = !!t.completed_at, archived = !done && !!t.archived_at, nav = opts.navType || '';
  // Minimal mode: flat task-line (popup/palette/sweep/ghost). Inert span check + pick-name title + areas + proj.
  // No wrappers, no badges, no chevron — same shape as the old taskRowHtml.
  if (opts.minimal) {
    const check = checkHtml(r, 'span', 'sm');
    const chips = (r.areas || []).map(areaChipHtml).join('');
    const titleHtml = r.titleHtml ?? mdTitle(t.content);
    return `${check}<span class="pick-name">${titleHtml}</span>${chips ? `<span class="areas inline-flex items-center gap-6 min-w-0">${chips}</span>` : ''}${projChipHtml(r.projName, r.isDefaultProj)}`;
  }
  const showProj = !!(r.projName || r.isDefaultProj) && (opts.proj === true || (opts.proj !== false && nav !== 'project' && nav !== 'backlog'));
  const badges = opts.badges !== false;
  // A checklist folds under the SAME chevron as subtasks — one gesture for "hide what's inside this row".
  const chkCount = (r.chk || t.checklist || []).length;
  const chev = (opts.chevron !== false && (r.childCount || chkCount))
    ? `<button type="button" class="row-chev${r.depth > 0 ? ' boxed' : ''}" data-act="collapse"${r.collapsed ? ' style="transform:rotate(-90deg)"' : ''}><svg class="ico"><use href="#i-chev-d"/></svg></button>` : '';
  // Normalize recurrence (object OR V3 rule-array) once (the repeat glyph reads it below).
  const recArr = Array.isArray(t.recurrence) ? t.recurrence : t.recurrence ? [t.recurrence] : [];
  const check = checkHtml(r);   // ↑ same builder the link picker uses, so both read the task's state identically
  const areas = r.areas.length ? `<span class="areas inline-flex items-center gap-6 min-w-0"${r.areas.length === 1 ? ` style="--tc:${esc(r.areas[0].color)}"` : ''}>${r.areas.map(areaChipHtml).join('')}</span>` : '';
  // Goals are DELIBERATELY not drawn in the list row — parked until the goals rework, and the dead
  // `.goal`/`.goals-chips` chrome went with them (the empty-string placeholder and mkRow's per-row
  // goalsForTask() went with them too — it was computed for every row of every render, consumed by nothing).
  // Tint whole chip (icon + text) with project color, faded; color is inherited CSS property so outer span suffices.
  const projTint = r.projColor ? ` style="${esc(r.projColor)};opacity:.55"` : '';
  // `proj-inbox` marks the icon-only default-project chip: it is a bare glyph, so the overflow ladder is
  // forbidden from moving it to line 2 (an icon alone on its own line reads as a bug). → app.js _ladder
  const proj = showProj ? projChipHtml(r.projName, r.isDefaultProj, projTint) : '';
  // Every badge in the row's right cluster is the same shape — muted icon + value. Only the modifier class,
  // the glyph and the text differ, so they are one builder rather than six near-identical template literals.
  const m = (on, icon, text, cls = '', attr = '') => on
    ? `<span class="m${cls ? ' ' + cls : ''} inline-flex items-center gap-4 muted-12"${attr}>${icon ? `<svg class="ico"><use href="#${icon}"/></svg>` : ''}${text ? `<span>${esc(text)}</span>` : ''}</span>`
    : '';
  // The tray's clock time (calendar side lists). It wears the clock GLYPH like every other badge here:
  // bare text was the one exception to `icon + value` and read as a stray number beside the when badge.
  const sched = m(opts.schedTime, 'i-clock', opts.schedTime, 'sched');
  // Size bucket, not a clock + "45m": the same four glyphs the composer's Size picker uses, so the row and the
  // control that sets it speak one vocabulary. Text-free — the duration rides along as the tooltip.
  const est = m(badges && r.estSize, 'i-size-' + r.estSize, '', 'est', ` title="${esc(r.est + (r.estRollup ? ' — total of subtasks' : ''))}"`);
  const dl = m(badges && t.deadline_at, 'i-flag', r.dl?.label, 'dl' + (r.dl?.overdue ? ' over' : ''));
  const loc = m(badges && r.loc, r.locX ? 'i-pin-off' : 'i-pin', r.loc, 'loc');
  // "after done" repeats (any rule from_completion) get the repeat+check glyph in both the due badge and the standalone chip.
  const repHref = recArr.some(x => x.from_completion) ? '#i-repeat-done' : '#i-repeat';
  const due = badges && r.due ? `<span class="badge ${esc(r.due.kind || '')} inline-flex items-center gap-4">${t.recurrence ? `<svg class="ico badge-rep"><use href="${repHref}"/></svg>` : ''}<span>${esc(r.due.label + (r.dueTime ? ' ' + r.dueTime : ''))}</span></span>` : '';
  const rep = m(badges && t.recurrence && !r.due, repHref.slice(1), '');   // a repeat with no date hosts the glyph itself
  const rels = opts.rels !== false && r.rels.length ? `<div class="row-rels flex items-center gap-8 min-w-0">${r.rels.map(rl =>
    `<span class="row-rel ${rl.type} inline-flex items-center gap-4 muted-11"><svg class="ico"><use href="#${esc(rl.icon)}"/></svg><span class="row-rel-name">${esc(rl.name)}</span></span>`).join('')}</div>` : '';
  // Relations are a LINE-1 CITIZEN — the ladder sheds them like anything else, so a row with a relation is
  // no longer two lines at every width. NOTES are the deliberate exception: prose always owns its own line
  // (user, 2026-08-17), so it never competes with the title and never joins the meta line. → app.js LADDER
  const notes = opts.notes !== false && t.notes ? `<div class="row2 flex items-center gap-8"><span class="desc-line grow min-w-0 truncate">${md(t.notes, { inline: true })}</span></div>` : '';
  // Checklist items pre-split (text::desc) in mkRow; fall back for callers that pass a bare row.
  const cl = r.chk || (t.checklist || []).map((c, ci) => { const sep = c.text.indexOf('::'); return { ci, done: !!c.done, txt: sep >= 0 ? c.text.slice(0, sep) : c.text, desc: sep >= 0 ? c.text.slice(sep + 2) : '' }; });
  // Display-only sort: done below open (stable); data-ci = original index so toggling never reorders the stored array.
  const plain = !!t.checklist_plain;   // uncheckable: plain notes list — bullets instead of boxes, no done styling
  const { rows: clRows, hidden, more } = chkVisible(cl, plain, opts.chkOpen);
  const morePlaceholder = more ? `<button type="button" class="chk-row flex gap-8 chk-more" data-act="chk-more"><span class="chk-more-txt">${hidden ? '…' + hidden + ' more' : 'Show less'}</span></button>` : '';
  const renderRow = ({ ci, done, txt, desc }) =>
    `<div class="chk-row flex gap-8${done && !plain ? ' done' : ''}" data-ci="${ci}"><span class="chk-rect${plain ? ' plain' : done ? ' done' : ''}"></span><span class="chk-txt truncate min-w-0">${mdTitle(txt)}</span>${desc ? `<span class="chk-desc truncate min-w-0">${mdTitle(desc)}</span>` : ''}</div>`;
  const chk = cl.length && !r.collapsed ? `<div class="chk-list flex-col">${clRows.map(renderRow).join('')}${morePlaceholder}</div>` : '';
  const titleHtml = r.titleHtml ?? mdTitle(t.content);   // precomputed in mkRow (regex-cached); fall back for bare rows
  return chev + check + `<div class="body grow min-w-0"><div class="row1 flex items-center gap-8"><div class="r1l flex items-center gap-6 min-w-0 grow"><span class="title">${titleHtml}</span>${areas}${proj}${rels}</div><div class="r1r flex items-center gap-8 min-w-0">${sched}${est}${dl}${loc}${due}${rep}</div></div>${notes}${chk}</div>`;
};

// data-ridx on box = focus index; data-more="kind:id" on ··· button
export const rollerBoxHtml = (it) => {
  // focus is a parent class, not set on the box itself
  const ind = it.depth ? it.depth * 16 : 0;
  // --rlc: the item's own color — the focus highlight recolors to it (falls back to accent in CSS)
  const style = [ind ? `margin-left:${ind}px;width:calc(100% - ${ind}px)` : '', it.color && !String(it.color).startsWith('var(') ? `--rlc:${esc(it.color)}` : ''].filter(Boolean).join(';');
  const indent = style ? ` style="${style}"` : '';
  const icon = it.icon === 'prog'
    ? `<span class="rl-ic rl-prog" style="--p:${esc(it.progress || 0)};--pc:${esc(it.color || 'var(--muted)')}"></span>`
    : `<span class="rl-ic"${it.color ? ` style="color:${esc(it.color)}"` : ''}><svg class="ico"><use href="#${esc(it.icon || 'i-circle')}"/></svg></span>`;
  const nest = it.depth ? '<span class="rl-nest">&#8627;</span>' : '';
  const cnt = (it.count ?? '') !== '' ? `<span class="rl-cnt">${esc(it.count)}</span>` : '';
  const more = it.kind === 'loc' ? '' : `<button type="button" class="rl-more" data-more="${it.kind}:${it.id ?? ''}">&#8943;</button>`;   // 'Manage locations' has no per-item menu
  // The rail has no drag, so these arrows ARE the ordering control — they sit beside the ⋯ instead of inside it
  // because reordering is a repeated one-press-per-step action, and a menu round-trip per step kills that.
  // Backlog/locations are fixed rows: there is nothing to order them against.
  const mv = ['proj', 'area', 'filter'].includes(it.kind) ? `<span class="rl-mv">${[-1, 1].map(d =>
    `<button type="button" class="rl-mvb" data-move="${it.kind}:${it.id}:${d}" aria-label="Move ${d < 0 ? 'up' : 'down'}"><svg class="ico"><use href="#i-chev-d"/></svg></button>`).join('')}</span>` : '';
  return html`<div class="rl-box" data-ridx="${it.ridx}"${raw(indent)}>${raw(nest)}${raw(icon)}<span class="rl-nm">${it.label}</span>${raw(cnt)}${raw(mv)}${raw(more)}</div>`;
};

// The strip IS the navigation on a phone (the hamburger is gone), so every dot needs a name: cd-far wears
// only its icon, and the current one carries a second job — pressing it opens the overview — that its visible
// label doesn't say. aria-label wins over the label text, so it has to repeat the surface name.
// A surface may fold its own sub-modes into its dot while it is current — Plan does, on a phone, where the
// calendar's views join the app's one navigator instead of floating a second cluster over the grid
// (calendar-mobile-controls-explorations #6). It is a SIBLING of the dot, never a child: a button inside a
// button is invalid and the parser hoists it straight back out.
const segHtml = (seg) => !seg ? '' : `<span class="cd-seg">${seg.views.map(v =>
  `<button type="button" data-v="${esc(v)}" class="cd-segb${v === seg.cur ? ' on' : ''}" aria-label="${esc(v)} view" aria-pressed="${v === seg.cur}">${esc(v[0].toUpperCase())}</button>`).join('')}</span>`;

export const dotStripHtml = (surfaces, idx) =>
  surfaces.map((s, i) => {
    const d = Math.abs(i - idx);
    // Its own icon, on every dot — the pip it replaces named nothing, so a far surface was only reachable by
    // counting positions. The icon is the constant; the label is what drops away with distance.
    const ico = raw(`<svg class="ico cd-ico" aria-hidden="true"><use href="#${esc(s.icon || 'i-all')}"/></svg>`);
    if (i === idx) { const dot = html`<button type="button" data-idx="${i}" class="cd cd-cur" aria-label="${s.label} — open menu" aria-haspopup="dialog">${ico}<span class="cd-lab">${s.label}</span></button>`;
      return s.seg ? `<span class="cd-plan">${dot}${segHtml(s.seg)}</span>` : dot; }
    if (d === 1)   return html`<button type="button" data-idx="${i}" class="cd cd-near">${ico}<span class="cd-lab">${s.label}</span></button>`;
    return html`<button type="button" data-idx="${i}" class="cd cd-far" aria-label="${s.label}">${ico}</button>`;
  }).join('');
