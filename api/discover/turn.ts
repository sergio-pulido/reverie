import type { IncomingMessage, ServerResponse } from "node:http";
import { turnRequestSchema, type TurnOk } from "../../src/conversation/contract";
import { MAX_TURNS_PER_SESSION } from "../../src/preferences/schema";
import { interpretMessage } from "../_lib/discover-assistant";
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
} from "../_lib/discover-http";
import { sendJson } from "../_lib/http";

const REQUESTS_PER_MINUTE = 20;
const MAX_BODY_BYTES = 80_000;
const allowRequest = createGuard(REQUESTS_PER_MINUTE);

/**
 * One conversational turn: the viewer's message and the current preference state in, a turn
 * the engine has already accepted out, with one line of acknowledgement and at most one
 * clarifying question. When the assistant cannot help it answers `unavailable` and says why;
 * it never invents a turn.
 */
export default async function discoverTurn(request: IncomingMessage, response: ServerResponse, options: DiscoverEndpointOptions = {}) {
  if (!admit(request, response, allowRequest)) return;

  const accessToken = readAccessToken(request);
  if (!accessToken) {
    fail(response, 401, "UNAUTHENTICATED", "Sign in to talk to the assistant.");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES);
  } catch {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }
  const parsed = turnRequestSchema.safeParse(body);
  const state = parsed.success ? parseState(parsed.data.state) : null;
  if (!parsed.success || !state) {
    fail(response, 400, "INVALID_REQUEST", "That request was not valid.");
    return;
  }
  if (Object.keys(state.processedTurns).length >= MAX_TURNS_PER_SESSION) {
    fail(response, 409, "TURN_LIMIT", "That is as much as one conversation holds. Start over to keep going.");
    return;
  }

  const provider = resolveProvider(options);
  if (isUnavailable(provider)) {
    sendJson(response, 200, provider);
    return;
  }
  if (!(await isSignedIn(accessToken, options))) {
    fail(response, 401, "UNAUTHENTICATED", "Sign in to talk to the assistant.");
    return;
  }

  const { message, previousQuestion } = parsed.data;
  const signal = abortOnDisconnect(response);
  const result = await withSlot(() => interpretMessage(provider.complete, state, message, previousQuestion, options.now, signal));
  if (isUnavailable(result)) {
    sendJson(response, 200, result);
    return;
  }
  if (!result.ok) {
    sendJson(response, 200, result.unavailable);
    return;
  }
  const payload: TurnOk = {
    status: "ok",
    source: "nebius",
    model: provider.model,
    turn: result.value.turn,
    acknowledgement: result.value.acknowledgement,
    question: result.value.question,
  };
  sendJson(response, 200, payload);
}
