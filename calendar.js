// Pure read-model (no DOM, no store): calendar recurrence, items, blocks, and locations.
import { _d, _iso, recurStep } from './store.js';

const timeOf = iso => iso.length > 10 ? iso.slice(10) : '';   // "THH:MM" or ""
const dateOf = iso => iso.slice(0, 10);

// Occurrences within [from, to] inclusive; date-only from/to expand to start/end-of-day.
export function occurrencesInRange(rule, startsAtIso, fromIso, toIso, max = 400) {
  const from = dateOf(fromIso), to = dateOf(toIso), clock = timeOf(startsAtIso);
  const at = d => _iso(d) + clock;
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
const wall = iso => new Date((iso.length > 10 ? iso : iso + 'T00:00') + ':00Z');
const fmtDT = d => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
const minutesBetween = (a, b) => (wall(b) - wall(a)) / 60000;
const addMinutes = (iso, mins) => fmtDT(new Date(wall(iso).getTime() + mins * 60000));   // timed result
const addMinutesDate = (iso, mins) => _iso(new Date(wall(iso).getTime() + mins * 60000)); // date-only result (all-day spans)

// pure — all data comes from args
export function calendarItems(events, tasks, fromIso, toIso, now) {
  const from = dateOf(fromIso), to = dateOf(toIso), items = [];
  for (const ev of events || []) {
    const dur = minutesBetween(ev.starts_at, ev.ends_at);
    for (const start of occurrencesInRange(ev.recurrence, ev.starts_at, fromIso, toIso)) {
      const end = ev.all_day ? addMinutesDate(start, dur) : addMinutes(start, dur);   // all-day ends stay date-only
      items.push({ kind: 'event', id: ev.id, title: ev.title, start, end, allDay: ev.all_day, color: ev.color });
    }
  }
  const inRange = iso => { const day = dateOf(iso); return day >= from && day <= to; };
  for (const t of tasks || []) {
    if (t.parent_id === null || t.sidebar) continue;   // skip projects + sidebar items
    // Scheduled tasks only show in their window; never falls back to due_at. Unscheduled → due marker.
    if (t.scheduled_at) {
      const ad = t.scheduled_at.length <= 10;   // date-only scheduled_at ⇒ all-day block (dropped into the all-day row)
      // a later due date stretches the all-day block into a multi-day band (scheduled → due = the window to do it)
      const adEnd = ad && t.due_at && t.due_at.slice(0, 10) > t.scheduled_at ? t.due_at.slice(0, 10) : t.scheduled_at;
      if (inRange(t.scheduled_at)) items.push({ kind: 'task-block', id: t.id, title: t.content, start: t.scheduled_at, end: ad ? adEnd : addMinutes(t.scheduled_at, t.est_minutes ?? 60), allDay: ad, color: t.color || null });
    } else if (t.due_at && inRange(t.due_at)) {
      items.push({ kind: 'task-due', id: t.id, title: t.content, start: t.due_at, end: t.due_at, allDay: t.due_at.length <= 10, color: t.color || null });
    }
  }
  // string sort on `start`: date-only ("2026-06-20") sorts before any same-day timed ("…T09:00") → all-day first.
  return items.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---- Now Room (pure) ----
export function daypartOf(hour) {
  return hour < 5 ? 'night' : hour < 11 ? 'dawn' : hour < 16 ? 'day' : hour < 20 ? 'dusk' : 'night';
}
export function eventsFirst(items) {
  return [...items.filter(it => it.kind === 'event'), ...items.filter(it => it.kind !== 'event')];
}

// ---- Locations (pure) ----
export function travelTime(travel, fromId, toId, def = 0) {
  if (!fromId || !toId || fromId === toId) return 0;
  return travel?.[fromId + '>' + toId] ?? travel?.[toId + '>' + fromId] ?? def;
}
export function locationConstraintAllows(constraint, locationId) {
  const c = constraint || { mode: 'any', ids: [] };
  if (c.mode === 'only') return (c.ids || []).includes(locationId);
  if (c.mode === 'except') return !(c.ids || []).includes(locationId);
  return true;
}

// ---- Blocks (condition-bearing spans) ----
export function blocksInRange(blocks, fromIso, toIso) {
  const out = [];
  for (const b of blocks || []) {
    const durMs = wall(b.ends_at) - wall(b.starts_at);
    for (const start of occurrencesInRange(b.recurrence, b.starts_at, fromIso, toIso)) {
      out.push({ block: b, id: b.id, title: b.title, start, end: fmtDT(new Date(wall(start).getTime() + durMs)),
        location_id: b.location_id, areas: b.areas || [], energy: b.energy, availability: b.availability, color: b.color });
    }
  }
  return out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// Location: task constraint must allow block's location (null ⇒ free). Area: empty block.areas ⇒ all.
// energy/availability declared here; planner matches them later.
export function blockAccepts(block, task, taskAreaId) {
  if (block.location_id && !locationConstraintAllows(task && task.location, block.location_id)) return false;
  const areas = block.areas || [];
  if (areas.length && !(taskAreaId && areas.includes(taskAreaId))) return false;
  return true;
}
