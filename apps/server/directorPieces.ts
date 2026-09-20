import { Worker } from "node:worker_threads";
import type { MediaStreamTrack } from "werift";
import { PieceMuxer, type PieceTrack } from "./directorPieceMuxer";
import type { PieceWorkerCommand, PieceWorkerEvent } from "./directorPieceWorker";
import type { DirectorSegmentSink } from "./directorSegmentSink";

/**
 * Stores a director stream as it runs, in pieces, off the serving thread.
 *
 * This is the main-thread half. Its entire per-packet cost is `serialize()`
 * and a `postMessage`; the muxing happens in a worker, and finished pieces
 * come back here to be fanned out to the sinks. The session, the audit trail
 * and the route that ends the session never wait on any of it.
 *
 * Capture on the serving thread was measured taking the whole server down —
 * 99% CPU, event loop stalled, `/end` unreachable. This exists so that the
 * stop path survives the media path, and it is the only capture the server
 * runs.
 */

export type PieceRecorderRefusal = "unsupported_codec" | "worker_failed";

export interface DirectorPieceRecorderOptions {
  sinks?: DirectorSegmentSink[];
  /** Seconds of film per piece; the muxer rounds up to the next keyframe. */
  targetPieceSeconds?: number;
  /**
   * How long to wait for a second track before opening the muxer. Audio and
   * video surface as separate track events and WebM declares its tracks up
   * front; without a grace period a stream would mux video and silently drop
   * the audio that arrived a few milliseconds behind it.
   */
  trackGraceMs?: number;
  /**
   * Runs the muxer on this thread instead of a worker. For tests only — it is
   * exactly the arrangement that stalls a real session, and nothing that
   * serves HTTP should ever set it.
   */
  inline?: boolean;
}

/** How long a closing session waits for the muxer's last piece. */
const SHUTDOWN_GRACE_MS = 2_000;

export class DirectorPieceRecorder {
  private readonly sinks: DirectorSegmentSink[];
  private readonly targetPieceSeconds: number;
  private readonly trackGraceMs: number;
  private readonly inline: boolean;

  private readonly tracks: MediaStreamTrack[] = [];
  private readonly unsubscribers: (() => void)[] = [];
  private startTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;

  private worker: Worker | null = null;
  private inlineMuxer: PieceMuxer | null = null;
  private refusal: PieceRecorderRefusal | null = null;
  private negotiated: string | null = null;
  private published = 0;
  private closed: Promise<void> | null = null;

  constructor(options: DirectorPieceRecorderOptions = {}) {
    this.sinks = options.sinks ?? [];
    this.targetPieceSeconds = options.targetPieceSeconds ?? 10;
    this.trackGraceMs = options.trackGraceMs ?? 500;
    this.inline = options.inline ?? false;
  }

  /** The video codec fal actually answered, once a track has arrived. */
  get negotiatedCodec(): string | null {
    return this.negotiated;
  }

  /** Why nothing is being stored, when nothing is. Never guessed. */
  get refusedBecause(): PieceRecorderRefusal | null {
    return this.refusal;
  }

  /** Pieces handed to the sinks so far. */
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

    const specs: PieceTrack[] = this.tracks.map((track) => {
      const codec = track.codec?.name?.toLowerCase() ?? "unknown";
      if (track.kind === "video") this.negotiated = codec;
      return { kind: track.kind === "video" ? "video" : "audio", codec };
    });

    if (this.inline) {
      this.inlineMuxer = new PieceMuxer(
        specs,
        {
          onInit: (bytes, codec) => this.onInit(bytes, codec),
          onPiece: (index, bytes, start, duration) =>
            this.onPiece(index, bytes, start, duration),
          onRefused: () => {
            this.refusal = "unsupported_codec";
          },
        },
        { targetPieceSeconds: this.targetPieceSeconds },
      );
    } else {
      this.worker = this.spawnWorker();
      this.send({ type: "open", tracks: specs, targetPieceSeconds: this.targetPieceSeconds });
    }

    for (const [index, track] of this.tracks.entries()) {
      // The only work this thread does per packet: serialize and hand over.
      const subscription = track.onReceiveRtp.subscribe((packet) => {
        const bytes = packet.serialize();
        if (this.inlineMuxer) {
          this.inlineMuxer.write(index, bytes);
          return;
        }
        this.send({ type: "rtp", track: index, packet: bytes });
      });
      this.unsubscribers.push(() => subscription.unSubscribe());
    }
  }

  private spawnWorker(): Worker {
    const worker = new Worker(new URL("./directorPieceWorker.ts", import.meta.url), {
      // The server runs under tsx in development and in the container alike,
      // so the worker has to load it too; naming it explicitly works either way.
      execArgv: ["--import", "tsx"],
    });
    worker.on("message", (event: PieceWorkerEvent) => this.onWorkerEvent(event));
    worker.on("error", () => {
      // The muxer thread died. Storage stops; the session, the audit trail and
      // the route that ends the session are all untouched — that containment is
      // the reason for the thread. Reported as its own reason, so a dead
      // worker is never mistaken for a codec verdict.
      this.refusal = this.refusal ?? "worker_failed";
    });
    // A muxer thread must never hold the process open by itself.
    worker.unref();
    return worker;
  }

  private send(command: PieceWorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private onWorkerEvent(event: PieceWorkerEvent): void {
    switch (event.type) {
      case "init":
        this.onInit(Buffer.from(event.bytes), event.codec);
        return;
      case "piece":
        this.onPiece(
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

  private onPiece(index: number, bytes: Buffer, start: number, duration: number): void {
    this.published = Math.max(this.published, index + 1);
    this.toSinks((sink) => sink.segment(index, bytes, start, duration));
  }

  /**
   * Hands one result to every sink.
   *
   * A sink that fails — a storage upload that times out — must not take the
   * stream down with it, nor stop the other sinks receiving the same bytes.
   */
  private toSinks(deliver: (sink: DirectorSegmentSink) => Promise<void> | void): void {
    for (const sink of this.sinks) {
      try {
        void Promise.resolve(deliver(sink)).catch(() => undefined);
      } catch {
        // A sink that throws synchronously loses this piece, not the stream.
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
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.closed = this.shutdown();
    await this.closed;
  }

  /**
   * Waits for the muxer's last piece, but never indefinitely.
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
      worker.on("message", (event: PieceWorkerEvent) => {
        if (event.type === "stopped") {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.postMessage({ type: "stop" } satisfies PieceWorkerCommand);
    });
    await worker.terminate().catch(() => undefined);
    this.toSinks((sink) => sink.finish());
  }
}
