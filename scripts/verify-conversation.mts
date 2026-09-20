// Live check of Discover's conversation: the real endpoints, the real provider, the real shortlist.
//
// Signs in anonymously with the public anon key, then drives the two conversational handlers
// in-process with that session's token, exactly as the browser calls them, and reads each
// shortlist through the catalogue adapter:
//
//   pnpm verify:conversation
//
// It needs REVERIE_LIVE_ENABLED=true, NEBIUS_API_KEY and the Supabase variables. It prints what
// the assistant said, match counts, the top titles, and the critic's note on each pick — which is
// the point of printing anything: a note that restates the genres is a prompt that has not worked,
// and only reading them says so. Never credentials or payloads.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import discoverCritique from "../api/discover/critique";
import discoverRank from "../api/discover/rank";
import discoverTurn from "../api/discover/turn";
import { fetchCatalogue } from "../api/_lib/supabase-catalogue";
import { toCandidates } from "../src/catalogue/candidates";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { orderByAssistant } from "../src/catalogue/scorer";
import { toShortlistFilters } from "../src/catalogue/shortlistFilters";
import { CATALOGUE_LIMITS, type CatalogueOk, type CatalogueTitle } from "../src/catalogue/contract";
import { CONVERSATION_LIMITS, critiqueResponseSchema, rankResponseSchema, turnResponseSchema } from "../src/conversation/contract";
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

async function shortlist(): Promise<CatalogueOk> {
  const filters = toShortlistFilters(state);
  const result = await fetchCatalogue({ query: "", page: 1, pageSize: CATALOGUE_LIMITS.shortlistSize, ...filters }, accessToken);
  assert.equal(result.status, "ok", `the shortlist loaded: ${JSON.stringify(result)}`);
  if (result.status !== "ok") throw new Error("unreachable");
  console.log(`  filters ${JSON.stringify(filters)} -> ${result.total} titles match`);
  return result;
}

function asCandidate(item: CatalogueTitle) {
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    genres: item.genres,
    runtimeMinutes: item.runtimeMinutes,
    originalLanguage: item.originalLanguage,
    rating: item.rating,
    synopsis: item.synopsis?.slice(0, CONVERSATION_LIMITS.rankSynopsisChars),
  };
}

/** Wraps a note to the width of a terminal, indented under the film it is about. */
function wrap(label: string, text: string, width = 96): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((part, index) => `       ${index === 0 ? label : " ".repeat(label.length)}${part}`).join("\n");
}

async function rank(items: readonly CatalogueTitle[]) {
  const started = Date.now();
  const reply = rankResponseSchema.parse(await post(discoverRank, "/api/discover/rank", { state, candidates: items.map(asCandidate) }));
  assert.equal(reply.status, "ok", `the assistant ranked the shortlist: ${JSON.stringify(reply)}`);
  if (reply.status !== "ok") throw new Error("unreachable");
  const { picks } = orderByAssistant(toCandidates(items), state, reply.stateVersion, reply.ranking);
  console.log(`  ranked by the assistant in ${Date.now() - started} ms:`);
  for (const pick of picks) {
    const reason = reply.reasons.find(({ candidateId }) => candidateId === pick.id)?.reason ?? "";
    console.log(`   - ${pick.title.title} (${pick.title.year ?? "?"}, ${pick.title.genres.join("/")}) ${reason}`);
  }
  await critique(items, picks);
  return picks;
}

/**
 * The critic over those picks, printed in full. A refusal is printed too, and is not a failure of
 * this script: the row keeps the ranking's reasons, which is the whole point of the fallback.
 */
async function critique(items: readonly CatalogueTitle[], picks: readonly { id: string; title: CatalogueTitle }[]) {
  const chosen = picks.slice(0, CONVERSATION_LIMITS.maxCritiquePicks).map(({ title: film }) => film);
  if (chosen.length === 0) return;
  const shown = new Set(chosen.map(({ id }) => id));
  const withheld = items.filter(({ id }) => !shown.has(id)).map(({ title: name }) => name);
  const started = Date.now();
  const reply = critiqueResponseSchema.parse(
    await post(discoverCritique, "/api/discover/critique", { state, picks: chosen.map(asCandidate), withheld }),
  );
  if (reply.status !== "ok") {
    console.log(`  the critic did not write (${reply.status}: ${"code" in reply ? reply.code : ""}), so the reasons above stand`);
    return;
  }
  console.log(`  the critic, in ${Date.now() - started} ms:`);
  for (const film of chosen) {
    const note = reply.critiques.find(({ candidateId }) => candidateId === film.id);
    console.log(`   - ${film.title}`);
    if (!note) {
      console.log("       (no note: it found nothing honest to say against this one)");
      continue;
    }
    console.log(wrap("why:      ", note.why));
    console.log(wrap("watching: ", note.watching));
    console.log(wrap("but:      ", note.reservation));
  }
  for (const note of reply.critiques) {
    assert.ok(shown.has(note.candidateId), "the critic wrote only about the films it was given");
  }
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

// The critic again, over horror rather than the comedies above: a note that reads the same
// whatever the shortlist is would be a note about nothing.
await rank(scary.items);

console.log("\nPASS conversation");
