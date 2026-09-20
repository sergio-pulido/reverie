import { FalBudget } from "./falBudget";
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
 *
 * The budget itself is shared (./falBudget): beat generation spends the same
 * FAL_ASSET_BUDGET_USD, so a room streaming and a room generating beats cannot
 * between them commit twice the total the server was given.
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
  /**
   * `<jamId>:<configurationKey>`. One paid stream per distinct configuration
   * in a room, not one per viewer — everyone on the same configuration shares
   * it (docs/specs/configuration-keyed-streams.md).
   */
  streamKey: string;
  startedAt: number;
  lastSeenAt: number;
  reservedUsd: number;
}

export class DirectorSessionLedger {
  private readonly sessions = new Map<string, OpenSession>();
  private readonly settlers = new Map<string, (actualUsd: number) => void>();
  private counter = 0;
  private readonly budget: FalBudget;

  constructor(
    private readonly limits: DirectorSessionLimits,
    private readonly now: () => number = () => Date.now(),
    budget?: FalBudget,
  ) {
    this.budget = budget ?? new FalBudget(limits.budgetUsd);
  }

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
    return this.budget.spentUsd;
  }

  get remainingUsd(): number {
    return this.budget.remainingUsd;
  }

  open(streamKey: string): OpenSession | SessionRefusal {
    this.expireIdle();
    // The per-configuration check comes first so the caller is told the
    // specific reason: with a single concurrent slot, "too many streams" would
    // otherwise mask "this configuration already has one" and send a client
    // off retrying instead of attaching to the stream that exists.
    for (const session of this.sessions.values()) {
      // One stream per configuration: a second would bill twice for one
      // audience watching the same thing.
      if (session.streamKey === streamKey) return "already_open";
    }
    if (this.sessions.size >= this.limits.maxConcurrentSessions) {
      return "too_many_sessions";
    }
    const reservedUsd = this.reservationUsd();
    const settle = this.budget.reserve(reservedUsd);
    if (!settle) return "budget_exhausted";
    this.counter += 1;
    const at = this.now();
    const session: OpenSession = {
      sessionId: `${at.toString(36)}-${this.counter.toString(36)}`,
      streamKey,
      startedAt: at,
      lastSeenAt: at,
      reservedUsd,
    };
    this.settlers.set(session.sessionId, settle);
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
    this.settlers.get(sessionId)?.(0);
    this.settlers.delete(sessionId);
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
    this.settlers.get(session.sessionId)?.(this.billedUsd(ranSeconds));
    this.settlers.delete(session.sessionId);
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
      if (session.lastSeenAt > cutoff) continue;
      // Settled at the full reservation, not at elapsed time: the server cannot
      // know fal stopped generating, and guessing low would understate spend.
      this.settlers.get(session.sessionId)?.(session.reservedUsd);
      this.settlers.delete(session.sessionId);
      this.sessions.delete(session.sessionId);
    }
  }

  get openCount(): number {
    return this.sessions.size;
  }

  find(sessionId: string): OpenSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** The open session serving a configuration, so viewers can attach to it. */
  findByStreamKey(streamKey: string): OpenSession | undefined {
    this.expireIdle();
    for (const session of this.sessions.values()) {
      if (session.streamKey === streamKey) return session;
    }
    return undefined;
  }
}
