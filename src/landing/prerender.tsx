import { renderToStaticMarkup } from "react-dom/server";
import type { LandingFilms } from "./films";
import { LandingPage } from "./LandingPage";

/** The landing's markup, rendered once by the build so `/` paints without any JavaScript. */
export function renderLanding(films: LandingFilms): string {
  return renderToStaticMarkup(<LandingPage films={films} />);
}
