import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MESSAGE_CHARS } from "../src/conversation/decision";
import { acceptedContentType } from "../src/voice/contract";
import { toPcm16 } from "../src/voice/pcmCapture";
import { mergeIntoDraft, outcomeOf, pressAction, streamedAnswer, voiceName } from "../src/voice/voiceState";

describe("voice outcomes", () => {
  it("puts only a final, non-blank transcript into the field", () => {
    assert.deepEqual(outcomeOf({ status: "ok", transcript: "A comedy, please.", audioSeconds: 1.2, model: "m", providerMs: 600 }), {
      kind: "text",
      text: "A comedy, please.",
    });
    assert.equal(outcomeOf({ status: "empty", safeMessage: "No words were heard in that recording." }).kind, "notice");
    assert.equal(outcomeOf({ status: "ok", transcript: "   ", audioSeconds: 1, model: "m", providerMs: 1 }).kind, "notice");
  });

  it("says plainly what happened when there is no transcript, and points back to typing", () => {
    const unreachable = outcomeOf(null);
    assert.equal(unreachable.kind, "notice");
    assert.match(unreachable.kind === "notice" ? unreachable.message : "", /could not reach the server.*Type/);
    const off = outcomeOf({ status: "unavailable", code: "VOICE_DISABLED", safeMessage: "Voice input is not switched on here." });
    assert.match(off.kind === "notice" ? off.message : "", /^Voice input is not switched on here\. Type/);
    const refused = outcomeOf({ status: "error", code: "RATE_LIMITED", safeMessage: "Too many requests.", retryable: true });
    assert.equal(refused.kind, "notice");
  });

  it("adds a transcript after what was typed, never over it, and within the message limit", () => {
    assert.equal(mergeIntoDraft("", "something light"), "something light");
    assert.equal(mergeIntoDraft("a comedy  ", "for tonight"), "a comedy for tonight");
    assert.equal(mergeIntoDraft("kept", "   "), "kept");
    assert.equal(mergeIntoDraft("x".repeat(MAX_MESSAGE_CHARS), "more").length, MAX_MESSAGE_CHARS);
  });
});

describe("the voice control", () => {
  it("starts when idle, stops while recording, gives up while opening, and ignores presses while transcribing", () => {
    assert.equal(pressAction("idle"), "start");
    assert.equal(pressAction("recording"), "stop");
    assert.equal(pressAction("starting"), "cancel");
    assert.equal(pressAction("transcribing"), "ignore");
  });

  it("names what pressing it does in every state, without a countdown", () => {
    assert.equal(voiceName("idle"), "Speak instead of typing");
    assert.equal(voiceName("starting"), "Opening the microphone. Press to cancel.");
    assert.equal(voiceName("recording"), "Listening. Press to stop.");
    assert.equal(voiceName("transcribing"), "Finishing what you said");
    for (const phase of ["idle", "starting", "recording", "transcribing"] as const) {
      assert.equal(/\d/.test(voiceName(phase)), false, `${phase} names no time`);
    }
  });

  it("accepts the recorder's containers and nothing else", () => {
    assert.equal(acceptedContentType("audio/webm;codecs=opus"), "audio/webm");
    assert.equal(acceptedContentType("Audio/MP4"), "audio/mp4");
    assert.equal(acceptedContentType("audio/ogg; codecs=opus"), "audio/ogg");
    assert.equal(acceptedContentType("video/webm"), null);
    assert.equal(acceptedContentType(undefined), null);
  });
});

describe("the live stream", () => {
  const timings = { firstPartialMs: 900, stopToFinalMs: 400, audioBytes: 64_000 };

  it("uses the stream's final only when it has words; otherwise the recording is uploaded", () => {
    assert.deepEqual(streamedAnswer({ kind: "final", transcript: " A comedy. ", timings }), {
      status: "ok",
      transcript: "A comedy.",
      audioSeconds: 2,
      model: "stream",
      providerMs: 400,
    });
    assert.equal(streamedAnswer({ kind: "final", transcript: "  ", timings }), null);
    assert.equal(streamedAnswer({ kind: "failed", code: "STREAM_CLOSED" }), null);
    assert.equal(streamedAnswer(null), null);
  });

  it("encodes samples as little-endian 16-bit PCM and clips out-of-range values", () => {
    const view = new DataView(toPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])));
    assert.equal(view.byteLength, 12);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((index) => view.getInt16(index * 2, true)),
      [0, 32767, -32768, 32767, -32768, 16383],
    );
  });
});
