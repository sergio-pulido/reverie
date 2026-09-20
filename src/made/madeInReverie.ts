import { useEffect, useState } from "react";
import type { JamRoom } from "../core/room";
import { safeMessageOf } from "../lib/errors";
import { listJams } from "../lib/jams";
import { DEFAULT_STARTED_KIND, readStartedKind, type StartedKind } from "../lib/startedKinds";

/**
 * What has been made in Reverie: the public rooms this viewer can read.
 *
 * "Public" is the room's own `visibility`, which is what decides whether anyone but its members
 * may be in it. What this list is NOT is every public room there is: `jams` is readable only by
 * a room's host or its members (the "participants read their own jams" policy), and there is no
 * policy granting a browser any wider read. So this is the public work this identity is part of,
 * and the screens that show it say so rather than implying a public gallery.
 *
 * Nor does it claim a playable film. A jam's script lives in the process that generated it and
 * its clips live in private buckets the browser cannot reach, so what a room has produced is
 * reported as the room's own state and nothing more.
 */

export type MadeFilm = {
  jamId: string;
  slug: string;
  title: string;
  premise: string;
  /** Which of the three it was started as, as far as this browser knows. */
  kind: StartedKind;
  /** The room's own state, which is all this can honestly say about what it has produced. */
  status: JamRoom["status"];
};

export type MadeState =
  | { phase: "loading" }
  | { phase: "ready"; films: readonly MadeFilm[] }
  | { phase: "error"; safeMessage: string };

export function madeFilmsFrom(jams: readonly JamRoom[]): MadeFilm[] {
  return jams
    .filter((jam) => jam.visibility === "public")
    .map((jam) => ({
      jamId: jam.id,
      slug: jam.slug,
      title: jam.title,
      premise: jam.premise,
      kind: readStartedKind(jam.id) ?? DEFAULT_STARTED_KIND,
      status: jam.status,
    }));
}

/** What a room has produced, as far as anything readable from a browser can say. */
export function producedLine(film: MadeFilm): string {
  if (film.status === "completed") return "Finished.";
  if (film.status === "closed") return "Closed.";
  if (film.status === "live" || film.status === "paused") return "Being made now.";
  return "Started, not finished.";
}

/** The public rooms, read once. `enabled` false leaves it loading and reads nothing. */
export function useMadeInReverie(enabled = true): MadeState {
  const [state, setState] = useState<MadeState>({ phase: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void listJams()
      .then((registry) => {
        if (active) setState({ phase: "ready", films: madeFilmsFrom(registry.jams) });
      })
      .catch((cause: unknown) => {
        if (active) setState({ phase: "error", safeMessage: safeMessageOf(cause, "What has been made here could not be loaded.") });
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  return state;
}

/** Said whenever the list is empty, on the home and in Catalog alike. */
export const NOTHING_MADE_YET = "Nothing has been made here yet. A public Movie Jam, Director session or escape room shows up here as soon as there is one.";
