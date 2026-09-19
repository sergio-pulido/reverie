-- Ranked, paginated catalogue search for Discover.
--
-- PostgREST filters can match `document` but cannot order by relevance, so ranking lives
-- here. The function returns one page and the match count, and only the columns Discover
-- maps: the whole table is never read into the application, and no row leaves the database
-- that the page will not render.
--
-- security invoker: the caller's own RLS applies, so this is exactly as visible as the table.

create or replace function public.search_catalogue_titles(
  search text default '',
  page_number integer default 1,
  page_size integer default 24
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  term text := left(btrim(coalesce(search, '')), 120);
  page_limit integer := least(greatest(coalesce(page_size, 24), 1), 48);
  page_offset integer := (least(greatest(coalesce(page_number, 1), 1), 100) - 1) * page_limit;
  english_query tsquery;
  simple_query tsquery;
  match_total bigint;
  page_items jsonb;
begin
  if term = '' then
    select count(*) into match_total from public.catalogue_titles;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'title', t.title, 'release_date', t.release_date, 'runtime', t.runtime,
             'poster_path', t.poster_path, 'backdrop_path', t.backdrop_path,
             'overview', t.overview, 'genres', t.genres
           ) order by t.popularity desc, t.id), '[]'::jsonb)
      into page_items
      from (
        select c.id, c.title, c.release_date, c.runtime, c.poster_path, c.backdrop_path,
               c.overview, c.genres, c.popularity
          from public.catalogue_titles c
         order by c.popularity desc, c.id
         limit page_limit offset page_offset
      ) t;

    return jsonb_build_object('total', match_total, 'items', page_items);
  end if;

  -- Titles and genres are indexed with the 'simple' configuration and plot text with
  -- 'english', so a term is matched in both forms and ranked by whichever scores higher.
  english_query := websearch_to_tsquery('english', term);
  simple_query := websearch_to_tsquery('simple', term);

  with matches as materialized (
    select c.id, c.popularity,
           greatest(ts_rank(c.document, english_query), ts_rank(c.document, simple_query)) as rank
      from public.catalogue_titles c
     where c.document @@ english_query or c.document @@ simple_query
  ),
  page as (
    select m.id, m.rank, m.popularity
      from matches m
     order by m.rank desc, m.popularity desc, m.id
     limit page_limit offset page_offset
  )
  select (select count(*) from matches),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'title', c.title, 'release_date', c.release_date, 'runtime', c.runtime,
           'poster_path', c.poster_path, 'backdrop_path', c.backdrop_path,
           'overview', c.overview, 'genres', c.genres
         ) order by p.rank desc, p.popularity desc, p.id), '[]'::jsonb)
    into match_total, page_items
    from page p
    join public.catalogue_titles c on c.id = p.id;

  return jsonb_build_object('total', match_total, 'items', page_items);
end;
$$;

revoke all on function public.search_catalogue_titles(text, integer, integer) from public, anon;
grant execute on function public.search_catalogue_titles(text, integer, integer) to authenticated;
