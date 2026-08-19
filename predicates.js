// Pure predicate module — things categorization (freeze §3).
// No imports. O(1) per call given byId map; parent-chain walk O(depth), cycle-safe via seen Set.

// contract: occurrence-status integration is a later slice; isDone reads only completed_at.
export const isDone = t => !!t.completed_at;

// A thing is a note iff its parent chain tops out at a ROOT project named 'Notes'. The name IS the
// setting — no flag, no escape hatch: rename or delete that project and its whole subtree is tasks
// again. Depth cap doubles as the cycle guard (twin: pg_mail/functions/in_notes.sql).
export function inNotes(t, byId) {
  let r = t;
  for (let d = 0; r?.parent_id && d < 200; d++) r = byId?.get(r.parent_id);
  return !!r && r.parent_id == null && r.content === 'Notes';
}

export const isReference = inNotes;

// Absent fields are falsy — null-safe without explicit guards. Span only: `recurrence` is the shared
// rule field (repeat engine + standing rule), so a rule alone must NOT read as placed — recurring
// errands and cadence things float (freeze §1/§4).
export const hasStanding = t => !!(t.starts_at || t.ends_at);

// claim is only meaningful on standing placements; unplaced claim is ignored (spec §2).
export const isCommitment = (t, byId) => hasStanding(t) && t.claim === 'going' && !isReference(t, byId);

export const isContext = (t, byId) => isCommitment(t, byId);

// contract: items = t.schedule_items or equivalent array; absent/null/empty → false.
export const hasScheduleItem = items => !!(items?.length);

export const inPool = (t, byId, scheduleItems) =>
  !isReference(t, byId) && !isDone(t) && !hasStanding(t) && !hasScheduleItem(scheduleItems);
