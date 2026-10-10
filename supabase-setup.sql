-- Road Game Builder — one-time database setup for accounts and cloud saves.
-- Run this in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again, and it upgrades a database set up by an earlier
-- version of this script without deleting saved cities.

-- Clean-up of the very first, save-code version of this script.
-- WARNING: this deletes any cities that were saved under save codes.
drop function if exists public.save_city(uuid, jsonb);
drop function if exists public.load_city(uuid);
drop table if exists public.city_saves;

-- Up to three cities per account, one per save slot.
create table if not exists public.cities (
  user_id uuid not null references auth.users (id) on delete cascade,
  slot smallint not null default 1,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Upgrade from the one-city-per-account version: add the slot and key rows by (account, slot).
alter table public.cities add column if not exists slot smallint not null default 1;
alter table public.cities drop constraint if exists cities_pkey;
alter table public.cities add primary key (user_id, slot);
alter table public.cities drop constraint if exists cities_slot_range;
alter table public.cities add constraint cities_slot_range check (slot between 1 and 3);
alter table public.cities drop constraint if exists cities_data_size;
alter table public.cities add constraint cities_data_size check (pg_column_size(data) < 400000);

-- Row level security: a signed-in player can read and write only their own rows.
-- Without signing in, nothing in this table is visible.
alter table public.cities enable row level security;

drop policy if exists "Players read their own city" on public.cities;
create policy "Players read their own city" on public.cities
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Players create their own city" on public.cities;
create policy "Players create their own city" on public.cities
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Players update their own city" on public.cities;
create policy "Players update their own city" on public.cities
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.cities to authenticated;

-- Make the API notice the changes straight away.
notify pgrst, 'reload schema';
