import { DIRECTOR_MIN_SESSION_SECONDS } from "./providers/falDirector";

/**
 * Server-owned lifetime accounting for Director sessions.
 *
 * Director holds a live provider stream open, so a session nobody closes keeps
 * generating until something stops it. A session is therefore given a hard
 * lifetime and reclaimed when its viewers stop checking in, because the
 * alternative is a stream that outlives the browser tab that opened it.
 *
 * This ledger counts sessions and seconds, never money: the demo does not
 * track what generation costs (docs/DECISIONS.md).
 */

/** A session is abandoned if it has not been renewed within this window. */
export const SESSION_IDLE_TIMEOUT_MS = 90_000;

export interface DirectorSessionLimits {
  maxConcurrentSessions: number;
  maxSessionSeconds: number;
}

export function resolveDirectorLimits(
  env: NodeJS.ProcessEnv,
): DirectorSessionLimits {
  return {
    maxConcurrentSessions: Math.max(
      1,
      Math.floor(positiveNumber(env.REVERIE_DIRECTOR_MAX_SESSIONS, 1)),
    ),
    // Two minutes is long enough for a take and short enough that an
    // abandoned stream stops on its own. A higher ceiling is an explicit
    // choice.
    maxSessionSeconds: Math.max(
      DIRECTOR_MIN_SESSION_SECONDS,
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
}

export class DirectorSessionLedger {
  private readonly sessions = new Map<string, OpenSession>();
  private readonly closedListeners = new Set<(sessionId: string) => void>();
  private counter = 0;

  constructor(
    private readonly limits: DirectorSessionLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Called whenever a session settles or is reclaimed, so every owner can
   * release the provider stream and media workers attached to this ledger.
   * A subscription rather than a constructor callback keeps an injected,
   * process-wide ledger usable by the router that owns those resources.
   */
  onClosed(listener: (sessionId: string) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  private notifyClosed(sessionId: string): void {
    for (const listener of this.closedListeners) listener(sessionId);
  }

  open(streamKey: string): OpenSession | SessionRefusal {
    this.expireIdle();
    // The per-configuration check comes first so the caller is told the
    // specific reason: with a single concurrent slot, "too many streams" would
    // otherwise mask "this configuration already has one" and send a client
    // off retrying instead of attaching to the stream that exists.
    for (const session of this.sessions.values()) {
      // One stream per configuration: a second would open a second provider
      // stream for one audience watching the same thing.
      if (session.streamKey === streamKey) return "already_open";
    }
    if (this.sessions.size >= this.limits.maxConcurrentSessions) {
      return "too_many_sessions";
    }
    this.counter += 1;
    const at = this.now();
    const session: OpenSession = {
      sessionId: `${at.toString(36)}-${this.counter.toString(36)}`,
      streamKey,
      startedAt: at,
      lastSeenAt: at,
      viewers: new Map(),
    };
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
   * Drops a session that never started, without announcing a close.
   *
   * Only for a handshake fal refused: no stream exists on their side and none
   * was attached on ours, so there is nothing for the close listeners to tear
   * down. A session that opened must go through `close` instead.
   */
  release(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false;
    return true;
  }

  /** Ends a session and tells every owner to tear its stream down. */
  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.forget(session);
    return true;
  }

  private forget(session: OpenSession): void {
    this.sessions.delete(session.sessionId);
    this.notifyClosed(session.sessionId);
  }

  /** Reclaims sessions whose viewers stopped checking in. */
  expireIdle(): void {
    const at = this.now();
    const cutoff = at - SESSION_IDLE_TIMEOUT_MS;
    for (const session of [...this.sessions.values()]) {
      // The configured ceiling is a hard lifetime, not a soft one: an
      // actively renewing viewer cannot extend a session past it.
      if (at - session.startedAt >= this.limits.maxSessionSeconds * 1000) {
        this.forget(session);
        continue;
      }
      for (const [viewerId, seenAt] of [...session.viewers]) {
        if (seenAt <= cutoff) session.viewers.delete(viewerId);
      }
      // One viewer still checking in keeps the stream, because somebody is
      // still watching it. A session with none falls back to its own clock,
      // which covers the moment between opening and the first viewer attaching.
      if (session.viewers.size > 0) continue;
      if (session.lastSeenAt <= cutoff) this.forget(session);
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
