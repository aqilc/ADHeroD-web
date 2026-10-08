// Pure recovery logic: journal shape + sync-safe staleness. No DOM, no store, no side effects.
export const JOURNAL_MAX = 200, JOURNAL_MAX_AGE_MS = 30 * 864e5;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);   // deep-equal for field values

// Keep only the fields whose current live value still equals what we last wrote (`expect`).
// A field changed underneath (by another device or a later edit) is dropped → never clobbered.
// attachments merge by id instead: putting one file back must not undo another one added or removed since.
export function guardedFields(target, currentRow, expect) {
  const out = {};
  for (const k in target) {
    if (k === 'attachments' && k in expect && currentRow?.id) out[k] = byMember(currentRow?.[k] ?? [], target[k] ?? [], expect[k] ?? []);
    else if (!(k in expect) || eq(currentRow?.[k], expect[k])) out[k] = target[k];
  }
  return out;
}
// In target's order (a file put back returns to its place), then the ones added since.
const byMember = (cur, target, expect) => {
  const keep = new Set([...cur.filter(id => target.includes(id) || !expect.includes(id)), ...target.filter(id => !expect.includes(id))]);
  return [...target.filter(id => keep.has(id)), ...cur.filter(id => keep.has(id) && !target.includes(id))];
};

// A live row as a Bin copy, stamps and edges aside: restoring that copy over it would change nothing.
const ASIDE = new Set(['updated_at', 'created_at', 'blocked_by', 'relates']);
export const sameRow = (a, b) => { const body = r => Object.keys(r).filter(k => !ASIDE.has(k)).sort().map(k => [k, r[k]]); return eq(body(a), body(b)); };

export function nextTs(candidateIso, prevIso) {
  if (!prevIso || candidateIso > prevIso) return candidateIso;
  return new Date(new Date(prevIso).getTime() + 1).toISOString();
}

export function trashView(journal, now) {
  return journal.filter(e => e.bin && !e.restored && now - e.ts <= JOURNAL_MAX_AGE_MS)
    .slice().sort((a, b) => b.ts - a.ts);
}

// Past the count cap only unrestored Bin rows stay (the Bin promises 30 days), detached so ⌘Z can't walk into a weeks-old delete.
// own: the cap counts only this tab's entries; another tab's age out at 30 days (a busy tab must not evict another's history).
// ceiling: Bin rows (full subtree rows) and closed tabs' entries stay uncapped for 30 days and every tab re-reads them all on each
// other tab's write — read by index (tab, ts) past ~1000 entries or a ~16ms re-read.
export function pruneJournal(journal, cursor, now, own = () => true) {
  const kept = [];
  let over = journal.filter(own).length - JOURNAL_MAX, dropped = 0;   // dropped: before the cursor
  journal.forEach((e, i) => {
    const capped = own(e) && over-- > 0;   // the oldest own entries past the cap
    if (now - e.ts > JOURNAL_MAX_AGE_MS || capped && !(e.bin && !e.restored)) { if (i < cursor) dropped++; return; }
    if (capped) e.detached = true;   // in place: undo/restore hold the entry across awaits
    kept.push(e);
  });
  return { journal: kept, cursor: cursor - dropped };
}

// --- Journal store (IndexedDB): one record per entry, so a tab writes only the entries it changed, never another tab's copy. ---
// epoch (meta store): the last wipe's time, so a write from a read before it can't land after it.
let journalDb = null;
const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const committed = t => new Promise((ok, no) => { t.oncomplete = ok; t.onabort = t.onerror = () => no(t.error); });
// A blocked or unanswered open rejects (the delete is refused with its notice, never left hanging); the next call retries.
const jOpen = () => journalDb ??= new Promise((ok, no) => {
  const r = Object.assign(indexedDB.open('adherod', 1), {
    onupgradeneeded: () => { r.result.createObjectStore('journal', { keyPath: 'id' }); r.result.createObjectStore('meta'); },
    onsuccess: () => {
      r.result.onversionchange = () => r.result.close();   // another tab's upgrade or data clear isn't blocked by this one
      r.result.onclose = () => journalDb = null;   // the browser dropped it (Safari then fails its transactions instead of throwing): the next call reopens
      ok(r.result);
    },
    onerror: () => no(r.error), onblocked: () => no(new Error('blocked')),
  });
  setTimeout(() => no(new Error('timeout')), 3000);
}).catch(err => { journalDb = null; throw err; });
const tx = async mode => {
  const open = jOpen(), db = await open;
  try { return db.transaction(['journal', 'meta'], mode); }
  catch (err) {   // closed under the app (a data clear): reopen once
    if (err.name !== 'InvalidStateError') throw err;
    if (journalDb === open) journalDb = null;
    return (await jOpen()).transaction(['journal', 'meta'], mode);
  }
};
export async function jRead() {
  const t = await tx('readonly');
  const [entries, epoch] = await Promise.all([req(t.objectStore('journal').getAll()), req(t.objectStore('meta').get('epoch'))]);
  return { entries, epoch: epoch ?? 0 };
}
// false: a wipe ran since `epoch` was read, nothing written. Throws when the transaction fails.
export async function jWrite(epoch, put, del) {
  const t = await tx('readwrite'), store = t.objectStore('journal');
  if ((await req(t.objectStore('meta').get('epoch')) ?? 0) !== epoch) { t.abort(); return false; }
  for (const e of put) store.put(e);
  for (const id of del) store.delete(id);
  await committed(t);
  return true;
}
export async function jWipe() {
  const t = await tx('readwrite'), meta = t.objectStore('meta');
  t.objectStore('journal').clear();
  meta.put(Math.max((await req(meta.get('epoch')) ?? 0) + 1, Date.now()), 'epoch');   // its time: an entry stamped after it was added since
  return committed(t);
}
// The localStorage journal → records: copy, verify every one committed, only then remove the key. A failure keeps the key
// for the next boot. The shared legacy key: a record already stored is newer (written since) and stays. A tab's page-hide key
// (adherod.journal.<tab>, _journalStash) holds what it hadn't stored: it replaces the record unless that one is newer (`mt`: the tab
// lived on, or another tab changed it since) or a wipe since took it; the tab's own records it dropped go.
export async function jMigrate() {
  let ok = true;
  for (const key of Object.keys(localStorage).filter(k => /^adherod\.journal(\.|$)/.test(k))) {
    const legacy = key === 'adherod.journal';
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(key)); } catch {}   // corrupt: nothing to copy
    const entries = stored?.entries || [];
    entries.forEach((e, i) => {
      if (i >= (stored.cursor ?? Infinity)) e.undone = true;   // one cursor for every tab: past it was undone
      if (i && e.ts <= entries[i - 1].ts) e.ts = entries[i - 1].ts + 1;   // stored in order; read back by ts
    });
    const t = await tx('readwrite'), store = t.objectStore('journal');
    const [records, epoch = 0] = await Promise.all([req(store.getAll()), req(t.objectStore('meta').get('epoch'))]), have = new Map(records.map(r => [r.id, r]));
    const copy = stored?.epoch === epoch ? entries : entries.filter(e => e.ts >= epoch);   // _journalSync's wipe rule
    for (const e of copy) { const r = have.get(e.id); if (!r || !legacy && (r.mt ?? 0) <= (e.mt ?? 0)) store.put(e); }
    for (const id of legacy ? [] : stored?.dropped || []) if (have.get(id)?.tab === key.slice('adherod.journal.'.length)) store.delete(id);
    await committed(t);
    const keys = new Set(await req((await tx('readonly')).objectStore('journal').getAllKeys()));
    if (copy.every(e => keys.has(e.id))) localStorage.removeItem(key);
    else ok = false;
  }
  return ok;
}
