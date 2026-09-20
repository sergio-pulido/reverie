-- Reading a finished director session from a Vercel function (RV-25).
--
-- 20260919237000 made the index server-only on purpose: RLS on with no
-- policies, grants to `service_role` alone, because the only thing that wrote
-- them was the container holding SUPABASE_SERVICE_ROLE_KEY. That is still true
-- of every WRITE. What changed is who reads: the archive routes move to
-- `api/`, where a function authenticates as the caller and holds no
-- service-role key (api/_lib/supabase-rest.ts), so without a read policy it
-- sees nothing at all and a finished film cannot be played in production.
--
-- So this adds SELECT, and only SELECT, for an active member of the jam the
-- session belongs to. Writes stay exactly as they were: no insert, update or
-- delete policy exists for `authenticated`, and none is granted, so a browser
-- identity still cannot forge a session, a segment row, or an audit entry.

-- 1. A jam id that may not be one -------------------------------------------
-- `jam_director_sessions.jam_id` is `text` (237000: no foreign key, because
-- the container owns jams in memory), while `is_active_jam_member` takes a
-- uuid. A direct cast raises on any row whose id is not a uuid, and a raise
-- inside a policy is an error for the whole query rather than a refusal of one
-- row -- so one malformed id would make the archive unreadable for everybody.
create or replace function public.jam_uuid(candidate text)
returns uuid
language plpgsql
immutable
as $$
begin
  return candidate::uuid;
exception when others then
  -- Not a jam any membership can match; `is_active_jam_member(null)` is false.
  return null;
end;
$$;

revoke all on function public.jam_uuid(text) from public;
grant execute on function public.jam_uuid(text) to authenticated;

-- 2. Reaching a session from a row that only names one ----------------------
-- `jam_director_segments` and `jam_director_audit` carry a session id and no
-- jam id, so their policies have to reach the session. Security definer, so
-- that reach is a single indexed lookup rather than a nested policy evaluation
-- on every row of every segment listing.
create or replace function public.can_read_director_session(target_session text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jam_director_sessions s
    where s.id = target_session
      and public.is_active_jam_member(public.jam_uuid(s.jam_id))
  );
$$;

revoke all on function public.can_read_director_session(text) from public;
grant execute on function public.can_read_director_session(text) to authenticated;

-- 3. Read policies ----------------------------------------------------------

drop policy if exists "active members read director sessions"
  on public.jam_director_sessions;
create policy "active members read director sessions"
on public.jam_director_sessions for select to authenticated
using (public.is_active_jam_member(public.jam_uuid(jam_id)));

drop policy if exists "active members read director segments"
  on public.jam_director_segments;
create policy "active members read director segments"
on public.jam_director_segments for select to authenticated
using (public.can_read_director_session(session_id));

drop policy if exists "active members read director audit"
  on public.jam_director_audit;
create policy "active members read director audit"
on public.jam_director_audit for select to authenticated
using (public.can_read_director_session(session_id));

-- SELECT only, and only to `authenticated`. `anon` is granted nothing: an
-- anonymous Supabase session is still `authenticated` once it signs in, and a
-- caller with no session has no membership row to match anyway.
grant select
  on public.jam_director_sessions,
     public.jam_director_segments,
     public.jam_director_audit
  to authenticated;

-- 4. The bytes --------------------------------------------------------------
-- The `jam-director` bucket (20260919236000) is private with no policies, for
-- the same reason the tables were: only the container wrote and read it. The
-- api/ function reads it as the caller too, so an active member needs SELECT
-- on the objects of the jam they are in -- and nothing else. No insert, update
-- or delete policy: a participant cannot add to, overwrite or remove an
-- archive, and the container keeps writing with the service-role key.
--
-- Objects are keyed `<jamId>/<sessionId>/<name>` (apps/server/directorArchive.ts),
-- so the first folder is the jam.
--
-- Skipped where Storage is not installed, matching 20260919236000: the local
-- Docker stack runs Postgres, Auth, PostgREST and Realtime but no Storage, so
-- this must not abort the migration run there.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects is absent; skipping the jam-director read policy.';
    return;
  end if;

  drop policy if exists "active members read director archives" on storage.objects;
  create policy "active members read director archives"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'jam-director'
    and public.is_active_jam_member(public.jam_uuid((storage.foldername(name))[1]))
  );
end
$$;
