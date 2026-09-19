import type { DirectorRecordingSink } from "./directorStream";
import {
  MediaStorageError,
  resolveObjectStorageConfig,
  type ObjectStorageConfig,
} from "./objectStorage";

/**
 * Where a finished director recording is kept.
 *
 * A recording is one session's whole stream, so it is stored under its session
 * id rather than sliced. It keeps its own `director/` prefix in the bucket so a
 * future consumer of the same bucket cannot collide with it.
 *
 * `durable` is reported honestly. Without a service-role key the recording
 * stays in memory and is lost on restart, and the API says so rather than
 * implying an archive that does not exist.
 */

const UPLOAD_TIMEOUT_MS = 120_000;
/** A director session can run for minutes; a portion clip cannot. */
export const MAX_RECORDING_BYTES = 512 * 1024 * 1024;
/** Bounded so a long-running server cannot grow without limit. */
const MAX_IN_MEMORY_RECORDINGS = 8;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The container follows the negotiated codec, so the key must follow it too. */
const EXTENSIONS: Record<string, string> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
};

export interface StoredRecording {
  bytes: Buffer;
  contentType: string;
  storedAt: string;
}

export interface DirectorRecordingStore extends DirectorRecordingSink {
  readonly durable: boolean;
  get(jamId: string, sessionId: string): Promise<StoredRecording | null>;
}

export class InMemoryDirectorRecordingStore implements DirectorRecordingStore {
  readonly durable = false;
  private readonly recordings = new Map<string, StoredRecording>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async save(jamId: string, sessionId: string, bytes: Buffer, contentType: string): Promise<void> {
    assertRecordingWithinCaps(bytes);
    if (this.recordings.size >= MAX_IN_MEMORY_RECORDINGS) {
      const oldest = this.recordings.keys().next().value;
      if (oldest) this.recordings.delete(oldest);
    }
    this.recordings.set(`${jamId}/${sessionId}`, {
      bytes,
      contentType,
      storedAt: this.clock().toISOString(),
    });
  }

  async get(jamId: string, sessionId: string): Promise<StoredRecording | null> {
    return this.recordings.get(`${jamId}/${sessionId}`) ?? null;
  }
}

export function assertRecordingWithinCaps(bytes: Buffer): void {
  if (bytes.byteLength > MAX_RECORDING_BYTES) {
    throw new MediaStorageError("The recording exceeds the size cap.", false);
  }
}

export interface SupabaseRecordingOptions {
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export class SupabaseDirectorRecordingStore implements DirectorRecordingStore {
  readonly durable = true;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ObjectStorageConfig,
    options: SupabaseRecordingOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async save(jamId: string, sessionId: string, bytes: Buffer, contentType: string): Promise<void> {
    assertRecordingWithinCaps(bytes);
    const path = this.objectPath(jamId, sessionId, contentType);
    const response = await this.request("POST", path, {
      headers: { "content-type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      // The storage body can name the bucket or the key's role; it is never
      // forwarded, so the failure stays honest without leaking configuration.
      throw new MediaStorageError(
        "The director recording could not be stored.",
        response.status >= 500,
      );
    }
  }

  /**
   * Reads an archive without being told its container.
   *
   * The key's extension follows the negotiated codec, and a reader has no way
   * to know which was used, so each known container is tried in turn. Only a
   * 404 moves on to the next: a real failure is reported rather than being
   * mistaken for "stored under the other extension".
   */
  async get(jamId: string, sessionId: string): Promise<StoredRecording | null> {
    for (const contentType of Object.keys(EXTENSIONS)) {
      const response = await this.request(
        "GET",
        this.objectPath(jamId, sessionId, contentType),
        {},
      );
      // Storage answers a missing object with HTTP 400 and a body whose
      // statusCode is "404", so status alone never matches. Treated as a miss
      // exactly as SupabasePortionMediaStore does; without this a recording
      // that simply is not there is reported as a store outage.
      if (response.status === 404 || response.status === 400) continue;
      if (!response.ok) {
        throw new MediaStorageError(
          "The director recording could not be read.",
          response.status >= 500,
        );
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? contentType,
        storedAt: response.headers.get("last-modified") ?? new Date().toISOString(),
      };
    }
    return null;
  }

  /** Ids reach the object key, so anything that is not plainly safe is refused. */
  private objectPath(jamId: string, sessionId: string, contentType?: string): string {
    if (!SAFE_ID.test(jamId) || !SAFE_ID.test(sessionId)) {
      throw new MediaStorageError("That id cannot address a stored recording.", false);
    }
    const extension = contentType ? EXTENSIONS[contentType] : undefined;
    // A read does not know the container, so it looks for what was written.
    // `.webm` stays the fallback because that is what every archive written
    // before the codec became negotiable was named.
    return `/storage/v1/object/${this.config.bucket}/${jamId}/${sessionId}.${extension ?? "webm"}`;
  }

  private async request(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: BodyInit },
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.config.url}${path}`, {
        method,
        headers: {
          apikey: this.config.serviceRoleKey,
          authorization: `Bearer ${this.config.serviceRoleKey}`,
          ...options.headers,
        },
        body: options.body,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new MediaStorageError("Recording storage could not be reached.", true);
    }
  }
}

const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** Created by supabase/migrations/20260919236000_jam_director_archive.sql. */
const DEFAULT_DIRECTOR_BUCKET = "jam-director";

/**
 * Where director archives go.
 *
 * Deliberately NOT the default `jam-portions` bucket. It allows `video/mp4`
 * only and caps objects at 64MB, so every director upload it received was
 * rejected: this store writes WebM or fragmented MP4 depending on the codec
 * fal negotiates, and a session archive is far larger than that cap. The
 * rejection was invisible for as long as the local stack had no Storage
 * service, because without one the store falls back to memory and reports
 * success.
 */
export function resolveDirectorStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig | null {
  const shared = resolveObjectStorageConfig(env);
  if (!shared) return null;
  const bucket = env.REVERIE_DIRECTOR_BUCKET?.trim() || DEFAULT_DIRECTOR_BUCKET;
  if (!SAFE_BUCKET.test(bucket)) {
    throw new MediaStorageError("REVERIE_DIRECTOR_BUCKET is not a valid bucket name.", false);
  }
  return { ...shared, bucket };
}

/** Durable storage when a service-role key is configured, memory otherwise. */
export function resolveDirectorRecordingStore(
  env: NodeJS.ProcessEnv = process.env,
): DirectorRecordingStore {
  const config = resolveDirectorStorageConfig(env);
  return config
    ? new SupabaseDirectorRecordingStore(config)
    : new InMemoryDirectorRecordingStore();
}
