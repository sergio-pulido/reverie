import { Worker } from "node:worker_threads";
import type { MediaStreamTrack } from "werift";
import type { MuxTrack } from "./directorMuxer";
import { SegmentMuxer } from "./directorMuxer";
import type {
  SegmentWorkerCommand,
  SegmentWorkerEvent,
} from "./directorSegmentWorker";

/**
 * The main thread's end of live delivery.
 *
 * It takes the inbound track and does as little with it as possible: serialize
 * each RTP packet and hand it to the worker that muxes. That division is the
 * whole design. Muxing on this thread drove a real 480p session to 99% CPU and
 * stalled the event loop, which stopped `/api/health` *and* the route that ends
 * the paid session; a server that cannot answer is a server that cannot stop
 * spending (docs/DECISIONS.md).
 *
 * There is one segmenter per session and it fans finished segments out to
 * sinks, so live delivery and the durable archive publish the same bytes under
 * the same numbering — the audit trail refers to segments by index, and two
 * muxers would have given it two timelines to drift between.
 */

/**
 * A consumer of the inbound media track, attached by `DirectorStream`.
 *
 * The track arrives exactly once and more than one thing wants it, so nothing
 * subscribes to the peer's `onTrack` directly — otherwise the first subscriber
 * would take it from the others.
 */
export interface DirectorTrackConsumer {
  addTrack(track: MediaStreamTrack): Promise<void> | void;
  stop(): Promise<void>;
}

/** Where finished segments go: the live window, the durable archive, or both. */
export interface DirectorSegmentSink {
  /**
   * The fMP4 initialization segment, with the codec actually negotiated — not
   * the one we asked for. Everything downstream branches on the real answer.
   */
  init(segment: Buffer, codec: string): Promise<void> | void;
  segment(
    index: number,
    bytes: Buffer,
    startSeconds: number,
    durationSeconds: number,
  ): Promise<void> | void;
  finish(): Promise<void> | void;
}

/** Why a stream has no segments, when it has none. */
export type SegmenterRefusal = "unsupported_codec";

export interface DirectorSegmenterOptions {
  sinks?: DirectorSegmentSink[];
  targetSegmentSeconds?: number;
  /**
   * How long to wait for a second track before opening the muxer. Audio and
   * video surface as separate `onTrack` events and fMP4 declares its tracks up
   * front; without a grace period a stream would mux video and silently drop
   * the audio that was a few milliseconds behind it.
   */
  trackGraceMs?: number;
  /**
   * Runs the muxer on this thread instead of a worker. For tests only — it is
   * exactly the arrangement that stalls a real session, and nothing that serves
   * HTTP should ever set it.
   */
  inline?: boolean;
}

export class DirectorSegmenter implements DirectorTrackConsumer {
  private readonly sinks: DirectorSegmentSink[];
  private readonly targetSegmentSeconds: number;
  private readonly trackGraceMs: number;
  private readonly inline: boolean;

  private readonly tracks: MediaStreamTrack[] = [];
  private startTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;

  private worker: Worker | null = null;
  private inlineMuxer: SegmentMuxer | null = null;
  private refusal: SegmenterRefusal | null = null;
  private negotiated: string | null = null;
  private published = 0;
  private closed: Promise<void> | null = null;

  constructor(options: DirectorSegmenterOptions = {}) {
    this.sinks = options.sinks ?? [];
    this.targetSegmentSeconds = options.targetSegmentSeconds ?? 2;
    this.trackGraceMs = options.trackGraceMs ?? 500;
    this.inline = options.inline ?? false;
  }

  /** The video codec fal actually answered, once a track has arrived. */
  get negotiatedCodec(): string | null {
    return this.negotiated;
  }

  /** Set when the negotiated codec cannot go into fMP4. Never guessed. */
  get refusedBecause(): SegmenterRefusal | null {
    return this.refusal;
  }

  get publishedCount(): number {
    return this.published;
  }

  addTrack(track: MediaStreamTrack): void {
    if (this.started || this.stopped) return;
    this.tracks.push(track);
    if (this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.start();
    }, this.trackGraceMs);
    // A pending timer must never be the reason the process stays alive; the
    // session's own lifetime decides that.
    this.startTimer.unref?.();
  }

  /** Opens the muxer for the tracks gathered so far. Idempotent. */
  start(): void {
    if (this.started || this.stopped || this.tracks.length === 0) return;
    this.started = true;

    const specs: MuxTrack[] = this.tracks.map((track) => {
      const codec = track.codec?.name?.toLowerCase() ?? "unknown";
      if (track.kind === "video") this.negotiated = codec;
      return { kind: track.kind === "video" ? "video" : "audio", codec };
    });

    if (this.inline) {
      this.inlineMuxer = new SegmentMuxer(
        specs,
        {
          onInit: (bytes, codec) => this.onInit(bytes, codec),
          onSegment: (index, bytes, start, duration) =>
            this.onSegment(index, bytes, start, duration),
          onRefused: () => {
            this.refusal = "unsupported_codec";
          },
        },
        { targetSegmentSeconds: this.targetSegmentSeconds },
      );
    } else {
      this.worker = this.spawnWorker();
      this.send({
        type: "open",
        tracks: specs,
        targetSegmentSeconds: this.targetSegmentSeconds,
      });
    }

    for (const [index, track] of this.tracks.entries()) {
      // The only work this thread does per packet: serialize and hand over.
      track.onReceiveRtp.subscribe((packet) => {
        const bytes = packet.serialize();
        if (this.inlineMuxer) {
          this.inlineMuxer.write(index, bytes);
          return;
        }
        this.send({ type: "rtp", track: index, packet: bytes });
      });
    }
  }

  private spawnWorker(): Worker {
    const worker = new Worker(new URL("./directorSegmentWorker.ts", import.meta.url), {
      // The server runs under tsx in development and in the container alike, so
      // the worker has to load it too; naming it explicitly works either way.
      execArgv: ["--import", "tsx"],
    });
    worker.on("message", (event: SegmentWorkerEvent) => this.onWorkerEvent(event));
    worker.on("error", () => {
      // The muxer thread died. Live delivery stops; the session, the recording
      // and the route that ends the spend are all untouched, which is the point
      // of it being a separate thread in the first place.
      this.refusal = this.refusal ?? "unsupported_codec";
    });
    // A muxer thread must never hold the process open by itself.
    worker.unref();
    return worker;
  }

  private send(command: SegmentWorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private onWorkerEvent(event: SegmentWorkerEvent): void {
    switch (event.type) {
      case "init":
        this.onInit(Buffer.from(event.bytes), event.codec);
        return;
      case "segment":
        this.onSegment(
          event.index,
          Buffer.from(event.bytes),
          event.startSeconds,
          event.durationSeconds,
        );
        return;
      case "refused":
        this.refusal = "unsupported_codec";
        return;
      case "stopped":
        return;
    }
  }

  private onInit(bytes: Buffer, codec: string): void {
    this.negotiated = codec;
    this.toSinks((sink) => sink.init(bytes, codec));
  }

  private onSegment(
    index: number,
    bytes: Buffer,
    startSeconds: number,
    durationSeconds: number,
  ): void {
    this.published = Math.max(this.published, index + 1);
    this.toSinks((sink) => sink.segment(index, bytes, startSeconds, durationSeconds));
  }

  /**
   * Hands one segment to every sink.
   *
   * A sink that fails — a storage upload that times out — must not take the
   * live stream down with it, nor stop the other sinks receiving the same
   * bytes. Delivery and durability fail independently by design.
   */
  private toSinks(deliver: (sink: DirectorSegmentSink) => Promise<void> | void): void {
    for (const sink of this.sinks) {
      try {
        void Promise.resolve(deliver(sink)).catch(() => undefined);
      } catch {
        // A sink that throws synchronously loses this segment, not the stream.
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.closed ?? undefined;
    this.stopped = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.closed = this.shutdown();
    await this.closed;
  }

  /**
   * Waits for the muxer's last segments, but never indefinitely.
   *
   * The tail of the film is worth a moment; the route that settles the paid
   * session is worth more. If the worker does not answer, it is terminated and
   * the session closes anyway.
   */
  private async shutdown(): Promise<void> {
    if (this.inlineMuxer) {
      await this.inlineMuxer.stop().catch(() => undefined);
      this.toSinks((sink) => sink.finish());
      return;
    }
    const worker = this.worker;
    this.worker = null;
    if (!worker) {
      this.toSinks((sink) => sink.finish());
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      timer.unref?.();
      worker.on("message", (event: SegmentWorkerEvent) => {
        if (event.type === "stopped") {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.postMessage({ type: "stop" } satisfies SegmentWorkerCommand);
    });
    await worker.terminate().catch(() => undefined);
    this.toSinks((sink) => sink.finish());
  }
}

/** How long a closing session waits for the muxer's last segments. */
const SHUTDOWN_GRACE_MS = 2_000;
