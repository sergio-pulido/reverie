-- A raised exception rolls back its counter update. Return a typed denial for failed invite
-- lookups so the per-identity throttle commits before the browser sees the refusal.

create or replace function public.request_jam_admission(p_invite_code text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_name text := btrim(coalesce(p_display_name, ''));
  v_code text := upper(btrim(coalesce(p_invite_code, ''))); v_jam public.jams%rowtype;
  v_status text; v_next text;
begin
  if v_uid is null then raise exception 'jam: authentication required' using errcode = '28000'; end if;
  if char_length(v_name) not between 1 and 32 then raise exception 'jam: display name must be 1 to 32 characters' using errcode = '22023'; end if;
  if public.admission_attempts_exhausted(v_uid) then
    return jsonb_build_object('status', 'error', 'code', 'rate_limited');
  end if;
  if v_code !~ '^[A-HJ-NP-TV-Z2-9]{8}$' then
    perform public.record_failed_admission(v_uid);
    return jsonb_build_object('status', 'error', 'code', 'invite_not_found');
  end if;
  select * into v_jam from public.jams where invite_code = v_code;
  if not found or (v_jam.host_id <> v_uid and public.jam_invite_state(v_jam.invite_expires_at, v_jam.invite_revoked_at) <> 'active') then
    perform public.record_failed_admission(v_uid);
    return jsonb_build_object('status', 'error', 'code', 'invite_not_found');
  end if;
  if v_jam.status in ('completed', 'closed') then raise exception 'jam: this jam is no longer open' using errcode = '22023'; end if;
  select status into v_status from public.jam_members where jam_id = v_jam.id and user_id = v_uid;
  if v_status = 'removed' then raise exception 'jam: access to this jam was revoked' using errcode = '42501'; end if;
  if v_jam.host_id = v_uid then
    return jsonb_build_object('jamId', v_jam.id, 'slug', v_jam.slug, 'title', v_jam.title, 'memberStatus', coalesce(v_status, 'active'));
  end if;
  v_next := case when v_jam.visibility = 'public' then 'active' else 'waiting' end;
  if v_status is null or v_status = 'left' then
    insert into public.jam_members (jam_id, user_id, display_name, role, status)
    values (v_jam.id, v_uid, v_name, 'member', v_next)
    on conflict (jam_id, user_id) do update set display_name = excluded.display_name, status = excluded.status
    returning status into v_status;
  else
    update public.jam_members set display_name = v_name where jam_id = v_jam.id and user_id = v_uid returning status into v_status;
  end if;
  return jsonb_build_object('jamId', v_jam.id, 'slug', v_jam.slug, 'title', v_jam.title, 'memberStatus', v_status);
end;
$$;

revoke all on function public.request_jam_admission(text, text) from public;
grant execute on function public.request_jam_admission(text, text) to authenticated;
