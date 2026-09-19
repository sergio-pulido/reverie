-- Reverie Movie Jam: opt-in live media. One Vonage session per jam, and a consent register
-- that records owner, purpose, lifetime and a server-issued asset reference.
-- Apply after 20260919190000_jam_collaboration.sql.
--
-- Nothing here stores media. It stores permission to publish a live track and the reference
-- the rest of the product may cite. Recording, export and transformation are separate
-- permissions that this migration deliberately does not grant.

-- 1. The jam's live session --------------------------------------------------
-- The Vonage session id is not a secret, but it is also not something a browser may
-- invent: it is written only by the privileged function below, which stores whatever the
-- server just created and returns the existing one to everybody else.

create table if not exists public.jam_live_sessions (
  jam_id uuid primary key references public.jams(id) on delete cascade,
  provider text not null default 'vonage' check (provider = 'vonage'),
  provider_session_id text not null unique check (char_length(provider_session_id) between 16 and 512),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.jam_live_sessions enable row level security;

drop policy if exists "active members read the live session" on public.jam_live_sessions;
create policy "active members read the live session"
on public.jam_live_sessions for select to authenticated
using (public.is_active_jam_member(jam_id));

-- No insert, update or delete policy: the function below is the only writer.

create or replace function public.ensure_jam_live_session(p_jam_id uuid, p_provider_session_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing text;
begin
  if v_uid is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_active_jam_member(p_jam_id) then
    raise exception 'jam: only an active member can open the live stage' using errcode = '42501';
  end if;
  if p_provider_session_id is null or char_length(p_provider_session_id) not between 16 and 512 then
    raise exception 'jam: a live session reference is required' using errcode = '22023';
  end if;

  -- Two members opening the stage at once must converge on one session, not two rooms.
  insert into public.jam_live_sessions (jam_id, provider_session_id, created_by)
  values (p_jam_id, p_provider_session_id, v_uid)
  on conflict (jam_id) do nothing;

  select provider_session_id into v_existing
  from public.jam_live_sessions where jam_id = p_jam_id;

  return v_existing;
end;
$$;

revoke all on function public.ensure_jam_live_session(uuid, text) from public;
grant execute on function public.ensure_jam_live_session(uuid, text) to authenticated;

-- 2. The consent register -----------------------------------------------------

create table if not exists public.jam_live_consents (
  id uuid primary key default gen_random_uuid(),
  jam_id uuid not null references public.jams(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('camera', 'microphone', 'screen')),
  purpose text not null check (char_length(btrim(purpose)) between 3 and 200),
  asset_ref text not null unique,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  withdrawn_at timestamptz
);

create index if not exists jam_live_consents_jam_idx
  on public.jam_live_consents (jam_id, granted_at, id);

-- The asset reference is issued here, never by the client, and the lifetime is clamped
-- here, so neither can be widened by whatever the browser sent.
create or replace function public.stamp_live_consent()
returns trigger
language plpgsql
as $$
begin
  new.asset_ref := 'live:' || gen_random_uuid();
  new.granted_at := now();
  new.withdrawn_at := null;
  if new.expires_at is null or new.expires_at <= now() or new.expires_at > now() + interval '2 hours' then
    new.expires_at := now() + interval '30 minutes';
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_live_consent on public.jam_live_consents;
create trigger stamp_live_consent
before insert on public.jam_live_consents
for each row execute function public.stamp_live_consent();

alter table public.jam_live_consents enable row level security;

-- The room can see who is live and what for. That visibility is the point of the register.
drop policy if exists "active members read live consents" on public.jam_live_consents;
create policy "active members read live consents"
on public.jam_live_consents for select to authenticated
using (public.is_active_jam_member(jam_id));

drop policy if exists "active members grant their own live consent" on public.jam_live_consents;
create policy "active members grant their own live consent"
on public.jam_live_consents for insert to authenticated
with check (owner_id = auth.uid() and public.is_active_jam_member(jam_id));

-- No update or delete policy. Withdrawal is the function below, so a consent record can
-- never be rewritten into something the owner did not agree to, or quietly deleted.

create or replace function public.withdraw_live_consent(p_consent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.jam_live_consents%rowtype;
begin
  if v_uid is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;

  update public.jam_live_consents
  set withdrawn_at = coalesce(withdrawn_at, now())
  where id = p_consent_id and owner_id = v_uid
  returning * into v_row;

  if v_row.id is null then
    raise exception 'jam: that consent is not yours to withdraw' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'jamId', v_row.jam_id,
    'kind', v_row.kind,
    'assetRef', v_row.asset_ref,
    'withdrawnAt', v_row.withdrawn_at
  );
end;
$$;

revoke all on function public.withdraw_live_consent(uuid) from public;
grant execute on function public.withdraw_live_consent(uuid) to authenticated;

-- 3. Realtime ------------------------------------------------------------------
-- A withdrawal has to reach the other clients, so the register publishes updates with the
-- full previous row rather than only the primary key.

alter table public.jam_live_consents replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jam_live_consents'
  ) then
    alter publication supabase_realtime add table public.jam_live_consents;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jam_live_sessions'
  ) then
    alter publication supabase_realtime add table public.jam_live_sessions;
  end if;
end;
$$;
