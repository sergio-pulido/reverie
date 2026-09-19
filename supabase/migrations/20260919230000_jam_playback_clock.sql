-- Reverie Movie Jam: the shared playback clock.
-- One clock per jam room. The host starts, pauses or resets it; the database
-- stamps the anchor with its own now(), so every viewer derives the same
-- position without trusting any browser's clock. Reads and writes go through
-- security definer functions only: the table has RLS on and no policies.

create table if not exists public.jam_playback (
  jam_id uuid primary key references public.jams(id) on delete cascade,
  status text not null default 'idle' check (status in ('idle', 'playing', 'paused')),
  -- Server anchor for the current playing segment. Null unless status = 'playing'.
  started_at timestamptz,
  -- Elapsed time accumulated before the current segment (paused time + prior plays).
  paused_elapsed_ms bigint not null default 0 check (paused_elapsed_ms >= 0),
  state_version integer not null default 1 check (state_version >= 1),
  updated_at timestamptz not null default now(),
  constraint jam_playback_anchor_consistent check (
    (status = 'playing' and started_at is not null)
    or (status <> 'playing' and started_at is null)
  )
);

drop trigger if exists jam_playback_updated_at on public.jam_playback;
create trigger jam_playback_updated_at
before update on public.jam_playback
for each row execute function public.set_jam_updated_at();

alter table public.jam_playback enable row level security;
revoke all on table public.jam_playback from authenticated, anon;

-- Every jam gets a clock row, so reads never have to write.
create or replace function public.create_jam_playback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.jam_playback (jam_id) values (new.id) on conflict (jam_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_jam_playback on public.jams;
create trigger create_jam_playback
after insert on public.jams
for each row execute function public.create_jam_playback();

-- Backfill rooms that predate this migration.
insert into public.jam_playback (jam_id) select id from public.jams on conflict (jam_id) do nothing;

-- The one rule for "where are we now". Pure, so it is testable and identical
-- for every caller; the mutating functions reuse it when they freeze elapsed.
create or replace function public.jam_playback_elapsed_ms(
  p_status text,
  p_started_at timestamptz,
  p_paused_elapsed_ms bigint,
  p_now timestamptz
)
returns bigint
language sql
stable
set search_path = public
as $$
  select case
    when p_status = 'idle' then 0::bigint
    when p_status = 'playing' and p_started_at is not null
      then p_paused_elapsed_ms
        + greatest(0, (extract(epoch from (p_now - p_started_at)) * 1000)::bigint)
    else p_paused_elapsed_ms
  end;
$$;

-- Shape returned to the browser. serverNow lets a client correct for clock
-- skew: it anchors to elapsedMs and advances with its own monotonic clock.
create or replace function public.jam_playback_json(p_row public.jam_playback, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'jamId', p_row.jam_id,
    'status', p_row.status,
    'elapsedMs', public.jam_playback_elapsed_ms(
      p_row.status, p_row.started_at, p_row.paused_elapsed_ms, p_now
    ),
    'serverNow', p_now,
    'stateVersion', p_row.state_version
  );
$$;

-- 1. Read: any active member of the room, plus the host. ----------------------

create or replace function public.get_jam_playback(p_jam_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.jam_playback%rowtype;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not (public.is_jam_host(p_jam_id) or public.is_active_jam_member(p_jam_id)) then
    raise exception 'jam: only active members can see playback' using errcode = '42501';
  end if;

  select * into v_row from public.jam_playback where jam_id = p_jam_id;
  if not found then
    return jsonb_build_object(
      'jamId', p_jam_id,
      'status', 'idle',
      'elapsedMs', 0,
      'serverNow', v_now,
      'stateVersion', 1
    );
  end if;

  return public.jam_playback_json(v_row, v_now);
end;
$$;

-- 2. Host-only control. Each takes the row lock before reading, so two taps
--    cannot interleave into a lost update. --------------------------------------

create or replace function public.start_jam_playback(p_jam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jam_playback%rowtype;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can control playback' using errcode = '42501';
  end if;

  insert into public.jam_playback (jam_id) values (p_jam_id) on conflict (jam_id) do nothing;
  select * into v_row from public.jam_playback where jam_id = p_jam_id for update;

  -- Pressing play while already playing is a no-op: it must not move the anchor.
  if v_row.status <> 'playing' then
    update public.jam_playback
    set status = 'playing',
        started_at = v_now,
        state_version = v_row.state_version + 1
    where jam_id = p_jam_id
    returning * into v_row;
  end if;

  return public.jam_playback_json(v_row, v_now);
end;
$$;

create or replace function public.pause_jam_playback(p_jam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jam_playback%rowtype;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can control playback' using errcode = '42501';
  end if;

  insert into public.jam_playback (jam_id) values (p_jam_id) on conflict (jam_id) do nothing;
  select * into v_row from public.jam_playback where jam_id = p_jam_id for update;

  if v_row.status = 'playing' then
    update public.jam_playback
    set paused_elapsed_ms = public.jam_playback_elapsed_ms(
          'playing', v_row.started_at, v_row.paused_elapsed_ms, v_now
        ),
        status = 'paused',
        started_at = null,
        state_version = v_row.state_version + 1
    where jam_id = p_jam_id
    returning * into v_row;
  end if;

  return public.jam_playback_json(v_row, v_now);
end;
$$;

create or replace function public.reset_jam_playback(p_jam_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jam_playback%rowtype;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'jam: authentication required' using errcode = '28000';
  end if;
  if not public.is_jam_host(p_jam_id) then
    raise exception 'jam: only the host can control playback' using errcode = '42501';
  end if;

  insert into public.jam_playback (jam_id) values (p_jam_id) on conflict (jam_id) do nothing;
  select * into v_row from public.jam_playback where jam_id = p_jam_id for update;

  update public.jam_playback
  set status = 'idle',
      started_at = null,
      paused_elapsed_ms = 0,
      state_version = v_row.state_version + 1
  where jam_id = p_jam_id
  returning * into v_row;

  return public.jam_playback_json(v_row, v_now);
end;
$$;

revoke all on function public.get_jam_playback(uuid) from public;
revoke all on function public.start_jam_playback(uuid) from public;
revoke all on function public.pause_jam_playback(uuid) from public;
revoke all on function public.reset_jam_playback(uuid) from public;
grant execute on function public.get_jam_playback(uuid) to authenticated;
grant execute on function public.start_jam_playback(uuid) to authenticated;
grant execute on function public.pause_jam_playback(uuid) to authenticated;
grant execute on function public.reset_jam_playback(uuid) to authenticated;
