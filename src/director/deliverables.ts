import type { JamScript } from "../core/script";
import { renderTimedOutline } from "../core/timedOutline";

/**
 * What a Director session can hand you, and what it honestly cannot.
 *
 * Every row states the real state of a real artifact. `absent` is not a
 * disabled button waiting for a feature flag: it means the file does not
 * exist, and the row says why instead of offering to fetch it. Two of the four
 * exist today, one is produced only by running a session, and one has nothing
 * behind it at all.
 */

export type DeliverableState = "ready" | "generating" | "absent";

export interface Deliverable {
  id: string;
  name: string;
  /** What the file is, in one line. */
  detail: string;
  state: DeliverableState;
  /** Where the server serves it. Only ever set on a `ready` row. */
  href?: string;
  /** A file this browser writes from what it already holds. */
  build?: () => { filename: string; text: string; type: string };
  /** Why there is nothing to download. Only ever set off a `ready` row. */
  missing?: string;
}

export interface DeliverableInput {
  jamId: string | null;
  /** The script this server holds for the room; null when it holds none. */
  script: JamScript | null;
  /** Why there is no script, when there is none. */
  scriptMissing: string | null;
  /** A session is running: its video is being made right now. */
  live: boolean;
  /** The recording of a session that ended in this browser. */
  recording: string | null;
  /** False when this server has no storage: a recording dies with the process. */
  recordingDurable: boolean;
}

/** A safe file name from a title: letters, digits and dashes only. */
export function fileStem(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
  return stem || "movie-jam";
}

export function deliverablesOf({
  jamId,
  script,
  scriptMissing,
  live,
  recording,
  recordingDurable,
}: DeliverableInput): Deliverable[] {
  const noScript =
    scriptMissing ?? "This jam has no script on this server, so nothing can be written from it.";

  return [
    {
      id: "script",
      name: "The script",
      detail: "The screenplay as markdown, scene by scene, with each portion's time range.",
      ...(script && jamId
        ? { state: "ready" as const, href: `/api/jams/${jamId}/script.md` }
        : { state: "absent" as const, missing: noScript }),
    },
    {
      id: "timed",
      name: "The timed script",
      detail: "Every beat against the clock: where it starts, how long it runs, what it is.",
      ...(script
        ? {
            state: "ready" as const,
            build: () => ({
              filename: `${fileStem(script.title)}-timed.md`,
              text: renderTimedOutline(script),
              type: "text/markdown;charset=utf-8",
            }),
          }
        : { state: "absent" as const, missing: noScript }),
    },
    {
      id: "audio-description",
      name: "The audio description",
      detail: "A spoken description of what happens on screen, for a viewer who cannot see it.",
      state: "absent",
      missing:
        "Nothing in this build writes one. There is no describer, no narration track and no file — only this row saying so.",
    },
    {
      id: "video",
      name: "The video file",
      detail: "The recording of a Director session, exactly as it was generated.",
      ...videoRow(live, recording, recordingDurable),
    },
  ];
}

function videoRow(
  live: boolean,
  recording: string | null,
  durable: boolean,
): Pick<Deliverable, "state" | "href" | "missing"> {
  if (live) {
    return {
      state: "generating",
      missing: "A session is running. Its recording exists when the session ends.",
    };
  }
  if (recording) {
    return {
      state: "ready",
      href: recording,
      ...(durable
        ? {}
        : {
            missing:
              "This server has no recording storage configured, so this file is held in memory and is lost when the process restarts.",
          }),
    };
  }
  return {
    state: "absent",
    missing: "No Director session has finished in this browser yet, so there is no video to hand over.",
  };
}
