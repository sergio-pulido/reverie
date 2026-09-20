import {
  MAX_SEGMENT_BYTES,
  MediaStorageError,
  resolveObjectStorageConfig,
  type ObjectStorageConfig,
} from "./objectStorage";

/**
 * Where an escape room's generated segments are kept.
 *
 * A location's idle loop is generated once and played for the rest of the
 * session, and a beat is played once and then kept so the room can look back
 * at what it did — so unlike a director recording, these are read many times.
 * They are served by our own routes from a private bucket; no storage URL and
 * no provider URL ever reaches a browser.
 *
 * `durable` is reported honestly. Without a service-role key the segments sit
 * in memory and are lost on restart, and the API says so rather than implying
 * an archive that does not exist.
 */

const UPLOAD_TIMEOUT_MS = 120_000;
/**
 * Three locations' loops plus a full run of beats, for a couple of rooms. A
 * server without storage is a demo server, and this bounds what it holds.
 */
const MAX_IN_MEMORY_SEGMENTS = 48;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface StoredSegment {
  bytes: Buffer;
  contentType: string;
  storedAt: string;
}

export interface EscapeMediaStore {
  readonly durable: boolean;
  save(jamId: string, mediaId: string, bytes: Buffer, contentType: string): Promise<void>;
  get(jamId: string, mediaId: string): Promise<StoredSegment | null>;
}

function assertWithinCaps(bytes: Buffer): void {
  if (bytes.byteLength > MAX_SEGMENT_BYTES) {
    throw new MediaStorageError("The generated segment exceeds the size cap.", false);
  }
}

export class InMemoryEscapeMediaStore implements EscapeMediaStore {
  readonly durable = false;
  private readonly segments = new Map<string, StoredSegment>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async save(jamId: string, mediaId: string, bytes: Buffer, contentType: string): Promise<void> {
    assertWithinCaps(bytes);
    if (this.segments.size >= MAX_IN_MEMORY_SEGMENTS) {
      const oldest = this.segments.keys().next().value;
      if (oldest) this.segments.delete(oldest);
    }
    this.segments.set(`${jamId}/${mediaId}`, {
      bytes,
      contentType,
      storedAt: this.clock().toISOString(),
    });
  }

  async get(jamId: string, mediaId: string): Promise<StoredSegment | null> {
    return this.segments.get(`${jamId}/${mediaId}`) ?? null;
  }
}

export class SupabaseEscapeMediaStore implements EscapeMediaStore {
  readonly durable = true;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ObjectStorageConfig,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async save(jamId: string, mediaId: string, bytes: Buffer, contentType: string): Promise<void> {
    assertWithinCaps(bytes);
    const response = await this.request("POST", this.objectPath(jamId, mediaId), {
      headers: { "content-type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      // The storage body can name the bucket or the key's role, so it is
      // never forwarded: the failure stays honest without leaking anything.
      throw new MediaStorageError(
        "The generated segment could not be stored.",
        response.status >= 500,
      );
    }
  }

  async get(jamId: string, mediaId: string): Promise<StoredSegment | null> {
    const response = await this.request("GET", this.objectPath(jamId, mediaId), {});
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new MediaStorageError(
        "The generated segment could not be read.",
        response.status >= 500,
      );
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "video/mp4",
      storedAt: response.headers.get("last-modified") ?? new Date().toISOString(),
    };
  }

  /** Ids reach the object key, so anything not plainly safe is refused. */
  private objectPath(jamId: string, mediaId: string): string {
    if (!SAFE_ID.test(jamId) || !SAFE_ID.test(mediaId)) {
      throw new MediaStorageError("That id cannot address a stored segment.", false);
    }
    return `/storage/v1/object/${this.config.bucket}/escape/${jamId}/${mediaId}.mp4`;
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
      throw new MediaStorageError("Segment storage could not be reached.", true);
    }
  }
}

/** Durable storage when a service-role key is configured, memory otherwise. */
export function resolveEscapeMediaStore(
  env: NodeJS.ProcessEnv = process.env,
): EscapeMediaStore {
  const config = resolveObjectStorageConfig(env);
  return config ? new SupabaseEscapeMediaStore(config) : new InMemoryEscapeMediaStore();
}
