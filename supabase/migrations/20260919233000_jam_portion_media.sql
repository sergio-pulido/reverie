-- Durable storage for generated portion clips (RV-14).
--
-- The bucket is private and carries no policies on storage.objects, so no
-- browser identity -- anonymous or authenticated -- can read or write it. Only
-- the server, holding SUPABASE_SERVICE_ROLE_KEY, uploads and reads clips, and
-- participants still receive the bytes through
-- GET /api/jams/:id/portions/:index/video. No storage URL is ever handed to a
-- participant, so a clip cannot outlive the room's authorization checks.
--
-- Skipped where Storage is not installed. The local Docker stack
-- (docker/compose.yaml) runs Postgres, Auth, PostgREST and Realtime but no
-- Storage service, and this file must not abort that migration run: a server
-- without a bucket keeps clips in memory and reports durable: false, which is
-- exactly what the local stack should do.

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage.buckets is absent; skipping the jam-portions bucket (clips stay in memory).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('jam-portions', 'jam-portions', false, 67108864, array['video/mp4'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end
$$;
