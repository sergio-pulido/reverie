-- Durable storage for generated portion clips (RV-14).
--
-- The bucket is private and carries no policies on storage.objects, so no
-- browser identity -- anonymous or authenticated -- can read or write it. Only
-- the server, holding SUPABASE_SERVICE_ROLE_KEY, uploads and reads clips, and
-- participants still receive the bytes through
-- GET /api/jams/:id/portions/:index/video. No storage URL is ever handed to a
-- participant, so a clip cannot outlive the room's authorization checks.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jam-portions', 'jam-portions', false, 67108864, array['video/mp4'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
