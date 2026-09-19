-- Reverie Movie Jam: reconcile the two independent jam_playback definitions.
--
-- Two migrations introduced public.jam_playback without knowing about each other:
--   20260919190000_structured_script_revisions.sql  (portion playback cursor)
--   20260919230000_jam_playback_clock.sql           (shared wall-clock anchor)
--
-- 190000 sorts first. On a fresh database it creates the table before the clock
-- migration runs, so the clock migration's `create table if not exists` no-ops,
-- its anchor columns are never added, and its `jam_playback_json` function fails
-- to compile because it references `p_row.started_at`. On an existing database
-- the reverse holds: the clock table exists and the portion cursor is missing.
--
-- This migration sits between the two so every database converges on one table
-- carrying both column sets before the clock functions are created. It is
-- idempotent: it never adds a column or constraint twice, and it backfills
-- before enforcing NOT NULL so no existing row can block it.
--
-- The two representations stay distinct on purpose:
--   current_portion_index  the portion cursor, -1 until the first portion plays
--   started_at             the wall-clock anchor, set only while status='playing'
--   paused_elapsed_ms      time accumulated before the current playing segment
-- status is the union of both vocabularies; only 'playing' carries an anchor.

alter table public.jam_playback
  add column if not exists current_portion_index integer,
  add column if not exists started_at timestamptz,
  add column if not exists paused_elapsed_ms bigint,
  add column if not exists state_version integer;

update public.jam_playback set current_portion_index = -1 where current_portion_index is null;
update public.jam_playback set paused_elapsed_ms = 0 where paused_elapsed_ms is null;
update public.jam_playback set state_version = 1 where state_version is null;

alter table public.jam_playback
  alter column status set default 'idle',
  alter column status set not null,
  alter column current_portion_index set default -1,
  alter column current_portion_index set not null,
  alter column paused_elapsed_ms set default 0,
  alter column paused_elapsed_ms set not null,
  alter column state_version set default 1,
  alter column state_version set not null;

-- One status vocabulary: the cursor's idle|priming|playing|finished plus the
-- clock's paused. Inline checks are auto-named `<table>_<column>_check`, so the
-- names below match whichever migration created the table.
alter table public.jam_playback drop constraint if exists jam_playback_status_check;
alter table public.jam_playback add constraint jam_playback_status_check
  check (status in ('idle', 'priming', 'playing', 'paused', 'finished'));

alter table public.jam_playback drop constraint if exists jam_playback_current_portion_index_check;
alter table public.jam_playback add constraint jam_playback_current_portion_index_check
  check (current_portion_index >= -1);

alter table public.jam_playback drop constraint if exists jam_playback_paused_elapsed_ms_check;
alter table public.jam_playback add constraint jam_playback_paused_elapsed_ms_check
  check (paused_elapsed_ms >= 0);

alter table public.jam_playback drop constraint if exists jam_playback_state_version_check;
alter table public.jam_playback add constraint jam_playback_state_version_check
  check (state_version >= 1);

-- The anchor invariant, stated for the union: a wall-clock anchor exists
-- exactly while the clock is playing. priming/finished/paused carry no anchor.
alter table public.jam_playback drop constraint if exists jam_playback_anchor_consistent;
alter table public.jam_playback add constraint jam_playback_anchor_consistent
  check ((status = 'playing') = (started_at is not null));
