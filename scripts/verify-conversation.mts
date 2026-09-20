// Live check of Discover's conversation: the real endpoints, the real provider, the real shortlist.
//
// Signs in anonymously with the public anon key, then drives the two conversational handlers
// in-process with that session's token, exactly as the browser calls them, and reads each
// shortlist through the catalogue adapter:
//
//   pnpm verify:conversation
//
// It needs REVERIE_LIVE_ENABLED=true, NEBIUS_API_KEY and the Supabase variables. It prints what
// the assistant said, match counts and the top titles, never credentials or payloads.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import discoverRank from "../api/discover/rank";
import discoverTurn from "../api/discover/turn";
import { fetchCatalogue } from "../api/_lib/supabase-catalogue";
import { toCandidates } from "../src/catalogue/candidates";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { orderByAssistant } from "../src/catalogue/scorer";
import { toShortlistRead } from "../src/catalogue/shortlistFilters";
import { CATALOGUE_LIMITS, type CatalogueOk, type CatalogueTitle } from "../src/catalogue/contract";
import { CONVERSATION_LIMITS, rankResponseSchema, turnResponseSchema } from "../src/conversation/contract";
import type { PreferenceState } from "../src/preferences/schema";
import { applyTurn, newState } from "../src/preferences/state";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY.");
  process.exit(2);
}
const client = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: session, error: signInError } = await client.auth.signInAnonymously();
if (signInError || !session.session) throw new Error(`Anonymous sign-in failed: ${signInError?.message}`);
const accessToken = session.session.access_token;

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

async function post(handler: Handler, path: string, body: unknown): Promise<unknown> {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.method = "POST";
  stream.url = path;
  stream.headers = { host: "verify.local", authorization: `Bearer ${accessToken}` };
  Object.defineProperty(stream, "socket", { value: { remoteAddress: "127.0.0.1" } });
  return new Promise((resolve) => {
    const response = {
      statusCode: 200,
      writableEnded: false,
      setHeader() {},
      on() {},
      end: (chunk: string) => resolve(JSON.parse(chunk)),
    } as unknown as ServerResponse;
    void handler(stream, response);
  });
}

let state: PreferenceState = newState(`verify-${Date.now()}`);
let previousQuestion: string | null = null;

async function say(message: string) {
  const started = Date.now();
  const reply = turnResponseSchema.parse(await post(discoverTurn, "/api/discover/turn", { message, state, previousQuestion }));
  assert.equal(reply.status, "ok", `the assistant answered "${message}": ${JSON.stringify(reply)}`);
  if (reply.status !== "ok") throw new Error("unreachable");
  state = applyTurn(state, reply.turn, CATALOGUE_CONFIGURATION);
  previousQuestion = reply.question;
  console.log(`\n> ${message}   (${Date.now() - started} ms, ${reply.model})`);
  console.log(`  assistant: ${reply.acknowledgement}${reply.question ? `\n  asks: ${reply.question}` : ""}`);
  return reply;
}

/** One catalogue page for exactly these words and filters, exactly as the browser reads it. */
async function page(query: string, filters: Record<string, unknown>): Promise<CatalogueOk> {
  const result = await fetchCatalogue({ query, page: 1, pageSize: CATALOGUE_LIMITS.shortlistSize, ...filters }, accessToken);
  assert.equal(result.status, "ok", `the shortlist loaded: ${JSON.stringify(result)}`);
  if (result.status !== "ok") throw new Error("unreachable");
  return result;
}

async function shortlist(): Promise<CatalogueOk> {
  const { subject, filters } = toShortlistRead(state);
  const result = await page(subject, filters);
  const words = subject === "" ? "" : ` about ${JSON.stringify(subject)}`;
  console.log(`  filters ${JSON.stringify(filters)}${words} -> ${result.total} titles match`);
  return result;
}

const titles = (found: CatalogueOk, count = 5) => found.items.slice(0, count).map(({ title, year }) => `${title} (${year ?? "?"})`);

async function rank(items: readonly CatalogueTitle[]) {
  const candidates = items.map((item) => ({
    id: item.id,
    title: item.title,
    year: item.year,
    genres: item.genres,
    runtimeMinutes: item.runtimeMinutes,
    originalLanguage: item.originalLanguage,
    rating: item.rating,
    synopsis: item.synopsis?.slice(0, CONVERSATION_LIMITS.rankSynopsisChars),
  }));
  const started = Date.now();
  const reply = rankResponseSchema.parse(await post(discoverRank, "/api/discover/rank", { state, candidates }));
  assert.equal(reply.status, "ok", `the assistant ranked the shortlist: ${JSON.stringify(reply)}`);
  if (reply.status !== "ok") throw new Error("unreachable");
  const { picks } = orderByAssistant(toCandidates(items), state, reply.stateVersion, reply.ranking);
  console.log(`  ranked by the assistant in ${Date.now() - started} ms:`);
  for (const pick of picks) {
    const reason = reply.reasons.find(({ candidateId }) => candidateId === pick.id)?.reason ?? "";
    console.log(`   - ${pick.title.title} (${pick.title.year ?? "?"}, ${pick.title.genres.join("/")}) ${reason}`);
  }
  return picks;
}

const light = await say("something light for a Friday night");
assert.ok(light.question, "a wide-open request earns one clarifying question");
const first = await shortlist();
assert.ok(first.items.length > 0, "and real titles at once");
await rank(first.items);

const answer = await say("A comedy, please");
assert.equal(answer.question, null, "an answer is not questioned again");
const second = await shortlist();
assert.ok(second.total < first.total, "answering the question narrows the result");
assert.ok(second.items.every(({ genres }) => genres.includes("Comedy")), "to comedies");
await rank(second.items);

const scared = await say("actually nothing scary");
assert.equal(scared.question, null);
const third = await shortlist();
assert.ok(third.items.every(({ genres }) => !genres.includes("Horror")), "nothing scary removes horror");
assert.ok(third.total <= second.total);
await rank(third.items);

state = newState(`verify-clear-${Date.now()}`);
previousQuestion = null;
const clear = await say("A scary film under two hours");
assert.equal(clear.question, null, "a clear request is answered, not questioned");
const scary = await shortlist();
assert.ok(scary.items.every(({ genres, runtimeMinutes }) => genres.includes("Horror") && (runtimeMinutes ?? 999) < 120));

/**
 * A request a genre-only funnel cannot answer: the viewer says what the film is about, and the
 * same state is read both ways — with the words the assistant heard, and with only the genres,
 * length and era they imply — so the difference between the two is on the record.
 */
async function about(message: string) {
  state = newState(`verify-about-${Date.now()}`);
  previousQuestion = null;
  await say(message);
  const { subject, filters } = toShortlistRead(state);
  assert.notEqual(subject, "", `"${message}": the assistant heard what the film is about`);
  console.log(`  what it is about: ${JSON.stringify(subject)}; filters ${JSON.stringify(filters)}`);

  const before = await page("", filters);
  const after = await page(subject, filters);
  console.log(`  before, by genre alone (${before.total} match): ${titles(before).join(", ")}`);
  console.log(`  after, with the words  (${after.total} match): ${titles(after).join(", ")}`);

  assert.ok(after.total > 0, `"${message}": the words found films, so nothing has to be widened`);
  assert.ok(after.total < before.total, `"${message}": the words narrow what the filters alone return`);
  assert.notDeepEqual(titles(after), titles(before), `"${message}": and return different films`);
  await rank(after.items);
  return { before, after };
}

await about("a film about a family with some pets");
await about("a heist that goes wrong");
await about("someone who loses their memory");

// Words nothing is about must not empty the screen: the filters alone still answer.
state = newState(`verify-nothing-${Date.now()}`);
previousQuestion = null;
await say("a comedy about zzqqxx nothingness");
const { subject: missing, filters: stillWanted } = toShortlistRead(state);
const found = await page(missing, stillWanted);
const fallback = await page("", stillWanted);
console.log(`  ${JSON.stringify(missing)} matched ${found.total}; the filters alone still match ${fallback.total}`);
assert.ok(fallback.total > 0, "a subject that matches nothing falls back to a real shortlist");

console.log("\nPASS conversation");
