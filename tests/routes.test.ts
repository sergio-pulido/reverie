import assert from "node:assert/strict";
import test from "node:test";
import {
  DESTINATION_PATH,
  HOME_PATH,
  LANDING_PATH,
  DISCOVER_PATH,
  destinationOf,
  filmFromPath,
  filmPath,
  jamSlugFromPath,
  screenFromPath,
} from "../src/lib/routes";

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
  assert.deepEqual(Object.keys(DESTINATION_PATH).sort(), ["discover", "home", "jam"]);
  assert.equal(destinationOf("home"), "home");
  for (const screen of ["jams", "create", "join", "script", "studio"] as const) assert.equal(destinationOf(screen), "jam", screen);
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
