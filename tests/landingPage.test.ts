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
    "Director (next)",
    "Movie Jam",
    "Discover",
    "Community (next)",
    "The loop",
    "Final CTA",
  ]);
});

test("every call to action opens something that exists: the home, Discover or the door", () => {
  const external = hrefs(markup).filter((href) => !href.startsWith("#"));
  assert.deepEqual([...new Set(external)].sort(), ["/about", "/create", "/discover", "/home"]);
  assert.deepEqual([...new Set(hrefs(markup).filter((href) => href.startsWith("#")))].sort(), ["#discover", "#top"]);
  // "Open Reverie" opens Reverie: the app's own home, never one screen inside it.
  for (const match of markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>Open Reverie/g)) assert.equal(match[1], "/home");
  assert.equal([...markup.matchAll(/>Open Reverie/g)].length, 3);
  // Only the one that says so leads to Discover.
  for (const match of markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>Ask it what to watch/g)) assert.equal(match[1], "/discover");
});

test("Director and Community are marked as not yet available and have no button", () => {
  for (const label of ["Director (next)", "Community (next)"]) {
    const html = section(label);
    assert.match(html, /Next · not yet available/, label);
    assert.doesNotMatch(html, /<a |<button/, label);
  }
  assert.match(text(section("Final CTA")), /Director and Community are next, and are not available yet\./);
});

test("the two invented shorts are labelled generated and never drawn as real posters", () => {
  const community = section("Community (next)");
  assert.equal([...community.matchAll(/>Generated</g)].length, 2);
  for (const name of ["The Lamp Unlit", "Sunday, Gently"]) {
    assert.ok(text(community).includes(name), name);
    assert.equal(markup.split(name).length - 1, 2, `${name} appears only as its tile and caption`);
  }
  const generatedFigures = community.split("<figure").slice(1).filter((figure) => figure.includes(">Generated<"));
  assert.equal(generatedFigures.length, 2);
  for (const figure of generatedFigures) assert.doesNotMatch(figure, /<img/);
  assert.doesNotMatch(text(markup), /\bGenerated\b.*\bGenerated\b.*\bGenerated\b/);
});

test("the real films are the catalogue's, with their posters, beside the generated shorts", () => {
  const community = section("Community (next)");
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
  assert.doesNotMatch(section("Discover") + section("Community (next)"), /loading="eager"/);
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
  assert.equal([...empty.matchAll(/>Generated</g)].length, 2);
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
