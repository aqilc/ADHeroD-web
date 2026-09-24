// Import: .ics calendars and pasted `{"adherod":1}` task payloads. Pure — no DOM, no store.
// Both paths end in the SAME shape: { items, problems }. A payload with ANY problem imports NOTHING;
// the caller renders `problems` and refuses. Guessing at a malformed import is worse than refusing it.

// ─── shared ────────────────────────────────────────────────────────────────────────────────────────
const p2 = n => String(n).padStart(2, '0');
// Round-trip, not just Date.parse: "2026-02-31" parses fine and silently rolls over to March 3.
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const problem = (path, message) => ({ path, message });

// ─── .ics ──────────────────────────────────────────────────────────────────────────────────────────
// RFC5545 line unfolding: a leading space/tab continues the previous line.
const unfold = text => text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
// "NAME;PARAM=V:value" → [name, params, value]. Only the FIRST colon separates; values contain colons.
function icsLine(line) {
  const c = line.indexOf(':');
  if (c < 0) return null;
  const head = line.slice(0, c).split(';'), params = {};
  for (const p of head.slice(1)) { const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1); }
  return [head[0].toUpperCase(), params, line.slice(c + 1)];
}
const icsUnescape = s => s.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1');
const icsDigits = v => v.replace(/[^0-9TZ]/g, '');

// A DATE/DATE-TIME → { iso, allDay }. Wall-clock local text is what the whole app stores, so a `Z` or
// TZID value is converted to local here — a full ISO reaching the calendar blanks it (calendar.js:33).
function icsWhen(value, params) {
  const v = icsDigits(value);
  if (params.VALUE === 'DATE' || !v.includes('T')) return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, allDay: true };
  const [d, t] = v.split('T');
  const parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), t.slice(0, 2), t.slice(2, 4)].map(Number);
  if (!t.endsWith('Z') && !params.TZID) return { iso: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}`, allDay: false };
  // Both Z and TZID resolve to an absolute instant, then render in the machine's local zone.
  const utc = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  const at = new Date(t.endsWith('Z') ? utc : utc - tzOffsetAt(params.TZID, utc));
  return { iso: `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())}T${p2(at.getHours())}:${p2(at.getMinutes())}`, allDay: false };
}
// Offset (ms) of a named zone at an instant — Intl is the platform's own tz database, no VTIMEZONE parsing.
function tzOffsetAt(tzid, utcMs) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tzid, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const o = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
    return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - utcMs;
  } catch { return 0; }   // unknown TZID → treat as floating local, matching the no-TZID branch
}
// PT1H30M / P1D / P2W → minutes.
function icsDuration(s) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const [, w, d, h, mi, sec] = m.map(x => (x == null ? 0 : +x));
  return w * 10080 + d * 1440 + h * 60 + mi + Math.round(sec / 60);
}
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQ = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
// RRULE → the app's rule shape, or a problem naming what can't be represented. Never approximates:
// an approximated rule produces a calendar that is wrong in a way you only notice weeks later.
export function ruleFromRRULE(text, path) {
  const parts = Object.fromEntries(text.split(';').filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i).toUpperCase(), p.slice(i + 1)]; }));
  const bad = k => problem(path, `${k} isn't representable — the app's repeat model has no equivalent, and approximating it would silently create the wrong dates.`);
  for (const k of ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY']) if (parts[k]) return { problem: bad(k) };
  const freq = FREQ[parts.FREQ];
  if (!freq) return { problem: parts.FREQ ? bad(`FREQ=${parts.FREQ}`) : problem(path, 'RRULE has no FREQ.') };
  const r = { freq, interval: parts.INTERVAL ? +parts.INTERVAL : 1, from_completion: false, ends: null, done_count: 0 };
  if (!(r.interval >= 1)) return { problem: problem(path, `INTERVAL=${parts.INTERVAL} is not a positive number.`) };

  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',').map(s => s.trim());
    const ord = days.map(d => /^(-?\d+)/.exec(d)).filter(Boolean);
    if (ord.length && days.length > 1) return { problem: problem(path, 'BYDAY mixes an ordinal with several weekdays — the app can express one ordinal weekday per month, not a set.') };
    if (ord.length) {
      if (freq !== 'month') return { problem: bad(`an ordinal BYDAY under FREQ=${parts.FREQ}`) };
      r.nth = +ord[0][1];
      r.weekdays = [WD.indexOf(days[0].replace(/^-?\d+/, ''))];
    } else r.weekdays = days.map(d => WD.indexOf(d)).sort((a, b) => a - b);
    if (r.weekdays.includes(-1)) return { problem: problem(path, `BYDAY=${parts.BYDAY} names a weekday that isn't MO-SU.`) };
  }
  if (parts.BYMONTHDAY) {
    const md = parts.BYMONTHDAY.split(',').map(Number);
    if (md.some(n => !(n >= 1 && n <= 31))) return { problem: bad('a negative or out-of-range BYMONTHDAY') };
    r.month_day = md.length === 1 ? md[0] : md.sort((a, b) => a - b);
  }
  if (parts.BYMONTH) r.months = parts.BYMONTH.split(',').map(Number).sort((a, b) => a - b);
  if (parts.COUNT) r.ends = { count: +parts.COUNT };
  // UNTIL is a DATE boundary compared against plain date strings, so read its digits directly. Converting
  // its instant to local shifts the last day by one in any negative-offset zone (green under TZ=UTC, red at
  // 20:00 EDT) — the same two-clocks trap the suite warns about.
  else if (parts.UNTIL) { const u = icsDigits(parts.UNTIL); r.ends = { date: `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` }; }
  return { rule: r };
}

// Parse a calendar into { items, problems }. Multiple VEVENTs; VALARM blocks are skipped outright so an
// alarm's own DURATION/TRIGGER can't be read as the event's.
export function parseICS(text) {
  const items = [], problems = [];
  const lines = unfold(String(text)).split('\n');
  let cur = null, depth = 0, idx = 0;
  for (const raw of lines) {
    const parsed = icsLine(raw.trim());
    if (!parsed) continue;
    const [name, params, value] = parsed;
    if (name === 'BEGIN' && value === 'VEVENT') { cur = { rrule: [], exdates: [], idx: idx++ }; depth = 0; continue; }
    if (!cur) continue;
    if (name === 'BEGIN') { depth++; continue; }              // VALARM (or any nested component)
    if (name === 'END' && depth > 0) { depth--; continue; }
    if (depth > 0) continue;                                   // inside VALARM — not the event's properties
    if (name === 'END' && value === 'VEVENT') { finishEvent(cur, items, problems); cur = null; continue; }
    if (name === 'DTSTART') cur.start = icsWhen(value, params);
    else if (name === 'DTEND') cur.end = icsWhen(value, params);
    else if (name === 'DURATION') cur.durMin = icsDuration(value);
    else if (name === 'SUMMARY') cur.title = icsUnescape(value);
    else if (name === 'UID') cur.uid = value;
    else if (name === 'RRULE') cur.rrule.push(value);
    else if (name === 'EXDATE') cur.exdates.push(...value.split(',').map(v => icsWhen(v, params).iso.slice(0, 10)));
    else if (name === 'RDATE') cur.rdate = true;
    else if (name === 'RECURRENCE-ID') cur.recurrenceId = icsWhen(value, params).iso;
    else if (name === 'SEQUENCE') cur.seq = +value;
    else if (name === 'LAST-MODIFIED') cur.modified = icsDigits(value);
  }
  return { items, problems };
}

function finishEvent(e, items, problems) {
  const path = `event ${e.idx + 1}${e.title ? ` (${e.title})` : ''}`;
  if (!e.start) return problems.push(problem(path, 'has no DTSTART, so there is no date to put it on.'));
  if (e.rdate) return problems.push(problem(path, 'uses RDATE (extra one-off dates bolted onto a series), which the repeat model cannot represent.'));
  if (e.rrule.length > 1) return problems.push(problem(path, 'has more than one RRULE. An event holds a single repeat rule; two would render as one.'));

  let ends = e.end ? e.end.iso : (e.durMin != null ? shift(e.start, e.durMin) : null);
  // An all-day end is EXCLUSIVE in ICS but INCLUSIVE here — via DTEND *or* DURATION, so a one-day
  // event stays one day instead of spilling into tomorrow. Never let it land before the start.
  if (ends && e.start.allDay) ends = maxIso(addDaysIso(ends.slice(0, 10), -1), e.start.iso);
  const item = { kind: 'event', title: e.title || 'Untitled', starts_at: e.start.iso, ends_at: ends ?? e.start.iso, all_day: e.start.allDay, external_id: e.uid ?? null, seq: e.seq ?? null, modified: e.modified ?? null };

  if (e.rrule.length) {
    const { rule, problem: p } = ruleFromRRULE(e.rrule[0], path);
    if (p) return problems.push(p);
    if (e.exdates.length) rule.exdates = e.exdates;
    item.recurrence = rule;
  } else if (e.exdates.length) return problems.push(problem(path, 'has EXDATE but no RRULE — there is no series for it to subtract from.'));
  // A RECURRENCE-ID event IS the moved occurrence: it imports as a standalone event, and the series it was
  // lifted out of carries the matching EXDATE. Nothing to represent beyond flagging it for the caller.
  if (e.recurrenceId) item.detached_from = e.recurrenceId;
  items.push(item);
}
const maxIso = (a, b) => (a >= b ? a : b);
const shift = (start, mins) => {
  if (start.allDay) return addDaysIso(start.iso, Math.round(mins / 1440));
  const d = new Date(start.iso + ':00Z'); d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 16);
};

// Should an incoming VEVENT overwrite the row already imported under the same UID? Only on a HIGHER
// SEQUENCE — re-dropping an older export must never roll newer data back, and re-dropping the SAME file
// must not clobber edits made since. Equal or absent sequences therefore mean "leave it alone".
// ceiling: SEQUENCE only. Publishers that bump LAST-MODIFIED without SEQUENCE won't refresh; storing a
// second column is the fix if that shows up in a real export.
export const icsReplaces = (existingSeq, incomingSeq) => (incomingSeq ?? 0) > (existingSeq ?? 0);

// ─── pasted task payload ───────────────────────────────────────────────────────────────────────────
export const IMPORTANCE = ['must', 'focus', 'none', 'someday'];
const SEVERITY = ['gentle', 'ping', 'alarm'];
const LOC_MODE = ['any', 'only', 'except'];
const ANCHOR = ['deadline', 'start', 'due'];
const MAX_DEPTH = 4;

const TOP_KEYS = ['adherod', 'lists', 'areas', 'tasks'];
const TASK_KEYS = ['id', 'title', 'notes', 'importance', 'minutes', 'list', 'areas', 'checklist', 'subtasks',
  'on', 'window_from', 'deadline', 'repeat', 'reminders', 'location', 'needs', 'relates'];
const REPEAT_KEYS = ['freq', 'interval', 'weekdays', 'month_day', 'nth', 'months', 'count', 'until', 'exdates'];
const REMINDER_KEYS = ['anchor', 'at', 'offset', 'severity'];

// Unknown keys are the hallucination canary: a model that invents "priority" must fail loudly, because a
// silently dropped field is a task that looks right and isn't.
const unknown = (obj, allowed, path, problems) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(problem(`${path}.${k}`, `unknown field "${k}". Allowed here: ${allowed.join(', ')}.`));
};
const oneOf = (v, list, path, label, problems) => {
  if (v == null) return true;
  if (!list.includes(v)) { problems.push(problem(path, `${label} must be one of ${list.join(', ')} — got ${JSON.stringify(v)}.`)); return false; }
  return true;
};

// Detect the payload without parsing the world: only a JSON object carrying the sentinel qualifies, so an
// ordinary paste can never trip the importer.
export function looksLikePayload(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return t.startsWith('{') && /"adherod"\s*:/.test(t);
}

export function parsePayload(text, { lists = [], areas = [], places = [], today } = {}) {
  const problems = [], t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let doc;
  try { doc = JSON.parse(t); } catch (e) { return { items: [], problems: [problem('(document)', `not valid JSON — ${e.message}`)] }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { items: [], problems: [problem('(document)', 'the top level must be a JSON object.')] };
  if (doc.adherod !== 1) return { items: [], problems: [problem('adherod', `expected "adherod": 1 — got ${JSON.stringify(doc.adherod)}.`)] };
  unknown(doc, TOP_KEYS, '(document)', problems);
  if (!Array.isArray(doc.tasks) || !doc.tasks.length) problems.push(problem('tasks', 'must be a non-empty array of tasks.'));

  const declaredLists = strList(doc.lists, 'lists', problems), declaredAreas = strList(doc.areas, 'areas', problems);
  const knownLists = new Set([...lists, ...declaredLists].map(low)), knownAreas = new Set([...areas, ...declaredAreas].map(low));
  const knownPlaces = new Set(places.map(low));
  const ids = new Map(), items = [];

  const walk = (raw, path, depth, parentRef) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(problem(path, 'each task must be an object.')); return; }
    unknown(raw, TASK_KEYS, path, problems);
    if (typeof raw.title !== 'string' || !raw.title.trim()) problems.push(problem(`${path}.title`, 'is required and must be a non-empty string.'));
    if (depth > MAX_DEPTH) problems.push(problem(path, `is nested ${depth} deep; the app allows ${MAX_DEPTH} levels.`));

    const item = { kind: 'task', ref: raw.id ?? null, depth, parentRef, content: String(raw.title ?? '').trim(), fields: {}, needs: [], relates: [] };
    if (raw.id != null) {
      if (typeof raw.id !== 'string') problems.push(problem(`${path}.id`, 'must be a string.'));
      else if (ids.has(raw.id)) problems.push(problem(`${path}.id`, `duplicate id "${raw.id}" — ids must be unique within the payload.`));
      else ids.set(raw.id, item);
    }
    if (raw.notes != null) { if (typeof raw.notes !== 'string') problems.push(problem(`${path}.notes`, 'must be a string.')); else item.fields.notes = raw.notes; }
    if (oneOf(raw.importance, IMPORTANCE, `${path}.importance`, 'importance', problems) && raw.importance != null) item.fields.importance = raw.importance;
    if (raw.minutes != null) {
      if (!Number.isInteger(raw.minutes) || raw.minutes < 0) problems.push(problem(`${path}.minutes`, 'must be a whole number of minutes, 0 or more.'));
      else item.fields.est_minutes = raw.minutes || null;
    }
    if (raw.list != null) {
      if (typeof raw.list !== 'string') problems.push(problem(`${path}.list`, 'must be a string.'));
      else if (!knownLists.has(low(raw.list))) problems.push(problem(`${path}.list`, `no list named "${raw.list}". Add it to the top-level "lists" array to create it, or use one that exists.`));
      else item.listName = raw.list;
    }
    if (raw.areas != null) for (const [i, a] of enumerate(raw.areas, `${path}.areas`, problems)) {
      if (!knownAreas.has(low(a))) problems.push(problem(`${path}.areas[${i}]`, `no area named "${a}". Add it to the top-level "areas" array to create it.`));
      else (item.areaNames ??= []).push(a);
    }
    if (raw.checklist != null) item.fields.checklist = [...enumerate(raw.checklist, `${path}.checklist`, problems)].map(([, s]) => ({ text: s, done: false }));
    for (const [key, col] of [['window_from', 'available_from'], ['deadline', 'deadline_at']]) {
      if (raw[key] == null) continue;
      if (!isDate(raw[key])) problems.push(problem(`${path}.${key}`, `must be a date as YYYY-MM-DD — got ${JSON.stringify(raw[key])}. Dates are always explicit; the importer never guesses one from words.`));
      else item.fields[col] = raw[key];
    }
    if (item.fields.available_from && item.fields.deadline_at && item.fields.deadline_at < item.fields.available_from)
      problems.push(problem(`${path}.deadline`, `is before window_from (${item.fields.deadline_at} < ${item.fields.available_from}).`));
    if (raw.on != null) item.on = readOn(raw.on, `${path}.on`, problems);
    if (raw.location != null) item.fields.location = readLocation(raw.location, `${path}.location`, knownPlaces, problems);
    if (raw.repeat != null) { const r = readRepeat(raw.repeat, `${path}.repeat`, problems); if (r) item.fields.recurrence = r; }
    if (raw.reminders != null) item.reminders = readReminders(raw.reminders, `${path}.reminders`, today, problems);
    for (const key of ['needs', 'relates']) if (raw[key] != null) item[key] = [...enumerate(raw[key], `${path}.${key}`, problems)].map(([, s]) => s);

    items.push(item);
    if (raw.subtasks != null) for (const [i, sub] of (Array.isArray(raw.subtasks) ? raw.subtasks : []).entries()) walk(sub, `${path}.subtasks[${i}]`, depth + 1, raw.id ?? null);
    if (raw.subtasks != null && !Array.isArray(raw.subtasks)) problems.push(problem(`${path}.subtasks`, 'must be an array.'));
  };
  for (const [i, raw] of (Array.isArray(doc.tasks) ? doc.tasks : []).entries()) walk(raw, `tasks[${i}]`, 1, null);

  // Relations resolve against payload-local ids only — a reference to a task that isn't here is a
  // hallucinated link, and nothing downstream (client or Postgres) prevents a needs-cycle.
  for (const it of items) for (const key of ['needs', 'relates'])
    for (const ref of it[key]) if (!ids.has(ref)) problems.push(problem(`${label(it)}.${key}`, `refers to id "${ref}", which no task in this payload declares.`));
  for (const cyc of cycles(items, ids)) problems.push(problem(label(cyc[0]), `these tasks need each other in a loop: ${cyc.map(c => c.content).join(' → ')} → ${cyc[0].content}. Nothing could ever be started.`));

  return { items, problems };
};

const low = s => String(s).trim().toLowerCase();
const label = it => it.ref ? `task "${it.ref}"` : `task "${it.content}"`;
function* enumerate(v, path, problems) {
  if (!Array.isArray(v)) { problems.push(problem(path, 'must be an array of strings.')); return; }
  for (const [i, s] of v.entries()) {
    if (typeof s !== 'string' || !s.trim()) { problems.push(problem(`${path}[${i}]`, 'must be a non-empty string.')); continue; }
    yield [i, s.trim()];
  }
}
const strList = (v, path, problems) => v == null ? [] : [...enumerate(v, path, problems)].map(([, s]) => s);

function readOn(v, path, problems) {
  if (typeof v === 'string') { if (!isDate(v)) { problems.push(problem(path, `must be a date as YYYY-MM-DD — got ${JSON.stringify(v)}.`)); return null; } return { date: v, time: null }; }
  if (!v || typeof v !== 'object') { problems.push(problem(path, 'must be a date string or { date, time }.')); return null; }
  unknown(v, ['date', 'time'], path, problems);
  if (!isDate(v.date)) { problems.push(problem(`${path}.date`, `must be a date as YYYY-MM-DD — got ${JSON.stringify(v.date)}.`)); return null; }
  if (v.time != null && !isTime(v.time)) { problems.push(problem(`${path}.time`, `must be a 24-hour time as HH:MM — got ${JSON.stringify(v.time)}.`)); return null; }
  return { date: v.date, time: v.time ?? null };
}

function readLocation(v, path, knownPlaces, problems) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(problem(path, 'must be an object like { "mode": "only", "places": ["Home"] }.')); return null; }
  unknown(v, ['mode', 'places'], path, problems);
  if (!oneOf(v.mode, LOC_MODE, `${path}.mode`, 'mode', problems)) return null;
  const names = [...enumerate(v.places ?? [], `${path}.places`, problems)].map(([, s]) => s);
  for (const [i, n] of names.entries()) if (!knownPlaces.has(low(n))) problems.push(problem(`${path}.places[${i}]`, `no place named "${n}". Places can't be created by an import — add it in the app first.`));
  return { mode: v.mode ?? 'any', names };
}

function readRepeat(v, path, problems) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(problem(path, 'must be an object like { "freq": "week", "weekdays": [1,3] }.')); return null; }
  unknown(v, REPEAT_KEYS, path, problems);
  if (!oneOf(v.freq, ['day', 'week', 'month', 'year'], `${path}.freq`, 'freq', problems)) return null;
  if (v.freq == null) { problems.push(problem(`${path}.freq`, 'is required for a repeat.')); return null; }
  const r = { freq: v.freq, interval: v.interval ?? 1, from_completion: false, ends: null, done_count: 0 };
  if (!Number.isInteger(r.interval) || r.interval < 1) { problems.push(problem(`${path}.interval`, 'must be a whole number 1 or greater.')); return null; }
  if (v.weekdays != null) {
    if (!Array.isArray(v.weekdays) || !v.weekdays.every(n => Number.isInteger(n) && n >= 0 && n <= 6)) { problems.push(problem(`${path}.weekdays`, 'must be an array of day numbers 0-6, where 0 is Sunday.')); return null; }
    r.weekdays = [...v.weekdays].sort((a, b) => a - b);
  }
  if (v.nth != null) {
    if (!Number.isInteger(v.nth) || v.nth === 0 || v.nth > 5 || v.nth < -1) { problems.push(problem(`${path}.nth`, 'must be 1-5, or -1 for the last one in the month.')); return null; }
    if (v.freq !== 'month' || !r.weekdays?.length) { problems.push(problem(`${path}.nth`, 'only means something with "freq": "month" and exactly one weekday (e.g. the 3rd Thursday).')); return null; }
    r.nth = v.nth;
  }
  if (v.month_day != null) {
    const md = Array.isArray(v.month_day) ? v.month_day : [v.month_day];
    if (!md.every(n => Number.isInteger(n) && n >= 1 && n <= 31)) { problems.push(problem(`${path}.month_day`, 'must be a day of the month 1-31, or an array of them.')); return null; }
    r.month_day = md.length === 1 ? md[0] : md.sort((a, b) => a - b);
  }
  if (v.months != null) {
    if (!Array.isArray(v.months) || !v.months.every(n => Number.isInteger(n) && n >= 1 && n <= 12)) { problems.push(problem(`${path}.months`, 'must be an array of month numbers 1-12.')); return null; }
    r.months = [...v.months].sort((a, b) => a - b);
  }
  if (v.count != null && v.until != null) { problems.push(problem(path, 'has both "count" and "until" — a repeat ends one way or the other, not both.')); return null; }
  if (v.count != null) { if (!Number.isInteger(v.count) || v.count < 1) { problems.push(problem(`${path}.count`, 'must be a whole number 1 or greater.')); return null; } r.ends = { count: v.count }; }
  if (v.until != null) { if (!isDate(v.until)) { problems.push(problem(`${path}.until`, `must be a date as YYYY-MM-DD — got ${JSON.stringify(v.until)}.`)); return null; } r.ends = { date: v.until }; }
  if (v.exdates != null) { const ex = [...enumerate(v.exdates, `${path}.exdates`, problems)].map(([, s]) => s); if (ex.some(s => !isDate(s))) { problems.push(problem(`${path}.exdates`, 'must all be dates as YYYY-MM-DD.')); return null; } if (ex.length) r.exdates = ex; }
  return r;
}

function readReminders(v, path, today, problems) {
  const out = [];
  if (!Array.isArray(v)) { problems.push(problem(path, 'must be an array.')); return out; }
  for (const [i, r] of v.entries()) {
    const p = `${path}[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { problems.push(problem(p, 'must be an object.')); continue; }
    unknown(r, REMINDER_KEYS, p, problems);
    if (!oneOf(r.severity, SEVERITY, `${p}.severity`, 'severity', problems)) continue;
    if (r.anchor != null && r.at != null) { problems.push(problem(p, 'has both "anchor" and "at" — a reminder hangs off a date the task already has, or off an absolute one, not both.')); continue; }
    if (r.anchor != null) {
      if (!oneOf(r.anchor, ANCHOR, `${p}.anchor`, 'anchor', problems)) continue;
      if (r.offset != null && !Number.isInteger(r.offset)) { problems.push(problem(`${p}.offset`, 'must be a whole number of minutes — negative for before, positive for after.')); continue; }
      out.push({ anchor: r.anchor, offset_minutes: r.offset ?? 0, severity: r.severity ?? 'ping' });
    } else if (r.at != null) {
      const at = String(r.at);
      if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(at)) { problems.push(problem(`${p}.at`, `must be an exact moment as YYYY-MM-DDTHH:MM — got ${JSON.stringify(r.at)}.`)); continue; }
      // The database refuses a reminder in the past, so catching it here beats a failed insert mid-import.
      if (today && at.slice(0, 10) < today) { problems.push(problem(`${p}.at`, `is in the past (${at}). A reminder can only be set for the future.`)); continue; }
      out.push({ anchor: 'absolute', at, severity: r.severity ?? 'ping' });
    } else problems.push(problem(p, 'needs either "anchor" (deadline/start/due) or "at" (an exact moment).'));
  }
  return out;
}

// ─── the prompt you hand to an assistant ───────────────────────────────────────────────────────────
// Generated, not canned: it carries TODAY and the user's real lists/areas/places, so the model writes
// #their-list instead of inventing one — the difference between a payload that validates and one that
// bounces. The worked example below is asserted against parsePayload in the tests: if the format ever
// drifts from the validator, the prompt's own example stops validating and the suite says so.
export const PROMPT_EXAMPLE = {
  adherod: 1,
  lists: ['Thermodynamics'],
  tasks: [
    { id: 't1', title: 'Read chapter 3', list: 'Thermodynamics', importance: 'focus', minutes: 45,
      on: { date: '2026-08-27', time: '18:00' }, checklist: ['Skim the summary', 'Work examples 3.1-3.6'] },
    { id: 't2', title: 'Problem set 3', list: 'Thermodynamics', deadline: '2026-08-31', needs: ['t1'],
      reminders: [{ anchor: 'deadline', offset: -1440, severity: 'ping' }] },
  ],
};
const bullet = (label, xs) => `${label}: ${xs.length ? xs.map(x => `"${x}"`).join(', ') : '(none yet)'}`;
export function importPrompt({ lists = [], areas = [], places = [], today = '' } = {}) {
  return `You are helping me turn my material into tasks for my task app.

Read what I give you next and reply with ONE fenced JSON block in the format below — nothing else, no commentary before or after. I paste your reply straight into the app, which validates it strictly and REFUSES the whole thing if anything is off, so precision matters more than coverage: leave a field out rather than guessing at it.

Today is ${today}. Work out every date yourself and write it as YYYY-MM-DD; the app does not read words like "next Friday". Times are 24-hour HH:MM.

My existing ${bullet('lists', lists)}
My existing ${bullet('areas', areas)}
My existing ${bullet('places', places)}
Use those names exactly when they fit. To put tasks in a NEW list, add its name to the top-level "lists" array — that is what tells the app to create it. Areas work the same way via "areas". Places CANNOT be created; only use one that already exists.

Rules the validator enforces:
- Every field name must be one of the ones listed below. An unrecognised field fails the whole import, so never invent one.
- "title" is required. Everything else is optional.
- "importance" is one of: must, focus, none, someday.
- "minutes" is a whole number (how long the task takes).
- "on" is when I plan to DO it: { "date": "YYYY-MM-DD", "time": "HH:MM" } (time optional). "deadline" is a hard due date; "window_from" is the earliest it can start. Do not invent a deadline that my material does not actually state.
- "subtasks" nests tasks (4 levels deep at most). "checklist" is a flat list of strings for trivial steps.
- "needs" lists the "id"s of tasks that must be done first — ids are yours to make up, they only have to be unique inside this block, and they must refer to tasks in this same block. Dependencies must not form a loop.
- "repeat" is { "freq": "day"|"week"|"month"|"year", "interval": 1, ... } with optional "weekdays" (0=Sunday..6), "month_day", "nth" (1-5 or -1 for last, with "freq":"month" and a single weekday, e.g. the 3rd Thursday), "months" (1-12), and one ending: "count" OR "until".
- "reminders" is a list of either { "anchor": "deadline"|"start"|"due", "offset": minutes-before-as-a-negative-number } or { "at": "YYYY-MM-DDTHH:MM" } for an exact moment, each optionally with "severity": "gentle"|"ping"|"alarm". An "at" must be in the future.
- "location" is { "mode": "only"|"except", "places": ["..."] }.

Full example:

\`\`\`json
${JSON.stringify(PROMPT_EXAMPLE, null, 2)}
\`\`\`

If my material does not support a field, omit it. Do not pad the list with tasks I did not ask for. Here is my material:`;
}

// Every simple cycle in the needs-graph, so the message can name the actual loop rather than "a cycle exists".
function cycles(items, ids) {
  const found = [], seen = new Set();
  const visit = (it, stack) => {
    const at = stack.indexOf(it);
    if (at >= 0) { const loop = stack.slice(at), key = [...loop].map(x => x.ref).sort().join('|'); if (!seen.has(key)) { seen.add(key); found.push(loop); } return; }
    stack.push(it);
    for (const ref of it.needs) { const next = ids.get(ref); if (next) visit(next, stack); }
    stack.pop();
  };
  for (const it of items) visit(it, []);
  return found;
}
