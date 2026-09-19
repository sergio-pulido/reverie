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
import { attachViewer, type ViewerPeer } from "./directorViewers";
import { DirectorFileRecorder } from "./directorFileRecorder";
import {
  DirectorSegmenter,
  type DirectorSegmentSink,
  type DirectorTrackConsumer,
} from "./directorSegmenter";
import { DirectorLiveSink } from "./directorLiveSink";
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
}

export interface DirectorRouterOptions {
  config?: DirectorConfig | null;
  limits?: DirectorSessionLimits;
  recordings?: DirectorRecordingStore;
  registry?: DirectorStreamRegistry;
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
  /**
   * Further places a session's segments go — the durable archive, in practice.
   *
   * Per session, because a sink needs to know which session it is writing for.
   * Segments are muxed whenever *any* sink wants them: live delivery is one
   * such sink, not the reason the muxer exists, so an archive keeps receiving
   * segments with HLS delivery switched off.
   */
  createSegmentSinks?: (session: { jamId: string; sessionId: string }) => DirectorSegmentSink[];
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
    delivery.delete(sessionId);
    for (const viewer of viewers.get(sessionId) ?? []) viewer.close();
    viewers.delete(sessionId);
    const task = Promise.resolve(stream?.stop()).then(() => undefined);
    releasing.set(sessionId, task);
    void task.catch(() => undefined).finally(() => releasing.delete(sessionId));
    return task;
  }

  // The ledger reclaims abandoned sessions on its own, inside `open` and
  // `findByStreamKey` as well as on a sweep. A stream left running past its
  // session keeps billing with nobody watching, so stopping it is bound to the
  // ledger rather than left to whichever route happened to notice.
  const ledger = new DirectorSessionLedger(limits, options.now, (sessionId) => {
    void releaseSession(sessionId).catch(() => undefined);
  });

  /**
   * Ends a session and settles it.
   *
   * Shared by the teardown route and by the last viewer leaving, so a session
   * stops the same way whichever reason it stops for.
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
        // A new viewer on a stream that already exists: counted, so the stream
        // outlives whoever opened it and ends when the last of them leaves.
        response.status(200).json({
          sessionId: existing.sessionId,
          viewerId: ledger.attach(existing.sessionId),
          attached: true,
          maxSessionSeconds: limits.maxSessionSeconds,
          recordingDurable: recordings.durable,
          liveDelivery: deliverLive,
          state: open.snapshot,
          beats: open.beats,
        });
        return;
      }
      // Ledger and stream map disagree: the session is not really serving
      // anyone, so release it rather than attach a viewer to nothing.
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

    // Capture is opt-in and off by default (REVERIE_DIRECTOR_RECORD), because
    // muxing WebM on this thread is what pinned the event loop. The flag
    // decides whether the recorder exists at all, not whether it is consulted.
    //
    // Segments are a different matter: they are muxed off this thread, and
    // they are produced whenever anything wants them — the live window when
    // HLS delivery is on, the durable archive when one is configured. With no
    // sink there is no muxer, so nothing is depacketized for nobody. HLS
    // delivery itself stays opt-in until a real session has shown /end
    // answering while the worker is mid-segment.
    const live = deliverLive
      ? (options.createLiveSink?.() ?? new DirectorLiveSink(options.segmentWindow ?? 6))
      : null;
    const sinks: DirectorSegmentSink[] = [
      ...(live ? [live] : []),
      ...(options.createSegmentSinks?.({ jamId: jam.id, sessionId: session.sessionId }) ?? []),
    ];
    const segmenter =
      sinks.length > 0
        ? new DirectorSegmenter({ sinks, targetSegmentSeconds: options.segmentSeconds ?? 2 })
        : null;
    const consumers: DirectorTrackConsumer[] = [
      ...(active.record
        ? [new DirectorFileRecorder(jam.id, session.sessionId, recordings)]
        : []),
      ...(segmenter ? [segmenter] : []),
    ];
    const stream = new DirectorStream({
      jamId: jam.id,
      sessionId: session.sessionId,
      config: active,
      script: jam.script,
      sink: recordings,
      consumers,
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
    if (live && segmenter) delivery.set(session.sessionId, { live, segmenter });
    response.status(201).json({
      sessionId: session.sessionId,
      viewerId: ledger.attach(session.sessionId),
      attached: false,
      maxSessionSeconds: limits.maxSessionSeconds,
      recordingDurable: recordings.durable,
      liveDelivery: deliverLive,
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

  /**
   * One viewer checking in.
   *
   * The viewer id matters on a shared stream: without it the server only knows
   * that *someone* is watching, which is how a stream outlives the room that
   * was watching it and bills for the silence.
   */
  router.post("/api/jams/:id/director/session/:sessionId/renew", (request, response) => {
    const viewerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : undefined;
    if (!ledger.renew(request.params.sessionId, viewerId)) {
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
    const sessionId = request.params.sessionId;
    const viewerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : undefined;
    if (viewerId) {
      ledger.detach(sessionId, viewerId);
      if (stillWatched(sessionId)) {
        // Somebody is still watching, by one route or the other. Nothing is
        // settled and nothing stops.
        response.status(204).end();
        return;
      }
    }
    // Idempotent: a client tearing down twice is not an error, and what
    // matters is that the reservation is released and the recording stored.
    await endSession(sessionId);
    response.status(204).end();
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
    if (!streams.get(request.params.sessionId)) {
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
