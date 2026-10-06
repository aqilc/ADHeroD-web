// Pure read-model (no DOM, no store): calendar recurrence, items, blocks, and locations.
import { _d, _iso, recurStep } from './store.js';

export const timeOf = (iso, fb = '') => iso.length > 10 ? iso.slice(11, 16) : fb;   // "HH:MM" or fb — the ONE date-vs-timed ISO decode (full-ISO round-trips once blanked Plan)
const dateOf = iso => iso.slice(0, 10);

// Occurrences within [from, to] inclusive; date-only from/to expand to start/end-of-day.
export function occurrencesInRange(rule, startsAtIso, fromIso, toIso, max = 400) {
  const from = dateOf(fromIso), to = dateOf(toIso), clock = timeOf(startsAtIso);
  const at = d => _iso(d) + (clock ? 'T' + clock : '');
  // Multiple rules (tasks already store an array; ICS files carry several RRULEs) — union them, de-duped and ordered.
  // Without this an array falls through the `!rule.freq` guard below and the whole series renders as one occurrence.
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

// Wall-clock datetime math, parsed as UTC so it's timezone-agnostic (no DST drift) — matching _d/_iso.
// Read the wall-clock DIGITS (like app.js _clMin) — a stored time can arrive as full ISO from a timestamptz
// round-trip or an external import; appending ':00Z' to that made an Invalid Date that blanked the calendar.
const wall = iso => new Date(iso.slice(0, 10) + 'T' + timeOf(iso, '00:00') + ':00Z');
export const minutesBetween = (a, b) => (wall(b) - wall(a)) / 60000;
// dateOnly ⇒ a bare day (all-day spans end date-only); otherwise a timed "YYYY-MM-DDTHH:MM"
export const addMinutes = (iso, mins, dateOnly) => { const d = new Date(wall(iso).getTime() + mins * 60000); return isNaN(d) ? iso : dateOnly ? _iso(d) : d.toISOString().slice(0, 16); };   // unparseable → zero-length, never a throw

export const placeable = t => t.parent_id !== null && !t.overview;   // projects + overview items are containers, never placed
const recursDaily = rule => [].concat(rule ?? []).some(r => r?.freq === 'day' && (r.interval || 1) === 1);   // tasks store an array of rules
export const onCalendar = (t, placed) => !!(placed?.has(t.id) || t.deadline_at || t.recurrence && t.recur_from);   // the only tasks calendarItems draws: an edit to any other leaves the calendar alone
// pure — all data comes from args
export function calendarItems(events, tasks, fromIso, toIso, placed) {
  const from = dateOf(fromIso), to = dateOf(toIso), items = [];
  // Membership is OVERLAP, not "starts inside": a window can be narrower than the item (day view asks for one
  // day), and a 4-day conference must still be visible on days 2-4. Occurrence search therefore looks back by
  // the item's own length, and anything that ended before the window is dropped again.
  const overlaps = (s, e) => dateOf(s) <= to && dateOf(e) >= from;
  const back = days => { const d = _d(from); d.setUTCDate(d.getUTCDate() - days); return _iso(d); };
  for (const ev of events || []) {
    // one unparseable row, or an end before its start (old all-day edits), degrades to a zero-length item, never a blank surface
    // ceiling: inverted rows are only read as one day, never repaired — a re-save fixes each; backfill if a DB scan finds many
    const dur = Math.max(0, minutesBetween(ev.starts_at, ev.ends_at) || 0), daily = recursDaily(ev.recurrence);
    for (const start of occurrencesInRange(ev.recurrence, ev.starts_at, back(Math.ceil(dur / 1440) + 1), toIso)) {
      const end = addMinutes(start, dur, ev.all_day);
      if (overlaps(start, end)) items.push({ kind: 'event', id: ev.id, title: ev.title, start, end, allDay: ev.all_day, color: ev.color, daily });
    }
  }
  const inRange = iso => { const day = dateOf(iso); return day >= from && day <= to; };
  for (const t of tasks || []) {
    if (!placeable(t) || !onCalendar(t, placed)) continue;
    // THE placement is the task's date-item (`placed`); never falls back to recur_from, which is only a
    // recurrence anchor now and gets its own marker when the task has no placement.
    const at = placed?.get(t.id), daily = recursDaily(t.recurrence);
    if (at) {
      const ad = at.length <= 10;   // date-only placement ⇒ all-day block (dropped into the all-day row)
      const end = ad ? at : addMinutes(at, t.est_minutes ?? 60);
      if (overlaps(at, end)) items.push({ kind: 'task-block', id: t.id, title: t.content, start: at, end, allDay: ad, color: t.color || null, daily });
    } else if (t.recurrence && t.recur_from && inRange(t.recur_from)) {
      items.push({ kind: 'task-due', id: t.id, title: t.content, start: t.recur_from, end: t.recur_from, allDay: t.recur_from.length <= 10, color: t.color || null, daily });
    }
    if (t.deadline_at && inRange(t.deadline_at)) {
      items.push({ kind: 'task-deadline', id: t.id, title: t.content, start: t.deadline_at, end: t.deadline_at, allDay: t.deadline_at.length <= 10, color: t.color || null, daily });
    }
  }
  // string sort on `start`: date-only ("2026-06-20") sorts before any same-day timed ("…T09:00") → all-day first.
  return items.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// A day overflowing a phone month cell shows tasks before what happens every day (decision #65); each group keeps its order.
export const tasksFirst = items => items.some(it => it.daily) ? [...items.filter(it => !it.daily), ...items.filter(it => it.daily)] : items;

// ---- Blocks (condition-bearing spans) ----
// blockDays: per-occurrence rows — { block_id, date, planned_start/end (the day's override), actual_start/end (what happened) }.
// A DAY-move is the override pointed at another date: the row stays keyed on the occurrence's own day
// (`src`), which is NOT the day it draws on. So the window scan drops what an override carried out, and each
// inbound row is resolved on its OWN day — one day per row, never a widened scan, whose occurrence budget a
// far-past source day would eat (leaving the block's own occurrences silently missing from the week).
// The planned slot: planned_* (substrate §4), or where rows written before it existed keep it — actual_*, until Start
// claims actual_start as the clock.
// ceiling: legacy branch — the DB is backfilled (db:backfill-planned), LocalStore rows aren't; delete once LocalStore migrates them
// A stopped day's log: both ends recorded, else it has none and keeps its planned slot.
export const loggedOf = bd => bd?.status === 'done' && bd.actual_start && bd.actual_end ? [bd.actual_start, bd.actual_end] : null;
export const plannedOf = bd => bd?.planned_start ? [bd.planned_start, bd.planned_end] : bd?.actual_start && !['running', 'done'].includes(bd.status) ? [bd.actual_start, bd.actual_end] : null;
// Running past the day it lives on = "didn't end" (user 2026-09-28); a block over midnight lives on to its planned end. Display only.
export function unended(bd, block, today) {
  if (bd?.status !== 'running') return false;
  const day = dateOf(bd.actual_start || bd.date), end = plannedOf(bd)?.[1] || blocksInRange(block ? [block] : [], day, day, [bd]).find(x => x.bd === bd)?.planned || day;
  return (end.length > 10 ? end : end + 'T24:00') <= today + 'T00:00';   // an all-day end is a whole day
}
export function blocksInRange(blocks, fromIso, toIso, blockDays = [], now = null) {
  const out = [], from = dateOf(fromIso), to = dateOf(toIso), inWin = d => d >= from && d <= to;
  for (const b of blocks || []) {
    const dur = minutesBetween(b.starts_at, b.ends_at) || 0;   // one unparseable row degrades to a zero-length block, never an Invalid-Date span
    // all-day: ends_at is the INCLUSIVE last day (as events), so it covers — and is searched back over — every day of its span
    // ceiling: an inverted all-day row reads as one day, never repaired — a re-save fixes each; backfill if a DB scan finds many
    // timed: yesterday's occurrence running past midnight draws its tail (decision 24, as the Mac's wSpans)
    // ceiling: one day of look-back — a timed block over a day long draws nothing from its third day; widen when one exists
    const allDay = !!b.all_day || b.starts_at.length <= 10, days = allDay ? Math.max(0, Math.round(dur / 1440)) : 1;
    const lo = addMinutes(from, -days * 1440, true), seen = d => d >= lo && d <= to;   // source days the look-back resolves
    const bds = blockDays.filter(d => d.block_id === b.id);
    const push = (start, bd) => {
      // H-states-D1: a started day draws at the PLANNED slot — the day's plan, else the rule's time on the day it lives;
      // a stopped one shrinks to its log (actual_*)
      const p = loggedOf(bd) || plannedOf(bd), s = p?.[0] || dateOf(bd?.actual_start || start) + start.slice(10);
      const planned = p?.[1] || (allDay ? addMinutes(dateOf(s), days * 1440, true) : addMinutes(s, dur));
      if (allDay ? dateOf(s) > to || dateOf(planned) < from : !inWin(dateOf(s)) && !(dateOf(s) < from && planned > from + 'T00:00')) return;   // moved onto another day, outside this window
      // §H H-bleed: still RUNNING past its planned end, on its own day, it hasn't ended — draw it to `now` (local "YYYY-MM-DDTHH:MM"), open.
      // A passed day keeps its plan ("didn't end", app.js clUnended).
      const open = bd?.status === 'running' && !allDay && !!now && now > planned && dateOf(now) === dateOf(s);
      out.push({ block: b, id: b.id, title: b.title, start: s, end: open ? now : planned, open, planned, allDay, src: dateOf(start), bd,
        location_id: b.location_id, areas: b.areas || [], color: b.color });
    };
    for (const start of occurrencesInRange(b.recurrence, b.starts_at, lo, to)) push(start, bds.find(d => d.date === dateOf(start)));
    for (const d of bds) {   // moved IN from a source day the look-back didn't reach; landing in lo…to = overlapping the window
      const at = d.planned_start || d.actual_start;
      if (at && !seen(d.date) && seen(dateOf(at)))
        for (const start of occurrencesInRange(b.recurrence, b.starts_at, d.date, d.date)) push(start, d);
    }
  }
  return out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---- Sizes (folded from size.js) ----
// Size buckets — the scheduling decision; est_minutes stays the precise value (spec §When popover settled)
export const SIZES = { tiny: [1, 8, 5], short: [9, 15, 15], session: [16, 60, 45], multi: [61, Infinity, 150] };
export const sizeFromMinutes = (m) => { if (!m) return null; for (const k in SIZES) { const [lo, hi] = SIZES[k]; if (m >= lo && m <= hi) return k; } return 'multi'; };
export const minutesForSize = (k) => SIZES[k]?.[2] ?? 0;
// A completion's ember-burst odds by its effort's size bucket: 1 in 8, weighted by effort — a surprise, never a sure payout.
export const emberOdds = (size) => ({ tiny: .5, session: 2, multi: 3 }[size] ?? 1) / 8;
