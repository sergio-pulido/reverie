import { DIRECTOR_MIN_BILLED_SECONDS } from "./providers/falDirector";

/**
 * Server-owned accounting for Director sessions.
 *
 * Director is the only thing this server starts that bills for *time*, with a
 * 60-second minimum per session whether or not anyone watches. So a session is
 * treated like a reservation: opening one debits its worst-case cost up front,
 * and closing it refunds the difference between that and what it actually ran.
 * A session nobody closes expires on its own, because the alternative is a
 * budget that leaks whenever a browser tab dies.
 */

/** fal's list price per generated second; the promotional rate is lower. */
export const DEFAULT_USD_PER_SECOND = 0.08;
/** A session is abandoned if it has not been renewed within this window. */
export const SESSION_IDLE_TIMEOUT_MS = 90_000;

export interface DirectorSessionLimits {
  /** Total spend this process may commit to Director. */
  budgetUsd: number;
  usdPerSecond: number;
  maxConcurrentSessions: number;
  maxSessionSeconds: number;
}

export function resolveDirectorLimits(
  env: NodeJS.ProcessEnv,
): DirectorSessionLimits {
  return {
    budgetUsd: positiveNumber(env.FAL_ASSET_BUDGET_USD, 0),
    usdPerSecond: positiveNumber(
      env.REVERIE_DIRECTOR_USD_PER_SECOND,
      DEFAULT_USD_PER_SECOND,
    ),
    maxConcurrentSessions: Math.max(
      1,
      Math.floor(positiveNumber(env.REVERIE_DIRECTOR_MAX_SESSIONS, 1)),
    ),
    // 120s reserves $9.60 at list price, so two streams still fit the $20
    // budget the project ships with. A higher ceiling is an explicit choice.
    maxSessionSeconds: Math.max(
      DIRECTOR_MIN_BILLED_SECONDS,
      Math.floor(
        positiveNumber(env.REVERIE_DIRECTOR_MAX_SESSION_SECONDS, 120),
      ),
    ),
  };
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type SessionRefusal =
  | "budget_exhausted"
  | "too_many_sessions"
  | "already_open";

export interface OpenSession {
  sessionId: string;
  jamId: string;
  startedAt: number;
  lastSeenAt: number;
  reservedUsd: number;
}

export class DirectorSessionLedger {
  private readonly sessions = new Map<string, OpenSession>();
  private spentUsd = 0;
  private counter = 0;

  constructor(
    private readonly limits: DirectorSessionLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Worst-case cost of a session that runs to its allowed limit. */
  private reservationUsd(): number {
    return this.limits.maxSessionSeconds * this.limits.usdPerSecond;
  }

  /** Cost of a session that ran `seconds`, honouring the billed minimum. */
  private billedUsd(seconds: number): number {
    return (
      Math.max(DIRECTOR_MIN_BILLED_SECONDS, Math.ceil(seconds)) *
      this.limits.usdPerSecond
    );
  }

  get committedUsd(): number {
    return this.spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limits.budgetUsd - this.spentUsd);
  }

  open(jamId: string): OpenSession | SessionRefusal {
    this.expireIdle();
    // The per-jam check comes first so the caller is told the specific reason:
    // with a single concurrent slot, "too many streams" would otherwise mask
    // "this jam already has one" and send a client off retrying.
    for (const session of this.sessions.values()) {
      // One stream per jam: a second would bill twice for one room.
      if (session.jamId === jamId) return "already_open";
    }
    if (this.sessions.size >= this.limits.maxConcurrentSessions) {
      return "too_many_sessions";
    }
    const reservedUsd = this.reservationUsd();
    if (this.spentUsd + reservedUsd > this.limits.budgetUsd) {
      return "budget_exhausted";
    }
    this.counter += 1;
    const at = this.now();
    const session: OpenSession = {
      sessionId: `${at.toString(36)}-${this.counter.toString(36)}`,
      jamId,
      startedAt: at,
      lastSeenAt: at,
      reservedUsd,
    };
    this.spentUsd += reservedUsd;
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /** Keeps a live session from being reclaimed as abandoned. */
  renew(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.lastSeenAt = this.now();
    return true;
  }

  /**
   * Cancels a session that never started, refunding the whole reservation.
   *
   * Only for a handshake fal refused: no session existed on their side, so
   * billing it the 60-second minimum would charge the budget for nothing. A
   * session that opened must go through `close` instead.
   */
  release(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.spentUsd -= session.reservedUsd;
    this.sessions.delete(sessionId);
    return true;
  }

  /** Settles a session: the reservation is replaced by what it actually ran. */
  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.settle(session);
    return true;
  }

  private settle(session: OpenSession): void {
    const ranSeconds = (this.now() - session.startedAt) / 1000;
    const billed = Math.min(session.reservedUsd, this.billedUsd(ranSeconds));
    this.spentUsd = this.spentUsd - session.reservedUsd + billed;
    this.sessions.delete(session.sessionId);
  }

  /**
   * Reclaims sessions whose client stopped checking in. They are settled at
   * their full reservation, not at elapsed time: the server cannot know that
   * fal actually stopped generating, and guessing low would understate spend.
   */
  expireIdle(): void {
    const cutoff = this.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const session of [...this.sessions.values()]) {
      if (session.lastSeenAt <= cutoff) this.sessions.delete(session.sessionId);
    }
  }

  get openCount(): number {
    return this.sessions.size;
  }

  find(sessionId: string): OpenSession | undefined {
    return this.sessions.get(sessionId);
  }
}
