import assert from "node:assert/strict";
import { test } from "node:test";
import { projectImportedScript, ScriptImportError } from "../src/core/scriptImport";
import { DEFAULT_SCRIPT_FORMAT, totalDurationSeconds } from "../src/core/script";

test("projects imported text into bounded timed portions", () => {
  const markdown = Array.from({ length: 80 }, (_, index) => `Beat ${index + 1} moves the story forward.`).join(" ");
  const script = projectImportedScript("Imported story", markdown, DEFAULT_SCRIPT_FORMAT);
  assert.equal(totalDurationSeconds(script), 240);
  assert.equal(script.scenes.length, 1);
  assert.ok(script.scenes[0].portions.length > 1);
  assert.ok(script.scenes[0].portions.every((portion) => portion.action.length <= 600));
  assert.equal(script.scenes[0].portions.map((portion) => portion.action).join(" "), markdown);
});

test("rejects text that cannot fit the selected runtime", () => {
  assert.throws(
    () => projectImportedScript("Too much", "word ".repeat(5000), DEFAULT_SCRIPT_FORMAT),
    ScriptImportError,
  );
});

test("rejects a script too short to fill the runtime", () => {
  assert.throws(
    () => projectImportedScript("Tiny", "A very short note.", DEFAULT_SCRIPT_FORMAT),
    ScriptImportError,
  );
});

test("splits imported text on word boundaries", () => {
  const markdown = Array.from(
    { length: 60 },
    (_, index) => `Sentence number ${index + 1} carries the story forward.`,
  ).join(" ");
  const script = projectImportedScript("Imported story", markdown, DEFAULT_SCRIPT_FORMAT);
  const portions = script.scenes[0].portions;
  assert.ok(portions.length > 1);
  assert.deepEqual(
    portions.map((portion) => portion.action).join(" ").split(" "),
    markdown.split(" "),
  );
});
