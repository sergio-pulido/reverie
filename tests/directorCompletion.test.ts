import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completionDetail,
  completionOf,
  completionSignal,
  playedToEnd,
  PLAYED_TO_END_TOLERANCE_SECONDS,
} from "../src/core/directorCompletion";
import { initialDirectorState, reduceDirectorState } from "../src/core/directorProtocol";
import { buildScript } from "./helpers";
import { DirectorStream } from "../apps/server/directorStream";
import { FakeDirectorPeer } from "./fakeDirectorPeer";

test("the whole film is generated when its whole length has been generated", () => {
  const reading = { runtimeSeconds: 20, generatedSeconds: 20, scriptOffsetSeconds: 10 };
  assert.equal(completionSignal(reading), "generated");
  assert.equal(completionSignal({ ...reading, generatedSeconds: 19.5 }), null);
  // Overrun still reads as finished: the last chunk may cross the end.
  assert.equal(completionSignal({ ...reading, generatedSeconds: 30 }), "generated");
});

test("the frontier is the backstop, and it crosses a chunk late", () => {
  // A provider that reports its frontier but no chunk durations still stops.
  const blind = { runtimeSeconds: 20, generatedSeconds: 0, scriptOffsetSeconds: 20 };
  assert.equal(completionSignal(blind), "frontier");
  // The frontier is the START offset of the chunk being generated, so a
  // session reading 10 on a 20s film has not reached the end yet.
  assert.equal(completionSignal({ ...blind, scriptOffsetSeconds: 10 }), null);
  assert.equal(completionSignal({ ...blind, scriptOffsetSeconds: null }), null);
});

test("a film of unknown length is never reported as generated", () => {
  // Zero is a script this server could not time, not a film of no length:
  // stopping such a take instantly is the worst reading of it.
  assert.equal(
    completionSignal({ runtimeSeconds: 0, generatedSeconds: 60, scriptOffsetSeconds: 60 }),
    null,
  );
});

test("generation is read off the stream's own state and script", () => {
  const script = buildScript(5, 2, 2); // 20s
  let state = initialDirectorState();
  state = reduceDirectorState(state, {
    type: "chunk",
    chunk_index: 0,
    prompt_version: 1,
    playback_seconds: 10,
    script_offset_seconds: 0,
  });
  assert.equal(completionOf(state, script), null);
  state = reduceDirectorState(state, {
    type: "chunk",
    chunk_index: 1,
    prompt_version: 1,
    playback_seconds: 10,
    script_offset_seconds: 10,
  });
  assert.equal(completionOf(state, script), "generated");
});

test("the detail names the reading that crossed, and the film it crossed", () => {
  assert.equal(
    completionDetail("generated", {
      runtimeSeconds: 20,
      generatedSeconds: 22.55,
      scriptOffsetSeconds: 20,
    }),
    "22.6s generated of a 20s film",
  );
  assert.equal(
    completionDetail("frontier", {
      runtimeSeconds: 20,
      generatedSeconds: 0,
      scriptOffsetSeconds: 20,
    }),
    "frontier at 20s of a 20s film",
  );
});

/** A stream over a fake peer, so nothing here touches the network. */
async function openStream(
  script = buildScript(5, 2, 2),
): Promise<{ stream: DirectorStream; peer: FakeDirectorPeer; signals: string[] }> {
  const peer = new FakeDirectorPeer();
  const signals: string[] = [];
  const stream = new DirectorStream({
    jamId: "jam-1",
    sessionId: "session-1",
    config: { apiKey: "k", resolution: "768p", aspectRatio: "16:9", record: false },
    script,
    createPeer: () => peer,
    startSession: async () => "v=0\r\nanswer\r\n",
    onFilmGenerated: (signal: string) => signals.push(signal),
  });
  await stream.open();
  peer.channel.open();
  return { stream, peer, signals };
}

function chunk(index: number, seconds: number, offset: number) {
  return {
    type: "chunk",
    chunk_index: index,
    prompt_version: 1,
    playback_seconds: seconds,
    script_offset_seconds: offset,
  };
}

test("the stream reports the whole film generated once, and records how", async () => {
  const { stream, peer, signals } = await openStream();
  peer.channel.deliver(chunk(0, 10, 0));
  assert.deepEqual(signals, []);
  assert.equal(stream.filmGenerated, false);

  peer.channel.deliver(chunk(1, 10, 10));
  assert.deepEqual(signals, ["generated"]);
  assert.equal(stream.filmGenerated, true);

  // fal keeps streaming past the last beat; the report does not repeat.
  peer.channel.deliver(chunk(2, 10, 20));
  assert.deepEqual(signals, ["generated"]);

  const completed = stream.entries.filter((entry) => entry.kind === "film_generated");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].detail, "20s generated of a 20s film");
  assert.equal(completed[0].scriptOffsetSeconds, 10);
  await stream.stop();
});

test("a provider that reports no playable duration still reaches the end", async () => {
  const { stream, peer, signals } = await openStream();
  // Every chunk reports zero playable seconds, so `generatedSeconds` never
  // moves: only the frontier says this take has passed the end of its film.
  for (const offset of [0, 10, 20]) {
    peer.channel.deliver(chunk(offset / 10, 0, offset));
  }
  assert.deepEqual(signals, ["frontier"]);
  assert.equal(stream.snapshot.generatedSeconds, 0);
  await stream.stop();
});

test("replacement overlap does not finish the film before its translated frontier", async () => {
  const script = buildScript(15, 2, 3); // 90s
  const { stream, peer, signals } = await openStream(script);
  peer.channel.deliver({ type: "configured", prompt_version: 1, chunk_duration: 10 });
  peer.channel.deliver(chunk(0, 10, 0));
  peer.channel.deliver(chunk(1, 10, 10));

  assert.deepEqual(stream.updateScript(script, 2), { accepted: true, promptVersion: 2 });

  // One already-requested v1 chunk arrives after the replacement. The new
  // provider clock then restarts at zero, so these reports total 90 generated
  // seconds but cover only the first 80 seconds of the film.
  peer.channel.deliver(chunk(2, 10, 20));
  for (const offset of [0, 10, 20, 30, 40, 50]) {
    peer.channel.deliver({
      type: "chunk",
      chunk_index: 3 + offset / 10,
      prompt_version: 2,
      playback_seconds: 10,
      script_offset_seconds: offset,
    });
  }
  assert.deepEqual(signals, []);
  assert.equal(stream.filmGenerated, false);

  peer.channel.deliver({
    type: "chunk",
    chunk_index: 9,
    prompt_version: 2,
    playback_seconds: 10,
    script_offset_seconds: 60,
  });
  assert.deepEqual(signals, ["generated"]);
  assert.equal(stream.filmGenerated, true);
  await stream.stop();
});

test("a take already stopping reports nothing generated", async () => {
  const { stream, peer, signals } = await openStream();
  await stream.stop();
  peer.channel.deliver(chunk(0, 30, 0));
  assert.deepEqual(signals, []);
});

test("the stop rule is the seconds played, and nothing else", () => {
  // The film is 20s. Generation reaching 20 says nothing here; only the
  // position the viewer has actually reached does.
  assert.equal(playedToEnd(19, 20), false);
  assert.equal(playedToEnd(20, 20), true);
  // A media element can stall a hair short, and the playhead is sampled four
  // times a second, so the last quarter-second counts as the end.
  assert.equal(playedToEnd(19.8, 20), true);
  assert.equal(playedToEnd(19.7, 20), false);
  assert.equal(PLAYED_TO_END_TOLERANCE_SECONDS, 0.25);
});

test("nothing playing is never an end", () => {
  // Null is a film that is not playing here — paused, nothing decoded, or no
  // element at all. Ending a take on that is how a room gets shown nothing.
  assert.equal(playedToEnd(null, 20), false);
  // And a film of unknown length has no end to reach.
  assert.equal(playedToEnd(30, null), false);
  assert.equal(playedToEnd(30, 0), false);
});

test("a stop records the reason it was given, and says nothing when given none", async () => {
  // A take that was watched to the end of its film is not the same event as
  // one somebody pressed Stop on, and the trail is where that difference
  // survives the session.
  const watched = await openStream();
  await watched.stream.stop("played_to_end");
  const closed = watched.stream.entries.filter((entry) => entry.kind === "session_closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].detail, "played_to_end");

  const pressed = await openStream();
  await pressed.stream.stop();
  assert.equal(
    pressed.stream.entries.find((entry) => entry.kind === "session_closed")?.detail,
    undefined,
  );
});
