import assert from "node:assert/strict";
import test from "node:test";
import {
  BAR_DESTINATIONS,
  CATALOG_PATH,
  COMMUNITY_PATH,
  DESTINATION_PATH,
  DIRECTOR_PATH,
  HOME_PATH,
  LANDING_PATH,
  DISCOVER_PATH,
  destinationOf,
  directorPath,
  directorSlugFromPath,
  filmFromPath,
  filmPath,
  jamSlugFromPath,
  screenFromPath,
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

test("the top bar reaches Discover as a destination of its own", () => {
  assert.equal(destinationOf("discover"), "discover");
  assert.equal(DESTINATION_PATH.discover, "/discover");
  assert.deepEqual(Object.keys(DESTINATION_PATH).sort(), ["catalog", "community", "discover", "home", "jam"]);
  assert.equal(destinationOf("home"), "home");
  for (const screen of ["jams", "create", "join", "script", "studio"] as const) assert.equal(destinationOf(screen), "jam", screen);
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
  assert.equal(screenFromPath("/jams/new"), "create");
  assert.equal(screenFromPath("/join"), "join");
  assert.equal(screenFromPath("/jams/night-swim-4k2"), "studio");
  assert.equal(jamSlugFromPath("/jams/night-swim-4k2"), "night-swim-4k2");
  assert.equal(jamSlugFromPath("/jams/new"), null);
  assert.equal(screenFromPath("/elsewhere"), "home");
});

test("Catalog and Community are screens of their own, at exactly their paths", () => {
  assert.equal(CATALOG_PATH, "/catalog");
  assert.equal(COMMUNITY_PATH, "/community");
  assert.equal(screenFromPath("/catalog"), "catalog");
  assert.equal(screenFromPath("/catalog/"), "catalog");
  assert.equal(screenFromPath("/community"), "community");
  assert.equal(screenFromPath("/community/"), "community");
  // Neither names a film, and neither swallows a neighbouring path.
  assert.equal(filmFromPath("/catalog"), null);
  assert.equal(filmFromPath("/community"), null);
  for (const path of ["/catalogue", "/catalogs", "/jams/catalog", "/communities", "/discover/catalog"]) {
    assert.notEqual(screenFromPath(path), "catalog", path);
    assert.notEqual(screenFromPath(path), "community", path);
  }
});

test("the bar's destinations are Home, Discover, Catalog, Movie Jam, Community, in that order", () => {
  assert.deepEqual([...BAR_DESTINATIONS], ["home", "discover", "catalog", "jam", "community"]);
  assert.deepEqual(BAR_DESTINATIONS.map((id) => DESTINATION_PATH[id]), ["/home", "/discover", "/catalog", "/jams", "/community"]);
  assert.equal(destinationOf("catalog"), "catalog");
  assert.equal(destinationOf("community"), "community");
});

test("Catalog and Community go back to the home, as Discover does", () => {
  for (const screen of ["catalog", "community", "discover"] as const) {
    assert.equal(parentPath(screen, false, null), HOME_PATH, screen);
  }
});

test("nothing redirects to or away from Catalog or Community", () => {
  // `screenFromPath` is the whole of the mapping: each path answers its own screen and no other.
  assert.equal(screenFromPath(CATALOG_PATH), "catalog");
  assert.equal(screenFromPath(COMMUNITY_PATH), "community");
  assert.equal(DESTINATION_PATH.catalog, CATALOG_PATH);
  assert.equal(DESTINATION_PATH.community, COMMUNITY_PATH);
});
