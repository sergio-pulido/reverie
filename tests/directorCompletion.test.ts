import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completionDetail,
  completionOf,
  completionSignal,
} from "../src/core/directorCompletion";
import { initialDirectorState, reduceDirectorState } from "../src/core/directorProtocol";
import { buildScript } from "./helpers";
import { DirectorStream } from "../apps/server/directorStream";
import { FakeDirectorPeer } from "./fakeDirectorPeer";

test("a film is finished when its whole length has been generated", () => {
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

test("a film of unknown length never completes itself", () => {
  // Zero is a script this server could not time, not a film of no length:
  // stopping such a take instantly is the worst reading of it.
  assert.equal(
    completionSignal({ runtimeSeconds: 0, generatedSeconds: 60, scriptOffsetSeconds: 60 }),
    null,
  );
});

test("completion is read off the stream's own state and script", () => {
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
    onComplete: (signal) => signals.push(signal),
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

test("the stream reports the end of the film once, and records why", async () => {
  const { stream, peer, signals } = await openStream();
  peer.channel.deliver(chunk(0, 10, 0));
  assert.deepEqual(signals, []);
  assert.equal(stream.complete, false);

  peer.channel.deliver(chunk(1, 10, 10));
  assert.deepEqual(signals, ["generated"]);
  assert.equal(stream.complete, true);

  // fal keeps streaming past the last beat; the report does not repeat.
  peer.channel.deliver(chunk(2, 10, 20));
  assert.deepEqual(signals, ["generated"]);

  const completed = stream.entries.filter((entry) => entry.kind === "session_complete");
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

test("a take already stopping reports no completion", async () => {
  const { stream, peer, signals } = await openStream();
  await stream.stop();
  peer.channel.deliver(chunk(0, 30, 0));
  assert.deepEqual(signals, []);
});
