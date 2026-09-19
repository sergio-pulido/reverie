import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import voiceTranscribe, { type Transcriber, type VoiceEndpointOptions } from "../api/voice/transcribe";
import { resolveSlngConfig, SlngError, sttUrl, transcribe, type SlngConfig } from "../apps/server/providers/slng";
import { MAX_MESSAGE_CHARS } from "../src/conversation/decision";
import { VOICE_LIMITS, voiceResponseSchema } from "../src/voice/contract";

type Captured = { statusCode: number; body: Record<string, unknown> };

let clientNumber = 0;

function request(
  audio: Uint8Array | null,
  init: { method?: string; authorization?: string | null; origin?: string; contentType?: string | null; contentLength?: number } = {},
) {
  const stream = Readable.from(audio && audio.length > 0 ? [Buffer.from(audio)] : []) as unknown as IncomingMessage;
  stream.method = init.method ?? "POST";
  stream.url = "/api/voice/transcribe";
  const authorization = init.authorization === undefined ? "Bearer header.payload.signature" : init.authorization;
  const contentType = init.contentType === undefined ? "audio/webm;codecs=opus" : init.contentType;
  stream.headers = {
    host: "reverie.test",
    ...(authorization ? { authorization } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
    ...(init.contentLength !== undefined ? { "content-length": String(init.contentLength) } : {}),
    ...(init.origin ? { origin: init.origin } : {}),
  };
  clientNumber += 1;
  Object.defineProperty(stream, "socket", { value: { remoteAddress: `10.9.${Math.floor(clientNumber / 250)}.${clientNumber % 250}` } });
  return stream;
}

function capture(): { response: ServerResponse; done: Promise<Captured> } {
  let resolve!: (value: Captured) => void;
  const done = new Promise<Captured>((settle) => (resolve = settle));
  const response = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    on() {},
    end(chunk: string) {
      resolve({ statusCode: response.statusCode, body: JSON.parse(chunk) });
    },
  } as unknown as ServerResponse;
  return { response, done };
}

async function call(audio: Uint8Array | null, options: VoiceEndpointOptions, init?: Parameters<typeof request>[1]) {
  const { response, done } = capture();
  await voiceTranscribe(request(audio, init), response, options);
  return done;
}

const SPEECH = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const signedIn: VoiceEndpointOptions["verifyViewer"] = async () => true;

function transcriber(result: Awaited<ReturnType<Transcriber["transcribe"]>> | Error): Transcriber & { calls: { bytes: number; contentType: string }[] } {
  const calls: { bytes: number; contentType: string }[] = [];
  return {
    calls,
    model: "slng/deepgram/nova:3-en",
    transcribe: async (audio, contentType) => {
      calls.push({ bytes: audio.length, contentType });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("POST /api/voice/transcribe", () => {
  it("returns the final transcript and never anything the schema would not accept", async () => {
    const stt = transcriber({ transcript: "Something light for a Friday night.", audioSeconds: 2.4 });
    const { statusCode, body } = await call(SPEECH, { transcriber: stt, verifyViewer: signedIn });
    assert.equal(statusCode, 200);
    const parsed = voiceResponseSchema.parse(body);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.status === "ok" && parsed.transcript, "Something light for a Friday night.");
    assert.equal(parsed.status === "ok" && parsed.audioSeconds, 2.4);
    assert.deepEqual(stt.calls, [{ bytes: SPEECH.length, contentType: "audio/webm" }]);
  });

  it("answers empty, not ok, when no words were heard", async () => {
    const { body } = await call(SPEECH, { transcriber: transcriber({ transcript: "", audioSeconds: 2 }), verifyViewer: signedIn });
    assert.equal(voiceResponseSchema.parse(body).status, "empty");
  });

  it("cuts a transcript to what one message may hold", async () => {
    const long = "word ".repeat(200).trim();
    const { body } = await call(SPEECH, { transcriber: transcriber({ transcript: long, audioSeconds: 19 }), verifyViewer: signedIn });
    const parsed = voiceResponseSchema.parse(body);
    assert.equal(parsed.status, "ok");
    const transcript = parsed.status === "ok" ? parsed.transcript : "";
    assert.ok(transcript.length <= MAX_MESSAGE_CHARS && transcript.length >= MAX_MESSAGE_CHARS - 5);
    assert.ok(long.startsWith(transcript));
  });

  it("refuses a wrong method, a cross-origin caller and a missing token before any provider call", async () => {
    const stt = transcriber({ transcript: "x", audioSeconds: 1 });
    assert.equal((await call(SPEECH, { transcriber: stt, verifyViewer: signedIn }, { method: "GET" })).statusCode, 405);
    assert.equal((await call(SPEECH, { transcriber: stt, verifyViewer: signedIn }, { origin: "https://elsewhere.example" })).statusCode, 403);
    const unsigned = await call(SPEECH, { transcriber: stt, verifyViewer: signedIn }, { authorization: null });
    assert.equal(unsigned.statusCode, 401);
    assert.equal(stt.calls.length, 0);
  });

  it("refuses a viewer Supabase does not recognise", async () => {
    const stt = transcriber({ transcript: "x", audioSeconds: 1 });
    const { statusCode } = await call(SPEECH, { transcriber: stt, verifyViewer: async () => false });
    assert.equal(statusCode, 401);
    assert.equal(stt.calls.length, 0);
  });

  it("refuses formats it does not accept", async () => {
    const stt = transcriber({ transcript: "x", audioSeconds: 1 });
    for (const contentType of ["application/json", "video/webm", null]) {
      const { statusCode, body } = await call(SPEECH, { transcriber: stt, verifyViewer: signedIn }, { contentType });
      assert.equal(statusCode, 415);
      assert.equal(body.code, "UNSUPPORTED_AUDIO");
    }
    assert.equal(stt.calls.length, 0);
  });

  it("refuses a recording over the upload cap, whether declared or streamed", async () => {
    const stt = transcriber({ transcript: "x", audioSeconds: 1 });
    const declared = await call(SPEECH, { transcriber: stt, verifyViewer: signedIn }, { contentLength: VOICE_LIMITS.maxUploadBytes + 1 });
    assert.equal(declared.statusCode, 413);
    const oversized = new Uint8Array(VOICE_LIMITS.maxUploadBytes + 1);
    const streamed = await call(oversized, { transcriber: stt, verifyViewer: signedIn });
    assert.equal(streamed.statusCode, 413);
    assert.equal(stt.calls.length, 0);
  });

  it("refuses an empty recording", async () => {
    const stt = transcriber({ transcript: "x", audioSeconds: 1 });
    const { statusCode, body } = await call(null, { transcriber: stt, verifyViewer: signedIn });
    assert.equal(statusCode, 400);
    assert.equal(body.code, "EMPTY_RECORDING");
    assert.equal(stt.calls.length, 0);
  });

  it("says voice is off when no provider is configured, and never claims a transcript", async () => {
    const { body } = await call(SPEECH, { transcriber: null, verifyViewer: signedIn });
    const parsed = voiceResponseSchema.parse(body);
    assert.equal(parsed.status, "unavailable");
    assert.equal(parsed.status === "unavailable" && parsed.code, "VOICE_DISABLED");
  });

  it("turns provider failures into typed unavailable answers", async () => {
    const failed = await call(SPEECH, { transcriber: transcriber(new SlngError("no", "rejected", 400)), verifyViewer: signedIn });
    assert.deepEqual([failed.body.status, failed.body.code], ["unavailable", "VOICE_FAILED"]);
    const shape = await call(SPEECH, { transcriber: transcriber(new SlngError("no", "bad_shape")), verifyViewer: signedIn });
    assert.deepEqual([shape.body.status, shape.body.code], ["unavailable", "VOICE_FAILED"]);
    const late = await call(SPEECH, { transcriber: transcriber(new SlngError("no", "timeout")), verifyViewer: signedIn });
    assert.deepEqual([late.body.status, late.body.code], ["unavailable", "VOICE_TIMEOUT"]);
  });

  it("reads SLNG from the environment only when live providers are switched on", async () => {
    const off = await call(SPEECH, { env: { SLNG_API_KEY: "k" }, verifyViewer: signedIn });
    assert.equal(off.body.code, "VOICE_DISABLED");
    const wrongModel = await call(SPEECH, {
      env: { REVERIE_LIVE_ENABLED: "true", SLNG_API_KEY: "k", SLNG_STT_MODEL: "someone/else:1" },
      verifyViewer: signedIn,
    });
    assert.equal(wrongModel.body.code, "VOICE_MISCONFIGURED");
  });
});

const CONFIG: SlngConfig = { apiKey: "test-key", model: "slng/deepgram/nova:3-en", region: "us-east" };

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("SLNG speech-to-text adapter", () => {
  it("resolves only allowlisted models and regions, and only when live", () => {
    assert.equal(resolveSlngConfig({ SLNG_API_KEY: "k" }), null);
    assert.equal(resolveSlngConfig({ REVERIE_LIVE_ENABLED: "true" }), null);
    assert.deepEqual(resolveSlngConfig({ REVERIE_LIVE_ENABLED: "true", SLNG_API_KEY: " k " }), {
      apiKey: "k",
      model: "slng/deepgram/nova:3-en",
      region: "us-east",
    });
    assert.throws(() => resolveSlngConfig({ REVERIE_LIVE_ENABLED: "true", SLNG_API_KEY: "k", SLNG_STT_MODEL: "deepgram/nova:2" }), SlngError);
    assert.throws(() => resolveSlngConfig({ REVERIE_LIVE_ENABLED: "true", SLNG_API_KEY: "k", SLNG_REGION: "eu-west" }), SlngError);
    assert.equal(sttUrl(CONFIG), "https://us-east.api.slng.ai/v1/stt/slng/deepgram/nova:3-en");
    assert.equal(sttUrl(CONFIG, "wss"), "wss://us-east.api.slng.ai/v1/stt/slng/deepgram/nova:3-en");
  });

  it("uploads the audio with the key as a bearer token and reads the first alternative", async () => {
    const { impl, seen } = fakeFetch(() =>
      json({ results: { channels: [{ alternatives: [{ transcript: " a comedy please ", confidence: 0.9 }] }] }, metadata: { duration: 1.5 } }),
    );
    const result = await transcribe(CONFIG, { audio: SPEECH, contentType: "audio/webm", timeoutMs: 1_000, fetchImpl: impl });
    assert.deepEqual(result, { transcript: "a comedy please", audioSeconds: 1.5 });
    assert.equal(seen[0].url, "https://us-east.api.slng.ai/v1/stt/slng/deepgram/nova:3-en");
    assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer test-key");
    const form = seen[0].init.body as FormData;
    assert.equal(form.get("model"), "nova-3-general");
    assert.equal((form.get("audio") as Blob).size, SPEECH.length);
  });

  it("treats an unexpected shape as a typed error, never a half-parsed string", async () => {
    for (const body of [{ results: { channels: [] } }, { transcript: "hello" }, { results: { channels: [{ alternatives: [{ text: "hi" }] }] } }]) {
      const { impl } = fakeFetch(() => json(body));
      await assert.rejects(transcribe(CONFIG, { audio: SPEECH, contentType: "audio/webm", timeoutMs: 1_000, fetchImpl: impl }), (error: unknown) =>
        error instanceof SlngError && error.kind === "bad_shape",
      );
    }
    const { impl } = fakeFetch(() => new Response("not json", { status: 200 }));
    await assert.rejects(transcribe(CONFIG, { audio: SPEECH, contentType: "audio/webm", timeoutMs: 1_000, fetchImpl: impl }), SlngError);
  });

  it("reports a rejection with its status and a network failure as no response", async () => {
    const rejected = fakeFetch(() => json({ error: "STT service error" }, 400));
    await assert.rejects(transcribe(CONFIG, { audio: SPEECH, contentType: "audio/webm", timeoutMs: 1_000, fetchImpl: rejected.impl }), (error: unknown) =>
      error instanceof SlngError && error.kind === "rejected" && error.status === 400,
    );
    const offline = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(transcribe(CONFIG, { audio: SPEECH, contentType: "audio/webm", timeoutMs: 1_000, fetchImpl: offline.impl }), (error: unknown) =>
      error instanceof SlngError && error.kind === "no_response",
    );
  });

  it("gives up at its timeout", async () => {
    // The timeout's own timer does not hold the process open; this one keeps the test alive for it.
    const keepAlive = setTimeout(() => undefined, 1_000);
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await assert.rejects(transcribe(CONFIG, { audio: SPEECH, contentType: "audio/webm", timeoutMs: 20, fetchImpl: hanging.impl }), (error: unknown) =>
      error instanceof SlngError && error.kind === "timeout",
    );
    clearTimeout(keepAlive);
  });
});
