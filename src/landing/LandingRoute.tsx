import films from "virtual:landing-films";
import { LandingPage } from "./LandingPage";
import "./landing.css";

/**
 * The landing as the app renders it: in development, and if the app itself ever reaches `/`.
 * A production build serves `/` as static HTML instead (see `scripts/landing-plugin.ts`). It is
 * loaded on demand, so no other screen downloads it, and its stylesheet is its own file.
 */
export default function LandingRoute() {
  return <LandingPage films={films} />;
}
