-- Subtitle and audio-description availability for catalogue films. Metadata only.
--
-- A companion table rather than new columns: catalogue_titles is licensed reference data that
-- is never rewritten, and these facts come from other sources, on another schedule, filled by
-- an offline backfill (apps/backfill/accessibility.ts). No subtitle file or text is stored.
--
-- Every fact has three states and none is collapsed into another:
--   subtitle_languages  null = never checked, '{}' = checked and none found, else the codes
--   has_audio_description  null = unknown, false = a source says no, true = a source says yes
-- A film with no row here is "never checked" for both. A film without an imdb_id can never be
-- checked by either source, so it keeps no row: absence of evidence, not evidence of absence.

create table if not exists public.catalogue_title_accessibility (
  title_id                      bigint primary key
                                references public.catalogue_titles (id) on delete cascade,
  subtitle_languages            text[],
  subtitle_count                integer,
  subtitle_checked_at           timestamptz,
  subtitle_source               text,
  has_audio_description         boolean,
  audio_description_source      text,
  audio_description_checked_at  timestamptz,

  -- A subtitle answer is all-or-nothing: languages, count, time and source together.
  constraint subtitle_answer_is_whole check (
    (subtitle_languages is null and subtitle_count is null and subtitle_checked_at is null and subtitle_source is null)
    or (subtitle_languages is not null and subtitle_count is not null and subtitle_checked_at is not null and subtitle_source is not null)
  ),
  constraint subtitle_count_is_sane check (subtitle_count is null or subtitle_count >= 0),
  constraint subtitle_languages_are_codes check (
    subtitle_languages is null
    or (cardinality(subtitle_languages) <= 200
        and array_to_string(subtitle_languages, ',') ~ '^([a-z]{2,3}(-[A-Za-z]{2,4})?(,|$))*$')
  ),
  -- No languages means no subtitles; languages mean at least one.
  constraint subtitle_count_matches_languages check (
    subtitle_languages is null or ((cardinality(subtitle_languages) = 0) = (subtitle_count = 0))
  ),
  -- A yes or a no always says where it came from, and when.
  constraint audio_description_answer_is_sourced check (
    (has_audio_description is null and audio_description_source is null and audio_description_checked_at is null)
    or (has_audio_description is not null and audio_description_source is not null and audio_description_checked_at is not null)
  )
);

alter table public.catalogue_title_accessibility enable row level security;

-- Read-only to signed-in viewers, exactly like the catalogue. The backfill writes as the
-- database owner, offline; nothing written here ever arrives through the API.
drop policy if exists "accessibility is readable by signed-in viewers" on public.catalogue_title_accessibility;
create policy "accessibility is readable by signed-in viewers"
  on public.catalogue_title_accessibility for select to authenticated using (true);

revoke all on table public.catalogue_title_accessibility from anon, authenticated;
grant select on table public.catalogue_title_accessibility to authenticated;

-- The film page reads these facts with the rest of the record: still one row, by key. The five
-- new keys are JSON null when the film was never checked, and the mapper keeps null distinct
-- from an empty list and from false. The parameter is qualified: the joined table has its own
-- title_id column, and in a SQL function a column name wins over a bare parameter name, which
-- would turn the filter into the join condition and return an arbitrary film.
create or replace function public.get_catalogue_title(title_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
           'id', c.id,
           'title', c.title,
           'original_title', c.original_title,
           'release_date', c.release_date,
           'runtime', c.runtime,
           'vote_average', c.vote_average,
           'vote_count', c.vote_count,
           'original_language', c.original_language,
           'spoken_languages', c.spoken_languages,
           'poster_path', c.poster_path,
           'backdrop_path', c.backdrop_path,
           'overview', c.overview,
           'tagline', c.tagline,
           'genres', c.genres,
           'keywords', c.keywords,
           'imdb_id', c.imdb_id,
           'subtitle_languages', a.subtitle_languages,
           'subtitle_count', a.subtitle_count,
           'subtitle_checked_at', a.subtitle_checked_at,
           'has_audio_description', a.has_audio_description,
           'audio_description_source', a.audio_description_source
         )
    from public.catalogue_titles c
    left join public.catalogue_title_accessibility a on a.title_id = c.id
   where c.id = get_catalogue_title.title_id;
$$;

revoke all on function public.get_catalogue_title(bigint) from public, anon;
grant execute on function public.get_catalogue_title(bigint) to authenticated;
