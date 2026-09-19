-- The reproduction record for a director session (RV-18).
--
-- The stored video alone cannot be reproduced or explained: it does not say
-- which configuration was being watched, which script revision it was made
-- from, what the room asked for, or what fal did with each direction. These
-- tables hold that, and the media bytes stay in the `jam-director` bucket.
--
-- Read-time reconstruction is the point. The HLS playlist for a finished
-- session is BUILT FROM `jam_director_segments` when it is requested, not
-- written when the session ends. A session whose process died mid-stream
-- therefore still reproduces, up to its last durable segment -- which is the
-- failure that actually happens, since the segmenter's `finish()` is delivered
-- fire-and-forget and nothing waits for it.
--
-- No foreign key to `public.jams`: the container server owns jams in memory
-- (apps/server/jams.ts), so a session's jam id need not exist as a row here.
--
-- Server-only, mirroring the private buckets. RLS is enabled and NO policies
-- are defined, so no browser identity -- anonymous or authenticated -- reads or
-- writes these. Only the server, holding SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS, touches them, and participants receive the record through the
-- server's own routes.

create table if not exists public.jam_director_sessions (
  id text primary key,
  jam_id text not null,
  -- Which stream this was: rooms key a paid stream by jam AND configuration,
  -- so the jam id alone does not say what was being watched.
  configuration_key text not null,
  -- The script the session was generated from, so a reproduction can be
  -- compared against the text that produced it.
  script_revision integer,
  -- What fal actually negotiated, not what was asked for.
  codec text,
  container text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- False until the session closed cleanly. A crashed session stays false, and
  -- the API reports it that way rather than implying a complete archive.
  complete boolean not null default false,
  -- Set when an archive stopped early for a reason worth surfacing, such as
  -- reaching the size cap.
  truncated_reason text
);

create index if not exists jam_director_sessions_jam_idx
  on public.jam_director_sessions (jam_id, started_at desc);

create table if not exists public.jam_director_segments (
  session_id text not null
    references public.jam_director_sessions (id) on delete cascade,
  segment_index integer not null,
  -- Seconds on the muxer's clock from stream start. NOT wall time: the muxer
  -- runs on RTP timestamps, with no NTP alignment.
  start_seconds double precision not null,
  duration_seconds double precision not null,
  byte_size integer not null,
  -- Where the bytes are in the bucket. Only rows for uploads that SUCCEEDED
  -- are written, so a playlist built from them never points at a missing object.
  object_path text not null,
  stored_at timestamptz not null default now(),
  primary key (session_id, segment_index)
);

create table if not exists public.jam_director_audit (
  id bigint generated always as identity primary key,
  session_id text not null
    references public.jam_director_sessions (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  prompt_version integer,
  chunk_index integer,
  script_offset_seconds double precision,
  proposal_id text,
  beat_index integer,
  author_id text,
  -- The direction exactly as it was sent to fal, so the log cannot disagree
  -- with what the provider was actually asked for.
  body text,
  detail text
);

create index if not exists jam_director_audit_session_idx
  on public.jam_director_audit (session_id, at);

alter table public.jam_director_sessions enable row level security;
alter table public.jam_director_segments enable row level security;
alter table public.jam_director_audit enable row level security;

-- Granted explicitly rather than relying on the hosted project's default that
-- `service_role` holds every privilege in `public`. The local stack defines its
-- own roles (docker/postgres/00-local-roles.sql) and grants nothing by default,
-- so without this the server writes fine against hosted Supabase and is refused
-- locally -- the exact divergence that lets a broken path look healthy.
-- `bypassrls` on the role bypasses POLICIES, not table privileges.
--
-- No grants to anon or authenticated: these tables are server-only, and the
-- absence of a grant is a second lock behind the policy-free RLS above.
grant select, insert, update, delete
  on public.jam_director_sessions,
     public.jam_director_segments,
     public.jam_director_audit
  to service_role;
