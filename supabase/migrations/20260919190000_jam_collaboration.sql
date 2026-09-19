-- Reverie Movie Jam: durable chat and proposals plus Realtime authorization.
-- Apply after 20260919180000_jam_scripts.sql.
--
-- Authority model: Postgres rows under RLS are the durable truth. Postgres Changes
-- notifies clients about those rows. Presence reports who is connected right now and
-- Broadcast is never authorization or durable story state.

-- 1. Durable collaborative tables ---------------------------------------------
-- author_id defaults to auth.uid() and the insert policy pins it there, so an author
-- identity always comes from Auth and can never be supplied by the browser.

create table if not exists public.jam_messages (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null references public.jams(id) on delete cascade,
  author_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists jam_messages_jam_created_idx
  on public.jam_messages (jam_id, created_at, id);

create table if not exists public.jam_proposals (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null references public.jams(id) on delete cascade,
  author_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 280),
  status text not null default 'queued'
    check (status in ('queued', 'accepted', 'rejected', 'superseded')),
  created_at timestamptz not null default now()
);

create index if not exists jam_proposals_jam_created_idx
  on public.jam_proposals (jam_id, created_at, id);

alter table public.jam_messages enable row level security;
alter table public.jam_proposals enable row level security;

-- 2. Policies -----------------------------------------------------------------
-- Only an active member reads or writes. A waiting, left or removed participant is
-- refused by the same predicate that gates the Realtime channel below.

drop policy if exists "active members read jam messages" on public.jam_messages;
create policy "active members read jam messages"
on public.jam_messages for select to authenticated
using (public.is_active_jam_member(jam_id));

drop policy if exists "active members write jam messages" on public.jam_messages;
create policy "active members write jam messages"
on public.jam_messages for insert to authenticated
with check (author_id = auth.uid() and public.is_active_jam_member(jam_id));

drop policy if exists "active members read jam proposals" on public.jam_proposals;
create policy "active members read jam proposals"
on public.jam_proposals for select to authenticated
using (public.is_active_jam_member(jam_id));

drop policy if exists "active members write jam proposals" on public.jam_proposals;
create policy "active members write jam proposals"
on public.jam_proposals for insert to authenticated
with check (
  author_id = auth.uid()
  and public.is_active_jam_member(jam_id)
  and status = 'queued'
);

-- No update or delete policy exists. Chat and proposals are an append-only log.
-- Changing a proposal status is a scene transition and needs the versioned
-- transactional contract that this migration deliberately does not introduce.

-- 3. Postgres Changes ----------------------------------------------------------
-- Postgres Changes are delivered per subscriber under the policies above.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jam_messages'
  ) then
    alter publication supabase_realtime add table public.jam_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jam_proposals'
  ) then
    alter publication supabase_realtime add table public.jam_proposals;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jam_members'
  ) then
    alter publication supabase_realtime add table public.jam_members;
  end if;
end;
$$;

-- jam_members updates carry the admission/removal transition, so subscribers need the
-- full previous row rather than only the primary key.
alter table public.jam_members replica identity full;

-- 4. Channel boundary -----------------------------------------------------------
-- Hosted Supabase does not grant projects ownership of its internal `realtime.messages`
-- table, so a project cannot safely install private-channel Presence/Broadcast policies
-- from the SQL Editor. The client uses a public channel solely as the transport for
-- Postgres Changes: durable `jam_messages`, `jam_proposals` and `jam_members` remain
-- individually authorized by their own RLS policies above. Presence and Broadcast are not
-- enabled, so a waiting participant has no transient roster to observe or spoof.
