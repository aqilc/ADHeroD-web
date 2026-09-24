// Pure predicate module — things categorization (freeze §3).
// No imports. O(1) per call given byId map; parent-chain walk O(depth), cycle-safe via seen Set.

// contract: occurrence-status integration is a later slice; isDone reads only completed_at.
export const isDone = t => !!t.completed_at;

// A thing is a note iff its parent chain tops out at a ROOT project named 'Notes'. The name IS the
// setting — no flag, no escape hatch: rename or delete that project and its whole subtree is tasks
// again. Depth cap doubles as the cycle guard (twin: pg_mail/functions/in_notes.sql).
// Case-insensitive: a user-renamed "notes"/"NOTES" root must keep noting its subtree (twin: in_notes.sql).
export const isNotesName = (c) => (c || '').trim().toLowerCase() === 'notes';
export function inNotes(t, byId) {
  let r = t;
  for (let d = 0; r?.parent_id && d < 200; d++) r = byId?.get(r.parent_id);
  return !!r && r.parent_id == null && isNotesName(r.content);
}

export const isReference = inNotes;

// Absent fields are falsy — null-safe without explicit guards. Span only: `recurrence` is the shared
// rule field (repeat engine + standing rule), so a rule alone must NOT read as placed — recurring
// errands and cadence things float (freeze §1/§4).
export const hasStanding = t => !!(t.starts_at || t.ends_at);

// contract: items = t.schedule_items or equivalent array; absent/null/empty → false.
export const hasScheduleItem = items => !!(items?.length);

export const inPool = (t, byId, scheduleItems) =>
  !isReference(t, byId) && !isDone(t) && !hasStanding(t) && !hasScheduleItem(scheduleItems);
