// URL + anonKey are browser-safe; RLS is the data boundary. Privileged DB URL lives in root .env only.
export const SUPABASE = {
  url: 'https://bguoboiahqyabffhebmt.supabase.co',
  anonKey: 'sb_publishable_0Le3HpubSIss4JgjiVhd9w_FkijCawb',
};

// The files Worker (scripts/files-worker.js). Null turns attaching off.
export const FILES_URL = 'https://adherod-files.aqilcm.workers.dev';

// Shipped surfaces, in order.
export const SURFACES = ['lists', 'plan', 'social'];

// Google Calendar sign-in: project adherod's web client (docs/superpowers/specs/2026-11-14-google-calendar-sync.md §Google project). A client id is public; the secret stays in the console.
export const GOOGLE = {
  clientId: '967939616143-2emguqfct7tam1qb8tu78br0563mr9qq.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/calendar',
};
