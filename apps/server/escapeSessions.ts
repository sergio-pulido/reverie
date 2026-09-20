import { randomUUID } from "node:crypto";
import { readMp4DurationSeconds } from "../../src/core/mediaDuration";
import { applyOutcome, resolveProposal, type EscapeOutcome } from "../../src/core/escape/rules";
import type { Scenario } from "../../src/core/escape/scenario";
import { findScenario } from "../../src/core/escape/scenarios";
import {
  goalReached,
  openScenario,
  readProgress,
  type EscapeState,
} from "../../src/core/escape/state";
import type {
  BeatView,
  EndReason,
  EscapeSnapshot,
  SegmentStatus,
  SegmentView,
} from "../../src/core/escape/session";
import { narrateBeat } from "./escapeNarrator";
import type { EscapeMediaStore } from "./escapeMedia";
import { resolveNebiusConfig, type NebiusConfig } from "./providers/nebius";
import {
  downloadSegment,
  getSegmentStatus,
  getSegmentUrl,
  resolveFalSegmentConfig,
  submitSegment,
  type FalSegmentConfig,
} from "./providers/falSegments";
import { clampDuration } from "./providers/falSegmentModels";
import { readPositive, type SpendAccount } from "./spendLedger";
import { DEFAULT_USD_PER_SECOND } from "./directorSessions";

/**
 * An escape room in progress: the scenario's state, the turn the room is on,
 * the beats it has played, and the segments this server has generated.
 *
 * The state itself is owned by the pure rules module; nothing here decides
 * what happened. This file does the three things the rules must not: it holds
 * the room's turn, it spends money, and it waits.
 *
 * Latency is the product problem, and the answer is here: a location's idle
 * loop is generated once and played for the rest of the session, and a beat is
 * generated after the vote settles while that loop keeps running. A measured
 * fifteen-second beat takes about twenty-five seconds to become playable
 * (docs/DECISIONS.md), so a beat that arrives late simply means a longer loop,
 * and a beat that never arrives leaves the loop running and says why.
 */

/** A loop only has to be long enough not to read as a stutter. Five seconds
 * is the model's floor: the cheapest and, measured, the fastest to produce. */
export const DEFAULT_LOOP_SECONDS = 5;
const GENERATION_DEADLINE_MS = 5 * 60_000;
const POLL_MS = 3_000;
const MAX_PROPOSALS_PER_TURN = 24;
const MAX_ROOMS = 24;
/**
 * A room nobody has read for this long is over as far as this process is
 * concerned. Rooms are never explicitly closed — a browser tab simply stops
 * polling — so without this the map fills up and the twenty-fifth host is
 * refused forever on a server that is doing nothing.
 */
const ROOM_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_BEATS_KEPT = 60;

export interface EscapeLimits {
  usdPerSecond: number;
  loopSeconds: number;
  maxConcurrentGenerations: number;
}

export function resolveEscapeLimits(env: NodeJS.ProcessEnv): EscapeLimits {
  return {
    // fal's list price per generated second, which never understates the
    // bill. It is a configured rate, not an invoice this repository has seen.
    usdPerSecond: readPositive(env.REVERIE_ESCAPE_USD_PER_SECOND, DEFAULT_USD_PER_SECOND),
    loopSeconds: Math.round(readPositive(env.REVERIE_ESCAPE_LOOP_SECONDS, DEFAULT_LOOP_SECONDS)),
    maxConcurrentGenerations: Math.max(
      1,
      Math.floor(readPositive(env.REVERIE_ESCAPE_MAX_GENERATIONS, 2)),
    ),
  };
}

export interface Proposal {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  at: number;
}

interface Turn {
  index: number;
  proposals: Proposal[];
  /** One effective vote per participant; a second replaces the first. */
  votes: Map<string, string>;
}

interface Segment {
  status: SegmentStatus;
  mediaId: string | null;
  /** The file's own length, once it exists. */
  seconds: number | null;
  message: string | null;
  /** Money held against this generation, refunded if it never reached fal. */
  reservedUsd: number;
}

interface Beat {
  id: string;
  turn: number;
  proposal: { body: string; authorName: string } | null;
  outcome: EscapeOutcome["kind"];
  narration: string;
  narrationSource: "nebius" | "scenario";
  changes: string[];
  segment: Segment;
  at: string;
}

interface Room {
  jamId: string;
  scenario: Scenario;
  state: EscapeState;
  turn: Turn;
  beats: Beat[];
  loops: Map<string, Segment>;
  ended: { reason: EndReason; tell: string } | null;
  openedAt: number;
  /** When anybody last read this room. Idle rooms are reclaimed. */
  lastSeenAt: number;
}

export type OpenRefusal = "unknown_scenario" | "already_open" | "too_many_rooms";
export type SettleRefusal = "no_proposals" | "session_over";

export interface EscapeRoomsOptions {
  media: EscapeMediaStore;
  account: SpendAccount;
  limits?: EscapeLimits;
  /** Null means this server cannot generate; it never pretends otherwise. */
  fal?: FalSegmentConfig | null;
  nebius?: NebiusConfig | null;
  now?: () => number;
  /** Injected in tests so a settle does not wait on a real generation. */
  sleep?: (ms: number) => Promise<void>;
}

function idleSegment(): Segment {
  return { status: "absent", mediaId: null, seconds: null, message: null, reservedUsd: 0 };
}

export class EscapeRooms {
  private readonly rooms = new Map<string, Room>();
  private readonly limits: EscapeLimits;
  private readonly fal: FalSegmentConfig | null;
  private readonly nebius: NebiusConfig | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  /** Every generation in flight, so a test (and a shutdown) can wait them out. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: EscapeRoomsOptions) {
    this.limits = options.limits ?? resolveEscapeLimits(process.env);
    this.fal = options.fal !== undefined ? options.fal : safely(() => resolveFalSegmentConfig(process.env));
    this.nebius = options.nebius !== undefined ? options.nebius : safely(() => resolveNebiusConfig(process.env));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Resolves once nothing is generating. Used by tests and by teardown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  open(jamId: string, scenarioId: string): Room | OpenRefusal {
    this.reclaimIdle();
    if (this.rooms.has(jamId)) return "already_open";
    if (this.rooms.size >= MAX_ROOMS) return "too_many_rooms";
    const scenario = findScenario(scenarioId);
    if (!scenario) return "unknown_scenario";
    const room: Room = {
      jamId,
      scenario,
      state: openScenario(scenario),
      turn: { index: 1, proposals: [], votes: new Map() },
      beats: [],
      loops: new Map(),
      ended: null,
      openedAt: this.now(),
      lastSeenAt: this.now(),
    };
    this.rooms.set(jamId, room);
    this.ensureLoop(room);
    return room;
  }

  has(jamId: string): boolean {
    return this.rooms.has(jamId);
  }

  propose(
    jamId: string,
    input: { authorId: string; authorName: string; body: string },
  ): Proposal | "not_open" | "session_over" | "too_many_proposals" {
    const room = this.rooms.get(jamId);
    if (!room) return "not_open";
    if (room.ended) return "session_over";
    if (room.turn.proposals.length >= MAX_PROPOSALS_PER_TURN) return "too_many_proposals";
    const proposal: Proposal = { id: randomUUID(), ...input, at: this.now() };
    room.turn.proposals.push(proposal);
    return proposal;
  }

  vote(jamId: string, voterId: string, proposalId: string): boolean | "not_open" | "session_over" {
    const room = this.rooms.get(jamId);
    if (!room) return "not_open";
    if (room.ended) return "session_over";
    if (!room.turn.proposals.some((proposal) => proposal.id === proposalId)) return false;
    room.turn.votes.set(voterId, proposalId);
    return true;
  }

  /**
   * Closes the vote: the winner is resolved by the rules, becomes a beat, and
   * is generated. Every other proposal is discarded — the room asked for one
   * thing to happen next, and a queue of stale suggestions against a world
   * that has since moved is worse than nothing.
   */
  settle(jamId: string): Beat | SettleRefusal | "not_open" {
    const room = this.rooms.get(jamId);
    if (!room) return "not_open";
    if (room.ended) return "session_over";
    const winner = chooseWinner(room.turn);
    if (!winner) return "no_proposals";

    const before = room.state;
    const outcome = resolveProposal(room.scenario, before, winner.body);
    room.state = applyOutcome(room.scenario, before, outcome);

    const beat: Beat = {
      id: randomUUID(),
      turn: room.turn.index,
      proposal: { body: winner.body, authorName: winner.authorName },
      outcome: outcome.kind,
      narration: outcome.kind === "advanced" ? outcome.tell : reasonOf(outcome),
      narrationSource: "scenario",
      changes: outcome.kind === "advanced" ? outcome.changes.map((change) => change.summary) : [],
      segment: idleSegment(),
      at: new Date(this.now()).toISOString(),
    };
    room.beats.push(beat);
    if (room.beats.length > MAX_BEATS_KEPT) room.beats.shift();
    room.turn = { index: room.turn.index + 1, proposals: [], votes: new Map() };

    if (outcome.kind === "advanced") {
      // Only an outcome that changed the world is filmed. A refusal already
      // carries the author's sentence, and spending a paid segment on it
      // would shorten the session the room is actually trying to finish.
      this.track(this.produceBeat(room, before, outcome, winner.body, beat));
      this.ensureLoop(room);
    }
    if (goalReached(room.scenario, room.state)) {
      room.ended = { reason: "goal", tell: room.scenario.goal.tell };
    }
    return beat;
  }

  async segmentBytes(jamId: string, mediaId: string) {
    return this.options.media.get(jamId, mediaId);
  }

  snapshot(jamId: string, viewerId: string | null): EscapeSnapshot | null {
    const room = this.rooms.get(jamId);
    if (!room) return null;
    room.lastSeenAt = this.now();
    const location = room.scenario.locations.find((candidate) => candidate.id === room.state.at);
    return {
      jamId,
      scenarioId: room.scenario.id,
      title: room.scenario.title,
      logline: room.scenario.logline,
      characterName: room.scenario.character.name,
      location: {
        id: room.state.at,
        name: location?.name ?? room.state.at,
        description: location?.description ?? "",
      },
      loop: viewOf(jamId, room.loops.get(room.state.at) ?? idleSegment()),
      progress: readProgress(room.scenario, room.state),
      turn: {
        index: room.turn.index,
        proposals: room.turn.proposals.map((proposal) => ({
          id: proposal.id,
          authorName: proposal.authorName,
          body: proposal.body,
          votes: [...room.turn.votes.values()].filter((voted) => voted === proposal.id).length,
        })),
        yourVote: viewerId ? (room.turn.votes.get(viewerId) ?? null) : null,
        voters: room.turn.votes.size,
      },
      beats: room.beats.map((beat) => beatView(jamId, beat)),
      ended: room.ended,
      spend: {
        budgetUsd: this.options.account.budgetUsd,
        committedUsd: round(this.options.account.committedUsd),
        remainingUsd: round(this.options.account.remainingUsd),
      },
      mediaDurable: this.options.media.durable,
    };
  }

  /**
   * Drops rooms nobody has read in half an hour.
   *
   * Only on `open`, because that is the one call a full map can refuse. A
   * generation still in flight for a reclaimed room writes into a segment
   * nothing reads any more, which is harmless — the money was already
   * committed and the clip is already paid for.
   */
  private reclaimIdle(): void {
    const cutoff = this.now() - ROOM_IDLE_TIMEOUT_MS;
    for (const [jamId, room] of [...this.rooms]) {
      if (room.lastSeenAt <= cutoff) this.rooms.delete(jamId);
    }
  }

  /** Starts this location's loop if it has never been asked for. */
  private ensureLoop(room: Room): void {
    const locationId = room.state.at;
    if (room.loops.has(locationId)) return;
    const location = room.scenario.locations.find((candidate) => candidate.id === locationId);
    if (!location) return;
    const segment = idleSegment();
    room.loops.set(locationId, segment);
    this.track(
      this.generate(room, segment, `${room.scenario.look} ${location.loopShot}`, this.limits.loopSeconds),
    );
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * Narrates the beat, then films it. The narration is asked for first
   * because the model writes the shot that is filmed; when it does not
   * answer, the author's own shot is used and the beat says so.
   */
  private async produceBeat(
    room: Room,
    before: EscapeState,
    outcome: Extract<EscapeOutcome, { kind: "advanced" }>,
    proposal: string,
    beat: Beat,
  ): Promise<void> {
    let shot = outcome.shot;
    if (this.nebius) {
      const narration = await narrateBeat(this.nebius, {
        scenario: room.scenario,
        before,
        outcome,
        proposal,
      }).catch(() => null);
      if (narration) {
        beat.narration = narration.narration;
        beat.narrationSource = "nebius";
        shot = narration.shot;
      }
    }
    await this.generate(room, beat.segment, `${room.scenario.look} ${shot}`, outcome.seconds);
  }

  /**
   * One segment, end to end: reserve, submit, wait, download, measure, store.
   *
   * Money is committed before the provider is called. A submit that never
   * reached fal is refunded; anything that failed after fal accepted the
   * request is not, because fal may well have run it.
   */
  private async generate(
    room: Room,
    segment: Segment,
    prompt: string,
    seconds: number,
  ): Promise<void> {
    if (!this.fal) {
      segment.status = "not_configured";
      segment.message = "This server is not configured to generate video, so there is none.";
      return;
    }
    const wanted = clampDuration(this.fal.model, seconds);
    const reservedUsd = wanted * this.limits.usdPerSecond;
    if (!this.options.account.commit(reservedUsd)) {
      segment.status = "ceiling_reached";
      segment.message = "The spend ceiling for this server is reached, so nothing was generated.";
      this.endForSpend(room);
      return;
    }
    segment.reservedUsd = reservedUsd;
    segment.status = "generating";
    segment.message = null;

    await this.takeSlot();
    try {
      let requestId: string;
      try {
        requestId = await submitSegment(this.fal, { prompt, durationSeconds: wanted });
      } catch (error) {
        // Nothing was accepted, so nothing will be billed.
        this.options.account.refund(reservedUsd);
        segment.reservedUsd = 0;
        throw error;
      }
      const deadline = this.now() + GENERATION_DEADLINE_MS;
      let status = await getSegmentStatus(this.fal, requestId);
      while (status !== "completed") {
        if (this.now() > deadline) {
          throw new Error("The provider did not finish this segment in time.");
        }
        await this.sleep(POLL_MS);
        status = await getSegmentStatus(this.fal, requestId);
      }
      const url = await getSegmentUrl(this.fal, requestId);
      const { bytes, contentType } = await downloadSegment(url);
      const mediaId = randomUUID();
      await this.options.media.save(room.jamId, mediaId, bytes, contentType);
      segment.mediaId = mediaId;
      // What the file is, not what was asked for: the two differ, measurably.
      segment.seconds = readMp4DurationSeconds(bytes);
      segment.status = "ready";
      segment.message = null;
    } catch {
      // The provider's own words are not repeated to a room; what a
      // participant needs is that it did not arrive and the loop goes on.
      segment.status = "failed";
      segment.message = "That shot could not be generated. The room keeps running on the loop.";
    } finally {
      this.releaseSlot();
    }
  }

  private endForSpend(room: Room): void {
    if (room.ended) return;
    room.ended = {
      reason: "spend_ceiling",
      tell: "The spend ceiling for this server is reached. The room stops here.",
    };
  }

  /** At most `maxConcurrentGenerations` requests are in flight at once. */
  private takeSlot(): Promise<void> {
    if (this.running < this.limits.maxConcurrentGenerations) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

/** Most votes wins; a tie goes to whichever was proposed first. */
export function chooseWinner(turn: {
  proposals: readonly Proposal[];
  votes: ReadonlyMap<string, string>;
}): Proposal | null {
  if (turn.proposals.length === 0) return null;
  const tally = new Map<string, number>();
  for (const proposalId of turn.votes.values()) {
    tally.set(proposalId, (tally.get(proposalId) ?? 0) + 1);
  }
  let best: Proposal | null = null;
  let bestVotes = -1;
  for (const proposal of turn.proposals) {
    const votes = tally.get(proposal.id) ?? 0;
    if (votes > bestVotes) {
      best = proposal;
      bestVotes = votes;
    }
  }
  return best;
}

function reasonOf(outcome: EscapeOutcome): string {
  return outcome.kind === "advanced" ? "" : outcome.reason;
}

function viewOf(jamId: string, segment: Segment): SegmentView {
  return {
    status: segment.status,
    src: segment.status === "ready" && segment.mediaId
      ? `/api/jams/${jamId}/escape-room/segments/${segment.mediaId}`
      : null,
    seconds: segment.seconds,
    message: segment.message,
  };
}

function beatView(jamId: string, beat: Beat): BeatView {
  return {
    id: beat.id,
    turn: beat.turn,
    proposal: beat.proposal,
    outcome: beat.outcome,
    narration: beat.narration,
    narrationSource: beat.narrationSource,
    changes: beat.changes,
    media: viewOf(jamId, beat.segment),
    at: beat.at,
  };
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** A misconfigured provider must not stop the server from starting. */
function safely<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
