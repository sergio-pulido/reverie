import {
  FRAME_CONTENT_TYPES,
  MAX_FRAME_BYTES,
  MAX_FRAME_PIXELS,
  MIN_FRAME_PIXELS,
} from "../../src/core/likeness";
import { MediaStorageError } from "./objectStorage";
import { resolvePrivateObjectStore, type PrivateObjectStore } from "./privateObjects";

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
 * The upper bound is a payload decision: the provider includes 4,096
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

/**
 * The object name behind a reference.
 *
 * Only the shape the register's trigger issues can address a frame, so a reference that came
 * from anywhere else cannot name an object at all.
 */
export function frameObjectName(assetRef: string): string {
  if (!SAFE_REF.test(assetRef)) {
    throw new MediaStorageError("That reference cannot address a frame.", false);
  }
  return assetRef.slice("likeness:".length);
}

/** Frames live under their own prefix in the private bucket, beside nothing else. */
export const FRAME_PREFIX = "likeness";
/** Bounded so a long-running local server cannot grow without limit. */
export const MAX_IN_MEMORY_FRAMES = 16;

export function resolveFrameStore(env: NodeJS.ProcessEnv = process.env): PrivateObjectStore {
  return resolvePrivateObjectStore(FRAME_PREFIX, MAX_IN_MEMORY_FRAMES, env);
}
