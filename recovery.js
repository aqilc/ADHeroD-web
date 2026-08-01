// Pure recovery logic: journal shape + sync-safe staleness. No DOM, no store, no side effects.
export const JOURNAL_MAX = 200, JOURNAL_MAX_AGE_MS = 30 * 864e5;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);   // deep-equal for field values

// Keep only the fields whose current live value still equals what we last wrote (`expect`).
// A field changed underneath (by another device or a later edit) is dropped → never clobbered.
export function guardedFields(target, currentRow, expect) {
  const out = {};
  for (const k in target) if (!(k in expect) || eq(currentRow?.[k], expect[k])) out[k] = target[k];
  return out;
}

export function nextTs(candidateIso, prevIso) {
  if (!prevIso || candidateIso > prevIso) return candidateIso;
  return new Date(new Date(prevIso).getTime() + 1).toISOString();
}

export function trashView(journal, now) {
  return journal.filter(e => e.bin && !e.restored && now - e.ts <= JOURNAL_MAX_AGE_MS)
    .slice().sort((a, b) => b.ts - a.ts);
}

export function pruneJournal(journal, cursor, now) {
  let drop = 0;
  while (drop < journal.length && now - journal[drop].ts > JOURNAL_MAX_AGE_MS) drop++;
  if (journal.length - drop > JOURNAL_MAX) drop = journal.length - JOURNAL_MAX;   // hard cap too
  return { journal: journal.slice(drop), cursor: Math.max(0, cursor - drop) };
}
