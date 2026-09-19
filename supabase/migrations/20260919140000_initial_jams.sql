-- Reverie Movie Jam: initial server-authoritative room model.
-- Apply through the Supabase SQL Editor or Supabase CLI after enabling Anonymous Sign-Ins.

create extension if not exists pgcrypto;

create table if not exists public.jams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 1 and 72),
  premise text not null check (char_length(premise) between 1 and 280),
  visibility text not null check (visibility in ('public', 'invite_only')),
  status text not null default 'draft' check (status in ('draft', 'lobby', 'live', 'paused', 'completed', 'closed')),
  host_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jam_members (
  jam_id uuid not null references public.jams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  role text not null check (role in ('host', 'member')),
  status text not null default 'active' check (status in ('waiting', 'active', 'left', 'removed')),
  joined_at timestamptz not null default now(),
  primary key (jam_id, user_id)
);

create or replace function public.set_jam_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jams_updated_at on public.jams;
create trigger jams_updated_at
before update on public.jams
for each row execute function public.set_jam_updated_at();

create or replace function public.create_jam_host_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.jam_members (jam_id, user_id, display_name, role, status)
  values (new.id, new.host_id, 'Host', 'host', 'active');
  return new;
end;
$$;

drop trigger if exists create_jam_host_membership on public.jams;
create trigger create_jam_host_membership
after insert on public.jams
for each row execute function public.create_jam_host_membership();

alter table public.jams enable row level security;
alter table public.jam_members enable row level security;

create policy "authenticated users create their own jams"
on public.jams for insert to authenticated
with check (host_id = auth.uid());

create policy "hosts read their own jams"
on public.jams for select to authenticated
using (host_id = auth.uid());

create policy "hosts update their own jams"
on public.jams for update to authenticated
using (host_id = auth.uid())
with check (host_id = auth.uid());

create policy "members read their own membership"
on public.jam_members for select to authenticated
using (user_id = auth.uid());

create policy "hosts read their room members"
on public.jam_members for select to authenticated
using (
  exists (
    select 1 from public.jams
    where jams.id = jam_members.jam_id and jams.host_id = auth.uid()
  )
);

-- Add these tables to Realtime only when the client subscriptions exist.
-- alter publication supabase_realtime add table public.jams, public.jam_members;
