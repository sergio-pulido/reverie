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
import { attachViewer, type ViewerPeer } from "./directorViewers";
import type { SpendAccount } from "./spendLedger";
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

  hasOpenStreamForJam(jamId: string): boolean {
    for (const stream of this.bySession.values()) {
      if (stream.jamId === jamId) return true;
    }
    return false;
  }
}

export interface DirectorRouterOptions {
  config?: DirectorConfig | null;
  limits?: DirectorSessionLimits;
  /** The process-wide fal budget. Omitted, the ledger keeps its own. */
  account?: SpendAccount;
  recordings?: DirectorRecordingStore;
  index?: DirectorIndexStore;
  registry?: DirectorStreamRegistry;
  /**
   * Sinks that receive a session's pieces as they are muxed. Per session,
   * because a sink needs to know which jam and session it is storing. When
   * omitted, a recording server archives every session; a server not
   * configured to record stores nothing and says so.
   */
  createSegmentSinks?: (session: { jamId: string; sessionId: string }) => DirectorSegmentSink[];
  /** Seconds of film per stored piece; the muxer rounds up to a keyframe. */
  targetPieceSeconds?: number;
  startSession?: typeof startDirectorSession;
  /** Injected in tests so routes do not open real peer connections. */
  createPeer?: () => DirectorPeer;
  /** Injected in tests so routes do not open real viewer peers. */
  attachViewer?: typeof attachViewer;
  now?: () => number;
}

export function createDirectorRouter(
  store: JamStore,
  options: DirectorRouterOptions = {},
): Router {
  const router = express.Router();
  const limits = options.limits ?? resolveDirectorLimits(process.env);
  const ledger = new DirectorSessionLedger(limits, options.now, options.account);
  const recordings = options.recordings ?? resolveDirectorRecordingStore();
  const index = options.index ?? resolveDirectorIndexStore();
  const streams = options.registry ?? new DirectorStreamRegistry();
  /** Viewer peers, closed when the server tears down a session. */
  /**
   * Viewer peers per session. Keyed, because ending one session must not tear
   * down another session's audience.
   */
  const viewers = new Map<string, Set<ViewerPeer>>();
  /** The piece recorder per session, stopped with the session. */
  const recorders = new Map<string, DirectorPieceRecorder>();

  /**
   * The archive is the default sink for the WebM muxer. H.264 is refused by
   * that muxer until the fMP4 implementation is selected upstream, so bytes
   * emitted here are always WebM and must never be labelled as MP4.
   */
  function defaultSinks(session: { jamId: string; sessionId: string }): DirectorSegmentSink[] {
    let sink: DirectorArchiveSink | null = null;
    const forContainer = (_codec: string): DirectorArchiveSink => {
      const container: ArchiveContainer = "webm";
      sink ??= new DirectorArchiveSink({ ...session, recordings, index, container });
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
   * Ends a session and everything hanging off it.
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
    const stream = streams.get(sessionId);
    streams.delete(sessionId);
    ledger.close(sessionId);
    for (const viewer of viewers.get(sessionId) ?? []) viewer.close();
    viewers.delete(sessionId);
    await stream?.stop();
    const recorder = recorders.get(sessionId);
    recorders.delete(sessionId);
    // Bounded inside: the tail of the film is worth a moment, the route that
    // settles the paid session is worth more.
    await recorder?.stop().catch(() => undefined);
    if (!stream) return;
    await index.closeSession(sessionId).catch(() => undefined);
    // A room may have one paid stream per configuration. It ends when its last
    // stream ends, not when any one language/configuration stops.
    if (!streams.hasOpenStreamForJam(stream.jamId)) {
      await store.advanceLifecycle(stream.jamId, "stop").catch(() => undefined);
    }
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
    // A finished room does not stream again: its recording is the artifact, and
    // a second session would leave two different films behind one room URL.
    // Checked before the ledger is charged, so a refused start costs nothing.
    if (jam.lifecycle === "ended") {
      sendError(
        response,
        409,
        "jam_ended",
        "This jam has ended. Its recording is what remains of it.",
        false,
      );
      return;
    }

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
        ledger.renew(existing.sessionId);
        response.status(200).json({
          sessionId: existing.sessionId,
          attached: true,
          maxSessionSeconds: limits.maxSessionSeconds,
          recordingDurable: recordings.durable && index.durable,
          // Attaching does not move the room; it reports where it already is.
          lifecycle: jam.lifecycle,
          state: open.snapshot,
          beats: open.beats,
          spend: spendOf(existing.sessionId),
        });
        return;
      }
      // Ledger and stream map disagree: the session is not really serving
      // anyone, so release it rather than attach a viewer to nothing.
      ledger.release(existing.sessionId);
    }

    const session = ledger.open(streamKey);
    if (typeof session === "string") {
      sendError(response, 409, session, refusalMessage(session), session !== "budget_exhausted");
      return;
    }

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

    const stream = new DirectorStream({
      jamId: jam.id,
      sessionId: session.sessionId,
      config: active,
      script: jam.script,
      startSession: options.startSession,
      createPeer: options.createPeer,
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
    }
    streams.set(session.sessionId, stream);
    // Storage is opt-in (REVERIE_DIRECTOR_RECORD) and runs off this thread: the
    // recorder's only work here is to hand packets to its worker. A server
    // that does not record still directs, audits and relays.
    if (active.record) {
      const sinks = (options.createSegmentSinks ?? defaultSinks)({
        jamId: jam.id,
        sessionId: session.sessionId,
      });
      const recorder = new DirectorPieceRecorder({
        sinks,
        targetPieceSeconds: options.targetPieceSeconds,
      });
      recorders.set(session.sessionId, recorder);
      stream.onTrackAvailable((track) => recorder.addTrack(track));
    }
    // The room is now playing. Recorded after the handshake succeeded, so a
    // stream fal refused leaves the room live rather than stuck in a state it
    // never reached.
    const started = await store.advanceLifecycle(jam.id, "start");
    response.status(201).json({
      sessionId: session.sessionId,
      attached: false,
      maxSessionSeconds: limits.maxSessionSeconds,
      recordingDurable: recordings.durable && index.durable,
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
          if (watching.size === 0) void endSession(sessionId);
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

  router.post("/api/jams/:id/director/session/:sessionId/renew", (request, response) => {
    const stream = streams.get(request.params.sessionId);
    if (
      !stream ||
      stream.jamId !== request.params.id ||
      !ledger.renew(request.params.sessionId)
    ) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.status(204).end();
  });

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
    // Idempotent: a client tearing down twice is not an error, and what
    // matters is that the reservation is released and the recording stored.
    await endSession(request.params.sessionId);
    // Reports where the room ended up rather than transitioning again: the
    // teardown already did it, and ending twice must not be an error.
    const jam = await store.getJam(request.params.id);
    response.status(200).json({ lifecycle: jam?.lifecycle ?? "ended" });
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
