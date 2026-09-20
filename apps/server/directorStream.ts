import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type MediaStreamTrack,
} from "werift";
import {
  directorServerMessageSchema,
  initialDirectorState,
  nextPromptMessage,
  nextScriptMessage,
  reduceDirectorState,
  type DirectorState,
} from "../../src/core/directorProtocol";
import {
  DirectorAuditLog,
  type DirectorAuditEntry,
  type DirectorAuditListener,
} from "../../src/core/directorAudit";
import { totalDurationSeconds, type JamScript } from "../../src/core/script";
import {
  completionDetail,
  completionSignal,
  type CompletionSignal,
} from "../../src/core/directorCompletion";
import {
  beatOffsets,
  beatWindow,
  isBeatLocked,
  type DirectorBeatWindow,
} from "../../src/core/directorBeats";
import {
  buildConfigureMessage,
  buildDirectorScript,
  DIRECTOR_MAX_CHUNK_SECONDS,
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

export interface DirectorStreamOptions {
  jamId: string;
  sessionId: string;
  config: DirectorConfig;
  script: JamScript;
  /**
   * The jam's script as it stands right now.
   *
   * The stream hands fal the beats a chunk at a time, and each handover reads
   * the story again: an edit that landed since the session opened is in the
   * beats that have not gone yet, and that is the whole point — the provider
   * is never holding a beat the room could still change. Absent, the script
   * this session opened with is used, which is what a test or a jam with no
   * store behind it wants.
   */
  readScript?: () => Promise<JamScript | null>;
  /** Injected in tests; defaults to the real fal handshake. */
  startSession?: typeof startDirectorSession;
  /** Injected in tests; defaults to a real werift peer. */
  createPeer?: () => DirectorPeer;
  /** Prefer H.264 for fMP4 delivery; recording-only sessions prefer VP8/WebM. */
  preferH264?: boolean;
  now?: () => Date;
  /**
   * Notified as each audit entry is recorded, so the trail can be written
   * somewhere that outlives this process. The in-memory trail is unaffected.
   */
  onAudit?: DirectorAuditListener;
  /**
   * Called once, when the provider has generated the whole film.
   *
   * Not an ending. Generation finishes long before the film has been watched,
   * so this exists to be recorded and reported, not to tear anything down —
   * ending a take here is exactly the bug that showed a room nothing at all.
   */
  onFilmGenerated?: (signal: CompletionSignal) => void;
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
 * H.264 (`avc1`) with Opus is the whole of what fMP4 can carry, while the
 * recording-only path writes VP8 WebM. Both stay in the offer; the selected
 * container decides which one leads, and an unsupported fallback is refused
 * by the muxer rather than being emitted under the wrong container label.
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

/**
 * Keep both supported codecs in every offer, but lead with the one the active
 * media pipeline can actually mux. A recording-only server writes WebM and
 * therefore must not accidentally negotiate H.264 merely because the HLS
 * path also exists in this module.
 */
export function directorVideoCodecs(preferH264: boolean): RTCRtpCodecParameters[] {
  return preferH264
    ? DIRECTOR_VIDEO_CODECS
    : [DIRECTOR_VIDEO_CODECS[1], DIRECTOR_VIDEO_CODECS[0]];
}

export const DIRECTOR_AUDIO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48_000,
    channels: 2,
  }),
];

/** Which beat starts at an offset, so a handover can be audited by beat. */
function beatIndexAt(script: JamScript, offsetSeconds: number): number | undefined {
  const index = beatOffsets(script).indexOf(offsetSeconds);
  return index < 0 ? undefined : index;
}

function createWeriftPeer(preferH264: boolean): DirectorPeer {
  return new RTCPeerConnection({
    codecs: { video: directorVideoCodecs(preferH264), audio: DIRECTOR_AUDIO_CODECS },
  }) as unknown as DirectorPeer;
}

export class DirectorStream {
  readonly audit: DirectorAuditLog;
  private state: DirectorState = initialDirectorState();
  private connection: DirectorPeer | null = null;
  private control: DirectorControlChannel | null = null;
  private stopped = false;
  /** Reported once: the film is generated in one chunk, not repeatedly. */
  private generated = false;
  /**
   * Seconds of script fal has been given. The lock boundary IS this number:
   * every beat below it is spoken for, every beat above it can still change.
   */
  private committedThroughSeconds = 0;
  /** One handover at a time, so two chunks cannot send the same beat twice. */
  private releasing: Promise<void> = Promise.resolve();
  /** Inbound tracks, kept so viewers can be forwarded a copy. */
  private readonly inbound: MediaStreamTrack[] = [];
  private readonly trackListeners: ((track: MediaStreamTrack) => void)[] = [];

  constructor(private readonly options: DirectorStreamOptions) {
    this.audit = new DirectorAuditLog(options.now, options.onAudit);
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

  /** True once the provider has generated the whole film it was asked for. */
  get filmGenerated(): boolean {
    return this.generated;
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
    const connection = this.options.createPeer?.()
      ?? createWeriftPeer(this.options.preferH264 ?? true);
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
      this.committedThroughSeconds,
    );
  }

  /** How much of the script fal holds. The lock boundary, in seconds. */
  get committedSeconds(): number {
    return this.committedThroughSeconds;
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

  /**
   * Stops the stream, finalizes the recording and stores it.
   *
   * `reason` is recorded when the caller has one. A take that ended because
   * the film had been watched to its end is not the same event as one somebody
   * pressed Stop on, and the trail is the only place that difference survives.
   */
  async stop(reason?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.control?.readyState === "open") {
      this.control.send(JSON.stringify({ type: "stop" }));
    }
    this.audit.record({ kind: "session_closed", ...(reason ? { detail: reason } : {}) });
    await this.teardown();
  }

  /**
   * Opens the session with the premise and the first chunk's worth of beats.
   *
   * Not the whole film. Whatever goes in here is planned from immediately and
   * can never be changed again, so it is kept to what fal will generate before
   * it has told us anything — one chunk at the longest length the model makes.
   * Everything after it is handed over as it closes, in `releaseBeats`.
   */
  private sendConfigure(): void {
    if (!this.control || this.control.readyState !== "open") return;
    const throughSeconds = DIRECTOR_MAX_CHUNK_SECONDS;
    this.control.send(
      JSON.stringify(
        buildConfigureMessage(this.options.config, this.options.script, {
          throughSeconds,
        }),
      ),
    );
    this.committedThroughSeconds = throughSeconds;
  }

  /**
   * Hands fal the beats it is about to need, reading the story as it stands.
   *
   * Called on every chunk. fal is generating the chunk that starts at the
   * frontier, so the beats of the chunk AFTER that are the ones it has not
   * planned yet and the ones it needs next — and the moment they are sent is
   * the moment they stop being editable, which is what `beats` reports.
   *
   * Best-effort by design: a handover that fails leaves the boundary where it
   * was, so the same beats are offered again on the next chunk rather than
   * being silently skipped. What cannot be recovered is a beat the frontier
   * has already passed; that is recorded, not papered over.
   */
  private async releaseBeats(): Promise<void> {
    if (this.stopped || !this.control || this.control.readyState !== "open") return;
    const frontier = this.state.scriptOffsetSeconds;
    if (frontier === null) return;
    const chunk = this.state.chunkSeconds ?? DIRECTOR_MAX_CHUNK_SECONDS;
    // The chunk being generated, plus the one after it: that is what fal needs
    // in hand to keep going without ever holding a beat that could change.
    const through = frontier + chunk * 2;
    if (through <= this.committedThroughSeconds) return;
    const script =
      (this.options.readScript ? await this.options.readScript() : null)
      ?? this.options.script;
    if (this.stopped || !this.control || this.control.readyState !== "open") return;
    const beats = buildDirectorScript(script, {
      fromSeconds: this.committedThroughSeconds,
      toSeconds: through,
    });
    if (beats.length === 0) {
      // Past the last beat, or a window that spans none: nothing to send, but
      // the boundary still moves so the room is not told a beat is editable
      // when the stream has already run past it.
      this.committedThroughSeconds = through;
      return;
    }
    const next = nextScriptMessage(this.state, beats);
    this.control.send(JSON.stringify(next.message));
    this.state = next.state;
    this.committedThroughSeconds = through;
    this.audit.record({
      kind: "beats_sent",
      promptVersion: (next.message as { prompt_version: number }).prompt_version,
      beatIndex: beatIndexAt(this.options.script, beats[0].offset),
      scriptOffsetSeconds: frontier,
      detail: `beats ${beats.map((beat) => beat.offset).join(", ")}s`,
    });
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
        // The frontier moved, so the next beats are due. Queued behind any
        // handover still in flight: two chunks arriving together must not both
        // read the same boundary and send the same beats twice.
        this.releasing = this.releasing
          .then(() => this.releaseBeats())
          .catch(() => undefined);
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

    this.reportFilmGenerated();
  }

  /**
   * Says, once, that the provider has generated the whole film.
   *
   * Read after every control message rather than only after a chunk, because
   * the two readings that answer it are carried on different messages.
   *
   * A stream that is already stopping reports nothing: there is nobody left to
   * tell, and the take is on its way out.
   */
  private reportFilmGenerated(): void {
    if (this.generated || this.stopped) return;
    const reading = {
      runtimeSeconds: totalDurationSeconds(this.options.script),
      generatedSeconds: this.state.generatedSeconds,
      scriptOffsetSeconds: this.state.scriptOffsetSeconds,
    };
    const signal = completionSignal(reading);
    if (!signal) return;
    this.generated = true;
    this.audit.record({
      kind: "film_generated",
      detail: completionDetail(signal, reading),
      ...(this.state.scriptOffsetSeconds === null
        ? {}
        : { scriptOffsetSeconds: this.state.scriptOffsetSeconds }),
    });
    this.options.onFilmGenerated?.(signal);
  }

  /**
   * Keeps and announces an incoming track. Nothing here touches its media.
   *
   * Forwarding a track to a viewer is packet relay and costs almost nothing;
   * MUXING it is what blocked the event loop when it ran on this thread. So
   * this stream never muxes: whoever wants the media — the relay, the piece
   * recorder — subscribes through `onTrackAvailable` and does its work off
   * this thread. The in-process recorder that used to live here is gone for
   * that reason (docs/DECISIONS.md).
   */
  private onTrack(track: MediaStreamTrack): void {
    this.inbound.push(track);
    for (const listener of this.trackListeners) listener(track);
  }

  private async teardown(): Promise<void> {
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
