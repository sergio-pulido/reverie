import type { IncomingMessage, ServerResponse } from "node:http";
import { critiqueRequestSchema, type CritiqueOk } from "../../src/conversation/contract.js";
import { eligibleRankCandidates } from "../_lib/discover-assistant.js";
import { writeCritiques } from "../_lib/discover-critic.js";
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
  // The same rule the ranking endpoint applies: the model only ever sees films this state
  // allows. A pick the state rules out is not on screen, so nothing is paid to write about it.
  const eligible = parsed.success && state ? new Set(eligibleRankCandidates(parsed.data.picks, state).map(({ id }) => id)) : new Set<string>();
  const picks = parsed.success ? parsed.data.picks.filter(({ id }) => eligible.has(id)) : [];
  if (!parsed.success || !state || picks.length === 0) {
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

  // A title sent as both a pick and a withheld one would refuse every critique of it.
  const held = parsed.data.withheld.filter((name) => !picks.some((film) => film.title === name));
  const signal = abortOnDisconnect(response);
  const result = await withSlot(() => writeCritiques(provider.complete, state, picks, held, options.now, signal));
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
