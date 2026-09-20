import type { EscapeProgress } from "./state";

/**
 * What a participant's screen is allowed to know about an escape room.
 *
 * Everything here is either scenario state, the room's own vote, or the
 * status of a generation this server actually started. There is no field a
 * screen can fill in with a plausible number, which is the point: the panel
 * that draws this is not permitted to invent a count, a player or a bar.
 */

export type SegmentStatus =
  | "absent"
  | "generating"
  | "ready"
  | "failed"
  /**
   * It was generated, and this server does not have it any more. A server
   * with no object storage keeps only the most recent segments, so a long
   * session loses its oldest shots; saying so beats a `ready` that 404s.
   */
  | "forgotten"
  /** No fal key or the live flag is off: this server cannot generate at all. */
  | "not_configured"
  /** The session ended before this could be generated. Nothing was sent. */
  | "session_over";

export interface SegmentView {
  status: SegmentStatus;
  /** Where this server serves it from. Null unless it is ready. */
  src: string | null;
  /** The clip's own measured length, not the length that was asked for. */
  seconds: number | null;
  /** Why it is not ready, in words a participant can read. */
  message: string | null;
}

export type BeatOutcome = "advanced" | "failed" | "impossible";

export interface BeatView {
  id: string;
  turn: number;
  /** The winning proposal, or null for the beat that opens the room. */
  proposal: { body: string; authorName: string } | null;
  outcome: BeatOutcome;
  /**
   * What this beat reads as. For an outcome that advanced the world it is
   * prose; for one that did not, it is the stated reason it did not, which
   * is the same sentence said once rather than carried twice.
   */
  narration: string;
  /** Whether the prose came from the model or from the scenario's author. */
  narrationSource: "nebius" | "scenario";
  changes: readonly string[];
  media: SegmentView;
  at: string;
}

export interface ProposalView {
  id: string;
  authorName: string;
  body: string;
  votes: number;
}

export interface TurnView {
  index: number;
  proposals: readonly ProposalView[];
  /** The proposal this viewer voted for, if any. */
  yourVote: string | null;
  /** How many people have voted this turn. */
  voters: number;
}

export type EndReason = "goal";

export interface EscapeSnapshot {
  jamId: string;
  scenarioId: string;
  title: string;
  logline: string;
  characterName: string;
  location: { id: string; name: string; description: string };
  /** The looping shot for the location the character is in. */
  loop: SegmentView;
  progress: EscapeProgress;
  turn: TurnView;
  beats: readonly BeatView[];
  ended: { reason: EndReason; tell: string } | null;
  /** False when this server has no object storage: segments die with it. */
  mediaDurable: boolean;
}
