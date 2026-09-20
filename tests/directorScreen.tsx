import { render } from "./render";
import { App } from "../src/App";
import type { Jam } from "../src/core/jam";
import type { DirectorAuditEntry } from "../src/core/directorAudit";
import type { DirectorBeatWindow } from "../src/core/directorBeats";
import type { DirectorSpend } from "../src/core/directorSpend";
import { initialDirectorState, type DirectorState } from "../src/core/directorProtocol";
import { beatWindowForScript } from "../src/core/directorBeats";
import { buildScript } from "./helpers";

/**
 * A Director session in the test document.
 *
 * The room comes from this browser's own preview registry, which is where a
 * jam lives when Supabase is not configured — so nothing about the room is
 * mocked. The server is: the script, the budget and the session are the four
 * routes the screen reads, and a test sets what each of them answers.
 */

export const SLUG = "preview-the-salt-door-91af20cd";
export const JAM_ID = "6f2f8f4e-1f3a-4a0a-9a1a-000000000001";
/** 6 beats of 5 seconds: 30 seconds of film. */
export const SCRIPT = buildScript(5, 2, 3);

export const RICH_SPEND: DirectorSpend = {
  budgetUsd: 20,
  usdPerSecond: 0.08,
  minBilledSeconds: 60,
  sessionUsd: 0,
  remainingUsd: 20,
};

export function jamOf(script = SCRIPT): Jam {
  return {
    id: JAM_ID,
    createdAt: "2026-09-20T10:00:00.000Z",
    source: { kind: "from-scratch", prompt: "A lighthouse keeper finds a door." },
    lifecycle: "live",
    format: { totalSeconds: 30, portionMinSeconds: 5, portionMaxSeconds: 5 },
    script,
  };
}

export type ServerOptions = {
  /** The script this server holds, or null when it holds none. */
  jam?: Jam | null;
  configured?: boolean;
  spend?: DirectorSpend;
  /** Where the stream has reached on the script's clock once a session opens. */
  offsetSeconds?: number | null;
  state?: Partial<DirectorState>;
  audit?: DirectorAuditEntry[];
  recordingDurable?: boolean;
  /** An attach-only poll finds a stream another screen already opened. */
  attachExisting?: boolean;
  /** Refuses to open a session with this code. */
  refuse?: { status: number; code: string; message: string };
};

export type FakeServer = {
  requests: string[];
  /** Changes what the next answers say, mid-test. */
  set: (next: Partial<ServerOptions>) => void;
  restore: () => void;
};

export function fakeServer(options: ServerOptions = {}): FakeServer {
  const current: ServerOptions = {
    jam: jamOf(),
    configured: true,
    spend: RICH_SPEND,
    offsetSeconds: null,
    audit: [],
    recordingDurable: true,
    ...options,
  };
  const requests: string[] = [];
  const original = globalThis.fetch;
  let sessions = 0;

  function beats(): DirectorBeatWindow {
    const script = current.jam?.script ?? SCRIPT;
    return beatWindowForScript(script, current.offsetSeconds ?? null);
  }
  function state(): DirectorState {
    return { ...initialDirectorState(), status: "streaming", ...current.state };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);

    if (url === `/api/jams/${JAM_ID}`) {
      return current.jam ? json({ jam: current.jam }) : json({ error: { code: "not_found" } }, 404);
    }
    if (url.endsWith("/director/budget")) {
      return json({ configured: current.configured, spend: current.spend });
    }
    if (url.endsWith("/director/session") && method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.attachOnly && !current.attachExisting) {
        return json(
          {
            error: {
              code: "no_stream",
              safeMessage: "Nobody is streaming this configuration yet.",
              retryable: true,
            },
          },
          404,
        );
      }
      if (current.refuse) {
        return json(
          { error: { code: current.refuse.code, safeMessage: current.refuse.message, retryable: false } },
          current.refuse.status,
        );
      }
      sessions += 1;
      return json(
        {
          sessionId: `session-${sessions}`,
          viewerId: `viewer-${sessions}`,
          attached: Boolean(body.attachOnly),
          liveDelivery: false,
          maxSessionSeconds: 120,
          recordingDurable: current.recordingDurable,
          state: state(),
          beats: beats(),
          spend: current.spend,
        },
        201,
      );
    }
    if (url.endsWith("/end") || url.endsWith("/renew")) return new Response(null, { status: 204 });
    if (url.includes("/director/session/")) {
      return json({
        state: state(),
        beats: beats(),
        audit: current.audit ?? [],
        droppedAuditEntries: 0,
        spend: current.spend,
      });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof fetch;

  return {
    requests,
    set(next) {
      Object.assign(current, next);
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Registers the room in this browser and opens its Director session. */
export async function openDirector(options: ServerOptions = {}): Promise<FakeServer> {
  const server = fakeServer(options);
  window.localStorage.setItem(
    "reverie.preview-jams.v1",
    JSON.stringify([
      {
        id: JAM_ID,
        slug: SLUG,
        title: "The Salt Door",
        premise: "A lighthouse keeper finds a door at the bottom of the sea.",
        visibility: "invite_only",
        status: "draft",
        created_at: "2026-09-20T10:00:00.000Z",
        updated_at: "2026-09-20T10:00:00.000Z",
      },
    ]),
  );
  await render(<App />, `/director/${SLUG}`);
  return server;
}

export const beatCards = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".director-beat"));
export const beatStates = () => beatCards().map((card) => card.dataset.state);
export const turnCards = () => Array.from(document.querySelectorAll<HTMLElement>(".director-turn"));
export const stage = () => document.querySelector<HTMLElement>(".director-stage")!;
export const playButton = () =>
  beatOrNull(document.querySelector<HTMLButtonElement>(".director-stage-actions .button-primary") ?? undefined);

function beatOrNull<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("the control is on the screen");
  return value;
}
