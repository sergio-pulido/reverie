-- Reverie Movie Jam: invite entitlement, display names, waiting lobby and host admission.
-- Apply after 20260919140000_initial_jams.sql. Ordered, not an idempotent reset script.

-- 1. Invite entitlement -------------------------------------------------------
-- Unambiguous 31-character alphabet: no I, O or U, so a code can be read aloud in a room.
-- security definer because the uniqueness probe must see every jam, not only the caller's.

create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';
  bytes bytea;
  code text;
  i int;
begin
  loop
    bytes := extensions.gen_random_bytes(8);
    code := '';
    for i in 0..7 loop
      code := code || substr(alphabet, 1 + (get_byte(bytes, i) % 31), 1);
    end loop;
    exit when not exists (select 1 from public.jams where jams.invite_code = code);
  end loop;
  return code;
end;
$$;

revoke all on function public.generate_invite_code() from public;
grant execute on function public.generate_invite_code() to authenticated;

alter table public.jams add column if not exists invite_code text;
update public.jams set invite_code = public.generate_invite_code() where invite_code is null;
alter table public.jams
  alter column invite_code set default public.generate_invite_code(),
  alter column invite_code set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jams_invite_code_key') then
    alter table public.jams add constraint jams_invite_code_key unique (invite_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jams_invite_code_format') then
    alter table public.jams add constraint jams_invite_code_format
      check (invite_code ~ '^[A-HJ-NP-TV-Z2-9]{8}$');
  end if;
end;
$$;

-- 2. Non-recursive authorization helpers --------------------------------------
-- A policy on jams that reads jam_members while a policy on jam_members reads jams
-- recurses. These helpers read with RLS bypassed and break that cycle.

create or replace function public.is_jam_host(target_jam uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jams
    where jams.id = target_jam and jams.host_id = auth.uid()
  );
$$;

create or replace function public.is_jam_member(target_jam uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jam_members
    where jam_members.jam_id = target_jam
      and jam_members.user_id = auth.uid()
      and jam_members.status in ('waiting', 'active')
  );
$$;

create or replace function public.is_active_jam_member(target_jam uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jam_members
    where jam_members.jam_id = target_jam
      and jam_members.user_id = auth.uid()
      and jam_members.status = 'active'
  );
$$;

revoke all on function public.is_jam_host(uuid) from public;
revoke all on function public.is_jam_member(uuid) from public;
revoke all on function public.is_active_jam_member(uuid) from public;
grant execute on function public.is_jam_host(uuid) to authenticated;
grant execute on function public.is_jam_member(uuid) to authenticated;
grant execute on function public.is_active_jam_member(uuid) to authenticated;

-- 3. Read policies ------------------------------------------------------------

drop policy if exists "hosts read their own jams" on public.jams;
create policy "participants read their own jams"
on public.jams for select to authenticated
using (host_id = auth.uid() or public.is_jam_member(id));

drop policy if exists "members read their own membership" on public.jam_members;
drop policy if exists "hosts read their room members" on public.jam_members;
create policy "participants read their room members"
on public.jam_members for select to authenticated
using (
  user_id = auth.uid()
  or public.is_jam_host(jam_id)
  or (status = 'active' and public.is_active_jam_member(jam_id))
);

-- A waiting participant reads only their own row, and a peer member reads only the active
-- roster. Who is queued for admission is host-only information, enforced here rather than
-- by which panel the client chooses to render.

-- Membership is mutated only through the constrained functions below. The authenticated
-- role has no insert, update or delete policy on public.jam_members.

-- 4. Admission ----------------------------------------------------------------

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
  if v_code !~ '^[A-HJ-NP-TV-Z2-9]{8}$' then
    raise exception 'jam: invite not found' using errcode = 'P0002';
  end if;

  select * into v_jam from public.jams where jams.invite_code = v_code;
  if not found then
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

-- 5. Host admission and removal ------------------------------------------------

create or replace function public.set_jam_member_status(p_jam_id uuid, p_member_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_member public.jam_members%rowtype;
begin
  if v_uid is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if p_status not in ('active', 'removed') then
    raise exception 'jam: status must be active or removed' using errcode = '22023';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can change membership' using errcode = '42501';
  end if;
  if p_member_id = v_uid then
    raise exception 'jam: the host cannot change their own membership' using errcode = '42501';
  end if;

  update public.jam_members
  set status = p_status
  where jam_members.jam_id = p_jam_id
    and jam_members.user_id = p_member_id
    and jam_members.role = 'member'
  returning * into v_member;

  if v_member.user_id is null then
    raise exception 'jam: member not found in this jam' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'jamId', v_member.jam_id,
    'userId', v_member.user_id,
    'displayName', v_member.display_name,
    'role', v_member.role,
    'status', v_member.status
  );
end;
$$;

revoke all on function public.set_jam_member_status(uuid, uuid, text) from public;
grant execute on function public.set_jam_member_status(uuid, uuid, text) to authenticated;
