import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import evaluateEndpoint, { type EvaluateEndpointOptions } from "../api/evaluate";
import { CRITIC_SYSTEM, INTERPRET_SYSTEM, RANK_SYSTEM } from "../api/_lib/discover-prompts";
import type { CatalogueReader } from "../api/_lib/evaluate-funnel";
import type { CompletionOptions } from "../apps/server/providers/nebius";
import { CATALOGUE_LIMITS, type CatalogueTitle } from "../src/catalogue/contract";
import { title } from "./catalogueFixtures";

const TOKEN = "eval-token-2f8a9c";
const env = { GALTEA_EVAL_TOKEN: TOKEN } as NodeJS.ProcessEnv;

type Captured = { statusCode: number; body: Record<string, unknown> };

let clientNumber = 0;

function request(body: unknown, options: { method?: string; authorization?: string | null } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  stream.method = options.method ?? "POST";
  stream.url = "/api/evaluate";
  const authorization = options.authorization === undefined ? `Bearer ${TOKEN}` : options.authorization;
  stream.headers = { host: "reverie.test", ...(authorization ? { authorization } : {}) };
  clientNumber += 1;
  Object.defineProperty(stream, "socket", { value: { remoteAddress: `10.9.${Math.floor(clientNumber / 250)}.${clientNumber % 250}` } });
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

async function call(body: unknown, options: EvaluateEndpointOptions, init?: Parameters<typeof request>[1]) {
  const { response, done } = capture();
  await evaluateEndpoint(request(body, init), response, options);
  return done;
}

/**
 * A provider that answers by which call it is: the same fake stands in for all three steps, so
 * a multi-turn case needs no script whose length depends on the number of turns.
 */
function provider(replies: { interpret: string[]; rank: string; critique: string }) {
  const calls: CompletionOptions[] = [];
  const interpretations = [...replies.interpret];
  return {
    calls,
    model: "test-model",
    complete: async (options: CompletionOptions) => {
      calls.push(options);
      if (options.system === INTERPRET_SYSTEM) {
        const next = interpretations.shift();
        if (next === undefined) throw new Error("no scripted interpretation left");
        return next;
      }
      if (options.system === RANK_SYSTEM) return replies.rank;
      if (options.system === CRITIC_SYSTEM) return replies.critique;
      throw new Error("unexpected system prompt");
    },
  };
}

const SHORTLIST: CatalogueTitle[] = [
  title(11, { title: "Night Terror", year: 1981, genres: ["Horror"], runtimeMinutes: 94 }),
  title(12, { title: "Dim Hall", year: 1994, genres: ["Horror"], runtimeMinutes: 101 }),
  title(13, { title: "Cold Signal", year: 2007, genres: ["Horror"], runtimeMinutes: 88 }),
  title(14, { title: "Pale Orchard", year: 2016, genres: ["Horror"], runtimeMinutes: 112 }),
];

/** A catalogue that answers every read with the same four horror titles, and records the reads. */
function fakeCatalogue() {
  const reads: Parameters<CatalogueReader>[0][] = [];
  const readCatalogue: CatalogueReader = async (read) => {
    reads.push(read);
    return {
      status: "ok",
      source: "tmdb",
      items: SHORTLIST,
      page: 1,
      pageSize: CATALOGUE_LIMITS.shortlistSize,
      total: 42,
      hasMore: false,
    };
  };
  return { readCatalogue, reads };
}

const SCARY = JSON.stringify({
  dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "scary", explicit: true }],
  subject: null,
  setConstraints: [],
  removeConstraints: [],
  acknowledgement: "Something scary, then.",
  question: null,
});

const SHORTER = JSON.stringify({
  dimensions: [],
  subject: null,
  setConstraints: [{ slot: "runtime.max", minutes: 120, quote: "under two hours" }],
  removeConstraints: [],
  acknowledgement: "Under two hours it is.",
  question: null,
});

const RANKED = JSON.stringify({
  ranking: [
    { candidateId: "cat:13", utility: 0.9 },
    { candidateId: "cat:11", utility: 0.7 },
    { candidateId: "cat:12", utility: 0.5 },
    { candidateId: "cat:14", utility: 0.3 },
  ],
  reasons: [
    { candidateId: "cat:13", reason: "the closest to what was asked for" },
    { candidateId: "cat:11", reason: "the same idea, played harder" },
    { candidateId: "cat:12", reason: "quieter, and slower to start" },
  ],
});

function note(candidateId: string, why: string) {
  return {
    candidateId,
    why,
    watching: "It holds a single long corridor shot until the silence itself starts to feel like a threat.",
    reservation: "The ending explains far more than it needed to, and some of the dread leaks out with it.",
  };
}

const CRITIQUED = JSON.stringify({
  critiques: [
    note("cat:13", "A ghost story told almost entirely through sound design, which is rarer than it sounds."),
    note("cat:11", "Practical effects that have aged into something stranger and less readable than CGI ever manages."),
    note("cat:12", "A haunting built out of domestic routine, where the scares arrive on a timetable."),
  ],
});

function options(overrides: Partial<EvaluateEndpointOptions> = {}): EvaluateEndpointOptions {
  return {
    env,
    provider: provider({ interpret: [SCARY, SHORTER], rank: RANKED, critique: CRITIQUED }),
    readCatalogue: fakeCatalogue().readCatalogue,
    ...overrides,
  };
}

describe("POST /api/evaluate", () => {
  it("refuses a request with no token, a wrong token, or a token in the wrong scheme", async () => {
    for (const authorization of [null, "Bearer wrong-token", `Basic ${TOKEN}`, TOKEN]) {
      const result = await call({ input: "something scary" }, options(), { authorization });
      assert.equal(result.statusCode, 401, `authorization ${JSON.stringify(authorization)}`);
      assert.equal(result.body.code, "UNAUTHENTICATED");
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false, "the refusal never echoes the token");
    }
  });

  it("says evaluation is switched off rather than opening up when no token is configured", async () => {
    const result = await call({ input: "something scary" }, options({ env: {} as NodeJS.ProcessEnv }));
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, "EVAL_NOT_CONFIGURED");
  });

  it("refuses a malformed body without calling the provider", async () => {
    const scripted = provider({ interpret: [SCARY], rank: RANKED, critique: CRITIQUED });
    for (const body of [{}, { input: "" }, { input: "hello", extra: 1 }, { input: "hello", history: "no" }]) {
      const result = await call(body, options({ provider: scripted }));
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(result.body.code, "INVALID_REQUEST");
    }
    assert.equal(scripted.calls.length, 0);
  });

  it("runs the whole funnel for one message and answers with what the viewer would have seen", async () => {
    const catalogue = fakeCatalogue();
    const result = await call({ input: "something scary" }, options({ readCatalogue: catalogue.readCatalogue }));

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, "ok");
    assert.equal(result.body.acknowledgement, "Something scary, then.");
    assert.equal(result.body.question, null);
    assert.equal(result.body.subject, null);
    assert.equal(result.body.total, 42);
    assert.deepEqual(catalogue.reads[0].filters, { includeGenres: ["horror"] });

    const titles = result.body.titles as { id: string; title: string; year: number | null; genres: string[] }[];
    assert.deepEqual(
      titles.map(({ id, title: name, year, genres }) => [id, name, year, genres]),
      [
        ["cat:13", "Cold Signal", 2007, ["Horror"]],
        ["cat:11", "Night Terror", 1981, ["Horror"]],
        ["cat:12", "Dim Hall", 1994, ["Horror"]],
      ],
      "the model's order, the top picks only",
    );
  });

  it("replays the history through the same engine, so a later message refines the earlier one", async () => {
    const catalogue = fakeCatalogue();
    const result = await call(
      { input: "under two hours", history: ["something scary"] },
      options({ readCatalogue: catalogue.readCatalogue }),
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.acknowledgement, "Under two hours it is.", "the last turn's line, not the first's");
    assert.deepEqual(
      catalogue.reads[0].filters,
      { maxRuntime: 119, includeGenres: ["horror"] },
      "both turns are in the read: the genre from the history and the length from the message",
    );

    const titles = result.body.titles as { title: string }[];
    assert.deepEqual(
      titles.map(({ title: name }) => name),
      ["Cold Signal", "Night Terror", "Dim Hall"],
      "the film over two hours is not eligible and is never picked",
    );
    assert.equal(
      JSON.stringify(result.body).includes("Pale Orchard"),
      false,
      "and the title the constraint rules out is nowhere in the answer",
    );
  });

  it("puts the titles and the critic's reasons in the text an evaluator grades", async () => {
    const result = await call({ input: "something scary" }, options());
    const output = result.body.output as string;

    assert.match(output, /^Something scary, then\./);
    for (const name of ["Cold Signal", "Night Terror", "Dim Hall"]) {
      assert.ok(output.includes(name), `output names ${name}`);
    }
    assert.ok(output.includes("A ghost story told almost entirely through sound design"), "the critic's reason for the first pick");
    assert.ok(output.includes("Practical effects that have aged into something stranger"), "and for the second");
    assert.ok(output.includes("It holds a single long corridor shot"), "what watching it is like");
    assert.ok(output.includes("The ending explains far more than it needed to"), "and the reservation");

    const critiques = result.body.critiques as Record<string, { why: string }>;
    assert.deepEqual(Object.keys(critiques).sort(), ["cat:11", "cat:12", "cat:13"]);
  });

  it("keeps the ranking's reasons when the critic refuses, instead of dropping the row", async () => {
    const result = await call(
      { input: "something scary" },
      options({ provider: provider({ interpret: [SCARY], rank: RANKED, critique: "not json" }) }),
    );

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.critiques, {});
    const output = result.body.output as string;
    assert.ok(output.includes("the closest to what was asked for"), "the ranking's reason stands in");
    assert.ok(output.includes("Cold Signal"));
  });

  it("falls back to the deterministic scorer when the assistant cannot rank", async () => {
    const result = await call(
      { input: "something scary" },
      options({ provider: provider({ interpret: [SCARY], rank: "not json", critique: CRITIQUED }) }),
    );

    assert.equal(result.statusCode, 200);
    const titles = result.body.titles as { title: string }[];
    assert.equal(titles.length, 3, "a row is still shown");
  });

  it("reports an assistant it cannot reach rather than inventing a shortlist", async () => {
    const result = await call({ input: "something scary" }, options({ provider: null }));
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, "ASSISTANT_DISABLED");
    assert.equal(result.body.status, "error");
  });

  it("answers only POST", async () => {
    const result = await call({ input: "something scary" }, options(), { method: "GET" });
    assert.equal(result.statusCode, 405);
    assert.equal(result.body.code, "METHOD_NOT_ALLOWED");
  });
});
