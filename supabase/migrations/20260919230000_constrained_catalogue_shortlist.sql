-- Constraint-aware shortlist for Discover refinement.
--
-- As the viewer says what they want, Discover narrows the catalogue. Every hard constraint the
-- preference state holds is pushed into this function, so a row that could never be shown is
-- filtered here instead of being shipped to the application and discarded:
--
--   min_runtime / max_runtime   inclusive minutes
--   min_year / max_year         inclusive release years
--   exclude_genres              genre slugs the viewer refused
--   exclude_ids                 titles the viewer turned down
--
-- A bound never matches a missing value: a title with no runtime is not "under two hours", and
-- one with no release date is not "from the nineties". Unknown is not permission.
--
-- include_genres carries the genres the viewer asked for. It restricts the shortlist to titles
-- with at least one of them and orders by how many they carry, so the best matches in the
-- whole catalogue are shortlisted rather than the best among the most popular.
--
-- The function keeps its name and its first three arguments, so an unrefined search is the
-- same call as before. It still returns one page of only the columns Discover maps, now with
-- original_language, and never more than 48 rows.

-- Genres as slugs ("Science Fiction" -> science_fiction), matching the application's vocabulary,
-- so a filter is an indexed array overlap instead of string matching on every row.
alter table public.catalogue_titles
  add column if not exists genre_slugs text[]
  generated always as (
    string_to_array(replace(replace(lower(coalesce(genres, '')), ', ', ','), ' ', '_'), ',')
  ) stored;

create index if not exists catalogue_titles_genre_slugs_idx
  on public.catalogue_titles using gin (genre_slugs);

-- The three-argument form is replaced, not overloaded: two candidates with defaulted arguments
-- would make a three-argument call ambiguous.
drop function if exists public.search_catalogue_titles(text, integer, integer);

create function public.search_catalogue_titles(
  search text default '',
  page_number integer default 1,
  page_size integer default 24,
  min_runtime integer default null,
  max_runtime integer default null,
  min_year integer default null,
  max_year integer default null,
  include_genres text[] default null,
  exclude_genres text[] default null,
  exclude_ids bigint[] default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Plan each call for the arguments it actually has, so a text search keeps its index and an
-- unfiltered browse is not planned as if every filter were present.
set plan_cache_mode = force_custom_plan
as $$
declare
  term text := left(btrim(coalesce(search, '')), 120);
  page_limit integer := least(greatest(coalesce(page_size, 24), 1), 48);
  page_offset integer := (least(greatest(coalesce(page_number, 1), 1), 100) - 1) * page_limit;
  wanted text[] := coalesce(include_genres[1:19], '{}');
  refused text[] := coalesce(exclude_genres[1:19], '{}');
  turned_down bigint[] := coalesce(exclude_ids[1:100], '{}');
  earliest date := case when min_year is null then null
                        else make_date(least(greatest(min_year, 1), 9999), 1, 1) end;
  before_date date := case when max_year is null then null
                           else make_date(least(greatest(max_year, 1), 9998) + 1, 1, 1) end;
  english_query tsquery;
  simple_query tsquery;
  match_total bigint;
  page_items jsonb;
begin
  -- Titles and genres are indexed with the 'simple' configuration and plot text with
  -- 'english', so a term is matched in both forms and ranked by whichever scores higher.
  if term <> '' then
    english_query := websearch_to_tsquery('english', term);
    simple_query := websearch_to_tsquery('simple', term);
  end if;

  with matches as materialized (
    select c.id, c.popularity,
           case when term = '' then 0
                else greatest(ts_rank(c.document, english_query), ts_rank(c.document, simple_query))
           end as rank,
           case when cardinality(wanted) = 0 then 0
                else (select count(*) from unnest(c.genre_slugs) g where g = any(wanted))
           end as affinity
      from public.catalogue_titles c
     where (term = '' or c.document @@ english_query or c.document @@ simple_query)
       and (min_runtime is null or c.runtime >= greatest(min_runtime, 1))
       and (max_runtime is null or (c.runtime >= 1 and c.runtime <= max_runtime))
       and (earliest is null or c.release_date >= earliest)
       and (before_date is null or c.release_date < before_date)
       and (cardinality(wanted) = 0 or c.genre_slugs && wanted)
       and not (c.genre_slugs && refused)
       and not (c.id = any(turned_down))
  ),
  page as (
    select m.id, m.affinity, m.rank, m.popularity
      from matches m
     order by m.affinity desc, m.rank desc, m.popularity desc, m.id
     limit page_limit offset page_offset
  )
  select (select count(*) from matches),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'title', c.title, 'release_date', c.release_date, 'runtime', c.runtime,
           'poster_path', c.poster_path, 'backdrop_path', c.backdrop_path,
           'overview', c.overview, 'genres', c.genres, 'original_language', c.original_language
         ) order by p.affinity desc, p.rank desc, p.popularity desc, p.id), '[]'::jsonb)
    into match_total, page_items
    from page p
    join public.catalogue_titles c on c.id = p.id;

  return jsonb_build_object('total', match_total, 'items', page_items);
end;
$$;

revoke all on function public.search_catalogue_titles(
  text, integer, integer, integer, integer, integer, integer, text[], text[], bigint[]
) from public, anon;
grant execute on function public.search_catalogue_titles(
  text, integer, integer, integer, integer, integer, integer, text[], text[], bigint[]
) to authenticated;

-- PostgREST caches function signatures; reload so the new arguments are callable at once.
notify pgrst, 'reload schema';
