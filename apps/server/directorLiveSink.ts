import { buildMediaPlaylist, HlsSegmentWindow } from "../../src/core/hlsPlaylist";
import type { DirectorSegmentSink } from "./directorSegmentSink";

/**
 * The live end of the segmenter: a bounded window of recent segments, and the
 * playlist that points at them.
 *
 * Everything here is in memory and deliberately forgettable. Durability is the
 * archive sink's job; this one exists so a viewer arriving now can start
 * watching now, and it holds only as much of the recent past as that needs.
 * Losing it costs the live view of a session, never the record of one.
 */
export class DirectorLiveSink implements DirectorSegmentSink {
  private readonly window: HlsSegmentWindow;
  private initialization: Buffer | null = null;
  private codec: string | null = null;
  private ended = false;

  /**
   * `windowSize` is how far behind live a viewer may fall and still recover.
   * Six segments is a few seconds of slack for a slow phone without turning the
   * container into a video cache.
   */
  constructor(windowSize = 6) {
    this.window = new HlsSegmentWindow(windowSize);
  }

  init(segment: Buffer, codec: string): void {
    this.initialization = segment;
    this.codec = codec;
  }

  segment(
    index: number,
    bytes: Buffer,
    _startSeconds: number,
    durationSeconds: number,
  ): void {
    this.window.append(index, durationSeconds, bytes);
  }

  finish(): void {
    this.ended = true;
  }

  /** The codec actually negotiated, as the muxer reported it. */
  get negotiatedCodec(): string | null {
    return this.codec;
  }

  /** The fMP4 initialization segment, or null before the muxer produced one. */
  get initializationSegment(): Buffer | null {
    return this.initialization;
  }

  /**
   * True once a player has everything it needs to start: the initialization
   * segment and at least one media segment. Before that the playlist is valid
   * but empty, which is a state a player handles by polling.
   */
  get ready(): boolean {
    return this.initialization !== null && this.window.segments.length > 0;
  }

  get heldBytes(): number {
    return this.window.heldBytes;
  }

  segmentBytes(sequence: number): Uint8Array | undefined {
    return this.window.data(sequence);
  }

  playlist(initUri: string, segmentUri: (sequence: number) => string): string {
    return buildMediaPlaylist({
      segments: this.window.segments,
      initUri,
      segmentUri,
      ended: this.ended,
    });
  }
}
