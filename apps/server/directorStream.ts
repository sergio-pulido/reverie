import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection, type MediaStreamTrack } from "werift";
import { MediaRecorder } from "werift/nonstandard";
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

/** Where a finished recording goes. Kept as an interface so the media store
 * and a test fake are interchangeable. */
export interface DirectorRecordingSink {
  save(jamId: string, sessionId: string, bytes: Buffer, contentType: string): Promise<void>;
}

export interface DirectorStreamOptions {
  jamId: string;
  sessionId: string;
  config: DirectorConfig;
  script: JamScript;
  sink?: DirectorRecordingSink;
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
}

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

function createWeriftPeer(): DirectorPeer {
  return new RTCPeerConnection() as unknown as DirectorPeer;
}

export class DirectorStream {
  readonly audit: DirectorAuditLog;
  private state: DirectorState = initialDirectorState();
  private connection: DirectorPeer | null = null;
  private control: DirectorControlChannel | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingDir: string | null = null;
  private recordingPath: string | null = null;
  private stopped = false;

  constructor(private readonly options: DirectorStreamOptions) {
    this.audit = new DirectorAuditLog(options.now);
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
    let answer: unknown;
    try {
      answer = await start(this.options.config, {
        type: "offer",
        sdp: connection.localDescription?.sdp ?? offer.sdp,
      });
    } catch (error) {
      await this.teardown();
      throw error;
    }
    const sdp = (answer as { sdp?: unknown })?.sdp;
    if (typeof sdp !== "string") {
      await this.teardown();
      throw new DirectorError("The director stream returned no answer.", true);
    }
    await connection.setRemoteDescription({ type: "answer", sdp });
    this.audit.record({ kind: "session_opened" });
  }

  /**
   * Sends one direction to fal and records it.
   *
   * The body is recorded exactly as sent, not as received, so the log cannot
   * disagree with what the provider was actually asked for.
   */
  direct(request: DirectionRequest): { accepted: boolean; promptVersion?: number } {
    if (!this.control || this.control.readyState !== "open") {
      return { accepted: false };
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
      scriptOffsetSeconds: this.state.scriptOffsetSeconds ?? undefined,
    });
    return { accepted: true, promptVersion };
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
   * Records the incoming track to disk.
   *
   * To a file rather than straight to object storage because the container
   * formats need to finalize their headers on close; streaming a half-written
   * WebM into the media store would leave an unplayable object behind.
   */
  private async onTrack(track: MediaStreamTrack): Promise<void> {
    if (this.recorder) {
      await this.recorder.addTrack(track);
      return;
    }
    this.recordingDir = await mkdtemp(join(tmpdir(), "reverie-director-"));
    this.recordingPath = join(this.recordingDir, `${this.options.sessionId}.webm`);
    this.recorder = new MediaRecorder({
      path: this.recordingPath,
      tracks: [track],
    });
  }

  private async teardown(): Promise<void> {
    try {
      await this.recorder?.stop();
    } catch {
      // A recorder that never received a frame throws on stop; the session is
      // ending either way and the failure must not mask the real reason.
    }
    this.connection?.close();
    await this.persistRecording();
    this.state = { ...this.state, status: this.state.status === "failed" ? "failed" : "ended" };
  }

  private async persistRecording(): Promise<void> {
    const path = this.recordingPath;
    const dir = this.recordingDir;
    this.recordingPath = null;
    this.recordingDir = null;
    if (!path || !dir) return;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > 0) {
        await this.options.sink?.save(
          this.options.jamId,
          this.options.sessionId,
          bytes,
          "video/webm",
        );
      }
    } catch {
      // Losing the recording must not prevent the session from closing and
      // releasing its budget reservation.
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
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
