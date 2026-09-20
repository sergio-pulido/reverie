/**
 * The audit trail for a live director session.
 *
 * Every direction that reaches fal, and every verdict fal returns, is recorded
 * here. That is the reason the server is the WebRTC peer at all: if the
 * browser talked to fal directly there would be no record of what was asked
 * for, by whom, or what came back.
 *
 * Deliberately append-only and stream-specific. The proposal that produced a
 * direction is owned by `jam_proposals` (author, body, decision, timestamps);
 * duplicating it here would create a second, divergent account of the same
 * event. What is recorded is what only this side knows: which prompt version
 * carried it, whether fal applied or refused it, and where in the stream it
 * landed.
 */

export type DirectorAuditKind =
  | "session_opened"
  | "direction_sent"
  | "direction_applied"
  | "direction_rejected"
  | "chunk_received"
  /**
   * Beats of the script handed to the provider mid-session.
   *
   * The script is not given all at once: each chunk is followed by the beats
   * of the chunk after it, read from the story as it stands right then. This
   * is the entry that says which beats fal was given and when — and therefore
   * which version of them it was given, since a beat below the boundary can no
   * longer change.
   */
  | "beats_sent"
  | "provider_error"
  /**
   * The provider has generated the whole film. NOT an ending: generation runs
   * far ahead of playback — a measured 20s film existed 17s after Play, before
   * a viewer could have seen half of it — so this is a fact about the provider,
   * and the take goes on until the film has been watched to its end.
   */
  | "film_generated"
  | "session_closed";

export interface DirectorAuditEntry {
  readonly at: string;
  readonly kind: DirectorAuditKind;
  /** fal's per-session version for the direction this entry concerns. */
  readonly promptVersion?: number;
  /** Where in the stream it took effect, when fal says. */
  readonly chunkIndex?: number;
  /**
   * Where that chunk sat on the SCRIPT's clock. Recorded because "which beat
   * was playing when this was sent" is the question an audit gets asked, and
   * it cannot be reconstructed from the chunk index alone.
   */
  readonly scriptOffsetSeconds?: number;
  /** The proposal this direction came from, when it came from one. */
  readonly proposalId?: string;
  /** The outline beat it rewrites, when it rewrites one. */
  readonly beatIndex?: number;
  /** Who asked for it. Absent for provider-originated entries. */
  readonly authorId?: string;
  /** The direction text exactly as it was sent to fal. */
  readonly body?: string;
  /**
   * Free text for the kinds that carry one: the provider's error, the
   * archive's container, and on `session_closed` why the take ended, when the
   * caller said. A stop nobody pressed is worth being able to tell from one
   * somebody did.
   */
  readonly detail?: string;
}

/** Bounded so one long session cannot grow without limit in memory. */
export const MAX_AUDIT_ENTRIES_PER_SESSION = 500;

/**
 * Notified as each entry is recorded, so the trail can outlive the process.
 *
 * Deliberately fire-and-forget from the log's point of view: the in-memory
 * trail is the one the live session reads, and a durable write that fails or
 * hangs must not stall the stream it is describing.
 */
export type DirectorAuditListener = (entry: DirectorAuditEntry) => void;

/** Whether fal applied, refused, or has not yet answered a direction. */
export type DirectionOutcome = "applied" | "rejected" | "pending";

/**
 * Resolves a direction's outcome by its prompt version, reading backwards so
 * the latest verdict wins. `pending` is a real state, not an error: a
 * direction takes effect at the next undispatched chunk.
 *
 * A free function because the trail is read in two places that do not share a
 * type — the log the server appends to, and the plain array a browser is
 * given — and two copies of this rule would eventually answer differently.
 */
export function outcomeOf(
  entries: readonly DirectorAuditEntry[],
  promptVersion: number,
): DirectionOutcome {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.promptVersion !== promptVersion) continue;
    if (entry.kind === "direction_applied") return "applied";
    if (entry.kind === "direction_rejected") return "rejected";
  }
  return "pending";
}

export class DirectorAuditLog {
  private readonly entries: DirectorAuditEntry[] = [];
  private dropped = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly onRecord?: DirectorAuditListener,
  ) {}

  record(entry: Omit<DirectorAuditEntry, "at">): DirectorAuditEntry {
    const stored: DirectorAuditEntry = { ...entry, at: this.now().toISOString() };
    this.entries.push(stored);
    try {
      this.onRecord?.(stored);
    } catch {
      // A listener that throws loses this entry durably, not the session. The
      // bounded in-memory trail below is unaffected either way.
    }
    if (this.entries.length > MAX_AUDIT_ENTRIES_PER_SESSION) {
      // The oldest go first, and the count of what was dropped is kept: a
      // truncated log that does not say it was truncated is a misleading one.
      this.entries.shift();
      this.dropped += 1;
    }
    return stored;
  }

  /** Everything recorded, oldest first. */
  all(): readonly DirectorAuditEntry[] {
    return this.entries;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** The directions actually sent, for the "what was asked for" view. */
  directions(): readonly DirectorAuditEntry[] {
    return this.entries.filter((entry) => entry.kind === "direction_sent");
  }

  /** This log's answer to `outcomeOf`, over the entries it still holds. */
  outcomeOf(promptVersion: number): DirectionOutcome {
    return outcomeOf(this.entries, promptVersion);
  }
}
