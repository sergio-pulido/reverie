import {
  MediaStorageError,
  resolveObjectStorageConfig,
  type ObjectStorageConfig,
} from "./objectStorage";

/**
 * Bytes this server holds on a room's behalf: an approved frame, a generated beat.
 *
 * Every one of them is private. The bucket has no policies on `storage.objects`, no signed
 * URL is ever minted, and nothing here returns an address — the bytes are read here and
 * served by our own routes, so a stored object cannot outlive the authorization checks that
 * guard it.
 *
 * `durable` is reported honestly. Without a service-role key the object lives in memory and
 * is lost on restart, and the routes say so rather than implying an archive.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_JAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
  storedAt: string;
}

export interface PrivateObjectStore {
  readonly durable: boolean;
  put(jamId: string, name: string, bytes: Buffer, contentType: string): Promise<void>;
  get(jamId: string, name: string): Promise<StoredObject | null>;
  discard(jamId: string, name: string): Promise<void>;
}

function assertAddressable(jamId: string, name: string): void {
  if (!SAFE_JAM_ID.test(jamId) || !SAFE_JAM_ID.test(name)) {
    throw new MediaStorageError("That reference cannot address stored bytes.", false);
  }
}

export class InMemoryObjectStore implements PrivateObjectStore {
  readonly durable = false;
  private readonly objects = new Map<string, StoredObject>();

  constructor(
    private readonly capacity: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async put(jamId: string, name: string, bytes: Buffer, contentType: string): Promise<void> {
    assertAddressable(jamId, name);
    const key = `${jamId}/${name}`;
    if (!this.objects.has(key) && this.objects.size >= this.capacity) {
      const oldest = this.objects.keys().next().value;
      if (oldest) this.objects.delete(oldest);
    }
    this.objects.set(key, { bytes, contentType, storedAt: this.clock().toISOString() });
  }

  async get(jamId: string, name: string): Promise<StoredObject | null> {
    assertAddressable(jamId, name);
    return this.objects.get(`${jamId}/${name}`) ?? null;
  }

  async discard(jamId: string, name: string): Promise<void> {
    assertAddressable(jamId, name);
    this.objects.delete(`${jamId}/${name}`);
  }
}

export class SupabaseObjectStore implements PrivateObjectStore {
  readonly durable = true;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ObjectStorageConfig,
    private readonly prefix: string,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async put(jamId: string, name: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await this.request("POST", this.path(jamId, name), {
      headers: { "content-type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      // The storage body can name the bucket or the key's role; it is never forwarded.
      throw new MediaStorageError("Those bytes could not be stored.", response.status >= 500);
    }
  }

  async get(jamId: string, name: string): Promise<StoredObject | null> {
    const response = await this.request("GET", this.path(jamId, name), {});
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new MediaStorageError("Those bytes could not be read.", response.status >= 500);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      storedAt: response.headers.get("last-modified") ?? new Date().toISOString(),
    };
  }

  async discard(jamId: string, name: string): Promise<void> {
    // Already gone is the state we wanted; only a real failure is raised.
    const response = await this.request("DELETE", this.path(jamId, name), {});
    if (!response.ok && response.status !== 404) {
      throw new MediaStorageError("Those bytes could not be discarded.", response.status >= 500);
    }
  }

  private path(jamId: string, name: string): string {
    assertAddressable(jamId, name);
    return `/storage/v1/object/${this.config.bucket}/${this.prefix}/${jamId}/${name}`;
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MediaStorageError("Storage could not be reached.", true);
    }
  }
}

export function resolvePrivateObjectStore(
  prefix: string,
  memoryCapacity: number,
  env: NodeJS.ProcessEnv = process.env,
): PrivateObjectStore {
  const config = resolveObjectStorageConfig(env);
  return config ? new SupabaseObjectStore(config, prefix) : new InMemoryObjectStore(memoryCapacity);
}
