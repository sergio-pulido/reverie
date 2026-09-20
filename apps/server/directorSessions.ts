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
  /**
   * Viewer id to the last time that viewer checked in.
   *
   * A stream is shared, so "is anyone still watching?" cannot be answered by a
   * single timestamp: with one clock, any one viewer's renewal keeps the stream
   * alive for a room that has emptied, and the last viewer leaving does not end
   * it — it stops being renewed and is reclaimed 90 seconds later, billing the
   * whole time. Counting viewers is what makes the shared stream's lifetime
   * match the audience it actually has.
   */
  viewers: Map<string, number>;
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
  private spentUsd = 0;
  private counter = 0;

  constructor(
    private readonly limits: DirectorSessionLimits,
    private readonly now: () => number = () => Date.now(),
    /**
     * Called for every session the ledger reclaims or settles, so the caller
     * can stop the stream it was paying for. Reclaim happens inside `open` and
     * `findByStreamKey` as well as on an explicit sweep, and a stream left
     * running after its session is gone keeps billing with nobody watching.
     */
    private readonly onClosed: (sessionId: string) => void = () => {},
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
    if (this.spentUsd + reservedUsd > this.limits.budgetUsd) {
      return "budget_exhausted";
    }
    this.counter += 1;
    const at = this.now();
    const session: OpenSession = {
      sessionId: `${at.toString(36)}-${this.counter.toString(36)}`,
      streamKey,
      startedAt: at,
      lastSeenAt: at,
      reservedUsd,
      viewers: new Map(),
    };
    this.spentUsd += reservedUsd;
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Registers one viewer on a stream and returns the id it checks in under.
   *
   * Viewers are identified by the server, not by the browser: an id a client
   * chose could collide with another viewer's and make two people look like
   * one, which would end a stream somebody was still watching.
   */
  attach(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.counter += 1;
    const at = this.now();
    const viewerId = `v${at.toString(36)}-${this.counter.toString(36)}`;
    session.viewers.set(viewerId, at);
    session.lastSeenAt = at;
    return viewerId;
  }

  /**
   * Stops counting one viewer, and reports whether anyone is left.
   *
   * The last viewer leaving is the signal to settle: waiting for the idle
   * timeout instead would bill 90 seconds of a stream nobody is watching.
   */
  detach(sessionId: string, viewerId: string): { remaining: number } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.viewers.delete(viewerId);
    return { remaining: session.viewers.size };
  }

  /** How many viewers are currently counted on a session. */
  viewerCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.viewers.size ?? 0;
  }

  /**
   * Keeps a live session from being reclaimed as abandoned.
   *
   * A viewer id renews that viewer specifically; without one this only refreshes
   * the session, which is what a caller with no viewer of its own — the server
   * itself, sending a direction — should do.
   */
  renew(sessionId: string, viewerId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const at = this.now();
    if (viewerId !== undefined) {
      // An unknown viewer id is not re-admitted here: attaching is what admits
      // a viewer, and silently recreating one would resurrect a viewer that
      // was dropped as stale.
      //
      // The session clock is refreshed only AFTER that check, and the order is
      // the whole point. A backgrounded tab whose timer was throttled past the
      // cutoff keeps calling renew with an id that has been dropped; bumping
      // `lastSeenAt` first would let those calls hold a viewerless session
      // open through the very fallback that exists to reclaim it, and bill for
      // it indefinitely.
      if (!session.viewers.has(viewerId)) return false;
      session.viewers.set(viewerId, at);
    }
    session.lastSeenAt = at;
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
    this.onClosed(session.sessionId);
  }

  /**
   * Reclaims sessions whose client stopped checking in. They are settled at
   * their full reservation, not at elapsed time: the server cannot know that
   * fal actually stopped generating, and guessing low would understate spend.
   */
  expireIdle(): void {
    const at = this.now();
    const cutoff = at - SESSION_IDLE_TIMEOUT_MS;
    for (const session of [...this.sessions.values()]) {
      // The configured ceiling is a real spend limit, not only the number used
      // to reserve budget. An actively renewing viewer cannot extend a paid
      // session past the amount the ledger committed for it.
      if (at - session.startedAt >= this.limits.maxSessionSeconds * 1000) {
        this.sessions.delete(session.sessionId);
        this.onClosed(session.sessionId);
        continue;
      }
      for (const [viewerId, seenAt] of [...session.viewers]) {
        if (seenAt <= cutoff) session.viewers.delete(viewerId);
      }
      // One viewer still checking in keeps the stream, because somebody is
      // still watching it. A session with none falls back to its own clock,
      // which covers the moment between opening and the first viewer attaching.
      if (session.viewers.size > 0) continue;
      if (session.lastSeenAt <= cutoff) {
        this.sessions.delete(session.sessionId);
        this.onClosed(session.sessionId);
      }
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
