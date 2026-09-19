import assert from "node:assert/strict";
import { test } from "node:test";
import {
  directorServerMessageSchema,
  initialDirectorState,
  isFatalDirectorError,
  nextPromptMessage,
  reduceDirectorState,
  type DirectorServerMessage,
  type DirectorState,
} from "../src/core/directorProtocol";

function fold(messages: unknown[]): DirectorState {
  return messages.reduce<DirectorState>((state, raw) => {
    const parsed = directorServerMessageSchema.parse(raw);
    return reduceDirectorState(state, parsed);
  }, initialDirectorState());
}

test("the stream is only live once video has actually arrived", () => {
  const configured = fold([{ type: "configured", prompt_version: 1 }]);
  assert.equal(configured.status, "configuring");
  assert.equal(configured.chunksReceived, 0);

  const streaming = fold([
    { type: "configured", prompt_version: 1 },
    { type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 10 },
  ]);
  assert.equal(streaming.status, "streaming");
  assert.equal(streaming.chunksReceived, 1);
  assert.equal(streaming.generatedSeconds, 10);
});

test("generated seconds accumulate for the spend readout", () => {
  const state = fold([
    { type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 10 },
    { type: "chunk", chunk_index: 1, prompt_version: 1, playback_seconds: 8.5 },
  ]);
  assert.equal(state.generatedSeconds, 18.5);
  assert.equal(state.chunksReceived, 2);
});

test("the applied version only moves forward", () => {
  const state = fold([
    { type: "prompt_applied", prompt_version: 3 },
    { type: "prompt_applied", prompt_version: 2 },
  ]);
  assert.equal(state.appliedPromptVersion, 3);
});

test("a rejected prompt reports itself without killing the stream", () => {
  const state = fold([
    { type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 10 },
    { type: "prompt_rejected", prompt_version: 4 },
  ]);
  assert.equal(state.status, "streaming");
  assert.match(String(state.error), /not applied/);
});

test("a diagnostic error is surfaced but the session survives", () => {
  const state = fold([
    { type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 10 },
    { type: "error", code: "invalid_message", error: "Unknown field." },
  ]);
  assert.equal(state.status, "streaming");
  assert.equal(state.error, "Unknown field.");
  assert.equal(isFatalDirectorError("invalid_message"), false);
});

test("a session-fatal error ends the stream", () => {
  for (const code of ["balance_unavailable", "content_policy", "generation_failed"]) {
    assert.ok(isFatalDirectorError(code));
    const state = fold([
      { type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 10 },
      { type: "error", code, error: "Stopped." },
    ]);
    assert.equal(state.status, "failed", code);
  }
});

test("exhaustion records why the stream ended", () => {
  const limit = fold([
    { type: "stream_exhausted", reason: "session_limit", chunks: 12 },
  ]);
  assert.equal(limit.status, "ended");
  assert.equal(limit.endedReason, "session_limit");

  const stopped = fold([{ type: "stream_exhausted", reason: "stopped", chunks: 3 }]);
  assert.equal(stopped.endedReason, "stopped");
});

test("unknown server messages are ignored, not treated as failures", () => {
  // fal publishes metrics and audio events this client does not act on; a
  // stricter union would break the moment another is added.
  const state = fold([
    { type: "chunk", chunk_index: 0, prompt_version: 1, playback_seconds: 10 },
    { type: "chunk_metrics", units: "ms" },
    { type: "audio_pending" },
  ]);
  assert.equal(state.status, "streaming");
  assert.equal(state.error, null);
});

test("each direction takes the next version fal will accept", () => {
  let state = initialDirectorState();
  const first = nextPromptMessage(state, "Push in on the door.");
  assert.deepEqual(first.message, {
    type: "prompt",
    prompt_version: 2,
    prompt: "Push in on the door.",
    replan: true,
  });
  state = first.state;
  const second = nextPromptMessage(state, "Cut to the lighthouse.");
  assert.equal(
    (second.message as { prompt_version: number }).prompt_version,
    3,
  );
});

test("a malformed server message is rejected by the schema", () => {
  assert.equal(
    directorServerMessageSchema.safeParse({ type: "chunk" }).success,
    false,
  );
  assert.equal(directorServerMessageSchema.safeParse(null).success, false);
  const ok = directorServerMessageSchema.safeParse({
    type: "error",
    code: "content_policy",
    error: "Refused.",
  });
  assert.ok(ok.success);
  assert.equal((ok.data as DirectorServerMessage).type, "error");
});
