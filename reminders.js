// Pure reminder read-model — no DOM, no store. Spec: docs/superpowers/specs/2026-08-19-reminders-model-design.md
// Three jobs: which anchors a host REALLY has, what to suggest, and whether a suggestion is already covered.
import { localStamp } from './nlp.js';

const DAYPARTS = [[12, 'morning'], [17, 'afternoon'], [24, 'evening']];
const daypart = iso => DAYPARTS.find(([h]) => +iso.slice(11, 13) < h)[1];
const side = r => (r.offset_minutes || 0) > 0 ? 'after' : 'before';

// Only the time facts the task actually carries — an absent fact is never offered (grounded-options rule).
// Keys ARE the DB's `reminder_anchor` enum values — the UI's human words live in `label`, so nothing has to
// translate at the store boundary (an invented key like 'window_open' fails the enum at insert time).
// 'start' = the window opens (available_from) · 'due' = recur_from: the window's soft close, and the
// occurrence anchor on a recurring host — the same column either way, so one row, one label per case.
export const anchorsFor = t => [
  t.deadline_at && { key: 'deadline', label: 'Deadline', at: t.deadline_at },
  t.available_from && { key: 'start', label: 'Window opens', at: t.available_from },
  t.recurrence && { key: 'due', label: 'Each time it comes around', at: t.recur_from || null },
  !t.recurrence && t.recur_from && { key: 'due', label: 'Window closes', at: t.recur_from },
].filter(Boolean);

// "Similar" = would fire at roughly the same moment for roughly the same reason — never exact-match only.
export const isSimilar = (a, b) => {
  const abs = r => !r.anchor || r.anchor === 'absolute';
  if (abs(a) !== abs(b)) return false;
  if (abs(a)) return !!a.at && !!b.at && a.at.slice(0, 10) === b.at.slice(0, 10) && daypart(a.at) === daypart(b.at);
  return a.anchor === b.anchor && side(a) === side(b);
};

// When an anchored reminder fires — the server's rule (reminders_for.sql, fire_instant.sql): a timed anchor at its
// hour, a bare date at 09:00, and a window that already opened opens again today.
const ANCHOR_FACT = { deadline: 'deadline_at', start: 'available_from', due: 'recur_from' };
const fireAt = (r, t, nowAt) => {
  if (!r.anchor || r.anchor === 'absolute') return r.at || null;
  let base = t[ANCHOR_FACT[r.anchor]];
  if (!base) return null;
  if (r.anchor === 'start') base = base.slice(0, 10) > nowAt.slice(0, 10) ? base.slice(0, 10) : nowAt.slice(0, 10);
  const d = new Date(base.length > 10 ? base.slice(0, 16) : base + 'T09:00');
  d.setMinutes(d.getMinutes() + (r.offset_minutes || 0));
  return isNaN(d) ? null : localStamp(d);
};

// Grounded suggestions, capped at 3 — never a count, never a pile.
export const suggestionsFor = (t, existing = [], now = new Date()) => {
  const day = t.deadline_at ? t.deadline_at.slice(0, 10) : null, nowAt = localStamp(now), tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const all = [
    t.deadline_at && { key: 'before_deadline', label: '30m before the deadline', anchor: 'deadline', offset_minutes: -30 },
    day && !(t.deadline_at.length > 10 && t.deadline_at.slice(11, 16) < '09:00') && { key: 'morning_of', label: "the morning it's due", anchor: 'absolute', at: `${day}T09:00` },
    t.available_from && { key: 'window_open', label: 'when the window opens', anchor: 'start', offset_minutes: 0 },
    t.recurrence && { key: 'each_time', label: 'each time it comes around', anchor: 'due', offset_minutes: 0 },
    !t.deadline_at && !t.available_from && !t.recurrence && { key: 'tomorrow_morning', label: 'tomorrow morning', anchor: 'absolute', at: localStamp(tomorrow).slice(0, 10) + 'T09:00' },
  ].filter(s => s && !(fireAt(s, t, nowAt) < nowAt));   // a moment already past fires late, or the server refuses it
  return all.filter(s => !existing.some(e => isSimilar(s, e))).slice(0, 3);
};

// The composer edits the user's own sentences only — the server brain's derived rows (start/deadline_near/
// soft_slip/log_nudge/block*) are not reminders in this model and must never be shown OR reconciled away.
export const userReminders = (rows, taskId) => (rows || []).filter(r => r.kind === 'user' && r.ref_id === taskId);

export const offsetLabel = n => { const a = Math.abs(n); return !a ? 'at' : a % 1440 === 0 ? a / 1440 + 'd' : a % 60 === 0 ? a / 60 + 'h' : a + 'm'; };

// The TASK repeating is not the REMINDER repeating: only its own cadence counts.
export const isRepeating = r => !!r.repeat || (r.times || []).length > 1;
// A one-time user reminder whose floating `at` is behind local now: restored, it comes back paused so it never fires late.
export const isPassed = r => r.kind === 'user' && !isRepeating(r) && Date.parse(r.at) < Date.now();
// A repeating reminder whose `at` went by: restored, it comes back at its next time at/after now on its own cadence —
// `repeat` steps from `at` (days as calendar days), `times` is daily 'HH:MM' slots. Anything else keeps its `at`.
const STEP = { min: 6e4, hour: 36e5, day: 864e5 };
export const nextAt = (r, now = Date.now()) => {
  let d = new Date(r.at);
  if (!r.at || !isRepeating(r) || !(d < now)) return r.at;
  if (r.repeat) {
    const { every, unit } = r.repeat, step = every * STEP[unit];
    if (!Number.isInteger(every) || every < 1 || !step) return r.at;   // setDate rounds a fractional step: it would never advance
    const nth = k => { const x = new Date(r.at); unit === 'day' ? x.setDate(x.getDate() + k * every) : x.setTime(x.getTime() + k * step); return x; };   // from `at` each time: a DST-skipped day doesn't shift the rest
    for (let k = Math.floor((now - d) / step); (d = nth(k)) < now; k++);
  } else d = new Date(Math.min(...[0, 1].flatMap(k => r.times.map(t => new Date(now).setHours(24 * k + +t.slice(0, 2), +t.slice(3, 5), 0, 0))).filter(x => x >= now)));
  return isNaN(d) ? r.at : localStamp(d);   // a malformed cadence keeps its at rather than failing the restore
};

// One lead slot: a severity-shaped bell, or the repeat switch wearing the same severity weight.
const BELL = { gentle: 'i-bell', ping: 'i-bell-fill', alarm: 'i-bell-alarm' };
export const leadIcon = r => {
  const sev = r.severity || 'ping', repeating = isRepeating(r);
  return { icon: repeating ? 'i-repeat' : BELL[sev], sev, repeating };
};
