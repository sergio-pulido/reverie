import type { DirectorState } from "../core/directorProtocol";
import type { DirectorAuditEntry } from "../core/directorAudit";
import type { DirectorBeatWindow } from "../core/directorBeats";
import type { DirectorSpend } from "../core/directorSpend";
import type { SessionSettings } from "../core/session";
import type { JamLifecycle } from "../core/jamLifecycle";

/**
 * Client for the server-proxied live director.
 *
 * There is no WebRTC here by design. The server holds the peer connection so
 * every frame can be recorded and every direction audited, which means this
 * browser can ask for a direction to be sent but can never reach the provider
 * itself. What it gets back is state, the audit trail, and a recording URL.
 */

export class DirectorSessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DirectorSessionError";
  }
}

export interface OpenedDirectorSession {
  sessionId: string;
  /** True when this joined a stream that was already running for this configuration. */
  attached: boolean;
  maxSessionSeconds: number;
  /** False when the server has no object storage: the recording is lost on restart. */
  recordingDurable: boolean;
  /** Where the room is now. Opening moves it to playing; attaching reports it. */
  lifecycle: JamLifecycle;
  state: DirectorState;
  beats: DirectorBeatWindow;
  spend: DirectorSpend;
}

export interface DirectorSnapshot {
  state: DirectorState;
  beats: DirectorBeatWindow;
  audit: DirectorAuditEntry[];
  droppedAuditEntries: number;
  spend: DirectorSpend;
}

/** What this server will spend on generation, before any of it is spent. */
export interface DirectorBudget {
  /** False when no director is configured here: nothing can be generated at all. */
  configured: boolean;
  spend: DirectorSpend;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = (body as { error?: { code?: string; safeMessage?: string } } | null)?.error;
    throw new DirectorSessionError(
      typeof error?.safeMessage === "string"
        ? error.safeMessage
        : "The live director is not available.",
      typeof error?.code === "string" ? error.code : "director_unavailable",
    );
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/**
 * Opens the stream for a configuration, or joins the one already running for
 * it. Everyone watching the same configuration shares one paid stream.
 */
export function startDirectorSession(
  jamId: string,
  configuration?: SessionSettings | null,
): Promise<OpenedDirectorSession> {
  return call<OpenedDirectorSession>(`/api/jams/${jamId}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(configuration ? { configuration } : {}),
  });
}

/**
 * The server's director budget, read before a paid session exists.
 *
 * Its own route rather than a field on the jam: the ceiling belongs to this
 * process, and a screen has to be able to say what a beat would cost before
 * it offers to generate one.
 */
export function readDirectorBudget(jamId: string): Promise<DirectorBudget> {
  return call<DirectorBudget>(`/api/jams/${jamId}/director/budget`);
}

export function readDirectorSession(
  jamId: string,
  sessionId: string,
): Promise<DirectorSnapshot> {
  return call<DirectorSnapshot>(`/api/jams/${jamId}/director/session/${sessionId}`);
}

/** Asks the server to send one direction. It decides what reaches the model. */
export function sendDirection(
  jamId: string,
  sessionId: string,
  direction: {
    body: string;
    authorId?: string;
    proposalId?: string;
    /** The outline beat this rewrites; the server refuses a locked one. */
    beatIndex?: number;
  },
): Promise<{ promptVersion: number; state: DirectorState; beats: DirectorBeatWindow }> {
  return call(`/api/jams/${jamId}/director/session/${sessionId}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(direction),
  });
}

/**
 * Stops the stream and reports where the room ended up.
 *
 * The lifecycle comes back in the response rather than being inferred: the
 * stop is the moment the room ends, and a caller that had to re-fetch the jam
 * to discover that would show a stale state in between.
 */
export function endDirectorSession(
  jamId: string,
  sessionId: string,
): Promise<{ lifecycle: JamLifecycle }> {
  return call(`/api/jams/${jamId}/director/session/${sessionId}/end`, {
    method: "POST",
  });
}

/** Best-effort keepalive; a missed renewal only risks the session being reclaimed. */
export function renewDirectorSession(jamId: string, sessionId: string): void {
  void fetch(`/api/jams/${jamId}/director/session/${sessionId}/renew`, {
    method: "POST",
  }).catch(() => undefined);
}

export function directorRecordingSrc(jamId: string, sessionId: string): string {
  return `/api/jams/${jamId}/director/recordings/${sessionId}`;
}

/**
 * The archived session as one playable file.
 *
 * WebM and fMP4 both concatenate their initial header with ordered media
 * pieces, so this plays in a plain `<video>` with no player library.
 */
export function directorArchiveVideoSrc(jamId: string, sessionId: string): string {
  return `/api/jams/${jamId}/director/archive/${sessionId}/video`;
}

/** One piece of the film, playable on its own; the seek primitive. */
export function directorArchivePieceSrc(jamId: string, sessionId: string, index: number): string {
  return `/api/jams/${jamId}/director/archive/${sessionId}/pieces/${index}`;
}

export interface ArchivedPiece {
  segmentIndex: number;
  startSeconds: number;
  durationSeconds: number;
}

/** A finished session's record: whether it completed, and its pieces. */
export async function readDirectorArchive(
  jamId: string,
  sessionId: string,
): Promise<{
  durable: boolean;
  session: { complete: boolean; container: string | null };
  segments: ArchivedPiece[];
  durationSeconds: number;
}> {
  return call(`/api/jams/${jamId}/director/archive/${sessionId}`);
}

/** The sessions a finished room archived, newest first. */
export async function listDirectorArchive(
  jamId: string,
): Promise<{ durable: boolean; sessions: { id: string }[] }> {
  return call(`/api/jams/${jamId}/director/archive`);
}

/** The room's life, as the server holds it. */
export async function readJamLifecycle(jamId: string): Promise<JamLifecycle> {
  const body = await call<{ jam: { lifecycle?: JamLifecycle } }>(`/api/jams/${jamId}`);
  return body.jam.lifecycle ?? "live";
}

/**
 * Opens a live view of a running session.
 *
 * The browser peers with OUR SERVER, never with fal: the server holds the
 * provider connection and forwards a copy, so every frame is still seen,
 * audited and recordable on the way through. Returns the stream to render,
 * and a teardown.
 */
export async function watchDirectorStream(
  jamId: string,
  sessionId: string,
  onStream: (stream: MediaStream) => void,
): Promise<() => void> {
  const connection = new RTCPeerConnection();
  // Receive-only: nothing from this machine is uploaded.
  connection.addTransceiver("video", { direction: "recvonly" });
  connection.addTransceiver("audio", { direction: "recvonly" });
  connection.addEventListener("track", (event) => {
    const [stream] = event.streams;
    if (stream) onStream(stream);
    else onStream(new MediaStream([event.track]));
  });

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIceGathering(connection);

  try {
    const { answer } = await call<{ answer: { sdp: string } }>(
      `/api/jams/${jamId}/director/session/${sessionId}/watch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: connection.localDescription?.sdp ?? offer.sdp }),
      },
    );
    await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  } catch (error) {
    connection.close();
    throw error;
  }
  return () => connection.close();
}

/**
 * The server takes a single complete offer rather than trickled candidates, so
 * the offer waits for gathering. The timeout is a safeguard: one candidate that
 * never arrives must not hang a viewer forever.
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
    const timer = setTimeout(finish, 5_000);
    connection.addEventListener("icegatheringstatechange", onChange);
  });
}
