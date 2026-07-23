// URL + anonKey are browser-safe; RLS is the data boundary. Privileged DB URL lives in root .env only.
export const SUPABASE = {
  url: 'https://bguoboiahqyabffhebmt.supabase.co',
  anonKey: 'sb_publishable_0Le3HpubSIss4JgjiVhd9w_FkijCawb',
};

// Deploy-time surface trim: null = full local set. `just deploy` rewrites this line for the live site.
export const SURFACES = ['plan', 'lists'];
