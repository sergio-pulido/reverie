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
import { DirectorStream, type DirectorPeer } from "./directorStream";
import {
  configurationKey,
  DEFAULT_CONFIGURATION,
} from "../../src/core/portionPlayback";
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

export interface DirectorRouterOptions {
  config?: DirectorConfig | null;
  limits?: DirectorSessionLimits;
  recordings?: DirectorRecordingStore;
  startSession?: typeof startDirectorSession;
  /** Injected in tests so routes do not open real peer connections. */
  createPeer?: () => DirectorPeer;
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
  /** Live streams, keyed by session id. */
  const streams = new Map<string, DirectorStream>();
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

    const stream = new DirectorStream({
      jamId: jam.id,
      sessionId: session.sessionId,
      config: active,
      script: jam.script,
      sink: recordings,
      startSession: options.startSession,
      createPeer: options.createPeer,
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
    response.status(201).json({
      sessionId: session.sessionId,
      attached: false,
      maxSessionSeconds: limits.maxSessionSeconds,
      recordingDurable: recordings.durable,
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

  router.post("/api/jams/:id/director/session/:sessionId/renew", (request, response) => {
    if (!ledger.renew(request.params.sessionId)) {
      sendError(response, 404, "not_found", "That director session is not open.", false);
      return;
    }
    response.status(204).end();
  });

  router.post("/api/jams/:id/director/session/:sessionId/end", async (request, response) => {
    const stream = streams.get(request.params.sessionId);
    streams.delete(request.params.sessionId);
    ledger.close(request.params.sessionId);
    // Idempotent: a client tearing down twice is not an error, and what
    // matters is that the reservation is released and the recording stored.
    await stream?.stop();
    response.status(204).end();
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
