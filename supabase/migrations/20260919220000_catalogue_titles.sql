-- Reference catalogue for TV-first Discover.
--
-- Source: the TMDB dataset named as the tool for the Titan OS challenge, curated down to
-- released, non-adult titles that have a poster, an overview and at least 50 votes. That is
-- 27,839 rows instead of 1.5 million: the long tail is unrecognisable filler that would cost
-- storage, index time and retrieval quality without ever being recommended.
--
-- These rows are licensed reference data about real films. They are read-only to the
-- application, are never rewritten, and must never be merged with generated Movie Jam
-- artifacts, which carry their own schema and identifiers.

create table if not exists public.catalogue_titles (
  id                 bigint primary key,
  title              text not null,
  original_title     text,
  release_date       date,
  runtime            integer,
  vote_average       numeric(4,3),
  vote_count         integer,
  popularity         numeric(10,3),
  original_language  text,
  poster_path        text,
  backdrop_path      text,
  overview           text,
  tagline            text,
  genres             text,
  keywords           text,
  spoken_languages   text,
  imdb_id            text
);

-- One ranked document per title. Weighting keeps a title match above a plot-word match, so
-- "alien" finds Alien before every film whose synopsis mentions an alien.
alter table public.catalogue_titles
  add column if not exists document tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(genres, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(keywords, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(overview, '')), 'D')
  ) stored;

create extension if not exists pg_trgm with schema extensions;

create index if not exists catalogue_titles_document_idx on public.catalogue_titles using gin (document);
create index if not exists catalogue_titles_title_trgm_idx on public.catalogue_titles using gin (title extensions.gin_trgm_ops);
create index if not exists catalogue_titles_popularity_idx on public.catalogue_titles (popularity desc);
create index if not exists catalogue_titles_release_idx on public.catalogue_titles (release_date desc);

alter table public.catalogue_titles enable row level security;

-- Read-only to every signed-in viewer. No insert, update or delete policy exists, so the
-- catalogue cannot be mutated through the API even by its own host.
drop policy if exists "catalogue is readable by signed-in viewers" on public.catalogue_titles;
create policy "catalogue is readable by signed-in viewers"
  on public.catalogue_titles for select to authenticated using (true);

revoke insert, update, delete on table public.catalogue_titles from authenticated, anon;
grant select on table public.catalogue_titles to authenticated;
