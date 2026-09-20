import { cleanup, click, render, settle } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JamDirector } from "../src/screens/JamDirector";
import { DEFAULT_CONFIGURATION } from "../src/core/configuration";

afterEach(cleanup);

const JAM = "11111111-1111-4111-8111-111111111111";

/**
 * Answers the reads the screen makes on mount.
 *
 * Only the lifecycle and archive calls matter here; anything else the screen
 * asks for gets an empty object, so a new call elsewhere does not fail these
 * tests for the wrong reason.
 */
function serve(
  lifecycle: string,
  sessions: { id: string }[] = [],
  pieces: { segmentIndex: number; startSeconds: number; durationSeconds: number }[] = [],
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input.toString());
    if (url.endsWith(`/api/jams/${JAM}`)) {
      return new Response(JSON.stringify({ jam: { lifecycle } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/director/archive")) {
      return new Response(JSON.stringify({ durable: true, sessions }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/director\/archive\/[^/]+$/.test(url)) {
      return new Response(
        JSON.stringify({
          durable: true,
          session: { complete: true, container: "webm" },
          segments: pieces,
          durationSeconds: pieces.reduce((total, piece) => total + piece.durationSeconds, 0),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith(`/api/jams/${JAM}/director/session`)) {
      return new Response(
        JSON.stringify({
          error: {
            code: "no_stream",
            safeMessage: "Nobody is streaming this configuration yet.",
            retryable: true,
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function badge(): string {
  const node = document.querySelector('[data-testid="jam-lifecycle"]');
  return node?.textContent?.trim() ?? "";
}

describe("the room shows where it is in its life", () => {
  it("a new room reads live and offers to play", async () => {
    const restore = serve("live");
    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      assert.equal(badge(), "LIVE");
      const play = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-play"]');
      assert.equal(play?.disabled, false);
    } finally {
      restore();
    }
  });

  it("gives everyone in the room the same two signals, and no third one", async () => {
    // Nobody owns the take. This screen is handed no role at all, which is the
    // point: the person who joined a jam sees the same controls as the person
    // who registered it. Two controls, and no free-text direction field —
    // steering a take belongs to the outline queue, not to a box beside the
    // player that bypasses it.
    const restore = serve("live");
    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      assert.ok(document.querySelector('[data-testid="jam-director-play"]'), "anybody can play");
      assert.ok(document.querySelector('[data-testid="jam-director-stop"]'), "anybody can stop");
      assert.equal(document.querySelector(".field input"), null, "and nobody types at the player");
    } finally {
      restore();
    }
  });

  it("swaps the emphasis to Stop once a take is running", async () => {
    // The only thing worth pressing while a take runs is the one that stops
    // the per-second bill.
    const restore = serve("live");
    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      const play = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-play"]');
      const stop = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-stop"]');
      assert.ok(play?.className.includes("button-primary"), "idle: Play is the offer");
      assert.equal(play?.disabled, false);
      assert.ok(stop?.className.includes("button-quiet"));
      assert.equal(stop?.disabled, true, "there is nothing to stop yet");
    } finally {
      restore();
    }
  });

  it("while a take runs: Stop is the offer, Play is disabled, and the cost is current", async () => {
    const original = globalThis.fetch;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input.toString());
      if (url.endsWith(`/api/jams/${JAM}`)) return json({ jam: { lifecycle: "playing" } });
      if (url.endsWith("/director/limits")) {
        return json({ configured: true, maxSessionSeconds: 120 });
      }
      if (url.endsWith(`/api/jams/${JAM}/director/session`) && init?.method === "POST") {
        return json({
          sessionId: "sess-live",
          viewerId: "viewer-1",
          attached: true,
          liveDelivery: true,
          recordingDurable: true,
          maxSessionSeconds: 120,
          lifecycle: "playing",
          state: {
            status: "streaming",
            appliedPromptVersion: 2,
            sentPromptVersion: 2,
            chunksReceived: 3,
            generatedSeconds: 45,
            scriptOffsetSeconds: null,
            endedReason: null,
            error: null,
          },
          beats: null,
        });
      }
      if (url.endsWith("/director/session/sess-live")) {
        return json({
          state: {
            status: "streaming",
            appliedPromptVersion: 2,
            sentPromptVersion: 2,
            chunksReceived: 3,
            generatedSeconds: 45,
            scriptOffsetSeconds: null,
            endedReason: null,
            error: null,
          },
          beats: null,
          audit: [],
        });
      }
      return json({});
    }) as typeof fetch;

    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      await settle();

      const play = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-play"]');
      const stop = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-stop"]');
      assert.equal(play?.disabled, true, "a running take cannot be started again");
      assert.ok(play?.className.includes("button-quiet"), "Play recedes");
      assert.ok(stop?.className.includes("button-primary"), "Stop is what the eye lands on");
      assert.equal(stop?.disabled, false);

      // What the take is doing, from the server's own figures, while it runs.
      const take = text('[data-testid="jam-director-take"]');
      assert.match(take, /This take is running/);
      assert.match(take, /stops itself after 2:00/);
      // And what it is doing.
      assert.match(text('[data-testid="jam-director-status"]'), /Playing · 0:45 generated across 3 chunk/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("says what a take will commit before anybody presses Play", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input.toString());
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith(`/api/jams/${JAM}`)) return json({ jam: { lifecycle: "live" } });
      if (url.endsWith("/director/limits")) {
        return json({ configured: true, maxSessionSeconds: 120 });
      }
      if (url.endsWith(`/api/jams/${JAM}/director/session`)) {
        return json(
          { error: { code: "no_stream", safeMessage: "Nobody is streaming.", retryable: true } },
          404,
        );
      }
      return json({});
    }) as typeof fetch;

    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      await settle();
      const take = text('[data-testid="jam-director-take"]');
      assert.match(take, /Play opens a live session with the provider/);
      // The self-stop is the fact that surprises: a take ends on its own
      // whether or not the room is done with it.
      assert.match(take, /stops itself after 2:00/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a stopped room plays its recording, and can be played again", async () => {
    const restore = serve(
      "ended",
      [{ id: "sess-1" }],
      [
        { segmentIndex: 0, startSeconds: 0, durationSeconds: 10 },
        { segmentIndex: 1, startSeconds: 10, durationSeconds: 10 },
        { segmentIndex: 2, startSeconds: 20, durationSeconds: 7 },
      ],
    );
    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      assert.equal(badge(), "STOPPED");

      // The recording is the artifact of the take that stopped, so it is offered.
      const player = document.querySelector<HTMLVideoElement>(
        '[data-testid="jam-director-recording"]',
      );
      assert.ok(player, "a finished room shows a player");
      assert.equal(
        document.querySelectorAll('[data-testid="jam-director-recording"]').length,
        1,
        "the finished recording is rendered once",
      );
      assert.match(player.getAttribute("src") ?? "", /\/director\/archive\/sess-1\/video$/);

      // And the room is not retired: the next take is one press away, because
      // a stop anybody can send must not be able to end the room for good.
      const play = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-play"]');
      assert.equal(play?.disabled, false);

      // The film is in pieces, so the viewer can go straight to a moment. The
      // piece list arrives on a second read, so the render is given time to settle.
      await settle();
      const jump = document.querySelector<HTMLButtonElement>('[data-testid="jam-piece-1"]');
      assert.ok(jump, "a piece per moment is offered");
      assert.equal(jump.textContent?.trim(), "0:10");
      await click(jump);
      assert.match(
        player.getAttribute("src") ?? "",
        /\/director\/archive\/sess-1\/pieces\/1$/,
      );
    } finally {
      restore();
    }
  });

  it("a stopped session with no stored pieces does not render a broken player", async () => {
    const restore = serve("ended", [{ id: "sess-empty" }], []);
    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      await settle();
      assert.equal(badge(), "STOPPED");
      assert.equal(
        document.querySelector('[data-testid="jam-director-recording"]'),
        null,
      );
    } finally {
      restore();
    }
  });

  it("says why a refused Play was refused, next to Play", async () => {
    // A server with no director configured is the commonest refusal, and it
    // used to be reported at the foot of the card, under the direction log and
    // a paragraph of notes — far enough from the button to read as the press
    // having done nothing at all.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input.toString());
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith(`/api/jams/${JAM}`)) return json({ jam: { lifecycle: "live" } });
      if (url.endsWith(`/api/jams/${JAM}/director/session`) && init?.method === "POST") {
        return json(
          {
            error: {
              code: "director_disabled",
              safeMessage: "The live director is not configured on this server.",
              retryable: false,
            },
          },
          503,
        );
      }
      return json({});
    }) as typeof fetch;

    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      const play = document.querySelector<HTMLButtonElement>('[data-testid="jam-director-play"]');
      await click(play);
      await settle();

      const notice = document.querySelector<HTMLElement>(".notice");
      assert.ok(notice, "the refusal is on screen");
      assert.match(notice.textContent ?? "", /not configured on this server/);
      // Next to the control that was pressed, not at the foot of the card.
      assert.ok(
        play?.compareDocumentPosition(notice) === Node.DOCUMENT_POSITION_FOLLOWING,
        "the refusal follows the button that was refused",
      );
      assert.ok(
        notice.compareDocumentPosition(
          document.querySelector('[data-testid="jam-director-take"]')!,
        ) === Node.DOCUMENT_POSITION_FOLLOWING,
        "and sits with the controls rather than at the foot of the card",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("lets go of a session somebody else stopped, and shows that take", async () => {
    // Anybody in the room can send the stop signal, so most stops arrive from
    // another browser. A screen that only learned about its own Stop would sit
    // on a dead player until it was reopened.
    const original = globalThis.fetch;
    let lifecycle = "playing";
    let sessionOpen = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input.toString());
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith(`/api/jams/${JAM}`)) return json({ jam: { lifecycle } });
      if (url.endsWith(`/api/jams/${JAM}/director/session`) && init?.method === "POST") {
        if (!sessionOpen) {
          return json(
            { error: { code: "no_stream", safeMessage: "Nobody is streaming.", retryable: true } },
            404,
          );
        }
        return json({
          sessionId: "sess-1",
          viewerId: "viewer-1",
          attached: true,
          liveDelivery: false,
          recordingDurable: true,
          lifecycle,
          state: {
            status: "streaming",
            appliedPromptVersion: 1,
            sentPromptVersion: 1,
            chunksReceived: 1,
            generatedSeconds: 4,
            scriptOffsetSeconds: null,
            endedReason: null,
            error: null,
          },
          beats: null,
        });
      }
      if (url.endsWith("/director/session/sess-1")) {
        // Between joining the stream and this first read of it, somebody else
        // in the room pressed Stop.
        sessionOpen = false;
        lifecycle = "ended";
        return json(
          { error: { code: "not_found", safeMessage: "That director session is not open.", retryable: false } },
          404,
        );
      }
      if (url.endsWith("/director/archive")) return json({ durable: true, sessions: [{ id: "sess-1" }] });
      if (/\/director\/archive\/[^/]+$/.test(url)) {
        return json({
          durable: true,
          session: { complete: true, container: "webm" },
          segments: [{ segmentIndex: 0, startSeconds: 0, durationSeconds: 8 }],
          durationSeconds: 8,
        });
      }
      return json({});
    }) as typeof fetch;

    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      await settle(6);

      assert.equal(badge(), "STOPPED");
      assert.equal(
        document.querySelector<HTMLButtonElement>('[data-testid="jam-director-stop"]')?.disabled,
        true,
        "there is nothing left to stop",
      );
      assert.ok(
        document.querySelector('[data-testid="jam-director-recording"]'),
        "the take that just stopped is what the room shows",
      );
      assert.equal(
        document.querySelector<HTMLButtonElement>('[data-testid="jam-director-play"]')?.disabled,
        false,
        "and the next take is one press away",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("detaches a viewer allocated after the screen has unmounted", async () => {
    const original = globalThis.fetch;
    let answerAttach!: (response: Response) => void;
    const attachResponse = new Promise<Response>((resolve) => {
      answerAttach = resolve;
    });
    const detached: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input.toString());
      if (url.endsWith(`/api/jams/${JAM}`)) {
        return new Response(JSON.stringify({ jam: { lifecycle: "live" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith(`/api/jams/${JAM}/director/session`) && init?.method === "POST") {
        return attachResponse;
      }
      if (url.endsWith("/director/session/session-late/end")) {
        detached.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ lifecycle: "playing" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      await cleanup();
      answerAttach(
        new Response(JSON.stringify({ sessionId: "session-late", viewerId: "viewer-late" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await settle();
      assert.deepEqual(detached, [{ viewerId: "viewer-late" }]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
