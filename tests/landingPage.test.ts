import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NO_LANDING_FILMS, type LandingFilm, type LandingFilms } from "../src/landing/films";
import { renderLanding } from "../src/landing/prerender";
import { APP_SHELL, landingDocument } from "../scripts/landing-plugin";

const film = (id: number, title = `Film ${id}`): LandingFilm => ({
  id: String(id),
  title,
  meta: "2023 · Drama",
  poster: `https://image.tmdb.org/t/p/w342/poster-${id}.jpg`,
});

const films: LandingFilms = {
  shelf: Array.from({ length: 12 }, (_, index) => film(index + 1)),
  picks: [film(40, "Inside Out"), film(41, "The Lion King"), film(42), film(43)],
  community: [film(50, "The Flash"), film(51, "After Everything")],
};

const markup = renderLanding(films);

/** Each `<section>` with its screen label, in document order. */
function sections(html: string) {
  return html.split("<section").slice(1).map((chunk) => ({
    label: /data-screen-label="([^"]+)"/.exec(chunk)?.[1],
    html: chunk.slice(0, chunk.indexOf("</section>")),
  }));
}

const section = (label: string) => sections(markup).find((candidate) => candidate.label === label)!.html;
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("the seven sections are there, in order", () => {
  assert.deepEqual(sections(markup).map((candidate) => candidate.label), [
    "Hero",
    "Director",
    "Movie Jam",
    "Discover",
    "Made in Reverie",
    "The loop",
    "Final CTA",
  ]);
});

test("every call to action opens something that exists: the home, Discover or the door", () => {
  const external = hrefs(markup).filter((href) => !href.startsWith("#"));
  assert.deepEqual([...new Set(external)].sort(), ["/about", "/catalog", "/create", "/discover", "/home"]);
  assert.deepEqual([...new Set(hrefs(markup).filter((href) => href.startsWith("#")))].sort(), ["#discover", "#top"]);
  // "Open Reverie" opens Reverie: the app's own home, never one screen inside it.
  for (const match of markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>Open Reverie/g)) assert.equal(match[1], "/home");
  assert.equal([...markup.matchAll(/>Open Reverie/g)].length, 3);
  // Only the one that says so leads to Discover.
  for (const match of markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>Ask it what to watch/g)) assert.equal(match[1], "/discover");
});

test("nothing on the page says a part of Reverie is unavailable", () => {
  // The two sections that used to carry the badge, and the page as a whole.
  for (const label of ["Director", "Made in Reverie"]) {
    assert.doesNotMatch(section(label), /not yet available/, label);
  }
  assert.doesNotMatch(text(markup), /not yet available|not available yet|is being built|coming soon/i);
  assert.match(text(section("Final CTA")), /Everything on this page is open today/);
});

test("all four things the page describes are marked live and each offers a way in", () => {
  const ways: Readonly<Record<string, string>> = {
    Director: "/create",
    "Movie Jam": "/create",
    Discover: "/discover",
    "Made in Reverie": "/catalog",
  };
  for (const [label, way] of Object.entries(ways)) {
    const html = section(label);
    assert.match(html, /class="landing-label landing-live"/, `${label} is marked live`);
    assert.ok(hrefs(html).includes(way), `${label} leads to ${way}`);
  }
  // Every section that names one of the four says "Live now", and only those four do.
  assert.equal([...markup.matchAll(/>Live now · /g)].length, 4);
});

test("the loop's four steps are the four that work, and none is labelled next", () => {
  const loop = text(section("The loop"));
  for (const name of ["Director", "Movie Jam", "Made in Reverie", "Discover"]) assert.ok(loop.includes(name), name);
  assert.doesNotMatch(loop, /\bNext\b/);
  assert.doesNotMatch(loop, /\bCommunity\b/);
});

test("the two invented shorts are labelled placeholders, in words as well as on the tile", () => {
  const made = section("Made in Reverie");
  assert.equal([...made.matchAll(/>Placeholder</g)].length, 2);
  for (const name of ["The Lamp Unlit", "Sunday, Gently"]) {
    assert.ok(text(made).includes(name), name);
    assert.equal(markup.split(name).length - 1, 2, `${name} appears only as its tile and caption`);
  }
  const placeholders = made.split("<figure").slice(1).filter((figure) => figure.includes(">Placeholder<"));
  assert.equal(placeholders.length, 2);
  for (const figure of placeholders) assert.doesNotMatch(figure, /<img/);
  assert.doesNotMatch(text(markup), /\bPlaceholder\b.*\bPlaceholder\b.*\bPlaceholder\b/);
  // And the section says so in a sentence, so the tag is not the only thing carrying it.
  assert.match(text(made), /placeholders, not films anybody made/);
  // The page never claims the app tags made work "generated": it does not.
  assert.doesNotMatch(text(markup), /\bgenerated\b/i);
});

test("the real films are the catalogue's, with their posters, beside the placeholders", () => {
  const community = section("Made in Reverie");
  assert.deepEqual([...community.matchAll(/<img [^>]*src="([^"]+)"/g)].map((match) => match[1]), [
    "https://image.tmdb.org/t/p/w342/poster-50.jpg",
    "https://image.tmdb.org/t/p/w342/poster-51.jpg",
  ]);
  const order = ["The Flash", "The Lamp Unlit", "After Everything", "Sunday, Gently"].map((name) => text(community).indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("every poster's space is reserved before it loads, and only the hero shelf loads eagerly", () => {
  const images = [...markup.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
  assert.equal(images.length, 12 + 4 + 2);
  for (const image of images) {
    assert.match(image, /width="342"/);
    assert.match(image, /height="513"/);
    assert.match(image, /alt=""/);
  }
  assert.equal(section("Hero").match(/loading="eager"/g)?.length, 12);
  assert.doesNotMatch(section("Discover") + section("Made in Reverie"), /loading="eager"/);
});

test("the Discover illustration marks its first two films as top picks", () => {
  const discover = section("Discover");
  assert.equal(discover.match(/>Top pick</g)?.length, 2);
  assert.ok(text(discover).indexOf("Top pick") < text(discover).indexOf("Inside Out"));
});

test("the only figures on the page are the true ones and the illustrations' own", () => {
  // Longest first, so "Film 1" does not leave the "0" of "Film 10" behind.
  const filmWords = [...films.shelf, ...films.picks, ...films.community]
    .flatMap((item) => [item.title, item.meta])
    .sort((a, b) => b.length - a.length);
  const copy = filmWords.reduce((remaining, words) => remaining.split(words).join(" "), text(markup));
  const numbers = [...copy.matchAll(/\d[\d,:.]*/g)].map((match) => match[0].replace(/[.,]$/, ""));
  assert.deepEqual(numbers.sort(), [
    "01", "01", "02", "03", "04", // the loop's steps, and "Back to 01"
    "0:14", // the illustrated voice note
    "27,839", "27,839", // films in the catalogue, stated twice
    "3", // "Scene 3" in the illustrated screenplay
    "4", "4", // "4 in the room", "4 titles match": the illustrations' own counts
  ].sort());
  assert.match(text(section("Final CTA")), /Built over one weekend · Barcelona/);
});

test("the TMDB attribution is on the page", () => {
  assert.ok(text(markup).includes(
    "Film data and images from TMDB (themoviedb.org). This product uses TMDB data but is not endorsed or certified by TMDB.",
  ));
});

test("without catalogue films the page shows no film rows and invents none", () => {
  const empty = renderLanding(NO_LANDING_FILMS);
  assert.doesNotMatch(empty, /<img/);
  assert.doesNotMatch(empty, /Films in the catalogue/);
  assert.doesNotMatch(empty, /Top pick/);
  assert.equal([...empty.matchAll(/>Placeholder</g)].length, 2);
  assert.deepEqual(sections(empty).map((candidate) => candidate.label), sections(markup).map((candidate) => candidate.label));
});

test("Vercel and the production server serve the app shell under the name the build writes", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { rewrites: { destination: string }[] };
  assert.deepEqual(vercel.rewrites.map((rewrite) => rewrite.destination), [`/${APP_SHELL}`]);
  const server = readFileSync(new URL("../apps/server/index.ts", import.meta.url), "utf8");
  assert.match(server, new RegExp(`"dist", "${APP_SHELL.replace(".", "\\.")}"`));
});

test("the static document carries the markup and its stylesheet, and no script", () => {
  const html = landingDocument({ markup, stylesheets: ["/assets/landing.css"] });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/landing\.css" \/>/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/image\.tmdb\.org" \/>/);
  assert.match(html, /<title>Reverie — Tonight, make a film\.<\/title>/);
  assert.ok(html.includes(markup));
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /rel="preload" href=/);
});
