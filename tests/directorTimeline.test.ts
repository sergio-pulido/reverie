import assert from "node:assert/strict";
import test from "node:test";
import type { DirectorAuditEntry } from "../src/core/directorAudit";
import { beatOffsets, beatWindowForScript } from "../src/core/directorBeats";
import { unopenedSpend, type DirectorRates, type DirectorSpend } from "../src/core/directorSpend";
import {
  buildTimeline,
  beatOfTurn,
  directionTurns,
  firstBlockedBeat,
  type TimelineInput,
} from "../src/core/directorTimeline";
import { buildScript } from "./helpers";

const RATES: DirectorRates = { budgetUsd: 20, usdPerSecond: 0.08, minBilledSeconds: 60 };
/** 6 beats of 5 seconds: 30 seconds of film, beats starting at 0,5,10,15,20,25. */
const SCRIPT = buildScript(5, 2, 3);
const RICH: DirectorSpend = { ...RATES, sessionUsd: 0, remainingUsd: 20 };

function timelineAt(offsetSeconds: number | null, spend: DirectorSpend = RICH) {
  const input: TimelineInput = {
    window: beatWindowForScript(SCRIPT, offsetSeconds),
    producedThrough: offsetSeconds === null ? null : null,
    spend,
  };
  return buildTimeline(SCRIPT, input);
}

function states(offsetSeconds: number | null, spend?: DirectorSpend) {
  return timelineAt(offsetSeconds, spend).map((beat) => beat.state);
}

test("with no session every beat is written, numbered from one, at its own offset", () => {
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: null, spend: RICH });
  assert.deepEqual(beats.map((beat) => beat.state), Array(6).fill("written"));
  assert.deepEqual(beats.map((beat) => beat.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(beats.map((beat) => beat.startSeconds), [0, 5, 10, 15, 20, 25]);
  assert.deepEqual(beats.map((beat) => beat.durationSeconds), Array(6).fill(5));
});

test("before the first chunk the opening beat is already being generated", () => {
  assert.deepEqual(states(null), [
    "generating",
    "written",
    "written",
    "written",
    "written",
    "written",
  ]);
});

test("a streamed beat is ready, the one on screen is generating, the one after it is locked", () => {
  // 12s in: beat 3 (index 2) is on screen, beat 4 is already with the provider.
  assert.deepEqual(states(12), ["ready", "ready", "generating", "locked", "written", "written"]);
});

test("the locked beat is exactly the gap the closing rule leaves", () => {
  const window = beatWindowForScript(SCRIPT, 12);
  const beats = timelineAt(12);
  const locked = beats.filter((beat) => beat.state === "locked");
  assert.equal(locked.length, 1);
  assert.equal(locked[0].portionIndex, window.lockedBeatIndex);
  assert.equal(window.minEditableBeatIndex, 4, "editing resumes two beats ahead");
  assert.equal(beats[4].state, "written", "the first editable beat is open again");
});

test("at the last beat nothing is locked ahead of it", () => {
  assert.deepEqual(states(27), ["ready", "ready", "ready", "ready", "ready", "generating"]);
});

test("after the session stops, what it produced stays ready and nothing is generating", () => {
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: 2, spend: RICH });
  assert.deepEqual(beats.map((beat) => beat.state), [
    "ready",
    "ready",
    "ready",
    "written",
    "written",
    "written",
  ]);
});

test("a beat the budget cannot pay for is blocked, and the block starts where the money runs out", () => {
  // $0.80 buys ten seconds: two 5-second beats, and no more.
  const tight: DirectorSpend = { ...RATES, sessionUsd: 19.2, remainingUsd: 0.4 };
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: null, spend: tight });
  assert.deepEqual(beats.map((beat) => beat.state), Array(6).fill("written"), "$0.40 still buys a 5s beat");

  const spent: DirectorSpend = { ...RATES, sessionUsd: 20, remainingUsd: 0 };
  const blocked = buildTimeline(SCRIPT, { window: null, producedThrough: null, spend: spent });
  assert.deepEqual(blocked.map((beat) => beat.state), Array(6).fill("blocked"));
  assert.equal(firstBlockedBeat(blocked)?.number, 1);
  assert.equal(firstBlockedBeat(beats), null);
});

test("an exhausted budget never overrides what the stream is actually doing", () => {
  const spent: DirectorSpend = { ...RATES, sessionUsd: 20, remainingUsd: 0 };
  assert.deepEqual(states(12, spent), [
    "ready",
    "ready",
    "generating",
    "locked",
    "blocked",
    "blocked",
  ]);
});

test("with no budget configured at all, every beat is blocked", () => {
  const none = unopenedSpend({ ...RATES, budgetUsd: 0 });
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: null, spend: none });
  assert.deepEqual(beats.map((beat) => beat.state), Array(6).fill("blocked"));
});

function sent(promptVersion: number, extra: Partial<DirectorAuditEntry> = {}): DirectorAuditEntry {
  return {
    at: `2026-09-20T10:0${promptVersion}:00.000Z`,
    kind: "direction_sent",
    promptVersion,
    body: `Direction ${promptVersion}`,
    ...extra,
  };
}

test("a turn is about the beat it names", () => {
  const offsets = beatOffsets(SCRIPT);
  assert.equal(beatOfTurn(sent(2, { beatIndex: 4, scriptOffsetSeconds: 12 }), offsets), 4);
});

test("a turn that names no beat is about the one that was playing when it was sent", () => {
  const offsets = beatOffsets(SCRIPT);
  assert.equal(beatOfTurn(sent(2, { scriptOffsetSeconds: 12 }), offsets), 2);
  assert.equal(beatOfTurn(sent(2, { scriptOffsetSeconds: 0 }), offsets), 0);
});

test("a turn sent before anything was on screen is about no beat, rather than guessing the first", () => {
  assert.equal(beatOfTurn(sent(2), beatOffsets(SCRIPT)), null);
});

test("turns carry the verdict the trail recorded, and pending is a real answer", () => {
  const entries: DirectorAuditEntry[] = [
    sent(2, { scriptOffsetSeconds: 12 }),
    { at: "2026-09-20T10:02:01.000Z", kind: "direction_applied", promptVersion: 2 },
    sent(3, { beatIndex: 5 }),
    { at: "2026-09-20T10:03:01.000Z", kind: "direction_rejected", promptVersion: 3 },
    sent(4),
  ];
  const turns = directionTurns(entries, SCRIPT);
  assert.deepEqual(turns.map((turn) => [turn.promptVersion, turn.outcome, turn.beatIndex]), [
    [2, "applied", 2],
    [3, "rejected", 5],
    [4, "pending", null],
  ]);
  assert.deepEqual(turns.map((turn) => turn.body), ["Direction 2", "Direction 3", "Direction 4"]);
});

test("only directions become turns; chunks and provider errors do not", () => {
  const entries: DirectorAuditEntry[] = [
    { at: "2026-09-20T10:00:00.000Z", kind: "session_opened" },
    { at: "2026-09-20T10:00:01.000Z", kind: "chunk_received", chunkIndex: 0 },
    sent(2),
    { at: "2026-09-20T10:00:03.000Z", kind: "provider_error", detail: "transient" },
  ];
  assert.deepEqual(directionTurns(entries, SCRIPT).map((turn) => turn.promptVersion), [2]);
});

test("with no script a turn keeps its named beat and cannot infer one from an offset", () => {
  const turns = directionTurns([sent(2, { scriptOffsetSeconds: 12 }), sent(3, { beatIndex: 1 })], null);
  assert.deepEqual(turns.map((turn) => turn.beatIndex), [null, 1]);
});
