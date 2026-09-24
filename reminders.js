// Pure reminder read-model — no DOM, no store. Spec: docs/superpowers/specs/2026-08-19-reminders-model-design.md
// Three jobs: which anchors a host REALLY has, what to suggest, and whether a suggestion is already covered.

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

// Grounded suggestions, capped at 3 — never a count, never a pile.
export const suggestionsFor = (t, existing = []) => {
  const day = t.deadline_at ? t.deadline_at.slice(0, 10) : null;
  const all = [
    t.deadline_at && { key: 'before_deadline', label: '30m before the deadline', anchor: 'deadline', offset_minutes: -30 },
    day && { key: 'morning_of', label: "the morning it's due", anchor: 'absolute', at: `${day}T09:00` },
    t.available_from && { key: 'window_open', label: 'when the window opens', anchor: 'start', offset_minutes: 0 },
    t.recurrence && { key: 'each_time', label: 'each time it comes around', anchor: 'due', offset_minutes: 0 },
    !t.deadline_at && !t.available_from && !t.recurrence && { key: 'tomorrow_morning', label: 'tomorrow morning', anchor: 'absolute', at: null },
  ].filter(Boolean);
  return all.filter(s => !existing.some(e => isSimilar(s, e))).slice(0, 3);
};

// The composer edits the user's own sentences only — the server brain's derived rows (start/deadline_near/
// soft_slip/log_nudge/block*) are not reminders in this model and must never be shown OR reconciled away.
export const userReminders = (rows, taskId) => (rows || []).filter(r => r.kind === 'user' && r.ref_id === taskId);

// Resolve the instant this reminder actually fires at — null when its anchor is gone (visibly inert).
const ANCHOR_FACT = { deadline: 'deadline_at', start: 'available_from', due: 'recur_from' };
export const resolveFire = (r, task = {}) => {
  if (!r.anchor || r.anchor === 'absolute') return r.at || null;
  const base = task[ANCHOR_FACT[r.anchor]];
  if (!base) return null;
  const d = new Date(base.length <= 10 ? base + 'T00:00' : base);
  if (isNaN(d)) return null;
  d.setMinutes(d.getMinutes() + (r.offset_minutes || 0));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const offsetLabel = n => { const a = Math.abs(n); return !a ? 'at' : a % 1440 === 0 ? a / 1440 + 'd' : a % 60 === 0 ? a / 60 + 'h' : a + 'm'; };
const cadence = r => r.repeat ? `every ${r.repeat.every}${r.repeat.unit === 'min' ? 'm' : r.repeat.unit === 'hour' ? 'h' : 'd'}${r.repeat.until === 'done' ? ' until done' : ''}`
  : (r.times || []).length > 1 ? r.times.join(' and ') : '';
// The preview is the whole point of the editor: what will happen, in time the user can feel.
export const previewText = (r, task = {}) => {
  const iso = resolveFire(r, task);
  if (!iso) return 'the anchor is gone — nothing to fire from';
  const d = new Date(iso), when = `${MON[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const rep = cadence(r), bind = r.anchor && r.anchor !== 'absolute' ? ` · moves with the ${r.anchor.replace('_', ' ')}` : '';
  return `fires ${when}${rep ? ` · ${rep}` : ''}${bind}`;
};

// The TASK repeating is not the REMINDER repeating: only its own cadence counts.
export const isRepeating = r => !!r.repeat || (r.times || []).length > 1;

// One lead slot: a severity-shaped bell, or the repeat switch wearing the same severity weight.
const BELL = { gentle: 'i-bell', ping: 'i-bell-fill', alarm: 'i-bell-alarm' };
export const leadIcon = r => {
  const sev = r.severity || 'ping', repeating = isRepeating(r);
  return { icon: repeating ? 'i-repeat' : BELL[sev], sev, repeating };
};
