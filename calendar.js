// Pure read-model (no DOM, no store): calendar recurrence, items, blocks, and locations.
import { _d, _iso, recurStep } from './store.js';

export const timeOf = (iso, fb = '') => iso.length > 10 ? iso.slice(11, 16) : fb;   // "HH:MM" or fb — the ONE date-vs-timed ISO decode (full-ISO round-trips once blanked Plan)
const dateOf = iso => iso.slice(0, 10);

// Occurrences within [from, to] inclusive; date-only from/to expand to start/end-of-day.
export function occurrencesInRange(rule, startsAtIso, fromIso, toIso, max = 400) {
  const from = dateOf(fromIso), to = dateOf(toIso), clock = timeOf(startsAtIso);
  const at = d => _iso(d) + (clock ? 'T' + clock : '');
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
    out.push(at(cur));
    if (rule.ends?.count != null && ++count >= rule.ends.count) break;
    cur = recurStep(rule, cur);
  }
  return out;
}

// Wall-clock datetime math, parsed as UTC so it's timezone-agnostic (no DST drift) — matching _d/_iso.
const p2 = n => String(n).padStart(2, '0');
// Read the wall-clock DIGITS (like app.js _clMin) — a stored time can arrive as full ISO from a timestamptz
// round-trip or an external import; appending ':00Z' to that made an Invalid Date that blanked the calendar.
const wall = iso => new Date(iso.slice(0, 10) + 'T' + timeOf(iso, '00:00') + ':00Z');
const fmtDT = d => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
const minutesBetween = (a, b) => (wall(b) - wall(a)) / 60000;
// dateOnly ⇒ a bare day (all-day spans end date-only); otherwise a timed "YYYY-MM-DDTHH:MM"
const addMinutes = (iso, mins, dateOnly) => { const d = new Date(wall(iso).getTime() + mins * 60000); return dateOnly ? _iso(d) : fmtDT(d); };

// pure — all data comes from args
export function calendarItems(events, tasks, fromIso, toIso, now, placed) {
  const from = dateOf(fromIso), to = dateOf(toIso), items = [];
  // Membership is OVERLAP, not "starts inside": a window can be narrower than the item (day view asks for one
  // day), and a 4-day conference must still be visible on days 2-4. Occurrence search therefore looks back by
  // the item's own length, and anything that ended before the window is dropped again.
  const overlaps = (s, e) => dateOf(s) <= to && dateOf(e) >= from;
  const back = days => { const d = _d(from); d.setUTCDate(d.getUTCDate() - days); return _iso(d); };
  for (const ev of events || []) {
    const dur = minutesBetween(ev.starts_at, ev.ends_at) || 0;   // one unparseable row degrades to a zero-length item, never a blank surface
    for (const start of occurrencesInRange(ev.recurrence, ev.starts_at, back(Math.ceil(Math.max(0, dur) / 1440) + 1), toIso)) {
      const end = addMinutes(start, dur, ev.all_day);
      if (overlaps(start, end)) items.push({ kind: 'event', id: ev.id, title: ev.title, start, end, allDay: ev.all_day, color: ev.color });
    }
  }
  const inRange = iso => { const day = dateOf(iso); return day >= from && day <= to; };
  for (const t of tasks || []) {
    if (t.parent_id === null || t.sidebar) continue;   // skip projects + sidebar items
    // THE placement is the task's date-item (`placed`); never falls back to recur_from, which is only a
    // recurrence anchor now and gets its own marker when the task has no placement.
    const at = placed?.get(t.id);
    if (at) {
      const ad = at.length <= 10;   // date-only placement ⇒ all-day block (dropped into the all-day row)
      const end = ad ? at : addMinutes(at, t.est_minutes ?? 60);
      if (overlaps(at, end)) items.push({ kind: 'task-block', id: t.id, title: t.content, start: at, end, allDay: ad, color: t.color || null });
    } else if (t.recurrence && t.recur_from && inRange(t.recur_from)) {
      items.push({ kind: 'task-due', id: t.id, title: t.content, start: t.recur_from, end: t.recur_from, allDay: t.recur_from.length <= 10, color: t.color || null });
    }
    if (t.deadline_at && inRange(t.deadline_at)) {
      items.push({ kind: 'task-deadline', id: t.id, title: t.content, start: t.deadline_at, end: t.deadline_at, allDay: t.deadline_at.length <= 10, color: t.color || null });
    }
  }
  // string sort on `start`: date-only ("2026-06-20") sorts before any same-day timed ("…T09:00") → all-day first.
  return items.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---- Blocks (condition-bearing spans) ----
// blockDays: optional per-occurrence overrides — { block_id, date, actual_start, actual_end }
// When a blockDay row exists for an occurrence, actual_start/actual_end override the computed start/end.
// A DAY-move is the same override pointed at another date: the row stays keyed on the occurrence's own day
// (`src`), which is NOT the day it draws on. So the window scan drops what an override carried out, and each
// inbound row is resolved on its OWN day — one day per row, never a widened scan, whose occurrence budget a
// far-past source day would eat (leaving the block's own occurrences silently missing from the week).
export function blocksInRange(blocks, fromIso, toIso, blockDays = []) {
  const out = [], from = dateOf(fromIso), to = dateOf(toIso), inWin = d => d >= from && d <= to;
  for (const b of blocks || []) {
    const dur = minutesBetween(b.starts_at, b.ends_at) || 0;   // one unparseable row degrades to a zero-length block, never an Invalid-Date span
    const bds = blockDays.filter(d => d.block_id === b.id);
    const push = (start, bd) => {
      const s = bd?.actual_start || start;
      if (!inWin(dateOf(s))) return;   // moved onto another day, outside this window
      out.push({ block: b, id: b.id, title: b.title, start: s, end: bd?.actual_end || addMinutes(s, dur), src: dateOf(start),
        location_id: b.location_id, areas: b.areas || [], energy: b.energy, availability: b.availability, color: b.color });
    };
    for (const start of occurrencesInRange(b.recurrence, b.starts_at, from, to)) push(start, bds.find(d => d.date === dateOf(start)));
    for (const d of bds)   // moved IN from a day outside the window (an in-window source is already resolved above)
      if (d.actual_start && !inWin(d.date) && inWin(dateOf(d.actual_start)) && dateOf(d.actual_start) !== d.date)
        for (const start of occurrencesInRange(b.recurrence, b.starts_at, d.date, d.date)) push(start, d);
  }
  return out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---- Sizes (folded from size.js) ----
// Size buckets — the scheduling decision; est_minutes stays the precise value (spec §When popover settled)
export const SIZES = { tiny: [1, 8, 5], short: [9, 15, 15], session: [16, 60, 45], multi: [61, Infinity, 150] };
export const sizeFromMinutes = (m) => { if (!m) return null; for (const k in SIZES) { const [lo, hi] = SIZES[k]; if (m >= lo && m <= hi) return k; } return 'multi'; };
export const minutesForSize = (k) => SIZES[k]?.[2] ?? 0;

