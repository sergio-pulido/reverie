import type { DirectorState } from "../core/directorProtocol";
import type { DirectorAuditEntry } from "../core/directorAudit";

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
  maxSessionSeconds: number;
  /** False when the server has no object storage: the recording is lost on restart. */
  recordingDurable: boolean;
  state: DirectorState;
}

export interface DirectorSnapshot {
  state: DirectorState;
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

export function startDirectorSession(jamId: string): Promise<OpenedDirectorSession> {
  return call<OpenedDirectorSession>(`/api/jams/${jamId}/director/session`, {
    method: "POST",
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
  direction: { body: string; authorId?: string; proposalId?: string },
): Promise<{ promptVersion: number; state: DirectorState }> {
  return call(`/api/jams/${jamId}/director/session/${sessionId}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(direction),
  });
}

export function endDirectorSession(jamId: string, sessionId: string): Promise<void> {
  return call<void>(`/api/jams/${jamId}/director/session/${sessionId}/end`, {
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
