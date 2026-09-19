/**
 * The HLS media playlist a live director stream publishes.
 *
 * This is the whole reason delivery is HTTP rather than a second peer
 * connection. The container holds exactly one long-lived connection — to fal —
 * and everyone watching the same configuration reads plain files from this
 * playlist. No viewer opens a socket, no viewer has state on the server, and a
 * hundred viewers cost what one costs (docs/DECISIONS.md).
 *
 * Nothing here does I/O or knows what a segment contains. It turns a list of
 * finished segments into the text a player asks for, so the rules can be tested
 * without a muxer, a peer, or a browser.
 */

/** A segment that is finished and safe to advertise. */
export interface HlsSegment {
  /**
   * Monotonic, never reused. It is the media sequence number *and* the
   * segment's address: a player that fell behind asks for a number that has
   * left the window and gets a clean 404 rather than someone else's frames.
   */
  sequence: number;
  durationSeconds: number;
}

export interface MediaPlaylistInput {
  /** Oldest first. Only segments that are complete belong here. */
  segments: readonly HlsSegment[];
  /** Address of the fMP4 initialization segment (`EXT-X-MAP`). */
  initUri: string;
  segmentUri: (sequence: number) => string;
  /** True once the session has stopped and no segment will ever follow. */
  ended: boolean;
}

/** HLS version 7 is the floor for `EXT-X-MAP`, which fMP4 delivery requires. */
const PLAYLIST_VERSION = 7;

/**
 * Builds the media playlist.
 *
 * `EXT-X-TARGETDURATION` is rounded **up**, because the spec requires it to be
 * no smaller than any segment it describes and a player treats an undersized
 * one as a broken playlist rather than a hint.
 */
export function buildMediaPlaylist(input: MediaPlaylistInput): string {
  const { segments, initUri, segmentUri, ended } = input;
  const target = segments.reduce(
    (longest, segment) => Math.max(longest, Math.ceil(segment.durationSeconds)),
    1,
  );
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${PLAYLIST_VERSION}`,
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.sequence ?? 0}`,
    // A live stream carries no EXT-X-PLAYLIST-TYPE: VOD would promise the
    // playlist never changes, and EVENT would promise nothing is ever removed.
    // This window drops its oldest segment, so neither is true.
    `#EXT-X-MAP:URI="${initUri}"`,
  ];
  for (const segment of segments) {
    lines.push(`#EXTINF:${segment.durationSeconds.toFixed(3)},`);
    lines.push(segmentUri(segment.sequence));
  }
  // Without this a player polls the playlist forever waiting for a segment that
  // is never coming, and the film never registers as over.
  if (ended) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/**
 * The bounded sliding window of segments a live stream keeps in memory.
 *
 * Bounded because this holds video in the container's heap: a session that ran
 * to its cap with an unbounded buffer would keep every frame it ever produced,
 * and the recording — which is what durable storage is for — already exists
 * elsewhere. Live delivery only ever needs the recent past.
 *
 * Sequence numbers are assigned by the segmenter and keep counting after a
 * segment is evicted, so an address is never reused. A player that stalled long
 * enough to fall out of the window asks for a number that is simply gone; being
 * told that plainly is what lets it re-read the playlist and rejoin, instead of
 * being handed frames from a different part of the film.
 */
export class HlsSegmentWindow {
  private readonly held: { segment: HlsSegment; data: Uint8Array }[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("hls_window_capacity_invalid");
    }
  }

  /**
   * Adds a finished segment under a sequence number chosen elsewhere.
   *
   * The number is given rather than generated because live delivery and the
   * durable archive publish the *same* segments, and the audit trail refers to
   * them by index. A counter of its own here would be a second timeline that
   * silently drifts from the one the record describes.
   */
  append(sequence: number, durationSeconds: number, data: Uint8Array): void {
    this.held.push({ segment: { sequence, durationSeconds }, data });
    while (this.held.length > this.capacity) this.held.shift();
  }

  /** Oldest first, which is the order a playlist lists them in. */
  get segments(): HlsSegment[] {
    return this.held.map((entry) => entry.segment);
  }

  /** The bytes of one segment, or undefined once it has left the window. */
  data(sequence: number): Uint8Array | undefined {
    return this.held.find((entry) => entry.segment.sequence === sequence)?.data;
  }

  get heldBytes(): number {
    return this.held.reduce((total, entry) => total + entry.data.byteLength, 0);
  }
}
