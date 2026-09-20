import assert from "node:assert/strict";
import test from "node:test";
import {
  ABOUT_PATH,
  BAR_DESTINATIONS,
  CREATE_PATH,
  CATALOG_PATH,
  COMMUNITY_PATH,
  DESTINATION_PATH,
  DIRECTOR_PATH,
  HOME_PATH,
  LANDING_PATH,
  DISCOVER_PATH,
  destinationOf,
  redirectFor,
  directorPath,
  directorSlugFromPath,
  filmFromPath,
  filmPath,
  jamSlugFromPath,
  screenFromPath,
  createPath,
  createWayFromPath,
} from "../src/lib/routes";
import { parentPath } from "../src/shell/keys";

test("Discover is its own screen at exactly /discover", () => {
  assert.equal(DISCOVER_PATH, "/discover");
  assert.equal(screenFromPath("/discover"), "discover");
  assert.equal(screenFromPath("/discover/"), "discover");
  assert.equal(filmFromPath("/discover"), null, "the screen itself names no film");
  for (const path of ["/discovery", "/discovers", "/jams/discover"]) {
    assert.notEqual(screenFromPath(path), "discover", path);
  }
});

test("About is its own screen, reached by name, and belongs to no destination", () => {
  assert.equal(ABOUT_PATH, "/about");
  assert.equal(screenFromPath("/about"), "about");
  assert.equal(screenFromPath("/about/"), "about");
  assert.equal(destinationOf("about"), null, "nothing on the bar is marked while it is open");
  assert.equal(BAR_DESTINATIONS.includes("about" as never), false);
  assert.equal(Object.prototype.hasOwnProperty.call(DESTINATION_PATH, "about"), false);
  // It climbs to the home, like every other sibling of the home.
  assert.equal(parentPath("about", false, null), HOME_PATH);
  for (const path of ["/abouts", "/about/us", "/jams/about"]) assert.notEqual(screenFromPath(path), "about", path);
});

test("the door is its own screen at /create, and the jam form sits under it", () => {
  assert.equal(CREATE_PATH, "/create");
  assert.equal(screenFromPath("/create"), "create");
  assert.equal(screenFromPath("/create/"), "create");
  // Back from the form returns to the door that opened it; the door is a sibling of the home.
  assert.equal(parentPath("newJam", false, null), CREATE_PATH);
  assert.equal(parentPath("create", false, null), HOME_PATH);
  for (const path of ["/creates", "/create/new", "/jams/create"]) assert.notEqual(screenFromPath(path), "create", path);
});

test("the landing belongs to no destination either, carrying no bar at all", () => {
  assert.equal(destinationOf("landing"), null);
});

test("the top bar reaches Discover as a destination of its own", () => {
  assert.equal(destinationOf("discover"), "discover");
  assert.equal(DESTINATION_PATH.discover, "/discover");
  assert.deepEqual(Object.keys(DESTINATION_PATH).sort(), ["catalog", "create", "discover", "home", "jam"]);
  assert.equal(destinationOf("home"), "home");
  for (const screen of ["jams", "join", "script", "studio", "director"] as const) assert.equal(destinationOf(screen), "jam", screen);
});

test("a Director session is its own screen at /director/:slug", () => {
  assert.equal(DIRECTOR_PATH, "/director");
  assert.equal(screenFromPath("/director/the-salt-door-91af20cd"), "director");
  assert.equal(directorSlugFromPath("/director/the-salt-door-91af20cd"), "the-salt-door-91af20cd");
  assert.equal(directorPath("the-salt-door-91af20cd"), "/director/the-salt-door-91af20cd");
});

test("only a slug segment makes a Director session; the bare path and deeper ones do not", () => {
  for (const path of ["/director", "/director/", "/director/a/b", "/director/A-B", "/directors/x"]) {
    assert.notEqual(screenFromPath(path), "director", path);
    assert.equal(directorSlugFromPath(path), null, path);
  }
});

test("a Director session belongs to Movie Jam, and adds no sixth destination", () => {
  assert.equal(destinationOf("director"), "jam");
  assert.equal(BAR_DESTINATIONS.length, 5);
  assert.equal(BAR_DESTINATIONS.includes("director" as never), false);
  assert.equal(Object.prototype.hasOwnProperty.call(DESTINATION_PATH, "director"), false);
});

test("Back from a Director session leads to the Movie Jam list", () => {
  assert.equal(parentPath("director", false, null), "/jams");
});

test("a film page lives beneath the screen it belongs to", () => {
  assert.equal(screenFromPath("/discover/27205"), "discover");
  assert.deepEqual(filmFromPath("/discover/27205"), { id: "27205" });
  assert.deepEqual(filmFromPath("/discover/27205/"), { id: "27205" });
});

test("a segment that is not a film id is named invalid, not quietly shown as something else", () => {
  for (const path of ["/discover/abc", "/discover/0", "/discover/-3", "/discover/012", "/discover/1.5", "/discover/1234567890123"]) {
    assert.equal(screenFromPath(path), "discover", path);
    assert.deepEqual(filmFromPath(path), { invalid: true }, path);
  }
});

test("only one parameter segment is matched", () => {
  assert.equal(filmFromPath("/discover/27205/cast"), null);
  assert.equal(screenFromPath("/discover/27205/cast"), "home");
  assert.equal(filmFromPath("/jams/27205"), null);
});

test("a film path round-trips through filmPath", () => {
  assert.equal(filmPath("27205"), "/discover/27205");
  assert.deepEqual(filmFromPath(filmPath("603")), { id: "603" });
  assert.throws(() => filmPath("cat:27205"), RangeError);
  assert.throws(() => filmPath("../jams"), RangeError);
});

test("the root is the public landing page and the app's home moves to /home", () => {
  assert.equal(LANDING_PATH, "/");
  assert.equal(HOME_PATH, "/home");
  assert.equal(screenFromPath(LANDING_PATH), "landing");
  assert.equal(screenFromPath(HOME_PATH), "home");
  assert.equal(filmFromPath(LANDING_PATH), null);
  assert.equal(jamSlugFromPath(LANDING_PATH), null);
});

test("only the exact root is the landing page", () => {
  for (const path of ["//", "/?", "/index.html", "/landing"]) assert.notEqual(screenFromPath(path), "landing", path);
});

test("the existing screens still resolve as before", () => {
  assert.equal(screenFromPath("/jams"), "jams");
  assert.equal(screenFromPath("/jams/new"), "newJam");
  assert.equal(screenFromPath("/join"), "join");
  assert.equal(screenFromPath("/jams/night-swim-4k2"), "studio");
  assert.equal(jamSlugFromPath("/jams/night-swim-4k2"), "night-swim-4k2");
  assert.equal(jamSlugFromPath("/jams/new"), null);
  assert.equal(screenFromPath("/elsewhere"), "home");
});

test("Catalog is a screen of its own, at exactly its path", () => {
  assert.equal(CATALOG_PATH, "/catalog");
  assert.equal(screenFromPath("/catalog"), "catalog");
  assert.equal(screenFromPath("/catalog/"), "catalog");
  assert.equal(filmFromPath("/catalog"), null, "it names no film");
  for (const path of ["/catalogue", "/catalogs", "/jams/catalog", "/discover/catalog"]) {
    assert.notEqual(screenFromPath(path), "catalog", path);
  }
});

test("the bar's destinations are Home, Discover, Catalog, Create, Yours, in that order", () => {
  assert.deepEqual([...BAR_DESTINATIONS], ["home", "discover", "catalog", "create", "jam"]);
  assert.deepEqual(BAR_DESTINATIONS.map((id) => DESTINATION_PATH[id]), ["/home", "/discover", "/catalog", "/create", "/jams"]);
  assert.equal(destinationOf("catalog"), "catalog");
  // The door and the form beneath it are one destination: making something new.
  assert.equal(destinationOf("create"), "create");
  assert.equal(destinationOf("newJam"), "create");
});

test("Community is not a destination, and its path lands on the home instead of nowhere", () => {
  assert.equal(COMMUNITY_PATH, "/community");
  assert.equal(BAR_DESTINATIONS.includes("community" as never), false);
  assert.equal(Object.prototype.hasOwnProperty.call(DESTINATION_PATH, "community"), false);
  assert.equal(redirectFor(COMMUNITY_PATH), HOME_PATH, "a shared link still lands");
  assert.equal(redirectFor("/community/"), HOME_PATH, "with or without its trailing slash");
  for (const path of ["/communities", "/community/x", "/catalog"]) assert.equal(redirectFor(path), null, path);
});

test("Catalog goes back to the home, as Discover does", () => {
  for (const screen of ["catalog", "discover"] as const) {
    assert.equal(parentPath(screen, false, null), HOME_PATH, screen);
  }
});

test("nothing redirects to or away from Catalog", () => {
  // `screenFromPath` is the whole of the mapping: each path answers its own screen and no other.
  assert.equal(screenFromPath(CATALOG_PATH), "catalog");
  assert.equal(redirectFor(CATALOG_PATH), null);
  assert.equal(DESTINATION_PATH.catalog, CATALOG_PATH);
});

test("each way in has a path of its own under the door, and /jams/new still means the jam form", () => {
  assert.equal(screenFromPath("/create/director"), "newJam");
  assert.equal(screenFromPath("/create/jam"), "newJam");
  assert.equal(screenFromPath("/create/escape"), "newJam");
  assert.equal(screenFromPath("/create/other"), "home", "only the three ways are forms; anything else is not a screen");
  assert.equal(createWayFromPath("/create/director"), "director");
  assert.equal(createWayFromPath("/create/escape/"), "escape");
  assert.equal(createWayFromPath("/jams/new"), "jam");
  assert.equal(createWayFromPath("/create"), null);
  assert.equal(createPath("director"), "/create/director");
});
