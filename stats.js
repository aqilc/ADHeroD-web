// Pure productivity aggregates over the activity stream. No DOM. Mirrors query.js/nlp.js.
import { effectiveGoalIds } from './store.js';
export const EXP = {
  priorityBonus: { 1: 10, 2: 8, 3: 7, 4: 6, 5: 5 },   // the completion award (p1 highest → 10, default p5 → 5)
  effortStepMin: 30, effortStepExp: 1, effortCap: 10,  // + effort bonus from est_minutes, capped into priority's range
  streakDailyBonus: 5,                                 // once per streak-qualifying day (streak ≥ 2)
  createBonus: 3,                                      // capturing a task earns a small base reward
};
const dayOf = ts => { const d = new Date(ts); const m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0'); return `${d.getFullYear()}-${m}-${dd}`; };
const live = acts => acts.filter(a => !a.void);
const addDay = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekKey = day => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }; // Monday's date
const monthKey = day => day.slice(0, 7);

export function expForComplete(ctx) {
  const p = EXP.priorityBonus[ctx?.priority] ?? EXP.priorityBonus[5];
  const eff = Math.min(EXP.effortCap, Math.floor((ctx?.est_minutes || 0) / EXP.effortStepMin) * EXP.effortStepExp);
  return p + eff;
}
export const expOf = a => (a.type === 'complete' ? expForComplete(a.ctx) : a.type === 'create' ? EXP.createBonus : 0);
export const level = exp => Math.floor(Math.sqrt(Math.max(0, exp) / 50)) + 1;   // gentle curve; tunable

export function levelProgress(exp) {
  if (exp <= 0) return { level: 1, pct: 0, toNext: 50 };
  const L = level(exp), lower = 50 * (L - 1) ** 2, upper = 50 * L ** 2;
  return { level: L, pct: Math.round((exp - lower) / (upper - lower) * 100), toNext: upper - exp };
}

const completeDays = L => new Set(L.filter(a => a.type === 'complete').map(a => dayOf(a.ts)));
// bonus only for streak ≥ 2 (previous day also in set)
const streakBonusDays = days => [...days].filter(d => days.has(addDay(d, -1)));

export function streak(acts, now) {
  const days = completeDays(live(acts));
  let longest = 0, run = 0;
  [...days].sort().forEach((d, i, arr) => { run = (i > 0 && arr[i - 1] === addDay(d, -1)) ? run + 1 : 1; longest = Math.max(longest, run); });
  let current = 0, cursor = dayOf(now);
  if (!days.has(cursor)) cursor = addDay(cursor, -1);            // today not-yet-done doesn't break the streak
  while (days.has(cursor)) { current++; cursor = addDay(cursor, -1); }
  return { current, longest };
}

export function perDay(acts, now) {
  const L = live(acts);
  if (!L.length) return [];
  const out = []; let day = L.reduce((m, a) => { const d = dayOf(a.ts); return d < m ? d : m; }, dayOf(L[0].ts)); const end = dayOf(now);
  const byDay = {};
  for (const a of L) { const k = dayOf(a.ts); (byDay[k] ||= { completed: 0, logged: 0, exp: 0 });
    if (a.type === 'complete') { byDay[k].completed++; byDay[k].exp += expOf(a); }
    if (a.type === 'create') byDay[k].logged++; }
  while (day <= end) { out.push({ day, ...(byDay[day] || { completed: 0, logged: 0, exp: 0 }) }); day = addDay(day, 1); }
  return out;
}

export function byDimension(acts, dim) {
  const m = new Map();
  for (const a of live(acts)) {
    if (a.type !== 'complete') continue;
    // area: task has 0..n areas (no "no-area" bucket); '' is meaningful for project/place only
    const keys = dim === 'project' ? [a.ctx?.project_id ?? ''] : dim === 'place' ? [a.ctx?.place ?? ''] : (a.ctx?.area_ids?.length ? a.ctx.area_ids : []);
    for (const key of keys) { const r = m.get(key) || { key, completed: 0, exp: 0 }; r.completed++; r.exp += expOf(a); m.set(key, r); }
  }
  return [...m.values()].sort((x, y) => y.completed - x.completed);
}

export function hourHistogram(acts) {
  const h = Array(24).fill(0);
  // getHours() is intentionally local wall-clock: the heatmap should reflect the user's daily rhythm
  for (const a of live(acts)) if (a.type === 'complete') h[new Date(a.ts).getHours()]++;
  return h;
}

export function postponements(acts) {
  const byTask = new Map();
  let count = 0;
  for (const a of live(acts)) if (a.type === 'postpone') { count++; byTask.set(a.subject_id, (byTask.get(a.subject_id) || 0) + 1); }
  return { count, byTask: [...byTask].map(([id, n]) => ({ id, count: n })).sort((x, y) => y.count - x.count) };
}

export function expTotals(acts, now) {
  const L = live(acts);
  const base = L.reduce((s, a) => s + expOf(a), 0);
  const days = completeDays(L);
  const bonusDays = streakBonusDays(days);
  const lifetime = base + bonusDays.length * EXP.streakDailyBonus;
  const sumPeriod = (keyFn, k) => L.reduce((s, a) => s + (keyFn(dayOf(a.ts)) === k ? expOf(a) : 0), 0)
    + bonusDays.filter(d => keyFn(d) === k).length * EXP.streakDailyBonus;
  const today = dayOf(now);
  return { lifetime, level: level(lifetime), day: sumPeriod(d => d, today), week: sumPeriod(weekKey, weekKey(today)), month: sumPeriod(monthKey, monthKey(today)) };
}

export function bestPeriods(acts, gran) {
  const keyFn = gran === 'month' ? monthKey : weekKey;
  const m = new Map();
  for (const a of live(acts)) { if (a.type !== 'complete') continue; const k = keyFn(dayOf(a.ts)); const r = m.get(k) || { key: k, completed: 0, exp: 0 }; r.completed++; r.exp += expOf(a); m.set(k, r); }
  // top-12-by-exp (statsSort re-orders this slice, not the global list)
  return [...m.values()].sort((x, y) => y.exp - x.exp).slice(0, 12);
}

const periodKeyFn = period => period === 'month' ? monthKey : period === 'week' ? weekKey : period === 'day' ? (d => d) : null;
// Fraction of the current period already elapsed at `now` (LOCAL), 0..1. null period → 0 (never "behind").
function elapsedFrac(period, now) {
  const d = new Date(now); const dayFrac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  if (period === 'day') return dayFrac;
  if (period === 'week') return (((d.getDay() + 6) % 7) + dayFrac) / 7;
  if (period === 'month') { const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return ((d.getDate() - 1) + dayFrac) / dim; }
  return 0;
}
const laddered = (acts, goalId) => live(acts).filter(a => a.type === 'complete' && (a.ctx?.goal_ids || []).includes(goalId));
function daysStreak(daySet, now) { let cur = 0, cursor = dayOf(now); if (!daySet.has(cursor)) cursor = addDay(cursor, -1); while (daySet.has(cursor)) { cur++; cursor = addDay(cursor, -1); } return cur; }

function targetProgress(rows, target, now) {
  const keyFn = periodKeyFn(target.period); const curKey = keyFn ? keyFn(dayOf(now)) : null;
  const inPeriod = a => !keyFn || keyFn(dayOf(a.ts)) === curKey;
  const current = rows.reduce((s, a) => inPeriod(a) ? s + (target.metric === 'minutes' ? (a.ctx?.est_minutes || 0) : expOf(a)) : s, 0);
  const pct = target.amount > 0 ? Math.min(1, current / target.amount) : 0;
  return { ...target, current, pct, behind: target.amount > 0 && pct < elapsedFrac(target.period, now) };
}

export function goalProgress(acts, goal, now) {
  const rows = laddered(acts, goal.id);
  const days = new Set(rows.map(a => dayOf(a.ts)));
  const weekKeyNow = weekKey(dayOf(now));
  return {
    targets: (goal.targets || []).map(t => targetProgress(rows, t, now)),
    lifetimeExp: rows.reduce((s, a) => s + expOf(a), 0),
    lifetimeMinutes: rows.reduce((s, a) => s + (a.ctx?.est_minutes || 0), 0),
    votes: rows.length,
    votesThisPeriod: rows.filter(a => weekKey(dayOf(a.ts)) === weekKeyNow).length,
    identityStreak: daysStreak(days, now),
  };
}

// ── Consistency hearth: per-goal "warmth" (framework §5b) ──
// `thriving` is a visual-layer threshold + test assertion — NOT a lifecycle stage
export const HEARTH = { ember: 8, gain: 0.25, gracePastIntervals: 1, thriving: 80 };
export const PROJ = { graceDays: 14, retainBase: 0.98, retainStep: 0.05, retainFloor: 0.5, msGain: 2 };

export function expectedIntervalDays(cadence) {
  if (!cadence || !cadence.times) return 1;
  const perWeek = cadence.per === 'day' ? cadence.times * 7 : cadence.times;
  return perWeek > 0 ? 7 / perWeek : 7;
}
// Warmth/show-ups are day-resolution, so target is "days per week" (matches onTrack = days this week); capped at 7.
const cadenceTargetPerWeek = c => Math.min(7, (!c || !c.times) ? 7 : (c.per === 'day' ? c.times * 7 : c.times));

function showUpDays(acts, goalId) { return movementDays(acts, goalId).days; }

function movementDays(acts, goalId) {
  const days = new Set(), msDays = new Set();
  for (const a of live(acts)) {
    if (a.type === 'show_up' && a.subject_id === goalId) days.add(dayOf(a.ts));
    else if (a.type === 'complete' && (a.ctx?.goal_ids || []).includes(goalId)) {
      days.add(dayOf(a.ts));
      if (a.ctx?.milestone) msDays.add(dayOf(a.ts));
    }
  }
  return { days, msDays };
}

export function firstShowUpDay(acts, goalId) {
  const days = showUpDays(acts, goalId);
  return days.size ? [...days].sort()[0] : null;
}

// ── Self-sustaining detection (v0 thresholds; Lally-2010-derived calendar floors) ──
export const SUSTAIN = { rate: 0.7, gapMult: 2, holdDays: 14 };
export function sustainMinWeeks(cadence) {
  const perWeek = cadenceTargetPerWeek(cadence);
  return perWeek >= 5 ? 9 : perWeek >= 2 ? 12 : 20;
}
const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const countLongGaps =(daysAsc, threshold) => { let n = 0; for (let i = 1; i < daysAsc.length; i++) if (diffDays(daysAsc[i - 1], daysAsc[i]) > threshold) n++; return n; };

// Anchors "weeks" to first show-up, not calendar; allDays hoisted by callers to avoid recompute.
function sustainAt(allDays, goal, end) {
  if (!goal.cadence) return false;
  const days = allDays.filter(d => d <= end).sort();
  if (!days.length) return false;
  const first = days[0];
  const elapsedWeeks = Math.floor(diffDays(first, end) / 7);
  if (elapsedWeeks < sustainMinWeeks(goal.cadence)) return false;
  const target = cadenceTargetPerWeek(goal.cadence);
  const daySet = new Set(days);
  let qualifying = 0;
  for (let i = 0; i < elapsedWeeks; i++) {
    let count = 0;
    for (let j = 0; j < 7; j++) if (daySet.has(addDay(first, i * 7 + j))) count++;
    if (count >= target) qualifying++;
  }
  if (qualifying / elapsedWeeks < SUSTAIN.rate) return false;
  const windowStart = addDay(end, -28); // fixed 4-week lookback: "did they recently fall off", independent of cadence
  const recent = days.filter(d => d >= windowStart);
  const threshold = SUSTAIN.gapMult * expectedIntervalDays(goal.cadence);
  if (diffDays(recent[recent.length - 1] ?? windowStart, end) > threshold) return false; // stale tail: silence since the last show-up counts too
  return countLongGaps(recent, threshold) <= 1;
}

// Sustained now AND held for SUSTAIN.holdDays (no flash-in-the-pan qualification).
export function sustainReady(acts, goal, now) {
  const days = [...showUpDays(acts, goal.id)];
  const end = dayOf(now);
  return sustainAt(days, goal, end) && sustainAt(days, goal, addDay(end, -SUSTAIN.holdDays));
}

// Action-crisis: kindling/burning, low warmth + ≥2 gaps > 2×interval in trailing 28d.
// Pull-based reflection signal — never a grade, never automatic.
const CRISIS_WARMTH = 35, CRISIS_WINDOW_DAYS = 28, CRISIS_MIN_GAPS = 2;
function crisisCheck(days, cadence, warmth, stage, now) {
  if (!cadence || (stage !== 'kindling' && stage !== 'burning') || warmth >= CRISIS_WARMTH) return false;
  const end = dayOf(now), windowStart = addDay(end, -CRISIS_WINDOW_DAYS);
  const recent = [...days].filter(d => d >= windowStart && d <= end).sort();
  return countLongGaps(recent, SUSTAIN.gapMult * expectedIntervalDays(cadence)) >= CRISIS_MIN_GAPS;
}
export function actionCrisis(acts, goal, now) {
  const { warmth, stage } = goalWarmth(acts, goal, now);
  return crisisCheck(showUpDays(acts, goal.id), goal.cadence, warmth, stage, now);
}

export function goalWarmth(acts, goal, now) {
  // shelved: freeze at shelved_at — ignore later activity
  if (goal.shelved_at) {
    const r = goalWarmth(acts.filter(a => a.ts <= goal.shelved_at), { ...goal, shelved_at: null }, goal.shelved_at);
    return { ...r, shelved: true, graduationReady: false, inCrisis: false };
  }
  const project = goal.shape === 'project';
  const I = project ? PROJ.graceDays : expectedIntervalDays(goal.cadence);
  const { days, msDays } = movementDays(acts, goal.id);
  const today = dayOf(now);
  const marks = []; for (let i = 13; i >= 0; i--) marks.push(days.has(addDay(today, -i)));
  const onTrack = [...days].filter(d => weekKey(d) === weekKey(today)).length;
  const target = project ? null : cadenceTargetPerWeek(goal.cadence);
  // offered, not automatic: sustained_at (user-confirmed) flips the stage
  const graduationReady = project ? false : (!goal.sustained_at && !(goal.sustain_snoozed_until && goal.sustain_snoozed_until > now) && sustainReady(acts, goal, now));
  if (!days.size) return { warmth: HEARTH.ember, stage: goal.sustained_at ? 'sustaining' : 'unlit', onTrack: 0, target, marks, graduationReady, inCrisis: false, shelved: false };
  const first = [...days].sort()[0];
  let W = HEARTH.ember, idle = 0, lit = false;
  for (let d = first; d <= today; d = addDay(d, 1)) {
    if (days.has(d)) {
      for (let k = 0; k < (project && msDays.has(d) ? PROJ.msGain : 1); k++) W += (100 - W) * HEARTH.gain;
      idle = 0; lit = true;
    } else {
      idle++;
      const overdue = idle - I * HEARTH.gracePastIntervals;
      if (overdue > 0) {
        const retain = project
          ? Math.max(PROJ.retainFloor, PROJ.retainBase - PROJ.retainStep * Math.floor(overdue / I))
          : Math.max(0.4, 0.92 - 0.10 * Math.floor(overdue / Math.max(1, I)));
        W = HEARTH.ember + (W - HEARTH.ember) * retain;
      }
    }
  }
  W = Math.max(HEARTH.ember, Math.min(100, W));
  const stage = goal.sustained_at ? 'sustaining' : (!lit ? 'unlit' : W >= 50 ? 'burning' : 'kindling');
  const warmth = Math.round(W);
  return { warmth, stage, onTrack, target, marks, graduationReady, inCrisis: crisisCheck(days, goal.cadence, warmth, stage, now), shelved: false };
}

export function homeWarmth(warmths) {
  const v = (warmths || []).filter(w => w && w.stage !== 'unlit').map(w => w.warmth);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : HEARTH.ember;
}

// ── Lifecycle lanes: tending / sustaining / fizzled / shelved + needs-you-first ordering ──
export const DORMANT_DAYS = 21;
export const PROJECT_DORMANT_DAYS = 45;

export function goalReleased(acts, goal) {
  return live(acts).some(a => a.type === 'release' && a.subject_id === goal.id);
}

// Dormant: shown up but silent past cadence threshold; not sustaining/shelved (those are resolved states).
export function goalDormant(acts, goal, now) {
  if (goal.sustained_at || goal.shelved_at) return false;
  const days = showUpDays(acts, goal.id);
  if (!days.size) return false;                                   // never lit ≠ fizzled
  // DORMANT_DAYS floor wins for current cadences (max interval 7d → 21)
  const threshold = goal.shape === 'project' ? PROJECT_DORMANT_DAYS
    : Math.max(DORMANT_DAYS, 3 * expectedIntervalDays(goal.cadence));
  return diffDays([...days].reduce((m, d) => d > m ? d : m, ''), dayOf(now)) > threshold;
}

export function goalLaneFull(acts, goal, now, w) {
  if (goal.shelved_at) return 'shelved';
  if ((w && w.stage === 'sustaining') || goal.sustained_at) return 'sustaining';
  if (goalReleased(acts, goal) || goalDormant(acts, goal, now)) return 'fizzled';
  return 'tending';
}

// Needs-you-first: in-crisis goals first, then lowest warmth first; stable tiebreak by position, then id.
export function laneComparator(a, b) {
  const wa = a._w || {}, wb = b._w || {};
  if (!!wa.inCrisis !== !!wb.inCrisis) return wa.inCrisis ? -1 : 1;
  const dw = (wa.warmth ?? 0) - (wb.warmth ?? 0);
  if (dw !== 0) return dw;
  return (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id));
}

// ── Project arc: milestone tasks (milestone: true) → done/total/next. Caller selects the tasks. ──
export function goalArc(msTasks) {
  const sorted = [...(msTasks || [])].sort((a, b) => {
    const ad = a.due_at ?? '9999', bd = b.due_at ?? '9999';
    return ad < bd ? -1 : ad > bd ? 1 : (a.position ?? 0) - (b.position ?? 0);
  });
  const done = sorted.filter(t => t.completed_at).length;
  return { done, total: sorted.length, next: sorted.find(t => !t.completed_at) ?? null, pct: sorted.length ? done / sorted.length : 0, sorted };
}
// offered, not auto-declared
export function finishReady(msTasks, goal) {
  return goal.shape === 'project' && !goal.finished_at && !goal.shelved_at && (msTasks || []).length > 0 && msTasks.every(t => t.completed_at);
}

export function globalProgress(acts, targets, now) {
  const rows = live(acts).filter(a => a.type === 'complete');
  return { targets: (targets || []).map(t => targetProgress(rows, t, now)) };
}

// Ids of incomplete tasks laddering to an active goal worth acting on now (targetless or ≥1 behind target).
export function towardGoalIds(tasks, goals, acts, now) {
  const worthy = new Set(goals.filter(g => !g.archived &&
    (!g.targets?.length || goalProgress(acts, g, now).targets.some(t => t.behind))).map(g => g.id));
  const byId = new Map(tasks.map(t => [t.id, t]));   // build once: keep the per-task walk O(depth), not O(n)
  const out = new Set();
  for (const t of tasks)
    if (!t.completed_at && effectiveGoalIds(tasks, t.id, byId).some(gid => worthy.has(gid))) out.add(t.id);
  return [...out];
}

export function compute(acts, now) {
  return {
    exp: expTotals(acts, now),
    streak: streak(acts, now),
    perDay: perDay(acts, now),
    byProject: byDimension(acts, 'project'),
    byArea: byDimension(acts, 'area'),
    byPlace: byDimension(acts, 'place'),
    hours: hourHistogram(acts),
    postpone: postponements(acts),
    best: { weeks: bestPeriods(acts, 'week'), months: bestPeriods(acts, 'month') },
  };
}
