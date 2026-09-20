import { ABOUT_PATH, CREATE_PATH, DISCOVER_PATH, HOME_PATH } from "../lib/routes";

/**
 * "Open Reverie": the app's own home. Opening Reverie is arriving in it, not arriving in one
 * of its screens — Discover is a destination inside the app, reached from the bar like any
 * other, and sending the front door's main call to action there skipped the home entirely.
 */
export const APP_URL = HOME_PATH;

/** "Ask it what to watch": Discover, because that is the thing being asked for. */
export const DISCOVER_URL = DISCOVER_PATH;

/**
 * "Start a Movie Jam": the door where the three ways to make a film are offered, Movie Jam
 * among them. It used to be the list of jams, which is where you go back to one, not where
 * you start one.
 */
export const JAM_URL = CREATE_PATH;

/** "About Reverie": what it is, what it runs on and who built it. Not a destination. */
export const ABOUT_URL = ABOUT_PATH;
