import { useEffect, useState } from "react";
import type { Jam } from "../core/jam";
import { safeMessageOf } from "../lib/errors";
import { openJam, type JamPersistence } from "../lib/jams";
import type { JamRoom } from "../core/room";

/**
 * The room a `/director/:slug` path names, and the script it is made of.
 *
 * The two come from different places and fail differently, which is why they
 * are reported separately. The room is a Supabase row (or this browser's own
 * preview registration). The script is generated and held by the long-lived
 * Node server, so a room opened against a server that never generated it — a
 * different process, a restart, a serverless deployment — has a room and no
 * script. That is a real state, and the screen says so rather than drawing an
 * empty film as though it were a new one.
 */

export type FilmState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      room: JamRoom;
      isHost: boolean;
      persistence: JamPersistence;
      /** Null when this server holds no script for the room. */
      jam: Jam | null;
      /** Why there is no script, when there is none. */
      scriptMissing: string | null;
    };

export function useDirectorFilm(slug: string | null): FilmState {
  const [state, setState] = useState<FilmState>({ phase: "loading" });

  useEffect(() => {
    if (!slug) {
      setState({ phase: "error", message: "That is not a Director session." });
      return;
    }
    let active = true;

    void (async () => {
      let opened;
      try {
        opened = await openJam(slug);
      } catch (error) {
        if (active) {
          setState({ phase: "error", message: safeMessageOf(error, "This jam could not be opened.") });
        }
        return;
      }
      if (!active) return;

      // The room resolved; the script is a separate question, and not having
      // one is a state to show rather than a failure to open the screen.
      let jam: Jam | null = null;
      let scriptMissing: string | null = null;
      try {
        const response = await fetch(`/api/jams/${opened.jam.id}`);
        if (response.ok) jam = ((await response.json()) as { jam: Jam }).jam;
        else if (response.status === 404) {
          scriptMissing = "This server holds no script for this jam. Scripts live in the process that generated them, so a restart or a different host loses them.";
        } else scriptMissing = "The script could not be read from this server.";
      } catch {
        scriptMissing = "The script could not be read from this server.";
      }
      if (!active) return;
      setState({
        phase: "ready",
        room: opened.jam,
        isHost: opened.isHost,
        persistence: opened.persistence,
        jam,
        scriptMissing,
      });
    })();

    return () => {
      active = false;
    };
  }, [slug]);

  return state;
}
