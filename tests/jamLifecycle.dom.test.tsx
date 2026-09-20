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

  it("gives everyone in the room the same two signals and the direction box", async () => {
    // Nobody owns the take. This screen is handed no role at all, which is the
    // point: the person who joined a jam sees the same controls as the person
    // who registered it.
    const restore = serve("live");
    try {
      await render(<JamDirector jamId={JAM} configuration={DEFAULT_CONFIGURATION} />);
      assert.ok(document.querySelector('[data-testid="jam-director-play"]'), "anybody can play");
      assert.ok(document.querySelector('[data-testid="jam-director-stop"]'), "anybody can stop");
      assert.ok(document.querySelector(".field input"), "anybody can direct");
    } finally {
      restore();
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
