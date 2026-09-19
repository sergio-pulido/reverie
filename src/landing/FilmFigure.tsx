import type { ReactNode } from "react";
import type { LandingFilm } from "./films";

/** TMDB's w342 posters are 342×513; the attributes give the frame its ratio before any bytes arrive. */
const POSTER_WIDTH = 342;
const POSTER_HEIGHT = 513;

type FilmFigureProps = { film: LandingFilm; loading: "eager" | "lazy"; className?: string; badge?: ReactNode };

/**
 * A real catalogue film: its poster, its title and its year and genre. The 2:3 frame holds its
 * space whether or not the image arrives, and the poster is decorative (`alt=""`) because the
 * caption names the film, so a poster that fails to load leaves only the empty frame.
 */
export function FilmFigure({ film, loading, className, badge }: FilmFigureProps) {
  return <figure className={className}>
    <div className="landing-poster">
      <img src={film.poster} alt="" width={POSTER_WIDTH} height={POSTER_HEIGHT} loading={loading} decoding="async" />
      {badge}
    </div>
    <figcaption className="landing-film-title">{film.title}</figcaption>
    <div className="landing-film-meta">{film.meta}</div>
  </figure>;
}
