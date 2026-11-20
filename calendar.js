// Pure read-model (no DOM, no store): calendar recurrence, items, blocks, and locations.
import { _d, _iso, recurStep } from './store.js';
import { localStamp } from './nlp.js';
import { ruleFromRRULE, tzOffsetAt } from './import.js';

export const timeOf = (iso, fb = '') => iso.length > 10 ? iso.slice(11, 16) : fb;   // "HH:MM" or fb: the one date-vs-timed ISO decode (a stored time can arrive as full ISO)
const dateOf = iso => iso.slice(0, 10);

// Occurrences within [from, to] inclusive; date-only from/to expand to start/end-of-day.
export function occurrencesInRange(rule, startsAtIso, fromIso, toIso, max = 400) {
  const from = dateOf(fromIso), to = dateOf(toIso), clock = timeOf(startsAtIso);
  const at = d => _iso(d) + (clock ? 'T' + clock : '');
  // Multiple rules (tasks store an array; ICS files carry several RRULEs): union them, de-duped and ordered; an array
  // would fall through the `!rule.freq` guard below and render as one occurrence.
  if (Array.isArray(rule)) {
    const seen = new Set();
    for (const r of rule) for (const s of occurrencesInRange(r, startsAtIso, fromIso, toIso, max)) seen.add(s);
    return [...seen].sort();
  }
  if (!rule || !rule.freq) { const day = dateOf(startsAtIso); return day >= from && day <= to ? [startsAtIso] : []; }   // null/malformed → one-off
  const out = [];
  let cur = _d(startsAtIso), count = 0;   // anchor always matches by construction
  // Fast-forward to the range start (counting toward ends.count) so a far-past anchor doesn't exhaust `max`.
  while (_iso(cur) < from) {
    if (rule.ends?.date && _iso(cur) > rule.ends.date) return out;
    if (rule.ends?.count != null && ++count >= rule.ends.count) return out;
    cur = recurStep(rule, cur);
  }
  for (let i = 0; i < max; i++) {
    const day = _iso(cur);
    if (day > to) break;
    if (rule.ends?.date && day > rule.ends.date) break;
    // exdates (ICS EXDATE, and how a moved occurrence is represented: excluded here + a standalone event).
    // ceiling: an excluded day still consumes an `ends.count` slot, matching how most calendars read COUNT.
    if (!rule.exdates?.includes(day)) out.push(at(cur));
    if (rule.ends?.count != null && ++count >= rule.ends.count) break;
    cur = recurStep(rule, cur);
  }
  return out;
}

// Wall-clock datetime math, parsed as UTC so it's timezone-agnostic (no DST drift), matching _d/_iso.
// Reads the wall-clock digits: a stored time can arrive as full ISO (timestamptz round-trip, import), and appending
// ':00Z' to that is an Invalid Date that blanks the calendar.
const wall = iso => new Date(iso.slice(0, 10) + 'T' + timeOf(iso, '00:00') + ':00Z');
export const minutesBetween = (a, b) => (wall(b) - wall(a)) / 60000;
// dateOnly ⇒ a bare day (all-day spans end date-only); otherwise a timed "YYYY-MM-DDTHH:MM"
export const addMinutes = (iso, mins, dateOnly) => { const d = new Date(wall(iso).getTime() + mins * 60000); return isNaN(d) ? iso : dateOnly ? _iso(d) : d.toISOString().slice(0, 16); };   // unparseable: zero-length, never a throw

// Going / Not going for one day (true | false | undefined = unanswered). A one-off reads its only answer, so a move keeps it.
// ceiling: a series keeps a key per answered day, never pruned; drop past days on save if a row grows past ~1K
export const goingOn = (ev, day) => ev.recurrence?.freq ? ev.going?.[day] ?? ev.going?.['*'] : Object.values(ev.going ?? {})[0];   // '*': a whole series' answer (a Google decline)
export const placeable = t => t.parent_id !== null && !t.overview;   // projects + overview items are containers, never placed
const recursDaily = rule => [].concat(rule ?? []).some(r => r?.freq === 'day' && (r.interval || 1) === 1);   // tasks store an array of rules
export const onCalendar = (t, placed) => !!(placed?.has(t.id) || t.deadline_at || t.recurrence && t.recur_from);   // the only tasks calendarItems draws
// pure — all data comes from args
export function calendarItems(events, tasks, fromIso, toIso, placed) {
  const from = dateOf(fromIso), to = dateOf(toIso), items = [];
  // Membership is overlap, not "starts inside": a day view's window is narrower than a 4-day conference, which must
  // still show on days 2-4. Occurrence search looks back by the item's own length; anything ended before the window drops.
  const overlaps = (s, e) => dateOf(s) <= to && dateOf(e) >= from;
  const back = days => { const d = _d(from); d.setUTCDate(d.getUTCDate() - days); return _iso(d); };
  for (const ev of events || []) {
    // an unparseable row, or an end before its start, degrades to a zero-length item, never a blank surface
    // ceiling: inverted rows are only read as one day, never repaired — a re-save fixes each; backfill if a DB scan finds many
    const dur = Math.max(0, minutesBetween(ev.starts_at, ev.ends_at) || 0), daily = recursDaily(ev.recurrence);
    for (const at of occurrencesInRange(ev.recurrence, ev.starts_at, back(Math.ceil(dur / 1440) + 1), ev.tz ? addMinutes(to, 1440, true) : toIso)) {   // tz: a day ahead, a zone east of here
      const start = ev.tz ? zonedToLocal(at, ev.tz) : at, end = addMinutes(start, dur, ev.all_day);
      if (overlaps(start, end)) items.push({ kind: 'event', id: ev.id, title: ev.title, start, end, allDay: ev.all_day, color: ev.color, daily, going: goingOn(ev, dateOf(start)), join: ev.join, importance: ev.importance });   // join: an Outlook call's link
    }
  }
  const inRange = iso => { const day = dateOf(iso); return day >= from && day <= to; };
  for (const t of tasks || []) {
    if (!placeable(t) || !onCalendar(t, placed)) continue;
    // The placement is the task's date-item (`placed`); recur_from is only a recurrence anchor with its own marker.
    const at = placed?.get(t.id), daily = recursDaily(t.recurrence);
    if (at) {
      const ad = at.length <= 10;   // date-only placement: an all-day block
      const end = ad ? at : addMinutes(at, t.est_minutes ?? 60);
      if (overlaps(at, end)) items.push({ kind: 'task-block', id: t.id, title: t.content, start: at, end, allDay: ad, color: t.color || null, daily });
    } else if (t.recurrence && t.recur_from && inRange(t.recur_from)) {
      items.push({ kind: 'task-due', id: t.id, title: t.content, start: t.recur_from, end: t.recur_from, allDay: t.recur_from.length <= 10, color: t.color || null, daily });
    }
    if (t.deadline_at && inRange(t.deadline_at)) {
      items.push({ kind: 'task-deadline', id: t.id, title: t.content, start: t.deadline_at, end: t.deadline_at, allDay: t.deadline_at.length <= 10, color: t.color || null, daily });
    }
  }
  // string sort on `start`: a date-only start sorts before any same-day timed one, so all-day first.
  return items.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---- Google Calendar's mirror (gcal_events, docs/superpowers/specs/2026-11-14-google-calendar-sync.md §Reading) ----
// Google's event colors by colorId, as Google Calendar draws them
const GCAL_COLORS = { 1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000' };
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const wallIn = (ms, tz) => new Date(ms + tzOffsetAt(tz, ms)).toISOString().slice(0, 16);   // an instant's "YYYY-MM-DDTHH:MM" in tz
// A wall clock in tz as this browser's; the second offset read puts a time beside a DST change on its own side of it
const zonedToLocal = (wall, tz) => { const w = Date.parse(wall + 'Z'), u = w - tzOffsetAt(tz, w); return localStamp(new Date(w - tzOffsetAt(tz, u))); };
const ymd = v => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
// Each shown calendar's rows as read-only events calendarItems draws, cancelled ones hidden. A series in another zone
// keeps that zone's wall clock (tz) and converts per occurrence; a moved or cancelled occurrence is its own row, and
// its series skips the day it left (exdates are days in the series' own clock).
export function gcalAsEvents(rows, cals) {
  const color = new Map(cals.filter(c => c.shown).map(c => [c.id, c.color]));
  const left = new Map();   // calendar + series id → the starts its moved or cancelled occurrences replaced
  for (const r of rows) if (r.series_id && r.original_start) { const k = r.calendar_id + r.series_id; left.set(k, [...left.get(k) ?? [], r.original_start]); }
  const out = [];
  for (const r of rows) {
    if (r.status === 'cancelled' || !color.has(r.calendar_id) || !r.starts_at) continue;
    const tz = r.all_day || !r.tz || r.tz === HERE ? null : r.tz;
    const at = s => s.length <= 10 ? s : tz ? wallIn(Date.parse(s), tz) : localStamp(new Date(s));
    const starts = at(r.starts_at), ends = r.all_day ? addMinutes(r.ends_at || starts, -1440, true) : at(r.ends_at || r.starts_at), utc = v => at(`${ymd(v)}T${v.slice(9, 11)}:${v.slice(11, 13)}:00Z`);
    const exdates = [...(left.get(r.calendar_id + r.google_id) ?? []).map(s => at(s).slice(0, 10)),
      ...(r.recurrence ?? []).filter(l => l.startsWith('EXDATE')).flatMap(l => l.slice(l.indexOf(':') + 1).split(',')).map(v => v.endsWith('Z') ? utc(v).slice(0, 10) : ymd(v))];
    // Google's UNTIL instant as the last day it covers on the series' clock (ruleFromRRULE reads UNTIL's digits as that day)
    const until = l => l.replace(/UNTIL=(\d{8}T\d{6}Z)/, (_, v) => { const w = utc(v); return 'UNTIL=' + (w.slice(11) < starts.slice(11) ? addMinutes(w.slice(0, 10), -1440, true) : w.slice(0, 10)).replaceAll('-', ''); });
    // ceiling: a rule ruleFromRRULE refuses (BYSETPOS, RDATE lines) draws only the series' first start; revisit when
    // one shows up in his calendar
    const rules = (r.recurrence ?? []).filter(l => l.startsWith('RRULE:')).map(l => ruleFromRRULE(until(l.slice(6)), r.title).rule).filter(Boolean).map(rule => exdates.length ? { ...rule, exdates } : rule);
    out.push({ id: 'g:' + r.id, title: r.title || 'Untitled', notes: r.notes || '', location: r.place, all_day: r.all_day, starts_at: starts, ends_at: ends < starts ? starts : ends, tz,
      recurrence: rules.length > 1 ? rules : rules[0] ?? null, color: GCAL_COLORS[r.color] || color.get(r.calendar_id), going: r.declined ? { '*': false } : {}, countdown: false });   // declined in Google: Not going on every day it happens
  }
  return out;
}

// A day overflowing a phone month cell shows tasks before what happens every day; each group keeps its order.
export const tasksFirst = items => items.some(it => it.daily) ? [...items.filter(it => !it.daily), ...items.filter(it => it.daily)] : items;

// ---- Blocks (condition-bearing spans) ----
// blockDays: per-occurrence rows — { block_id, date, planned_start/end (the day's override), actual_start/end (what happened) }.
// A day-move is the override pointed at another date: the row stays keyed on the occurrence's own day (`src`). The
// window scan drops what an override carried out, and each inbound row resolves on its own day, never via a widened
// scan: a far-past source day would eat its occurrence budget and drop the week's own.
// The planned slot: planned_* (substrate §4), else actual_* on older rows, until Start claims actual_start as the clock.
// ceiling: legacy branch — the DB is backfilled (db:backfill-planned), LocalStore rows aren't; delete once LocalStore migrates them
// A stopped day's log: both ends recorded, else it has none and keeps its planned slot.
export const loggedOf = bd => bd?.status === 'done' && bd.actual_start && bd.actual_end ? [bd.actual_start, bd.actual_end] : null;
export const plannedOf = bd => bd?.planned_start ? [bd.planned_start, bd.planned_end] : bd?.actual_start && !['running', 'done'].includes(bd.status) ? [bd.actual_start, bd.actual_end] : null;
// Running past the day it lives on = "didn't end"; a block over midnight lives on to its planned end. Display only.
export function unended(bd, block, today) {
  if (bd?.status !== 'running') return false;
  const day = dateOf(bd.actual_start || bd.date), end = plannedOf(bd)?.[1] || blocksInRange(block ? [block] : [], day, day, [bd]).find(x => x.bd === bd)?.planned || day;
  return (end.length > 10 ? end : end + 'T24:00') <= today + 'T00:00';   // an all-day end is a whole day
}
export function blocksInRange(blocks, fromIso, toIso, blockDays = [], now = null) {
  const out = [], from = dateOf(fromIso), to = dateOf(toIso), inWin = d => d >= from && d <= to;
  for (const b of blocks || []) {
    const dur = minutesBetween(b.starts_at, b.ends_at) || 0;   // an unparseable row degrades to a zero-length block
    // all-day: ends_at is the inclusive last day (as events), so every day of its span is covered and searched back over
    // ceiling: an inverted all-day row reads as one day, never repaired; a re-save fixes each; backfill if a DB scan finds many
    // timed: yesterday's occurrence running past midnight draws its tail (as the Mac's wSpans)
    // ceiling: one day of look-back — a timed block over a day long draws nothing from its third day; widen when one exists
    const allDay = !!b.all_day || b.starts_at.length <= 10, days = allDay ? Math.max(0, Math.round(dur / 1440)) : 1;
    const lo = addMinutes(from, -days * 1440, true), seen = d => d >= lo && d <= to;   // source days the look-back resolves
    const bds = blockDays.filter(d => d.block_id === b.id);
    const push = (start, bd) => {
      // a started day draws at the planned slot (the day's plan, else the rule's time on the day it lives);
      // a stopped one shrinks to its log (actual_*)
      const p = loggedOf(bd) || plannedOf(bd), s = p?.[0] || dateOf(bd?.actual_start || start) + start.slice(10);
      const planned = p?.[1] || (allDay ? addMinutes(dateOf(s), days * 1440, true) : addMinutes(s, dur));
      if (allDay ? dateOf(s) > to || dateOf(planned) < from : !inWin(dateOf(s)) && !(dateOf(s) < from && planned > from + 'T00:00')) return;   // moved onto another day, outside this window
      // Still running past its planned end, on its own day: draw it to `now` (local "YYYY-MM-DDTHH:MM"), open.
      // A passed day keeps its plan ("didn't end", app.js clUnended).
      const open = bd?.status === 'running' && !allDay && !!now && now > planned && dateOf(now) === dateOf(s);
      out.push({ block: b, id: b.id, title: b.title, start: s, end: open ? now : planned, open, planned, allDay, src: dateOf(start), bd,
        location_id: b.location_id, areas: b.areas || [], color: b.color });
    };
    for (const start of occurrencesInRange(b.recurrence, b.starts_at, lo, to)) push(start, bds.find(d => d.date === dateOf(start)));
    for (const d of bds) {   // moved in from a source day the look-back didn't reach
      const at = d.planned_start || d.actual_start;
      if (at && !seen(d.date) && seen(dateOf(at)))
        for (const start of occurrencesInRange(b.recurrence, b.starts_at, d.date, d.date)) push(start, d);
    }
  }
  return out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---- Sizes (folded from size.js) ----
// Size buckets are the scheduling decision; est_minutes stays the precise value (spec §When popover settled)
export const SIZES = { tiny: [1, 8, 5], short: [9, 15, 15], session: [16, 60, 45], multi: [61, Infinity, 150] };
export const sizeFromMinutes = (m) => { if (!m) return null; for (const k in SIZES) { const [lo, hi] = SIZES[k]; if (m >= lo && m <= hi) return k; } return 'multi'; };
export const minutesForSize = (k) => SIZES[k]?.[2] ?? 0;
// A completion's ember-burst odds by its effort's size bucket: 1 in 8, weighted by effort — a surprise, never a sure payout.
export const emberOdds = (size) => ({ tiny: .5, session: 2, multi: 3 }[size] ?? 1) / 8;

// ---- A place's open hours (locations.hours: { mon: [["09:00","13:30"], …], …, sun: [] }; null = unknown) ----
export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_SETS = { weekday: [0, 1, 2, 3, 4], weekend: [5, 6], daily: [0, 1, 2, 3, 4, 5, 6], everyday: [0, 1, 2, 3, 4, 5, 6] };
const dayLabel = i => DAY_NAMES[i][0].toUpperCase() + DAY_NAMES[i].slice(1, 3);
const hm = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
const mins = t => +t.slice(0, 2) * 60 + +t.slice(3);
// A typed day word → day indexes ("mon", "th": any prefix of 2+, "mondays", "weds", "sat-mon", "weekdays"), else null.
function daysOf(word) {
  const set = word.replace(/s$/, '');
  if (Object.hasOwn(DAY_SETS, set)) return DAY_SETS[set];
  const find = w => w?.length >= 2 ? DAY_NAMES.findIndex(n => n.startsWith(w)) : -1;
  const at = w => find(w) < 0 ? find(w?.replace(/s$/, '')) : find(w), [a, b, extra] = word.split('-');
  const from = at(a), to = b === undefined ? from : at(b);
  if (from < 0 || to < 0 || extra !== undefined) return null;
  const out = [from];
  while (out.at(-1) !== to) out.push((out.at(-1) + 1) % 7);   // "sat-mon" wraps the week
  return out;
}
// A typed time → minutes; with no am/pm and not 24h ("14:00", "09:00") the first at or after `after`, else null (a range never
// runs backward). An `end` of 12am (or a bare 12 past noon) is midnight closing, 1440 ("24:00"). null when it isn't one.
function clockAt(word, after, end) {
  const m = /^(\d{1,2})(?::(\d{2}))?([ap]m?)?$/.exec(word);
  const h = +m?.[1], min = +(m?.[2] ?? 0), midnight = end && h === 12 && min === 0 ? 1440 : null;
  if (!m || h > 23 || min > 59) return null;
  if (m[3]) return h > 12 || h === 0 ? null : m[3][0] === 'a' && midnight ? midnight : (h % 12 + (m[3][0] === 'p' ? 12 : 0)) * 60 + min;
  if (h === 0 || h > 12 || m[1][0] === '0') return h * 60 + min;
  return [h % 12 * 60 + min, h % 12 * 60 + min + 720, midnight].find(t => t !== null && t >= after) ?? null;
}
// One typed range ("9-1:30", "9am–5pm") → ["09:00", "13:30"], starting at or after `after` ("HH:MM", else 6am); null when unreadable.
export function parseRange(word, after) {
  const [a, b, extra] = word.split(/[-–]/), start = extra === undefined && b ? clockAt(a, after ? mins(after) : 360) : null;
  const end = start === null ? null : clockAt(b, start + 1, true);
  return end !== null && end > start ? [hm(start), hm(end)] : null;   // ceiling: no range past midnight; revisit when one of his places closes after 12am
}
// Typed hours in the line's one form: lowercase, "9 to 5" and dashes → "9-5", "9 a.m." → "9am", "every day" → "daily".
export const normHours = line => String(line).toLowerCase().replace(/\s*[-–—]\s*|\s+to\s+/g, '-').replace(/(\d)\s*([ap])\.?m?\.?(?![a-z])/g, '$1$2m').replace(/every day/g, 'daily');
// The typed line → { hours, bad }: the whole week (a day it doesn't name is closed), or null for an empty line; bad = the words
// it couldn't read. Parts split on , or ;. A part naming no day adds to the previous part's days (every day when it's first).
export function parseHours(line) {
  const text = normHours(line);
  if (!text.replace(/[,;\s]/g, '')) return { hours: null, bad: [] };
  const hours = Object.fromEntries(WEEK.map(d => [d, []])), bad = [];
  let last = DAY_SETS.daily, pending = [];
  for (const part of text.split(/[,;]/)) {
    const words = part.split(/\s+/).filter(Boolean), days = [...pending];
    let k = 0;
    for (let d; k < words.length && (d = daysOf(words[k])); k++) days.push(...d);
    if (k === words.length) { pending = days; continue; }   // "mon, wed 9-5": a part of only days joins the next
    pending = [];
    if (days.length) last = days;
    const ranges = days.length ? [] : [...hours[WEEK[last[0]]]];
    for (const word of words.slice(k)) {
      const r = word === 'closed' || parseRange(word, ranges.at(-1)?.[1]);
      if (!r) bad.push(word); else if (r !== true) ranges.push(r);
    }
    for (const d of last) hours[WEEK[d]] = ranges;
  }
  return { hours, bad };
}
// Hours → runs of neighboring days with equal ranges: [{ days, label: "Mon–Fri" | "Sat" | "Daily", ranges }].
export function hoursGroups(hours) {
  const out = [], key = i => JSON.stringify(hours?.[WEEK[i]] ?? []);
  for (let i = 0; i < 7; i++) {
    const g = out.at(-1);
    if (g && key(g.days.at(-1)) === key(i)) g.days.push(i);
    else out.push({ days: [i], ranges: hours?.[WEEK[i]] ?? [] });
  }
  for (const g of out) g.label = g.days.length === 7 ? 'Daily' : dayLabel(g.days[0]) + (g.days.length > 1 ? '–' + dayLabel(g.days.at(-1)) : '');
  return out;
}
// Hours → the typed line that reads back as them: each run of open days, am/pm only where a bare hour would read otherwise.
export function hoursText(hours) {
  if (!hours) return '';
  const say = (min, after, end) => {
    const bare = (Math.floor(min / 60) % 12 || 12) + (min % 60 ? ':' + String(min % 60).padStart(2, '0') : '');
    return clockAt(bare, after, end) === min && !bare.startsWith('12') ? bare : bare + (min < 720 || min >= 1440 ? 'am' : 'pm');   // a bare 12 reads as noon or midnight only by context
  };
  const parts = hoursGroups(hours).filter(g => g.ranges.length).map(g => {
    const days = { Daily: 'daily', 'Mon–Fri': 'weekdays', 'Sat–Sun': 'weekends' }[g.label] ?? g.label.toLowerCase().replace('–', '-');
    let after = 360;
    return [days, ...g.ranges.map(([a, b]) => { const range = say(mins(a), after) + '-' + say(mins(b), mins(a) + 1, true); after = mins(b); return range; })].join(' ');
  });
  return parts.join(', ') || 'daily closed';
}
