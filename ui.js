// Shared UI primitives — pure string builders (no DOM, no Alpine, no `this`). html auto-escapes for Alpine x-html; raw() bypasses.

export const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A ? sheet keycap row → the shortcut coach's plain tip text: its first alternative, adjacent keys joined the
// platform's way (⌘Z on a Mac, Ctrl+Z elsewhere).
export const keyTip = (keycaps, mod) => keycaps.split(' · ')[0].replaceAll('</kbd><kbd', mod === '⌘' ? '</kbd><kbd' : '</kbd>+<kbd')
  .replace(/<[^>]+>/g, '').replaceAll('⌘', mod).replace(/(?<=[⌘+])[a-z]$/, c => c.toUpperCase());

// Sanitize link: only http(s)/mailto allowed (bare email → mailto, www. → https); anything else (javascript: etc.) rejected.
const _mdUrl = u => /^(https?:\/\/|mailto:)/i.test(u) ? u
  : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u) ? 'mailto:' + u
  : /^www\.[^\s]+$/i.test(u) ? 'https://' + u : '';
const _link = (url, text) => { const u = _mdUrl(url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text); };
const _langs = { bash: 'bash', sh: 'bash', cmd: 'cmd', bat: 'cmd', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', rust: 'rust', rs: 'rust', c: 'c' };
const _keys = {
  bash: 'if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in',
  cmd: 'if|else|for|in|do|set|call|goto|echo|not|exist|defined',
  js: 'const|let|var|function|return|if|else|for|while|class|new|import|export|async|await|throw|try|catch',
  ts: 'const|let|var|function|return|if|else|for|while|class|new|import|export|async|await|interface|type|enum|implements|public|private',
  rust: 'fn|let|mut|const|if|else|for|while|loop|match|struct|enum|impl|trait|use|pub|mod|return|async|await',
  c: 'auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|int|long|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while',
};
const _comments = { bash: '#[^\n]*', cmd: '(?<=^|\n)[ \t]*(?:rem\\b|::)[^\n]*', js: '\\/\\/[^\n]*|\\/\\*[\\s\\S]*?\\*\\/', ts: '\\/\\/[^\n]*|\\/\\*[\\s\\S]*?\\*\\/', rust: '\\/\\/[^\n]*|\\/\\*[\\s\\S]*?\\*\\/', c: '\\/\\/[^\n]*|\\/\\*[\\s\\S]*?\\*\\/' };
const _highlight = (src, lang) => {
  if (!lang) return esc(src);
  const re = new RegExp(`(?<com>${_comments[lang]})|(?<str>"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(?<key>\\b(?:${_keys[lang]})\\b)|(?<num>\\b(?:0x[\\dA-Fa-f]+|\\d+(?:\\.\\d+)?)\\b)`, lang === 'cmd' ? 'gi' : 'g');
  let out = '', at = 0;
  for (const m of src.matchAll(re)) { const kind = Object.keys(m.groups).find(k => m.groups[k] != null); out += esc(src.slice(at, m.index)) + `<span class="md-code-${kind}">${esc(m[0])}</span>`; at = m.index + m[0].length; }
  return out + esc(src.slice(at));
};
const _copyCode = '<button class="code-copy" type="button" contenteditable="false" aria-label="Copy code" title="Copy code"><svg class="ico"><use href="#i-copy"/></svg></button>';
// A short pill (≤ 8 chars) would sit mostly under its Copy, so the composer puts Copy beside it (styles.css).
const _codeBlock = (src, info, compact) => { const key = String(info || '').toLowerCase(), lang = Object.hasOwn(_langs, key) ? _langs[key] : ''; return `<span class="md-code${compact ? ` md-code-inline${src.length <= 8 ? ' md-code-short' : ''}` : ''}"${lang ? ` data-lang="${lang}"` : ''}><code>${_highlight(src, lang)}</code>${_copyCode}</span>`; };
// ceiling: triple-backtick fences only; use a parser if nested fences or full Markdown are requested.
const _fences = /```([\s\S]*?)(```|$)/g;
const _hasFence = src => String(src ?? '').includes('```');
const _chkSep = src => { const s = String(src ?? ''); return (_hasFence(s) ? s.replace(_fences, m => ' '.repeat(m.length)) : s).indexOf('::'); };   // the fence test first: replace() alone costs ~2x per row
export const chkParts = (c, ci) => { const sep = _chkSep(c.text); return { ci, done: !!c.done, txt: sep >= 0 ? c.text.slice(0, sep) : c.text, desc: sep >= 0 ? c.text.slice(sep + 2) : '' }; };
const _sentinel = (src, mark) => { while (src.includes(mark)) mark += mark[0]; return mark; };
// XSS-safe markdown for task descriptions (headings, bold, italic, code, links, bullets). Inline-styled spans, not a document renderer.
const _md = (src, opts = {}) => {
  if (src == null || src === '') return '';
  const codes = [], raw = String(src), C = _sentinel(raw, '\uE000'), CE = C + '\uE001';
  // pull inline code out first so its content isn't touched by later rules
  let s = raw.replace(/`([^`\n]+)`/g, (_, c) => `${C}${codes.push(`<code>${esc(c)}${opts.copy ? _copyCode : ''}</code>`) - 1}${CE}`);
  const inline = (t) => {
    const links = [], L = _sentinel(t, '\uE002'), LE = L + '\uE003';
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `${L}${links.push(_link(url, txt)) - 1}${LE}`);
    t = t.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<)]+)/gi, (_, pre, url) => `${pre}${L}${links.push(_link(url, url)) - 1}${LE}`);
    t = esc(t);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, '$1<em>$2</em>');
    return t.replace(new RegExp(L + '(\\d+)' + LE, 'g'), (_, i) => links[+i]);
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
  return s.replace(new RegExp(C + '(\\d+)' + CE, 'g'), (_, i) => codes[+i]);
};

const _fenced = (src, live, inline = false, copy = false) => {
  const raw = String(src ?? ''), prose = s => live ? s.split('\n').map(line => _dLine(line)).join('\n') : _md(s, { inline, copy });
  let out = '', at = 0;
  for (const m of raw.matchAll(_fences)) {
    // Only a newline-ended opening line is language metadata; same-line commands stay literal.
    const head = m[1].match(/^([^\s`]*)[ \t]*\r?\n/), prefix = head?.[0] || '', compact = !m[1].includes('\n'), block = _codeBlock(m[1].slice(prefix.length), head?.[1], compact);
    // A multiline fence is a block and takes its closing line break (hidden, it leaves no empty line); a compact one flows in its line.
    const nl = live && !compact && m[2] && raw[m.index + m[0].length] === '\n' ? '\n' : '';
    out += prose(raw.slice(at, m.index)) + (live ? `<span class="dm-tok${compact ? '' : ' dm-fence'}"><span class="dm-mark">${esc('```' + prefix)}</span>` + block + (m[2] ? '<span class="dm-mark">```' + nl + '</span>' : '') + '</span>' : block);
    at = m.index + m[0].length + nl.length;
  }
  return out + prose(raw.slice(at));
};
export const md = (src, opts = {}) => opts.literal ? _md(src, opts) : _fenced(src, false, !!opts.inline, !!opts.copy);

// The composer's live Markdown: textContent(mdLive(t)) === t keeps the caret aligned. Each construct is a .dm-tok holding its
// .dm-mark markers, which show only while the caret touches it (app.js descReveal).
export const mdLive = (src) => _fenced(src, true);
// Where a long text from `start` (a line start outside any fence) can be cut: the first line end at least `min` chars on
// that no ``` fence spans, so each part renders as its share of the whole. src.length when there's none.
// ceiling: a text with no newline, or one huge fence, is one part: the composer draws it whole, and a row whose first fence
// is huge previews all of it. Cut mid-line or mid-fence if a pasted log is seen to stutter.
export const mdCut = (src, start, min) => {
  let end = src.indexOf('\n', start + min) + 1 || src.length;
  while (end < src.length && src.slice(start, end).split('```').length % 2 === 0) {   // an odd count of ``` before end: inside a fence
    const close = src.indexOf('```', end);
    end = close < 0 ? src.length : src.indexOf('\n', close + 3) + 1 || src.length;
  }
  return end;
};
const _tok = (open, inner, close) => `<span class="dm-tok"><span class="dm-mark">${open}</span>${inner}<span class="dm-mark">${close}</span></span>`;
const _dLine = (line, literal) => {   // literal: a title's, where # and - stay text
  const parts = [], S = _sentinel(line, '\uE000'), E = S + '\uE001';
  const stash = (html) => S + (parts.push(html) - 1) + E;   // pull code/links out so their text isn't bold/italic-scanned
  let t = line.replace(/`([^`\n]+)`/g, (_, c) => stash(`<span class="dm-tok"><span class="dm-mark">\`</span><code>${esc(c)}</code><span class="dm-mark">\`</span></span>`));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    const u = _mdUrl(url);
    return stash(_tok('[', u ? `<a class="dm-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(txt)}</a>` : esc(txt), `](${esc(url)})`));
  });
  t = esc(t);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, (_, x) => _tok('**', `<strong>${x}</strong>`, '**'));
  t = t.replace(/~~([^~\n]+)~~/g, (_, x) => _tok('~~', `<s>${x}</s>`, '~~'));
  t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, (_, pre, x) => pre + _tok('*', `<em>${x}</em>`, '*'));
  t = t.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_/g, (_, pre, x) => pre + _tok('_', `<em>${x}</em>`, '_'));
  const li = !literal && t.match(/^([-*] )|^(\d+\. )/), h = !literal && !li && t.match(/^(#{1,3})(\s[\s\S]*)?$/);
  if (li) t = (li[1] ? `<span class="dm-tok"><span class="dm-mark dm-li">${li[1]}</span></span>` : `<span class="dm-mark dm-ol">${li[2]}</span>`) + t.slice(li[0].length);   // a number always shows
  else if (h) t = `<span class="dm-tok dm-h h${h[1].length}"><span class="dm-mark">${h[1]}${h[2]?.[0] || ''}</span>${h[2]?.slice(1) || ''}</span>`;   // the space after # is a marker too: the heading starts flush
  return t.replace(new RegExp(S + '(\\d+)' + E, 'g'), (_, i) => parts[+i]);
};

// Which checklist items a list row actually shows: 3+ done collapse behind "…N more" (open items unaffected;
// plain = no collapse); `open` reveals them. `more` = the toggle exists at all. Shared with app.js's row-height
// estimate for contain-intrinsic-size, so the rendered count and the estimated count can't drift. Open first, done last (stable),
// the composer's and the row's alike. held: item key (id, or a row's ci) → the done it showed before a tick still in place (app.js _holdChk).
export function chkVisible(cl, plain, open, held) {
  if (plain) return { rows: cl, hidden: 0, more: 0 };
  const isDone = x => !!(held?.has(x.id ?? x.ci) ? held.get(x.id ?? x.ci) : x.done);
  const view = cl.slice().sort((a, b) => isDone(a) - isDone(b)), done = view.filter(isDone), more = Math.max(done.length - 2, 0);
  return { rows: !more || open ? view : view.filter(x => !isDone(x)).concat(done.slice(0, 2)), hidden: open ? 0 : more, more };
}

// Live editor for a composer checklist item: everything after the first "::" is its note, led by the "::" as a marker
// (the caret at the note's start touches it). textContent(chkLive(t)) === t so the caret math holds (same contract as mdLive).
// tail goes inside the note's block: a <br> after it leaves the caret before a trailing newline.
export const chkLive = (text, tail = '') => {
  const s = String(text ?? ''), i = _chkSep(s);
  return i < 0 ? mdLive(s) + tail
    : `${mdLive(s.slice(0, i))}<span class="chk-idesc"><span class="dm-tok"><span class="dm-mark">::</span></span>${mdLive(s.slice(i + 2))}${tail}</span>`;
};

// A composer title's live Markdown (a pill editor's text between chips): mdTitle's constructs, markers kept as in mdLive.
export const titleLive = src => _dLine(String(src ?? ''), true);

// Inline markdown for task titles: bold/italic/strike/code/links; no headings/bullets (-/# stay literal); markers removed.
const _titleMemo = new Map();   // ceiling: cleared past 20k titles; an LRU if a corpus that size churns it
export const mdTitle = src => {
  let html = _titleMemo.get(src);
  if (html === undefined) { if (_titleMemo.size >= 2e4) _titleMemo.clear(); _titleMemo.set(src, html = md(src, { literal: true })); }
  return html;
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

// Area picker chip body — the composer's area pop-up and the filter menu's Area facet share it, so the two can't drift.
export const areaOptHtml = ({ name, icon }, on) => html`${raw(on ? '<svg class="tick ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '')}${raw(
  icon ? `<svg class="ico"><use href="#${esc(icon)}"/></svg>` : '')}<span>${name}</span>`;

// Shared proj chip — used by both rowBodyHtml (full row) and minimal task lines; the name is a task title, rendered as one. tintAttr is a style="…" attribute string or ''.
export const projChipHtml = (name, isDefault, tintAttr = '') => (name || isDefault)
  ? `<span class="proj${isDefault ? ' proj-inbox' : ''} inline-flex items-center gap-2 min-w-0 flex-none"${tintAttr}>${isDefault
    ? `<svg class="proj-ico ico flex-none"><use href="#i-backlog"/></svg>`
    : `<span class="proj-in flex-none">in</span><span class="proj-nm">${mdTitle(name)}</span>`}</span>`
  : '';

const recList = rec => Array.isArray(rec) ? rec : rec ? [rec] : [];   // = store.js recRules (ui.js stays import-free); rowBodyHtml hands checkHtml its one copy

// The task's OWN checkbox — one builder so every surface showing a task (list row, link picker) agrees on
// what its state looks like. tag='span' renders it inert (a picker row is not a place to tick something off).
export const checkHtml = (r, tag = 'button', extra = '', recArr = recList(r.t.recurrence)) => {
  const t = r.t, done = !!t.completed_at, archived = !done && !!t.archived_at;
  // A note's slot mark: slanted tack pin — inert, same slot (never bare, never a box, never pressable). No .done: a done note keeps its tack, never the tick.
  if (r.note) return `<span class="check note${extra ? ' ' + extra : ''}"><svg class="ico"><use href="#i-tack"/></svg></span>`;
  const isPaused = !done && !archived && recArr.length > 0 && recArr.every(x => x.paused);
  // archived → inert archive glyph (means "set aside"); suppress done/prog/blocked/paused overlays.
  const steps = !!r.step && !r.blocked;   // a blocked Steps task keeps the blocked check
  const cls = ['check', extra, done && 'done', archived && 'archived', !archived && r.hasProgress && !done && 'prog', steps && 'steps', !!r.step && r.progress > 0 && !done && 'walked', !archived && r.blocked && !done && 'blocked', isPaused && 'paused'].filter(Boolean).join(' ');
  const lock = !archived && r.blocked && !done ? '<svg class="ico lock-ico"><use href="#i-lock"/></svg>' : '';
  const pause = isPaused ? '<svg class="ico pause-ico"><use href="#i-pause"/></svg>' : '';
  const act = tag === 'button' ? ` type="button" data-act="check" role="checkbox" aria-checked="${done}" aria-label="${esc(t.content || '')}"` : '';   // never a submit: the composer's own check sits inside its <form>
  return `<${tag} class="${cls}"${act} style="--pc:${esc(r.pc)}${r.hasProgress ? ';--p:' + r.progress : ''}">${steps ? '<i class="ring"></i>' : ''}${lock}${pause}</${tag}>`;
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
    return `${check}<span class="pick-name">${titleHtml}</span>${chips ? `<span class="areas inline-flex items-center gap-6 flex-none">${chips}</span>` : ''}${projChipHtml(r.projName, r.isDefaultProj)}`;
  }
  const showProj = !!(r.projName || r.isDefaultProj) && (opts.proj === true || (opts.proj !== false && nav !== 'project' && nav !== 'backlog'));
  const badges = opts.badges !== false;
  // A checklist folds under the SAME chevron as subtasks — one gesture for "hide what's inside this row".
  const chkCount = (r.chk || t.checklist || []).length;
  const chev = (opts.chevron !== false && r.fold !== false && (r.childCount || (!r.step && chkCount)))   // a Steps row shows no checklist to fold   // r.fold: false in a view that ignores folding
    ? `<button type="button" class="row-chev${r.depth > 0 ? ' boxed' : ''}" data-act="collapse" aria-label="Fold" aria-expanded="${!r.collapsed}"${r.collapsed ? ' style="transform:rotate(-90deg)"' : ''}><svg class="ico"><use href="#i-chev-d"/></svg></button>` : '';
  const recArr = recList(t.recurrence), check = checkHtml(opts.tray ? { ...r, hasProgress: false } : r, 'button', '', recArr);   // the tray drops the checklist ring; same builder the link picker uses, so both read the task's state identically
  const areas = r.areas.length ? `<span class="areas inline-flex items-center gap-6 flex-none"${r.areas.length === 1 ? ` style="--tc:${esc(r.areas[0].color)}"` : ''}>${r.areas.map(areaChipHtml).join('')}</span>` : '';
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
  const est = m(badges && r.estSize, 'i-size-' + r.estSize, '', 'est', ` title="${esc(r.est + (r.estRollup ? ' (total of subtasks)' : ''))}"`);
  const dl = m(badges && t.deadline_at, 'i-flag', r.dl?.label, 'dl' + (r.dl?.overdue ? ' over' : ''));
  const loc = m(badges && r.loc, r.locX ? 'i-pin-off' : 'i-pin', r.loc, 'loc');
  // "after done" repeats (any rule from_completion) get the repeat+check glyph in both the due badge and the standalone chip.
  const repHref = recArr.some(x => x.from_completion) ? '#i-repeat-done' : '#i-repeat';
  const due = badges && r.due ? `<span class="badge ${esc(r.due.kind || '')} inline-flex items-center gap-4">${t.recurrence ? `<svg class="ico badge-rep"><use href="${repHref}"/></svg>` : ''}<span>${esc(r.due.label + (r.dueTime ? ' ' + r.dueTime : ''))}</span></span>` : '';
  const rep = m(badges && t.recurrence && !r.due, repHref.slice(1), '');   // a repeat with no date hosts the glyph itself
  const titleHtml = (r.titleHtml ?? mdTitle(t.content)).replaceAll('</code>', _copyCode + '</code>');   // cached inline-only title; copy controls belong to full rows, not pickers
  const row1 = (left, right) => `<div class="row1 flex items-center gap-8"><div class="r1l flex items-center gap-6 min-w-0 grow"><span class="title">${titleHtml}</span>${left}</div><div class="r1r flex items-center gap-8 min-w-0">${right}</div></div>`;
  // Plan's tray: one flat line — check, title, project, when. Nothing that unfolds, nests or ages (user, decision #79).
  if (opts.tray) return check + `<div class="body grow min-w-0">${row1(proj, sched + dl + due + rep)}</div>`;
  // One chip per item, blockers then files; the ladder drops names one at a time and rolls a kind's >3 into its first chip's count (app.js _relIcon).
  const rels = opts.rels !== false && r.rels.length ? `<div class="row-rels flex items-center gap-8 min-w-0">${r.rels.map(rl =>
    `<button type="button" class="row-rel ${rl.type} inline-flex items-center gap-4 muted-11" data-act="rel" data-kind="${rl.type}" data-rel="${esc(rl.id)}" aria-label="${esc(rl.label)}"><svg class="ico"><use href="#${esc(rl.icon)}"/></svg><span class="row-rel-name">${esc(rl.name)}</span>${rl.n ? `<span class="row-rel-n">${rl.n}</span>` : ''}</button>`).join('')}</div>` : '';
  // Relations are a LINE-1 CITIZEN — the ladder sheds them like anything else, so a row with a relation is
  // no longer two lines at every width. The DESCRIPTION is the deliberate exception: prose always owns its own line
  // (user, 2026-08-17), so it never competes with the title and never joins the meta line. → app.js LADDER
  const head = t.notes ? t.notes.slice(0, mdCut(t.notes, 0, 1000)) : '';   // one line shows: the first 1000+ chars, never half a fence
  let lead = head;
  for (const m of _hasFence(head) ? head.matchAll(_fences) : []) if (m[1].includes('\n')) {   // a code block after prose would wrap below the one line, half clipped; a one-line fence stays inline
    if (head.slice(0, m.index).trim()) lead = head.slice(0, m.index);
    break;
  }
  const desc = t.notes ? `<div class="row2 flex items-center gap-8"><span class="desc-line grow min-w-0 truncate">${md(lead, { inline: true, copy: true })}</span></div>` : '';
  // Checklist items pre-split (text::desc) in mkRow; fall back for callers that pass a bare row.
  const cl = r.chk || (t.checklist || []).map(chkParts);
  // Display-only sort: done below open (stable); data-ci = original index so toggling never reorders the stored array.
  const plain = !!t.checklist_plain;   // uncheckable: plain notes list — bullets instead of boxes, no done styling
  const { rows: clRows, hidden, more } = chkVisible(cl, plain, opts.chkOpen, opts.chkHeld);
  const morePlaceholder = more ? `<button type="button" class="chk-row flex gap-8 chk-more" data-act="chk-more"><span class="chk-more-txt">${hidden ? '…' + hidden + ' more' : 'Show less'}</span></button>` : '';
  const chkMd = s => md(s, { inline: true, literal: !_hasFence(s), copy: true });
  const renderRow = ({ ci, done, txt, desc }) =>
    `<div class="chk-row flex gap-8${done && !plain ? ' done' : ''}" data-ci="${ci}"><span class="chk-rect${plain ? ' plain' : done ? ' done' : ''}"></span><span class="chk-txt truncate min-w-0">${chkMd(txt)}</span>${desc ? `<span class="chk-desc truncate min-w-0">${chkMd(desc)}</span>` : ''}</div>`;
  const chk = opts.checklist !== false && cl.length && !r.step && !(r.collapsed && r.fold !== false) ? `<div class="chk-list flex-col">${clRows.map(renderRow).join('')}${morePlaceholder}</div>` : '';
  // Steps: the current step hangs under the (smaller) title at title size, its ::desc on a line of its own, then the
  // next open step on the rail — its node ticks it (app.js onRowClick).
  const step = r.step ? `<div class="step-block" style="--pc:${esc(r.pc)}"><div class="row-step"><span class="chk-txt">${chkMd(r.step.txt)}</span></div>${r.step.desc ? `<div class="step-desc truncate">${chkMd(r.step.desc)}</div>` : ''}${r.next
    ? `<div class="step-next flex items-center" data-ci="${r.next.ci}"><span class="chk-rect step-node" role="checkbox" aria-checked="false" aria-label="Tick the next step"></span><span class="step-next-txt truncate min-w-0">${chkMd(r.next.txt)}</span></div>` : ''}</div>` : '';
  return chev + check + `<div class="body grow min-w-0">${row1(areas + proj + rels, sched + est + dl + loc + due + rep)}${step}${desc}${chk}</div>`;
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
  const cnt = (it.count ?? '') !== '' ? `<span class="rl-cnt">${esc(it.count)}</span>` : '';
  const more = it.kind === 'loc' ? '' : it.kind === 'arch' ? `<svg class="ico rl-chev${it.open ? ' open' : ''}"><use href="#i-chev-d"/></svg>`   // 'Manage locations' has no per-item menu; the Archived row folds
    : `<button type="button" class="rl-more" data-more="${it.kind}:${it.id ?? ''}">&#8943;</button>`;
  // The rail has no drag, so these arrows ARE the ordering control — they sit beside the ⋯ instead of inside it
  // because reordering is a repeated one-press-per-step action, and a menu round-trip per step kills that.
  // Backlog/locations are fixed rows: there is nothing to order them against.
  const mv = ['proj', 'area', 'filter'].includes(it.kind) && !it.archived ? `<span class="rl-mv">${[-1, 1].map(d =>
    `<button type="button" class="rl-mvb" data-move="${it.kind}:${it.id}:${d}" aria-label="Move ${d < 0 ? 'up' : 'down'}"><svg class="ico"><use href="#i-chev-d"/></svg></button>`).join('')}</span>` : '';
  const cls = it.kind === 'arch' ? ' rl-arch-row' : it.archived ? ' rl-arch' : '';
  return html`<div class="rl-box${cls}" data-ridx="${it.ridx}"${raw(indent)}>${raw(icon)}<span class="rl-nm">${it.label}</span>${raw(cnt)}${raw(mv)}${raw(more)}</div>`;
};

// The strip IS the navigation on a phone (the hamburger is gone), so every dot needs a name: cd-far wears
// only its icon, and the current one carries a second job — pressing it opens the overview — that its visible
// label doesn't say. aria-label wins over the label text, so it has to repeat the surface name.
// A surface may fold its own sub-modes into its dot while it is current — Plan does, on a phone, where the
// calendar's views join the app's one navigator instead of floating a second cluster over the grid
// (calendar-mobile-controls-explorations #6). It is a SIBLING of the dot, never a child: a button inside a
// button is invalid and the parser hoists it straight back out. Plan's actions follow the views (D5, Android
// P4/P8): "T" only while today is out of view, the task panel, and ＋ new task (held: new event, D8) — `data-act`, dotStripClick.
const segHtml = (seg) => !seg ? '' : `<span class="cd-seg">${seg.views.map(v =>
  `<button type="button" data-v="${esc(v)}" data-sk="Day / week / month" data-sk-key="${esc(v[0])}" class="cd-segb${v === seg.cur ? ' on' : ''}" aria-label="${esc(v)} view" aria-pressed="${v === seg.cur}">${esc(v[0].toUpperCase())}</button>`).join('')}</span>`
  + `<button type="button" data-act="today" class="cd-act cd-today" aria-label="Today"${seg.today ? '' : ' style="visibility:hidden"'}>T</button>`   // keeps its slot: toggling it never re-centres the strip
  + `<button type="button" data-act="side" class="cd-act${seg.side ? ' on' : ''}" aria-label="Task panel" aria-pressed="${!!seg.side}"><svg class="ico cd-ico" aria-hidden="true"><use href="#i-panel-r"/></svg></button>`
  + '<button type="button" data-act="add" data-sk="New task" class="cd-act" aria-label="New task (hold for event)" title="New task (hold for event)">＋</button>';

export const dotStripHtml = (surfaces, idx) =>
  surfaces.map((s, i) => {
    const d = Math.abs(i - idx);
    // Its own icon, on every dot — the pip it replaces named nothing, so a far surface was only reachable by
    // counting positions. The icon is the constant; the label is what drops away with distance.
    const ico = raw(`<svg class="ico cd-ico" aria-hidden="true"><use href="#${esc(s.icon || 'i-all')}"/></svg>`);
    const label = s.unread ? s.label + ', new messages' : s.label, cls = s.unread ? ' cd-new' : '';   // the quiet unread dot (soc-1b)
    if (i === idx) { const dot = html`<button type="button" data-idx="${i}" data-sk="Overview" class="cd cd-cur${cls}" aria-label="${label}, open menu" aria-haspopup="dialog">${ico}<span class="cd-lab">${s.label}</span></button>`;
      return s.seg ? `<span class="cd-plan">${dot}${segHtml(s.seg)}</span>` : dot; }
    if (d === 1)   return html`<button type="button" data-idx="${i}" data-sk="Go to ${s.label}" class="cd cd-near${cls}" aria-label="${label}">${ico}<span class="cd-lab">${s.label}</span></button>`;
    return html`<button type="button" data-idx="${i}" data-sk="Go to ${s.label}" class="cd cd-far${cls}" aria-label="${label}">${ico}</button>`;
  }).join('');
