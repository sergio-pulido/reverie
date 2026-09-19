import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { finalText, hear, NOTHING_HEARD, parseUpstreamEvent, shownText } from "../apps/server/providers/slng";
import { attachVoiceStream, type UpstreamHandlers, type VoiceStreamOptions } from "../apps/server/voiceStream";
import { serverMessageSchema, STREAM_LIMITS, STREAM_PATH, type ServerMessage } from "../src/voice/streamProtocol";

const results = (transcript: string, isFinal = false, speechFinal = false, timing?: { start: number; duration: number }) =>
  JSON.stringify({ type: "Results", is_final: isFinal, speech_final: speechFinal, channel: { alternatives: [{ transcript }] }, ...timing });

describe("SLNG stream messages", () => {
  it("reads results, ignores metadata, and treats anything else as invalid", () => {
    assert.deepEqual(parseUpstreamEvent(results(" a comedy ", true, true)), {
      kind: "results",
      transcript: "a comedy",
      isFinal: true,
      speechFinal: true,
      heardUntil: null,
    });
    assert.equal((parseUpstreamEvent(results("", false, false, { start: 2.5, duration: 0.75 })) as { heardUntil: number }).heardUntil, 3.25);
    assert.deepEqual(parseUpstreamEvent(JSON.stringify({ type: "Metadata", request_id: "r" })), { kind: "other" });
    assert.deepEqual(parseUpstreamEvent(JSON.stringify({ code: "config_error", message: "no", type: "error" })), { kind: "error" });
    assert.deepEqual(parseUpstreamEvent("{not json"), { kind: "invalid" });
    assert.deepEqual(parseUpstreamEvent(JSON.stringify({ type: "Results", channel: { alternatives: [] } })), { kind: "invalid" });
    assert.deepEqual(parseUpstreamEvent(JSON.stringify({ transcript: "hi" })), { kind: "invalid" });
  });

  it("builds the final transcript from finalized segments only", () => {
    let heard = NOTHING_HEARD;
    const result = (transcript: string, isFinal: boolean, speechFinal: boolean) => ({ kind: "results" as const, transcript, isFinal, speechFinal, heardUntil: null });
    heard = hear(heard, result("something", false, false));
    assert.equal(shownText(heard), "something");
    assert.equal(finalText(heard), "");
    heard = hear(heard, result("Something light.", true, false));
    heard = hear(heard, result("for a", false, false));
    assert.equal(shownText(heard), "Something light. for a");
    assert.equal(finalText(heard), "Something light.");
    heard = hear(heard, result("For a Friday night.", true, true));
    assert.equal(finalText(heard), "Something light. For a Friday night.");
    heard = hear(heard, result("", true, true));
    assert.equal(finalText(heard), "Something light. For a Friday night.");
  });
});

type FakeUpstream = {
  sent: (Buffer | string)[];
  handlers: UpstreamHandlers | null;
  closed: boolean;
};

let server: Server;
let port = 0;
let upstream: FakeUpstream;
let options: VoiceStreamOptions;

function fakeConnect(openImmediately = true): VoiceStreamOptions["connectUpstream"] {
  return (handlers) => {
    upstream.handlers = handlers;
    if (openImmediately) setImmediate(handlers.onOpen);
    return {
      send: (data) => upstream.sent.push(data),
      close: () => {
        upstream.closed = true;
      },
    };
  };
}

before(async () => {
  server = createServer((_request, response) => response.end());
  // Options are read per session, so each test can swap them.
  attachVoiceStream(server, new Proxy({} as VoiceStreamOptions, { get: (_target, key) => options[key as keyof VoiceStreamOptions] }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function reset(overrides: Partial<VoiceStreamOptions> = {}) {
  upstream = { sent: [], handlers: null, closed: false };
  options = { connectUpstream: fakeConnect(), verifyViewer: async () => true, model: "slng/deepgram/nova:3-en", ...overrides };
}

type Client = { socket: WebSocket; messages: ServerMessage[]; next: (type: ServerMessage["type"]) => Promise<ServerMessage>; closed: Promise<number> };

function connect(origin = `http://127.0.0.1:${port}`): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${STREAM_PATH}`, { headers: { origin } });
  const messages: ServerMessage[] = [];
  const waiters: { type: string; resolve: (message: ServerMessage) => void }[] = [];
  socket.on("message", (data) => {
    const message = serverMessageSchema.parse(JSON.parse(data.toString()));
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  const next = (type: ServerMessage["type"]) => {
    const seen = messages.find((message) => message.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise<ServerMessage>((resolve) => waiters.push({ type, resolve }));
  };
  return new Promise((resolve, reject) => {
    socket.on("open", () => resolve({ socket, messages, next, closed }));
    socket.on("error", reject);
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("voice stream relay", () => {
  it("relays audio after the init message, shows partials, and answers the final once SLNG ends the utterance", async () => {
    reset();
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    await client.next("ready");
    client.socket.send(Buffer.alloc(3_200, 1));
    await tick();
    assert.equal(JSON.parse(String(upstream.sent[0])).type, "init");
    assert.equal(JSON.parse(String(upstream.sent[0])).config.encoding, "linear16");
    assert.equal((upstream.sent[1] as Buffer).length, 3_200);

    upstream.handlers!.onMessage(results("something light"));
    const partial = await client.next("partial");
    assert.deepEqual(partial, { type: "partial", text: "something light" });

    client.socket.send(JSON.stringify({ type: "stop" }));
    await tick();
    const silence = upstream.sent.slice(2) as Buffer[];
    assert.equal(silence.reduce((sum, frame) => sum + frame.length, 0) >= (STREAM_LIMITS.trailingSilenceMs / 1_000) * STREAM_LIMITS.bytesPerSecond, true);
    assert.ok(silence.every((frame) => frame.every((byte) => byte === 0)));

    upstream.handlers!.onMessage(results("Something light for a Friday night.", true, true));
    const final = await client.next("final");
    assert.equal(final.type === "final" && final.transcript, "Something light for a Friday night.");
    assert.equal(final.type === "final" && final.timings.audioBytes, 3_200);
    assert.equal(await client.closed, 1000);
    assert.equal(upstream.closed, true);
  });

  it("answers as soon as SLNG has heard past the point where the viewer stopped", async () => {
    reset();
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    await client.next("ready");
    client.socket.send(Buffer.alloc(16_000, 1));
    upstream.handlers!.onMessage(results("A comedy.", true, true, { start: 0, duration: 0.4 }));
    client.socket.send(JSON.stringify({ type: "stop" }));
    await tick();
    // Heard up to 0.45 s of 0.5 s spoken: not yet.
    upstream.handlers!.onMessage(results("", false, false, { start: 0.4, duration: 0.05 }));
    await tick();
    assert.equal(client.messages.some((message) => message.type === "final"), false);
    upstream.handlers!.onMessage(results("", false, false, { start: 0.4, duration: 0.3 }));
    const final = await client.next("final");
    assert.equal(final.type === "final" && final.transcript, "A comedy.");
  });

  it("never offers a partial as the final", async () => {
    reset();
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    await client.next("ready");
    client.socket.send(Buffer.alloc(3_200, 1));
    upstream.handlers!.onMessage(results("a scary"));
    await client.next("partial");
    client.socket.send(JSON.stringify({ type: "stop" }));
    // SLNG closes without finalizing: the stream reports failure, and the browser uploads instead.
    await tick();
    upstream.handlers!.onClose();
    const error = await client.next("error");
    assert.equal(error.type === "error" && error.code, "STREAM_UPSTREAM");
    assert.equal(client.messages.some((message) => message.type === "final"), false);
  });

  it("refuses a viewer Supabase does not recognise before opening SLNG", async () => {
    reset({ verifyViewer: async () => false });
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    const error = await client.next("error");
    assert.equal(error.type === "error" && error.code, "UNAUTHENTICATED");
    assert.equal(upstream.handlers, null);
  });

  it("says voice is off when SLNG is not configured", async () => {
    reset({ connectUpstream: null });
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    const error = await client.next("error");
    assert.equal(error.type === "error" && error.code, "VOICE_DISABLED");
  });

  it("refuses malformed messages and oversized frames", async () => {
    reset();
    const bad = await connect();
    bad.socket.send(JSON.stringify({ type: "start", accessToken: "token", extra: true }));
    assert.equal((await bad.next("error")).type, "error");

    reset();
    const big = await connect();
    big.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    await big.next("ready");
    big.socket.send(Buffer.alloc(STREAM_LIMITS.maxFrameBytes + 1));
    // ws refuses an oversized frame itself with 1009.
    assert.equal(await big.closed, 1009);
  });

  it("fails when SLNG reports an error or sends something unreadable", async () => {
    reset();
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    await client.next("ready");
    upstream.handlers!.onMessage(JSON.stringify({ type: "error", code: "config_error", message: "no" }));
    const error = await client.next("error");
    assert.equal(error.type === "error" && error.code, "STREAM_UPSTREAM");
  });

  it("answers an empty final when stop arrives before any audio", async () => {
    reset();
    const client = await connect();
    client.socket.send(JSON.stringify({ type: "start", accessToken: "token" }));
    await client.next("ready");
    client.socket.send(JSON.stringify({ type: "stop" }));
    const final = await client.next("final");
    assert.equal(final.type === "final" && final.transcript, "");
  });

  it("refuses a cross-origin socket at the upgrade", async () => {
    reset();
    await assert.rejects(connect("https://elsewhere.example"), /403/);
  });
});
