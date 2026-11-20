// Verbindung zu Supabase (Konten + Online-Speicher). Nur in der Website-Version.
// Der „publishable key“ ist öffentlich und darf im Browser stehen – geschützt werden
// die Daten durch die Row-Level-Security-Regeln in der Datenbank.
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://bibdouylpyvdlhpefsbi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_6UxThjLqNAOz0OoSiI2ZJw_3UVtDjc9';

let client = null;
export function sb() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'schach-anki-auth' },
    });
  }
  return client;
}
export const available = true;
