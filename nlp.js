// Pure date + quick-add-tokenizer helpers. No DOM — shared by index.html and unit-tested in tests/.
// `now` is injectable so all relative-date logic is deterministic under test.
import DESIGN from './design.json' with { type: 'json' };
const L = DESIGN.lang.labels;
const V = DESIGN.lang.nlp;

export const localStamp = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);   // floating local 'YYYY-MM-DDTHH:MM'
export const isoDate = d => localStamp(d).slice(0, 10);
// "HH:MM" → its next local occurrence, "YYYY-MM-DDTHH:MM": today while still ahead, else tomorrow.
export function nextTimeAt(hm, now = new Date()) {
  const d = new Date(now); d.setHours(+hm.slice(0, 2), +hm.slice(3, 5), 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return isoDate(d) + 'T' + hm;
}
// n months on, clamped to the month's end: Jan 31 + 1 is Feb 28, never Mar 3 (setMonth rolls over). Mutates d.
export const addMonths = (d, n) => { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d; };

// Importance ordering (must > focus > none > someday). impRank: 0 = most important; unset → 'none'.
export const IMPORTANCE = ['must', 'focus', 'none', 'someday'];
export const impRank = v => { const i = IMPORTANCE.indexOf(v); return i < 0 ? 2 : i; };


const midnight = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };
const shortDate = (d, now) => d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + (now && d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
const dayDiff = (iso, now) => {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00' : iso); d.setHours(0, 0, 0, 0);
  return { d, diff: Math.round((d - midnight(now)) / 86400000) };
};

// Short relative label for a due date: weekdays within a week either side ("Last Mon", "Fri", "Next Mon"), then
// weeks and months; both fall back to an absolute date beyond ~6 weeks. Never "missed" (user: tweak-7).
const relDue = (d, diff, now) => {
  const ago = diff < 0, n = Math.abs(diff), day = () => d.toLocaleDateString([], { weekday: 'short' });
  if (n === 1)  return ago ? L.yest : L.tmr;
  if (n <= 6)   return ago ? `Last ${day()}` : day();
  if (n <= 13)  return ago ? 'Last week' : `Next ${day()}`;
  if (n <= 27)  return `${Math.round(n / 7)}w${ago ? ' ago' : ''}`;
  if (n <= 45)  return ago ? 'Last month' : 'Next month';
  return shortDate(d, now);
};

export function dueBadge(due, now = new Date(), done = false) {
  if (!due) return null;
  const { d, diff } = dayDiff(due, now);
  if (diff === 0) return { label: L.today, kind: 'today' };
  const kind = diff < 0 ? 'overdue' : diff <= 6 ? 'soon' : 'later';   // color band; labels themselves are relative
  return { label: done && diff < 0 ? shortDate(d, now) : relDue(d, diff, now), kind };   // a done task's passed date reads as the date (user 10-05)
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
  if (!from || !to || from === to) return dueBadge(to || from, now, !!task.completed_at);
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
  else if (key === 'weekend') { from.setDate(from.getDate() + (g ? 6 - g : 0)); to.setDate(to.getDate() + (7 - g) % 7); }   // on a Sunday, what's left of it
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

const MONTHS = V.months, DAYS = V.weekdays;
// weekday alternation for the quick-add matchers (long form first so "sunday" doesn't stop at "sun")
const WD_ALT = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat';
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIdx = w => MONTHS.indexOf(w.slice(0, 3).toLowerCase());
// A weekday WORD ("month" isn't "mon"; "mons" isn't plural). The field reads "monday at 5" as monday; a title
// span must be only the date, or "by monday finish report" would pill whole and lose the words.
const WD_LEAD = '^(next\\s+week\\s+|next\\s+)?(tues|weds|thurs?|sun|mon|tue|wed|thu|fri|sat)(?:(?:day|sday|nesday|rsday|urday)s?)?(\\s+next\\s+week)?';
const WD_WORD = new RegExp(WD_LEAD + '\\b'), WD_WHOLE = new RegExp(WD_LEAD + '[.,]?$');
// a weekday beside an explicit date ("sat oct 3", "oct 3 sat") is absorbed; the date wins
const WD_PRE = '(?:(?:' + WD_ALT + ')\\.?,?\\s+)', WD_SUF = '(?:,?\\s+(?:' + WD_ALT + ')\\b)?', ORD = '(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)';
const MON_DAY = WD_PRE + '?' + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?' + WD_SUF, DAY_MON = WD_PRE + '?(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_RE + '(?:,?\\s+(\\d{4}))?' + WD_SUF;
// Every regex is built once: V8 drops a per-call RegExp's compiled code at each major GC, so the next typed space recompiled them all (~29ms at 6x CPU).
const MON_DAY_ALL = new RegExp('^' + MON_DAY + '$'), DAY_MON_ALL = new RegExp('^' + DAY_MON + '$'), ORD_ALL = new RegExp('^' + WD_PRE + '?' + ORD + '$');
// no year: rolls to next year if already past. A day the month lacks ("feb 30") rolls over in Date → null.
function monthDayIso(mi, day, year, now) {
  if (mi < 0) return null;
  let d = new Date(year || now.getFullYear(), mi, day);
  if (!year && d < midnight(now)) d = new Date(now.getFullYear() + 1, mi, day);
  return d.getDate() === day ? isoDate(d) : null;
}
// "the 12th": the next 12th from today; a month without it ("the 31st" in Nov) skips to one that has it
function nextDayIso(day, now) {
  for (let i = 0; i < 3; i++) {
    const iso = monthDayIso(now.getMonth() + i, day, now.getFullYear(), now);
    if (iso && iso >= isoDate(now)) return iso;
  }
  return null;
}

export function parseDate(s, now = new Date(), whole = false) {
  s = (s || '').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (V.dueToday.includes(low)) return isoDate(now);
  if (V.dueTomorrow.includes(low)) return quickDate('tomorrow', now);
  if (V.dueYesterday.includes(low)) return quickDate('yesterday', now);
  if (V.weekend.includes(low)) return quickDate('weekend', now);
  if (V.nextWeek.includes(low)) return quickDate('nextweek', now);
  if (/^next\s+weekend$/.test(low)) return isoDate(nextWeekDate(6, now));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const rel = low.match(/^(?:in\s+)?(\d+)\s*d(?:ays?)?$/);
  if (rel) { const d = midnight(now); d.setDate(d.getDate() + +rel[1]); return isoDate(d); }
  let mn = low.match(MON_DAY_ALL);
  if (mn) return monthDayIso(monthIdx(mn[1]), +mn[2], mn[3] && +mn[3], now);
  mn = low.match(DAY_MON_ALL);
  if (mn) return monthDayIso(monthIdx(mn[2]), +mn[1], mn[3] && +mn[3], now);
  mn = low.match(ORD_ALL);
  if (mn) return nextDayIso(+mn[1], now);
  // weekday name: bare = nearest upcoming; "next <wd>" / "next week <wd>" / "<wd> next week" = that day NEXT week
  const wd = low.match(whole ? WD_WHOLE : WD_WORD);
  if (wd) {
    const t = DAYS.indexOf(wd[2].slice(0, 3));
    if (wd[1] || wd[3]) return isoDate(nextWeekDate(t, now));
    const d = midnight(now); d.setDate(d.getDate() + ((t - d.getDay() + 7) % 7));
    return isoDate(d);
  }
  const md = s.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
  if (md) {
    let yr = md[3] ? +md[3] : now.getFullYear(); if (yr < 100) yr += 2000;
    const d = new Date(yr, +md[1] - 1, +md[2]);
    return d.getDate() === +md[2] && d.getMonth() === +md[1] - 1 ? isoDate(d) : null;   // M/D: "31/12" and "2/30" didn't happen
  }
  // native Date only for strings with an explicit 4-digit year (too lenient otherwise, e.g. "10" → Oct 1), and
  // never an ISO date-only prefix: "2026-10" reads as UTC midnight, the day before west of UTC.
  if (!/(19|20|21)\d{2}/.test(s) || /^\d{4}(-\d{2})?$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(+d) ? null : isoDate(d);
}

const MERIDIEM = '([ap])(?:m\\b|\\.m\\b\\.?)';   // am · pm · a.m. · p.m. — captures a|p; no trailing \b, so "p.m." keeps its dot
// sat/sun/wed are English words too ("I sat down", "the sun"): without on/this/next they pill only beside a time (#92)
const WD_PROSE = /^(?:sat|sun|wed)$/i, TIME_RE = '(?:\\d{1,2}(?::\\d{2})?\\s*' + MERIDIEM + '|(?:[01]?\\d|2[0-3]):[0-5]\\d\\b)';
// a bare "at 5" is the next 5 o'clock between 7am and 10pm (#103)
const AT_HOUR = 'at\\s+(1[0-2]|[1-9])\\b(?![:.]\\d)';
const TIME_AFTER = new RegExp('^\\.?\\s+(?:(?:at\\s+)?' + TIME_RE + '|' + AT_HOUR + ')', 'i'), TIME_BEFORE = new RegExp(TIME_RE + '\\s*$', 'i');
const AT_HOUR_END = new RegExp('\\s' + AT_HOUR + '$', 'i'), AT_HOUR_ANY = new RegExp('\\s' + AT_HOUR, 'i');
const MERIDIEM_TIME = new RegExp('\\b(\\d{1,2})(?::(\\d{2}))?\\s*' + MERIDIEM), MERIDIEM_AT = new RegExp('(?:\\bat\\s+)?\\b\\d{1,2}(?::\\d{2})?\\s*' + MERIDIEM, 'i');
function atHour(h, laterDay, now) {
  const hours = [+h % 12, +h % 12 + 12].filter(x => x >= 7 && x <= 22).map(x => String(x).padStart(2, '0') + ':00');
  return laterDay ? hours[0] : hours.reduce((a, b) => nextTimeAt(b, now) < nextTimeAt(a, now) ? b : a);   // a later day: its first
}
function parseTime(s) {
  const low = (s || '').toLowerCase();
  let m = low.match(MERIDIEM_TIME);
  if (m) { let h = +m[1] % 12; if (m[3] === 'p') h += 12; return String(h).padStart(2, '0') + ':' + (m[2] || '00'); }
  m = low.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return m ? String(+m[1]).padStart(2, '0') + ':' + m[2] : '';
}

// bare time defaults date to today (`bare` says so); `whole`: see WD_WHOLE
export function parseDateText(s, now = new Date(), whole = false) {
  s = (s || '').trim();
  const time = parseTime(s);
  const dateStr = time
    ? s.replace(MERIDIEM_AT, '').replace(/(?:\bat\s+)?\b(?:[01]?\d|2[0-3]):[0-5]\d\b/i, '').trim()   // "fri at 5pm" → date "fri"
    : s;
  let iso = dateStr ? parseDate(dateStr, now, whole) : null;
  const bare = !iso && !!time;
  if (bare) iso = nextTimeAt(time, now).slice(0, 10);   // a passed time is tomorrow's
  return { iso, time, bare };
}

// Recurrence grammar ("every[!] <rule>") — shared by parseQuick (strips) and parseRecurrence (date field).
// It mirrors the When popover's sentence — "every N unit [on <days>] at <time>, <n> times, ending <date>" —
// so every word that surface RENDERS is typeable, including its empty-value glyphs (`–`, `∞`, `never`).
const REC_DAY_RE = '(?:sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\\b';
const REC_DAYS = '(?:(?:' + REC_DAY_RE + ')(?:\\s*,\\s*|\\s+)?)+';
// An nth weekday ("first sunday", store `nth`) and the month's last day (month_day 31, clamped to month-end) name a monthly day.
const REC_NTH = '(?:first|second|third|fourth|fifth|last|[1-5](?:st|nd|rd|th))', REC_NTH_N = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };
const REC_NTH_DAY = REC_NTH + '\\s+' + REC_DAY_RE, REC_OF_MONTH = '(?:\\s+of\\s+(?:the|every)\\s+month)?';
const REC_RULE = '(?:' + REC_NTH_DAY + '|last\\s+day)' + REC_OF_MONTH + '|other\\s+(?:' + REC_DAYS + '|days?|weeks?|months?|years?)|' + REC_DAYS + '|weekday|\\d+\\s*(?:days?|weeks?|months?|years?)|days?|weeks?|months?|years?|\\d{1,2}(?:st|nd|rd|th)';
const REC_ON = '\\s+on\\s+(' + REC_DAYS + '|(?:the\\s+)?(?:' + REC_NTH_DAY + '|last\\s+day)|the\\s+\\d{1,2}(?:st|nd|rd|th))';   // must hug the rule, so "work on the deck" is prose
const REC_AT = '\\s+at\\s+(–|\\d{1,2}(?::\\d{2})?\\s*[ap]m|(?:[01]?\\d|2[0-3]):[0-5]\\d)';   // a TIME only — never "at <place>"
// The count needs `for` or the popover's own comma (", 3 times"): a bare "<n> times" is ordinary English
// ("every day 2 times daily" is a frequency, not an end) and eating it silently loses title text. The
// until-tail is bounded (≤3 comma-free words + an optional ", <year>") so a following clause still binds.
const REC_END = '(?:\\s*,\\s*|\\s+for\\s+)(\\d+|∞)\\s+times?|\\s+x(\\d+)|(?:\\s*,\\s*|\\s+)(?:until|ending)\\s+(never|[^\\s,]+(?:\\s+[^\\s,]+){0,2}(?:,\\s*\\d{4})?)';
const REC_FULL = '\\severy(!?)(?:\\s+(' + REC_RULE + '))?(?:' + REC_ON + ')?(?:' + REC_AT + ')?((?:' + REC_END + ')*)(?=\\s|$)';
const REC_END_ALL = new RegExp(REC_END, 'gi'), REC_DAYS_ALL = new RegExp(REC_DAY_RE, 'g'), REC_DAY_LEAD = new RegExp('^' + REC_DAY_RE);
const REC_ONE = new RegExp(REC_FULL, 'i'), REC_EACH = new RegExp(REC_FULL, 'gi');
// The day named BEFORE the rule: "the 1st and 15th of every month", "first and third sunday of every 2 months".
const REC_ITEM = '(?:first|second|third|fourth|fifth|last|\\d{1,2}(?:st|nd|rd|th))';
const REC_OF = '\\s(?:on\\s+)?(?:the\\s+)?(' + REC_ITEM + '(?:(?:\\s*,\\s*|\\s+)(?:and\\s+)?' + REC_ITEM + ')*)(?:\\s+(' + REC_DAY_RE + '|day))?\\s+of\\s+every(!?)\\s+((?:\\d+\\s*|other\\s+)?months?)(?:' + REC_AT + ')?((?:' + REC_END + ')*)(?=\\s|$)';
const REC_OF_ONE = new RegExp(REC_OF, 'i'), REC_OF_EACH = new RegExp(REC_OF, 'gi'), REC_ITEM_ALL = new RegExp(REC_ITEM, 'gi');
const REC_MONTH_DAY = new RegExp('^(?:the\\s+)?(?:(' + REC_NTH + ')\\s+(' + REC_DAY_RE + ')|last\\s+day)', 'i');
const nthOf = w => REC_NTH_N[w.toLowerCase()] ?? parseInt(w);
// End clauses may co-occur and repeat; `ends` is single-valued, so the LAST clause with a real value wins
// (reading order) — "∞ times"/"ending never" are placeholders, so a printed "3 times, ending never" survives.
// Returns the prose it could NOT resolve, to hand back to the title as the sibling `only`/`by` matchers do.
function applyEnds(rec, tail, now) {
  let rest = '';
  for (const [raw, count, xCount, until] of (tail || '').matchAll(REC_END_ALL)) {
    if (count === '∞' || /^never$/i.test(until || '')) continue;
    if (count || xCount) rec.ends = { count: +(count || xCount) };
    else { const d = parseDate(until.trim(), now, true); if (d) rec.ends = { date: d }; else rest += raw; }
  }
  return rest;
}
function buildRecurrence(bang, rule, on, at, tail, now) {
  if (!rule && !bang) return {};   // bare "every" with no rule/bang is not a recurrence
  const rec = { freq: 'day', interval: 1, from_completion: !!bang, ends: null, done_count: 0 };
  const body = (rule || '').toLowerCase().replace(/^other\s+/, ''), other = body.length < (rule || '').length;   // "every other" = every 2
  const n = body.match(/^(\d+)/), interval = n ? +n[1] : other ? 2 : 1;
  const wdays = t => (t.match(REC_DAYS_ALL) || []).map(d => DAYS.indexOf(d.slice(0, 3)));
  const monthOf = m => Object.assign(rec, { freq: 'month' }, m[1] ? { nth: nthOf(m[1]), weekdays: wdays(m[2]) } : { month_day: 31 });   // a REC_MONTH_DAY match
  const bodyDay = body.match(REC_MONTH_DAY);
  if (bodyDay) monthOf(bodyDay);
  else if (/weekday/.test(body)) Object.assign(rec, { freq: 'week', weekdays: [1, 2, 3, 4, 5] });
  else if (REC_DAY_LEAD.test(body)) Object.assign(rec, { freq: 'week', weekdays: wdays(body), interval });
  else if (/days?$/.test(body)) Object.assign(rec, { freq: 'day', interval });
  else if (/weeks?$/.test(body)) Object.assign(rec, { freq: 'week', interval });
  else if (/months?$/.test(body)) Object.assign(rec, { freq: 'month', interval });
  else if (/years?$/.test(body)) Object.assign(rec, { freq: 'year', interval });
  else if (/^\d/.test(body)) Object.assign(rec, { freq: 'month', month_day: interval });   // "15th"
  const onLow = (on || '').toLowerCase(), onDay = onLow.match(REC_MONTH_DAY);   // the "on …" chip OWNS the freq it implies (weekly set / monthly day)
  if (onDay) monthOf(onDay);
  else if (/^the\b/.test(onLow)) Object.assign(rec, { freq: 'month', month_day: +onLow.match(/\d+/)[0] });
  else if (onLow) Object.assign(rec, { freq: 'week', weekdays: wdays(onLow) });
  if (at && at !== '–') rec.at = parseTime(at);
  return { rec, rest: applyEnds(rec, tail, now) };
}
// REC_OF's match → { rec, rest }: one rule, or one per nth for "first and third sunday" (`nth` holds one weekday).
function buildOf(items, unit, bang, rule, at, tail, now) {
  const { rec, rest } = buildRecurrence(bang, rule, '', at, tail, now), ns = items.match(REC_ITEM_ALL).map(nthOf);
  if (unit && !/^day$/i.test(unit)) {
    if (ns.some(n => n > 5)) return {};
    const rules = ns.map(nth => ({ ...rec, ends: rec.ends && { ...rec.ends }, nth, weekdays: [DAYS.indexOf(unit.slice(0, 3).toLowerCase())] }));
    return { rec: rules.length > 1 ? rules : rules[0], rest };
  }
  const md = [...new Set(ns.map(n => n < 0 ? 31 : n))].sort((a, b) => a - b);
  if (md.some(n => n < 1 || n > 31)) return {};
  return { rec: Object.assign(rec, { month_day: md.length > 1 ? md : md[0] }), rest };
}
export function parseRecurrence(s, now = new Date()) {
  const t = ' ' + (s || '').replace(/^\s*(dai|week|month|year)ly\b/i, (_, u) => 'every ' + (/^dai/i.test(u) ? 'day' : u)) + ' ';   // the field's "daily": a title keeps its -ly words
  const of = t.match(REC_OF_ONE), m = !of && t.match(REC_ONE);
  return (of ? buildOf(...of.slice(1, 7), now) : m ? buildRecurrence(m[1], m[2], m[3], m[4], m[5], now) : {}).rec ?? null;
}

const DPRE = '(?:on\\s+)?';   // "on" is filler before a date; by/due are the DEADLINE register (§11), matched earlier
const TPRE = '(?:at\\s+)?';   // ... and "at" before a time
const re = (body, flags = 'gi') => new RegExp('\\s' + body + '\\b', flags);
const Q_ISO = re(DPRE + '(\\d{4}-\\d{2}-\\d{2})'), Q_MON_DAY = re(DPRE + MON_DAY), Q_DAY_MON = re(DPRE + DAY_MON);
const Q_ORD = re('(?:on\\s+' + WD_PRE + '?|' + WD_PRE + ')' + ORD), Q_SLASH = re(DPRE + '(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?');
const Q_DUE = re(DPRE + '(' + [...V.dueToday, ...V.dueTomorrow, ...V.dueYesterday].sort((a, b) => b.length - a.length).join('|') + ')');
const Q_WKND = re(DPRE + '(next\\s+)?(?:' + V.weekend.map(w => w.replace(' ', '\\s+')).sort((a, b) => b.length - a.length).join('|') + ')');
const Q_NEXT_WEEK_WD = re(DPRE + '(?:next\\s+week\\s+(' + WD_ALT + ')|(' + WD_ALT + ')\\s+next\\s+week)');
const Q_THIS_WEEK = new RegExp('\\s(?:' + V.thisWeek.map(w => w.replace(' ', '\\s+')).join('|') + ')\\b', 'gi');
const Q_NEXT_WEEK = new RegExp('\\s(?:' + V.nextWeek.map(w => w.replace(' ', '\\s+')).join('|') + ')\\b', 'gi');
const Q_WD = new RegExp('\\s((?:on|this)\\s+(?:coming\\s+)?|coming\\s+)?(next\\s+)?(' + WD_ALT + ')(?:,(?=\\s)|\\b)', 'gi');
const Q_NOON = re(TPRE + '(noon|midnight)'), Q_MERIDIEM = new RegExp('\\s' + TPRE + '(\\d{1,2})(?::(\\d{2}))?\\s*' + MERIDIEM, 'gi'), Q_CLOCK = re(TPRE + '([01]?\\d|2[0-3]):([0-5]\\d)');
// A day-part right after a date ("nov 5 afternoon", "fri night") or on its own as "this morning" / "tonight": a rough window, never a clock time.
export const DAY_PARTS = V.dayParts;
const Q_PART = /\s(?:(this)\s+|in\s+the\s+)?(morning|afternoon|evening|night|tonight)\b/i;
const DATE_END = new RegExp('(?:^|\\s)(?:\\d{4}-\\d{2}-\\d{2}|' + MON_DAY + '|' + DAY_MON + '|' + ORD + '|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|'
  + [...V.dueToday, ...V.dueTomorrow, ...V.dueYesterday].join('|') + '|' + WD_ALT + ')[.,]?$', 'i');
export const partOf = bands => Object.keys(DAY_PARTS).find(k => bands?.length === 1 && DAY_PARTS[k].join() === bands[0].join()) ?? '';
let locKey, locNot, locAt;   // the places' regexes, rebuilt only when the list changes

// hybrid tokenizer: classifyToken asks it whether a span is exactly one token. `locations` (the places already in use) guards
// "at <name>" — only a known place pills, so "Meet Sam at 5pm" never invents one.
export function parseQuick(raw, now = new Date(), locations = []) {
  let s = ' ' + (raw || '') + ' ';
  const o = { importance: null, dueIso: null, dueFromIso: null, deadlineIso: null, dueTime: '', part: null, durMin: null, project: null, areas: [], recurrence: null, location: null, locationExcept: false };
  const setTime = (h, m) => o.dueTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

  // importance flag (app-behavior, not a rank): ! = focus, !! = must, ~ = someday
  s = s.replace(/\s(!{1,2}|~)(?=\s|$)/g, (_, t) => (o.importance = t === '~' ? 'someday' : t === '!!' ? 'must' : 'focus', ' '));
  s = s.replace(/\s@([\w-]+)/g, (_, l) => (o.areas.push(l), ' '));
  s = s.replace(/\s#([\w-]+)/g, (_, p) => (o.project = p, ' '));

  // "in N <unit>" before bare durations so "in 3hr" doesn't become an estimate
  s = s.replace(/\sin\s+(\d+|an?(?=\s+(?:day|week|wk|month|hour)\b))\s*(months?|mos?|weeks?|wks?|days?|hours?|hrs?|h|minutes?|mins?|m)\b/gi, (_, n, unit) => {   // "in a week"; "in a minute"/"in a mo" mean soon, so stay prose
    n = +n || 1; const u = unit.toLowerCase(), d = new Date(now);
    if (/^mo/.test(u)) o.dueIso = isoDate(midnight(addMonths(d, n)));
    else if (/^w/.test(u)) { d.setDate(d.getDate() + n * 7); o.dueIso = isoDate(midnight(d)); }
    else if (/^d/.test(u)) { d.setDate(d.getDate() + n); o.dueIso = isoDate(midnight(d)); }
    else if (/^h/.test(u)) { d.setHours(d.getHours() + n); o.dueIso = isoDate(d); setTime(d.getHours(), d.getMinutes()); }
    else { d.setMinutes(d.getMinutes() + n); o.dueIso = isoDate(d); setTime(d.getHours(), d.getMinutes()); }
    return ' ';
  });

  // consumed before dates so "every monday" is a rule, not a dueIso
  s = s.replace(REC_OF_EACH, (_m, items, unit, bang, rule, at, tail) => {
    const { rec, rest } = buildOf(items, unit, bang, rule, at, tail, now);
    if (!rec) return _m;
    o.recurrence = rec;
    return rest ? rest + ' ' : ' ';
  });
  s = s.replace(REC_EACH, (_m, bang, rule, on, at, tail) => {
    const { rec, rest } = buildRecurrence(bang, rule, on, at, tail, now);
    if (!rec) return _m;
    o.recurrence = rec;
    return rest ? rest + ' ' : ' ';   // `rest` keeps its own leading separator, so the prose reads back verbatim
  });

  // \u0001 holds the day-part's place: it reads as a time beside sat/sun/wed and goes back to prose if no date takes it
  let today = false, partText = '';   // "this afternoon" / "tonight" with no date of their own are today's
  s = s.replace(Q_PART, (m, self, w, at, str) => {
    const dated = DATE_END.test(str.slice(0, at));
    if (!dated && !self && w.toLowerCase() !== 'tonight') return m;
    today = !dated; partText = m; o.part = /night/i.test(w) ? 'evening' : w.toLowerCase(); return ' \u0001 ';
  });

  // 'only <date>' walls BOTH sides — a one-day world-window ("vote only tue"). Leading form only:
  // a trailing "<date> only" stays literal ("aug 10 only tue" ambiguity). Consumed before by/due below.
  s = s.replace(/\sonly\s+(.+?)(?=\s+(?:!{1,2}|~)(?=\s|$)|\s+[#@]|\s+every\b|\s*$)/i, (m, dateStr) => {
    const { iso, time } = parseDateText(dateStr.replace('\u0001', '').trim(), now, true);
    if (!iso) return m;
    o.onlyIso = iso; o.deadlineIso = iso + (time ? 'T' + time : '');
    return ' ';
  });

  // By the end of that day / week (Sunday, as quickRange 'thisweek') / month
  s = s.replace(/\s(?:(?:by|until|till|before)\s+)?(?:eo([dwm])|end\s+of\s+(?:the\s+)?(day|week|month))\b/i, (_, eo, unit) => {
    const u = (eo || unit[0]).toLowerCase(), d = midnight(now);
    if (u === 'm') d.setMonth(d.getMonth() + 1, 0);
    o.deadlineIso = u === 'w' ? quickRange('thisweek', now).to : isoDate(d); return ' ';
  });
  // "next month" is a range: possible from its 1st, By its last day
  s = s.replace(/\snext\s+month\b/i, () => {
    const d = midnight(now); d.setDate(1); d.setMonth(d.getMonth() + 1);
    o.deadlineFromIso = isoDate(d); d.setMonth(d.getMonth() + 1, 0); o.deadlineIso = isoDate(d); return ' ';
  });
  // Marked dates wall (§11): by/due/^ join the deadline keyword; until/till/before read as by. Consumed before due-date matchers so
  // the keyword's date isn't also taken as a due date; a non-date tail leaves the text untouched.
  s = s.replace(/\s(?:(?:deadline|ddl|dl|by|due|until|till|before)\s+|\^\s*)(.+?)(?=\s+(?:!{1,2}|~)(?=\s|$)|\s+[#@]|\s+every\b|\s*$)/i, (m, dateStr) => {
    dateStr = dateStr.replace(/\s*\u0001/, '');
    const at = dateStr.match(AT_HOUR_END);   // "by fri at 5"
    const parsed = parseDateText(at ? dateStr.slice(0, at.index) : dateStr.trim(), now, true);   // "deadline fri 5pm" keeps the hour (F16)
    const iso = parsed.iso, time = at ? atHour(at[1], iso > isoDate(now), now) : parsed.time;
    if (!iso) return m;                 // not a date → leave the text untouched
    o.deadlineIso = iso + (time ? 'T' + time : ''); return ' ';
  });

  s = s.replace(Q_ISO, (_, iso) => (o.dueIso = iso, ' '));
  s = s.replace(Q_MON_DAY, (m, mon, day, yr) => { const iso = monthDayIso(monthIdx(mon), +day, yr && +yr, now); return iso ? (o.dueIso = iso, ' ') : m; });
  s = s.replace(Q_DAY_MON, (m, day, mon, yr) => { const iso = monthDayIso(monthIdx(mon), +day, yr && +yr, now); return iso ? (o.dueIso = iso, ' ') : m; });
  // a bare ordinal is prose ("my 12th birthday"): it needs "on" or a weekday
  s = s.replace(Q_ORD, (m, day) => { const iso = nextDayIso(+day, now); return iso ? (o.dueIso = iso, ' ') : m; });
  s = s.replace(Q_SLASH, (m, a, b, y) => {
    let yr = y ? +y : now.getFullYear(); if (yr < 100) yr += 2000;
    const d = new Date(yr, +a - 1, +b);
    if (d.getDate() !== +b || d.getMonth() !== +a - 1) return m;   // "2/30", "31/12" stay title
    o.dueIso = isoDate(d); return ' ';
  });

  s = s.replace(Q_DUE, (_, w) => {
    const lw = w.toLowerCase();
    const key = V.dueYesterday.includes(lw) ? 'yesterday' : V.dueTomorrow.includes(lw) ? 'tomorrow' : 'today';
    if (key === 'yesterday') return (o.dueIso = quickDate('yesterday', now), ' ');   // past point — open-start
    const r = quickRange(key, now);
    return (o.dueFromIso = r.from, o.dueIso = r.to, ' ');
  });
  s = s.replace(Q_WKND, (_, nx) => {
    if (nx) return (o.dueFromIso = isoDate(nextWeekDate(6, now)), o.dueIso = isoDate(nextWeekDate(0, now)), ' ');   // next week's Sat–Sun, as "next sat"
    const r = quickRange('weekend', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' ');
  });
  // parsed as ONE unit (before bare "next week" / bare weekday)
  s = s.replace(Q_NEXT_WEEK_WD, (_, w, w2) =>
    (o.dueIso = o.dueFromIso = isoDate(nextWeekDate(DAYS.indexOf((w || w2).slice(0, 3).toLowerCase()), now)), ' '));
  s = s.replace(Q_THIS_WEEK, () => { const r = quickRange('thisweek', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  s = s.replace(Q_NEXT_WEEK, () => { const r = quickRange('nextweek', now); return (o.dueFromIso = r.from, o.dueIso = r.to, ' '); });
  const dated = !!o.dueIso;
  s = s.replace(Q_WD, (m, pre, nx, w, at, str) => {
    if (dated) return !pre && !nx && WD_PROSE.test(w) ? m : ' ';   // an explicit date already won: the weekday word is absorbed, never overwrites it
    if (!pre && !nx && WD_PROSE.test(w) && !/^\s*\u0001/.test(str.slice(at + m.length)) && !TIME_AFTER.test(str.slice(at + m.length)) && !TIME_BEFORE.test(str.slice(0, at))) return m;
    const t = DAYS.indexOf(w.slice(0, 3).toLowerCase());
    if (nx) { o.dueIso = o.dueFromIso = isoDate(nextWeekDate(t, now)); return ' '; }   // "next <wd>" → that day next week
    const d = midnight(now); d.setDate(d.getDate() + ((t - d.getDay() + 7) % 7 || 7));
    o.dueIso = o.dueFromIso = isoDate(d); return ' ';
  });

  s = s.replace(/\s(\d+)\s*(?:h|hr|hrs|hours?)(?:\s*(\d+)\s*(?:m|min|mins|minutes?))?\b/gi, (_, h, m) => (o.durMin = +h * 60 + (m ? +m : 0), ' '));
  s = s.replace(/\s(\d+)\s*(?:m|min|mins|minutes?)\b/gi, (_, m) => (o.durMin == null && (o.durMin = +m), ' '));

  s = s.replace(Q_NOON, (_, w) => (setTime(/mid/i.test(w) ? 0 : 12, 0), ' '));
  s = s.replace(Q_MERIDIEM, (_, h, m, ap) => {
    h = +h % 12; if (/p/i.test(ap)) h += 12; setTime(h, m ? +m : 0); return ' ';
  });
  s = s.replace(Q_CLOCK, (_, h, m) => (setTime(+h, +m), ' '));
  s = s.replace(AT_HOUR_ANY, (_, h) => (o.dueTime = atHour(h, o.dueIso > isoDate(now), now), ' '));
  // the popover shows `at <time>` INSIDE the repeat sentence — so a time with a rule and no one-off date
  // rides the RULE (matches applyDateText). A one-off date present ("friday at 5pm every week") keeps its time.
  if (o.part) {
    if (today && !o.dueIso) { const r = quickRange('today', now); o.dueFromIso = r.from; o.dueIso = r.to; }
    if (!o.dueIso && /^.{10}$/.test(o.deadlineIso ?? '')) o.deadlineIso += 'T' + DAY_PARTS[o.part][1];   // "by fri afternoon": by its end
    s = s.replace('\u0001', o.dueIso || o.deadlineIso ? ' ' : partText);
    if (o.dueTime || !o.dueIso) o.part = null;   // a clock time is the firmer word
  }
  if (o.recurrence && o.dueTime && !o.dueIso) { [].concat(o.recurrence).forEach(r => { r.at = o.dueTime; }); o.dueTime = ''; }

  if (locations && locations.length) {
    const byLen = [...locations].sort((a, b) => b.length - a.length);
    const alt = byLen.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const found = name => byLen.find(n => n.toLowerCase() === name.toLowerCase()) || name;
    if (alt !== locKey) { locKey = alt; locNot = new RegExp('\\s(?:not\\s+at|away\\s+from)\\s+(' + alt + ')(?=\\s|$)', 'i'); locAt = new RegExp('\\sat\\s+(' + alt + ')(?=\\s|$)', 'i'); }
    // negation first ("not at X" / "away from X" are synonyms), then plain "at X"
    s = s.replace(locNot, (_m, name) =>
      (o.location = found(name), o.locationExcept = true, ' '));
    if (!o.location) s = s.replace(locAt, (_m, name) =>
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
  if (p.dueIso || p.dueTime) hits.push({ kind: 'date', value: { iso: p.dueIso, from: p.dueFromIso, time: p.dueTime, ...p.part && { part: p.part } } });
  if (p.deadlineIso) hits.push({ kind: 'deadline', value: p.onlyIso ? { iso: p.onlyIso, only: true } : p.deadlineFromIso ? { iso: p.deadlineIso, from: p.deadlineFromIso } : { iso: p.deadlineIso } });
  if (p.durMin != null) hits.push({ kind: 'dur', value: p.durMin });
  if (p.project) hits.push({ kind: 'proj', value: p.project });
  if (p.areas.length === 1) hits.push({ kind: 'area', value: p.areas[0] });
  if (p.recurrence) hits.push({ kind: 'rec', value: p.recurrence });
  if (p.location) hits.push({ kind: 'loc', value: (p.locationExcept ? 'away from ' : '') + p.location });   // pill label carries the polarity
  return hits.length === 1 ? hits[0] : null;                          // none or ambiguous → null
}

// Longest recognisable token, in words: the When popover's full repeat sentence
// ("every 2 weeks on Mon Wed at 9am, 3 times, ending Sep 1"). Bounds both token scans.
const TOK_MAX_WORDS = 13;

const AFTER = /(^|\s)after\s+$/i;   // "after fri" stays prose (#103)
export function tokenizeAll(text, now = new Date(), locations = []) {
  const parts = (text || '').match(/\s+|\S+/g) || [];      // alternating whitespace / word runs
  const isWord = p => /\S/.test(p);
  const segs = [];
  const addText = t => { const l = segs[segs.length - 1]; if (l && l.text !== undefined) l.text += t; else segs.push({ text: t }); };
  let i = 0;
  while (i < parts.length) {
    if (!isWord(parts[i])) { addText(parts[i]); i++; continue; }
    let best = null, bestJ = i, bestSpan = '', span = '';
    for (let j = i; j < parts.length && j - i <= TOK_MAX_WORDS * 2; j++) {   // parts alternate word/gap
      span += parts[j];
      if (!isWord(parts[j])) continue;                     // only test at word ends
      const cls = classifyToken(span.trim(), now, locations);
      if (cls && !(cls.kind === 'date' && AFTER.test(segs[segs.length - 1]?.text || ''))) { best = cls; bestJ = j; bestSpan = span; }
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
  for (const start of offsets.slice(-TOK_MAX_WORDS)) {
    const tok = classifyToken(text.slice(start), now, locations);
    if (tok && !(tok.kind === 'date' && AFTER.test(text.slice(0, start)))) return { ...tok, start };
  }
  return null;
}

export const WEEKDAYS = V.weekdayLabels;
// A word typed after a date pill folds into it when "<pill> <word>" reads as ONE date: [next week] + "sun",
// [Fri 4:00] + "PM" (space mints the time before its meridiem exists). A word that alone is that same date
// is an independent date ("fri" then "mon") — two pills, so backspacing the second restores the first.
export function foldIntoDate(pillToken, word, now = new Date(), locations = []) {
  const token = (pillToken + ' ' + word).trim();
  const cls = classifyToken(token, now, locations);
  if (cls?.kind !== 'date') return null;
  const solo = classifyToken(word, now, locations);
  return solo?.kind === 'date' && solo.value.iso && solo.value.iso === cls.value.iso ? null : { ...cls, token };
}
export const ordinal = d => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
// The monthly day a rule names: "1st Sun", "last Fri", "last day" (month_day 31 clamps to month-end), "1st, 15th"; null when none.
export function monthOn(r) {
  if (r?.freq !== 'month') return null;
  if (r.nth != null && r.weekdays?.length) return (r.nth < 0 ? 'last' : ordinal(r.nth)) + ' ' + WEEKDAYS[r.weekdays[0]];
  return r.month_day ? [].concat(r.month_day).map(d => d === 31 ? 'last day' : ordinal(d)).join(', ') : null;
}
export function recurrenceLabel(rec) {
  if (!rec) return '';
  if (Array.isArray(rec)) return rec.map(recurrenceLabel).join(' + ');
  const n = rec.interval || 1;
  // A day set or a month day NAMES the step — but an interval > 1 still counts ("every 2 weeks on Mon" ≠ "Every Mon").
  if (rec.freq === 'week' && rec.weekdays?.length) {
    const wd = [...rec.weekdays].sort((a, b) => a - b), days = wd.join() === '1,2,3,4,5' ? null : wd.map(d => WEEKDAYS[d]).join(', ');
    return n > 1 ? `Every ${n} weeks on ${days ?? 'weekdays'}` : days ? 'Every ' + days : 'Weekdays';
  }
  const on = monthOn(rec);
  if (on) return n > 1 ? `Every ${n} months on the ${on}` : 'Every ' + on;
  return n > 1 ? `Every ${n} ${rec.freq}s` : 'Every ' + rec.freq;
}
