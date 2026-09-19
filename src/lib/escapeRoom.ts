import type { EscapeSnapshot } from "../core/escape/session";
import { JamError } from "./errors";
import { ensureAccessToken } from "./session";

/**
 * Browser side of the escape room.
 *
 * Every call carries the viewer's own Supabase access token, because the
 * server decides who they are and what they may do from that token and their
 * membership row — this browser never says which room it is the host of. The
 * snapshot that comes back is the only thing the screen draws: there is no
 * client-side copy of the scenario and nothing here to keep in step with it.
 */

export interface ScenarioCard {
  id: string;
  title: string;
  logline: string;
  characterName: string;
  goal: string;
  locationCount: number;
}

async function call<T>(path: string, action: string, init?: RequestInit): Promise<T> {
  const accessToken = await ensureAccessToken(action);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${accessToken}`,
        ...init?.headers,
      },
    });
  } catch {
    throw new JamError("unavailable", "The escape room could not be reached.", true);
  }
  if (!response.ok) throw await asJamError(response);
  return (await response.json()) as T;
}

async function asJamError(response: Response): Promise<JamError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; safeMessage?: string; retryable?: boolean } }
    | null;
  const safeMessage = body?.error?.safeMessage ?? "The escape room is not available.";
  const retryable = body?.error?.retryable ?? false;
  if (response.status === 401) return new JamError("unauthenticated", safeMessage);
  if (response.status === 403) return new JamError("forbidden", safeMessage);
  if (response.status === 404) return new JamError("not_found", safeMessage);
  if (response.status === 409) return new JamError("conflict", safeMessage);
  return new JamError("unavailable", safeMessage, retryable);
}

/**
 * The rooms this build ships, read from the server's own data.
 *
 * Unauthenticated on purpose: these are this repository's scenario files, the
 * same for everyone, and the create screen offers them before anybody has a
 * room to be a member of.
 */
export async function readScenarios(): Promise<ScenarioCard[]> {
  let response: Response;
  try {
    response = await fetch("/api/escape-room/scenarios");
  } catch {
    throw new JamError("unavailable", "The escape rooms could not be listed.", true);
  }
  if (!response.ok) throw await asJamError(response);
  const body = (await response.json()) as { scenarios?: ScenarioCard[] };
  return body.scenarios ?? [];
}

export function openEscapeRoom(jamId: string, scenarioId: string): Promise<EscapeSnapshot> {
  return call(`/api/jams/${jamId}/escape-room`, "Opening an escape room", {
    method: "POST",
    body: JSON.stringify({ scenarioId }),
  });
}

export function readEscapeRoom(jamId: string): Promise<EscapeSnapshot> {
  return call(`/api/jams/${jamId}/escape-room`, "Reading the escape room");
}

export function proposeAction(
  jamId: string,
  input: { body: string; authorName: string },
): Promise<{ proposalId: string; snapshot: EscapeSnapshot }> {
  return call(`/api/jams/${jamId}/escape-room/proposals`, "Proposing an action", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function voteForProposal(jamId: string, proposalId: string): Promise<EscapeSnapshot> {
  return call(`/api/jams/${jamId}/escape-room/votes`, "Voting", {
    method: "POST",
    body: JSON.stringify({ proposalId }),
  });
}

/** Closes the vote. Host-only on the server, whatever this browser thinks. */
export function settleTurn(
  jamId: string,
): Promise<{ beatId: string; snapshot: EscapeSnapshot }> {
  return call(`/api/jams/${jamId}/escape-room/settle`, "Closing the vote", { method: "POST" });
}
