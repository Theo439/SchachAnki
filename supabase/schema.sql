-- Schach-Anki: Datenbank-Schema (Supabase / Postgres)
-- Jeder Nutzer sieht und ändert nur seine eigenen Daten (Row Level Security).

create table public.repertoires (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb,                       -- Repertoire als JSON (Zugbaum, Lernstand …), null bei gelöscht
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb, -- Einstellungen, Tageslimit, Sparring-Partien und Wertung
  updated_at timestamptz not null default now()
);

alter table public.repertoires enable row level security;
alter table public.user_settings enable row level security;

create policy "Eigene Repertoires lesen" on public.repertoires for select to authenticated using ((select auth.uid()) = user_id);
create policy "Eigene Repertoires anlegen" on public.repertoires for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Eigene Repertoires ändern" on public.repertoires for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Eigene Repertoires löschen" on public.repertoires for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Eigene Einstellungen lesen" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "Eigene Einstellungen anlegen" on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Eigene Einstellungen ändern" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Eigene Einstellungen löschen" on public.user_settings for delete to authenticated using ((select auth.uid()) = user_id);

alter table public.repertoires add constraint repertoire_size check (data is null or pg_column_size(data) < 2000000);
alter table public.user_settings add constraint settings_size check (pg_column_size(data) < 2000000);

grant select, insert, update, delete on public.repertoires to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
revoke all on public.repertoires from anon;
revoke all on public.user_settings from anon;
