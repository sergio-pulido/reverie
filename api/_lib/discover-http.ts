import type { IncomingMessage, ServerResponse } from "node:http";
import { completeJson, NebiusError, resolveNebiusConfig } from "../../apps/server/providers/nebius.js";
import type { Unavailable } from "../../src/conversation/contract.js";
import { preferenceStateSchema, type PreferenceState } from "../../src/preferences/schema.js";
import { unavailable, type Completion } from "./discover-assistant.js";
import { clientKey, createRateLimiter, isSameOrigin, sendJson } from "./http.js";
import { authenticate, readBearerToken, readSupabaseConfig, RestError, type SupabaseRestOptions } from "./supabase-rest.js";

/**
 * Guards shared by the conversational endpoints. Every model call is made here, on the server,
 * for a signed-in viewer, under a rate limit and an in-process concurrency cap; the provider key
 * never leaves this process.
 */

export type Provider = { complete: Completion; model: string };

export type DiscoverEndpointOptions = SupabaseRestOptions & {
  env?: NodeJS.ProcessEnv;
  /** Replaces the provider resolved from the environment; null means "not configured". */
  provider?: Provider | null;
  /** Replaces Supabase Auth: resolves true for a signed-in viewer. */
  verifyViewer?: (accessToken: string) => Promise<boolean>;
  now?: () => number;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CONCURRENT_CALLS = 6;
let activeCalls = 0;

export function createGuard(requestsPerMinute: number) {
  return createRateLimiter(requestsPerMinute, RATE_LIMIT_WINDOW_MS);
}

export function fail(response: ServerResponse, statusCode: number, code: string, safeMessage: string, retryable = false) {
  sendJson(response, statusCode, { status: "error", code, safeMessage, retryable });
}

/** Method, origin and rate limit. Returns false after answering when the request is refused. */
export function admit(request: IncomingMessage, response: ServerResponse, allow: (key: string) => boolean): boolean {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    fail(response, 405, "METHOD_NOT_ALLOWED", "Only POST is supported.");
    return false;
  }
  if (!isSameOrigin(request)) {
    fail(response, 403, "CROSS_ORIGIN_BLOCKED", "This endpoint only answers same-origin requests.");
    return false;
  }
  if (!allow(clientKey(request))) {
    response.setHeader("Retry-After", String(RATE_LIMIT_WINDOW_MS / 1_000));
    fail(response, 429, "RATE_LIMITED", "Too many requests to the assistant. Try again shortly.", true);
    return false;
  }
  return true;
}

/** Reads a JSON body up to `maxBytes`; a larger body is refused rather than buffered. */
export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function parseState(input: unknown): PreferenceState | null {
  const parsed = preferenceStateSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function resolveProvider(options: DiscoverEndpointOptions): Provider | Unavailable {
  if (options.provider !== undefined) return options.provider ?? unavailable("ASSISTANT_DISABLED");
  try {
    const config = resolveNebiusConfig(options.env ?? process.env);
    if (!config) return unavailable("ASSISTANT_DISABLED");
    return { complete: (completion) => completeJson(config, completion), model: config.model };
  } catch (error) {
    if (error instanceof NebiusError) return unavailable("ASSISTANT_MISCONFIGURED");
    throw error;
  }
}

/** True when the bearer token belongs to a signed-in viewer, per Supabase Auth. */
export async function isSignedIn(accessToken: string, options: DiscoverEndpointOptions): Promise<boolean> {
  if (options.verifyViewer) return options.verifyViewer(accessToken);
  const supabase = readSupabaseConfig(options.env ?? process.env);
  if (!supabase) return false;
  try {
    await authenticate(supabase, accessToken, options);
    return true;
  } catch (error) {
    if (error instanceof RestError) return false;
    throw error;
  }
}

export function readAccessToken(request: IncomingMessage): string | null {
  return readBearerToken(request.headers.authorization);
}

/** Runs `call` if a slot is free, otherwise answers "busy" without calling the provider. */
export async function withSlot<T>(call: () => Promise<T>): Promise<T | Unavailable> {
  if (activeCalls >= MAX_CONCURRENT_CALLS) return unavailable("ASSISTANT_BUSY");
  activeCalls += 1;
  try {
    return await call();
  } finally {
    activeCalls -= 1;
  }
}

/** Aborts when the client goes away before the answer is written, so the model call stops too. */
export function abortOnDisconnect(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

export function isUnavailable(value: unknown): value is Unavailable {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "unavailable";
}
