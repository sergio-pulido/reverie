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
  isBeatClosed,
  type TimelineInput,
} from "../src/core/directorTimeline";
import { buildScript } from "./helpers";

const RATES: DirectorRates = { budgetUsd: 20, usdPerSecond: 0.08, minBilledSeconds: 60 };
/** 6 beats of 5 seconds: 30 seconds of film, beats starting at 0,5,10,15,20,25. */
const SCRIPT = buildScript(5, 2, 3);
const RICH: DirectorSpend = { ...RATES, sessionUsd: 0, remainingUsd: 20 };

function timelineAt(
  offsetSeconds: number | null,
  spend: DirectorSpend = RICH,
  playheadSeconds: number | null = null,
) {
  const input: TimelineInput = {
    window: beatWindowForScript(SCRIPT, offsetSeconds),
    producedThrough: offsetSeconds === null ? null : null,
    playheadSeconds,
    spend,
  };
  return buildTimeline(SCRIPT, input);
}

function states(
  offsetSeconds: number | null,
  spend?: DirectorSpend,
  playheadSeconds: number | null = null,
) {
  return timelineAt(offsetSeconds, spend, playheadSeconds).map((beat) => beat.state);
}

test("with no session every beat is written, numbered from one, at its own offset", () => {
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: null, playheadSeconds: null, spend: RICH });
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

test("a streamed beat is ready, the frontier beat is generating, the one after it is locked", () => {
  // The frontier is 12s in: beat 3 (index 2) is being generated, beat 4 is
  // already committed. Nothing here says which beat the VIEWER is on — with no
  // playhead, none of them claims to be on screen.
  assert.deepEqual(states(12), ["ready", "ready", "generating", "locked", "written", "written"]);
});

test("the beat on screen is the playhead's, not the provider's frontier", () => {
  // The case the screen got wrong. A paid probe (2026-09-20) measured chunks
  // arriving 10s at a time while this script's beats are 5s, so the frontier
  // runs whole beats ahead of the viewer: generated through 20s, watching 7s.
  // Beat 5 is being made; beat 2 is the one a person is actually looking at.
  assert.deepEqual(states(20, RICH, 7), [
    "ready",
    "playing",
    "ready",
    "ready",
    "generating",
    "locked",
  ]);
});

test("exactly one beat is ever on screen, and it advances with the playhead alone", () => {
  // The frontier is held still at 20s across the whole run: if the timeline
  // only moved when a chunk landed, every row here would be identical. This is
  // the regression test for "the timeline does not update as the film goes on".
  const playing = [0, 4, 5, 9, 12, 17].map((at) => {
    const beats = timelineAt(20, RICH, at);
    const onScreen = beats.filter((beat) => beat.state === "playing");
    assert.equal(onScreen.length, 1, `one beat on screen at ${at}s`);
    return onScreen[0].number;
  });
  assert.deepEqual(playing, [1, 1, 2, 2, 3, 4], "the beat advances on beat boundaries");
});

test("at the live edge the beat being generated keeps saying so", () => {
  // The viewer has caught up to the frontier: both claims are true of beat 3
  // and the stronger one wins, so the screen never stops reporting that the
  // provider is still working.
  const beats = timelineAt(12, RICH, 12);
  assert.equal(beats[2].state, "generating");
  assert.equal(beats.filter((beat) => beat.state === "playing").length, 0);
});

test("a playhead outside every beat puts nothing on screen", () => {
  // Past the end of a 30s film, and before anything plays.
  assert.equal(timelineAt(20, RICH, 30).filter((beat) => beat.state === "playing").length, 0);
  assert.equal(timelineAt(20, RICH, null).filter((beat) => beat.state === "playing").length, 0);
});

test("a finished film still shows where the room's clock is", () => {
  // No session, so no frontier: the playhead is the room's shared clock and
  // the beat it sits in is on screen rather than merely ready.
  const beats = buildTimeline(SCRIPT, {
    window: null,
    producedThrough: 5,
    playheadSeconds: 12,
    spend: RICH,
  });
  assert.deepEqual(beats.map((beat) => beat.state), [
    "ready",
    "ready",
    "playing",
    "ready",
    "ready",
    "ready",
  ]);
});

test("a beat nothing has produced never claims to be on screen", () => {
  // The playhead sits in beat 5, but this session only produced three beats.
  // An un-generated beat cannot be what a viewer is watching.
  const beats = buildTimeline(SCRIPT, {
    window: null,
    producedThrough: 2,
    playheadSeconds: 22,
    spend: RICH,
  });
  assert.equal(beats[4].state, "written");
  assert.equal(beats.filter((beat) => beat.state === "playing").length, 0);
});

test("a beat on screen is closed to direction, exactly as a generated one is", () => {
  // "On screen" is a treatment, not permission to re-direct: the viewer is
  // watching it, so the provider made it. Only the two states that were never
  // generated stay open.
  assert.deepEqual(
    (["generating", "playing", "ready", "locked"] as const).map(isBeatClosed),
    [true, true, true, true],
  );
  assert.deepEqual((["written", "blocked"] as const).map(isBeatClosed), [false, false]);
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
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: 2, playheadSeconds: null, spend: RICH });
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
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: null, playheadSeconds: null, spend: tight });
  assert.deepEqual(beats.map((beat) => beat.state), Array(6).fill("written"), "$0.40 still buys a 5s beat");

  const spent: DirectorSpend = { ...RATES, sessionUsd: 20, remainingUsd: 0 };
  const blocked = buildTimeline(SCRIPT, { window: null, producedThrough: null, playheadSeconds: null, spend: spent });
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
  const beats = buildTimeline(SCRIPT, { window: null, producedThrough: null, playheadSeconds: null, spend: none });
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

test("at Play the opening beat is being made and the beats handed over with it are closed", () => {
  // What `configure` carried: 15 seconds, so beats 1-3 are with the provider.
  // The provider starts at the top of the film, so beat 1 is the one being
  // made — not the last one handed over, which is three beats ahead of it.
  const window = beatWindowForScript(SCRIPT, null, 15);
  assert.deepEqual(window, {
    currentBeatIndex: null,
    lockedBeatIndex: 2,
    minEditableBeatIndex: 3,
  });
  const beats = buildTimeline(SCRIPT, {
    window,
    producedThrough: null,
    playheadSeconds: null,
    spend: RICH,
  });
  assert.deepEqual(beats.map((beat) => beat.state), [
    "generating",
    "locked",
    "locked",
    "written",
    "written",
    "written",
  ]);
  // And every one of them is closed to direction, the generating one included.
  assert.deepEqual(beats.map((beat) => isBeatClosed(beat.state)), [
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
});
