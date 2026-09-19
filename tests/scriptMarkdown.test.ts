import assert from "node:assert/strict";
import { test } from "node:test";
import { formatClock, renderScriptMarkdown } from "../src/core/scriptMarkdown";
import { buildScript } from "./helpers";

test("renders the whole idea as markdown with timed scene portions", () => {
  const markdown = renderScriptMarkdown(buildScript(15), {
    kind: "from-scratch",
    prompt: "A lighthouse keeper finds a door.",
  });
  assert.ok(markdown.startsWith("# The Salt Door"));
  assert.match(markdown, /> A lighthouse keeper finds a door at the bottom of the sea\./);
  assert.match(markdown, /Runtime: 4:00 \(240s\) across 4 scenes and 16 scene portions/);
  assert.match(markdown, /## Scene 1 — Beat 1/);
  assert.match(markdown, /### Portion 1\.1 · 0:00–0:15 \(15s\)/);
  assert.match(markdown, /### Portion 4\.4 · 3:45–4:00 \(15s\)/);
  assert.match(markdown, /generated Movie Jam script/);
});

test("names the movie when a jam starts from an existing film", () => {
  const markdown = renderScriptMarkdown(buildScript(15), {
    kind: "from-movie",
    movieTitle: "Solaris",
  });
  assert.match(markdown, /inspired by “Solaris”/);
});

test("formats clocks as m:ss", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(240), "4:00");
});
