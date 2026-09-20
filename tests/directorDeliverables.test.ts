import assert from "node:assert/strict";
import test from "node:test";
import { renderTimedOutline } from "../src/core/timedOutline";
import { deliverablesOf, fileStem, type DeliverableInput } from "../src/director/deliverables";
import { buildScript } from "./helpers";

const SCRIPT = buildScript(5, 2, 2);
const BASE: DeliverableInput = {
  jamId: "6f2f8f4e-1f3a-4a0a-9a1a-000000000000",
  script: SCRIPT,
  scriptMissing: null,
  live: false,
  recording: null,
  recordingDurable: true,
};

function row(input: Partial<DeliverableInput>, id: string) {
  const found = deliverablesOf({ ...BASE, ...input }).find((item) => item.id === id);
  assert.ok(found, `${id} is offered`);
  return found;
}

test("the drawer offers exactly the four deliverables, always in the same order", () => {
  assert.deepEqual(deliverablesOf(BASE).map((item) => item.id), [
    "script",
    "timed",
    "audio-description",
    "video",
  ]);
});

test("the script is served by the server, and only when the server holds one", () => {
  const ready = row({}, "script");
  assert.equal(ready.state, "ready");
  assert.equal(ready.href, `/api/jams/${BASE.jamId}/script.md`);
  assert.equal(ready.missing, undefined);

  const absent = row({ script: null, scriptMissing: "This server holds no script." }, "script");
  assert.equal(absent.state, "absent");
  assert.equal(absent.href, undefined, "nothing to fetch, so no address to fetch it from");
  assert.equal(absent.missing, "This server holds no script.");
});

test("the timed script is written here from the script, not fetched", () => {
  const timed = row({}, "timed");
  assert.equal(timed.state, "ready");
  assert.equal(timed.href, undefined);
  const file = timed.build?.();
  assert.equal(file?.filename, "the-salt-door-timed.md");
  assert.equal(file?.text, renderTimedOutline(SCRIPT));
});

test("the audio description is absent, and says what is missing rather than offering a download", () => {
  const audio = row({}, "audio-description");
  assert.equal(audio.state, "absent");
  assert.equal(audio.href, undefined);
  assert.equal(audio.build, undefined);
  assert.match(audio.missing ?? "", /no describer/i);
});

test("the video is absent before a session, generating during one, ready after it", () => {
  assert.equal(row({}, "video").state, "absent");
  assert.equal(row({}, "video").href, undefined);

  const running = row({ live: true }, "video");
  assert.equal(running.state, "generating");
  assert.equal(running.href, undefined, "a file being made cannot be downloaded");

  const done = row({ recording: "/api/jams/x/director/recordings/y" }, "video");
  assert.equal(done.state, "ready");
  assert.equal(done.href, "/api/jams/x/director/recordings/y");
  assert.equal(done.missing, undefined);
});

test("a recording a server cannot keep is offered, and says it will not survive a restart", () => {
  const fragile = row(
    { recording: "/api/jams/x/director/recordings/y", recordingDurable: false },
    "video",
  );
  assert.equal(fragile.state, "ready");
  assert.match(fragile.missing ?? "", /lost when the process restarts/);
});

test("no row is ever both absent and downloadable", () => {
  for (const input of [
    BASE,
    { ...BASE, script: null, scriptMissing: null },
    { ...BASE, live: true },
    { ...BASE, recording: "/x", recordingDurable: false },
  ]) {
    for (const item of deliverablesOf(input)) {
      if (item.state === "ready") continue;
      assert.equal(item.href, undefined, `${item.id} offers no address`);
      assert.equal(item.build, undefined, `${item.id} builds no file`);
      assert.ok(item.missing, `${item.id} says why`);
    }
  }
});

test("a jam with no id cannot be asked for its script, whatever the script says", () => {
  const item = row({ jamId: null }, "script");
  assert.equal(item.state, "absent");
});

test("a file name is made of letters, digits and dashes, and never empty", () => {
  assert.equal(fileStem("The Salt Door"), "the-salt-door");
  assert.equal(fileStem("  ¿Qué? / ¡Ya!  "), "qu-ya");
  assert.equal(fileStem("···"), "movie-jam");
});

test("the timed outline is the script's own numbers, and says when a beat has no phrase", () => {
  const text = renderTimedOutline(SCRIPT);
  assert.match(text, /# The Salt Door — timed outline/);
  assert.match(text, /Runtime: 0:20 \(20s\) across 4 beats/);
  assert.match(text, /\| 1 \| 0:00 \| 0:05 \| 5s \| Beat 1 \| — \|/);
  assert.match(text, /\| 4 \| 0:15 \| 0:20 \| 5s \| Beat 2 \| — \|/);
  assert.match(text, /4 beats have no phrase/);
  assert.match(text, /not an existing film or catalogue title/);
});

test("a beat's own phrase is used when it has one, and a pipe cannot break the table", () => {
  const withSummaries = {
    ...SCRIPT,
    scenes: [
      {
        heading: "Open | wide",
        portions: [{ ...SCRIPT.scenes[0].portions[0], summary: "She opens the door | slowly" }],
      },
    ],
  };
  const text = renderTimedOutline(withSummaries);
  assert.match(text, /\| 1 \| 0:00 \| 0:05 \| 5s \| Open \\\| wide \| She opens the door \\\| slowly \|/);
  assert.doesNotMatch(text, /have no phrase/);
});
