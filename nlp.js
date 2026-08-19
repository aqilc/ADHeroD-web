// Pure date + quick-add-tokenizer helpers. No DOM — shared by index.html and unit-tested in tests/.
// `now` is injectable so all relative-date logic is deterministic under test.
import DESIGN from './design.json' with { type: 'json' };
const L = DESIGN.lang.labels;
const V = DESIGN.lang.nlp;

export const isoDate = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Importance ordering (must > focus > none > someday). impRank: 0 = most important; unset → 'none'.
export const IMPORTANCE = ['must', 'focus', 'none', 'someday'];
export const impRank = v => { const i = IMPORTANCE.indexOf(v); return i < 0 ? 2 : i; };


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
  // A deadline that carries an HOUR counts down in hours once it's inside a day: "1d left" on a 9am hand-in
  // reads as a whole free day, which is exactly the rounding this app exists to stop. Date-only stays date-only.
  if (deadline.length > 10) {
    const ms = new Date(deadline) - now;
    if (Math.abs(ms) < 864e5) {
      if (ms < 0) return { label: L.hOver.replace('{n}', Math.max(1, Math.round(-ms / 36e5))), overdue: true };
      return ms < 36e5
        ? { label: L.mLeft.replace('{n}', Math.max(1, Math.round(ms / 6e4))), overdue: true }
        : { label: L.hLeft.replace('{n}', Math.round(ms / 36e5)), overdue: false };
    }
  }
  const { diff } = dayDiff(deadline, now);
  if (diff === 0) return { label: L.today, overdue: true };
  const n = Math.abs(diff);
  return diff < 0 ? { label: L.dOver.replace('{n}', n), overdue: true } : { label: L.dLeft.replace('{n}', n), overdue: false };
}


// Badge for a window: point/open-start reuse dueBadge (keyed on the latest); a true range shows its span.
export function windowBadge(task, now = new Date()) {
  const from = task?.available_from ? task.available_from.slice(0, 10) : null;
  const to = task?.recur_from ? task.recur_from.slice(0, 10) : null;
  if (!to && !from) return null;
  if (!from || !to || from === to) return dueBadge(to || from, now);
  const b = dueBadge(to, now);
  const fromD = new Date(from + 'T00:00'), toD = new Date(to + 'T00:00');
  const sameMonth = fromD.getMonth() === toD.getMonth() && fromD.getFullYear() === toD.getFullYear();
  return { label: shortDate(fromD, now) + '–' + (sameMonth ? toD.getDate() : shortDate(toD, now)), kind: b.kind, range: true };
}

// Named relative phrase → an inclusive date window {from,to} (local wall-clock ISO). Single-day phrases give from===to.
export function quickRange(key, now = new Date()) {
  const s = midnight(now), from = new Date(s), to = new Date(s), g = s.getDay();
  if (key === 'tomorrow') { from.setDate(from.getDate() + 1); to.setDate(to.getDate() + 1); }
  else if (key === 'yesterday') { from.setDate(from.getDate() - 1); to.setDate(to.getDate() - 1); }
  else if (key === 'thisweek') { to.setDate(to.getDate() + ((7 - g) % 7)); }                 // today → this Sunday
  else if (key === 'nextweek') { from.setDate(from.getDate() + ((1 - g + 7) % 7 || 7)); to.setTime(from.getTime()); to.setDate(to.getDate() + 6); }
  else if (key === 'weekend') { from.setDate(from.getDate() + ((6 - g + 7) % 7 || 7)); to.setTime(from.getTime()); to.setDate(to.getDate() + 1); }
  return { from: isoDate(from), to: isoDate(to) };   // 'today' falls through: from===to===today
}
// A phrase's single date IS its window's start — one set of offsets, two shapes.
export const quickDate = (key, now = new Date()) => quickRange(key, now).from;

// Weekday (0=Sun..6=Sat) in NEXT week; "next week <wd>"/"next <wd>" both anchor to Mon.
const nextWeekDate = (targetDay, now) => {
  const d = midnight(now);
  d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));   // → next Monday (start of next week)
  d.setDate(d.getDate() + ((targetDay - 1 + 7) % 7));         // → that weekday within the Mon–Sun week
  return d;
};

const MONTHS = V.months, DAYS = V.weekdays;   // design.json is the single source for both
// weekday alternation for the quick-add matchers (long form first so "sunday" doesn't stop at "sun")
const WD_ALT = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat';
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
  const wd = low.match(/^(next\s+week\s+|next\s+)?(sun|mon|tue|wed|thu|fri|sat)/);
  if (wd) {
    const t = DAYS.indexOf(wd[2]);
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

function parseTime(s) {
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
const REC_DAY_RE = '(?:sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\\b';
const REC_RULE = '(?:(?:' + REC_DAY_RE + ')(?:\\s*,\\s*|\\s+)?)+|weekday|\\d+\\s*(?:days?|weeks?|months?|years?)|days?|weeks?|months?|years?|\\d{1,2}(?:st|nd|rd|th)';
// The count needs `for` or the popover's own comma (", 3 times"): a bare "<n> times" is ordinary English
// ("every day 2 times daily" is a frequency, not an end) and eating it silently loses title text.
const REC_FULL = '\\severy(!?)(?:\\s+(' + REC_RULE + '))?(?:(?:\\s*,\\s*|\\s+for\\s+)(\\d+)\\s+times?|\\s+x(\\d+)|\\s+(until|ending)\\s+(.+))?(?=\\s|$)';
function buildRecurrence(bang, rule, count, xCount, until, now) {
  if (!rule && !bang) return null;   // bare "every" with no rule/bang is not a recurrence
  const rec = { freq: 'day', interval: 1, from_completion: !!bang, ends: null, done_count: 0 };
  const body = (rule || '').toLowerCase();
  const n = body.match(/^(\d+)/), interval = n ? +n[1] : 1;
  if (/weekday/.test(body)) Object.assign(rec, { freq: 'week', weekdays: [1, 2, 3, 4, 5] });
  else if (new RegExp('^' + REC_DAY_RE).test(body)) {
    rec.freq = 'week';
    rec.weekdays = (body.match(new RegExp(REC_DAY_RE, 'g')) || []).map(d => DAYS.indexOf(d.slice(0, 3)));
  } else if (/days?$/.test(body)) Object.assign(rec, { freq: 'day', interval });
  else if (/weeks?$/.test(body)) Object.assign(rec, { freq: 'week', interval });
  else if (/months?$/.test(body)) Object.assign(rec, { freq: 'month', interval });
  else if (/years?$/.test(body)) Object.assign(rec, { freq: 'year', interval });
  else if (/^\d/.test(body)) Object.assign(rec, { freq: 'month', month_day: interval });   // "15th"
  if (count || xCount) rec.ends = { count: +(count || xCount) };
  else if (until) { const d = parseDate(until.trim(), now); if (d) rec.ends = { date: d }; }   // a non-date tail is prose, not an end
  return rec;
}
export function parseRecurrence(s, now = new Date()) {
  const m = (' ' + (s || '') + ' ').match(new RegExp(REC_FULL, 'i'));
  return m ? buildRecurrence(m[1], m[2], m[3], m[4], m[6], now) : null;
}

// hybrid tokenizer: live preview keeps tokens; strips on save. `locations` (the places already in use) guards
// "at <name>" — only a known place pills, so "Meet Sam at 5pm" never invents one.
export function parseQuick(raw, now = new Date(), locations = []) {
  let s = ' ' + (raw || '') + ' ';
  const o = { importance: null, dueIso: null, dueFromIso: null, deadlineIso: null, dueTime: '', durMin: null, project: null, areas: [], recurrence: null, location: null, locationExcept: false };
  const setTime = (h, m) => o.dueTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  const DPRE = '(?:on\\s+)?';   // "on" is filler before a date; by/due are the DEADLINE register (§11), matched earlier
  const TPRE = '(?:at\\s+)?';   // ... and "at" before a time
  const re = (body, flags = 'gi') => new RegExp('\\s' + body + '\\b', flags);

  // importance flag (app-behavior, not a rank): ! = focus, !! = must, ~ = someday
  s = s.replace(/\s(!{1,2}|~)(?=\s|$)/g, (_, t) => (o.importance = t === '~' ? 'someday' : t === '!!' ? 'must' : 'focus', ' '));
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
  s = s.replace(new RegExp(REC_FULL, 'gi'), (_m, bang, rule, count, xCount, untilWord, until) => {
    const rec = buildRecurrence(bang, rule, count, xCount, until, now);
    if (!rec) return _m;
    o.recurrence = rec;
    // the rule is real but its "until/ending" tail isn't a date — hand the prose back to the title,
    // as the sibling `only`/`by` matchers already do rather than swallowing what the user typed
    return untilWord && !rec.ends ? ' ' + untilWord + ' ' + until + ' ' : ' ';
  });

  // 'only <date>' walls BOTH sides — a one-day world-window ("vote only tue"). Leading form only:
  // a trailing "<date> only" stays literal ("aug 10 only tue" ambiguity). Consumed before by/due below.
  s = s.replace(/\sonly\s+(.+?)(?=\s+(?:!{1,2}|~)(?=\s|$)|\s+[#@]|\s+every\b|\s*$)/i, (m, dateStr) => {
    const { iso, time } = parseDateText(dateStr.trim(), now);
    if (!iso) return m;
    o.onlyIso = iso; o.deadlineIso = iso + (time ? 'T' + time : '');
    return ' ';
  });

  // Marked dates wall (§11): by/due/^ join the deadline keyword. Consumed before due-date matchers so
  // the keyword's date isn't also taken as a due date; a non-date tail leaves the text untouched.
  s = s.replace(/\s(?:(?:deadline|ddl|dl|by|due)\s+|\^\s*)(.+?)(?=\s+(?:!{1,2}|~)(?=\s|$)|\s+[#@]|\s+every\b|\s*$)/i, (m, dateStr) => {
    const { iso, time } = parseDateText(dateStr.trim(), now);   // "deadline fri 5pm" keeps the hour (F16)
    if (!iso) return m;                 // not a date → leave the text untouched
    o.deadlineIso = iso + (time ? 'T' + time : ''); return ' ';
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
  s = s.replace(re(DPRE + 'next\\s+week\\s+(' + WD_ALT + ')'), (_, w) =>
    (o.dueIso = o.dueFromIso = isoDate(nextWeekDate(DAYS.indexOf(w.slice(0, 3).toLowerCase()), now)), ' '));
  const THISWK_RE = V.thisWeek.map(w => w.replace(' ', '\\s+')).join('|');
  s = s.replace(new RegExp('\\s(?:' + THISWK_RE + ')\\b', 'gi'), () => { const r = quickRange('thisweek', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  s = s.replace(new RegExp('\\s(?:' + V.nextWeek.map(w => w.replace(' ', '\\s+')).join('|') + ')\\b', 'gi'), () => { const r = quickRange('nextweek', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  s = s.replace(re(DPRE + '(next\\s+)?(' + WD_ALT + ')'), (_, nx, w) => {
    const t = DAYS.indexOf(w.slice(0, 3).toLowerCase());
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
  // the popover shows `at <time>` INSIDE the repeat sentence — so a time with a rule and no one-off date
  // rides the RULE (matches applyDateText). A one-off date present ("friday at 5pm every week") keeps its time.
  if (o.recurrence && o.dueTime && !o.dueIso) { o.recurrence.at = o.dueTime; o.dueTime = ''; }

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
  if (p.importance != null) hits.push({ kind: 'imp', value: p.importance });
  if (p.dueIso || p.dueTime) hits.push({ kind: 'date', value: { iso: p.dueIso, from: p.dueFromIso, time: p.dueTime } });
  if (p.deadlineIso) hits.push({ kind: 'deadline', value: p.onlyIso ? { iso: p.onlyIso, only: true } : { iso: p.deadlineIso } });
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

// Natural-language importance (conservative): prefix `must X` / `focus on X` / `someday X`; suffix
// `X focus|someday|must` UNLESS the word before it is a connector (so "improve my focus" / "read up on
// focus" stay literal). Positional — it can't ride classifyToken (a title always leaves leftover), so
// it's parsed as a start/end pass by the composer's live trailing pill + the save-flush.
const IMP_CONNECTORS = new Set('a an the this that these those my your our their its his her on in of for to at by up about with into from is are was were be am no'.split(' '));

// Trailing importance word for the LIVE composer pill (consumes only the word). must/someday may lead
// (no word before); focus needs a real, non-connector word before it — so bare "focus …" never pills.
export function matchTrailingImportanceWord(text) {
  const m = (text || '').match(/(^|\s)(focus|someday|must)\s*$/i);
  if (!m) return null;
  const word = m[2].toLowerCase();
  const before = (text.slice(0, m.index + m[1].length)).trim();
  const prev = before ? before.split(/\s+/).pop().toLowerCase() : '';
  if (word === 'focus' ? (!prev || IMP_CONNECTORS.has(prev)) : (prev && IMP_CONNECTORS.has(prev))) return null;
  return { value: word, start: m.index + m[1].length };
}

// Whole-title importance from natural language — the save-flush backstop (catches prefix "focus on X",
// which can't pill trailing). Returns { importance, content } or null; caller only applies it when no
// importance was set explicitly (pill/picker), so it never overrides a deliberate choice.
export function parseImportanceWords(text) {
  const t = (text || '').trim();
  let m;
  if ((m = t.match(/^must\s+(\S.*)$/i))) return { importance: 'must', content: m[1].trim() };
  if ((m = t.match(/^focus\s+on\s+(\S.*)$/i))) return { importance: 'focus', content: m[1].trim() };
  if ((m = t.match(/^someday\s+(\S.*)$/i))) return { importance: 'someday', content: m[1].trim() };
  const m2 = matchTrailingImportanceWord(t);
  if (m2 && m2.start > 0) return { importance: m2.value, content: t.slice(0, m2.start).trimEnd() };
  return null;
}

// longest token at trailing end — "every" waits, "every 2 weeks" pills. A qualifying trailing
// importance WORD wins first (focus/someday/must aren't otherwise tokens, so no conflict).
export function matchTrailingToken(pending, now = new Date(), locations = []) {
  const text = pending || '';
  const imp = matchTrailingImportanceWord(text);
  if (imp) return { kind: 'imp', value: imp.value, start: imp.start };
  const offsets = []; const re = /\S+/g; let m;
  while ((m = re.exec(text))) offsets.push(m.index);
  for (const start of offsets.slice(-6)) {
    const tok = classifyToken(text.slice(start), now, locations);
    if (tok) return { ...tok, start };
  }
  return null;
}

export const WEEKDAYS = V.weekdayLabels;
export function recurrenceLabel(rec) {
  if (!rec) return '';
  const n = rec.interval || 1;
  const ord = d => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
  if (rec.freq === 'week' && rec.weekdays?.length) {
    const wd = [...rec.weekdays].sort((a, b) => a - b);
    if (wd.join() === '1,2,3,4,5') return 'Weekdays';
    return 'Every ' + wd.map(d => WEEKDAYS[d]).join(', ');
  }
  if (rec.freq === 'month' && rec.month_day) return 'Every ' + ord(rec.month_day);
  const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[rec.freq] || rec.freq;
  return n > 1 ? `Every ${n} ${unit}s` : 'Every ' + unit;
}
