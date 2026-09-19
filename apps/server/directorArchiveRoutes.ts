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
   * fMP4 is the init segment followed by its media segments, so concatenating
   * them in order IS a valid MP4 — which means a finished session plays in a
   * plain `<video>` element with no playlist, no MSE and no player library.
   * Segments stay individually addressable for anything that wants to seek.
   *
   * Streamed as it is assembled rather than buffered: a session archive can be
   * hundreds of megabytes, and holding one in memory to serve one viewer is
   * how a container runs out of it.
   */
  router.get("/api/jams/:id/director/archive/:sessionId/video", async (request, response) => {
    if (!(await requireJam(request.params.id, response))) return;
    const { id, sessionId } = request.params;
    let segments;
    try {
      const session = await index.getSession(sessionId);
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

    response.setHeader("content-type", "video/mp4");
    try {
      const init = await recordings.getObject(`${id}/${sessionId}/init.mp4`);
      // Without the init segment the media segments cannot be decoded, so an
      // archive missing it is refused rather than served as an unplayable file.
      if (!init) {
        sendError(response, 404, "not_found", "That session stored no video.", false);
        return;
      }
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

  return router;
}
