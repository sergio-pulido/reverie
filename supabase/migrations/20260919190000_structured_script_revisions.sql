-- Reverie Movie Jam: structured script revisions and persisted playback.
-- The structured script is the editing source of truth; markdown is a
-- deterministic render and is no longer stored. Safe to run after
-- 20260919180000: that migration has not been applied to any live project
-- (docs/PROJECT_STATE.md), so jam_script_revisions is empty and the column
-- swap needs no backfill.

alter table public.jam_script_revisions drop column if exists markdown;
alter table public.jam_script_revisions add column if not exists script jsonb;
alter table public.jam_script_revisions alter column script set not null;

-- Server-owned playback state, persisted under compare-and-swap on
-- state_version. Written only by the server (service role); RLS gives hosts
-- read access and deliberately no client write policy.
create table if not exists public.jam_playback (
  jam_id uuid primary key references public.jams(id) on delete cascade,
  status text not null check (status in ('idle', 'priming', 'playing', 'finished')),
  current_portion_index integer not null check (current_portion_index >= -1),
  state_version integer not null check (state_version >= 1),
  updated_at timestamptz not null default now()
);

drop trigger if exists jam_playback_updated_at on public.jam_playback;
create trigger jam_playback_updated_at
before update on public.jam_playback
for each row execute function public.set_jam_updated_at();

alter table public.jam_playback enable row level security;

create policy "hosts read their jam playback"
on public.jam_playback for select to authenticated
using (
  exists (
    select 1 from public.jams
    where jams.id = jam_playback.jam_id and jams.host_id = auth.uid()
  )
);

-- A Supabase-backed JamStore must serialize per-jam mutations (portion
-- edits, reverts, playback CAS) — take a transaction-level lock on the
-- jam's jam_scripts row before reading the lock boundary or writing.
