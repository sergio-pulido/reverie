import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMediaPlaylist,
  HlsSegmentWindow,
  type HlsSegment,
} from "../src/core/hlsPlaylist";

const uri = (sequence: number) => `segment/${sequence}.m4s`;

function playlist(segments: HlsSegment[], ended = false): string {
  return buildMediaPlaylist({ segments, initUri: "init.mp4", segmentUri: uri, ended });
}

test("a live playlist names its init segment and starts at the window's first sequence", () => {
  const text = playlist([
    { sequence: 12, durationSeconds: 1 },
    { sequence: 13, durationSeconds: 1 },
  ]);
  assert.match(text, /^#EXTM3U\n/);
  // Version 7 is the floor for EXT-X-MAP; an fMP4 playlist below it is invalid.
  assert.match(text, /#EXT-X-VERSION:7\n/);
  assert.match(text, /#EXT-X-MAP:URI="init\.mp4"\n/);
  // The media sequence is the first segment still in the window, not zero, or
  // a player that joins late replays numbers that were already evicted.
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:12\n/);
  assert.ok(text.includes("segment/12.m4s"));
  assert.ok(text.includes("segment/13.m4s"));
});

test("the target duration is rounded up, never down", () => {
  // The spec requires it to be >= every segment it describes. Rounding 1.4 down
  // to 1 makes players treat the whole playlist as malformed.
  assert.match(playlist([{ sequence: 0, durationSeconds: 1.4 }]), /#EXT-X-TARGETDURATION:2\n/);
  assert.match(playlist([{ sequence: 0, durationSeconds: 3.0 }]), /#EXT-X-TARGETDURATION:3\n/);
});

test("an empty window is still a valid playlist", () => {
  // The first viewer can arrive before the first segment is muxed. Serving a
  // playlist with no segments is correct; serving nothing is a 404 they retry.
  const text = playlist([]);
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:0\n/);
  assert.match(text, /#EXT-X-TARGETDURATION:1\n/);
  assert.ok(!text.includes("#EXTINF"));
});

test("only a stopped stream gets an endlist", () => {
  assert.ok(!playlist([{ sequence: 0, durationSeconds: 1 }]).includes("#EXT-X-ENDLIST"));
  // Without ENDLIST the player polls forever and the film never ends.
  assert.ok(playlist([{ sequence: 0, durationSeconds: 1 }], true).includes("#EXT-X-ENDLIST"));
});

test("a live playlist claims neither VOD nor EVENT", () => {
  // Both are promises this window breaks: it changes, and it drops segments.
  assert.ok(!playlist([{ sequence: 0, durationSeconds: 1 }]).includes("#EXT-X-PLAYLIST-TYPE"));
});

test("the window slides, and evicted sequence numbers are never reused", () => {
  const window = new HlsSegmentWindow(2);
  window.append(0, 1, new Uint8Array([1]));
  window.append(1, 1, new Uint8Array([2]));
  window.append(2, 1, new Uint8Array([3]));
  assert.deepEqual(
    window.segments.map((segment) => segment.sequence),
    [1, 2],
  );
  // Segment 0 is gone rather than recycled: a stalled player asking for it must
  // be told it is gone, not handed a different part of the film.
  assert.equal(window.data(0), undefined);
  assert.deepEqual(window.data(2), new Uint8Array([3]));
});

test("the window numbers segments the way it is told to, not its own way", () => {
  // Live delivery and the durable archive publish the same segments, and the
  // audit refers to them by index. A counter of its own here would be a second
  // timeline for that record to drift against.
  const window = new HlsSegmentWindow(3);
  window.append(41, 1, new Uint8Array([1]));
  window.append(42, 1, new Uint8Array([2]));
  assert.deepEqual(
    window.segments.map((segment) => segment.sequence),
    [41, 42],
  );
  assert.deepEqual(window.data(41), new Uint8Array([1]));
});

test("the window bounds what it holds in memory", () => {
  const window = new HlsSegmentWindow(3);
  for (let index = 0; index < 50; index += 1) {
    window.append(index, 1, new Uint8Array(1000));
  }
  assert.equal(window.segments.length, 3);
  assert.equal(window.heldBytes, 3000);
});

test("a window must have room for at least one segment", () => {
  assert.throws(() => new HlsSegmentWindow(0), /hls_window_capacity_invalid/);
  assert.throws(() => new HlsSegmentWindow(1.5), /hls_window_capacity_invalid/);
});
