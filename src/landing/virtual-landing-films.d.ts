/** The landing's catalogue films, read when the app is built (see `scripts/landing-plugin.ts`). */
declare module "virtual:landing-films" {
  const films: import("./films").LandingFilms;
  export default films;
}
