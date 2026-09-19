import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NebiusError, type CompletionOptions } from "../apps/server/providers/nebius";
import {
  ASSISTANT_ATTEMPTS,
  INTERPRET_BUDGET,
  RANK_BUDGET,
  eligibleRankCandidates,
  interpretMessage,
  rankCandidates,
  type Completion,
} from "../api/_lib/discover-assistant";
import { REFINEMENTS, refinementTurn } from "../src/catalogue/refinements";
import { CATALOGUE_CONFIGURATION } from "../src/catalogue/domain";
import { toCandidates } from "../src/catalogue/candidates";
import { orderByAssistant } from "../src/catalogue/scorer";
import { PreferenceError } from "../src/preferences/errors";
import { applyTurn, newState, rejectCandidate } from "../src/preferences/state";
import type { PreferenceState } from "../src/preferences/schema";
import { title } from "./catalogueFixtures";

/** A completion that replays `replies` in order and records every call it receives. */
function scripted(...replies: (string | Error)[]) {
  const calls: CompletionOptions[] = [];
  const complete: Completion = async (options) => {
    calls.push(options);
    const next = replies.shift();
    if (next === undefined) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { complete, calls };
}

const LIGHT = JSON.stringify({
  dimensions: [
    { dimension: "genre.comedy", value: 1, confidence: 0.6, quote: "light", explicit: false },
    { dimension: "genre.family", value: 1, confidence: 0.5, quote: "light", explicit: false },
  ],
  setConstraints: [],
  removeConstraints: [],
  acknowledgement: "Something easy-going for the end of the week.",
  question: "Would you rather laugh, or keep it under 90 minutes?",
});

const INVENTED = JSON.stringify({
  dimensions: [{ dimension: "genre.horror", value: 1, confidence: 0.9, quote: "terrifying", explicit: true }],
  setConstraints: [],
  removeConstraints: [],
  acknowledgement: "Something terrifying.",
  question: null,
});

function chip(state: PreferenceState, id: string): PreferenceState {
  const refinement = REFINEMENTS.find((candidate) => candidate.id === id);
  assert.ok(refinement);
  return applyTurn(state, refinementTurn(refinement, state), CATALOGUE_CONFIGURATION);
}

describe("interpretMessage", () => {
  it("returns a grounded turn, the acknowledgement and the question, within the token and time budget", async () => {
    const { complete, calls } = scripted(LIGHT);
    const result = await interpretMessage(complete, newState("talk"), "something light for a Friday night", null);
    assert.ok(result.ok);
    assert.equal(result.attempts, 1);
    assert.equal(result.value.question, "Would you rather laugh, or keep it under 90 minutes?");
    assert.deepEqual(Object.keys(result.value.turn.dimensions), ["genre.comedy", "genre.family"]);
    assert.equal(calls[0].maxTokens, INTERPRET_BUDGET.maxTokens);
    assert.ok((calls[0].timeoutMs ?? Infinity) <= INTERPRET_BUDGET.timeoutMs);
  });

  it("never sends the model catalogue data, only the viewer's words and the state", async () => {
    const { complete, calls } = scripted(LIGHT);
    await interpretMessage(complete, chip(newState("talk"), "want-horror"), "something light", "Any era in mind?");
    assert.match(calls[0].user, /"something light"/);
    assert.match(calls[0].user, /Any era in mind\?/);
    assert.doesNotMatch(calls[0].user + calls[0].system, /cat:\d/);
  });

  it("refuses a decision whose quote is not in the message, retries once with the reason, then falls back", async () => {
    const { complete, calls } = scripted(INVENTED, INVENTED);
    const result = await interpretMessage(complete, newState("talk"), "Something scary", null);
    assert.equal(result.ok, false);
    assert.equal(calls.length, ASSISTANT_ATTEMPTS);
    assert.match(calls[1].user, /Correction required.*"terrifying"/s);
    if (!result.ok) assert.equal(result.unavailable.code, "ASSISTANT_UNGROUNDED");
  });

  it("accepts a corrected decision on the retry", async () => {
    const grounded = INVENTED.replace('"quote":"terrifying"', '"quote":"scary"');
    const { complete } = scripted(INVENTED, grounded);
    const result = await interpretMessage(complete, newState("talk"), "Something scary", null);
    assert.ok(result.ok);
    assert.equal(result.attempts, 2);
  });

  it("falls back when the reply is not JSON twice", async () => {
    const { complete, calls } = scripted("Sure! Here are some films:", "{ nope");
    const result = await interpretMessage(complete, newState("talk"), "something good", null);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    assert.match(calls[1].user, /not a single JSON object/);
    if (!result.ok) assert.equal(result.unavailable.code, "ASSISTANT_UNUSABLE");
  });

  it("does not retry a provider that did not answer, and says it timed out", async () => {
    const { complete, calls } = scripted(new NebiusError("The creative provider did not respond.", true, "no_response"));
    const result = await interpretMessage(complete, newState("talk"), "something good", null);
    assert.equal(calls.length, 1);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.unavailable.code, "ASSISTANT_TIMEOUT");
  });

  it("does not start a retry the deadline could not fit", async () => {
    let clock = 0;
    const complete: Completion = async () => {
      clock += INTERPRET_BUDGET.deadlineMs - 1_000;
      return INVENTED;
    };
    const result = await interpretMessage(complete, newState("talk"), "Something scary", null, () => clock);
    assert.equal(result.ok, false);
    assert.equal(clock, INTERPRET_BUDGET.deadlineMs - 1_000, "only one call was made");
  });
});

const shortlist = toCandidates([
  title(1, { title: "Laugh Riot", genres: ["Comedy"] }),
  title(2, { title: "Night Terror", genres: ["Horror"] }),
  title(3, { title: "Paper Boats", genres: ["Family", "Comedy"] }),
  title(4, { title: "Late Train", genres: ["Drama"] }),
]);

function ranking(ids: string[], reasons: { candidateId: string; reason: string }[] = []) {
  return JSON.stringify({
    ranking: ids.map((candidateId, index) => ({ candidateId, utility: 1 - index / 10 })),
    reasons,
  });
}

describe("rankCandidates", () => {
  const state = newState("rank");

  it("sends only the supplied candidates and returns the model's order with its top-three reasons", async () => {
    const { complete, calls } = scripted(
      ranking(["cat:3", "cat:1", "cat:4", "cat:2"], [
        { candidateId: "cat:3", reason: "Gentle and funny." },
        { candidateId: "cat:4", reason: "Quiet." },
        { candidateId: "cat:2", reason: "Not a top pick, so dropped." },
      ]),
    );
    const result = await rankCandidates(complete, state, shortlist);
    assert.ok(result.ok);
    assert.deepEqual(result.value.ranking.map(({ candidateId }) => candidateId), ["cat:3", "cat:1", "cat:4", "cat:2"]);
    assert.deepEqual(result.value.reasons.map(({ candidateId }) => candidateId), ["cat:3", "cat:4"]);
    assert.equal(calls[0].maxTokens, RANK_BUDGET.maxTokens);
    for (const id of ["cat:1", "cat:2", "cat:3", "cat:4"]) assert.match(calls[0].user, new RegExp(`${id} \\|`));
  });

  it("refuses a ranking that names an id it was not given, and falls back after the retry", async () => {
    const { complete, calls } = scripted(ranking(["cat:3", "cat:999", "cat:1"]), ranking(["cat:3", "cat:999", "cat:1"]));
    const result = await rankCandidates(complete, state, shortlist);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    assert.match(calls[1].user, /cat:999, which was not supplied/);
    if (!result.ok) assert.equal(result.unavailable.code, "ASSISTANT_UNGROUNDED");
  });

  it("refuses a ranking that names a title the viewer turned down", async () => {
    const rejected = rejectCandidate(state, "cat:2");
    const eligible = shortlist.filter(({ id }) => id !== "cat:2");
    const { complete } = scripted(ranking(["cat:2", "cat:1", "cat:3"]), ranking(["cat:1", "cat:3", "cat:4"]));
    const result = await rankCandidates(complete, rejected, eligible);
    assert.ok(result.ok, "the retry named only supplied, eligible titles");
    assert.equal(result.attempts, 2);
  });

  it("refuses a ranking too short to fill the top picks", async () => {
    const { complete } = scripted(ranking(["cat:1"]), ranking(["cat:1"]));
    const result = await rankCandidates(complete, state, shortlist);
    assert.equal(result.ok, false);
  });

  it("drops candidates the state rules out before the model sees them", () => {
    const refused = chip(newState("rank"), "refuse-horror");
    const eligible = eligibleRankCandidates(
      [title(1, { genres: ["Comedy"] }), title(2, { genres: ["Horror"] })].map(({ availability: _, ...rest }) => rest),
      refused,
    );
    assert.deepEqual(eligible.map(({ id }) => id), ["cat:1"]);
  });
});

describe("orderByAssistant", () => {
  const state = newState("order");

  it("orders by the model's utility alone, with no position term", () => {
    const { picks, ordered } = orderByAssistant(shortlist, state, state.stateVersion, [
      { candidateId: "cat:4", utility: 0.9 },
      { candidateId: "cat:1", utility: 0.5 },
      { candidateId: "cat:3", utility: 0.5 },
    ]);
    assert.deepEqual(picks.map(({ id }) => id), ["cat:4", "cat:1", "cat:3"]);
    assert.deepEqual(ordered.map(({ id }) => id), ["cat:4", "cat:1", "cat:3", "cat:2"], "an unranked title follows, never picked");
  });

  it("refuses a ranking naming an unknown id instead of showing it", () => {
    assert.throws(
      () => orderByAssistant(shortlist, state, state.stateVersion, [{ candidateId: "cat:77", utility: 1 }]),
      (error: unknown) => error instanceof PreferenceError && error.code === "unknown_candidate",
    );
  });

  it("refuses a ranking made against an older state", () => {
    const later = rejectCandidate(state, "cat:2");
    assert.throws(
      () => orderByAssistant(shortlist, later, state.stateVersion, [{ candidateId: "cat:1", utility: 1 }]),
      (error: unknown) => error instanceof PreferenceError && error.code === "stale_ranking",
    );
  });
});

describe("a viewer who has gone away", () => {
  it("stops the retry once the request is aborted, so nothing more is paid for", async () => {
    const controller = new AbortController();
    const { complete, calls } = scripted(INVENTED, INVENTED);
    const aborting: Completion = async (options) => {
      const reply = await complete(options);
      controller.abort();
      return reply;
    };
    const result = await interpretMessage(aborting, newState("talk"), "Something scary", null, Date.now, controller.signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal, controller.signal, "the provider call carries the abort signal");
    assert.equal(result.ok, false);
  });
});
