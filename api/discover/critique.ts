import type { IncomingMessage, ServerResponse } from "node:http";
import { critiqueRequestSchema, type CritiqueOk } from "../../src/conversation/contract.js";
import { critiqueStep } from "../_lib/discover-funnel.js";
import {
  abortOnDisconnect,
  admit,
  createGuard,
  fail,
  isSignedIn,
  isUnavailable,
  parseState,
  readAccessToken,
  readJsonBody,
  resolveProvider,
  type DiscoverEndpointOptions,
} from "../_lib/discover-http.js";
import { sendJson } from "../_lib/http.js";

const REQUESTS_PER_MINUTE = 30;
const MAX_BODY_BYTES = 32_000;
const allowRequest = createGuard(REQUESTS_PER_MINUTE);

/**
 * Writes the critic's note on the films a ranking picked. One call for the whole set, with its
 * own budget and deadline; the picks are the only films it may write about, and the shortlist's
 * other titles are sent only so a critique that names one can be refused. When it cannot answer
 * the endpoint says so and the browser keeps the reasons the ranking already produced, so a
 * critique that never arrives costs the row nothing.
 */
export default async function discoverCritique(request: IncomingMessage, response: ServerResponse, options: DiscoverEndpointOptions = {}) {
  if (!admit(request, response, allowRequest)) return;

  const accessToken = readAccessToken(request);
  if (!accessToken) {
    fail(response, 401, "UNAUTHENTICATED", "Sign in to use the assistant.");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES);
  } catch {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }
  const parsed = critiqueRequestSchema.safeParse(body);
  const state = parsed.success ? parseState(parsed.data.state) : null;
  if (!parsed.success || !state) {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }

  const provider = resolveProvider(options);
  if (isUnavailable(provider)) {
    sendJson(response, 200, provider);
    return;
  }
  if (!(await isSignedIn(accessToken, options))) {
    fail(response, 401, "UNAUTHENTICATED", "Sign in to use the assistant.");
    return;
  }

  const { picks, withheld } = parsed.data;
  const signal = abortOnDisconnect(response);
  const result = await critiqueStep(provider, state, picks, withheld, { now: options.now, signal });
  if (isUnavailable(result)) {
    sendJson(response, 200, result);
    return;
  }
  if (!result.ok) {
    sendJson(response, 200, result.unavailable);
    return;
  }
  const payload: CritiqueOk = {
    status: "ok",
    source: "nebius",
    model: provider.model,
    stateVersion: state.stateVersion,
    critiques: result.value,
  };
  sendJson(response, 200, payload);
}
