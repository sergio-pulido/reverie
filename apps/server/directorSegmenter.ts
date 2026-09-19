import type { MediaStreamTrack } from "werift";
import {
  DepacketizeCallback,
  JitterBufferCallback,
  MP4Callback,
  NtpTimeCallback,
  RtcpSourceCallback,
  RtpSourceCallback,
  type DepacketizerCodec,
  type Mp4Output,
  type Track as Mp4Track,
} from "werift/nonstandard";

/**
 * Turns the one inbound director track into fMP4 segments.
 *
 * This is the delivery half of "one stream, many viewers". The container keeps
 * its single connection to fal; everyone watching reads segments over ordinary
 * HTTP, so fan-out costs nothing and no viewer holds server state. A second
 * peer connection per viewer would have put a long-lived socket back in front
 * of every participant, which is the thing multiplexing removes.
 *
 * There is exactly one segmenter per session, and it fans its output out to
 * sinks. Live delivery and the durable archive therefore publish the *same*
 * bytes under the *same* numbering — the audit trail refers to segments by
 * index, and two muxers would have produced two timelines for it to drift
 * between.
 *
 * It never opens a session and never talks to a provider; it is handed a track
 * that already exists.
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

const MICROSECONDS_PER_SECOND = 1_000_000;

/** fMP4 carries these and only these (`mp4SupportedCodecs` in werift). */
const MP4_VIDEO_CODEC = "avc1";
const MP4_AUDIO_CODEC = "opus";

/** What the depacketizer calls the codecs the muxer can take. */
const DEPACKETIZER_CODEC: Record<string, DepacketizerCodec> = {
  h264: "MPEG4/ISO/AVC",
  opus: "OPUS",
};

export interface DirectorSegmenterOptions {
  sinks?: DirectorSegmentSink[];
  /**
   * Seconds of media per segment. A segment closes at the first keyframe past
   * this, never mid-GOP, so the real duration is the provider's keyframe
   * cadence rounded up — shorter segments mean lower latency, more requests.
   */
  targetSegmentSeconds?: number;
  /**
   * How long to wait for a second track before muxing what has arrived. Audio
   * and video surface as separate `onTrack` events and fMP4 declares its tracks
   * up front; without a grace period a stream would mux video and silently drop
   * the audio that was a few milliseconds behind it.
   */
  trackGraceMs?: number;
}

/** Why a stream has no segments, when it has none. */
export type SegmenterRefusal = "unsupported_codec";

export class DirectorSegmenter implements DirectorTrackConsumer {
  private readonly sinks: DirectorSegmentSink[];
  private readonly targetSegmentSeconds: number;
  private readonly trackGraceMs: number;

  private readonly pendingTracks: MediaStreamTrack[] = [];
  private startTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;

  private mp4: MP4Callback | null = null;
  private readonly sources: RtpSourceCallback[] = [];
  private refusal: SegmenterRefusal | null = null;
  private negotiated: string | null = null;

  /** Fragments accumulated into the segment currently being built. */
  private pending: Uint8Array[] = [];
  private pendingStartMicros: number | null = null;
  private pendingEndMicros = 0;
  private nextIndex = 0;

  constructor(options: DirectorSegmenterOptions = {}) {
    this.sinks = options.sinks ?? [];
    this.targetSegmentSeconds = options.targetSegmentSeconds ?? 2;
    this.trackGraceMs = options.trackGraceMs ?? 500;
  }

  /** The video codec fal actually answered, once a track has arrived. */
  get negotiatedCodec(): string | null {
    return this.negotiated;
  }

  /** Set when the negotiated codec cannot go into fMP4. Never guessed. */
  get refusedBecause(): SegmenterRefusal | null {
    return this.refusal;
  }

  /** How many segments have been published. */
  get publishedCount(): number {
    return this.nextIndex;
  }

  /**
   * Takes a track without muxing it yet.
   *
   * fMP4 declares its tracks in the initialization segment, so the muxer has to
   * be built knowing all of them. Video and audio arrive as separate events, so
   * the first one starts a short clock and whatever else lands inside it joins
   * the same file.
   */
  addTrack(track: MediaStreamTrack): void {
    if (this.started || this.stopped) return;
    this.pendingTracks.push(track);
    if (this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.start();
    }, this.trackGraceMs);
    // A pending timer must never be the reason the process stays alive; the
    // session's own lifetime decides that.
    this.startTimer.unref?.();
  }

  /** Builds the muxer for the tracks gathered so far. Idempotent. */
  start(): void {
    if (this.started || this.stopped || this.pendingTracks.length === 0) return;
    this.started = true;

    const specs: { track: MediaStreamTrack; spec: Mp4Track; codec: DepacketizerCodec }[] = [];
    for (const [index, track] of this.pendingTracks.entries()) {
      const name = track.codec?.name?.toLowerCase() ?? "";
      const video = track.kind === "video";
      if (video) this.negotiated = name;
      const depacketizer = DEPACKETIZER_CODEC[name];
      // H.264 and Opus are the whole of what fMP4 takes. A VP8 stream is not
      // muxed into a container that cannot hold it and then served as though it
      // played: delivery refuses in the open, and recording is unaffected.
      if (!depacketizer || (video ? name !== "h264" : name !== "opus")) {
        this.refusal = "unsupported_codec";
        return;
      }
      specs.push({
        track,
        codec: depacketizer,
        spec: {
          kind: video ? "video" : "audio",
          codec: video ? MP4_VIDEO_CODEC : MP4_AUDIO_CODEC,
          clockRate: video ? 90_000 : 48_000,
          trackNumber: index + 1,
        },
      });
    }

    const mp4 = new MP4Callback(specs.map((entry) => entry.spec));
    this.mp4 = mp4;
    mp4.pipe(async (output) => {
      this.onMuxed(output);
    });
    for (const { track, spec, codec } of specs) {
      this.pipeTrack(track, spec, codec);
    }
  }

  /**
   * RTP in, muxer frames out.
   *
   * The chain is werift's own recorder pipeline: a jitter buffer to put packets
   * back in order, NTP time so both tracks share one clock, a depacketizer to
   * rebuild frames. Video gets the jitter buffer and the marker-bit rule
   * because a video frame spans many packets and the muxer needs whole ones.
   */
  private pipeTrack(
    track: MediaStreamTrack,
    spec: Mp4Track,
    codec: DepacketizerCodec,
  ): void {
    const mp4 = this.mp4;
    if (!mp4) return;
    const rtp = new RtpSourceCallback();
    const rtcp = new RtcpSourceCallback();
    track.onReceiveRtp.subscribe((packet) => rtp.input(packet.clone()));
    track.onReceiveRtcp.subscribe((packet) => rtcp.input(packet));
    const time = new NtpTimeCallback(spec.clockRate);

    if (spec.kind === "video") {
      const depacketizer = new DepacketizeCallback(codec, {
        isFinalPacketInSequence: (header) => header.marker,
      });
      const jitter = new JitterBufferCallback(spec.clockRate);
      rtp.pipe(jitter.input);
      rtcp.pipe(time.input);
      jitter.pipe(time.input);
      time.pipe(depacketizer.input);
      depacketizer.pipe(mp4.inputVideo);
    } else {
      const depacketizer = new DepacketizeCallback(codec);
      rtp.pipe(time.input);
      rtcp.pipe(time.input);
      time.pipe(depacketizer.input);
      depacketizer.pipe(mp4.inputAudio);
    }
    this.sources.push(rtp);
  }

  /**
   * Collects muxer output into segments.
   *
   * A segment always begins on a video keyframe, because that is the only place
   * a player can start decoding. The target duration is a floor, not a promise:
   * the segment closes at the first keyframe past it, so the real length is
   * whatever cadence the provider's encoder chose.
   */
  private onMuxed(output: Mp4Output): void {
    if ("eol" in output && output.eol) {
      this.closeSegment();
      return;
    }
    const chunk = output as Exclude<Mp4Output, { eol: true }>;
    if (chunk.type === "init") {
      this.emitInit(Buffer.from(chunk.data));
      return;
    }
    const startsSegment = chunk.kind === "video" && chunk.type === "key";
    if (startsSegment && this.pendingSeconds >= this.targetSegmentSeconds) {
      this.closeSegment();
    }
    // Everything muxed goes into the segment in the order produced — audio
    // fragments included, or the film would arrive silent.
    this.pending.push(chunk.data);
    if (this.pendingStartMicros === null) this.pendingStartMicros = chunk.timestamp;
    this.pendingEndMicros = Math.max(
      this.pendingEndMicros,
      chunk.timestamp + chunk.duration,
    );
  }

  private get pendingSeconds(): number {
    if (this.pendingStartMicros === null) return 0;
    return (this.pendingEndMicros - this.pendingStartMicros) / MICROSECONDS_PER_SECOND;
  }

  /** Publishes the accumulated fragments as one segment, to every sink. */
  private closeSegment(): void {
    if (this.pending.length === 0) return;
    const startSeconds = (this.pendingStartMicros ?? 0) / MICROSECONDS_PER_SECOND;
    const seconds = this.pendingSeconds;
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingStartMicros = null;
    this.pendingEndMicros = 0;
    const index = this.nextIndex;
    this.nextIndex += 1;
    // A zero-length segment would advertise a duration no player can use; the
    // target is the honest floor when the muxer reported no timing.
    const duration = seconds > 0 ? seconds : this.targetSegmentSeconds;
    this.toSinks((sink) => sink.segment(index, bytes, startSeconds, duration));
  }

  private emitInit(bytes: Buffer): void {
    const codec = this.negotiated ?? "unknown";
    this.toSinks((sink) => sink.init(bytes, codec));
  }

  /**
   * Hands one segment to every sink.
   *
   * A sink that fails — a storage upload that times out — must not take the
   * live stream down with it, and must not stop the other sinks receiving the
   * same bytes. Delivery and durability fail independently by design.
   */
  private toSinks(deliver: (sink: DirectorSegmentSink) => Promise<void> | void): void {
    for (const sink of this.sinks) {
      try {
        void Promise.resolve(deliver(sink)).catch(() => undefined);
      } catch {
        // A sink that throws synchronously is the same failure, handled the
        // same way: it loses this segment, not the stream.
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    await Promise.all(
      this.sources.map(async (source) => {
        try {
          await source.stop();
        } catch {
          // Closing a source that never received a packet is not a failure
          // worth propagating while the session is already ending.
        }
      }),
    );
    try {
      await this.mp4?.stop();
    } catch {
      // A muxer that never saw a frame throws on stop. The session is ending
      // regardless, and this must not mask why.
    }
    // Whatever was accumulated is still the tail of the film, and worth
    // serving; the sinks are then told there will be no more.
    this.closeSegment();
    this.toSinks((sink) => sink.finish());
  }
}
