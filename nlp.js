// Pure date + quick-add-tokenizer helpers. No DOM — shared by index.html and unit-tested in tests/.
// `now` is injectable so all relative-date logic is deterministic under test.
import DESIGN from './design.json' with { type: 'json' };
const L = DESIGN.lang.labels;
const V = DESIGN.lang.nlp;

export const isoDate = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Client half of the reminders future-only rule (server: pg/functions/reject_past_reminder.sql):
// a user-created absolute reminder's floating local `at` ('YYYY-MM-DDTHH:MM') must not be in the past.
// Lexicographic string comparison — same convention as the Android client.
export const isPastAt = (at, now = new Date()) => !!at && at.length >= 16 && at < isoDate(now) + 'T' + now.toTimeString().slice(0, 5);

const midnight = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };
const shortDate = (d, now) => d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + (now && d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
const dayDiff = (iso, now) => {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00' : iso); d.setHours(0, 0, 0, 0);
  return { d, diff: Math.round((d - midnight(now)) / 86400000) };
};

// Short relative label for a due date: past reads "…ago", future extends past this week; both fall back to an
// absolute date beyond ~6 weeks. (Weekday shown for the coming few days; "Nd ago" for the past few.)
const relDue = (d, diff, now) => {
  const ago = diff < 0, n = Math.abs(diff);
  if (n === 1)  return ago ? L.yest : L.tmr;
  if (n <= 6)   return ago ? `${n}d ago` : d.toLocaleDateString([], { weekday: 'short' });
  if (n <= 13)  return ago ? 'Last week' : 'Next wk';
  if (n <= 27)  return `${Math.round(n / 7)}w${ago ? ' ago' : ''}`;
  if (n <= 45)  return ago ? 'Last month' : 'Next month';
  return shortDate(d, now);
};

export function dueBadge(due, now = new Date()) {
  if (!due) return null;
  const { d, diff } = dayDiff(due, now);
  if (diff === 0) return { label: L.today, kind: 'today' };
  const kind = diff < 0 ? 'overdue' : diff <= 6 ? 'soon' : 'later';   // color band; labels themselves are relative
  return { label: relDue(d, diff, now), kind };
}

export function deadlineLeft(deadline, now = new Date()) {
  if (!deadline) return null;
  const { diff } = dayDiff(deadline, now);
  if (diff === 0) return { label: L.today, overdue: true };
  const n = Math.abs(diff);
  return diff < 0 ? { label: L.dOver.replace('{n}', n), overdue: true } : { label: L.dLeft.replace('{n}', n), overdue: false };
}

// Pure lifecycle of a task relative to its window [available_from, due_at] + effective (own-or-inherited) deadline.
// Deadline states take precedence over window states. nearDays = how close counts as "deadline nearing".
export function dueState(task, now = new Date(), effDeadline = task?.deadline_at || null, nearDays = 1) {
  const today = isoDate(now);
  const from = task?.available_from ? task.available_from.slice(0, 10) : null;
  const to = task?.due_at ? task.due_at.slice(0, 10) : null;
  const dl = effDeadline ? effDeadline.slice(0, 10) : null;
  if (dl && today > dl) return 'deadline_passed';
  if (dl && dayDiff(dl, now).diff <= nearDays) return 'deadline_near';
  if (from && today < from) return 'upcoming';
  if (to && today > to) return 'soft_slipped';
  if (to && (!from || today >= from)) return 'in_window';   // today <= to (else soft_slipped) and window has opened
  if (from && today >= from) return 'in_window';            // open-ended future window that has started
  return 'none';
}

// Badge for a window: point/open-start reuse dueBadge (keyed on the latest); a true range shows its span.
export function windowBadge(task, now = new Date()) {
  const from = task?.available_from ? task.available_from.slice(0, 10) : null;
  const to = task?.due_at ? task.due_at.slice(0, 10) : null;
  if (!to && !from) return null;
  if (!from || !to || from === to) return dueBadge(to || from, now);
  const b = dueBadge(to, now);
  const fromD = new Date(from + 'T00:00'), toD = new Date(to + 'T00:00');
  const sameMonth = fromD.getMonth() === toD.getMonth() && fromD.getFullYear() === toD.getFullYear();
  return { label: shortDate(fromD, now) + '–' + (sameMonth ? toD.getDate() : shortDate(toD, now)), kind: b.kind, range: true };
}

export function quickDate(key, now = new Date()) {
  const d = midnight(now);
  if (key === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (key === 'yesterday') d.setDate(d.getDate() - 1);
  else if (key === 'weekend') d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  else if (key === 'nextweek') d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));
  return isoDate(d);
}

// Named relative phrase → an inclusive date window {from,to} (local wall-clock ISO). Single-day phrases give from===to.
export function quickRange(key, now = new Date()) {
  const s = midnight(now), from = new Date(s), to = new Date(s), g = s.getDay();
  if (key === 'tomorrow') { from.setDate(from.getDate() + 1); to.setDate(to.getDate() + 1); }
  else if (key === 'thisweek') { to.setDate(to.getDate() + ((7 - g) % 7)); }                 // today → this Sunday
  else if (key === 'nextweek') { from.setDate(from.getDate() + ((1 - g + 7) % 7 || 7)); to.setTime(from.getTime()); to.setDate(to.getDate() + 6); }
  else if (key === 'weekend') { from.setDate(from.getDate() + ((6 - g + 7) % 7 || 7)); to.setTime(from.getTime()); to.setDate(to.getDate() + 1); }
  return { from: isoDate(from), to: isoDate(to) };   // 'today' falls through: from===to===today
}

// Weekday (0=Sun..6=Sat) in NEXT week; "next week <wd>"/"next <wd>" both anchor to Mon.
const nextWeekDate = (targetDay, now) => {
  const d = midnight(now);
  d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));   // → next Monday (start of next week)
  d.setDate(d.getDate() + ((targetDay - 1 + 7) % 7));         // → that weekday within the Mon–Sun week
  return d;
};

const MONTHS = V.months;
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIdx = w => MONTHS.indexOf(w.slice(0, 3).toLowerCase());
// no year: rolls to next year if already past
function monthDayIso(mi, day, year, now) {
  if (mi < 0 || day < 1 || day > 31) return null;
  let d = new Date(year || now.getFullYear(), mi, day);
  if (isNaN(+d)) return null;
  if (!year && d < midnight(now)) d = new Date(now.getFullYear() + 1, mi, day);
  return isoDate(d);
}

export function parseDate(s, now = new Date()) {
  s = (s || '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (V.dueToday.includes(low)) return isoDate(now);
  if (V.dueTomorrow.includes(low)) return quickDate('tomorrow', now);
  if (V.dueYesterday.includes(low)) return quickDate('yesterday', now);
  if (V.weekend.includes(low)) return quickDate('weekend', now);
  if (V.nextWeek.includes(low)) return quickDate('nextweek', now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // weekday name: bare = nearest upcoming; "next <wd>" / "next week <wd>" = that day NEXT week
  const days = V.weekdays;
  const wd = low.match(/^(next\s+week\s+|next\s+)?(sun|mon|tue|wed|thu|fri|sat)/);
  if (wd) {
    const t = days.indexOf(wd[2]);
    if (wd[1]) return isoDate(nextWeekDate(t, now));
    const d = midnight(now); d.setDate(d.getDate() + ((t - d.getDay() + 7) % 7));
    return isoDate(d);
  }
  const rel = low.match(/^(?:in\s+)?(\d+)\s*d(?:ays?)?$/);
  if (rel) { const d = midnight(now); d.setDate(d.getDate() + +rel[1]); return isoDate(d); }
  let mn = low.match(new RegExp('^' + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$'));
  if (mn) return monthDayIso(monthIdx(mn[1]), +mn[2], mn[3] && +mn[3], now);
  mn = low.match(new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_RE + '(?:,?\\s+(\\d{4}))?$'));
  if (mn) return monthDayIso(monthIdx(mn[2]), +mn[1], mn[3] && +mn[3], now);
  const md = s.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
  if (md) {
    let yr = md[3] ? +md[3] : now.getFullYear(); if (yr < 100) yr += 2000;
    const d = new Date(yr, +md[1] - 1, +md[2]);
    return isNaN(d) ? null : isoDate(d);
  }
  // native Date only for strings with an explicit 4-digit year (too lenient otherwise, e.g. "10" → Oct 1)
  if (!/(19|20|21)\d{2}/.test(s)) return null;
  const d = new Date(s);
  return isNaN(+d) ? null : isoDate(d);
}

export function parseTime(s) {
  const low = (s || '').toLowerCase();
  let m = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) { let h = +m[1] % 12; if (m[3] === 'pm') h += 12; return String(h).padStart(2, '0') + ':' + (m[2] || '00'); }
  m = low.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return m ? String(+m[1]).padStart(2, '0') + ':' + m[2] : '';
}

// bare time defaults date to today
export function parseDateText(s, now = new Date()) {
  s = (s || '').trim();
  const time = parseTime(s);
  const dateStr = time
    ? s.replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, '').replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/, '').trim()
    : s;
  let iso = dateStr ? parseDate(dateStr, now) : null;
  if (!iso && time) iso = isoDate(now);
  return { iso, time };
}

// Recurrence grammar ("every[!] <rule>") — shared by parseQuick (strips) and parseRecurrence (date field).
const REC_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const REC_DAY_RE = '(?:sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\\b';
const REC_RULE = '(?:(?:' + REC_DAY_RE + ')(?:\\s*,\\s*|\\s+)?)+|weekday|\\d+\\s*(?:days?|weeks?|months?|years?)|days?|weeks?|months?|years?|\\d{1,2}(?:st|nd|rd|th)';
const REC_FULL = '\\severy(!?)(?:\\s+(' + REC_RULE + '))?(?:\\s+(?:for\\s+(\\d+)\\s+times?|x(\\d+)|until\\s+(.+)))?(?=\\s|$)';
function buildRecurrence(bang, rule, count, xCount, until, now) {
  if (!rule && !bang) return null;   // bare "every" with no rule/bang is not a recurrence
  const rec = { freq: 'day', interval: 1, from_completion: !!bang, ends: null, done_count: 0 };
  const body = (rule || '').toLowerCase();
  const n = body.match(/^(\d+)/), interval = n ? +n[1] : 1;
  if (/weekday/.test(body)) Object.assign(rec, { freq: 'week', weekdays: [1, 2, 3, 4, 5] });
  else if (new RegExp('^' + REC_DAY_RE).test(body)) {
    rec.freq = 'week';
    rec.weekdays = (body.match(new RegExp(REC_DAY_RE, 'g')) || []).map(d => REC_DAYS.indexOf(d.slice(0, 3)));
  } else if (/days?$/.test(body)) Object.assign(rec, { freq: 'day', interval });
  else if (/weeks?$/.test(body)) Object.assign(rec, { freq: 'week', interval });
  else if (/months?$/.test(body)) Object.assign(rec, { freq: 'month', interval });
  else if (/years?$/.test(body)) Object.assign(rec, { freq: 'year', interval });
  else if (/^\d/.test(body)) Object.assign(rec, { freq: 'month', month_day: interval });   // "15th"
  if (count || xCount) rec.ends = { count: +(count || xCount) };
  else if (until) rec.ends = { date: parseDate(until.trim(), now) };
  return rec;
}
export function parseRecurrence(s, now = new Date()) {
  const m = (' ' + (s || '') + ' ').match(new RegExp(REC_FULL, 'i'));
  return m ? buildRecurrence(m[1], m[2], m[3], m[4], m[5], now) : null;
}

// hybrid tokenizer: live preview keeps tokens; strips on save. `locations` guards "at <name>" — only known names pill.
export function parseQuick(raw, now = new Date(), locations = []) {
  let s = ' ' + (raw || '') + ' ';
  const o = { priority: null, dueIso: null, dueFromIso: null, deadlineIso: null, dueTime: '', durMin: null, project: null, areas: [], recurrence: null, location: null, locationExcept: false };
  const setTime = (h, m) => o.dueTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  const DPRE = '(?:(?:on|due|by)\\s+)?';   // filler prepositions swallowed before a date
  const TPRE = '(?:(?:at|by|due)\\s+)?';   // ... and before a time
  const re = (body, flags = 'gi') => new RegExp('\\s' + body + '\\b', flags);

  s = s.replace(/\sp([1-4])\b/gi, (_, n) => (o.priority = +n, ' '));
  s = s.replace(/\s@([\w-]+)/g, (_, l) => (o.areas.push(l), ' '));
  s = s.replace(/\s#([\w-]+)/g, (_, p) => (o.project = p, ' '));

  // "in N <unit>" before bare durations so "in 3hr" doesn't become an estimate
  s = s.replace(/\sin\s+(\d+)\s*(months?|mos?|weeks?|wks?|days?|hours?|hrs?|h|minutes?|mins?|m)\b/gi, (_, n, unit) => {
    n = +n; const u = unit.toLowerCase(), d = new Date(now);
    if (/^mo/.test(u)) { d.setMonth(d.getMonth() + n); o.dueIso = isoDate(midnight(d)); }
    else if (/^w/.test(u)) { d.setDate(d.getDate() + n * 7); o.dueIso = isoDate(midnight(d)); }
    else if (/^d/.test(u)) { d.setDate(d.getDate() + n); o.dueIso = isoDate(midnight(d)); }
    else if (/^h/.test(u)) { d.setHours(d.getHours() + n); o.dueIso = isoDate(d); setTime(d.getHours(), d.getMinutes()); }
    else { d.setMinutes(d.getMinutes() + n); o.dueIso = isoDate(d); setTime(d.getHours(), d.getMinutes()); }
    return ' ';
  });

  // consumed before dates so "every monday" is a rule, not a dueIso
  s = s.replace(new RegExp(REC_FULL, 'gi'), (_m, bang, rule, count, xCount, until) => {
    const rec = buildRecurrence(bang, rule, count, xCount, until, now);
    if (!rec) return _m;
    o.recurrence = rec;
    return ' ';
  });

  // consumed before due-date matchers so the keyword's date isn't also taken as a due date
  s = s.replace(/\s(?:deadline|ddl|dl)\s+(.+?)(?=\s+p[1-5]\b|\s+[#@]|\s+every\b|\s*$)/i, (m, dateStr) => {
    const iso = parseDate(dateStr.trim(), now);
    if (!iso) return m;                 // not a date → leave the text untouched
    o.deadlineIso = iso; return ' ';
  });

  s = s.replace(re(DPRE + '(\\d{4}-\\d{2}-\\d{2})'), (_, iso) => (o.dueIso = iso, ' '));
  s = s.replace(re(DPRE + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?'),
    (_, mon, day, yr) => (o.dueIso = monthDayIso(monthIdx(mon), +day, yr && +yr, now) || o.dueIso, ' '));
  s = s.replace(re(DPRE + '(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_RE + '(?:,?\\s+(\\d{4}))?'),
    (_, day, mon, yr) => (o.dueIso = monthDayIso(monthIdx(mon), +day, yr && +yr, now) || o.dueIso, ' '));
  s = s.replace(re(DPRE + '(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?'), (_, a, b, y) => {
    let yr = y ? +y : now.getFullYear(); if (yr < 100) yr += 2000;
    const d = new Date(yr, +a - 1, +b); if (!isNaN(+d)) o.dueIso = isoDate(d); return ' ';
  });

  const DUE_WORDS = [...V.dueToday, ...V.dueTomorrow, ...V.dueYesterday].sort((a, b) => b.length - a.length);
  s = s.replace(re(DPRE + '(' + DUE_WORDS.join('|') + ')'), (_, w) => {
    const lw = w.toLowerCase();
    const key = V.dueYesterday.includes(lw) ? 'yesterday' : V.dueTomorrow.includes(lw) ? 'tomorrow' : 'today';
    if (key === 'yesterday') return (o.dueIso = quickDate('yesterday', now), ' ');   // past point — open-start
    const r = quickRange(key, now);
    return (o.dueFromIso = r.from, o.dueIso = r.to, ' ');
  });
  const WKND_RE = V.weekend.map(w => w.replace(' ', '\\s+')).sort((a, b) => b.length - a.length).join('|');
  s = s.replace(re(DPRE + '(' + WKND_RE + ')'), () => { const r = quickRange('weekend', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  // parsed as ONE unit (before bare "next week" / bare weekday)
  s = s.replace(re(DPRE + 'next\\s+week\\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)'), (_, w) =>
    (o.dueIso = o.dueFromIso = isoDate(nextWeekDate(REC_DAYS.indexOf(w.slice(0, 3).toLowerCase()), now)), ' '));
  const THISWK_RE = V.thisWeek.map(w => w.replace(' ', '\\s+')).join('|');
  s = s.replace(new RegExp('\\s(?:' + THISWK_RE + ')\\b', 'gi'), () => { const r = quickRange('thisweek', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  s = s.replace(new RegExp('\\s(?:' + V.nextWeek.map(w => w.replace(' ', '\\s+')).join('|') + ')\\b', 'gi'), () => { const r = quickRange('nextweek', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  s = s.replace(re(DPRE + '(next\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)'), (_, nx, w) => {
    const t = REC_DAYS.indexOf(w.slice(0, 3).toLowerCase());
    if (nx) { o.dueIso = o.dueFromIso = isoDate(nextWeekDate(t, now)); return ' '; }   // "next <wd>" → that day next week
    const d = midnight(now); d.setDate(d.getDate() + ((t - d.getDay() + 7) % 7 || 7));
    o.dueIso = o.dueFromIso = isoDate(d); return ' ';
  });

  s = s.replace(/\s(\d+)\s*(?:h|hr|hrs|hours?)(?:\s*(\d+)\s*(?:m|min|mins|minutes?))?\b/gi, (_, h, m) => (o.durMin = +h * 60 + (m ? +m : 0), ' '));
  s = s.replace(/\s(\d+)\s*(?:m|min|mins|minutes?)\b/gi, (_, m) => (o.durMin == null && (o.durMin = +m), ' '));

  s = s.replace(re(TPRE + '(noon|midnight)'), (_, w) => (setTime(/mid/i.test(w) ? 0 : 12, 0), ' '));
  s = s.replace(re(TPRE + '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)'), (_, h, m, ap) => {
    h = +h % 12; if (/pm/i.test(ap)) h += 12; setTime(h, m ? +m : 0); return ' ';
  });
  s = s.replace(re(TPRE + '([01]?\\d|2[0-3]):([0-5]\\d)'), (_, h, m) => (setTime(+h, +m), ' '));

  if (locations && locations.length) {
    const byLen = [...locations].sort((a, b) => b.length - a.length);
    const alt = byLen.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const found = name => byLen.find(n => n.toLowerCase() === name.toLowerCase()) || name;
    // negation first ("not at X" / "away from X" are synonyms), then plain "at X"
    s = s.replace(new RegExp('\\s(?:not\\s+at|away\\s+from)\\s+(' + alt + ')(?=\\s|$)', 'i'), (_m, name) =>
      (o.location = found(name), o.locationExcept = true, ' '));
    if (!o.location) s = s.replace(new RegExp('\\sat\\s+(' + alt + ')(?=\\s|$)', 'i'), (_m, name) =>
      (o.location = found(name), ' '));
  }

  o.content = s.replace(/\s+/g, ' ').trim();
  return o;
}

// parseQuick must fully consume and set exactly one field; else null
export function classifyToken(text, now = new Date(), locations = []) {
  const s = (text || '').trim();
  if (!s) return null;
  const p = parseQuick(s, now, locations);
  if (p.content !== '') return null;                                  // leftover text → not one token
  if (p.areas.length > 1) return null;                               // multiple areas ≠ one token
  const hits = [];
  if (p.priority != null) hits.push({ kind: 'pri', value: p.priority });
  if (p.dueIso || p.dueTime) hits.push({ kind: 'date', value: { iso: p.dueIso, from: p.dueFromIso, time: p.dueTime } });
  if (p.deadlineIso) hits.push({ kind: 'deadline', value: { iso: p.deadlineIso } });
  if (p.durMin != null) hits.push({ kind: 'dur', value: p.durMin });
  if (p.project) hits.push({ kind: 'proj', value: p.project });
  if (p.areas.length === 1) hits.push({ kind: 'area', value: p.areas[0] });
  if (p.recurrence) hits.push({ kind: 'rec', value: p.recurrence });
  if (p.location) hits.push({ kind: 'loc', value: (p.locationExcept ? 'away from ' : '') + p.location });   // pill label carries the polarity
  return hits.length === 1 ? hits[0] : null;                          // none or ambiguous → null
}

export function tokenizeAll(text, now = new Date(), locations = []) {
  const parts = (text || '').match(/\s+|\S+/g) || [];      // alternating whitespace / word runs
  const isWord = p => /\S/.test(p);
  const segs = [];
  const addText = t => { const l = segs[segs.length - 1]; if (l && l.text !== undefined) l.text += t; else segs.push({ text: t }); };
  let i = 0;
  while (i < parts.length) {
    if (!isWord(parts[i])) { addText(parts[i]); i++; continue; }
    let best = null, bestJ = i, bestSpan = '', span = '';
    for (let j = i; j < parts.length && j - i <= 6; j++) {
      span += parts[j];
      if (!isWord(parts[j])) continue;                     // only test at word ends
      const cls = classifyToken(span.trim(), now, locations);
      if (cls) { best = cls; bestJ = j; bestSpan = span; }
    }
    if (best) { segs.push({ kind: best.kind, value: best.value, token: bestSpan.trim() }); i = bestJ + 1; }
    else { addText(parts[i]); i++; }
  }
  return segs;
}

// longest token at trailing end — "every" waits, "every 2 weeks" pills
export function matchTrailingToken(pending, now = new Date(), locations = []) {
  const text = pending || '';
  const offsets = []; const re = /\S+/g; let m;
  while ((m = re.exec(text))) offsets.push(m.index);
  for (const start of offsets) {
    const tok = classifyToken(text.slice(start), now, locations);
    if (tok) return { ...tok, start };
  }
  return null;
}

export function recurrenceLabel(rec) {
  if (!rec) return '';
  const n = rec.interval || 1, days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ord = d => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
  if (rec.freq === 'week' && rec.weekdays?.length) {
    const wd = [...rec.weekdays].sort((a, b) => a - b);
    if (wd.join() === '1,2,3,4,5') return 'Weekdays';
    return 'Every ' + wd.map(d => days[d]).join(', ');
  }
  if (rec.freq === 'month' && rec.month_day) return 'Every ' + ord(rec.month_day);
  const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[rec.freq] || rec.freq;
  return n > 1 ? `Every ${n} ${unit}s` : 'Every ' + unit;
}

// Fuller one-line summary for the repeat picker: base label + until/count end + paused state.
export function recurrenceSummary(rec) {
  if (!rec) return '';
  let s = recurrenceLabel(rec);
  if (rec.ends?.count != null) s += `, ${rec.ends.count}×`;
  else if (rec.ends?.date) s += ', until ' + new Date(rec.ends.date + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (rec.paused) s += ' (paused)';
  return s;
}

export function logDayLabel(day) {
  const d = new Date(day + 'T00:00:00'), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 864e5);
  if (diff === 0) return L.today;
  if (diff === 1) return L.yesterday;
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// bare date inherits now's time; future timestamps clamp to now; falls back to `dflt`
export function parseLogNote(raw, now = new Date(), dflt = null) {
  const clean = s => (s || '').trim() || null;
  const text = (raw || '').trim();
  if (!text) return { note: clean(dflt), ts: null };
  const segs = tokenizeAll(text, now);
  const dateSeg = segs.find(s => s.kind === 'date');
  if (!dateSeg) return { note: text, ts: null };
  const rest = segs.filter(s => s !== dateSeg).map(s => s.text !== undefined ? s.text : s.token).join('').replace(/\s+/g, ' ').trim();
  const { iso, time } = dateSeg.value;
  const d = iso ? new Date(iso + 'T00:00') : new Date(now);
  const [h, m] = time ? time.split(':').map(Number) : [now.getHours(), now.getMinutes()];
  d.setHours(h, m, 0, 0);
  return { note: clean(rest) ?? clean(dflt), ts: (d > now ? now : d).toISOString() };
}
