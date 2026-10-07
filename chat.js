// Social chat over Supabase (pg_mail chat tables). Signed-in only; RLS scopes every read to the caller's chats.
// Store-op contract (web/CLAUDE.md): reads return rows or null, writes return the row or false; nothing throws.

const ok = ({ data, error }) => (error ? null : data);

// Chats the caller belongs to, newest activity first: { id, title, members: [{ user_id, name }], last }.
// ceiling: one last-message query per chat; batch it (a view or rpc) past ~30 chats.
export async function loadChats(sb) {
  const members = ok(await sb.from('conversation_members').select('conversation_id, user_id, name, last_read_at'));
  if (!members) return null;
  const ids = [...new Set(members.map(m => m.conversation_id))];
  const chats = await Promise.all(ids.map(async id => {
    const last = ok(await sb.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: false }).limit(1));
    return { id, members: members.filter(m => m.conversation_id === id), last: last?.[0] ?? null };
  }));
  return chats.sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? ''));
}

// ceiling: the newest 200 only; page older ones in on scroll-up once a chat outgrows it.
export async function loadMessages(sb, chatId) {
  const rows = ok(await sb.from('messages').select('*').eq('conversation_id', chatId).order('created_at', { ascending: false }).limit(200));
  return rows && rows.reverse();
}

export async function sendMessage(sb, uid, chatId, body) {
  const rows = ok(await sb.from('messages').insert({ user_id: uid, conversation_id: chatId, body }).select());
  return rows?.[0] ?? false;
}

export async function editMessage(sb, id, body) {
  const rows = ok(await sb.from('messages').update({ body, edited_at: new Date().toISOString() }).eq('id', id).select());
  return rows?.[0] ?? false;
}

// The journal's resource for target 'message' (app.js › _res): its edits, deletes and Bin restores go through here.
// RLS limits writes to the caller's own messages; a write that reaches no row is a failure, not a success.
export const messageStore = sb => ({
  async get(id) {
    const { data, error } = await sb.from('messages').select('*').eq('id', id);
    if (error) throw error;
    return data[0] ?? null;
  },
  update: async (id, fields) => !!ok(await sb.from('messages').update(fields).eq('id', id).select())?.length,
  remove: async id => !!ok(await sb.from('messages').delete().eq('id', id).select())?.length,
  // As store.reinsert: a row already stored stays as it is, and its id goes to `live` so the Bin keeps the copy.
  async reinsert(kind, rows, live = null) {
    const landed = ok(await sb.from('messages').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }).select('id'));
    if (!landed) return false;
    const ids = new Set(landed.map(r => r.id));
    for (const r of rows) if (!ids.has(r.id)) live?.add(r.id);
    return true;
  },
});

// Your name rides each of your memberships, the only rows a friend can read.
export async function setName(sb, uid, name) {
  const { error } = await sb.from('conversation_members').update({ name }).eq('user_id', uid);
  return !error;
}

// An invite link's token: one use, 14 days (schema default); redeem_invite opens the chat for whoever signs in with it.
export async function createInvite(sb, uid) {
  const rows = ok(await sb.from('invites').insert({ user_id: uid }).select());
  return rows?.[0] ?? false;
}

// Unread: the newest message is someone else's and later than your own read mark (the nav's dot, soc-1b).
export function unread(chat, uid) {
  const mine = chat.members.find(m => m.user_id === uid);
  return !!chat.last && chat.last.user_id !== uid && new Date(chat.last.created_at) > new Date(mine?.last_read_at ?? 0);
}

// The mark is the newest message's own time, not this device's clock, which may run behind the server's.
export async function markRead(sb, uid, chatId, at) {
  const rows = ok(await sb.from('conversation_members').update({ last_read_at: at }).eq('conversation_id', chatId).eq('user_id', uid).select());
  return !!rows?.length;
}

// One unfiltered subscription: RLS delivers only the caller's chats (DELETE events carry just the id).
export function watchMessages(sb, onChange) {
  return sb.channel('chat').on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, onChange).subscribe();
}

// The peer's display name in a 1:1; a member names themselves, so an unnamed one shows as "Friend".
export const peerName = (chat, uid) => chat.members.find(m => m.user_id !== uid)?.name || 'Friend';

// List timestamp: today → "2:14 PM", this week → "Sun", older → "Sep 3".
const TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat([], { weekday: 'short' });
const DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
export function whenLabel(ts, now = new Date()) {
  if (!ts) return '';
  const at = new Date(ts), days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 864e5);   // round: a DST day is 23 or 25 h
  return (days < 1 ? TIME : days < 7 ? WEEKDAY : DAY).format(at);
}
