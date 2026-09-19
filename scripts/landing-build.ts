// What the landing plugin runs during a build or dev server. The plugin loads this module
// through Vite's module runner rather than importing it, so the Vite config itself imports
// nothing from the repository beyond the plugin.

export { readLandingFilms } from "./landing-films";
export { NO_LANDING_FILMS } from "../src/landing/films";
export { renderLanding } from "../src/landing/prerender";
