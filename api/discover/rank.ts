import type { IncomingMessage, ServerResponse } from "node:http";
import { rankRequestSchema, type RankOk } from "../../src/conversation/contract.js";
import { eligibleRankCandidates, rankCandidates } from "../_lib/discover-assistant.js";
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
  withSlot,
  type DiscoverEndpointOptions,
} from "../_lib/discover-http.js";
import { sendJson } from "../_lib/http.js";

const REQUESTS_PER_MINUTE = 30;
const MAX_BODY_BYTES = 96_000;
const allowRequest = createGuard(REQUESTS_PER_MINUTE);

/**
 * Ranks a refined shortlist. The model sees only the eligible candidates sent here and may only
 * reorder them: its ranking crosses the engine's boundary before it is returned, and the browser
 * checks it again against the shortlist it actually holds.
 */
export default async function discoverRank(request: IncomingMessage, response: ServerResponse, options: DiscoverEndpointOptions = {}) {
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
  const parsed = rankRequestSchema.safeParse(body);
  const state = parsed.success ? parseState(parsed.data.state) : null;
  const candidates = parsed.success && state ? eligibleRankCandidates(parsed.data.candidates, state) : [];
  if (!parsed.success || !state || candidates.length === 0) {
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

  const signal = abortOnDisconnect(response);
  const result = await withSlot(() => rankCandidates(provider.complete, state, candidates, options.now, signal));
  if (isUnavailable(result)) {
    sendJson(response, 200, result);
    return;
  }
  if (!result.ok) {
    sendJson(response, 200, result.unavailable);
    return;
  }
  const payload: RankOk = {
    status: "ok",
    source: "nebius",
    model: provider.model,
    stateVersion: state.stateVersion,
    ranking: result.value.ranking,
    reasons: result.value.reasons,
  };
  sendJson(response, 200, payload);
}
