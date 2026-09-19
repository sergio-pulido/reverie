import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type MediaStreamTrack,
} from "werift";
import {
  directorServerMessageSchema,
  initialDirectorState,
  nextPromptMessage,
  reduceDirectorState,
  type DirectorState,
} from "../../src/core/directorProtocol";
import { DirectorAuditLog, type DirectorAuditEntry } from "../../src/core/directorAudit";
import type { JamScript } from "../../src/core/script";
import {
  beatOffsets,
  beatWindow,
  isBeatLocked,
  type DirectorBeatWindow,
} from "../../src/core/directorBeats";
import {
  DirectorFileRecorder,
  type DirectorRecordingSink,
} from "./directorFileRecorder";
import type { DirectorTrackConsumer } from "./directorSegmenter";
import {
  buildConfigureMessage,
  DirectorError,
  startDirectorSession,
  type DirectorConfig,
} from "./providers/falDirector";

/**
 * A live director stream, with this server as the WebRTC peer.
 *
 * The browser is deliberately NOT the peer. Everything fal sends arrives here
 * and is recorded; everything fal is asked for originates here and is audited.
 * That is the whole point: a stream nobody can inspect afterwards is a stream
 * the room cannot be held to.
 *
 * The cost of that choice is stated plainly in docs/DECISIONS.md — this holds
 * a long-lived connection, so it cannot run in a serverless function and
 * belongs to the container deployment.
 */

/** The control channel's address, from the model's AsyncAPI `channels`. */
const CONTROL_CHANNEL = "fal";
const ICE_GATHERING_TIMEOUT_MS = 5_000;

/**
 * Re-exported so the recording store keeps one import site while the recorder
 * itself lives behind the track-consumer seam.
 */
export type { DirectorRecordingSink } from "./directorFileRecorder";

export interface DirectorStreamOptions {
  jamId: string;
  sessionId: string;
  config: DirectorConfig;
  script: JamScript;
  sink?: DirectorRecordingSink;
  /**
   * Everything that wants the inbound media track.
   *
   * The track arrives once and several things want it — durable recording and
   * live delivery — so they attach here instead of subscribing to `onTrack`,
   * where the first subscriber would take it from the rest. Defaults to the
   * WebM recorder alone, which is what the director shipped with.
   */
  consumers?: DirectorTrackConsumer[];
  /** Injected in tests; defaults to the real fal handshake. */
  startSession?: typeof startDirectorSession;
  /** Injected in tests; defaults to a real werift peer. */
  createPeer?: () => DirectorPeer;
  now?: () => Date;
}

export interface DirectionRequest {
  body: string;
  authorId?: string;
  proposalId?: string;
  /**
   * The outline beat this direction rewrites, when it rewrites one.
   *
   * Optional because not every direction targets a beat: a live aside from the
   * room is direction without being an edit. When it IS given, the beat window
   * applies and a direction landing on the beat being generated, or the one
   * after it, is refused — that block is what gives the room time to react to
   * a cascade instead of seeing it arrive on screen.
   */
  beatIndex?: number;
}

export type DirectionRefusal = "stream_not_ready" | "beat_locked";

/**
 * The slice of a peer connection this stream uses.
 *
 * werift sits behind this one seam so a route test can drive the session
 * without opening real UDP sockets — which, besides being slow, keep the Node
 * event loop alive and hang the test runner. The real implementation is the
 * default; nothing else in the server knows werift exists.
 */
export interface DirectorPeer {
  addTransceiver(kind: "video" | "audio", init: { direction: "recvonly" }): unknown;
  createDataChannel(label: string): DirectorControlChannel;
  createOffer(): Promise<{ sdp: string }>;
  setLocalDescription(offer: { sdp: string }): Promise<unknown>;
  setRemoteDescription(answer: { type: "answer"; sdp: string }): Promise<unknown>;
  readonly localDescription: { sdp: string } | undefined;
  onTrack: { subscribe(listener: (track: MediaStreamTrack) => void): unknown };
  iceGatheringState: string;
  iceGatheringStateChange: { subscribe(listener: (state: string) => void): unknown };
  close(): unknown;
}

export interface DirectorControlChannel {
  readonly readyState: string;
  send(data: string): unknown;
  onMessage: { subscribe(listener: (raw: unknown) => void): unknown };
  stateChanged: { subscribe(listener: (state: string) => void): unknown };
}

/**
 * The codecs this server will accept from fal, in preference order.
 *
 * This is not a default worth inheriting: werift offers **VP8 only** unless
 * told otherwise, so an unconfigured peer silently forecloses H.264 — and
 * H.264 (`avc1`) with Opus is the whole of what fMP4 can carry, which is what
 * live HLS delivery and the durable archive are both built on. Offering VP8
 * second is deliberate rather than decorative: if fal cannot do H.264 the
 * session still connects and still records, and delivery refuses in the open
 * instead of the handshake failing outright.
 */
export const DIRECTOR_VIDEO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: "video/H264",
    clockRate: 90_000,
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "goog-remb" },
    ],
    // packetization-mode=1 is what the depacketizer's marker-bit rule assumes;
    // the baseline profile is the one every browser can decode.
    parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  }),
  new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90_000,
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "goog-remb" },
    ],
  }),
];

export const DIRECTOR_AUDIO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48_000,
    channels: 2,
  }),
];

function createWeriftPeer(): DirectorPeer {
  return new RTCPeerConnection({
    codecs: { video: DIRECTOR_VIDEO_CODECS, audio: DIRECTOR_AUDIO_CODECS },
  }) as unknown as DirectorPeer;
}

export class DirectorStream {
  readonly audit: DirectorAuditLog;
  private state: DirectorState = initialDirectorState();
  private connection: DirectorPeer | null = null;
  private control: DirectorControlChannel | null = null;
  private readonly consumers: DirectorTrackConsumer[];
  private stopped = false;
  /** Inbound tracks, kept so viewers can be forwarded a copy. */
  private readonly inbound: MediaStreamTrack[] = [];
  private readonly trackListeners: ((track: MediaStreamTrack) => void)[] = [];

  constructor(private readonly options: DirectorStreamOptions) {
    this.audit = new DirectorAuditLog(options.now);
    // Capture stays opt-in and off by default, as `DirectorConfig.record`
    // established: muxing WebM on this thread is what pinned the event loop.
    // The flag now decides whether the recorder exists at all rather than
    // being re-checked per track.
    this.consumers =
      options.consumers ??
      (options.config.record
        ? [new DirectorFileRecorder(options.jamId, options.sessionId, options.sink)]
        : []);
  }

  /** The tracks fal is sending, for forwarding to viewers. */
  get tracks(): readonly MediaStreamTrack[] {
    return this.inbound;
  }

  /**
   * Calls back for every track, including ones that already arrived.
   *
   * A viewer can attach before fal has sent anything, so a listener that only
   * saw future tracks would leave the first viewer watching nothing.
   */
  onTrackAvailable(listener: (track: MediaStreamTrack) => void): () => void {
    for (const track of this.inbound) listener(track);
    this.trackListeners.push(listener);
    return () => {
      const index = this.trackListeners.indexOf(listener);
      if (index >= 0) this.trackListeners.splice(index, 1);
    };
  }

  /** The jam this stream belongs to, for callers holding many streams. */
  get jamId(): string {
    return this.options.jamId;
  }

  get snapshot(): DirectorState {
    return this.state;
  }

  get entries(): readonly DirectorAuditEntry[] {
    return this.audit.all();
  }

  /** Negotiates with fal and starts recording. Throws DirectorError on refusal. */
  async open(): Promise<void> {
    const connection = (this.options.createPeer ?? createWeriftPeer)();
    this.connection = connection;
    this.state = { ...this.state, status: "connecting" };

    // Receive-only: this server sends fal no media, only direction.
    connection.addTransceiver("video", { direction: "recvonly" });
    connection.addTransceiver("audio", { direction: "recvonly" });
    const control = connection.createDataChannel(CONTROL_CHANNEL);
    this.control = control;

    connection.onTrack.subscribe((track) => void this.onTrack(track));
    control.onMessage.subscribe((raw) => this.onControlMessage(raw));
    control.stateChanged.subscribe((channelState) => {
      if (channelState === "open") this.sendConfigure();
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await this.waitForIceGathering(connection);

    const start = this.options.startSession ?? startDirectorSession;
    let answerSdp: string;
    try {
      answerSdp = await start(this.options.config, {
        type: "offer",
        sdp: connection.localDescription?.sdp ?? offer.sdp,
      });
    } catch (error) {
      await this.teardown();
      throw error;
    }
    if (!answerSdp) {
      await this.teardown();
      throw new DirectorError("The director stream returned no answer.", true);
    }
    await connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.audit.record({ kind: "session_opened" });
  }

  /**
   * Sends one direction to fal and records it.
   *
   * The body is recorded exactly as sent, not as received, so the log cannot
   * disagree with what the provider was actually asked for.
   */
  /** The beat being generated, the one locked behind it, and what is editable. */
  get beats(): DirectorBeatWindow {
    return beatWindow(
      beatOffsets(this.options.script),
      this.state.scriptOffsetSeconds,
    );
  }

  direct(request: DirectionRequest): {
    accepted: boolean;
    refusal?: DirectionRefusal;
    promptVersion?: number;
    beats?: DirectorBeatWindow;
  } {
    if (!this.control || this.control.readyState !== "open") {
      return { accepted: false, refusal: "stream_not_ready" };
    }
    const beats = this.beats;
    if (request.beatIndex !== undefined && isBeatLocked(beats, request.beatIndex)) {
      return { accepted: false, refusal: "beat_locked", beats };
    }
    const next = nextPromptMessage(this.state, request.body);
    this.control.send(JSON.stringify(next.message));
    this.state = next.state;
    const promptVersion = (next.message as { prompt_version: number }).prompt_version;
    this.audit.record({
      kind: "direction_sent",
      promptVersion,
      body: request.body,
      authorId: request.authorId,
      proposalId: request.proposalId,
      beatIndex: request.beatIndex,
      scriptOffsetSeconds: this.state.scriptOffsetSeconds ?? undefined,
    });
    return { accepted: true, promptVersion, beats };
  }

  /** Stops the stream, finalizes the recording and stores it. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.control?.readyState === "open") {
      this.control.send(JSON.stringify({ type: "stop" }));
    }
    this.audit.record({ kind: "session_closed" });
    await this.teardown();
  }

  private sendConfigure(): void {
    if (!this.control || this.control.readyState !== "open") return;
    this.control.send(
      JSON.stringify(
        buildConfigureMessage(this.options.config, this.options.script),
      ),
    );
  }

  private onControlMessage(raw: unknown): void {
    const parsed = directorServerMessageSchema.safeParse(safeJson(raw));
    if (!parsed.success) return;
    const message = parsed.data;
    this.state = reduceDirectorState(this.state, message);

    switch (message.type) {
      case "prompt_applied":
        this.audit.record({
          kind: "direction_applied",
          promptVersion: (message as { prompt_version: number }).prompt_version,
        });
        break;
      case "prompt_rejected":
        // Per the transactional-scene-contract rule, a refused direction does
        // not undo the room's decision: it is recorded and surfaced, and the
        // accepted proposal stays accepted.
        this.audit.record({
          kind: "direction_rejected",
          promptVersion:
            (message as { prompt_version?: number | null }).prompt_version ?? undefined,
        });
        break;
      case "chunk": {
        const chunk = message as {
          chunk_index: number;
          prompt_version: number;
          script_offset_seconds?: number | null;
        };
        this.audit.record({
          kind: "chunk_received",
          chunkIndex: chunk.chunk_index,
          promptVersion: chunk.prompt_version,
          scriptOffsetSeconds: chunk.script_offset_seconds ?? undefined,
        });
        break;
      }
      case "error": {
        const failure = message as { code: string; error: string };
        this.audit.record({
          kind: "provider_error",
          detail: `${failure.code}: ${failure.error}`,
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Hands the incoming track to every consumer.
   *
   * The stream owns `onTrack` and nothing else subscribes to it, so recording
   * and live delivery both receive the same track instead of racing for it.
   * werift's event is genuinely multi-subscriber, so each consumer builds its
   * own pipeline from the same RTP without taking packets from the others.
   *
   * A consumer that fails takes only itself down: a recorder that cannot open a
   * temp file must not stop the room watching, and vice versa.
   */
  private async onTrack(track: MediaStreamTrack): Promise<void> {
    // Kept and announced regardless of capture: forwarding a track to a viewer
    // is packet relay and costs almost nothing, while MUXING it is what blocks
    // the event loop. The two are separate decisions.
    this.inbound.push(track);
    for (const listener of this.trackListeners) listener(track);

    // Consumers are the muxing side of that split. Each runs its own pipeline
    // and each is responsible for keeping it off this thread; capture being
    // opt-in is expressed by which consumers exist, not by a check here.
    await Promise.all(
      this.consumers.map(async (consumer) => {
        try {
          await consumer.addTrack(track);
        } catch {
          // Recorded rather than thrown: the session is live and the other
          // consumers are still working.
          this.audit.record({
            kind: "provider_error",
            detail: "track_consumer_failed",
          });
        }
      }),
    );
  }

  private async teardown(): Promise<void> {
    await Promise.all(
      this.consumers.map(async (consumer) => {
        try {
          await consumer.stop();
        } catch {
          // One consumer failing to finalize must not strand the others or
          // hold the session's budget reservation open.
        }
      }),
    );
    this.connection?.close();
    this.state = { ...this.state, status: this.state.status === "failed" ? "failed" : "ended" };
  }

  private waitForIceGathering(connection: DirectorPeer): Promise<void> {
    if (connection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS);
      connection.iceGatheringStateChange.subscribe((gathering) => {
        if (gathering === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }
}

function safeJson(raw: unknown): unknown {
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Buffer
        ? raw.toString("utf8")
        : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
