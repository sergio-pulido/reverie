import {
  assertClipWithinCaps,
  InMemoryPortionMediaStore,
  type PortionMediaStore,
  type StoredClip,
} from "./media";

// Durable clip storage on Supabase Storage, behind the same PortionMediaStore
// boundary as the in-memory default. Clips are still served to participants by
// `GET /api/jams/:id/portions/:index/video`: the bucket is private and no
// storage URL, key or provider URL ever reaches the browser.

const DEFAULT_BUCKET = "jam-portions";
const READ_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** How long a listing of a jam's stored clips is trusted before it is re-read. */
const INDEX_TTL_MS = 5_000;
const MAX_LISTED_CLIPS = 100;

const SAFE_BUCKET = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SAFE_JAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class MediaStorageError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "MediaStorageError";
  }
}

export interface PortionStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

/**
 * Storage is configured only when the server holds a service-role key. That key
 * stays on this host: it is never sent to the browser, never logged, and never
 * read by the Vercel functions, which authenticate as the caller instead
 * (`api/_lib/supabase-rest.ts`).
 */
export function resolvePortionStorageConfig(
  env: NodeJS.ProcessEnv,
): PortionStorageConfig | null {
  const url = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL)?.trim().replace(/\/$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  const bucket = env.REVERIE_PORTION_BUCKET?.trim() || DEFAULT_BUCKET;
  if (!SAFE_BUCKET.test(bucket)) {
    throw new MediaStorageError("REVERIE_PORTION_BUCKET is not a valid bucket name.", false);
  }
  return { url, serviceRoleKey, bucket };
}

/** The store the server runs with: durable when Storage is configured, the
 * bounded in-memory store otherwise. A build never silently claims the first. */
export function resolvePortionMediaStore(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): PortionMediaStore {
  const config = resolvePortionStorageConfig(env);
  return config
    ? new SupabasePortionMediaStore(config, { fetchImpl })
    : new InMemoryPortionMediaStore();
}

export interface SupabaseMediaOptions {
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

type JamIndex = { readAt: number; indices: Set<number> };

export class SupabasePortionMediaStore implements PortionMediaStore {
  readonly durable = true;
  private readonly cache = new InMemoryPortionMediaStore();
  private readonly index = new Map<string, JamIndex>();
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(
    private readonly config: PortionStorageConfig,
    options: SupabaseMediaOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  async put(jamId: string, portionIndex: number, bytes: Buffer, contentType: string): Promise<void> {
    const path = this.objectPath(jamId, portionIndex);
    if (!path) throw new MediaStorageError("That jam id cannot address stored media.", false);
    const known = await this.knownIndices(jamId);
    assertClipWithinCaps(bytes, known.size, !known.has(portionIndex));

    const response = await this.request(
      "POST",
      `/storage/v1/object/${this.config.bucket}/${path}`,
      {
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: { "content-type": contentType, "x-upsert": "true" },
        body: new Uint8Array(bytes),
      },
    );
    if (!response.ok) {
      // A storage error body can name the bucket or the key's role, so it is
      // never forwarded; the job fails honestly instead.
      throw new MediaStorageError("The generated clip could not be stored.", response.status >= 500);
    }
    known.add(portionIndex);
    await this.cache.put(jamId, portionIndex, bytes, contentType);
  }

  async get(jamId: string, portionIndex: number): Promise<StoredClip | null> {
    const cached = await this.cache.get(jamId, portionIndex);
    if (cached) return cached;
    const path = this.objectPath(jamId, portionIndex);
    if (!path) return null;

    const response = await this.request("GET", `/storage/v1/object/${this.config.bucket}/${path}`, {
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new MediaStorageError("The stored clip could not be read.", true);

    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "video/mp4";
    const clip: StoredClip = { bytes, contentType, storedAt: this.clock().toISOString() };
    // Cache caps are advisory here: an oversized stored object is served but
    // not cached rather than failing the read.
    try {
      await this.cache.put(jamId, portionIndex, bytes, contentType);
    } catch {
      /* keep serving the clip we already hold */
    }
    return clip;
  }

  async has(jamId: string, portionIndex: number): Promise<boolean> {
    if (await this.cache.has(jamId, portionIndex)) return true;
    return (await this.knownIndices(jamId)).has(portionIndex);
  }

  async deleteJam(jamId: string): Promise<void> {
    await this.cache.deleteJam(jamId);
    const indices = [...(await this.knownIndices(jamId))];
    this.index.delete(jamId);
    if (indices.length === 0) return;
    const prefixes = indices
      .map((index) => this.objectPath(jamId, index))
      .filter((path): path is string => path !== null);
    const response = await this.request("DELETE", `/storage/v1/object/${this.config.bucket}`, {
      timeoutMs: READ_TIMEOUT_MS,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes }),
    });
    if (!response.ok) throw new MediaStorageError("The stored clips could not be removed.", true);
  }

  /** `jams/<jamId>/portions/<index>.mp4`, or null for an id that cannot
   * safely address an object. Jam ids reach this from the request path. */
  private objectPath(jamId: string, portionIndex: number): string | null {
    if (!SAFE_JAM_ID.test(jamId)) return null;
    if (!Number.isInteger(portionIndex) || portionIndex < 0) return null;
    return `jams/${jamId}/portions/${portionIndex}.mp4`;
  }

  /**
   * Which portions this jam already has stored, read as one listing per jam
   * rather than one request per portion: every playback poll asks about every
   * portion, so a per-portion probe would multiply storage traffic by the
   * portion count.
   */
  private async knownIndices(jamId: string): Promise<Set<number>> {
    const cached = this.index.get(jamId);
    const now = this.clock().getTime();
    if (cached && now - cached.readAt < INDEX_TTL_MS) return cached.indices;
    if (!SAFE_JAM_ID.test(jamId)) return new Set();

    const response = await this.request("POST", `/storage/v1/object/list/${this.config.bucket}`, {
      timeoutMs: READ_TIMEOUT_MS,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prefix: `jams/${jamId}/portions`,
        limit: MAX_LISTED_CLIPS,
        offset: 0,
      }),
    });
    if (!response.ok) throw new MediaStorageError("Stored clips could not be listed.", true);

    const body: unknown = await response.json().catch(() => null);
    const indices = new Set<number>();
    if (Array.isArray(body)) {
      for (const entry of body) {
        const name = (entry as { name?: unknown } | null)?.name;
        const match = typeof name === "string" ? /^(\d+)\.mp4$/.exec(name) : null;
        if (match) indices.add(Number(match[1]));
      }
    }
    this.index.set(jamId, { readAt: now, indices });
    return indices;
  }

  private async request(
    method: string,
    path: string,
    options: { timeoutMs: number; headers?: Record<string, string>; body?: BodyInit },
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
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new MediaStorageError("Clip storage could not be reached.", true);
    }
  }
}
