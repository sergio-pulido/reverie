import {
  DepacketizeCallback,
  JitterBufferCallback,
  MP4Callback,
  RtpSourceCallback,
  RtpTimeCallback,
  type DepacketizerCodec,
  type Mp4Output,
  type Track as Mp4Track,
} from "werift/nonstandard";

/**
 * RTP in, fMP4 segments out.
 *
 * This is the expensive half of live delivery and it exists as its own object
 * for one reason: it must not run on the thread that serves HTTP. Depacketizing
 * and muxing a real 480p session on the main thread drove Node to 99% CPU and
 * stalled the event loop — /api/health stopped answering, and so did the route
 * that ends the paid session (docs/DECISIONS.md). A server that cannot answer
 * is a server that cannot stop spending, so the muxer runs in a worker and this
 * class knows nothing about peers, tracks, sockets or HTTP. It takes serialized
 * RTP and hands back bytes.
 */

/** A track as the muxer needs to declare it, before any packet arrives. */
export interface MuxTrack {
  kind: "audio" | "video";
  /** The negotiated codec name, lowercased: `h264` or `opus`. */
  codec: string;
  /**
   * Frame size for a video track. Required, and not merely for metadata.
   *
   * werift derives the fMP4 display aspect ratio with a Euclidean `gcd` loop
   * (`while (y !== 0)`) over these two numbers, on the first keyframe. Its own
   * type marks them optional, but `undefined % undefined` is `NaN`, `NaN !== 0`
   * is forever true, and the loop never terminates — so a video track declared
   * without a size does not lose metadata, it hangs the muxer thread on the
   * first keyframe and takes live delivery and the durable archive with it.
   * That is exactly the failure this field exists to make impossible.
   */
  width?: number;
  height?: number;
}

/**
 * A dimension werift's ratio loop can actually terminate on.
 *
 * The type above asks every caller for a real size, so reaching the fallback is
 * a programming error rather than a provider quirk. It degrades the track
 * header's declared size instead of wedging the thread, because a film with
 * imperfect metadata is worth incomparably more than a muxer that never returns.
 */
export function usableDimension(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.round(value)
    : 1;
}

export interface SegmentMuxerHandlers {
  onInit(bytes: Buffer, codec: string): void;
  onSegment(
    index: number,
    bytes: Buffer,
    startSeconds: number,
    durationSeconds: number,
  ): void;
  /** Called once if the negotiated codecs cannot be carried by fMP4. */
  onRefused(reason: MuxerRefusal): void;
}

export type MuxerRefusal = "unsupported_codec";

const MICROSECONDS_PER_SECOND = 1_000_000;
const MP4_VIDEO_CODEC = "avc1";
const MP4_AUDIO_CODEC = "opus";

/** What the depacketizer calls the codecs the muxer can take. */
const DEPACKETIZER_CODEC: Record<string, DepacketizerCodec> = {
  h264: "MPEG4/ISO/AVC",
  opus: "OPUS",
};

export interface SegmentMuxerOptions {
  /**
   * Seconds of media per segment. A segment closes at the first video keyframe
   * past this, never mid-GOP, so the real duration is the provider's keyframe
   * cadence rounded up — shorter segments mean lower latency, more requests.
   */
  targetSegmentSeconds?: number;
}

export class SegmentMuxer {
  private readonly targetSegmentSeconds: number;
  private readonly sources: (RtpSourceCallback | null)[] = [];
  private mp4: MP4Callback | null = null;
  private refusal: MuxerRefusal | null = null;
  private videoCodec = "unknown";
  private stopped = false;

  private pending: Uint8Array[] = [];
  private pendingStartMicros: number | null = null;
  private pendingEndMicros = 0;
  private nextIndex = 0;

  constructor(
    tracks: readonly MuxTrack[],
    private readonly handlers: SegmentMuxerHandlers,
    options: SegmentMuxerOptions = {},
  ) {
    this.targetSegmentSeconds = options.targetSegmentSeconds ?? 2;
    this.open(tracks);
  }

  get refusedBecause(): MuxerRefusal | null {
    return this.refusal;
  }

  private open(tracks: readonly MuxTrack[]): void {
    const specs: { spec: Mp4Track; codec: DepacketizerCodec }[] = [];
    for (const [index, track] of tracks.entries()) {
      const name = track.codec.toLowerCase();
      const video = track.kind === "video";
      if (video) this.videoCodec = name;
      const depacketizer = DEPACKETIZER_CODEC[name];
      // H.264 and Opus are the whole of what fMP4 takes. A VP8 stream is not
      // muxed into a container that cannot hold it and then served as though it
      // played: delivery refuses in the open, and recording is unaffected.
      if (!depacketizer || (video ? name !== "h264" : name !== "opus")) {
        this.refusal = "unsupported_codec";
        this.handlers.onRefused("unsupported_codec");
        return;
      }
      specs.push({
        codec: depacketizer,
        spec: {
          kind: video ? "video" : "audio",
          codec: video ? MP4_VIDEO_CODEC : MP4_AUDIO_CODEC,
          clockRate: video ? 90_000 : 48_000,
          trackNumber: index + 1,
          // Only the video track's size is read; audio carries none.
          ...(video
            ? {
                width: usableDimension(track.width),
                height: usableDimension(track.height),
              }
            : {}),
        },
      });
    }

    const mp4 = new MP4Callback(specs.map((entry) => entry.spec));
    this.mp4 = mp4;
    mp4.pipe(async (output) => this.onMuxed(output));
    for (const { spec, codec } of specs) this.sources.push(this.pipeline(spec, codec));
  }

  /**
   * Builds one track's pipeline and returns the end a caller writes RTP into.
   *
   * The chain is werift's own recorder pipeline minus the NTP clock: a jitter
   * buffer to put packets back in order, then the RTP timestamp clock, then a
   * depacketizer to rebuild frames. RTCP never crosses the worker boundary, so
   * there are no sender reports to derive wall-clock time from — both tracks
   * come from one generated source on one clock, so what is lost is absolute
   * NTP alignment, which nothing here uses, rather than sync between them.
   */
  private pipeline(spec: Mp4Track, codec: DepacketizerCodec): RtpSourceCallback {
    const mp4 = this.mp4;
    const rtp = new RtpSourceCallback();
    const time = new RtpTimeCallback(spec.clockRate);
    if (!mp4) return rtp;

    if (spec.kind === "video") {
      const depacketizer = new DepacketizeCallback(codec, {
        isFinalPacketInSequence: (header) => header.marker,
      });
      const jitter = new JitterBufferCallback(spec.clockRate);
      rtp.pipe(jitter.input);
      jitter.pipe(time.input);
      time.pipe(depacketizer.input);
      depacketizer.pipe(mp4.inputVideo);
    } else {
      const depacketizer = new DepacketizeCallback(codec);
      rtp.pipe(time.input);
      time.pipe(depacketizer.input);
      depacketizer.pipe(mp4.inputAudio);
    }
    return rtp;
  }

  /** Feeds one serialized RTP packet to the track that produced it. */
  write(trackIndex: number, packet: Buffer): void {
    if (this.stopped || this.refusal) return;
    this.sources[trackIndex]?.input(packet);
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
      this.handlers.onInit(Buffer.from(chunk.data), this.videoCodec);
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
    this.handlers.onSegment(
      index,
      bytes,
      startSeconds,
      seconds > 0 ? seconds : this.targetSegmentSeconds,
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) {
      try {
        source?.stop();
      } catch {
        // Closing a source that never received a packet is not a failure worth
        // propagating while the session is already ending.
      }
    }
    try {
      await this.mp4?.stop();
    } catch {
      // A muxer that never saw a frame throws on stop. The session is ending
      // regardless, and this must not mask why.
    }
    // Whatever was accumulated is still the tail of the film, and worth serving.
    this.closeSegment();
  }
}
