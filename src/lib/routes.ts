/**
 * Pathname matching for the app. There is no router: each screen is an exact path, and a few
 * carry one parameter segment (`/jams/:slug`, `/director/:slug`, `/discover/:id`). Pure, so it is
 * testable without a browser.
 *
 * `/` is the public landing page; the app's own home is `/home`.
 */

export type Screen =
  | "landing"
  | "about"
  | "home"
  | "discover"
  | "catalog"
  | "jams"
  | "create"
  | "newJam"
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
/**
 * The one door. Making a film alone, making one with a room and playing an escape room are
 * three different experiences; this is where you choose between them, and each leads into the
 * flow it already had.
 */
export const CREATE_PATH = "/create";

/**
 * The three ways in, each with a path of its own under the door: `/create/director`,
 * `/create/jam`, `/create/escape`. The way lives in the URL so that a refresh, a shared link
 * or Back lands on the same form it left, rather than on whichever way the app last held in
 * memory. `/jams/new` keeps meaning the jam form, for links already out there.
 */
export const CREATE_WAYS = ["director", "jam", "escape"] as const;
export type CreateWayPath = (typeof CREATE_WAYS)[number];

export function createPath(way: CreateWayPath): string {
  return `${CREATE_PATH}/${way}`;
}

const CREATE_WAY = /^\/create\/(director|jam|escape)\/?$/;

/** Which way a create-form path names, or null when the path is not a create form. */
export function createWayFromPath(pathname: string): CreateWayPath | null {
  const match = CREATE_WAY.exec(pathname);
  if (match) return match[1] as CreateWayPath;
  return pathname === NEW_JAM_PATH ? "jam" : null;
}
export const JOIN_PATH = "/join";
/** The conversation, with a film's own page beneath it at `/discover/:id`. */
export const DISCOVER_PATH = "/discover";
/**
 * The browsable catalogue: a paging poster grid with a title search and the chips that narrow it,
 * and a source switch choosing between the films Reverie reads and the ones made here.
 */
export const CATALOG_PATH = "/catalog";
/**
 * Where what the rooms around you are making used to have a screen of its own.
 *
 * It is no longer a destination. Films made in Reverie belong beside the catalogue's, which is
 * the product's own claim, so they are a shelf on the home and a source filter in Catalog
 * instead of a fifth place to go. The path still resolves, to the home, so a link someone has
 * already shared still lands somewhere.
 */
export const COMMUNITY_PATH = "/community";

/** A path that no longer names a screen, and where a link to it lands now. */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = { [COMMUNITY_PATH]: HOME_PATH };

/** Where `pathname` should be sent instead, or null when it names a screen of its own. */
export function redirectFor(pathname: string): string | null {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return LEGACY_REDIRECTS[normalized] ?? null;
}
/**
 * What Reverie is, what it is built on, and who built it.
 *
 * Deliberately NOT a destination. The bar carries the places you work; About is read once and
 * reached from where a viewer looks for it — the page's footer and the account menu.
 */
export const ABOUT_PATH = "/about";
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
  if (pathname === ABOUT_PATH || pathname === `${ABOUT_PATH}/`) return "about";
  if (pathname === CREATE_PATH || pathname === `${CREATE_PATH}/`) return "create";
  if (pathname === DISCOVER_PATH || pathname === `${DISCOVER_PATH}/` || FILM_PAGE.test(pathname)) return "discover";
  if (pathname === CATALOG_PATH || pathname === `${CATALOG_PATH}/`) return "catalog";
  if (pathname === "/jams") return "jams";
  if (pathname === "/jams/new" || CREATE_WAY.test(pathname)) return "newJam";
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

/**
 * The places the bar leads to. Every screen belongs to exactly one, or to none.
 *
 * `create` is the door where the three ways to make a film are offered; `jam` is Yours,
 * everything you have already started. They are different questions, which is why they are
 * different places.
 */
export type Destination = "home" | "discover" | "catalog" | "create" | "jam";

/**
 * Which of the bar's destinations a screen belongs to, or `null` for a screen that belongs to
 * none: the landing, which carries no bar at all, and About, which carries the bar with nothing
 * on it marked, because it is not one of the places the bar leads.
 */
export function destinationOf(screen: Screen): Destination | null {
  if (screen === "landing" || screen === "about") return null;
  if (screen === "home") return "home";
  if (screen === "discover") return "discover";
  if (screen === "catalog") return "catalog";
  // The door, and the form it opens: both are making something new.
  if (screen === "create" || screen === "newJam") return "create";
  // "director" falls here with the jam screens: a Director session is one way
  // to work on a jam, not a sixth place to go.
  return "jam";
}

export const DESTINATION_PATH: Readonly<Record<Destination, string>> = {
  home: HOME_PATH,
  discover: DISCOVER_PATH,
  catalog: CATALOG_PATH,
  create: CREATE_PATH,
  jam: JAMS_PATH,
};

/** The bar's destinations, in the order a remote walks them. */
export const BAR_DESTINATIONS: readonly Destination[] = ["home", "discover", "catalog", "create", "jam"];
