-- Reverie Movie Jam: generated script artifact and its append-only revision
-- history. The structured script (validated JamScript JSON) is the authority;
-- each revision snapshots the live-edited markdown. Undo is a new revision
-- that records restored_from_revision — history is never rewritten, which is
-- why neither table gets an update or delete policy for revisions.

create table if not exists public.jam_scripts (
  jam_id uuid primary key references public.jams(id) on delete cascade,
  source jsonb not null,
  script jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists jam_scripts_updated_at on public.jam_scripts;
create trigger jam_scripts_updated_at
before update on public.jam_scripts
for each row execute function public.set_jam_updated_at();

create table if not exists public.jam_script_revisions (
  jam_id uuid not null references public.jam_scripts(jam_id) on delete cascade,
  revision integer not null check (revision >= 1),
  markdown text not null check (char_length(markdown) between 1 and 30000),
  author_id uuid references auth.users(id) on delete set null,
  note text check (char_length(note) <= 280),
  restored_from_revision integer check (restored_from_revision >= 1),
  created_at timestamptz not null default now(),
  primary key (jam_id, revision)
);

alter table public.jam_scripts enable row level security;
alter table public.jam_script_revisions enable row level security;

create policy "hosts create their jam script"
on public.jam_scripts for insert to authenticated
with check (
  exists (
    select 1 from public.jams
    where jams.id = jam_scripts.jam_id and jams.host_id = auth.uid()
  )
);

create policy "hosts read their jam script"
on public.jam_scripts for select to authenticated
using (
  exists (
    select 1 from public.jams
    where jams.id = jam_scripts.jam_id and jams.host_id = auth.uid()
  )
);

create policy "hosts append script revisions"
on public.jam_script_revisions for insert to authenticated
with check (
  exists (
    select 1 from public.jams
    where jams.id = jam_script_revisions.jam_id and jams.host_id = auth.uid()
  )
);

create policy "hosts read script revisions"
on public.jam_script_revisions for select to authenticated
using (
  exists (
    select 1 from public.jams
    where jams.id = jam_script_revisions.jam_id and jams.host_id = auth.uid()
  )
);

-- Member read access and Realtime publication arrive with the shared room
-- experience; do not widen these policies before membership checks exist.
