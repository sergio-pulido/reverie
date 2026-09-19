-- Reverie Movie Jam: configurable script format + per-user playback sessions.
-- Extends the initial room model: jams carry their timing format, and each
-- user can attach one session per jam whose language/ambientation skin the
-- shared script for that user only.

alter table public.jams
  add column if not exists total_seconds integer not null default 240
    check (total_seconds between 60 and 900),
  add column if not exists portion_min_seconds integer not null default 10
    check (portion_min_seconds between 4 and 60),
  add column if not exists portion_max_seconds integer not null default 20
    check (portion_max_seconds between 4 and 60);

alter table public.jams
  add constraint jams_portion_band check (portion_min_seconds <= portion_max_seconds),
  add constraint jams_portion_fits_total check (portion_max_seconds <= total_seconds);

create table if not exists public.jam_sessions (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null references public.jams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  language text not null default 'en'
    check (language ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'),
  ambientation text not null default '' check (char_length(ambientation) <= 280),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jam_id, owner_id)
);

drop trigger if exists jam_sessions_updated_at on public.jam_sessions;
create trigger jam_sessions_updated_at
before update on public.jam_sessions
for each row execute function public.set_jam_updated_at();

alter table public.jam_sessions enable row level security;

create policy "users create their own sessions"
on public.jam_sessions for insert to authenticated
with check (owner_id = auth.uid());

create policy "owners read their own sessions"
on public.jam_sessions for select to authenticated
using (owner_id = auth.uid());

create policy "owners update their own sessions"
on public.jam_sessions for update to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "owners delete their own sessions"
on public.jam_sessions for delete to authenticated
using (owner_id = auth.uid());

create policy "hosts read their room's sessions"
on public.jam_sessions for select to authenticated
using (
  exists (
    select 1 from public.jams
    where jams.id = jam_sessions.jam_id and jams.host_id = auth.uid()
  )
);
