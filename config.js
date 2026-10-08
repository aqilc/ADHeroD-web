// URL + anonKey are browser-safe; RLS is the data boundary. Privileged DB URL lives in root .env only.
export const SUPABASE = {
  url: 'https://bguoboiahqyabffhebmt.supabase.co',
  anonKey: 'sb_publishable_0Le3HpubSIss4JgjiVhd9w_FkijCawb',
};

// The files Worker (scripts/files-worker.js). Null until it's deployed: attaching stays off.
export const FILES_URL = null;

// Shipped surfaces, in order.
export const SURFACES = ['lists', 'plan', 'social'];
