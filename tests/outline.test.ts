import assert from "node:assert/strict";
import { test } from "node:test";
import { beatAt, buildOutline } from "../src/core/outline";
import {
  applyCascade,
  buildCascadePrompt,
  OutlineCascadeError,
} from "../src/core/outlineCascade";
import { beatOffsets } from "../src/core/directorBeats";
import { jamScriptSchema, type JamScript } from "../src/core/script";

/**
 * Two scenes, three portions, distinct durations so offsets are unambiguous.
 * Durations stay inside the video model's [5, 15] second band, which the script
 * schema enforces — a fixture outside it fails validation, not the assertion.
 */
function scriptOf(): JamScript {
  return jamScriptSchema.parse({
    title: "The Key",
    logline: "Someone loses what they need.",
    scenes: [
      {
        heading: "INT. HALLWAY",
        portions: [
          { durationSeconds: 5, summary: "she finds the key", action: "She kneels." },
          { durationSeconds: 10, summary: "she pockets it", action: "She stands." },
        ],
      },
      {
        heading: "INT. CELLAR",
        portions: [
          { durationSeconds: 15, summary: "she unlocks the cellar", action: "The door gives." },
        ],
      },
    ],
  });
}

test("outline flattens scenes into beats with cumulative offsets", () => {
  const beats = buildOutline(scriptOf());
  assert.deepEqual(
    beats.map((beat) => [beat.portionIndex, beat.startSeconds, beat.sceneIndex]),
    [
      [0, 0, 0],
      [1, 5, 0],
      [2, 15, 1],
    ],
  );
  assert.equal(beats[2].sceneHeading, "INT. CELLAR");
  assert.equal(beats[0].summary, "she finds the key");
});

test("a stream that has not reported a position is on no beat at all", () => {
  // Not the opening beat: "nothing is playing" and "the first beat is playing"
  // are different claims, and direction must not be sent against the second
  // when only the first is true.
  const beats = buildOutline(scriptOf());
  assert.equal(beatAt(beats, null), null);
});

test("a stream offset lands on the beat that contains it", () => {
  const beats = buildOutline(scriptOf());
  assert.equal(beatAt(beats, 0)?.portionIndex, 0);
  assert.equal(beatAt(beats, 4)?.portionIndex, 0);
  assert.equal(beatAt(beats, 5)?.portionIndex, 1);
  assert.equal(beatAt(beats, 14)?.portionIndex, 1);
  assert.equal(beatAt(beats, 15)?.portionIndex, 2);
  assert.equal(beatAt(beats, 999)?.portionIndex, 2);
});

test("the outline's offsets are the director's, not a second timeline", () => {
  const script = scriptOf();
  assert.deepEqual(
    buildOutline(script).map((beat) => beat.startSeconds),
    beatOffsets(script),
  );
});

test("a cascade rewrites the tail and leaves settled beats alone", () => {
  const next = applyCascade(scriptOf(), 1, [
    { summary: "she drops it", action: "It rings on the tile." },
    { summary: "she forces the cellar door", action: "Wood splinters." },
  ]);
  const beats = buildOutline(next);
  assert.equal(beats[0].summary, "she finds the key");
  assert.equal(beats[1].summary, "she drops it");
  assert.equal(beats[2].summary, "she forces the cellar door");
});

test("a cascade never changes durations, so the runtime cannot drift", () => {
  const before = scriptOf();
  const next = applyCascade(before, 0, [
    { summary: "a", action: "a" },
    { summary: "b", action: "b" },
    { summary: "c", action: "c" },
  ]);
  assert.deepEqual(
    buildOutline(next).map((beat) => beat.durationSeconds),
    buildOutline(before).map((beat) => beat.durationSeconds),
  );
});

test("a cascade never changes the scene structure that indices address", () => {
  const next = applyCascade(scriptOf(), 0, [
    { summary: "a", action: "a" },
    { summary: "b", action: "b" },
    { summary: "c", action: "c" },
  ]);
  assert.deepEqual(
    next.scenes.map((scene) => [scene.heading, scene.portions.length]),
    [
      ["INT. HALLWAY", 2],
      ["INT. CELLAR", 1],
    ],
  );
});

test("a cascade that does not cover the tail exactly is refused", () => {
  assert.throws(
    () => applyCascade(scriptOf(), 1, [{ summary: "only one", action: "x" }]),
    (error: unknown) =>
      error instanceof OutlineCascadeError && error.code === "invalid_cascade",
  );
  assert.throws(
    () =>
      applyCascade(scriptOf(), 2, [
        { summary: "one", action: "x" },
        { summary: "two too many", action: "y" },
      ]),
    (error: unknown) =>
      error instanceof OutlineCascadeError && error.code === "invalid_cascade",
  );
});

test("dropped optional fields do not survive a cascade as stale text", () => {
  const before = jamScriptSchema.parse({
    title: "T",
    logline: "L",
    scenes: [
      {
        heading: "INT. ROOM",
        portions: [
          {
            durationSeconds: 10,
            summary: "he lies",
            action: "He speaks.",
            dialogue: "I never left.",
            visualDirection: "Tight on his hands.",
          },
        ],
      },
    ],
  });
  const next = applyCascade(before, 0, [{ summary: "he says nothing", action: "Silence." }]);
  assert.equal(next.scenes[0].portions[0].dialogue, undefined);
  assert.equal(next.scenes[0].portions[0].visualDirection, undefined);
});

test("the cascade prompt marks settled beats immutable and asks for the exact count", () => {
  const prompt = buildCascadePrompt(scriptOf(), {
    intent: "set",
    beatIndex: 1,
    summary: "she drops it",
  });
  assert.match(prompt, /CANNOT change/);
  assert.match(prompt, /0\. she finds the key/);
  assert.match(prompt, /Return exactly 2 object\(s\)/);
  assert.match(prompt, /"she drops it"/);
  // The settled beat must not appear in the replaced list.
  const replaced = prompt.slice(prompt.indexOf("being replaced"));
  assert.doesNotMatch(replaced, /she finds the key/);
});

test("a reroll prompt names what was rejected and asks for something different", () => {
  const prompt = buildCascadePrompt(scriptOf(), {
    intent: "reroll",
    beatIndex: 1,
    reason: "too convenient",
  });
  assert.match(prompt, /rejected beat 1, which read: "she pockets it"/);
  assert.match(prompt, /too convenient/);
  assert.match(prompt, /clearly different/);
  assert.match(prompt, /Return exactly 2 object\(s\)/);
  // A reroll carries no replacement text, and the prompt must not invent one.
  assert.doesNotMatch(prompt, /has rewritten beat/);
});
