import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { buildMediaPlaylist } from "../../../../../src/core/hlsPlaylist.js";
import {
  asContainer,
  containerContentType,
  initObjectName,
  pieceObjectName,
} from "../../../../../src/core/directorArchiveLayout.js";
import {
  authenticate,
  readBearerToken,
  readMembership,
  readSupabaseConfig,
  RestError,
  type SupabaseConfig,
  type SupabaseRestOptions,
} from "../../../../_lib/supabase-rest.js";
import {
  listArchivedAudit,
  listArchivedSegments,
  listArchivedSessions,
  readArchiveObject,
  readArchivedSession,
  readDirectorBucket,
  type ArchiveSegment,
  type ArchiveSession,
} from "../../../../_lib/director-archive.js";
import { clientKey, createRateLimiter, isSameOrigin, requestUrl, sendJson } from "../../../../_lib/http.js";

/**
 * Reading a finished director session in production.
 *
 * The live director holds a long-lived peer connection to fal and therefore
 * belongs to the container (`AGENTS.md`, docs/DECISIONS.md). Reproducing one
 * does not: every route here is a plain read of Supabase and Storage, which is
 * exactly what a Vercel function can do — so a film the container made is
 * playable from the deployed URL whether or not that container is still alive.
 *
 * Unlike the container's own copy of these routes, this checks who is asking.
 * Identity comes from Supabase Auth verifying the presented token, membership
 * from the caller's own `jam_members` row under RLS, and the rows and objects
 * below are read with that same token — so this function can see no more of
 * the archive than the participant it is acting for.
 */

const RATE_LIMIT_REQUESTS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ROUTE = /^\/api\/jams\/([^/]+)\/director\/archive(?:\/(.*))?$/;
/** A jam id is minted by the browser and is always a v4 UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A session id is NOT a UUID: the ledger mints `<base36 time>-<base36 count>`
 * (apps/server/directorSessions.ts), so real ids look like `mu9lukum-3`.
 *
 * It still has to be bounded, because it reaches both a PostgREST filter and
 * an object key. This charset excludes everything either one reads as syntax —
 * no `&`, no `.`, no comma, no slash — so the id can only ever be a value.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const allowRequest = createRateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS);

export type ArchiveHandlerOptions = SupabaseRestOptions & { env?: NodeJS.ProcessEnv };

function fail(
  response: ServerResponse,
  status: number,
  code: string,
  safeMessage: string,
  retryable = false,
) {
  // The container's archive routes answer in this shape, and one client reads
  // both. A second error shape would be a second thing to get right.
  sendJson(response, status, { error: { code, safeMessage, retryable } });
}

function notFound(response: ServerResponse) {
  fail(response, 404, "not_found", "There is no archive for that session.");
}

export default async function directorArchive(
  request: IncomingMessage,
  response: ServerResponse,
  options: ArchiveHandlerOptions = {},
) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    fail(response, 405, "method_not_allowed", "Only GET is supported.");
    return;
  }
  if (!isSameOrigin(request)) {
    fail(response, 403, "cross_origin_blocked", "This endpoint only answers same-origin requests.");
    return;
  }
  if (!allowRequest(clientKey(request))) {
    response.setHeader("Retry-After", String(RATE_LIMIT_WINDOW_MS / 1_000));
    fail(response, 429, "rate_limited", "Too many archive requests. Try again shortly.", true);
    return;
  }

  const match = ROUTE.exec(requestUrl(request).pathname);
  if (!match) {
    notFound(response);
    return;
  }
  const jamId = match[1];
  const tail = (match[2] ?? "").split("/").filter((part) => part.length > 0).map(decodeURIComponent);
  // A jam id is interpolated into the PostgREST query that reads membership,
  // so an id carrying `&` would add filters to a query this function has to be
  // able to trust. Every jam this repository mints is a v4 UUID.
  if (!UUID.test(jamId)) {
    notFound(response);
    return;
  }

  const config = readSupabaseConfig(options.env ?? process.env);
  if (!config) {
    fail(
      response,
      503,
      "archive_unavailable",
      "This deployment has no Supabase configuration, so it cannot read the archive.",
      true,
    );
    return;
  }

  const token = readBearerToken(request.headers.authorization);
  if (!token) {
    fail(response, 401, "unauthenticated", "Sign in to watch this room's film.");
    return;
  }

  try {
    const userId = await authenticate(config, token, options);
    const membership = await readMembership(config, token, jamId, userId, options);
    if (membership.status !== "active") {
      fail(response, 403, "forbidden", "You are not an active member of this room.");
      return;
    }
    await route(request, response, { config, token, jamId, tail, options });
  } catch (error) {
    if (error instanceof RestError) {
      if (error.code === "unauthenticated") {
        fail(response, 401, "unauthenticated", "That session is not signed in.");
        return;
      }
      if (error.code === "forbidden") {
        fail(response, 403, "forbidden", "You are not a member of this room.");
        return;
      }
      fail(response, 503, "archive_unavailable", error.message, true);
      return;
    }
    fail(response, 503, "archive_unavailable", "The director archive could not be read.", true);
  }
}

type RouteContext = {
  config: SupabaseConfig;
  token: string;
  jamId: string;
  tail: string[];
  options: ArchiveHandlerOptions;
};

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const { config, token, jamId, tail, options } = context;

  if (tail.length === 0) {
    const sessions = await listArchivedSessions(config, token, jamId, options);
    // Always durable here: these rows came from Postgres and their bytes from
    // the bucket. The container reports `false` when it is holding an archive
    // in memory; a function has nothing to hold.
    sendJson(response, 200, { durable: true, sessions });
    return;
  }

  const sessionId = tail[0];
  if (!SESSION_ID.test(sessionId)) {
    notFound(response);
    return;
  }
  const session = await readArchivedSession(config, token, sessionId, options);
  // A session belonging to another jam answers "there is no archive", not "you
  // may not see it": the second sentence confirms that it exists.
  if (!session || session.jamId !== jamId) {
    notFound(response);
    return;
  }

  if (tail.length === 1) {
    const segments = await listArchivedSegments(config, token, session.id, options);
    sendJson(response, 200, {
      durable: true,
      session,
      segments,
      // Summed from the pieces that are actually stored, not from what the
      // session was expected to produce.
      durationSeconds: segments.reduce((total, piece) => total + piece.durationSeconds, 0),
    });
    return;
  }

  if (tail.length === 2 && tail[1] === "audit") {
    sendJson(response, 200, {
      durable: true,
      audit: await listArchivedAudit(config, token, session.id, options),
    });
    return;
  }

  if (tail.length === 2 && tail[1] === "playlist.m3u8") {
    await sendPlaylist(response, session, context);
    return;
  }

  if (tail.length === 3 && tail[1] === "media") {
    await sendObject(request, response, session, tail[2], context);
    return;
  }

  if (tail.length === 3 && tail[1] === "pieces") {
    await sendPiece(response, session, tail[2], context);
    return;
  }

  if (tail.length === 2 && tail[1] === "video") {
    await sendWholeFilm(response, session, context);
    return;
  }

  notFound(response);
}

/**
 * The VOD playlist for a finished session, built from its stored pieces.
 *
 * Built at read time rather than written when the session ended, so a session
 * whose process died mid-stream still plays up to its last durable piece —
 * which is the failure that actually happens, because the segmenter delivers
 * `finish()` fire-and-forget (supabase/migrations/20260919237000).
 *
 * `EXT-X-PLAYLIST-TYPE:VOD` and `EXT-X-ENDLIST` are what turn a recording into
 * something a player can seek through: it knows every piece and its duration
 * up front, so jumping to a minute fetches the piece holding it instead of
 * everything before it. That is the seeking the single concatenated file at
 * `/video` cannot offer, whatever range it is asked for.
 */
async function sendPlaylist(
  response: ServerResponse,
  session: ArchiveSession,
  context: RouteContext,
): Promise<void> {
  const { config, token, options } = context;
  const segments = await listArchivedSegments(config, token, session.id, options);
  if (!segments.length) {
    fail(response, 404, "not_found", "That session stored no video.");
    return;
  }
  const container = asContainer(session.container);
  const playlist = buildMediaPlaylist({
    segments: segments.map((piece) => ({
      sequence: piece.segmentIndex,
      durationSeconds: piece.durationSeconds,
    })),
    initUri: `media/${initObjectName(container)}`,
    segmentUri: (sequence) => `media/${pieceObjectName(container, sequence)}`,
    // Nothing will ever be appended to an archive: the session is over, and a
    // player that is not told so polls this file forever.
    ended: true,
    playlistType: "VOD",
  });
  response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.statusCode = 200;
  response.end(playlist);
}

/**
 * One stored object, with the caller's `Range` forwarded to Storage.
 *
 * This is the byte-range half of playback: the playlist says which piece holds
 * a given second, and this serves that piece — in whole, or in the window a
 * player asks for when it is seeking inside one. Storage answers the range; we
 * pass its answer back rather than reading the object and slicing it here,
 * because slicing here would mean holding the piece in the function.
 *
 * No storage URL ever reaches the browser. The bucket stays private and the
 * bytes come through this route, so a piece cannot outlive the membership
 * check above the way a signed URL would.
 */
async function sendObject(
  request: IncomingMessage,
  response: ServerResponse,
  session: ArchiveSession,
  name: string,
  context: RouteContext,
): Promise<void> {
  const { config, token, jamId, options } = context;
  const range = request.headers.range ?? null;
  const object = await readArchiveObject(
    config,
    token,
    readDirectorBucket(options.env ?? process.env),
    `${jamId}/${session.id}/${name}`,
    { ...options, range },
  );
  if (!object) {
    fail(response, 404, "not_found", "That piece is not in the archive.");
    return;
  }
  response.setHeader("Content-Type", object.contentType);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (object.contentLength) response.setHeader("Content-Length", object.contentLength);
  if (object.contentRange) response.setHeader("Content-Range", object.contentRange);
  response.statusCode = object.status;
  await streamInto(response, object.body, true);
}

/** Pipes a fetch body into the response. `end` closes the response after it. */
async function streamInto(
  response: ServerResponse,
  body: ReadableStream<Uint8Array> | null,
  end: boolean,
): Promise<void> {
  if (!body) {
    if (end) response.end();
    return;
  }
  const source = Readable.fromWeb(body as never);
  await new Promise<void>((resolve, reject) => {
    source.on("error", reject);
    source.on("end", resolve);
    source.pipe(response, { end });
  });
  if (end) response.end();
}

/**
 * One piece of the film, playable on its own — the seek primitive for anything
 * that is not reading the playlist.
 *
 * Each piece begins on a keyframe, so `initial header + piece` decodes from its
 * first frame in a plain `<video>`. The header is stored once and prepended
 * here, so seeking costs one small object plus the piece.
 */
async function sendPiece(
  response: ServerResponse,
  session: ArchiveSession,
  index: string,
  context: RouteContext,
): Promise<void> {
  const { config, token, jamId, options } = context;
  const wanted = Number(index);
  if (!Number.isInteger(wanted) || wanted < 0) {
    fail(response, 400, "invalid_command", "That piece index is not valid.");
    return;
  }
  const segments = await listArchivedSegments(config, token, session.id, options);
  const piece = segments.find((candidate) => candidate.segmentIndex === wanted);
  if (!piece) {
    fail(response, 404, "not_found", "That piece is not in the archive.");
    return;
  }
  const container = asContainer(session.container);
  const bucket = readDirectorBucket(options.env ?? process.env);
  const init = await readArchiveObject(
    config, token, bucket, `${jamId}/${session.id}/${initObjectName(container)}`, options,
  );
  const bytes = await readArchiveObject(
    config, token, bucket, `${jamId}/${session.id}/${pieceObjectName(container, wanted)}`, options,
  );
  if (!init || !bytes) {
    fail(response, 404, "not_found", "That piece is not in the archive.");
    return;
  }
  response.setHeader("Content-Type", containerContentType(container));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  // Where this piece sits on the film's clock, so a player can show it.
  response.setHeader("X-Piece-Start-Seconds", String(piece.startSeconds));
  response.setHeader("X-Piece-Duration-Seconds", String(piece.durationSeconds));
  response.statusCode = 200;
  await streamInto(response, init.body, false);
  await streamInto(response, bytes.body, true);
}

/**
 * The whole archived session as one playable file.
 *
 * Both layouts concatenate: WebM is its initial header followed by clusters,
 * and fMP4 is its init segment followed by media segments. So a finished
 * session plays in a plain `<video>` with no playlist and no player library —
 * which is what this route is for, and the only thing it is better at.
 *
 * It deliberately does NOT accept a range. The film is stored as many objects,
 * so a byte offset into the concatenation is not an offset into anything that
 * exists, and honouring one would mean reading the pieces to count them.
 * Seeking belongs to `playlist.m3u8`, where the pieces are addressed by time.
 */
async function sendWholeFilm(
  response: ServerResponse,
  session: ArchiveSession,
  context: RouteContext,
): Promise<void> {
  const { config, token, jamId, options } = context;
  const segments = await listArchivedSegments(config, token, session.id, options);
  if (!segments.length) {
    fail(response, 404, "not_found", "That session stored no video.");
    return;
  }
  const container = asContainer(session.container);
  const bucket = readDirectorBucket(options.env ?? process.env);
  const init = await readArchiveObject(
    config, token, bucket, `${jamId}/${session.id}/${initObjectName(container)}`, options,
  );
  // Without the initial header the pieces cannot be decoded, so an archive
  // missing it is refused rather than served as an unplayable file.
  if (!init) {
    fail(response, 404, "not_found", "That session stored no video.");
    return;
  }
  response.setHeader("Content-Type", containerContentType(container));
  response.setHeader("Accept-Ranges", "none");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.statusCode = 200;
  await streamInto(response, init.body, false);
  for (const piece of segments) {
    const object = await readArchiveObject(
      config, token, bucket, `${jamId}/${session.id}/${pieceObjectName(container, piece.segmentIndex)}`, options,
    );
    // A gap would silently corrupt the file. The rows only exist for uploads
    // that succeeded, so a missing object here means the bucket lost it, and
    // stopping is more honest than writing a broken tail.
    if (!object) break;
    await streamInto(response, object.body, false);
  }
  response.end();
}
