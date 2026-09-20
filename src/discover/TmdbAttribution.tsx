/** Shown whenever TMDB records are on screen, even if a response omits its own attribution. */
export const TMDB_ATTRIBUTION_FALLBACK =
  "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.";

/**
 * The TMDB credit, at the foot of any screen showing TMDB records or images.
 *
 * TMDB's terms require it wherever their data is shown, so every such screen renders it and
 * none of them hides it behind a link. It is the page's own footer, in the flow, scrolling
 * with the content: fixed across the bottom it was a four-line banner on a phone, sitting over
 * the shelf it was crediting.
 */
export function TmdbAttribution({ text = TMDB_ATTRIBUTION_FALLBACK }: { text?: string }) {
  return (
    <footer className="discover-attribution">
      <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
      {text}
    </footer>
  );
}
