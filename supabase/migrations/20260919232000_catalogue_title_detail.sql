-- One full catalogue record, for a film's own page.
--
-- search_catalogue_titles stays lean: it returns only what a poster grid renders. A film page
-- needs the rest of the record (tagline, rating, original title, languages, keywords, IMDb id),
-- and pays for it with exactly one row, looked up by primary key. The list query is never
-- widened to carry fields that only this page shows.
--
-- Returns null when no title has that id. Internal columns (the search document, genre slugs,
-- popularity) are not part of the record and are not returned.
--
-- security invoker: the caller's own RLS applies, so this is exactly as visible as the table.

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
           'imdb_id', c.imdb_id
         )
    from public.catalogue_titles c
   where c.id = title_id;
$$;

revoke all on function public.get_catalogue_title(bigint) from public, anon;
grant execute on function public.get_catalogue_title(bigint) to authenticated;
