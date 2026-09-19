/**
 * Pathname matching for the app. There is no router: each screen is an exact path, and a few
 * carry one parameter segment (`/jams/:slug`, `/director/:slug`, `/discover/:id`). Pure, so it is
 * testable without a browser.
 *
 * `/` is the public landing page; the app's own home is `/home`.
 */

export type Screen =
  | "landing"
  | "home"
  | "discover"
  | "catalog"
  | "jams"
  | "community"
  | "create"
  | "join"
  | "script"
  | "studio"
  | "director";

const FILM_PAGE = /^\/discover\/([^/]+)\/?$/;
const JAM_SLUG = /^\/jams\/([a-z0-9-]+)$/;
const DIRECTOR_SLUG = /^\/director\/([a-z0-9-]+)$/;
/** A film id in a URL is the provider's positive integer id: no sign, no leading zero. */
const FILM_ID = /^[1-9]\d{0,11}$/;

export const LANDING_PATH = "/";
export const HOME_PATH = "/home";
export const JAMS_PATH = "/jams";
export const NEW_JAM_PATH = "/jams/new";
export const JOIN_PATH = "/join";
/** The conversation, with a film's own page beneath it at `/discover/:id`. */
export const DISCOVER_PATH = "/discover";
/** The browsable catalogue. A later slice fills it; today it is a placeholder screen. */
export const CATALOG_PATH = "/catalog";
/** What the rooms around you are making. A later slice fills it; today it is a placeholder screen. */
export const COMMUNITY_PATH = "/community";
/**
 * One person directing one film, at `/director/:slug`.
 *
 * It is NOT a sixth top-bar destination. The bar's five already have to fit a 360px screen, and
 * a Director session is a way of working on a jam rather than a place of its own — so it lives
 * under Movie Jam, which is where you start one and where Back returns you.
 */
export const DIRECTOR_PATH = "/director";

export function directorPath(slug: string) {
  return `${DIRECTOR_PATH}/${slug}`;
}

/**
 * A film page is a layer over the screen it was opened from, so its path belongs to the Discover
 * screen (the layer's own screen when it is reached by URL). The home draws it over itself when
 * the film was opened from there.
 */
export function screenFromPath(pathname: string): Screen {
  if (pathname === LANDING_PATH) return "landing";
  if (pathname === DISCOVER_PATH || pathname === `${DISCOVER_PATH}/` || FILM_PAGE.test(pathname)) return "discover";
  if (pathname === CATALOG_PATH || pathname === `${CATALOG_PATH}/`) return "catalog";
  if (pathname === COMMUNITY_PATH || pathname === `${COMMUNITY_PATH}/`) return "community";
  if (pathname === "/jams") return "jams";
  if (pathname === "/jams/new") return "create";
  if (pathname === "/join") return "join";
  if (DIRECTOR_SLUG.test(pathname)) return "director";
  if (pathname.startsWith("/jams/")) return "studio";
  return "home";
}

export function jamSlugFromPath(pathname: string) {
  const match = pathname.match(JAM_SLUG);
  return match?.[1] === "new" ? null : match?.[1] ?? null;
}

/** The jam a `/director/:slug` path names, or null when the path names none. */
export function directorSlugFromPath(pathname: string) {
  return pathname.match(DIRECTOR_SLUG)?.[1] ?? null;
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
export type Destination = "home" | "discover" | "catalog" | "jam" | "community";

export function destinationOf(screen: Screen): Destination {
  // The landing carries no top bar; it answers "home" so the type stays total.
  if (screen === "home" || screen === "landing") return "home";
  if (screen === "discover") return "discover";
  if (screen === "catalog") return "catalog";
  if (screen === "community") return "community";
  // "director" falls here with the jam screens: a Director session is one way
  // to work on a jam, not a sixth place to go.
  return "jam";
}

export const DESTINATION_PATH: Readonly<Record<Destination, string>> = {
  home: HOME_PATH,
  discover: DISCOVER_PATH,
  catalog: CATALOG_PATH,
  jam: JAMS_PATH,
  community: COMMUNITY_PATH,
};

/** The bar's destinations, in the order a remote walks them. */
export const BAR_DESTINATIONS: readonly Destination[] = ["home", "discover", "catalog", "jam", "community"];
