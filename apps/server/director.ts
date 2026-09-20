import type { FalBudget } from "./falBudget";
import express, { type Router } from "express";
import { z } from "zod";
import { sendError, type JamStore } from "./jams";
import {
  DirectorSessionLedger,
  resolveDirectorLimits,
  type DirectorSessionLimits,
} from "./directorSessions";
import {
  resolveDirectorRecordingStore,
  type DirectorRecordingStore,
} from "./directorRecordings";
import {
  resolveDirectorIndexStore,
  type DirectorIndexStore,
} from "./directorIndex";
import { DirectorArchiveSink, type ArchiveContainer } from "./directorArchive";
import { DirectorPieceRecorder } from "./directorPieces";
import type { DirectorSegmentSink } from "./directorSegmentSink";
import { DirectorStream, type DirectorPeer } from "./directorStream";
import type { DirectorBeatWindow } from "../../src/core/directorBeats";
import { attachViewer, type ViewerPeer } from "./directorViewers";
import { DirectorSegmenter } from "./directorSegmenter";
import { DirectorLiveSink } from "./directorLiveSink";
import {
  configurationKey,
  DEFAULT_CONFIGURATION,
} from "../../src/core/configuration";
import { sessionSettingsSchema } from "../../src/core/session";
import {
  DIRECTOR_MIN_BILLED_SECONDS,
  DirectorError,
  resolveDirectorConfig,
  startDirectorSession,
  type DirectorConfig,
} from "./providers/falDirector";
import {
  sessionSpendUsd,
  type DirectorRates,
  type DirectorSpend,
} from "../../src/core/directorSpend";

/**
 * The live director, proxied end to end by this server.
 *
 * This server is the WebRTC peer. Nothing reaches fal that did not pass
 * through here, and nothing fal produces leaves without being recorded: the
 * media track is written to storage and every direction and verdict is
 * appended to the session's audit log. A browser can ask for a direction to be
 * sent; it cannot talk to the provider.
 *
 * That is a deliberate trade. Holding a peer connection means this cannot run
 * as a serverless function — it belongs to the long-lived container process —
 * and the browser watches the recording rather than the live peer. Both are
 * recorded in docs/DECISIONS.md.
 */

/** A viewer's SDP offer to watch the stream this server already holds. */
const watchSchema = z.object({
  sdp: z.string().min(1).max(64_000),
});

const directionSchema = z.object({
  // 280 chars is what `jam_proposals` already enforces on a proposal body, so
  // a direction sourced from the queue cannot exceed what the room agreed to.
  body: z.string().trim().min(1).max(2_000),
  authorId: z.string().trim().min(1).max(200).optional(),
  proposalId: z.string().trim().min(1).max(200).optional(),
  beatIndex: z.number().int().min(0).max(1000).optional(),
});

/**
 * A viewer names the configuration they are watching. Everyone on the same
 * one shares a stream, so this selects which stream to attach to rather than
 * requesting a private one.
 */
const attachSchema = z
  .object({
    configuration: sessionSettingsSchema.optional(),
    /**
     * Join the stream for this configuration, but never start one.
     *
     * This is what everyone who is not the host sends. Opening a stream bills a
     * sixty-second minimum, so a participant merely arriving in a room must not
     * be able to start one by arriving — they attach to what the host is paying
     * for, or they are told there is nothing to watch yet.
     */
    attachOnly: z.boolean().optional(),
  })
  .optional();

/**
 * The live streams this process holds, so the script routes can read the same
 * lock boundary the director enforces.
 *
 * A beat edit IS a script edit: refusing direction on a closed beat while
 * letting a PATCH rewrite the same portion would leave two different answers
 * to one question. Both read this.
 */
export class DirectorStreamRegistry {
  private readonly bySession = new Map<string, DirectorStream>();

  set(sessionId: string, stream: DirectorStream): void {
    this.bySession.set(sessionId, stream);
  }

  get(sessionId: string): DirectorStream | undefined {
    return this.bySession.get(sessionId);
  }

  delete(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /**
   * First portion a script edit may still touch for this jam.
   *
   * The strictest open stream wins: a jam can carry one stream per
   * configuration, and an edit is only safe if it is ahead of all of them.
   */
  minEditablePortionIndex(jamId: string): number {
    let boundary = 0;
    for (const stream of this.bySession.values()) {
      if (stream.jamId !== jamId) continue;
      boundary = Math.max(boundary, stream.beats.minEditableBeatIndex);
    }
    return boundary;
  }

  /** Every open stream of a jam, so a landed outline edit can be sent to each. */
  streamsFor(jamId: string): DirectorStream[] {
    return [...this.bySession.values()].filter((stream) => stream.jamId === jamId);
  }

  /**
   * The strictest open stream's beat window, for the outline panel. The same
   * rule as `minEditablePortionIndex`, with the on-screen and locked beats
   * that stream reports; nothing is locked when no stream is open.
   */
  beatWindow(jamId: string): DirectorBeatWindow {
    let strictest: DirectorBeatWindow = {
      currentBeatIndex: null,
      lockedBeatIndex: null,
      minEditableBeatIndex: 0,
    };
    for (const stream of this.streamsFor(jamId)) {
      const window = stream.beats;
      if (window.minEditableBeatIndex >= strictest.minEditableBeatIndex) strictest = window;
    }
    return strictest;
  }

  hasOpenStreamForJam(jamId: string): boolean {
    for (const stream of this.bySession.values()) {
      if (stream.jamId === jamId) return true;
    }
    return false;
  }
}

/**
 * A viewer naming itself on a shared stream.
 *
 * Validated rather than hand-read because this id decides whether a paid
 * session keeps running: every other participant-supplied body in this file
 * goes through a schema, and the one that moves money should not be the
 * exception.
 */
const viewerSchema = z
  .object({ viewerId: z.string().trim().min(1).max(200).optional() })
  .optional();

export interface DirectorRouterOptions {
  config?: DirectorConfig | null;
  limits?: DirectorSessionLimits;
  /** Supplied so several routers reserve against one shared fal budget. */
  ledger?: DirectorSessionLedger;
  /** The process-wide fal budget a ledger built here reserves against. */
  budget?: FalBudget;
  recordings?: DirectorRecordingStore;
  index?: DirectorIndexStore;
  registry?: DirectorStreamRegistry;
  /**
   * Sinks that receive a session's pieces as they are muxed. Per session,
   * because a sink needs to know which jam and session it is storing. When
   * omitted, a recording server archives every session; a server not
   * configured to record stores nothing and says so.
   */
  createSegmentSinks?: (session: {
    jamId: string;
    sessionId: string;
    container: ArchiveContainer;
  }) => DirectorSegmentSink[];
  /** Seconds of film per stored piece; the muxer rounds up to a keyframe. */
  targetPieceSeconds?: number;
  startSession?: typeof startDirectorSession;
  /** Injected in tests so routes do not open real peer connections. */
  createPeer?: () => DirectorPeer;
  /** Injected in tests so routes do not open real viewer peers. */
  attachViewer?: typeof attachViewer;
  now?: () => number;
  /** Seconds of media per delivered segment; the floor, not a promise. */
  segmentSeconds?: number;
  /** How many recent segments stay fetchable. */
  segmentWindow?: number;
  /** Overrides the REVERIE_DIRECTOR_HLS flag; injected in tests. */
  liveDelivery?: boolean;
  /** Injected in tests so the delivery routes can be fed segments without a muxer. */
  createLiveSink?: () => DirectorLiveSink;
}

/** A live session: the provider stream, and what serves it to the room. */
interface LiveDirectorSession {
  stream: DirectorStream;
  live: DirectorLiveSink;
  segmenter: DirectorSegmenter;
}

export function createDirectorRouter(
  store: JamStore,
  options: DirectorRouterOptions = {},
): Router {
  const router = express.Router();
  const limits = options.limits ?? resolveDirectorLimits(process.env);
  const recordings = options.recordings ?? resolveDirectorRecordingStore();
  const index = options.index ?? resolveDirectorIndexStore();
  const streams = options.registry ?? new DirectorStreamRegistry();
  const deliverLive =
    options.liveDelivery ?? process.env.REVERIE_DIRECTOR_HLS === "true";
  /** What serves a session's segments, alongside the stream itself. */
  const delivery = new Map<string, { live: DirectorLiveSink; segmenter: DirectorSegmenter }>();
  /**
   * Viewer peers per session. Keyed, because ending one session must not tear
   * down another session's audience.
   */
  const viewers = new Map<string, Set<ViewerPeer>>();
  /** Teardowns in flight, so a session is released once however it ends. */
  const releasing = new Map<string, Promise<void>>();
  /**
   * Stream keys whose session is in the ledger but whose handshake has not
   * finished, so nothing is in `streams` for them yet.
   *
   * Without this, the two are indistinguishable from an orphaned reservation,
   * and the window is seconds wide — a fal handshake plus up to five seconds of
   * ICE gathering — while every participant's browser polls to attach every
   * three seconds.
   */
  const opening = new Set<string>();
  /** The piece recorder per session, stopped with the session. */
  const recorders = new Map<string, DirectorPieceRecorder>();

  /** The archive sink is told which selected muxer produced its bytes. */
  function defaultSinks(session: {
    jamId: string;
    sessionId: string;
    container: ArchiveContainer;
  }): DirectorSegmentSink[] {
    let sink: DirectorArchiveSink | null = null;
    const forContainer = (_codec: string): DirectorArchiveSink => {
      sink ??= new DirectorArchiveSink({ ...session, recordings, index });
      return sink;
    };
    return [
      {
        init: (bytes, codec) => forContainer(codec).init(bytes, codec),
        segment: (i, bytes, start, duration) =>
          sink?.segment(i, bytes, start, duration),
        finish: () => sink?.finish(),
      },
    ];
  }

  /**
   * Is anyone still watching, by either route?
   *
   * There are two ways to watch one stream — a relay peer, or a counted viewer
   * fetching segments — and a session must survive while EITHER has an
   * audience. Counting only one of them would end a stream somebody is still
   * watching through the other.
   */
  function stillWatched(sessionId: string): boolean {
    return (viewers.get(sessionId)?.size ?? 0) > 0 || ledger.viewerCount(sessionId) > 0;
  }

  /**
   * Tears down everything hanging off a session, without touching the ledger.
   *
   * Separate from settling because the ledger reclaims abandoned sessions
   * itself and calls back here; going through `endSession` from that callback
   * would settle a session that is already being settled.
   */
  function releaseSession(sessionId: string): Promise<void> {
    const inFlight = releasing.get(sessionId);
    if (inFlight) return inFlight;
    const stream = streams.get(sessionId);
    streams.delete(sessionId);
    const delivered = delivery.get(sessionId);
    delivery.delete(sessionId);
    for (const viewer of viewers.get(sessionId) ?? []) viewer.close();
    viewers.delete(sessionId);
    const recorder = recorders.get(sessionId);
    recorders.delete(sessionId);
    const task = (async () => {
      await stream?.stop();
      // Bounded inside: the tail of the film is worth a moment, the route that
      // settles the paid session is worth more.
      await delivered?.segmenter.stop().catch(() => undefined);
      await recorder?.stop().catch(() => undefined);
      if (!stream) return;
      await index.closeSession(sessionId).catch(() => undefined);
      // A room may have one paid stream per configuration. It ends when its
      // last stream ends, not when any one configuration stops. The jam is
      // read from the stream, never from a map this teardown has cleared, so
      // the ledger's own reclaim path can resolve it too.
      if (!streams.hasOpenStreamForJam(stream.jamId)) {
        await store.advanceLifecycle(stream.jamId, "stop").catch(() => undefined);
      }
    })();
    releasing.set(sessionId, task);
    void task.catch(() => undefined).finally(() => releasing.delete(sessionId));
    return task;
  }

  // A process with no configured FAL_ASSET_BUDGET_USD leaves the ledger on its
  // own limits rather than imposing a ceiling of zero over them. A configured
  // one is shared, so Director and beat generation debit the same total.
  const ledger =
    options.ledger
    ?? new DirectorSessionLedger(
      limits,
      options.now,
      options.budget?.totalUsd ? options.budget : undefined,
    );
  // The ledger reclaims abandoned sessions on its own, inside `open` and
  // `findByStreamKey` as well as on a sweep. A stream left running past its
  // session keeps billing with nobody watching, so stopping it is bound to the
  // ledger rather than left to whichever route happened to notice. This also
  // attaches the resource owner when the ledger was injected process-wide.
  ledger.onClosed((sessionId) => {
    void releaseSession(sessionId).catch(() => undefined);
  });
  // Reclaim must not depend on another browser happening to open or find a
  // session. If the final tab crashes and no later request arrives, only a
  // server-owned sweep can stop the paid stream at the idle or hard-duration
  // boundary. `unref` keeps this maintenance timer from holding the process up.
  const sessionSweep = setInterval(() => ledger.expireIdle(), 30_000);
  sessionSweep.unref?.();

  /**
   * Ends a session and settles it.
   *
   * Shared by the teardown route and by the last viewer leaving, so a session
   * stops the same way whichever reason it stops for.
   */
  /**
   * Tears a session down and ends the room it belonged to.
   *
   * The lifecycle transition lives in the teardown rather than in the end
   * route, because a session also stops when its last viewer leaves. A room
   * stopped that way would otherwise read `playing` for ever with nothing
   * streaming.
   *
   * INVARIANT, if this function is ever split: the transition must sit on the
   * path that EVERY stop reaches, not on the one the end route happens to
   * call. A ledger that reclaims abandoned sessions on its own, for instance,
   * would bypass a settle-and-teardown wrapper and reach only the inner
   * teardown — and a room whose viewers all went silent would be left reading
   * `playing`. Resolve the jam from the stream or the ledger, not from any
   * map the teardown itself clears, or the reclaim path will have nothing
   * left to resolve it from.
   *
   * Only a room that actually held this stream is ended, so a teardown for an
   * unknown session id cannot end a room that is still playing.
   */
  async function endSession(sessionId: string): Promise<void> {
    ledger.close(sessionId);
    await releaseSession(sessionId);
  }
  let resolved = false;
  let config: DirectorConfig | null = options.config ?? null;

  function requireConfig(): DirectorConfig | null {
    if (options.config !== undefined) return options.config;
    if (!resolved) {
      config = resolveDirectorConfig(process.env);
      resolved = true;
    }
    return config;
  }

  const rates: DirectorRates = {
    budgetUsd: limits.budgetUsd,
    usdPerSecond: limits.usdPerSecond,
    minBilledSeconds: DIRECTOR_MIN_BILLED_SECONDS,
  };

  /**
   * What has been spent, in USD, and what is left.
   *
   * A session's figure comes from the seconds fal actually generated, never
   * from its reservation: the reservation is the worst case this process
   * committed up front so a dead browser tab cannot leak budget, and quoting
   * it back as spend would overstate every session that ran short. It does cap
   * the figure, because a session cannot be billed past the limit it stops at.
   *
   * Everything else still open keeps its reservation, because those sessions
   * have not settled and this one must not be told money it cannot have.
   */
  function spendOf(sessionId: string | null): DirectorSpend {
    const session = sessionId ? ledger.find(sessionId) : undefined;
    const stream = sessionId ? streams.get(sessionId) : undefined;
    const sessionUsd = session
      ? Math.min(
          session.reservedUsd,
          sessionSpendUsd(stream?.snapshot.generatedSeconds ?? 0, rates),
        )
      : 0;
    const committedElsewhere = ledger.committedUsd - (session?.reservedUsd ?? 0);
    return {
      ...rates,
      sessionUsd,
      remainingUsd: Math.max(0, rates.budgetUsd - committedElsewhere - sessionUsd),
    };
  }

  router.use(express.json({ limit: "8kb" }));

  /**
   * The director budget of THIS server, so a screen can state the ceiling
   * before it opens a paid session.
   *
   * It does not look the jam up: the budget belongs to this process, not to a
   * room, and refusing to name the ceiling because the script lives elsewhere
   * would help nobody. `configured` says whether a session could be opened at
   * all, which is a different fact from having money left.
   */
  router.get("/api/jams/:id/director/budget", (_request, response) => {
    response.json({ configured: requireConfig() !== null, spend: spendOf(null) });
  });

  router.post("/api/jams/:id/director/session", async (request, response) => {
    const jam = await store.getJam(request.params.id);
    if (!jam) {
      sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
      return;
    }
    // A stopped room plays again. Anybody in the room sends the play signal and
    // anybody sends the stop signal, so a stop is a stop rather than a retirement:
    // the new session gets its own archive entry beside the previous take's.

    const active = requireConfig();
    if (!active) {
      sendError(
        response,
        503,
        "director_disabled",
        "The live director is not configured on this server.",
        false,
      );
      return;
    }

    const attach = attachSchema.safeParse(request.body);
    if (!attach.success) {
      sendError(response, 400, "invalid_command", "That configuration is not valid.", false);
      return;
    }
    const configuration = attach.data?.configuration ?? DEFAULT_CONFIGURATION;
    const streamKey = `${jam.id}:${configurationKey(configuration)}`;

    // Everyone watching the same configuration shares one paid stream. A
    // second viewer attaches to it instead of opening — and paying for — a
    // second copy of the same film.
    const existing = ledger.findByStreamKey(streamKey);
    if (existing) {
      const open = streams.get(existing.sessionId);
      if (open) {
        // A new viewer on a stream that already exists: counted, so the stream
        // outlives whoever opened it and ends when the last of them leaves.
        response.status(200).json({
          sessionId: existing.sessionId,
          viewerId: ledger.attach(existing.sessionId),
          attached: true,
          maxSessionSeconds: limits.maxSessionSeconds,
          recordingDurable: recordings.durable && index.durable,
          liveDelivery: deliverLive,
          // Attaching does not move the room; it reports where it already is.
          lifecycle: jam.lifecycle,
          state: open.snapshot,
          beats: open.beats,
          spend: spendOf(existing.sessionId),
        });
        return;
      }
      if (opening.has(streamKey)) {
        // The stream exists in the ledger and is mid-handshake. It is neither
        // attachable yet nor orphaned, and releasing it here would refund and
        // delete the reservation for a paid session that is about to go live —
        // leaving fal billing for a stream this server no longer tracks, and
        // letting the next Start open a second one for the same room.
        sendError(
          response,
          409,
          "stream_starting",
          "That stream is still starting. Try again in a moment.",
          true,
        );
        return;
      }
      // Ledger and stream map disagree and nothing is opening: the session is
      // not really serving anyone, so release it rather than attach a viewer to
      // nothing.
      ledger.release(existing.sessionId);
    }

    if (attach.data?.attachOnly) {
      // Nothing is running for this configuration and this caller may not start
      // one. Retryable on purpose: a participant who opened the room before the
      // host pressed start is early, not wrong.
      sendError(
        response,
        404,
        "no_stream",
        "Nobody is streaming this configuration yet.",
        true,
      );
      return;
    }

    const session = ledger.open(streamKey);
    if (typeof session === "string") {
      sendError(response, 409, session, refusalMessage(session), session !== "budget_exhausted");
      return;
    }

    // Guard the whole opening transaction, including the durable index write
    // below. That write has a ten-second timeout while viewers poll every three
    // seconds; marking only the provider handshake left a window where a poll
    // could mistake a valid reservation for an orphan and release it before the
    // paid session had even begun opening.
    opening.add(streamKey);

    // The reproduction record opens with the session, not at the end of it:
    // the audit rows reference it, and a session that dies mid-stream must
    // still have somewhere for what it managed to record.
    const revision = await store.getCurrentScriptRevision(jam.id).catch(() => null);
    try {
      await index.openSession({
        id: session.sessionId,
        jamId: jam.id,
        configurationKey: configurationKey(configuration),
        scriptRevision: revision?.revision ?? null,
      });
    } catch {
      // A stream that cannot be indexed is still a stream the room asked for.
      // It runs, and the API reports the archive as not durable.
    }

    // Select one media pipeline. With HLS on it produces fMP4 for both the live
    // window and the archive; otherwise the recorder produces WebM pieces. This
    // keeps live viewing and durable reproduction on one numbered timeline
    // instead of independently muxing the same track twice.
    const archiveSinks = active.record
      ? (options.createSegmentSinks ?? defaultSinks)({
          jamId: jam.id,
          sessionId: session.sessionId,
          container: deliverLive ? "mp4" : "webm",
        })
      : [];
    const live = deliverLive
      ? (options.createLiveSink?.() ?? new DirectorLiveSink(options.segmentWindow ?? 6))
      : null;
    const segmenter = live
      ? new DirectorSegmenter({
          sinks: [live, ...archiveSinks],
          targetSegmentSeconds: options.segmentSeconds ?? 2,
        })
      : null;
    const stream = new DirectorStream({
      jamId: jam.id,
      sessionId: session.sessionId,
      config: active,
      script: jam.script,
      startSession: options.startSession,
      createPeer: options.createPeer,
      // The offered preference follows the selected muxer. Both codecs remain
      // available as fallbacks, but a recording-only server must negotiate
      // VP8 first because its archive container is WebM.
      preferH264: deliverLive,
      // Fire-and-forget: a durable audit write that fails or hangs must not
      // stall the stream it is describing, and the in-memory trail the live
      // session reads is unaffected either way.
      onAudit: (entry) => {
        void index.recordAudit(session.sessionId, entry).catch(() => undefined);
      },
    });
    try {
      await stream.open();
    } catch (error) {
      // fal refused the handshake: no session exists on their side, so the
      // reservation is refunded rather than billed at the minimum.
      ledger.release(session.sessionId);
      if (error instanceof DirectorError) {
        sendError(response, 502, "director_unavailable", error.message, error.retryable);
        return;
      }
      throw error;
    } finally {
      // Cleared here rather than after `streams.set` only because nothing
      // awaits in between: the two run in one synchronous step, so no request
      // can observe the key as neither opening nor open.
      opening.delete(streamKey);
    }
    streams.set(session.sessionId, stream);
    // Storage is opt-in (REVERIE_DIRECTOR_RECORD) and runs off this thread: the
    // recorder's only work here is to hand packets to its worker. A server
    // that does not record still directs, audits and relays.
    if (active.record && !segmenter) {
      const recorder = new DirectorPieceRecorder({
        sinks: archiveSinks,
        targetPieceSeconds: options.targetPieceSeconds,
      });
      recorders.set(session.sessionId, recorder);
      stream.onTrackAvailable((track) => recorder.addTrack(track));
    }
    // The room is now playing. Recorded after the handshake succeeded, so a
    // stream fal refused leaves the room live rather than stuck in a state it
    // never reached.
    const started = await store.advanceLifecycle(jam.id, "start");
    if (live && segmenter) {
      delivery.set(session.sessionId, { live, segmenter });
      // The same seam the recorder uses: the stream announces its track, and
      // each muxer runs in its own worker off this thread.
      stream.onTrackAvailable((track) => segmenter.addTrack(track));
    }
    response.status(201).json({
      sessionId: session.sessionId,
      viewerId: ledger.attach(session.sessionId),
      attached: false,
      maxSessionSeconds: limits.maxSessionSeconds,
      recordingDurable: recordings.durable && index.durable,
      liveDelivery: deliverLive,
      lifecycle: started.lifecycle,
      state: stream.snapshot,
      beats: stream.beats,
      spend: spendOf(session.sessionId),
    });
  });

  /**
   * Sends one direction to the provider.
   *
   * This is the audit point. The body recorded is the body sent, and a client
   * has no other route to the model — which is the reason this server holds
   * the peer connection at all.
   */
  router.post("/api/jams/:id/director/session/:sessionId/direct", (request, response) => {
    const stream = streams.get(request.params.sessionId);
    if (!stream || stream.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    const direction = directionSchema.safeParse(request.body);
    if (!direction.success) {
      sendError(response, 400, "invalid_command", "That direction is not valid.", false);
      return;
    }
    ledger.renew(request.params.sessionId);
    const sent = stream.direct(direction.data);
    if (!sent.accepted) {
      if (sent.refusal === "beat_locked") {
        // The beat is on screen or already committed to generation. Refusing
        // is the point: it is the window the room has to react to a change.
        response.status(409).json({
          error: {
            code: "beat_locked",
            safeMessage:
              "That beat is already being generated. Only later beats can still change.",
            retryable: false,
          },
          beats: sent.beats,
        });
        return;
      }
      // The stream exists but its channel is not open: a real, temporary state
      // rather than a failure of the request.
      sendError(
        response,
        409,
        "stream_not_ready",
        "The director stream is not ready for direction yet.",
        true,
      );
      return;
    }
    response.status(202).json({
      promptVersion: sent.promptVersion,
      state: stream.snapshot,
      beats: sent.beats,
    });
  });

  /** State and audit trail for an open session. */
  router.get("/api/jams/:id/director/session/:sessionId", (request, response) => {
    const stream = streams.get(request.params.sessionId);
    if (!stream || stream.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.json({
      state: stream.snapshot,
      beats: stream.beats,
      audit: stream.entries,
      droppedAuditEntries: stream.audit.droppedCount,
      spend: spendOf(request.params.sessionId),
    });
  });

  /**
   * Watch the live stream.
   *
   * The viewer peers with THIS SERVER, not with fal: frames still arrive here
   * first and stay auditable and recordable. One fal session fans out to every
   * viewer that attaches, which is what makes a shared configuration cost one
   * stream rather than one per person.
   */
  router.post("/api/jams/:id/director/session/:sessionId/watch", async (request, response) => {
    const stream = streams.get(request.params.sessionId);
    if (stream && stream.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    if (!stream) {
      // A room that has ended is not a missing one. The room exists and so
      // does its recording; only the live stream is gone, and saying so with
      // a pointer is more useful than "no such thing". Any route that serves
      // a LIVE stream answers an ended room this way.
      const jam = await store.getJam(request.params.id);
      if (jam?.lifecycle === "ended") {
        response.status(409).json({
          error: {
            code: "jam_ended",
            safeMessage: "This jam has ended. Its recording is what remains of it.",
            retryable: false,
          },
          // The collection, not a resolved session: which session was last is
          // a read the archive already does.
          archive: `/api/jams/${request.params.id}/director/archive`,
        });
        return;
      }
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    const offer = watchSchema.safeParse(request.body);
    if (!offer.success) {
      sendError(response, 400, "invalid_command", "That viewer offer is not valid.", false);
      return;
    }
    const sessionId = request.params.sessionId;
    ledger.renew(sessionId);
    let viewer: ViewerPeer;
    try {
      viewer = await (options.attachViewer ?? attachViewer)(
        stream,
        offer.data.sdp,
        () => {
          const watching = viewers.get(sessionId);
          if (!watching) return;
          watching.delete(viewer);
          // Nobody is watching a stream that still bills by the second. A
          // session that HAD an audience and lost it is different from one
          // nobody has joined yet, and only the first should stop itself.
          // Not `watching.size === 0`: a relay peer dropping must not end a
          // session that counted viewers are still on. One rule, both paths.
          if (!stillWatched(sessionId)) void endSession(sessionId);
        },
      );
    } catch {
      sendError(
        response,
        502,
        "director_unavailable",
        "The stream could not be forwarded to this viewer.",
        true,
      );
      return;
    }
    const watching = viewers.get(sessionId) ?? new Set<ViewerPeer>();
    watching.add(viewer);
    viewers.set(sessionId, watching);
    response.status(201).json({
      answer: { type: "answer", sdp: viewer.answerSdp },
      viewers: watching.size,
    });
  });

  /**
   * One viewer checking in.
   *
   * The viewer id matters on a shared stream: without it the server only knows
   * that *someone* is watching, which is how a stream outlives the room that
   * was watching it and bills for the silence.
   */
  router.post("/api/jams/:id/director/session/:sessionId/renew", (request, response) => {
    const viewer = viewerSchema.safeParse(request.body);
    if (!viewer.success) {
      sendError(response, 400, "invalid_command", "That viewer is not valid.", false);
      return;
    }
    const viewerId = viewer.data?.viewerId;
    const stream = streams.get(request.params.sessionId);
    if (
      !stream ||
      stream.jamId !== request.params.id ||
      !ledger.renew(request.params.sessionId, viewerId)
    ) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.status(204).end();
  });

  /**
   * One viewer stops watching; the stream ends when the last of them does.
   *
   * This is the half of multiplexing that costs money. A shared stream must
   * survive one person closing a tab — ending it there would stop the film for
   * everyone still watching — and it must not survive the last one leaving,
   * because an unwatched stream goes on billing until the idle timeout
   * reclaims it. A caller that names no viewer ends the session outright,
   * which is what the host's own "stop" does.
   */
  router.post("/api/jams/:id/director/session/:sessionId/end", async (request, response) => {
    const open = streams.get(request.params.sessionId);
    if (open && open.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    if (!open) {
      try {
        const archived = await index.getSession(request.params.sessionId);
        if (archived && archived.jamId !== request.params.id) {
          sendError(response, 404, "not_found", "That director session is not open.", false);
          return;
        }
      } catch {
        sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
        return;
      }
    }
    // A viewer naming itself is leaving, not stopping the room's film. The
    // session ends only when nobody is watching by either route — a relay peer
    // or a counted viewer. Naming no viewer is the host's deliberate stop.
    const viewer = viewerSchema.safeParse(request.body);
    if (!viewer.success) {
      // Missing viewerId is the host's whole-room stop. Invalid viewer data
      // must never collapse into that privileged meaning.
      sendError(response, 400, "invalid_command", "That viewer is not valid.", false);
      return;
    }
    const viewerId = viewer.data?.viewerId;
    if (viewerId) {
      ledger.detach(request.params.sessionId, viewerId);
      if (stillWatched(request.params.sessionId)) {
        const jam = await store.getJam(request.params.id);
        response.status(200).json({ lifecycle: jam?.lifecycle ?? "live" });
        return;
      }
    }
    // Idempotent: a client tearing down twice is not an error, and what
    // matters is that the reservation is released and the recording stored.
    await endSession(request.params.sessionId);
    // Reports where the room ended up rather than transitioning again: the
    // teardown already did it, and ending twice must not be an error.
    const jam = await store.getJam(request.params.id);
    response.status(200).json({ lifecycle: jam?.lifecycle ?? "ended" });
  });

  /**
   * The live playlist: one file, fetched by everyone watching.
   *
   * This is the delivery half of "one stream, many viewers". Every viewer on a
   * configuration reads this same playlist and the same segments over ordinary
   * HTTP, so a second viewer costs a cache hit rather than a second paid
   * session — and no viewer holds a socket, which is what keeps the room off
   * the container's connection budget.
   */
  router.get("/api/jams/:id/director/session/:sessionId/playlist.m3u8", (request, response) => {
    // Order matters: "not open" and "not delivered live" are different answers,
    // and a server with delivery off has no delivery entry for any session, so
    // asking the delivery map first would report every stream as missing.
    const stream = streams.get(request.params.sessionId);
    if (!stream || stream.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    if (!deliverLive) {
      sendError(
        response,
        503,
        "live_delivery_disabled",
        "This server is not delivering the director stream live.",
        false,
      );
      return;
    }
    const served = delivery.get(request.params.sessionId);
    if (!served) {
      sendError(response, 404, "not_found", "That stream is not being delivered.", false);
      return;
    }
    switch (served.segmenter.refusedBecause) {
      case "unsupported_codec":
        // The negotiated codec cannot go into fMP4. Saying so is the point:
        // the alternative is a playlist whose segments no browser can decode.
        sendError(
          response,
          503,
          "unsupported_codec",
          "The provider is sending a video codec this server cannot deliver live.",
          false,
        );
        return;
      case "worker_failed":
        // The muxer thread died. That is a different fact from a codec
        // problem and is reported as one: the session, its recording and the
        // route that ends the spend are all still running.
        sendError(
          response,
          503,
          "live_delivery_failed",
          "Live delivery for this stream stopped. The stream itself is still running.",
          false,
        );
        return;
      case null:
        break;
    }
    // A playlist is only ever as current as the segment it was built from, and
    // a cached one strands a player one window behind live.
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/vnd.apple.mpegurl");
    response
      .status(200)
      .send(served.live.playlist("init.mp4", (sequence: number) => `segment/${sequence}.m4s`));
  });

  /** The fMP4 initialization segment every viewer needs before any media. */
  router.get("/api/jams/:id/director/session/:sessionId/init.mp4", (request, response) => {
    const stream = streams.get(request.params.sessionId);
    if (!stream || stream.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    const initialization = delivery.get(request.params.sessionId)?.live.initializationSegment;
    if (!initialization) {
      sendError(response, 404, "not_found", "That stream has not started yet.", true);
      return;
    }
    // Immutable for the life of the session: it describes tracks that cannot
    // change once declared, so every viewer after the first can be served a
    // cached copy.
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.setHeader("content-type", "video/mp4");
    response.status(200).end(Buffer.from(initialization));
  });

  /**
   * One media segment.
   *
   * Segments are immutable and cacheable, which is the property that makes
   * fan-out free: the hundredth viewer of a segment can be served without the
   * container doing anything at all.
   */
  router.get("/api/jams/:id/director/session/:sessionId/segment/:sequence.m4s", (request, response) => {
    const stream = streams.get(request.params.sessionId);
    if (!stream || stream.jamId !== request.params.id) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    const live = delivery.get(request.params.sessionId)?.live;
    const sequence = Number(request.params.sequence);
    if (!live || !Number.isInteger(sequence) || sequence < 0) {
      sendError(response, 404, "not_found", "There is no such segment.", false);
      return;
    }
    const bytes = live.segmentBytes(sequence);
    if (!bytes) {
      // Either not produced yet, or it has fallen out of the live window. Both
      // are answered the same way: the playlist says what currently exists, and
      // a player that fell behind re-reads it rather than being handed the
      // wrong part of the film.
      sendError(response, 404, "not_found", "That segment is no longer available.", false);
      return;
    }
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
    response.setHeader("content-type", "video/iso.segment");
    response.status(200).end(Buffer.from(bytes));
  });

  /** The stored recording of a session, served by this server only. */
  router.get("/api/jams/:id/director/recordings/:sessionId", async (request, response) => {
    let recording;
    try {
      recording = await recordings.get(request.params.id, request.params.sessionId);
    } catch {
      sendError(
        response,
        503,
        "media_unavailable",
        "The recording store could not be reached.",
        true,
      );
      return;
    }
    if (!recording) {
      sendError(response, 404, "not_found", "There is no recording for that session.", false);
      return;
    }
    response.setHeader("content-type", recording.contentType);
    response.setHeader("content-length", String(recording.bytes.byteLength));
    response.status(200).end(recording.bytes);
  });

  return router;
}

function refusalMessage(refusal: string): string {
  if (refusal === "budget_exhausted") {
    return "The director budget for this server is spent.";
  }
  if (refusal === "already_open") {
    return "That configuration already has a director stream open.";
  }
  return "Too many director streams are open right now.";
}
