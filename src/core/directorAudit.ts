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
  | "provider_error"
  | "session_closed";

export interface DirectorAuditEntry {
  readonly at: string;
  readonly kind: DirectorAuditKind;
  /** fal's per-session version for the direction this entry concerns. */
  readonly promptVersion?: number;
  /** Where in the stream it took effect, when fal says. */
  readonly chunkIndex?: number;
  /** The proposal this direction came from, when it came from one. */
  readonly proposalId?: string;
  /** Who asked for it. Absent for provider-originated entries. */
  readonly authorId?: string;
  /** The direction text exactly as it was sent to fal. */
  readonly body?: string;
  readonly detail?: string;
}

/** Bounded so one long session cannot grow without limit in memory. */
export const MAX_AUDIT_ENTRIES_PER_SESSION = 500;

export class DirectorAuditLog {
  private readonly entries: DirectorAuditEntry[] = [];
  private dropped = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<DirectorAuditEntry, "at">): DirectorAuditEntry {
    const stored: DirectorAuditEntry = { ...entry, at: this.now().toISOString() };
    this.entries.push(stored);
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

  /**
   * Resolves a direction's outcome by its prompt version. `pending` means fal
   * has neither applied nor refused it yet, which is a real state and not an
   * error: a direction takes effect at the next undispatched chunk.
   */
  outcomeOf(promptVersion: number): "applied" | "rejected" | "pending" {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.promptVersion !== promptVersion) continue;
      if (entry.kind === "direction_applied") return "applied";
      if (entry.kind === "direction_rejected") return "rejected";
    }
    return "pending";
  }
}
