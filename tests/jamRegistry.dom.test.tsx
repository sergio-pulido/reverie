import { cleanup, render, settle } from "./render";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JamRegistry } from "../src/screens/JamRegistry";

afterEach(cleanup);

const PLAYING = "11111111-1111-4111-8111-111111111111";
const STOPPED = "22222222-2222-4222-8222-222222222222";

/**
 * Two rooms in this browser's registry, both carrying the legacy `draft`
 * status the database used to default to and nothing ever moved off.
 */
function seed() {
  window.localStorage.setItem(
    "reverie.preview-jams.v1",
    JSON.stringify([
      {
        id: PLAYING,
        slug: "the-blink",
        title: "The Blink",
        premise: "A signal changes what the room thinks is possible.",
        visibility: "public",
        status: "draft",
      },
      {
        id: STOPPED,
        slug: "the-understudy",
        title: "The Understudy",
        premise: "Someone takes a part that was never offered.",
        visibility: "invite_only",
        status: "draft",
      },
    ]),
  );
}

function serve(lifecycles: Record<string, string>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input.toString());
    const id = Object.keys(lifecycles).find((candidate) => url.endsWith(`/api/jams/${candidate}`));
    if (id) {
      return new Response(JSON.stringify({ jam: { lifecycle: lifecycles[id] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    window.localStorage.clear();
  };
}

describe("the registry says where each room actually is", () => {
  it("reads the server's lifecycle, and never shows the legacy draft status", async () => {
    seed();
    const restore = serve({ [PLAYING]: "playing", [STOPPED]: "ended" });
    try {
      await render(<JamRegistry onNew={() => {}} onOpen={() => {}} onDirect={() => {}} />);
      await settle();

      const state = (id: string) =>
        document.querySelector(`[data-testid="jam-state-${id}"]`)?.textContent ?? "";
      assert.match(state(PLAYING), /^PLAYING · PUBLIC$/);
      assert.match(state(STOPPED), /^STOPPED · INVITE ONLY$/);
      // The word the rows still carry, and which nothing could ever change.
      assert.doesNotMatch(document.body.textContent ?? "", /DRAFT/);
    } finally {
      restore();
    }
  });

  it("a room this server has never run is live, not unknown", async () => {
    seed();
    // Nothing answers for these rooms: the server does not hold them.
    const restore = serve({});
    try {
      await render(<JamRegistry onNew={() => {}} onOpen={() => {}} onDirect={() => {}} />);
      await settle();
      const state = document.querySelector(`[data-testid="jam-state-${PLAYING}"]`)?.textContent ?? "";
      assert.match(state, /^LIVE · PUBLIC$/);
    } finally {
      restore();
    }
  });
});
