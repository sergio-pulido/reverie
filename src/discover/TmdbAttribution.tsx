/** Shown whenever TMDB records are on screen, even if a response omits its own attribution. */
export const TMDB_ATTRIBUTION_FALLBACK =
  "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.";

/** The TMDB attribution, fixed to the bottom of any screen showing TMDB records or images. */
export function TmdbAttribution({ text = TMDB_ATTRIBUTION_FALLBACK }: { text?: string }) {
  return (
    <p className="discover-attribution">
      <span className="discover-attribution-mark" aria-hidden="true">TMDB</span>
      {text}
    </p>
  );
}
