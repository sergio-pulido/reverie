import { DISCOVER_PATH, HOME_PATH } from "../lib/routes";

/**
 * "Open Reverie": the app's own home. Opening Reverie is arriving in it, not arriving in one
 * of its screens — Discover is a destination inside the app, reached from the bar like any
 * other, and sending the front door's main call to action there skipped the home entirely.
 */
export const APP_URL = HOME_PATH;

/** "Ask it what to watch": Discover, because that is the thing being asked for. */
export const DISCOVER_URL = DISCOVER_PATH;

/** "Start a Movie Jam": the jam registry, where a room is started. Movie Jam is live. */
export const JAM_URL = "/jams";
