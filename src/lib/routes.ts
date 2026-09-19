/**
 * Pathname matching for the app. There is no router: each screen is an exact path, and a few
 * carry one parameter segment (`/jams/:slug`, `/discover/:id`). Pure, so it is testable without
 * a browser.
 */

export type Screen = "home" | "search" | "jams" | "create" | "join" | "script" | "studio";

const FILM_PAGE = /^\/discover\/([^/]+)\/?$/;
const JAM_SLUG = /^\/jams\/([a-z0-9-]+)$/;
/** A film id in a URL is the provider's positive integer id: no sign, no leading zero. */
const FILM_ID = /^[1-9]\d{0,11}$/;

export const HOME_PATH = "/";
export const SEARCH_PATH = "/search";
export const JAMS_PATH = "/jams";
export const NEW_JAM_PATH = "/jams/new";
export const JOIN_PATH = "/join";
/** Leads to search; a film's page lives beneath it, at `/discover/:id`. */
export const DISCOVER_PATH = "/discover";

/**
 * A film page is a layer over the screen it was opened from, so its path belongs to the search
 * screen (the layer's own screen when it is reached by URL). The home draws it over itself when
 * the film was opened from there.
 */
export function screenFromPath(pathname: string): Screen {
  const moved = movedPath(pathname);
  if (moved) return screenFromPath(moved);
  if (pathname === SEARCH_PATH || pathname === `${SEARCH_PATH}/` || FILM_PAGE.test(pathname)) return "search";
  if (pathname === "/jams") return "jams";
  if (pathname === "/jams/new") return "create";
  if (pathname === "/join") return "join";
  if (pathname.startsWith("/jams/")) return "studio";
  return "home";
}

/**
 * A path that has moved, and where it lives now, so an old link or bookmark keeps working:
 * `/discover` leads to `/search`. `null` for every path that has not moved.
 */
export function movedPath(pathname: string): string | null {
  return pathname === DISCOVER_PATH || pathname === `${DISCOVER_PATH}/` ? SEARCH_PATH : null;
}

export function jamSlugFromPath(pathname: string) {
  const match = pathname.match(JAM_SLUG);
  return match?.[1] === "new" ? null : match?.[1] ?? null;
}

/**
 * The film a `/discover/:id` path names. `null` means no film. A segment that is not a film id
 * is returned as `{ invalid: true }` so the page can say the film is not there, rather than
 * silently showing something else under a URL that names a film.
 */
export type FilmRoute = { id: string } | { invalid: true } | null;

export function filmFromPath(pathname: string): FilmRoute {
  const match = pathname.match(FILM_PAGE);
  if (!match) return null;
  return FILM_ID.test(match[1]) ? { id: match[1] } : { invalid: true };
}

export function filmPath(providerId: string) {
  if (!FILM_ID.test(providerId)) throw new RangeError("A film path needs a provider id.");
  return `${DISCOVER_PATH}/${providerId}`;
}

/** The places the top bar leads to. Every screen belongs to exactly one. */
export type Destination = "home" | "search" | "jam";

export function destinationOf(screen: Screen): Destination {
  if (screen === "home") return "home";
  if (screen === "search") return "search";
  return "jam";
}

export const DESTINATION_PATH: Readonly<Record<Destination, string>> = {
  home: HOME_PATH,
  search: SEARCH_PATH,
  jam: JAMS_PATH,
};
