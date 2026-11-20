// Nachbau von Supabase für automatische Tests (wird nie veröffentlicht).
const DB = 'mock-supabase-db', SES = 'mock-supabase-session', USERS = 'mock-supabase-users';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const listeners = [];
const emit = (ev, s) => listeners.forEach((f) => setTimeout(() => f(ev, s), 0));
const session = () => load(SES, null);
function query(table) {
  const uid = session()?.user?.id;
  const all = load(DB, { repertoires: [], user_settings: [] });
  const mine = () => (all[table] || []).filter((r) => r.user_id === uid);
  const q = {
    select() { return q; },
    maybeSingle() { return Promise.resolve({ data: uid ? mine()[0] || null : null, error: uid ? null : { message: 'not authenticated' } }); },
    then(res, rej) { return Promise.resolve({ data: uid ? mine() : [], error: uid ? null : { message: 'not authenticated' } }).then(res, rej); },
    upsert(rows) {
      if (!uid) return Promise.resolve({ error: { message: 'not authenticated' } });
      for (const r0 of [].concat(rows)) {
        const r = { ...r0, user_id: r0.user_id || uid };
        if (r.user_id !== uid) return Promise.resolve({ error: { message: 'RLS' } });
        const list = all[table] || (all[table] = []);
        const i = list.findIndex((x) => x.user_id === uid && (table === 'user_settings' || x.id === r.id));
        if (i >= 0) list[i] = { ...list[i], ...r }; else list.push(r);
      }
      save(DB, all);
      return Promise.resolve({ error: null });
    },
  };
  return q;
}
const client = {
  from: query,
  auth: {
    async getSession() { return { data: { session: session() } }; },
    onAuthStateChange(f) { listeners.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
    async signUp({ email, password }) {
      const users = load(USERS, {});
      if (users[email]) return { data: {}, error: { message: 'User already registered' } };
      users[email] = { id: 'u-' + Math.random().toString(36).slice(2), password }; save(USERS, users);
      const s = { user: { id: users[email].id, email } }; save(SES, s); emit('SIGNED_IN', s);
      return { data: { session: s, user: s.user }, error: null };
    },
    async signInWithPassword({ email, password }) {
      const u = load(USERS, {})[email];
      if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
      const s = { user: { id: u.id, email } }; save(SES, s); emit('SIGNED_IN', s);
      return { data: { session: s }, error: null };
    },
    async signOut() { localStorage.removeItem(SES); emit('SIGNED_OUT', null); return { error: null }; },
    async resetPasswordForEmail() { return { error: null }; },
    async updateUser() { return { error: null }; },
  },
};
export function sb() { return client; }
export const available = true;
