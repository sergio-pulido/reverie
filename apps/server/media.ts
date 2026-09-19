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
 * (docs/API_CONTRACTS.md "Delivery"). Bounded per jam and across jams;
 * clients only ever see these bytes, never provider URLs.
 */
export class InMemoryPortionMediaStore {
  private readonly jams = new Map<string, Map<number, StoredClip>>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  put(jamId: string, portionIndex: number, bytes: Buffer, contentType: string): void {
    if (bytes.byteLength > MAX_CLIP_BYTES) {
      throw new Error("Clip exceeds the per-clip size cap.");
    }
    let clips = this.jams.get(jamId);
    if (!clips) {
      if (this.jams.size >= MAX_JAMS_WITH_MEDIA) {
        const oldest = this.jams.keys().next().value;
        if (oldest) this.jams.delete(oldest);
      }
      clips = new Map();
      this.jams.set(jamId, clips);
    }
    if (!clips.has(portionIndex) && clips.size >= MAX_PORTIONS) {
      throw new Error("Clip count cap reached for this jam.");
    }
    clips.set(portionIndex, {
      bytes,
      contentType,
      storedAt: this.clock().toISOString(),
    });
  }

  get(jamId: string, portionIndex: number): StoredClip | null {
    return this.jams.get(jamId)?.get(portionIndex) ?? null;
  }

  has(jamId: string, portionIndex: number): boolean {
    return this.jams.get(jamId)?.has(portionIndex) ?? false;
  }

  /** Evict every clip a jam holds (room close or store eviction). */
  deleteJam(jamId: string): void {
    this.jams.delete(jamId);
  }
}
