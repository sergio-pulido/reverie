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
import { DirectorStream, type DirectorPeer } from "./directorStream";
import { attachViewer, type ViewerPeer } from "./directorViewers";
import {
  configurationKey,
  DEFAULT_CONFIGURATION,
} from "../../src/core/configuration";
import { sessionSettingsSchema } from "../../src/core/session";
import {
  DirectorError,
  resolveDirectorConfig,
  startDirectorSession,
  type DirectorConfig,
} from "./providers/falDirector";

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
}

export interface DirectorRouterOptions {
  config?: DirectorConfig | null;
  limits?: DirectorSessionLimits;
  recordings?: DirectorRecordingStore;
  index?: DirectorIndexStore;
  registry?: DirectorStreamRegistry;
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
  const ledger = new DirectorSessionLedger(limits, options.now);
  const recordings = options.recordings ?? resolveDirectorRecordingStore();
  const index = options.index ?? resolveDirectorIndexStore();
  const streams = options.registry ?? new DirectorStreamRegistry();
  /** Viewer peers, closed when the server tears down a session. */
  /**
   * Viewer peers per session. Keyed, because ending one session must not tear
   * down another session's audience.
   */
  const viewers = new Map<string, Set<ViewerPeer>>();

  /**
   * Ends a session and everything hanging off it.
   *
   * Shared by the teardown route and by the last viewer leaving, so a session
   * stops the same way whichever reason it stops for.
   */
  async function endSession(sessionId: string): Promise<void> {
    const stream = streams.get(sessionId);
    streams.delete(sessionId);
    ledger.close(sessionId);
    for (const viewer of viewers.get(sessionId) ?? []) viewer.close();
    viewers.delete(sessionId);
    await stream?.stop();
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

  router.use(express.json({ limit: "8kb" }));

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
          recordingDurable: recordings.durable,
          // Attaching does not move the room; it reports where it already is.
          lifecycle: jam.lifecycle,
          state: open.snapshot,
          beats: open.beats,
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
      sink: recordings,
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
    // The room is now playing. Recorded after the handshake succeeded, so a
    // stream fal refused leaves the room live rather than stuck in a state it
    // never reached.
    const started = await store.advanceLifecycle(jam.id, "start");
    response.status(201).json({
      sessionId: session.sessionId,
      attached: false,
      maxSessionSeconds: limits.maxSessionSeconds,
      recordingDurable: recordings.durable,
      lifecycle: started.lifecycle,
      state: stream.snapshot,
      beats: stream.beats,
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
    if (!stream) {
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
    if (!stream) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.json({
      state: stream.snapshot,
      beats: stream.beats,
      audit: stream.entries,
      droppedAuditEntries: stream.audit.droppedCount,
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
    if (!stream) {
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
    if (!ledger.renew(request.params.sessionId)) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.status(204).end();
  });

  router.post("/api/jams/:id/director/session/:sessionId/end", async (request, response) => {
    // Idempotent: a client tearing down twice is not an error, and what
    // matters is that the reservation is released and the recording stored.
    await endSession(request.params.sessionId);
    // A room that has stopped is ended, and what remains of it is its
    // recording. Refused transitions are not an error here: ending twice is
    // the same idempotent teardown as the rest of this route.
    // Closes the reproduction record too, so a session that ended cleanly is
    // distinguishable from one whose process died.
    await index.closeSession(request.params.sessionId).catch(() => undefined);
    const stopped = await store.advanceLifecycle(request.params.id, "stop");
    response.status(200).json({ lifecycle: stopped.lifecycle });
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
