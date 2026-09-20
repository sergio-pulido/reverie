import type { DirectorState } from "../core/directorProtocol";
import type { DirectorAuditEntry } from "../core/directorAudit";
import type { DirectorBeatWindow } from "../core/directorBeats";
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
  /**
   * This viewer's own id on the shared stream, issued by the server.
   *
   * A shared stream needs to know how many people are watching, not merely that
   * someone is: without it, one viewer's keepalive holds the stream open for a
   * room that has emptied, and the last viewer leaving does not end it.
   */
  viewerId: string;
  /** True when this joined a stream that was already running for this configuration. */
  attached: boolean;
  /** False when this server is not delivering the stream live. */
  liveDelivery: boolean;
  maxSessionSeconds: number;
  /** False when the server has no object storage: the recording is lost on restart. */
  recordingDurable: boolean;
  /** Where the room is now. Opening moves it to playing; attaching reports it. */
  lifecycle: JamLifecycle;
  state: DirectorState;
  beats: DirectorBeatWindow;
}

export interface DirectorSnapshot {
  state: DirectorState;
  beats: DirectorBeatWindow;
  audit: DirectorAuditEntry[];
  droppedAuditEntries: number;
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
 * Joins the stream running for a configuration, and never starts one.
 *
 * This is how everyone but the host arrives. Opening a stream bills a
 * sixty-second minimum, so walking into a room must not be able to start one:
 * a participant attaches to what the host is already paying for, or is told
 * `no_stream` and waits. The same call serves the host reopening the jam, which
 * is why it is not gated on who is asking.
 */
export function attachDirectorSession(
  jamId: string,
  configuration?: SessionSettings | null,
): Promise<OpenedDirectorSession> {
  return call<OpenedDirectorSession>(`/api/jams/${jamId}/director/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attachOnly: true, ...(configuration ? { configuration } : {}) }),
  });
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
 * Stops watching, and reports where the room ended up.
 *
 * With a viewer id this leaves the shared stream, which ends it only if nobody
 * else is watching — one person closing a tab must not stop the film for the
 * room. Without one it ends the session outright, which is what a host's own
 * stop means.
 *
 * The lifecycle comes back in the response rather than being inferred: the
 * stop is the moment the room ends, and a caller that had to re-fetch the jam
 * to discover that would show a stale state in between.
 */
export function endDirectorSession(
  jamId: string,
  sessionId: string,
  viewerId?: string,
): Promise<{ lifecycle: JamLifecycle }> {
  return call(`/api/jams/${jamId}/director/session/${sessionId}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Detach is commonly sent while navigating away. Keepalive gives the small
    // request a chance to finish after the document begins unloading, so the
    // last viewer does not leave the paid stream to the idle fallback.
    keepalive: true,
    body: JSON.stringify(viewerId ? { viewerId } : {}),
  });
}

/**
 * Best-effort keepalive; a missed renewal only risks the session being
 * reclaimed.
 *
 * Goes through `call` like every other request here, so anything that is ever
 * added to it — headers, a base URL, error normalization — reaches the
 * keepalive too. The failure is swallowed rather than surfaced: this is the
 * one request whose job is to be repeated.
 */
export function renewDirectorSession(
  jamId: string,
  sessionId: string,
  viewerId?: string,
): void {
  void call<void>(`/api/jams/${jamId}/director/session/${sessionId}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(viewerId ? { viewerId } : {}),
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

/**
 * The live playlist for a session.
 *
 * Everyone watching the same configuration reads this same address, which is
 * the point: the stream is generated once and delivered to the room over plain
 * HTTP, so another viewer costs a cache hit rather than a second paid session.
 */
export function directorPlaylistSrc(jamId: string, sessionId: string): string {
  return `/api/jams/${jamId}/director/session/${sessionId}/playlist.m3u8`;
}
