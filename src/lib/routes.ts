/**
 * Pathname matching for the app. There is no router: each screen is an exact path, and a few
 * carry one parameter segment (`/jams/:slug`, `/discover/:id`). Pure, so it is testable without
 * a browser.
 */

export type Screen = "home" | "discover" | "jams" | "create" | "join" | "script" | "studio";

const DISCOVER_FILM = /^\/discover\/([^/]+)\/?$/;
const JAM_SLUG = /^\/jams\/([a-z0-9-]+)$/;
/** A film id in a URL is the provider's positive integer id: no sign, no leading zero. */
const FILM_ID = /^[1-9]\d{0,11}$/;

export function screenFromPath(pathname: string): Screen {
  if (pathname === "/discover" || pathname === "/discover/" || DISCOVER_FILM.test(pathname)) return "discover";
  if (pathname === "/jams") return "jams";
  if (pathname === "/jams/new") return "create";
  if (pathname === "/join") return "join";
  if (pathname.startsWith("/jams/")) return "studio";
  return "home";
}

export function jamSlugFromPath(pathname: string) {
  const match = pathname.match(JAM_SLUG);
  return match?.[1] === "new" ? null : match?.[1] ?? null;
}

/**
 * The film a `/discover/:id` path names. `null` means the grid. A segment that is not a film id
 * is returned as `{ invalid: true }` so the page can say the film is not there, rather than
 * silently showing the grid under a URL that names something else.
 */
export type FilmRoute = { id: string } | { invalid: true } | null;

export function filmFromPath(pathname: string): FilmRoute {
  const match = pathname.match(DISCOVER_FILM);
  if (!match) return null;
  return FILM_ID.test(match[1]) ? { id: match[1] } : { invalid: true };
}

export function filmPath(providerId: string) {
  if (!FILM_ID.test(providerId)) throw new RangeError("A film path needs a provider id.");
  return `/discover/${providerId}`;
}

export const DISCOVER_PATH = "/discover";
