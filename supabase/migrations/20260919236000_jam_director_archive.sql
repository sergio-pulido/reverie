-- Durable storage for director session archives (RV-18).
--
-- A separate bucket from `jam-portions`, not a prefix inside it, because the
-- two have genuinely different constraints and the shared bucket silently
-- rejected every director upload: `jam-portions` allows video/mp4 only and caps
-- objects at 64MB, while a director archive is written as WebM or fragmented
-- MP4 depending on the codec fal negotiates, and a whole session is far larger
-- than one portion clip. That mismatch was invisible until the local stack
-- gained a Storage service, because without one every upload fell back to
-- memory and reported success.
--
-- Private, with no policies on storage.objects, so no browser identity --
-- anonymous or authenticated -- can read or write it. Only the server, holding
-- SUPABASE_SERVICE_ROLE_KEY, uploads and reads; participants receive bytes
-- through the server's own routes and never a storage URL.
--
-- Skipped where Storage is not installed, matching
-- 20260919233000_jam_portion_media.sql: a server without a bucket keeps
-- archives in memory and reports durable: false.

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage.buckets is absent; skipping the jam-director bucket (archives stay in memory).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'jam-director',
    'jam-director',
    false,
    536870912,
    -- WebM and fMP4 because the container follows the negotiated codec, and the
    -- HLS playlist that indexes the segments of a finished session.
    array['video/webm', 'video/mp4', 'application/vnd.apple.mpegurl']
  )
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end
$$;
