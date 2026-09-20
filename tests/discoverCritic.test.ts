import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompletionOptions } from "../apps/server/providers/nebius";
import { ASSISTANT_ATTEMPTS, type Completion } from "../api/_lib/discover-assistant";
import { CRITIQUE_BUDGET, faultInCritique, isHollow, judgeCritiques, writeCritiques } from "../api/_lib/discover-critic";
import { CRITIC_SYSTEM } from "../api/_lib/discover-prompts";
import type { Critique, RankCandidate } from "../src/conversation/contract";
import { newState } from "../src/preferences/state";
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

function pick(id: number, overrides: Partial<RankCandidate> = {}): RankCandidate {
  const { availability: _availability, ...rest } = title(id, overrides as never);
  return { ...rest, ...overrides };
}

const PICKS = [
  pick(1, { title: "Laugh Riot", year: 1994, runtimeMinutes: 96, genres: ["Comedy"] }),
  pick(2, { title: "Paper Boats", year: 2003, runtimeMinutes: 108, genres: ["Family", "Comedy"] }),
];

/** A critique that breaks none of the rules, so a test can break exactly one. */
function good(candidateId: string, overrides: Partial<Critique> = {}): Critique {
  return {
    candidateId,
    why: "Farrelly-brothers slapstick played entirely straight, which is rarer and much harder than it looks.",
    watching: "It moves like a stage farce: doors, timing, a cast committing absolutely to material that could have died.",
    reservation: "The third act abandons the farce for sentiment, and the tonal change never quite earns itself.",
    ...overrides,
  };
}

function reply(...critiques: Critique[]) {
  return JSON.stringify({ critiques });
}

describe("faultInCritique", () => {
  it("passes a critique that names no other film, writes no digits and speaks for nobody", () => {
    assert.equal(faultInCritique(good("cat:1"), PICKS[0], ["Night Terror", "Late Train"]), null);
  });

  it("refuses one that names a film held back from it", () => {
    const named = good("cat:1", { watching: "It has the same shaggy energy as Late Train, and lands more of its jokes." });
    assert.match(faultInCritique(named, PICKS[0], ["Late Train"]) ?? "", /names "Late Train"/);
  });

  it("leaves a one-word title alone, because the word cannot be told from the film", () => {
    const prose = good("cat:1", { watching: "The pace never lets up; it moves." });
    assert.equal(faultInCritique(prose, PICKS[0], ["Up", "Heat", "Moves"]), null);
  });

  it("refuses a wrong year, a running time and an invented score alike, as strayed digits", () => {
    for (const part of [
      { why: "A 1998 comedy that still plays." },
      { watching: "At 132 minutes it outstays the joke a little." },
      { reservation: "Worth 7.5 at most, and the ending drops a point off even that." },
    ]) {
      const fault = faultInCritique(good("cat:1", part), PICKS[0], []);
      assert.match(fault ?? "", /writes the number/, JSON.stringify(part));
    }
  });

  it("allows the film's own year, and digits inside its own title", () => {
    assert.equal(faultInCritique(good("cat:1", { why: "The best thing anybody made in 1994." }), PICKS[0], []), null);
    const sequel = pick(3, { title: "Laugh Riot 2", year: 1997 });
    assert.equal(faultInCritique(good("cat:3", { why: "Laugh Riot 2 is the one that earns its reputation." }), sequel, []), null);
  });

  it("allows a score the row states, cited as the crowd's", () => {
    const rated = pick(4, { title: "Late Train", year: 2001, rating: "7.4" });
    assert.equal(faultInCritique(good("cat:4", { why: "The crowd puts it at 7.4, and that is about right." }), rated, []), null);
  });

  it("refuses a verdict borrowed from critics, audiences or a score site", () => {
    for (const phrase of [
      "Critics called it a classic.",
      "Audiences loved it on release.",
      "The consensus is generous.",
      "An acclaimed performance anchors it.",
      "It is widely regarded as the best of them.",
    ]) {
      assert.match(faultInCritique(good("cat:1", { why: phrase }), PICKS[0], []) ?? "", /speak for a crowd/, phrase);
    }
  });

  it("lets the critic say who might bounce off it, which is a verdict and not a borrowed one", () => {
    for (const phrase of [
      "Its theatricality will lose viewers who want their fantasy grounded.",
      "The slow burn asks for patience an audience expecting jokes may not have.",
    ]) {
      assert.equal(faultInCritique(good("cat:1", { reservation: phrase }), PICKS[0], []), null, phrase);
    }
  });

  it("refuses a critique that turns to face the viewer and sells", () => {
    for (const phrase of [
      "You’ll love every minute of it.",
      "It fits what you asked for exactly.",
      "You wanted something light, and here it is.",
      "Your evening is safe with it.",
      "A perfect choice for you.",
    ]) {
      assert.match(faultInCritique(good("cat:1", { why: phrase }), PICKS[0], []) ?? "", /not about what the viewer asked for/, phrase);
    }
  });

  it("leaves the impersonal second person of criticism alone, and ordinary words with it", () => {
    for (const phrase of [
      "A twist you do not see coming, and a last shot that refuses to explain it.",
      "The pacing sags if you are not already invested in the marriage at its centre.",
      "A young cast carries it, with a youthful looseness.",
    ]) {
      assert.equal(faultInCritique(good("cat:1", { why: phrase }), PICKS[0], []), null, phrase);
    }
  });
});

describe("isHollow", () => {
  it("rejects a reservation that reserves nothing", () => {
    for (const hollow of ["Nothing much against it.", "No real flaws here at all.", "It is hard to fault.", "None.", "Very little."]) {
      assert.equal(isHollow(hollow), true, hollow);
    }
  });

  it("keeps a reservation that names something", () => {
    assert.equal(isHollow("The middle hour sags badly once the mystery is spent."), false);
  });
});

describe("judgeCritiques", () => {
  it("accepts critiques for the films it was given", () => {
    const verdict = judgeCritiques(JSON.parse(reply(good("cat:1"), good("cat:2"))), PICKS, []);
    assert.ok("critiques" in verdict);
    assert.deepEqual(verdict.critiques.map(({ candidateId }) => candidateId), ["cat:1", "cat:2"]);
  });

  it("refuses the whole reply when it writes about a film that was not picked", () => {
    const verdict = judgeCritiques(JSON.parse(reply(good("cat:1"), good("cat:99"))), PICKS, []);
    assert.ok("fault" in verdict);
    assert.match(verdict.fault, /cat:99.*not one of the films/);
  });

  it("refuses a reply that writes about the same film twice, even when the first was dropped", () => {
    const verdict = judgeCritiques(JSON.parse(reply(good("cat:1", { reservation: "None." }), good("cat:1"))), PICKS, []);
    assert.ok("fault" in verdict);
    assert.match(verdict.fault, /twice/);
  });

  it("drops the pick whose reservation is hollow rather than refusing the reply", () => {
    const verdict = judgeCritiques(JSON.parse(reply(good("cat:1", { reservation: "Nothing against it." }), good("cat:2"))), PICKS, []);
    assert.ok("critiques" in verdict);
    assert.deepEqual(verdict.critiques.map(({ candidateId }) => candidateId), ["cat:2"]);
  });

  it("refuses an entry missing a part, because a recommendation needs all three", () => {
    const verdict = judgeCritiques({ critiques: [{ candidateId: "cat:1", why: "Good.", watching: "Fast." }] }, PICKS, []);
    assert.ok("fault" in verdict);
  });
});

describe("writeCritiques", () => {
  const state = newState("critic");

  it("sends only the picks, under the critique budget, and returns what it wrote", async () => {
    const { complete, calls } = scripted(reply(good("cat:1"), good("cat:2")));
    const result = await writeCritiques(complete, state, PICKS, ["Night Terror"]);
    assert.ok(result.ok);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.value.map(({ candidateId }) => candidateId), ["cat:1", "cat:2"]);
    assert.equal(calls[0].maxTokens, CRITIQUE_BUDGET.maxTokens);
    assert.equal(calls[0].temperature, CRITIQUE_BUDGET.temperature);
    assert.ok((calls[0].timeoutMs ?? Infinity) <= CRITIQUE_BUDGET.timeoutMs);
    assert.match(calls[0].user, /Laugh Riot/);
    assert.doesNotMatch(calls[0].user, /Night Terror/, "a title held back never reaches the model");
  });

  it("tells the critic exactly what was refused, and accepts the corrected reply", async () => {
    const strays = reply(good("cat:1", { why: "A 1998 comedy." }), good("cat:2"));
    const { complete, calls } = scripted(strays, reply(good("cat:1"), good("cat:2")));
    const result = await writeCritiques(complete, state, PICKS, []);
    assert.ok(result.ok);
    assert.equal(result.attempts, 2);
    assert.match(calls[1].user, /Correction required.*"1998"/s);
    assert.match(calls[1].user, /cat:1, cat:2/);
  });

  it("falls back after a second refusal rather than showing an unchecked critique", async () => {
    const named = reply(good("cat:1", { watching: "Sharper than Night Terror ever managed." }));
    const { complete, calls } = scripted(named, named);
    const result = await writeCritiques(complete, state, PICKS, ["Night Terror"]);
    assert.equal(result.ok, false);
    assert.equal(calls.length, ASSISTANT_ATTEMPTS);
    if (!result.ok) assert.equal(result.unavailable.code, "ASSISTANT_UNUSABLE");
  });

  it("asks again when every reservation was hollow, and falls back if they stay hollow", async () => {
    const hollow = reply(good("cat:1", { reservation: "Nothing against it." }), good("cat:2", { reservation: "No real flaws." }));
    const { complete, calls } = scripted(hollow, hollow);
    const result = await writeCritiques(complete, state, PICKS, []);
    assert.equal(result.ok, false);
    assert.match(calls[1].user, /every reservation was missing or said nothing/);
  });

  it("never asks the critic for anything the preference engine could read back", () => {
    assert.doesNotMatch(CRITIC_SYSTEM, /quote|dimension|constraint|setConstraints|acknowledgement|question/i);
    assert.match(CRITIC_SYSTEM, /"critiques"/);
  });
});
