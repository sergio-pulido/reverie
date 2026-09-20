import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "../src/conversation/decision.js";
import { MAX_TURNS_PER_SESSION } from "../src/preferences/schema.js";
import {
  runEvaluation,
  shortlistQuery,
  type CatalogueReader,
  type EvaluateOk,
} from "./_lib/evaluate-funnel.js";
import {
  abortOnDisconnect,
  admit,
  createGuard,
  fail,
  isUnavailable,
  readJsonBody,
  resolveProvider,
  type DiscoverEndpointOptions,
} from "./_lib/discover-http.js";
import { sendJson } from "./_lib/http.js";
import { fetchCatalogue, UNAUTHENTICATED_RESPONSE, type CatalogueAdapterOptions } from "./_lib/supabase-catalogue.js";
import { serverAccessToken } from "./_lib/supabase-server-session.js";

/**
 * Discover's funnel behind one HTTP call, for an external evaluation harness.
 *
 * Galtea grades a deployed agent by calling one endpoint, and the three conversational endpoints
 * are no use to it: each needs a viewer's Supabase session, and an anonymous one expires inside
 * an hour. This one authenticates with a static `GALTEA_EVAL_TOKEN` the deployment holds, runs
 * interpret → catalogue → rank → critique through the same modules `/api/discover/*` call, and
 * answers with what the viewer would have seen.
 *
 * It is not a second funnel and not a second catalogue: the steps come from `discover-funnel.ts`
 * and the read from the same adapter `/api/catalogue` uses, under a credential the server owns.
 * A viewer's token is never accepted here, and the eval token is never logged or echoed back.
 */

const REQUESTS_PER_MINUTE = 30;
const MAX_BODY_BYTES = 16_000;
const allowRequest = createGuard(REQUESTS_PER_MINUTE);

const messageSchema = z.string().trim().min(1).max(MAX_MESSAGE_CHARS);

export const evaluateRequestSchema = z.strictObject({
  /** The viewer's message to evaluate. */
  input: messageSchema,
  /** Earlier viewer messages, replayed through the same engine so the state is a real one. */
  history: z.array(messageSchema).max(MAX_TURNS_PER_SESSION - 1).default([]),
});

export type EvaluateEndpointOptions = DiscoverEndpointOptions & {
  /** Replaces the catalogue read; tests supply a fake catalogue rather than a database. */
  readCatalogue?: CatalogueReader;
  catalogue?: CatalogueAdapterOptions;
  sessionId?: () => string;
};

export default async function evaluate(request: IncomingMessage, response: ServerResponse, options: EvaluateEndpointOptions = {}) {
  if (!admit(request, response, allowRequest)) return;

  const env = options.env ?? process.env;
  const expected = env.GALTEA_EVAL_TOKEN?.trim();
  if (!expected) {
    fail(response, 503, "EVAL_NOT_CONFIGURED", "Evaluation is not switched on for this deployment.");
    return;
  }
  if (!presentedTokenMatches(request.headers.authorization, expected)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    fail(response, 401, "UNAUTHENTICATED", "This endpoint needs the evaluation token.");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES);
  } catch {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }
  const parsed = evaluateRequestSchema.safeParse(body);
  if (!parsed.success) {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }

  const provider = resolveProvider(options);
  if (isUnavailable(provider)) {
    fail(response, 503, provider.code, provider.safeMessage);
    return;
  }

  const result = await runEvaluation(
    {
      provider,
      readCatalogue: options.readCatalogue ?? serverCatalogueReader(options),
      sessionId: (options.sessionId ?? defaultSessionId)(),
      now: options.now,
      signal: abortOnDisconnect(response),
    },
    [...parsed.data.history, parsed.data.input],
  );

  if (!result.ok) {
    const { statusCode, code, safeMessage, retryable } = result.failure;
    fail(response, statusCode, code, safeMessage, retryable);
    return;
  }
  const payload: EvaluateOk = result.value;
  sendJson(response, 200, payload);
}

function defaultSessionId(): string {
  return `eval-${randomUUID()}`;
}

/**
 * Reads the catalogue as the server, never as the caller. The harness has no Supabase session
 * and must not be given one; without a server credential there is no catalogue, and the funnel
 * says so rather than answering with nothing.
 */
function serverCatalogueReader(options: EvaluateEndpointOptions): CatalogueReader {
  return async (read) => {
    const token = await serverAccessToken({ env: options.env, fetchImpl: options.catalogue?.fetchImpl });
    if (!token) return UNAUTHENTICATED_RESPONSE;
    return fetchCatalogue(shortlistQuery(read), token, { environment: options.env ?? process.env, ...options.catalogue });
  };
}

/**
 * Whether the request presents the evaluation token. Both sides are hashed first, so the
 * comparison is over equal-length buffers and neither the token nor its length leaks through
 * how long the check takes. The presented value is never logged, echoed or stored.
 */
function presentedTokenMatches(header: string | string[] | undefined, expected: string): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const match = raw ? /^Bearer +(\S+)$/.exec(raw.trim()) : null;
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
