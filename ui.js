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
  // opts.inline: one line, inline content only (for list-row preview)
  s = s.split('\n').map(line => {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) return opts.inline ? inline(h[2]) : `<span class="md-h md-h${h[1].length}">${inline(h[2])}</span>`;
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) return opts.inline ? inline(b[1]) : `<span class="md-li">${inline(b[1])}</span>`;
    return inline(line);
  }).join(opts.inline ? ' ' : '<br>');
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

// Live editor for a composer checklist item: everything after the first "::" renders small/faded inline (the ::
// is a dimmed marker). textContent(chkLive(t)) === t so the contenteditable caret math holds (same contract as mdLive).
export const chkLive = (text) => {
  const s = String(text ?? ''), i = s.indexOf('::');
  return i < 0 ? esc(s)
    : `${esc(s.slice(0, i))}<span class="dm-mark">::</span><span class="chk-idesc">${esc(s.slice(i + 2))}</span>`;
};

// Inline markdown for task titles: bold/italic/strike/code/links; no headings/bullets (-/# stay literal); markers removed.
export const mdTitle = (src) => {
  const parts = [];
  const stash = h => `\uE001${parts.push(h) - 1}\uE001`;   // pull code/links out so their text isn't styled
  let t = String(src ?? '')
    .replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => stash(_link(url, txt)))
    .replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<)]+)/gi, (_, pre, url) => `${pre}${stash(_link(url, url))}`);
  t = esc(t);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, '$1<em>$2</em>');
  return t.replace(/\uE001(\d+)\uE001/g, (_, i) => parts[+i]);
};

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

// `title` is escaped or raw() pre-marked HTML (search highlight)
export const taskRowHtml = ({ priorityColor, title, areas = [], projName = '', done = false }) => {
  const chips = areas.map(areaChipHtml).join('');
  const proj = projName ? html`<span class="pick-path">#${projName}</span>` : '';
  return html`<span class="check sm${done ? ' done' : ''}" style="--pc:${priorityColor}"></span><span class="pick-name">${title}</span>${chips ? raw(`<span class="areas">${chips}</span>`) : raw('')}${raw(proj)}`;
};

// opts.ms wraps rows in .goal-step-row with a ◆ milestone toggle (data-act="milestone" for delegation)
export const taskListHtml = (rows, opts = {}) =>
  rows.map(({ id, line, milestone }) => opts.ms
    ? html`<div class="goal-step-row"><button type="button" class="ms-toggle${milestone ? ' ms-on' : ''}" data-tid="${id}" data-act="milestone" title="Toggle milestone">◆</button><button type="button" class="task-line" data-tid="${id}">${raw(line)}</button></div>`
    : html`<button type="button" class="task-line" data-tid="${id}">${raw(line)}</button>`).join('');

// static body kills per-row x-for/x-show cost; shell bindings stay reactive; clicks via data-act/data-ci
export const rowBodyHtml = (r, opts = {}) => {
  const t = r.t, done = !!t.completed_at, archived = !done && !!t.archived_at, nav = opts.navType || '';
  const showProj = !!r.projName && (opts.proj === true || (opts.proj !== false && nav !== 'project' && nav !== 'backlog'));
  const badges = opts.badges !== false;
  const chev = (opts.chevron !== false && r.childCount)
    ? `<button type="button" class="row-chev${r.depth > 0 ? ' boxed' : ''}" data-act="collapse"${r.collapsed ? ' style="transform:rotate(-90deg)"' : ''}><svg class="ico"><use href="#i-chev-d"/></svg></button>` : '';
  // Normalize recurrence (object OR V3 rule-array) once: paused = has rules and every one is paused.
  const recArr = Array.isArray(t.recurrence) ? t.recurrence : t.recurrence ? [t.recurrence] : [];
  const isPaused = !done && !archived && recArr.length > 0 && recArr.every(x => x.paused);
  // archived → inert archive glyph (means "set aside"); suppress done/prog/blocked/paused overlays.
  const ckCls = ['check', done && 'done', archived && 'archived', !archived && r.hasProgress && !done && 'prog', !archived && r.blocked && !done && 'blocked', isPaused && 'paused'].filter(Boolean).join(' ');
  const lock = !archived && r.blocked && !done ? '<svg class="ico lock-ico"><use href="#i-lock"/></svg>' : '';
  const pauseIco = isPaused ? '<svg class="ico pause-ico"><use href="#i-pause"/></svg>' : '';
  // archived → a dash-in-circle "set aside" checkbox (the dash is pure CSS on .check.archived), not a done tick
  const check = `<button class="${ckCls}" data-act="check" style="--pc:${esc(r.pc)}${r.hasProgress ? ';--p:' + r.progress : ''}">${lock}${pauseIco}</button>`;
  const areas = r.areas.length ? `<span class="areas"${r.areas.length === 1 ? ` style="--tc:${esc(r.areas[0].color)}"` : ''}>${r.areas.map(areaChipHtml).join('')}</span>` : '';
  const glint = opts.glintId === t.id ? ' glint' : '';
  const goals = r.goals.length ? `<span class="goals-chips">${r.goals.map(g =>
    `<span class="goal${glint}"${g.color ? ` style="--tc:${esc(g.color)}"` : ''} title="${esc(g.name)}"><svg class="ico"><use href="#i-tag-flame"/></svg><span class="nm">${esc(g.name)}</span></span>`).join('')}</span>` : '';
  // Tint whole chip (icon + text) with project color, faded; color is inherited CSS property so outer span suffices.
  const projTint = r.projColor ? ` style="${esc(r.projColor)};opacity:.55"` : '';
  const proj = showProj ? `<span class="proj"${projTint}>${r.isDefaultProj
    ? `<svg class="proj-ico ico"><use href="#i-backlog"/></svg>`
    : `<span class="proj-in">in</span><span class="proj-nm">${esc(r.projName)}</span>`}</span>` : '';
  const sched = opts.schedTime ? `<span class="m">${esc(opts.schedTime)}</span>` : '';
  const est = badges && r.est ? `<span class="m"${r.estRollup ? ' title="Total of subtasks"' : ''}><svg class="ico"><use href="#i-clock"/></svg><span>${esc(r.est)}</span></span>` : '';
  const dl = badges && t.deadline_at ? `<span class="m dl${r.dl?.overdue ? ' over' : ''}"><svg class="ico"><use href="#i-flag"/></svg><span>${esc(r.dl?.label)}</span></span>` : '';
  const loc = badges && r.loc ? `<span class="m loc"><svg class="ico"><use href="#${r.locX ? 'i-pin-off' : 'i-pin'}"/></svg><span>${esc(r.loc)}</span></span>` : '';
  // "after done" repeats (any rule from_completion) get the repeat+check glyph in both the due badge and the standalone chip.
  const repHref = recArr.some(x => x.from_completion) ? '#i-repeat-done' : '#i-repeat';
  const due = badges && t.due_at ? `<span class="badge ${esc(r.due?.kind || '')}">${t.recurrence ? `<svg class="ico badge-rep"><use href="${repHref}"/></svg>` : ''}<span>${esc(r.due?.label + (r.dueTime ? ' ' + r.dueTime : ''))}</span></span>` : '';
  const rep = badges && t.recurrence && !t.due_at ? `<span class="m"><svg class="ico"><use href="${repHref}"/></svg></span>` : '';
  const rels = opts.rels !== false && r.rels.length ? `<div class="row-rels">${r.rels.map(rl =>
    `<span class="row-rel ${rl.type}"><svg class="ico"><use href="#${esc(rl.icon)}"/></svg><span class="row-rel-name">${esc(rl.name)}</span></span>`).join('')}</div>` : '';
  const notes = opts.notes !== false && t.notes ? `<div class="row2"><span class="desc-line">${md(t.notes, { inline: true })}</span></div>` : '';
  // Checklist items pre-split (text::desc) in mkRow; fall back for callers that pass a bare row.
  const cl = r.chk || (t.checklist || []).map((c, ci) => { const sep = c.text.indexOf('::'); return { ci, done: !!c.done, txt: sep >= 0 ? c.text.slice(0, sep) : c.text, desc: sep >= 0 ? c.text.slice(sep + 2) : '' }; });
  // Display-only sort: done below open (stable); data-ci = original index so toggling never reorders the stored array.
  const clView = cl.slice().sort(byDone);
  const plain = !!t.checklist_plain;   // uncheckable: plain notes list — bullets instead of boxes, no done styling
  const chk = cl.length ? `<div class="chk-list">${(plain ? cl : clView).map(({ ci, done, txt, desc }) =>
    `<div class="chk-row${done && !plain ? ' done' : ''}" data-ci="${ci}"><span class="chk-rect${plain ? ' plain' : done ? ' done' : ''}"></span><span class="chk-txt">${esc(txt)}</span>${desc ? `<span class="chk-desc">${esc(desc)}</span>` : ''}</div>`).join('')}</div>` : '';
  const titleHtml = r.titleHtml ?? mdTitle(t.content);   // precomputed in mkRow (regex-cached); fall back for bare rows
  return chev + check + `<div class="body"><div class="row1"><div class="r1l"><span class="title">${titleHtml}</span>${areas}${proj}${goals}</div><div class="r1r">${sched}${est}${dl}${loc}${due}${rep}</div></div>${rels}${notes}${chk}</div>`;
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
  return html`<div class="rl-box" data-ridx="${it.ridx}"${raw(indent)}>${raw(nest)}${raw(icon)}<span class="rl-nm">${it.label}</span>${raw(cnt)}${raw(more)}</div>`;
};

export const dotStripHtml = (surfaces, idx) =>
  surfaces.map((s, i) => {
    const d = Math.abs(i - idx);
    if (i === idx) return html`<button type="button" data-idx="${i}" class="cd cd-cur"><span class="cd-pip"></span><span class="cd-lab">${s.label}</span></button>`;
    if (d === 1)   return html`<button type="button" data-idx="${i}" class="cd cd-near"><span class="cd-lab">${s.label}</span></button>`;
    return html`<button type="button" data-idx="${i}" class="cd cd-far"><span class="cd-pip"></span></button>`;
  }).join('');
