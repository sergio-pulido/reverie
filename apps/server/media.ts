import { MAX_PORTIONS } from "../../src/core/script";
import { MAX_CLIP_BYTES } from "./providers/fal";

const MAX_JAMS_WITH_MEDIA = 20;

export interface StoredClip {
  bytes: Buffer;
  contentType: string;
  storedAt: string;
}

/**
 * Server-owned clip storage, deliberately outside the JamStore boundary
 * (docs/API_CONTRACTS.md "Delivery"). Clients only ever see these bytes,
 * never a provider or storage URL, whichever implementation is in use.
 *
 * `durable` says whether clips outlive the process. It is reported honestly
 * rather than assumed: a build without object storage configured keeps clips
 * in memory only, and must not claim otherwise.
 */
export interface PortionMediaStore {
  readonly durable: boolean;
  put(jamId: string, portionIndex: number, bytes: Buffer, contentType: string): Promise<void>;
  get(jamId: string, portionIndex: number): Promise<StoredClip | null>;
  has(jamId: string, portionIndex: number): Promise<boolean>;
  /** Evict every clip a jam holds (room close or store eviction). */
  deleteJam(jamId: string): Promise<void>;
}

/** Rejects a clip that breaks a storage cap before any of it is stored. */
export function assertClipWithinCaps(bytes: Buffer, existingClipCount: number, isNewIndex: boolean): void {
  if (bytes.byteLength > MAX_CLIP_BYTES) {
    throw new Error("Clip exceeds the per-clip size cap.");
  }
  if (isNewIndex && existingClipCount >= MAX_PORTIONS) {
    throw new Error("Clip count cap reached for this jam.");
  }
}

/** Bounded per jam and across jams. The default store, and the read cache
 * in front of object storage. */
export class InMemoryPortionMediaStore implements PortionMediaStore {
  readonly durable = false;
  private readonly jams = new Map<string, Map<number, StoredClip>>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async put(jamId: string, portionIndex: number, bytes: Buffer, contentType: string): Promise<void> {
    let clips = this.jams.get(jamId);
    assertClipWithinCaps(bytes, clips?.size ?? 0, !clips?.has(portionIndex));
    if (!clips) {
      if (this.jams.size >= MAX_JAMS_WITH_MEDIA) {
        const oldest = this.jams.keys().next().value;
        if (oldest) this.jams.delete(oldest);
      }
      clips = new Map();
      this.jams.set(jamId, clips);
    }
    clips.set(portionIndex, {
      bytes,
      contentType,
      storedAt: this.clock().toISOString(),
    });
  }

  async get(jamId: string, portionIndex: number): Promise<StoredClip | null> {
    return this.jams.get(jamId)?.get(portionIndex) ?? null;
  }

  async has(jamId: string, portionIndex: number): Promise<boolean> {
    return this.jams.get(jamId)?.has(portionIndex) ?? false;
  }

  async deleteJam(jamId: string): Promise<void> {
    this.jams.delete(jamId);
  }
}
