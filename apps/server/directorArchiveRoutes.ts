import express, { type Router } from "express";
import { sendError, type JamStore } from "./jams";
import {
  resolveDirectorIndexStore,
  type DirectorIndexStore,
} from "./directorIndex";
import {
  resolveDirectorRecordingStore,
  type DirectorRecordingStore,
} from "./directorRecordings";
import {
  asContainer,
  containerContentType,
  initObjectName,
  pieceObjectName,
} from "../../src/core/directorArchiveLayout";
import { buildMediaPlaylist } from "../../src/core/hlsPlaylist";

/**
 * Reading back a director session after it has finished.
 *
 * Every route here is a plain read of durable state — no in-process stream
 * map, no container-local file — so a session reproduces from a server that
 * never saw it run, and these could be served by a serverless function
 * unchanged. That is deliberate: the live director must hold a long-lived peer
 * connection and cannot leave the container, but reproducing one need not.
 *
 * Kept out of `director.ts`, which owns the live session routes, so the live
 * and archived halves of the feature do not contend for one file.
 */

export interface DirectorArchiveRouterOptions {
  index?: DirectorIndexStore;
  recordings?: DirectorRecordingStore;
}

export function createDirectorArchiveRouter(
  store: JamStore,
  options: DirectorArchiveRouterOptions = {},
): Router {
  const router = express.Router();
  const index = options.index ?? resolveDirectorIndexStore();
  const recordings = options.recordings ?? resolveDirectorRecordingStore();

  /** Every route reports whether what it served is actually durable. */
  const durable = index.durable && recordings.durable;

  async function requireJam(id: string, response: express.Response): Promise<boolean> {
    if (await store.getJam(id)) return true;
    sendError(response, 404, "not_found", "This jam does not exist on this server.", false);
    return false;
  }

  /** The sessions a jam has archived, newest first. */
  router.get("/api/jams/:id/director/archive", async (request, response) => {
    if (!(await requireJam(request.params.id, response))) return;
    let sessions;
    try {
      sessions = await index.listSessions(request.params.id);
    } catch {
      sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
      return;
    }
    response.json({ durable, sessions });
  });

  /**
   * One session's record, with the segments that actually reached storage.
   *
   * `complete` is false for a session whose process died mid-stream, and the
   * segments listed are the ones that survived. Reporting a partial archive as
   * partial is the point.
   */
  router.get("/api/jams/:id/director/archive/:sessionId", async (request, response) => {
    if (!(await requireJam(request.params.id, response))) return;
    try {
      const session = await index.getSession(request.params.sessionId);
      if (!session || session.jamId !== request.params.id) {
        sendError(response, 404, "not_found", "There is no archive for that session.", false);
        return;
      }
      const segments = await index.listSegments(session.id);
      response.json({
        durable,
        session,
        segments,
        // Summed from the segments that are actually stored, not from what the
        // session was expected to produce.
        durationSeconds: segments.reduce((total, s) => total + s.durationSeconds, 0),
      });
    } catch {
      sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
    }
  });

  /** What the room asked for, and what the provider did with it. */
  router.get("/api/jams/:id/director/archive/:sessionId/audit", async (request, response) => {
    if (!(await requireJam(request.params.id, response))) return;
    try {
      const session = await index.getSession(request.params.sessionId);
      if (!session || session.jamId !== request.params.id) {
        sendError(response, 404, "not_found", "There is no archive for that session.", false);
        return;
      }
      response.json({ durable, audit: await index.listAudit(session.id) });
    } catch {
      sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
    }
  });

  /**
   * The same VOD playlist the deployed function serves, from the same rows.
   *
   * Built at read time from `jam_director_segments`, so a session whose process
   * died mid-stream still plays up to its last durable piece. Parity matters
   * more than the few lines it costs: one browser reads this contract from
   * either host, and a playlist that existed on only one of them would make a
   * film that plays locally unplayable in production, or the reverse.
   */
  router.get("/api/jams/:id/director/archive/:sessionId/playlist.m3u8", async (request, response) => {
    if (!(await requireJam(request.params.id, response))) return;
    const { id, sessionId } = request.params;
    let session;
    let segments;
    try {
      session = await index.getSession(sessionId);
      if (!session || session.jamId !== id) {
        sendError(response, 404, "not_found", "There is no archive for that session.", false);
        return;
      }
      segments = await index.listSegments(session.id);
    } catch {
      sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
      return;
    }
    if (!segments.length) {
      sendError(response, 404, "not_found", "That session stored no video.", false);
      return;
    }
    const container = asContainer(session.container);
    response
      .type("application/vnd.apple.mpegurl")
      .send(
        buildMediaPlaylist({
          segments: segments.map((piece) => ({
            sequence: piece.segmentIndex,
            durationSeconds: piece.durationSeconds,
          })),
          initUri: `media/${initObjectName(container)}`,
          segmentUri: (sequence) => `media/${pieceObjectName(container, sequence)}`,
          // The session is over; a player that is not told so polls forever.
          ended: true,
          playlistType: "VOD",
        }),
      );
  });

  /**
   * The bytes of one archived object, served by this server.
   *
   * The bucket is private and no storage URL ever reaches a participant, so a
   * segment cannot outlive the room's authorization checks.
   */
  router.get(
    "/api/jams/:id/director/archive/:sessionId/media/:name",
    async (request, response) => {
      if (!(await requireJam(request.params.id, response))) return;
      const { id, sessionId, name } = request.params;
      let object;
      try {
        const session = await index.getSession(sessionId);
        if (!session || session.jamId !== id) {
          sendError(response, 404, "not_found", "There is no archive for that session.", false);
          return;
        }
        object = await recordings.getObject(`${id}/${sessionId}/${name}`);
      } catch {
        sendError(response, 503, "media_unavailable", "The archive store could not be reached.", true);
        return;
      }
      if (!object) {
        sendError(response, 404, "not_found", "That segment is not in the archive.", false);
        return;
      }
      response.setHeader("content-type", object.contentType);
      response.setHeader("content-length", String(object.bytes.byteLength));
      response.status(200).end(object.bytes);
    },
  );

  /**
   * The whole archived session as one playable file.
   *
   * Both supported layouts concatenate: WebM is its initial header followed by
   * clusters, and fMP4 is its init segment followed by media segments. A
   * finished session therefore plays in a plain `<video>` element with no
   * playlist, no MSE and no player library.
   * Segments stay individually addressable for anything that wants to seek.
   *
   * Streamed as it is assembled rather than buffered: a session archive can be
   * hundreds of megabytes, and holding one in memory to serve one viewer is
   * how a container runs out of it.
   */
  router.get("/api/jams/:id/director/archive/:sessionId/video", async (request, response) => {
    if (!(await requireJam(request.params.id, response))) return;
    const { id, sessionId } = request.params;
    let session;
    let segments;
    try {
      session = await index.getSession(sessionId);
      if (!session || session.jamId !== id) {
        sendError(response, 404, "not_found", "There is no archive for that session.", false);
        return;
      }
      segments = await index.listSegments(session.id);
    } catch {
      sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
      return;
    }
    if (!segments.length) {
      sendError(response, 404, "not_found", "That session stored no video.", false);
      return;
    }

    const container = asContainer(session.container);
    try {
      const init = await recordings.getObject(`${id}/${sessionId}/${initObjectName(container)}`);
      // Without the initial header the pieces cannot be decoded, so an archive
      // missing it is refused rather than served as an unplayable file.
      if (!init) {
        sendError(response, 404, "not_found", "That session stored no video.", false);
        return;
      }
      response.setHeader("content-type", containerContentType(container));
      response.write(init.bytes);
      for (const segment of segments) {
        const bytes = await recordings.getObject(segment.objectPath);
        // A gap would silently corrupt the file. The rows only exist for
        // uploads that succeeded, so a missing object here means the bucket
        // lost it, and stopping is more honest than writing a broken tail.
        if (!bytes) break;
        response.write(bytes.bytes);
      }
      response.end();
    } catch {
      // The headers are already sent, so there is no status left to change:
      // ending the response is all that is left, and a short file is at least
      // not a lie about its own length.
      response.end();
    }
  });

  /**
   * One piece of the film, playable on its own — the seek primitive.
   *
   * Going to a given minute means fetching the piece that contains it, not
   * downloading everything before it. Each piece begins on a keyframe, so
   * `initial header + piece` decodes from its first frame in a plain <video>.
   * The header is stored once and prepended here, so seeking costs one small
   * object plus the piece.
   */
  router.get(
    "/api/jams/:id/director/archive/:sessionId/pieces/:index",
    async (request, response) => {
      if (!(await requireJam(request.params.id, response))) return;
      const { id, sessionId } = request.params;
      const wanted = Number(request.params.index);
      if (!Number.isInteger(wanted) || wanted < 0) {
        sendError(response, 400, "invalid_command", "That piece index is not valid.", false);
        return;
      }
      let session;
      let piece;
      try {
        session = await index.getSession(sessionId);
        if (!session || session.jamId !== id) {
          sendError(response, 404, "not_found", "There is no archive for that session.", false);
          return;
        }
        piece = (await index.listSegments(session.id)).find((s) => s.segmentIndex === wanted);
      } catch {
        sendError(response, 503, "media_unavailable", "The director archive could not be read.", true);
        return;
      }
      if (!piece) {
        sendError(response, 404, "not_found", "That piece is not in the archive.", false);
        return;
      }
      const container = asContainer(session.container);
      let init;
      let bytes;
      try {
        init = await recordings.getObject(`${id}/${sessionId}/${initObjectName(container)}`);
        bytes = await recordings.getObject(piece.objectPath);
      } catch {
        sendError(response, 503, "media_unavailable", "The archive store could not be reached.", true);
        return;
      }
      if (!init || !bytes) {
        sendError(response, 404, "not_found", "That piece is not in the archive.", false);
        return;
      }
      response.setHeader("content-type", containerContentType(container));
      response.setHeader("content-length", String(init.bytes.byteLength + bytes.bytes.byteLength));
      // Where this piece sits on the film's clock, so a player can show it.
      response.setHeader("x-piece-start-seconds", String(piece.startSeconds));
      response.setHeader("x-piece-duration-seconds", String(piece.durationSeconds));
      response.write(init.bytes);
      response.end(bytes.bytes);
    },
  );

  return router;
}
