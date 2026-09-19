-- Prevent concurrent token requests from allocating duplicate external video rooms.
-- Apply after 20260919210000_jam_live_media.sql.

alter table public.jam_live_sessions
  alter column provider_session_id drop not null,
  add column if not exists status text not null default 'ready'
    check (status in ('pending', 'ready')),
  add column if not exists reservation_id uuid,
  add column if not exists reservation_expires_at timestamptz;

alter table public.jam_live_sessions
  drop constraint if exists jam_live_sessions_ready_session_check;
alter table public.jam_live_sessions
  add constraint jam_live_sessions_ready_session_check check (
    (status = 'ready' and provider_session_id is not null and reservation_id is null and reservation_expires_at is null)
    or (status = 'pending' and provider_session_id is null and reservation_id is not null and reservation_expires_at is not null)
  );

drop function if exists public.ensure_jam_live_session(uuid, text);

create or replace function public.reserve_jam_live_session(p_jam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.jam_live_sessions%rowtype;
  v_reservation uuid;
begin
  if v_uid is null then raise exception 'jam: authentication required' using errcode = '28000'; end if;
  if not public.is_active_jam_member(p_jam_id) then raise exception 'jam: only an active member can open the live stage' using errcode = '42501'; end if;

  -- Serializes the missing-row case as well as updates to an existing row.
  perform pg_advisory_xact_lock(hashtextextended(p_jam_id::text, 0));
  select * into v_row from public.jam_live_sessions where jam_id = p_jam_id;
  if found and v_row.status = 'ready' then
    return jsonb_build_object('state', 'ready', 'sessionId', v_row.provider_session_id);
  end if;
  if found and v_row.status = 'pending' and v_row.reservation_expires_at > now() then
    return jsonb_build_object('state', 'pending');
  end if;

  v_reservation := gen_random_uuid();
  insert into public.jam_live_sessions (jam_id, provider_session_id, created_by, status, reservation_id, reservation_expires_at)
  values (p_jam_id, null, v_uid, 'pending', v_reservation, now() + interval '1 minute')
  on conflict (jam_id) do update set
    provider_session_id = null,
    created_by = excluded.created_by,
    status = 'pending',
    reservation_id = excluded.reservation_id,
    reservation_expires_at = excluded.reservation_expires_at;
  return jsonb_build_object('state', 'reserved', 'reservationId', v_reservation);
end;
$$;

create or replace function public.finalize_jam_live_session(
  p_jam_id uuid, p_reservation_id uuid, p_provider_session_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_session_id text;
begin
  if v_uid is null then raise exception 'jam: authentication required' using errcode = '28000'; end if;
  if not public.is_active_jam_member(p_jam_id) then raise exception 'jam: only an active member can open the live stage' using errcode = '42501'; end if;
  if p_provider_session_id is null or char_length(p_provider_session_id) not between 16 and 512 then raise exception 'jam: a live session reference is required' using errcode = '22023'; end if;
  update public.jam_live_sessions
  set provider_session_id = p_provider_session_id, status = 'ready', reservation_id = null, reservation_expires_at = null
  where jam_id = p_jam_id and status = 'pending' and reservation_id = p_reservation_id and reservation_expires_at > now()
  returning provider_session_id into v_session_id;
  if v_session_id is null then raise exception 'jam: live session reservation expired' using errcode = '40001'; end if;
  return v_session_id;
end;
$$;

revoke all on function public.reserve_jam_live_session(uuid) from public;
grant execute on function public.reserve_jam_live_session(uuid) to authenticated;
revoke all on function public.finalize_jam_live_session(uuid, uuid, text) from public;
grant execute on function public.finalize_jam_live_session(uuid, uuid, text) to authenticated;
