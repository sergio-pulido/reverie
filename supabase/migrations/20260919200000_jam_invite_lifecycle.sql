-- Reverie Movie Jam: invite expiry, revocation, rotation, host-only invite reads and a
-- throttle on failed invite lookups.
-- Apply after 20260919190000_jam_collaboration.sql. Ordered, not an idempotent reset.

-- 1. Lifecycle columns ---------------------------------------------------------
-- A null expiry means "does not expire"; a null revocation means "not revoked".

alter table public.jams
  add column if not exists invite_expires_at timestamptz,
  add column if not exists invite_revoked_at timestamptz;

-- 2. The invite is host-only at the column level -------------------------------
-- RLS answers "which rows"; "which columns of a row I may read" is a column privilege.
-- A table-level grant cannot be partially revoked, so the table grant is dropped and
-- re-issued per column, excluding the three invite columns. The security definer
-- functions below run as owner and are unaffected.
--
-- MAINTENANCE: a later `grant select on public.jams to authenticated` — the table-level
-- form, without a column list — silently re-exposes the invite to every member. Column
-- privileges are additive on top of the revoke, so nothing here would fail loudly.
-- scripts/verify-realtime.mjs asserts the column is unreadable; keep that check.

do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
  into v_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'jams'
    and column_name not in ('invite_code', 'invite_expires_at', 'invite_revoked_at');

  execute 'revoke select, update on public.jams from authenticated, anon';
  execute format('grant select (%s) on public.jams to authenticated', v_columns);
  execute format('grant update (%s) on public.jams to authenticated', v_columns);
end;
$$;

-- A host can still update their room through the existing policy, but neither a host nor
-- a member can read or hand-write the entitlement. Both go through the functions below.

-- 3. Derived invite state ------------------------------------------------------

create or replace function public.jam_invite_state(p_expires_at timestamptz, p_revoked_at timestamptz)
returns text
language sql
-- stable, not immutable: it reads now(). Marking it immutable would let the planner
-- constant-fold an expiry check and keep answering 'active' after the invite lapsed.
stable
as $$
  select case
    when p_revoked_at is not null then 'revoked'
    when p_expires_at is not null and p_expires_at <= now() then 'expired'
    else 'active'
  end;
$$;

-- 4. Throttle on failed invite lookups -----------------------------------------
-- RLS is on and there is no policy: only the security definer functions below reach it,
-- and neither is granted to authenticated, so no caller can inflate another user's count.
--
-- Scope, stated honestly: this is keyed on auth.uid(), and the product uses anonymous
-- sign-in, so an attacker can mint a fresh identity to reset the window. It raises the
-- cost of scripted probing from one session; it is not the barrier. The barrier is the
-- code's ~39 bits plus Supabase Auth's own limits on anonymous sign-in, which must be
-- configured before a public audience (see docs/SUPABASE_SETUP.md).

create table if not exists public.jam_admission_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  failed_count integer not null default 0
);

alter table public.jam_admission_attempts enable row level security;
revoke all on table public.jam_admission_attempts from authenticated, anon;

create or replace function public.record_failed_admission(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.jam_admission_attempts (user_id, window_started_at, failed_count)
  values (p_user, now(), 1)
  on conflict (user_id) do update
    set failed_count = case
          when public.jam_admission_attempts.window_started_at < now() - interval '10 minutes' then 1
          else public.jam_admission_attempts.failed_count + 1
        end,
        window_started_at = case
          when public.jam_admission_attempts.window_started_at < now() - interval '10 minutes' then now()
          else public.jam_admission_attempts.window_started_at
        end;
end;
$$;

create or replace function public.admission_attempts_exhausted(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select failed_count >= 10
     from public.jam_admission_attempts
     where user_id = p_user
       and window_started_at >= now() - interval '10 minutes'),
    false);
$$;

revoke all on function public.record_failed_admission(uuid) from public;
revoke all on function public.admission_attempts_exhausted(uuid) from public;

-- 5. Admission honours the lifecycle and the throttle ---------------------------

create or replace function public.request_jam_admission(p_invite_code text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_display_name, ''));
  v_code text := upper(btrim(coalesce(p_invite_code, '')));
  v_jam public.jams%rowtype;
  v_status text;
  v_next text;
begin
  if v_uid is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 32 then
    raise exception 'jam: display name must be 1 to 32 characters' using errcode = '22023';
  end if;
  if public.admission_attempts_exhausted(v_uid) then
    raise exception 'jam: too many invite attempts. Wait a few minutes and try again.'
      using errcode = '53400';
  end if;

  if v_code !~ '^[A-HJ-NP-TV-Z2-9]{8}$' then
    perform public.record_failed_admission(v_uid);
    raise exception 'jam: invite not found' using errcode = 'P0002';
  end if;

  select * into v_jam from public.jams where jams.invite_code = v_code;
  if not found then
    perform public.record_failed_admission(v_uid);
    raise exception 'jam: invite not found' using errcode = 'P0002';
  end if;

  -- A revoked or lapsed invite reports the same thing an unknown code does, and counts
  -- against the throttle, so a probe cannot learn that a private room exists at a code by
  -- watching the message change. The 'no longer open' branch below is deliberately
  -- distinguishable, but it is only reachable by someone already holding a live invite for
  -- that room, so it tells them nothing they were not already entitled to know.
  if v_jam.host_id <> v_uid
     and public.jam_invite_state(v_jam.invite_expires_at, v_jam.invite_revoked_at) <> 'active' then
    perform public.record_failed_admission(v_uid);
    raise exception 'jam: invite not found' using errcode = 'P0002';
  end if;

  if v_jam.status in ('completed', 'closed') then
    raise exception 'jam: this jam is no longer open' using errcode = '22023';
  end if;

  select jam_members.status into v_status
  from public.jam_members
  where jam_members.jam_id = v_jam.id and jam_members.user_id = v_uid;

  if v_status = 'removed' then
    raise exception 'jam: access to this jam was revoked' using errcode = '42501';
  end if;

  -- The host already holds an active host membership. Returning it here keeps the host
  -- out of the insert path below, where a status change could otherwise touch their row.
  if v_jam.host_id = v_uid then
    return jsonb_build_object('jamId', v_jam.id, 'slug', v_jam.slug, 'title', v_jam.title, 'memberStatus', coalesce(v_status, 'active'));
  end if;

  -- Public rooms admit on arrival; invite-only rooms wait for the host.
  v_next := case when v_jam.visibility = 'public' then 'active' else 'waiting' end;

  if v_status is null or v_status = 'left' then
    insert into public.jam_members (jam_id, user_id, display_name, role, status)
    values (v_jam.id, v_uid, v_name, 'member', v_next)
    on conflict (jam_id, user_id) do update
      set display_name = excluded.display_name, status = excluded.status
    returning jam_members.status into v_status;
  else
    -- Already waiting or active: refresh the display name, never the role or status.
    -- A repeated request from the same participant is therefore idempotent.
    update public.jam_members
    set display_name = v_name
    where jam_members.jam_id = v_jam.id and jam_members.user_id = v_uid
    returning jam_members.status into v_status;
  end if;

  return jsonb_build_object(
    'jamId', v_jam.id,
    'slug', v_jam.slug,
    'title', v_jam.title,
    'memberStatus', v_status
  );
end;
$$;

revoke all on function public.request_jam_admission(text, text) from public;
grant execute on function public.request_jam_admission(text, text) to authenticated;

-- 6. Host-only invite read, rotation and revocation -----------------------------

create or replace function public.get_jam_invite(p_jam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jam public.jams%rowtype;
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can see the invite' using errcode = '42501';
  end if;

  select * into v_jam from public.jams where jams.id = p_jam_id;
  if not found then
    raise exception 'jam: that jam does not exist' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'jamId', v_jam.id,
    'slug', v_jam.slug,
    'code', v_jam.invite_code,
    'expiresAt', v_jam.invite_expires_at,
    'revokedAt', v_jam.invite_revoked_at,
    'state', public.jam_invite_state(v_jam.invite_expires_at, v_jam.invite_revoked_at)
  );
end;
$$;

create or replace function public.rotate_jam_invite(p_jam_id uuid, p_expires_in_minutes integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can change the invite' using errcode = '42501';
  end if;
  if p_expires_in_minutes is not null and (p_expires_in_minutes < 5 or p_expires_in_minutes > 1440) then
    raise exception 'jam: an invite lasts between 5 minutes and 24 hours' using errcode = '22023';
  end if;

  v_expires := case when p_expires_in_minutes is null
                    then null
                    else now() + make_interval(mins => p_expires_in_minutes) end;

  -- A new code makes every outstanding link stop working, because the entitlement is a
  -- column on the room rather than a row that could be left behind.
  update public.jams
  set invite_code = public.generate_invite_code(),
      invite_expires_at = v_expires,
      invite_revoked_at = null
  where jams.id = p_jam_id;

  return public.get_jam_invite(p_jam_id);
end;
$$;

create or replace function public.revoke_jam_invite(p_jam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can change the invite' using errcode = '42501';
  end if;

  -- Revocation closes the door to new arrivals. It does not touch existing members:
  -- removing someone already in the room is set_jam_member_status.
  update public.jams set invite_revoked_at = now() where jams.id = p_jam_id;

  return public.get_jam_invite(p_jam_id);
end;
$$;

revoke all on function public.get_jam_invite(uuid) from public;
revoke all on function public.rotate_jam_invite(uuid, integer) from public;
revoke all on function public.revoke_jam_invite(uuid) from public;
grant execute on function public.get_jam_invite(uuid) to authenticated;
grant execute on function public.rotate_jam_invite(uuid, integer) to authenticated;
grant execute on function public.revoke_jam_invite(uuid) to authenticated;
