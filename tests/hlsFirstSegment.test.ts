import assert from "node:assert/strict";
import test from "node:test";
import { waitForFirstSegment } from "../src/lib/hlsPlayback";

/**
 * Why a live playlist is not attached the moment it exists.
 *
 * A director playlist is served before its first segment is muxed: the provider
 * takes seconds to send a chunk and the muxer needs a keyframe, so until then
 * the playlist is a valid header with no `#EXTINF` and an `EXT-X-MAP` naming an
 * `init.mp4` that 404s. Handed that, hls.js counts a level error, exhausts its
 * retries, excludes the only level there is and stops for good — the frame then
 * stays black even after segments appear, which is exactly what made "click Play
 * and nothing happens" survive the muxer fix.
 */

const EMPTY = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:1",
  "#EXT-X-MEDIA-SEQUENCE:0",
  '#EXT-X-MAP:URI="init.mp4"',
].join("\n");
const SERVING = `${EMPTY}\n#EXTINF:10.400,\nsegment/0.m4s\n`;

function playlists(bodies: (string | number)[]) {
  let at = 0;
  const seen: string[] = [];
  const fetchPlaylist = (async (url: string) => {
    seen.push(String(url));
    const body = bodies[Math.min(at, bodies.length - 1)];
    at += 1;
    if (typeof body === "number") return { ok: false, status: body, text: async () => "" } as Response;
    return { ok: true, status: 200, text: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetchPlaylist, seen, calls: () => at };
}

const immediately = { wait: async () => undefined };

test("waits through an empty playlist and attaches once a segment is listed", async () => {
  const { fetchPlaylist, calls } = playlists([EMPTY, EMPTY, SERVING]);
  const ready = await waitForFirstSegment("/playlist.m3u8", {
    cancelled: () => false,
    fetchPlaylist,
    ...immediately,
  });
  assert.equal(ready, true);
  assert.equal(calls(), 3, "polled until the first segment appeared");
});

test("a 404 before the session serves is waited through, not treated as failure", async () => {
  const { fetchPlaylist } = playlists([404, 404, SERVING]);
  assert.equal(
    await waitForFirstSegment("/playlist.m3u8", { cancelled: () => false, fetchPlaylist, ...immediately }),
    true,
  );
});

test("a playlist that never serves a segment gives up rather than waiting forever", async () => {
  let clock = 0;
  const { fetchPlaylist } = playlists([EMPTY]);
  const ready = await waitForFirstSegment("/playlist.m3u8", {
    cancelled: () => false,
    fetchPlaylist,
    now: () => (clock += 10_000),
    ...immediately,
  });
  assert.equal(ready, false);
});

test("detaching mid-wait stops the poll instead of attaching later", async () => {
  let cancelled = false;
  const { fetchPlaylist, calls } = playlists([EMPTY, EMPTY, SERVING]);
  const ready = await waitForFirstSegment("/playlist.m3u8", {
    cancelled: () => cancelled,
    fetchPlaylist,
    wait: async () => { cancelled = true; },
  });
  assert.equal(ready, false, "a viewer who left is never attached");
  assert.equal(calls(), 1);
});

test("the token travels with the poll, since the archived playlist is authorized", async () => {
  const headers: unknown[] = [];
  const fetchPlaylist = (async (_url: string, init: RequestInit) => {
    headers.push(init.headers);
    return { ok: true, status: 200, text: async () => SERVING } as Response;
  }) as unknown as typeof fetch;
  await waitForFirstSegment("/playlist.m3u8", {
    cancelled: () => false,
    fetchPlaylist,
    accessToken: "abc",
    ...immediately,
  });
  assert.deepEqual(headers[0], { authorization: "Bearer abc" });
});
