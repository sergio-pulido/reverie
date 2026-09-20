/**
 * How long a generated clip actually is, read from the file itself.
 *
 * A model's documentation says what duration it accepts; the file says what
 * it returned. Those are not always the same number, and a room that cuts
 * from a beat back to its loop needs the second one. This reads the ISO
 * base-media header (`moov` → `mvhd`) and answers `null` for anything it does
 * not recognise, because an honest "unknown" is worth more here than a guess
 * that the rest of the timing would then be built on.
 */

const MVHD_HEADER_BYTES = 8;
/** A `size` of 0 means "to the end of the file"; 1 means a 64-bit size follows. */
const SIZE_TO_END = 0;
const SIZE_IS_64_BIT = 1;

export function readMp4DurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(view, 0, view.byteLength, "moov");
  if (!moov) return null;
  const mvhd = findBox(view, moov.start, moov.end, "mvhd");
  if (!mvhd || mvhd.end - mvhd.start < 20) return null;

  const version = view.getUint8(mvhd.start);
  const timescaleAt = mvhd.start + 4 + (version === 1 ? 16 : 8);
  const durationAt = timescaleAt + 4;
  const needed = durationAt + (version === 1 ? 8 : 4);
  if (needed > mvhd.end) return null;

  const timescale = view.getUint32(timescaleAt);
  if (timescale === 0) return null;
  const duration =
    version === 1 ? Number(view.getBigUint64(durationAt)) : view.getUint32(durationAt);
  // Two sentinels mean "unknown length" rather than "very long".
  if (duration === 0 || duration === 0xffffffff) return null;
  return duration / timescale;
}

interface BoxBody {
  /** First byte of the box's payload. */
  start: number;
  /** One past its last byte. */
  end: number;
}

/**
 * The payload of the first `type` box directly inside `[from, to)`.
 *
 * Deliberately not recursive: `mvhd` is a child of `moov` and nothing else
 * here needs a deep search, so a malformed file cannot make this walk far.
 */
function findBox(view: DataView, from: number, to: number, type: string): BoxBody | null {
  let at = from;
  while (at + MVHD_HEADER_BYTES <= to) {
    const declared = view.getUint32(at);
    const name = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    let headerBytes = MVHD_HEADER_BYTES;
    let size = declared;
    if (declared === SIZE_IS_64_BIT) {
      if (at + 16 > to) return null;
      size = Number(view.getBigUint64(at + 8));
      headerBytes = 16;
    } else if (declared === SIZE_TO_END) {
      size = to - at;
    }
    if (size < headerBytes || at + size > to) return null;
    if (name === type) return { start: at + headerBytes, end: at + size };
    at += size;
  }
  return null;
}
