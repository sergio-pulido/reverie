import {
  MAX_RECORDING_BYTES,
  type DirectorRecordingStore,
} from "./directorRecordings";
import type { DirectorIndexStore } from "./directorIndex";

/**
 * The durable half of a director stream.
 *
 * One of the segmenter's two sinks: the other delivers the same segments live.
 * Each segment is uploaded as it is produced and its row written only after
 * that upload succeeds, so what survives a crash is a shorter archive rather
 * than a corrupt one — and a playlist built from those rows can never point at
 * an object that is not there.
 *
 * Nothing is written at the end that reproduction depends on. The segmenter
 * delivers `finish()` fire-and-forget and does not await it, so a session that
 * dies mid-stream still reproduces up to its last durable segment; `complete`
 * stays false and is reported that way.
 */

/**
 * The container the pieces are in. It follows the codec fal negotiated: VP8
 * goes into WebM, H.264 into fMP4, and the stored keys and content types say
 * which so a reader never has to guess.
 */
export type ArchiveContainer = "webm" | "mp4";

const CONTAINERS: Record<ArchiveContainer, { init: string; piece: string; contentType: string }> = {
  webm: { init: "init.webm", piece: "webm", contentType: "video/webm" },
  mp4: { init: "init.mp4", piece: "m4s", contentType: "video/mp4" },
};

/** The key a piece is stored under, given its container. */
export function pieceObjectName(container: ArchiveContainer, index: number): string {
  return `${index}.${CONTAINERS[container].piece}`;
}

export function initObjectName(container: ArchiveContainer): string {
  return CONTAINERS[container].init;
}

export function containerContentType(container: ArchiveContainer): string {
  return CONTAINERS[container].contentType;
}

export interface DirectorArchiveOptions {
  jamId: string;
  sessionId: string;
  recordings: DirectorRecordingStore;
  index: DirectorIndexStore;
  container: ArchiveContainer;
}

export class DirectorArchiveSink {
  /** Uploads run one at a time, in order, on this chain. */
  private queue: Promise<void> = Promise.resolve();
  private storedBytes = 0;
  private truncated: string | null = null;
  private failedSegments = 0;

  constructor(private readonly options: DirectorArchiveOptions) {}

  /** The codec fal actually negotiated, recorded before any segment lands. */
  init(segment: Buffer, codec: string): void {
    this.enqueue(async () => {
      const { container } = this.options;
      await this.options.index.describeStream(this.options.sessionId, codec, container);
      await this.options.recordings.putObject(
        this.objectPath(initObjectName(container)),
        segment,
        containerContentType(container),
      );
    });
  }

  segment(
    index: number,
    bytes: Buffer,
    startSeconds: number,
    durationSeconds: number,
  ): void {
    this.enqueue(async () => {
      if (this.truncated) return;
      if (this.storedBytes + bytes.byteLength > MAX_RECORDING_BYTES) {
        // Stopping is recorded rather than silent: an archive that quietly
        // ends early is indistinguishable from a session that ended early.
        this.truncated = "size_cap";
        return;
      }
      const { container } = this.options;
      const path = this.objectPath(pieceObjectName(container, index));
      await this.options.recordings.putObject(path, bytes, containerContentType(container));
      // Only after the bytes are durable. The row is what a reader trusts.
      await this.options.index.recordSegment(this.options.sessionId, {
        segmentIndex: index,
        startSeconds,
        durationSeconds,
        byteSize: bytes.byteLength,
        objectPath: path,
      });
      this.storedBytes += bytes.byteLength;
    });
  }

  finish(): void {
    this.enqueue(async () => {
      await this.options.index.closeSession(this.options.sessionId, this.truncated);
    });
  }

  /**
   * Resolves when every queued upload has settled.
   *
   * The segmenter does not await the sinks, so nothing upstream waits for this.
   * It exists so a caller that CAN wait — a route settling a session — is able
   * to, rather than leaving uploads racing a process exit.
   */
  async drained(): Promise<void> {
    await this.queue;
  }

  /** Segments that failed to upload, and are therefore absent from the index. */
  get lostSegments(): number {
    return this.failedSegments;
  }

  private objectPath(name: string): string {
    return `${this.options.jamId}/${this.options.sessionId}/${name}`;
  }

  /**
   * Serializes work onto the chain.
   *
   * The segmenter calls the sink fire-and-forget, so without this a slow
   * upload would overlap the next segment and the uploads would race. Each
   * task absorbs its own failure: one segment lost must not break the chain
   * and take the rest of the archive with it.
   */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {
      this.failedSegments += 1;
    });
  }
}
