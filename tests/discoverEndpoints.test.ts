import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import discoverCritique from "../api/discover/critique";
import discoverRank from "../api/discover/rank";
import discoverTurn from "../api/discover/turn";
import type { DiscoverEndpointOptions, Provider } from "../api/_lib/discover-http";
import { critiqueResponseSchema, rankResponseSchema, turnResponseSchema } from "../src/conversation/contract";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { MAX_TURNS_PER_SESSION, type PreferenceState } from "../src/preferences/schema";
import { applyTurn, newState, rejectCandidate } from "../src/preferences/state";
import { title } from "./catalogueFixtures";

type Captured = { statusCode: number; body: Record<string, unknown> };
type Handler = (request: IncomingMessage, response: ServerResponse, options?: DiscoverEndpointOptions) => Promise<void>;

let clientNumber = 0;

function request(path: string, body: unknown, options: { method?: string; authorization?: string | null; origin?: string } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  stream.method = options.method ?? "POST";
  stream.url = path;
  const authorization = options.authorization === undefined ? "Bearer header.payload.signature" : options.authorization;
  stream.headers = {
    host: "reverie.test",
    ...(authorization ? { authorization } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  clientNumber += 1;
  Object.defineProperty(stream, "socket", { value: { remoteAddress: `10.1.${Math.floor(clientNumber / 250)}.${clientNumber % 250}` } });
  return stream;
}

function capture(): { response: ServerResponse; done: Promise<Captured> } {
  let resolve!: (value: Captured) => void;
  const done = new Promise<Captured>((settle) => (resolve = settle));
  const response = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    on() {},
    end(chunk: string) {
      resolve({ statusCode: response.statusCode, body: JSON.parse(chunk) });
    },
  } as unknown as ServerResponse;
  return { response, done };
}

async function call(handler: Handler, path: string, body: unknown, options: DiscoverEndpointOptions, init?: Parameters<typeof request>[2]) {
  const { response, done } = capture();
  await handler(request(path, body, init), response, options);
  return done;
}

function provider(...replies: string[]): Provider & { calls: number } {
  const recorded = {
    calls: 0,
    model: "test-model",
    complete: async () => {
      recorded.calls += 1;
      const next = replies.shift();
      if (next === undefined) throw new Error("no scripted reply left");
      return next;
    },
  };
  return recorded;
}

const signedIn: DiscoverEndpointOptions["verifyViewer"] = async () => true;

const SCARY = JSON.stringify({
  dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "scary", explicit: true }],
  setConstraints: [{ slot: "runtime.max", minutes: 120, quote: "under two hours" }],
  removeConstraints: [],
  acknowledgement: "A scary film under two hours.",
  question: null,
});

describe("POST /api/discover/turn", () => {
  const path = "/api/discover/turn";
  const body = { message: "A scary film under two hours", state: newState("endpoint"), previousQuestion: null };

  it("answers with a turn the engine accepts", async () => {
    const result = await call(discoverTurn, path, body, { provider: provider(SCARY), verifyViewer: signedIn });
    assert.equal(result.statusCode, 200);
    const parsed = turnResponseSchema.parse(result.body);
    assert.equal(parsed.status, "ok");
    if (parsed.status !== "ok") return;
    assert.equal(parsed.source, "nebius");
    const next = applyTurn(body.state, parsed.turn, CATALOGUE_CONFIGURATION);
    assert.equal(next.stateVersion, 1);
  });

  it("says the assistant is unavailable when no provider is configured, without calling anything", async () => {
    const result = await call(discoverTurn, path, body, { env: {} as NodeJS.ProcessEnv, verifyViewer: signedIn });
    assert.deepEqual(turnResponseSchema.parse(result.body), {
      status: "unavailable",
      code: "ASSISTANT_DISABLED",
      safeMessage: "The assistant is not switched on for this deployment.",
    });
  });

  it("does not treat a live key as enabled unless live providers are switched on", async () => {
    const env = { NEBIUS_API_KEY: "key", REVERIE_LIVE_ENABLED: "false" } as NodeJS.ProcessEnv;
    const result = await call(discoverTurn, path, body, { env, verifyViewer: signedIn });
    assert.equal(result.body.code, "ASSISTANT_DISABLED");
  });

  it("falls back, and says why, when the model keeps inventing what the viewer said", async () => {
    const invented = SCARY.replace('"quote":"scary"', '"quote":"gory"');
    const scripted = provider(invented, invented);
    const result = await call(discoverTurn, path, body, { provider: scripted, verifyViewer: signedIn });
    assert.equal(result.body.status, "unavailable");
    assert.equal(result.body.code, "ASSISTANT_UNGROUNDED");
    assert.equal(scripted.calls, 2, "one retry, no more");
  });

  it("refuses an unsigned or signed-out viewer before any model call", async () => {
    const scripted = provider(SCARY);
    const anonymous = await call(discoverTurn, path, body, { provider: scripted, verifyViewer: signedIn }, { authorization: null });
    assert.equal(anonymous.statusCode, 401);
    const expired = await call(discoverTurn, path, body, { provider: scripted, verifyViewer: async () => false });
    assert.equal(expired.statusCode, 401);
    assert.equal(scripted.calls, 0);
  });

  it("refuses an invalid state, an empty or oversized message, a wrong method and a foreign origin", async () => {
    const options = { provider: provider(), verifyViewer: signedIn };
    const broken = await call(discoverTurn, path, { ...body, state: { ...body.state, stateVersion: -1 } }, options);
    assert.equal(broken.statusCode, 400);
    assert.equal((await call(discoverTurn, path, { ...body, message: "   " }, options)).statusCode, 400);
    assert.equal((await call(discoverTurn, path, { ...body, message: "x".repeat(501) }, options)).statusCode, 400);
    assert.equal((await call(discoverTurn, path, undefined, options, { method: "GET" })).statusCode, 405);
    assert.equal((await call(discoverTurn, path, body, options, { origin: "https://elsewhere.test" })).statusCode, 403);
  });

  it("refuses a session that has used every turn, without calling the model", async () => {
    let state: PreferenceState = newState("full");
    for (let index = 1; index <= MAX_TURNS_PER_SESSION; index += 1) {
      state = applyTurn(
        state,
        {
          sessionId: state.sessionId,
          turnId: `turn-${index}`,
          expectedStateVersion: state.stateVersion,
          transcript: `turn ${index}`,
          dimensions: {},
          setConstraints: [],
          removeConstraints: [],
        },
        CATALOGUE_CONFIGURATION,
      );
    }
    const scripted = provider(SCARY);
    const result = await call(discoverTurn, path, { ...body, state }, { provider: scripted, verifyViewer: signedIn });
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, "TURN_LIMIT");
    assert.equal(scripted.calls, 0);
  });
});

describe("POST /api/discover/rank", () => {
  const path = "/api/discover/rank";
  const state = newState("rank-endpoint");
  const candidates = [1, 2, 3].map((id) => {
    const { availability: _, ...rest } = title(id, { genres: ["Comedy"] });
    return rest;
  });

  it("returns a ranking of supplied ids only", async () => {
    const reply = JSON.stringify({
      ranking: [
        { candidateId: "cat:2", utility: 0.9 },
        { candidateId: "cat:3", utility: 0.6 },
        { candidateId: "cat:1", utility: 0.3 },
      ],
      reasons: [{ candidateId: "cat:2", reason: "Funniest of the three." }],
    });
    const result = await call(discoverRank, path, { state, candidates }, { provider: provider(reply), verifyViewer: signedIn });
    const parsed = rankResponseSchema.parse(result.body);
    assert.equal(parsed.status, "ok");
    if (parsed.status !== "ok") return;
    assert.deepEqual(parsed.ranking.map(({ candidateId }) => candidateId), ["cat:2", "cat:3", "cat:1"]);
    assert.equal(parsed.stateVersion, state.stateVersion);
  });

  it("falls back when the model keeps naming a film it was not given", async () => {
    const reply = JSON.stringify({ ranking: [{ candidateId: "cat:42", utility: 1 }, { candidateId: "cat:1", utility: 0.5 }] });
    const result = await call(discoverRank, path, { state, candidates }, { provider: provider(reply, reply), verifyViewer: signedIn });
    assert.equal(result.body.status, "unavailable");
    assert.equal(result.body.code, "ASSISTANT_UNGROUNDED");
  });

  it("says the assistant is unavailable when no provider is configured", async () => {
    const result = await call(discoverRank, path, { state, candidates }, { provider: null, verifyViewer: signedIn });
    assert.equal(result.body.code, "ASSISTANT_DISABLED");
  });

  it("refuses more candidates than one shortlist holds", async () => {
    const many = Array.from({ length: 49 }, (_, index) => ({ ...candidates[0], id: `cat:${index + 1}` }));
    const result = await call(discoverRank, path, { state, candidates: many }, { provider: provider(), verifyViewer: signedIn });
    assert.equal(result.statusCode, 400);
  });
});

describe("POST /api/discover/critique", () => {
  const path = "/api/discover/critique";
  const state = newState("critique-endpoint");
  const picks = [1, 2].map((id) => {
    const { availability: _, ...rest } = title(id, { title: `Film ${id}`, genres: ["Comedy"] });
    return rest;
  });

  /** A critique that breaks none of the critic's rules. */
  function note(candidateId: string, reservation = "The last half hour loses its nerve and reaches for a moral.") {
    return {
      candidateId,
      why: "A screwball structure worked out with real rigour, which almost nobody attempts at this scale.",
      watching: "Brisk and verbal, carried by a cast that plays the farce entirely straight until it cannot.",
      reservation,
    };
  }

  it("returns a critique for each pick, with the state version it was written for", async () => {
    const reply = JSON.stringify({ critiques: [note("cat:1"), note("cat:2")] });
    const result = await call(discoverCritique, path, { state, picks, withheld: [] }, { provider: provider(reply), verifyViewer: signedIn });
    const parsed = critiqueResponseSchema.parse(result.body);
    assert.equal(parsed.status, "ok");
    if (parsed.status !== "ok") return;
    assert.deepEqual(parsed.critiques.map(({ candidateId }) => candidateId), ["cat:1", "cat:2"]);
    assert.equal(parsed.stateVersion, state.stateVersion);
  });

  it("carries nothing the preference engine could read: no turn, no quote, no version bump", async () => {
    const reply = JSON.stringify({ critiques: [note("cat:1")] });
    const result = await call(discoverCritique, path, { state, picks, withheld: [] }, { provider: provider(reply), verifyViewer: signedIn });
    assert.deepEqual(Object.keys(result.body).sort(), ["critiques", "model", "source", "stateVersion", "status"]);
    assert.equal(result.body.stateVersion, state.stateVersion);
  });

  it("falls back when the critic keeps naming a film it was not given", async () => {
    const reply = JSON.stringify({ critiques: [{ ...note("cat:1"), watching: "Sharper than Night Terror ever was." }] });
    const result = await call(discoverCritique, path, { state, picks, withheld: ["Night Terror"] }, { provider: provider(reply, reply), verifyViewer: signedIn });
    assert.equal(result.body.status, "unavailable");
    assert.equal(result.body.code, "ASSISTANT_UNUSABLE");
  });

  it("never lets a withheld title refuse the pick that shares its name", async () => {
    const reply = JSON.stringify({ critiques: [note("cat:1")] });
    const result = await call(
      discoverCritique,
      path,
      { state, picks: [picks[0]], withheld: ["Film 1", "Night Terror"] },
      { provider: provider(reply), verifyViewer: signedIn },
    );
    assert.equal(result.body.status, "ok");
  });

  it("says the assistant is unavailable when no provider is configured", async () => {
    const result = await call(discoverCritique, path, { state, picks, withheld: [] }, { provider: null, verifyViewer: signedIn });
    assert.equal(result.body.code, "ASSISTANT_DISABLED");
  });

  it("refuses more picks than the shortlist has top picks", async () => {
    const many = Array.from({ length: 4 }, (_, index) => ({ ...picks[0], id: `cat:${index + 1}` }));
    const result = await call(discoverCritique, path, { state, picks: many }, { provider: provider(), verifyViewer: signedIn });
    assert.equal(result.statusCode, 400);
  });

  it("refuses a request from a viewer who is not signed in, before any model call", async () => {
    const scripted = provider(JSON.stringify({ critiques: [note("cat:1")] }));
    const result = await call(discoverCritique, path, { state, picks }, { provider: scripted, verifyViewer: async () => false });
    assert.equal(result.statusCode, 401);
    assert.equal(scripted.calls, 0);
  });

  it("never writes about a film the state rules out, and pays nothing when none is left", async () => {
    const refused = rejectCandidate(state, "cat:1");
    const scripted = provider(JSON.stringify({ critiques: [note("cat:2")] }));
    const result = await call(discoverCritique, path, { state: refused, picks }, { provider: scripted, verifyViewer: signedIn });
    assert.equal(result.body.status, "ok", "the pick that survives is still written about");
    assert.deepEqual((result.body.critiques as { candidateId: string }[]).map(({ candidateId }) => candidateId), ["cat:2"]);

    const none = provider();
    const empty = await call(discoverCritique, path, { state: rejectCandidate(refused, "cat:2"), picks }, { provider: none, verifyViewer: signedIn });
    assert.equal(empty.statusCode, 400);
    assert.equal(none.calls, 0, "no model call for films the state has already ruled out");
  });
});
