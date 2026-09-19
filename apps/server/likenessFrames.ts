import {
  FRAME_CONTENT_TYPES,
  MAX_FRAME_BYTES,
  MAX_FRAME_PIXELS,
  MIN_FRAME_PIXELS,
} from "../../src/core/likeness";
import {
  MediaStorageError,
  resolveObjectStorageConfig,
  type ObjectStorageConfig,
} from "./objectStorage";

/**
 * Where an approved frame lives, and what counts as one.
 *
 * The frame is the most sensitive thing this product holds: it is a photograph of a person,
 * kept because they said it could be. So it is never public, never addressable by URL, never
 * served to anyone but its owner, and never kept past the consent that justifies it.
 *
 * Nothing here decides whether a frame may be used. `src/core/likeness.ts` does, and every
 * caller of this module has already asked it.
 */

const UPLOAD_TIMEOUT_MS = 30_000;
/** Bounded so a long-running local server cannot grow without limit. */
const MAX_IN_MEMORY_FRAMES = 16;
/** A reference is `likeness:<uuid>`; only that shape can address an object. */
const SAFE_REF = /^likeness:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FrameRefusal =
  | "frame_type_unsupported"
  | "frame_too_large"
  | "frame_unreadable"
  | "frame_too_small"
  | "frame_too_big";

export const FRAME_REFUSAL_MESSAGE: Record<FrameRefusal, string> = {
  frame_type_unsupported: "A frame has to be a JPEG or a PNG.",
  frame_too_large: "That frame is larger than this room accepts.",
  frame_unreadable: "That frame could not be read as an image.",
  frame_too_small: `A frame has to be at least ${MIN_FRAME_PIXELS}×${MIN_FRAME_PIXELS} pixels.`,
  frame_too_big: `A frame has to be at most ${MAX_FRAME_PIXELS}×${MAX_FRAME_PIXELS} pixels.`,
};

export interface FrameDimensions {
  width: number;
  height: number;
}

/**
 * Width and height straight out of the header, for the two formats a browser canvas
 * produces. Reading them here is what turns a provider-side rejection — measured:
 * `image_too_small`, minimum 256×256 — into a sentence the person sees before anything is
 * spent on their behalf.
 */
export function readFrameDimensions(bytes: Uint8Array): FrameDimensions | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segment chain to the frame header, which is the only one carrying the size.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      // SOF0..SOF15, excluding the two markers in that range that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Whether these bytes are a frame this room will accept.
 *
 * The upper bound is a spend decision as much as a payload one: the provider includes 4,096
 * reference tokens per request and charges beyond them, and a 1024×1024 image is 1,024
 * tokens. Capping a frame at 1024×1024 keeps our three-reference limit inside the included
 * allowance, so appearing in the film costs the room the clip and nothing extra.
 */
export function checkFrame(
  contentType: string,
  bytes: Uint8Array,
): { ok: true; dimensions: FrameDimensions } | { ok: false; reason: FrameRefusal } {
  if (!(FRAME_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return { ok: false, reason: "frame_type_unsupported" };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) {
    return { ok: false, reason: "frame_too_large" };
  }
  const dimensions = readFrameDimensions(bytes);
  if (!dimensions || dimensions.width === 0 || dimensions.height === 0) {
    return { ok: false, reason: "frame_unreadable" };
  }
  if (dimensions.width < MIN_FRAME_PIXELS || dimensions.height < MIN_FRAME_PIXELS) {
    return { ok: false, reason: "frame_too_small" };
  }
  if (dimensions.width > MAX_FRAME_PIXELS || dimensions.height > MAX_FRAME_PIXELS) {
    return { ok: false, reason: "frame_too_big" };
  }
  return { ok: true, dimensions };
}

export interface StoredFrame {
  bytes: Buffer;
  contentType: string;
  storedAt: string;
}

export interface FrameStore {
  /** Honest, and reported to the room: without it a frame is lost on restart. */
  readonly durable: boolean;
  put(jamId: string, assetRef: string, bytes: Buffer, contentType: string): Promise<void>;
  get(jamId: string, assetRef: string): Promise<StoredFrame | null>;
  /** Called when a grant ends. A frame outliving its consent is the thing to avoid. */
  discard(jamId: string, assetRef: string): Promise<void>;
}

function objectName(assetRef: string): string {
  if (!SAFE_REF.test(assetRef)) {
    throw new MediaStorageError("That reference cannot address a frame.", false);
  }
  return assetRef.slice("likeness:".length);
}

export class InMemoryFrameStore implements FrameStore {
  readonly durable = false;
  private readonly frames = new Map<string, StoredFrame>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async put(jamId: string, assetRef: string, bytes: Buffer, contentType: string): Promise<void> {
    const key = `${jamId}/${objectName(assetRef)}`;
    if (!this.frames.has(key) && this.frames.size >= MAX_IN_MEMORY_FRAMES) {
      const oldest = this.frames.keys().next().value;
      if (oldest) this.frames.delete(oldest);
    }
    this.frames.set(key, { bytes, contentType, storedAt: this.clock().toISOString() });
  }

  async get(jamId: string, assetRef: string): Promise<StoredFrame | null> {
    return this.frames.get(`${jamId}/${objectName(assetRef)}`) ?? null;
  }

  async discard(jamId: string, assetRef: string): Promise<void> {
    this.frames.delete(`${jamId}/${objectName(assetRef)}`);
  }
}

/**
 * The private bucket, reached with the service-role key this host holds. No signed URL is
 * ever minted: the bytes are read here and served by our own route, so there is no address
 * for a participant's face that outlives the room's authorization checks.
 */
export class SupabaseFrameStore implements FrameStore {
  readonly durable = true;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ObjectStorageConfig,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async put(jamId: string, assetRef: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await this.request("POST", this.path(jamId, assetRef), {
      headers: { "content-type": contentType, "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw new MediaStorageError("That frame could not be stored.", response.status >= 500);
    }
  }

  async get(jamId: string, assetRef: string): Promise<StoredFrame | null> {
    const response = await this.request("GET", this.path(jamId, assetRef), {});
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new MediaStorageError("That frame could not be read.", response.status >= 500);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "image/jpeg",
      storedAt: response.headers.get("last-modified") ?? new Date().toISOString(),
    };
  }

  async discard(jamId: string, assetRef: string): Promise<void> {
    // A frame that is already gone is the state we wanted; only a real failure is raised.
    const response = await this.request("DELETE", this.path(jamId, assetRef), {});
    if (!response.ok && response.status !== 404) {
      throw new MediaStorageError("That frame could not be discarded.", response.status >= 500);
    }
  }

  private path(jamId: string, assetRef: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jamId)) {
      throw new MediaStorageError("That id cannot address a frame.", false);
    }
    return `/storage/v1/object/${this.config.bucket}/likeness/${jamId}/${objectName(assetRef)}`;
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
      throw new MediaStorageError("Frame storage could not be reached.", true);
    }
  }
}

export function resolveFrameStore(env: NodeJS.ProcessEnv = process.env): FrameStore {
  const config = resolveObjectStorageConfig(env);
  return config ? new SupabaseFrameStore(config) : new InMemoryFrameStore();
}
