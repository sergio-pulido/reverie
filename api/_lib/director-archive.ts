import { RestError, type SupabaseConfig, type SupabaseRestOptions } from "./supabase-rest.js";

/**
 * Reading a finished director session, as the caller.
 *
 * The container writes the archive with a service-role key; this reads it with
 * the participant's own access token and nothing else, so every row and every
 * object below is still filtered by the policies added in
 * supabase/migrations/20260920110000_director_archive_reads.sql. A function
 * that held the service-role key could serve one room's film to another room's
 * member and never know it.
 *
 * Only reads live here. There is no write path to the index or the bucket from
 * a Vercel function, and no policy that would accept one.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
/** Matches MAX_AUDIT_ROWS_PER_SESSION in apps/server/directorIndex.ts. */
const MAX_AUDIT_ROWS = 500;
const DEFAULT_BUCKET = "jam-director";
const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}$/;

export type ArchiveSession = {
  id: string;
  jamId: string;
  configurationKey: string;
  scriptRevision: number | null;
  codec: string | null;
  container: string | null;
  startedAt: string;
  endedAt: string | null;
  complete: boolean;
  truncatedReason: string | null;
};

export type ArchiveSegment = {
  segmentIndex: number;
  startSeconds: number;
  durationSeconds: number;
  byteSize: number;
  objectPath: string;
};

export type ArchiveAuditEntry = {
  at: string;
  kind: string;
  promptVersion: number | null;
  chunkIndex: number | null;
  scriptOffsetSeconds: number | null;
  proposalId: string | null;
  beatIndex: number | null;
  authorId: string | null;
  body: string | null;
  detail: string | null;
};

/** The bucket the container writes archives to (apps/server/directorRecordings.ts). */
export function readDirectorBucket(env: NodeJS.ProcessEnv = process.env): string {
  const bucket = env.REVERIE_DIRECTOR_BUCKET?.trim() || DEFAULT_BUCKET;
  if (!SAFE_BUCKET.test(bucket)) {
    throw new RestError("unavailable", "The archive store is not configured correctly.");
  }
  return bucket;
}

async function readRows(
  config: SupabaseConfig,
  accessToken: string,
  path: string,
  options: SupabaseRestOptions,
): Promise<Record<string, unknown>[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${config.url}${path}`, {
      method: "GET",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    throw new RestError("unavailable", "The director archive could not be reached.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new RestError("unauthenticated", "That session is not signed in.");
  }
  if (!response.ok) {
    // PostgREST names columns and constraints in its body; it is never
    // forwarded, so a failure stays honest without leaking the schema.
    throw new RestError("unavailable", "The director archive could not be read.");
  }
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new RestError("unavailable", "The director archive returned an unexpected response.");
  }
  return body as Record<string, unknown>[];
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toSession(row: Record<string, unknown>): ArchiveSession {
  return {
    id: String(row.id),
    jamId: String(row.jam_id),
    configurationKey: String(row.configuration_key),
    scriptRevision: nullableNumber(row.script_revision),
    codec: nullableString(row.codec),
    container: nullableString(row.container),
    startedAt: String(row.started_at),
    endedAt: nullableString(row.ended_at),
    complete: row.complete === true,
    truncatedReason: nullableString(row.truncated_reason),
  };
}

/** The sessions a jam has archived, newest first. */
export async function listArchivedSessions(
  config: SupabaseConfig,
  accessToken: string,
  jamId: string,
  options: SupabaseRestOptions = {},
): Promise<ArchiveSession[]> {
  const rows = await readRows(
    config,
    accessToken,
    `/rest/v1/jam_director_sessions?jam_id=eq.${encodeURIComponent(jamId)}` +
      "&order=started_at.desc&limit=100",
    options,
  );
  return rows.map(toSession);
}

/**
 * One session, if this caller may read it.
 *
 * The jam is checked by the caller rather than here, because a session that
 * belongs to another jam must answer "there is no archive for that session"
 * and not "you may not see it": the second sentence confirms it exists.
 */
export async function readArchivedSession(
  config: SupabaseConfig,
  accessToken: string,
  sessionId: string,
  options: SupabaseRestOptions = {},
): Promise<ArchiveSession | null> {
  const rows = await readRows(
    config,
    accessToken,
    `/rest/v1/jam_director_sessions?id=eq.${encodeURIComponent(sessionId)}&limit=1`,
    options,
  );
  return rows.length ? toSession(rows[0]) : null;
}

/** The pieces that actually reached storage, in order. */
export async function listArchivedSegments(
  config: SupabaseConfig,
  accessToken: string,
  sessionId: string,
  options: SupabaseRestOptions = {},
): Promise<ArchiveSegment[]> {
  const rows = await readRows(
    config,
    accessToken,
    `/rest/v1/jam_director_segments?session_id=eq.${encodeURIComponent(sessionId)}` +
      "&order=segment_index.asc",
    options,
  );
  return rows.map((row) => ({
    segmentIndex: Number(row.segment_index),
    startSeconds: Number(row.start_seconds),
    durationSeconds: Number(row.duration_seconds),
    byteSize: Number(row.byte_size),
    objectPath: String(row.object_path),
  }));
}

/** What the room asked for, and what the provider did with it. */
export async function listArchivedAudit(
  config: SupabaseConfig,
  accessToken: string,
  sessionId: string,
  options: SupabaseRestOptions = {},
): Promise<ArchiveAuditEntry[]> {
  const rows = await readRows(
    config,
    accessToken,
    `/rest/v1/jam_director_audit?session_id=eq.${encodeURIComponent(sessionId)}` +
      `&order=at.asc,id.asc&limit=${MAX_AUDIT_ROWS}`,
    options,
  );
  return rows.map((row) => ({
    at: String(row.at),
    kind: String(row.kind),
    promptVersion: nullableNumber(row.prompt_version),
    chunkIndex: nullableNumber(row.chunk_index),
    scriptOffsetSeconds: nullableNumber(row.script_offset_seconds),
    proposalId: nullableString(row.proposal_id),
    beatIndex: nullableNumber(row.beat_index),
    authorId: nullableString(row.author_id),
    body: nullableString(row.body),
    detail: nullableString(row.detail),
  }));
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Each key segment reaches the object path, so each is checked. */
export function isSafeObjectPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length > 0 && segments.every((segment) => SAFE_KEY.test(segment));
}

export type ArchiveObject = {
  /** 200, or 206 when the caller asked for a range and Storage honoured it. */
  status: number;
  contentType: string;
  contentLength: string | null;
  contentRange: string | null;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * One archived object, streamed rather than buffered.
 *
 * A session archive runs to hundreds of megabytes, so the bytes are piped
 * through as they arrive: holding a film in a function's memory to serve one
 * viewer is how the function runs out of it. A `Range` header is forwarded
 * untouched and the answer is passed back with its status, which is what lets
 * a player seek inside a piece instead of refetching it.
 *
 * Deliberately no abort signal: the timeout that belongs here is the platform's
 * function timeout, and a signal sized for a request header would cut the
 * stream off partway through a large piece.
 */
export async function readArchiveObject(
  config: SupabaseConfig,
  accessToken: string,
  bucket: string,
  path: string,
  options: SupabaseRestOptions & { range?: string | null } = {},
): Promise<ArchiveObject | null> {
  if (!isSafeObjectPath(path)) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${config.url}/storage/v1/object/${bucket}/${path}`, {
      method: "GET",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        ...(options.range ? { Range: options.range } : {}),
      },
    });
  } catch {
    throw new RestError("unavailable", "The archive store could not be reached.");
  }

  if (await isMissingObject(response)) return null;
  if (response.status === 401 || response.status === 403) {
    // Under the read policy this is a caller who is not an active member of
    // the jam that owns the object, which is the same answer as "not there".
    return null;
  }
  if (!response.ok && response.status !== 206) {
    throw new RestError("unavailable", "The archive store could not be read.");
  }
  return {
    status: response.status === 206 ? 206 : 200,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    contentLength: response.headers.get("content-length"),
    contentRange: response.headers.get("content-range"),
    body: response.body as ReadableStream<Uint8Array> | null,
  };
}

/** Storage sometimes wraps a missing object in HTTP 400; other 400s are errors. */
async function isMissingObject(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;
  const body = (await response.clone().json().catch(() => null)) as
    | { statusCode?: unknown }
    | null;
  return String(body?.statusCode ?? "") === "404";
}
