import {
  directorServerMessageSchema,
  initialDirectorState,
  nextPromptMessage,
  reduceDirectorState,
  type DirectorState,
} from "../core/directorProtocol";

/**
 * Opens a Director stream from the browser.
 *
 * The browser is the WebRTC peer by design: the video is a media track, and
 * the alternative is a native WebRTC stack inside the Node server. The server
 * still brokers the handshake, so fal's credential never reaches this code —
 * what travels from here is an SDP offer and, later, direction.
 */

/** The control channel's address, from the model's AsyncAPI `channels`. */
const CONTROL_CHANNEL = "fal";
/** Renewal keeps the server's spend ledger from reclaiming a live session. */
const RENEW_INTERVAL_MS = 30_000;
const ICE_GATHERING_TIMEOUT_MS = 5_000;

export class DirectorSessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DirectorSessionError";
  }
}

export interface DirectorSessionHandle {
  /** Sends new direction; resolves false if the channel is not open. */
  direct(prompt: string): boolean;
  /** Stops the stream and releases the server's reservation. */
  stop(): Promise<void>;
  readonly state: DirectorState;
}

export interface DirectorSessionOptions {
  jamId: string;
  onState(state: DirectorState): void;
  onStream(stream: MediaStream): void;
  signal?: AbortSignal;
}

interface SessionResponse {
  sessionId: string;
  answer: { sdp: string };
  configure: Record<string, unknown>;
  maxSessionSeconds: number;
}

export async function openDirectorSession(
  options: DirectorSessionOptions,
): Promise<DirectorSessionHandle> {
  const connection = new RTCPeerConnection();
  let state: DirectorState = { ...initialDirectorState(), status: "connecting" };
  const publish = () => options.onState(state);
  publish();

  // Video and audio are receive-only: nothing from this browser is uploaded.
  connection.addTransceiver("video", { direction: "recvonly" });
  connection.addTransceiver("audio", { direction: "recvonly" });
  const control = connection.createDataChannel(CONTROL_CHANNEL);

  connection.addEventListener("track", (event) => {
    const [stream] = event.streams;
    if (stream) options.onStream(stream);
  });

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIceGathering(connection);

  let session: SessionResponse;
  try {
    session = await requestSession(
      options.jamId,
      connection.localDescription?.sdp ?? offer.sdp ?? "",
      options.signal,
    );
  } catch (error) {
    connection.close();
    throw error;
  }

  control.addEventListener("open", () => {
    // The configure message is the server's, built from the jam's script.
    control.send(JSON.stringify(session.configure));
  });
  control.addEventListener("message", (event) => {
    const parsed = directorServerMessageSchema.safeParse(safeJson(event.data));
    if (!parsed.success) return;
    state = reduceDirectorState(state, parsed.data);
    publish();
  });

  await connection.setRemoteDescription({
    type: "answer",
    sdp: session.answer.sdp,
  });

  const renew = setInterval(() => {
    void fetch(
      `/api/jams/${options.jamId}/director/session/${session.sessionId}/renew`,
      { method: "POST" },
    ).catch(() => undefined);
  }, RENEW_INTERVAL_MS);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(renew);
    if (control.readyState === "open") {
      control.send(JSON.stringify({ type: "stop" }));
    }
    connection.close();
    state = { ...state, status: "ended" };
    publish();
    // Released last: the reservation must go even if the peer teardown threw.
    await fetch(
      `/api/jams/${options.jamId}/director/session/${session.sessionId}/end`,
      { method: "POST" },
    ).catch(() => undefined);
  };

  options.signal?.addEventListener("abort", () => void stop());

  return {
    direct(prompt: string) {
      if (control.readyState !== "open") return false;
      const next = nextPromptMessage(state, prompt);
      control.send(JSON.stringify(next.message));
      state = next.state;
      publish();
      return true;
    },
    stop,
    get state() {
      return state;
    },
  };
}

async function requestSession(
  jamId: string,
  sdp: string,
  signal?: AbortSignal,
): Promise<SessionResponse> {
  const response = await fetch(`/api/jams/${jamId}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sdp }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = body?.error;
    throw new DirectorSessionError(
      typeof error?.safeMessage === "string"
        ? error.safeMessage
        : "The live director could not be started.",
      typeof error?.code === "string" ? error.code : "director_unavailable",
    );
  }
  return (await response.json()) as SessionResponse;
}

/**
 * fal takes a single complete offer rather than trickled candidates, so the
 * offer is held until gathering finishes. The timeout is a safeguard: a
 * candidate that never arrives should not hang the session forever, and a
 * partial candidate list still connects on a normal network.
 */
function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    connection.addEventListener("icegatheringstatechange", onChange);
  });
}

function safeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
