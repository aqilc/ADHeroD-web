// Pure predicate module — things categorization (freeze §3).
// No imports. O(1) per call.

// contract: occurrence-status integration is a later slice; isDone reads only completed_at.
export const isDone = t => !!t.completed_at;

// A note is the thing's own flag, never inherited (twin: pg_mail/functions/in_notes.sql).
export const inNotes = t => t?.task_type === 'note';

export const isReference = inNotes;

// Absent fields are falsy — null-safe without explicit guards. Span only: `recurrence` is the shared
// rule field (repeat engine + standing rule), so a rule alone must NOT read as placed — recurring
// errands and cadence things float (freeze §1/§4).
export const hasStanding = t => !!(t.starts_at || t.ends_at);

// contract: items = t.schedule_items or equivalent array; absent/null/empty → false.
export const hasScheduleItem = items => !!(items?.length);

export const inPool = (t, byId, scheduleItems) =>
  !isReference(t, byId) && !isDone(t) && !hasStanding(t) && !hasScheduleItem(scheduleItems);
