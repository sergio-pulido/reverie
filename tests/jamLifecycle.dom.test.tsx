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
  it("a new room reads live and offers to start", async () => {
    const restore = serve("live");
    try {
      await render(<JamDirector jamId={JAM} canDrive configuration={DEFAULT_CONFIGURATION} />);
      assert.equal(badge(), "LIVE");
      const start = document.querySelector<HTMLButtonElement>(".button-primary");
      assert.equal(start?.disabled, false);
    } finally {
      restore();
    }
  });

  it("an ended room reads ended and plays its recording instead of restarting", async () => {
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
      await render(<JamDirector jamId={JAM} canDrive configuration={DEFAULT_CONFIGURATION} />);
      assert.equal(badge(), "ENDED");

      // The recording is the artifact of a finished room, so it is offered.
      const player = document.querySelector<HTMLVideoElement>(
        '[data-testid="jam-director-recording"]',
      );
      assert.ok(player, "a finished room shows a player");
      assert.match(player.getAttribute("src") ?? "", /\/director\/archive\/sess-1\/video$/);

      // And starting again is not on offer: the server would refuse it.
      const start = document.querySelector<HTMLButtonElement>(".button-primary");
      assert.equal(start?.disabled, true);

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
});
