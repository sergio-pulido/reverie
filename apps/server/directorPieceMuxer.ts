import {
  DepacketizeCallback,
  JitterBufferCallback,
  RtpSourceCallback,
  RtpTimeCallback,
  WebmCallback,
  type DepacketizerCodec,
  type WebmOutput,
  type WebmTrack,
} from "werift/nonstandard";

/**
 * RTP in, WebM pieces out.
 *
 * A director session is stored as it streams, in pieces of a handleable length
 * rather than as one file at the end. Two things follow from that: a process
 * that dies mid-stream loses the piece in flight and nothing before it, and
 * going to a given minute of the film is a matter of fetching the piece that
 * contains it rather than downloading everything up to it.
 *
 * Each piece is playable on its own. WebM is an initial header followed by
 * clusters, and a cluster always begins on a video keyframe, so `init + any
 * run of clusters` is a valid stream that a plain <video> element decodes
 * from its first frame. The init header is emitted once and stored once; a
 * reader prepends it when serving a piece.
 *
 * This runs in a worker thread and knows nothing about peers, sockets or HTTP.
 * Depacketizing and muxing a real 480p session on the serving thread drove
 * Node to 99% CPU and stalled the route that ends the paid session
 * (docs/DECISIONS.md); nothing here may ever run there.
 */

export interface PieceTrack {
  kind: "audio" | "video";
  /** The negotiated codec name, lowercased: `vp8`, `h264`, `opus`. */
  codec: string;
}

export interface PieceMuxerHandlers {
  /** The WebM initial header, once, with the video codec actually negotiated. */
  onInit(bytes: Buffer, codec: string): void;
  onPiece(index: number, bytes: Buffer, startSeconds: number, durationSeconds: number): void;
  onRefused(reason: PieceMuxerRefusal): void;
}

export type PieceMuxerRefusal = "unsupported_codec";

export interface PieceMuxerOptions {
  /**
   * Seconds of film per piece. A piece closes at the first video keyframe past
   * this, never mid-GOP, so the real length is the provider's keyframe cadence
   * rounded up. Shorter pieces mean finer seeking and more objects.
   */
  targetPieceSeconds?: number;
}

/** What WebM calls each codec, and what the depacketizer calls it. */
const WEBM_CODEC: Record<string, WebmTrack["codec"]> = {
  vp8: "VP8",
  vp9: "VP9",
  h264: "MPEG4/ISO/AVC",
  opus: "OPUS",
};
const DEPACKETIZER_CODEC: Record<string, DepacketizerCodec> = {
  vp8: "VP8",
  vp9: "VP9",
  h264: "MPEG4/ISO/AVC",
  opus: "OPUS",
};

const DEFAULT_TARGET_PIECE_SECONDS = 10;
/** How long a stop waits for the muxer to report the film's final length. */
const EOL_GRACE_MS = 1_500;
/** Far past any session the ledger allows; the real length is patched by eol. */
const NOMINAL_DURATION_MS = 1000 * 60 * 60 * 24;

export class PieceMuxer {
  private readonly targetPieceSeconds: number;
  private readonly sources: RtpSourceCallback[] = [];
  private webm: WebmCallback | null = null;
  private refusal: PieceMuxerRefusal | null = null;
  private videoCodec = "unknown";
  private stopped = false;

  /** Bytes of the piece being assembled: cluster headers and their blocks. */
  private pending: Buffer[] = [];
  /** Where the open piece starts on the muxer's clock, in ms. */
  private pieceStartMs: number | null = null;
  /** Where the open cluster starts, so a closing cluster's length is known. */
  private clusterStartMs = 0;
  /** The muxer's clock: ms elapsed at the most recent cluster boundary. */
  private elapsedMs = 0;
  private nextIndex = 0;
  /** Resolves the stop that is waiting for the muxer's final word. */
  private onEol: (() => void) | null = null;
  /** Whether any output was ever produced; a muxer that never was cannot end. */
  private produced = false;

  constructor(
    tracks: readonly PieceTrack[],
    private readonly handlers: PieceMuxerHandlers,
    options: PieceMuxerOptions = {},
  ) {
    this.targetPieceSeconds = options.targetPieceSeconds ?? DEFAULT_TARGET_PIECE_SECONDS;
    this.open(tracks);
  }

  get refusedBecause(): PieceMuxerRefusal | null {
    return this.refusal;
  }

  private open(tracks: readonly PieceTrack[]): void {
    const specs: { spec: WebmTrack; codec: DepacketizerCodec }[] = [];
    for (const [index, track] of tracks.entries()) {
      const name = track.codec.toLowerCase();
      const video = track.kind === "video";
      if (video) this.videoCodec = name;
      const webmCodec = WEBM_CODEC[name];
      const depacketizer = DEPACKETIZER_CODEC[name];
      // Refused in the open rather than muxed into a container that cannot
      // hold it. WebM takes VP8, VP9, H.264 and Opus — the negotiated codec
      // is reported either way, and the archive is never silently empty.
      if (!webmCodec || !depacketizer || (!video && name !== "opus")) {
        this.refusal = "unsupported_codec";
        this.handlers.onRefused("unsupported_codec");
        return;
      }
      specs.push({
        codec: depacketizer,
        spec: {
          kind: video ? "video" : "audio",
          codec: webmCodec,
          clockRate: video ? 90_000 : 48_000,
          trackNumber: index + 1,
        },
      });
    }

    const webm = new WebmCallback(
      specs.map((entry) => entry.spec),
      { duration: NOMINAL_DURATION_MS },
    );
    this.webm = webm;
    webm.pipe(async (output) => this.onMuxed(output));
    for (const { spec, codec } of specs) this.sources.push(this.pipeline(spec, codec));
  }

  /**
   * One track's pipeline, returning the end a caller writes RTP into.
   *
   * werift's own recorder chain minus the NTP clock: RTCP never crosses the
   * worker boundary, so there are no sender reports to derive wall-clock from.
   * Both tracks come from one generated source on one clock, so what is lost
   * is absolute alignment nothing here uses, not sync between them.
   */
  private pipeline(spec: WebmTrack, codec: DepacketizerCodec): RtpSourceCallback {
    const webm = this.webm;
    const rtp = new RtpSourceCallback();
    const time = new RtpTimeCallback(spec.clockRate);
    if (!webm) return rtp;

    if (spec.kind === "video") {
      const depacketizer = new DepacketizeCallback(codec, {
        isFinalPacketInSequence: (header) => header.marker,
      });
      const jitter = new JitterBufferCallback(spec.clockRate);
      rtp.pipe(jitter.input);
      jitter.pipe(time.input);
      time.pipe(depacketizer.input);
      depacketizer.pipe(webm.inputVideo);
    } else {
      const depacketizer = new DepacketizeCallback(codec);
      rtp.pipe(time.input);
      time.pipe(depacketizer.input);
      depacketizer.pipe(webm.inputAudio);
    }
    return rtp;
  }

  /** Feeds one serialized RTP packet to the track that produced it. */
  write(trackIndex: number, packet: Buffer): void {
    if (this.stopped || this.refusal) return;
    this.sources[trackIndex]?.input(packet);
  }

  /**
   * Collects muxer output into pieces.
   *
   * werift opens a new cluster on every video keyframe and reports, on that
   * boundary, how long the cluster it just closed ran. A piece is a run of
   * whole clusters, so it always begins on a keyframe and its length is known
   * exactly at the moment it closes.
   */
  private onMuxed(output: WebmOutput): void {
    this.produced = true;
    if (output.eol) {
      // The muxer's final word on how long the film ran; it settles the last
      // piece, whose closing cluster never saw a boundary after it.
      this.elapsedMs = output.eol.duration;
      this.closePiece();
      this.onEol?.();
      this.onEol = null;
      return;
    }
    if (output.kind === "initial" && output.saveToFile) {
      this.handlers.onInit(Buffer.from(output.saveToFile), this.videoCodec);
      return;
    }
    if (output.kind === "cuePoints") return;
    if (!output.saveToFile) return;

    if (output.kind === "cluster") {
      // The previous cluster is now complete and its length is known.
      this.elapsedMs = this.clusterStartMs + (output.previousDuration ?? 0);
      this.clusterStartMs = this.elapsedMs;
      if (this.pieceStartMs !== null && this.openPieceSeconds >= this.targetPieceSeconds) {
        this.closePiece();
      }
      if (this.pieceStartMs === null) this.pieceStartMs = this.clusterStartMs;
    }
    this.pending.push(Buffer.from(output.saveToFile));
  }

  private get openPieceSeconds(): number {
    if (this.pieceStartMs === null) return 0;
    return (this.elapsedMs - this.pieceStartMs) / 1000;
  }

  private closePiece(): void {
    if (this.pending.length === 0 || this.pieceStartMs === null) return;
    const startSeconds = this.pieceStartMs / 1000;
    const seconds = this.openPieceSeconds;
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.pieceStartMs = null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    // A zero-length piece would advertise a duration no player can use; the
    // target is the honest floor when the muxer reported no timing.
    this.handlers.onPiece(index, bytes, startSeconds, seconds > 0 ? seconds : this.targetPieceSeconds);
  }

  /**
   * Stops the pipeline and waits, briefly, for the last piece.
   *
   * Stopping the sources sends an end-of-stream down each chain, and the muxer
   * answers with `eol` carrying the film's true length — but it answers through
   * a queue, asynchronously, so the last piece is only correct once that has
   * arrived. A muxer that never saw a frame never answers (it throws instead),
   * so the wait is bounded: the tail of the film is worth a moment, the route
   * that settles the paid session is worth more.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // A muxer that was refused, or never saw a frame, has no end-of-stream to
    // send; waiting for one would only delay the route that settles the spend.
    const ended = this.produced && !this.refusal
      ? new Promise<void>((resolve) => {
          this.onEol = resolve;
          const timer = setTimeout(resolve, EOL_GRACE_MS);
          timer.unref?.();
        })
      : Promise.resolve();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Closing a source that never received a packet is not a failure worth
        // propagating while the session is already ending.
      }
    }
    await ended;
    this.onEol = null;
    this.webm?.destroy();
    // Whatever is still pending is the tail of the film, and worth keeping.
    this.closePiece();
  }
}
