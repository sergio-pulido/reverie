import assert from "node:assert/strict";
import { test } from "node:test";
import { EscapeRooms, chooseWinner, type Proposal } from "../apps/server/escapeSessions";
import { InMemoryEscapeMediaStore } from "../apps/server/escapeMedia";
import { SpendAccount } from "../apps/server/spendLedger";
import { findSegmentModel } from "../apps/server/providers/falSegmentModels";
import type { FalSegmentConfig } from "../apps/server/providers/falSegments";
import { fakeMp4 } from "./fakeMp4";

/**
 * The turn, the spending and the loop. The rules themselves are tested in
 * tests/escapeRules.test.ts; nothing here decides what happened.
 */

const FAL: FalSegmentConfig = {
  apiKey: "test-key",
  model: findSegmentModel("minimax/h3-max/text-to-video")!,
};

/** Answers every fal call, and records the prompts and durations asked for. */
function fakeFal(clipSeconds = 15.104) {
  const submitted: { prompt: string; duration: number }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/text-to-video")) {
      const body = JSON.parse(String(init?.body));
      submitted.push({ prompt: body.prompt, duration: body.duration });
      return new Response(JSON.stringify({ request_id: `req-${submitted.length}` }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/requests/")) {
      return new Response(JSON.stringify({ video: { url: "https://v3b.fal.media/clip.mp4" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array(fakeMp4(clipSeconds)), {
      headers: { "content-type": "video/mp4" },
    });
  }) as typeof fetch;
  return { submitted, restore: () => { globalThis.fetch = original; } };
}

function build(options: { account?: SpendAccount; fal?: FalSegmentConfig | null } = {}) {
  const media = new InMemoryEscapeMediaStore();
  const account = options.account ?? new SpendAccount(100);
  const rooms = new EscapeRooms({
    media,
    account,
    fal: options.fal !== undefined ? options.fal : FAL,
    nebius: null,
    limits: { usdPerSecond: 0.08, loopSeconds: 5, maxConcurrentGenerations: 2 },
    sleep: async () => {},
  });
  return { rooms, media, account };
}

test("opening a room starts its first location's loop and nothing else", async () => {
  const fal = fakeFal(5.184);
  try {
    const { rooms } = build();
    assert.notEqual(typeof rooms.open("jam-1", "night-audit"), "string");
    await rooms.idle();
    const snapshot = rooms.snapshot("jam-1", "viewer")!;
    assert.equal(snapshot.loop.status, "ready");
    assert.equal(snapshot.loop.seconds, 5.184, "the loop's measured length, not the one asked for");
    assert.match(snapshot.loop.src ?? "", /^\/api\/jams\/jam-1\/escape-room\/segments\//);
    assert.equal(snapshot.beats.length, 0);
    assert.equal(fal.submitted.length, 1, "one loop, no beat");
    assert.equal(fal.submitted[0].duration, 5);
    assert.match(fal.submitted[0].prompt, /reading room/i);
  } finally {
    fal.restore();
  }
});

test("an unknown scenario and a second room for one jam are both refused", () => {
  const { rooms } = build({ fal: null });
  assert.equal(rooms.open("jam-1", "no-such-room"), "unknown_scenario");
  assert.notEqual(typeof rooms.open("jam-1", "cold-sill"), "string");
  assert.equal(rooms.open("jam-1", "cold-sill"), "already_open");
});

test("the winning proposal is resolved and filmed; the losers are discarded", async () => {
  const fal = fakeFal();
  try {
    const { rooms } = build();
    rooms.open("jam-2", "night-audit");
    await rooms.idle();
    const win = rooms.propose("jam-2", { authorId: "a", authorName: "Ada", body: "lift the counter hatch" });
    const lose = rooms.propose("jam-2", { authorId: "b", authorName: "Bo", body: "open the fuse box" });
    assert.ok(typeof win !== "string" && typeof lose !== "string");
    rooms.vote("jam-2", "a", win.id);
    rooms.vote("jam-2", "c", win.id);
    rooms.vote("jam-2", "b", lose.id);

    const beat = rooms.settle("jam-2");
    assert.ok(typeof beat !== "string");
    assert.equal(beat.outcome, "advanced");
    // Said before the narrator is even asked: a snapshot taken during those
    // seconds must not tell the room a beat about to be filmed was not.
    assert.equal(
      rooms.snapshot("jam-2", "a")!.beats.at(-1)!.media.status,
      "generating",
    );
    assert.equal(beat.proposal?.authorName, "Ada");
    assert.equal(beat.narrationSource, "scenario", "no narrator configured, so the author speaks");

    const after = rooms.snapshot("jam-2", "a")!;
    assert.equal(after.turn.index, 2);
    assert.deepEqual([...after.turn.proposals], [], "losing proposals are discarded, not queued");
    assert.equal(after.turn.yourVote, null);
    assert.ok(after.progress.found.some((thing) => thing.id === "torch"), "the torch was found");

    await rooms.idle();
    const filmed = rooms.snapshot("jam-2", "a")!.beats.at(-1)!;
    assert.equal(filmed.media.status, "ready");
    assert.equal(filmed.media.seconds, 15.104);
    assert.equal(fal.submitted.at(-1)?.duration, 15);
  } finally {
    fal.restore();
  }
});

test("a proposal the rules refuse becomes a beat, costs nothing, and says why", async () => {
  const fal = fakeFal();
  try {
    const { rooms, account } = build();
    rooms.open("jam-3", "night-audit");
    await rooms.idle();
    const spentOnTheLoop = account.committedUsd;

    const proposal = rooms.propose("jam-3", { authorId: "a", authorName: "Ada", body: "push open the stack door" });
    assert.ok(typeof proposal !== "string");
    const beat = rooms.settle("jam-3");
    assert.ok(typeof beat !== "string");
    assert.equal(beat.outcome, "failed");
    assert.equal(beat.narration, "The magnetic lock is still holding the door shut.");
    await rooms.idle();
    assert.equal(account.committedUsd, spentOnTheLoop, "a refusal is not filmed");
    assert.equal(rooms.snapshot("jam-3", "a")!.beats.at(-1)!.media.status, "absent");
  } finally {
    fal.restore();
  }
});

test("moving to a new location generates that location's loop, once", async () => {
  const fal = fakeFal();
  try {
    const { rooms } = build();
    rooms.open("jam-4", "night-audit");
    await rooms.idle();
    for (const body of [
      "open the counter hatch", "take the torch", "open the fuse box",
      "throw the breakers", "switch on the torch", "go through the stack door",
    ]) {
      rooms.propose("jam-4", { authorId: "a", authorName: "Ada", body });
      rooms.settle("jam-4");
      await rooms.idle();
    }
    const snapshot = rooms.snapshot("jam-4", "a")!;
    assert.equal(snapshot.location.id, "stacks");
    assert.equal(snapshot.loop.status, "ready");
    const loops = fal.submitted.filter((job) => job.duration === 5);
    assert.equal(loops.length, 2, "one loop for the reading room, one for the stacks");
  } finally {
    fal.restore();
  }
});

test("reaching the goal ends the session in the author's words", async () => {
  const fal = fakeFal();
  try {
    const { rooms } = build();
    rooms.open("jam-5", "cold-sill");
    await rooms.idle();
    const run = [
      "take the spanner", "shut the flood valve", "undog the bulkhead",
      "go through the bulkhead", "open the sample locker", "take the sample case",
      "climb the ladder", "strike the bell hatch", "stow the case", "pull the ballast release",
    ];
    for (const body of run) {
      rooms.propose("jam-5", { authorId: "a", authorName: "Ada", body });
      const beat = rooms.settle("jam-5");
      assert.ok(typeof beat !== "string" && beat.outcome === "advanced", `"${body}" advances`);
      await rooms.idle();
    }
    const snapshot = rooms.snapshot("jam-5", "a")!;
    assert.equal(snapshot.ended?.reason, "goal");
    assert.match(snapshot.ended?.tell ?? "", /eleven days of seabed/);
    assert.equal(snapshot.progress.goalReached, true);
    assert.equal(rooms.propose("jam-5", { authorId: "a", authorName: "Ada", body: "again" }), "session_over");
    assert.equal(rooms.settle("jam-5"), "session_over");
  } finally {
    fal.restore();
  }
});

test("the spend ceiling stops the session, and nothing is sent to the provider", async () => {
  const fal = fakeFal();
  try {
    // Enough for one five-second loop ($0.40) and not for a beat ($1.20).
    const { rooms, account } = build({ account: new SpendAccount(0.8) });
    rooms.open("jam-6", "night-audit");
    await rooms.idle();
    assert.equal(account.committedUsd, 0.4);

    rooms.propose("jam-6", { authorId: "a", authorName: "Ada", body: "open the counter hatch" });
    rooms.settle("jam-6");
    await rooms.idle();

    const snapshot = rooms.snapshot("jam-6", "a")!;
    assert.equal(snapshot.beats.at(-1)!.media.status, "ceiling_reached");
    assert.equal(snapshot.ended?.reason, "spend_ceiling");
    assert.equal(fal.submitted.length, 1, "only the loop was ever submitted");
    assert.equal(snapshot.spend.remainingUsd, round(0.8 - 0.4));
  } finally {
    fal.restore();
  }
});

test("a server that cannot generate says so rather than implying a film", async () => {
  const { rooms } = build({ fal: null });
  rooms.open("jam-7", "the-understudy");
  await rooms.idle();
  const snapshot = rooms.snapshot("jam-7", "a")!;
  assert.equal(snapshot.loop.status, "not_configured");
  assert.equal(snapshot.loop.src, null);
  assert.match(snapshot.loop.message ?? "", /not configured to generate video/);
  assert.equal(snapshot.ended, null, "the room is still playable as text");
});

test("a provider failure leaves the loop running and tells the room plainly", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/text-to-video")) return new Response("{}", { status: 500 });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const { rooms, account } = build();
    rooms.open("jam-8", "night-audit");
    await rooms.idle();
    const snapshot = rooms.snapshot("jam-8", "a")!;
    assert.equal(snapshot.loop.status, "failed");
    assert.match(snapshot.loop.message ?? "", /keeps running on the loop/);
    assert.equal(account.committedUsd, 0, "a submit fal never accepted is refunded");
  } finally {
    globalThis.fetch = original;
  }
});

test("a segment the server has dropped says so instead of reading as ready", async () => {
  const fal = fakeFal();
  try {
    const media = new InMemoryEscapeMediaStore();
    const rooms = new EscapeRooms({
      media,
      account: new SpendAccount(100),
      fal: FAL,
      nebius: null,
      limits: { usdPerSecond: 0.08, loopSeconds: 5, maxConcurrentGenerations: 2 },
      sleep: async () => {},
    });
    rooms.open("jam-forget", "night-audit");
    await rooms.idle();
    const ready = rooms.snapshot("jam-forget", "a")!.loop;
    assert.equal(ready.status, "ready");

    // The store is bounded and shared by every room; the oldest segment goes
    // when a newer one needs the space. The session must hear about it.
    const mediaId = ready.src!.split("/").at(-1)!;
    media.onEvicted?.("jam-forget", mediaId);

    const after = rooms.snapshot("jam-forget", "a")!.loop;
    assert.equal(after.status, "forgotten");
    assert.equal(after.src, null, "and stops offering a URL that would 404");
    assert.match(after.message ?? "", /most recent shots/);
  } finally {
    fal.restore();
  }
});

test("a session that has ended buys nothing else", async () => {
  const fal = fakeFal();
  try {
    // Enough for the opening loop ($0.40) and a second one, but not a beat.
    const { rooms, account } = build({ account: new SpendAccount(0.9) });
    rooms.open("jam-stop", "night-audit");
    await rooms.idle();
    assert.equal(account.committedUsd, 0.4);

    // This action moves to a new location, so a naive implementation would
    // buy that location's loop after the beat had already ended the session.
    for (const body of [
      "open the counter hatch", "take the torch", "open the fuse box",
      "throw the breakers", "switch on the torch", "go through the stack door",
    ]) {
      rooms.propose("jam-stop", { authorId: "a", authorName: "Ada", body });
      rooms.settle("jam-stop");
      await rooms.idle();
    }
    const snapshot = rooms.snapshot("jam-stop", "a")!;
    assert.equal(snapshot.ended?.reason, "spend_ceiling");
    assert.equal(account.committedUsd, 0.4, "nothing was bought after it ended");
    assert.equal(fal.submitted.length, 1, "only the opening loop reached the provider");
  } finally {
    fal.restore();
  }
});

test("most votes wins, and a tie goes to whoever said it first", () => {
  const proposals: Proposal[] = [
    { id: "p1", authorId: "a", authorName: "Ada", body: "first", at: 1 },
    { id: "p2", authorId: "b", authorName: "Bo", body: "second", at: 2 },
  ];
  assert.equal(chooseWinner({ proposals, votes: new Map() })?.id, "p1", "nobody voted");
  assert.equal(
    chooseWinner({ proposals, votes: new Map([["x", "p2"]]) })?.id,
    "p2",
  );
  assert.equal(
    chooseWinner({ proposals, votes: new Map([["x", "p1"], ["y", "p2"]]) })?.id,
    "p1",
    "a tie goes to the earlier proposal",
  );
  assert.equal(chooseWinner({ proposals: [], votes: new Map() }), null);
});

test("a participant has one effective vote, and may change it", () => {
  const { rooms } = build({ fal: null });
  rooms.open("jam-9", "night-audit");
  const one = rooms.propose("jam-9", { authorId: "a", authorName: "Ada", body: "open the hatch" });
  const two = rooms.propose("jam-9", { authorId: "b", authorName: "Bo", body: "open the fuse box" });
  assert.ok(typeof one !== "string" && typeof two !== "string");
  rooms.vote("jam-9", "a", one.id);
  rooms.vote("jam-9", "a", two.id);
  const snapshot = rooms.snapshot("jam-9", "a")!;
  assert.equal(snapshot.turn.voters, 1);
  assert.equal(snapshot.turn.yourVote, two.id);
  assert.deepEqual(snapshot.turn.proposals.map((proposal) => proposal.votes), [0, 1]);
  assert.equal(rooms.vote("jam-9", "a", "00000000-0000-4000-8000-000000000000"), false);
});

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

test("a room nobody has read in half an hour stops holding a slot", async () => {
  const media = new InMemoryEscapeMediaStore();
  let clock = 1_000;
  const rooms = new EscapeRooms({
    media,
    account: new SpendAccount(100),
    fal: null,
    nebius: null,
    limits: { usdPerSecond: 0.08, loopSeconds: 5, maxConcurrentGenerations: 2 },
    now: () => clock,
    sleep: async () => {},
  });
  // Rooms are never explicitly closed — a tab simply stops polling — so
  // without reclaiming them a busy server refuses new ones forever.
  for (let index = 0; index < 24; index += 1) {
    assert.notEqual(typeof rooms.open(`old-${index}`, "night-audit"), "string");
  }
  assert.equal(rooms.open("one-more", "night-audit"), "too_many_rooms");

  // One of them is still being watched; the rest are not.
  clock += 25 * 60_000;
  rooms.snapshot("old-7", "viewer");
  clock += 25 * 60_000;

  assert.notEqual(typeof rooms.open("one-more", "night-audit"), "string");
  assert.equal(rooms.has("old-7"), true, "the room somebody is watching survives");
  assert.equal(rooms.has("old-0"), false);
});
