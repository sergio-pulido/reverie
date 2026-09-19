import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  appendRevision,
  applyPortionPatch,
  createInitialHistory,
  currentRevision,
  getPortionAt,
  portionsDifferBelow,
  revertToRevision,
  MAX_REVISIONS_PER_JAM,
  PortionLockedError,
  ScriptHistoryError,
} from "../src/core/scriptHistory";
import { DEFAULT_SCRIPT_FORMAT, type JamScript } from "../src/core/script";
import { buildScript } from "./helpers";

const AT = "2026-09-19T12:00:00.000Z";
const EVERYTHING_EDITABLE = 0;

function withAction(base: JamScript, flatIndex: number, action: string) {
  return applyPortionPatch(base, flatIndex, { action }, DEFAULT_SCRIPT_FORMAT);
}

function seedHistory(script = buildScript(15)) {
  return createInitialHistory(randomUUID(), { script, createdAt: AT });
}

test("starts a history at revision 1 with the structured script", () => {
  const history = seedHistory();
  assert.equal(currentRevision(history).revision, 1);
  assert.equal(currentRevision(history).script.title, "The Salt Door");
});

test("appends edits as increasing revisions and ignores no-op appends", () => {
  const base = buildScript(15);
  let history = seedHistory(base);
  history = appendRevision(history, {
    script: withAction(base, 0, "A door opens."),
    createdAt: AT,
    authorId: "host",
  });
  assert.equal(currentRevision(history).revision, 2);
  assert.equal(currentRevision(history).authorId, "host");

  const unchanged = appendRevision(history, {
    script: withAction(base, 0, "A door opens."),
    createdAt: AT,
  });
  assert.equal(unchanged, history);
});

test("undo restores an earlier revision as a new revision", () => {
  const base = buildScript(15);
  let history = seedHistory(base);
  history = appendRevision(history, {
    script: withAction(base, 5, "The sea holds its breath."),
    createdAt: AT,
  });
  history = revertToRevision(history, 1, EVERYTHING_EDITABLE, {
    createdAt: AT,
  });
  const current = currentRevision(history);
  assert.equal(current.revision, 3);
  assert.equal(current.restoredFromRevision, 1);
  assert.deepEqual(current.script, base);
  // History is append-only: the undone revision is still there for redo.
  assert.equal(history.revisions.length, 3);
});

test("rejects reverting to a missing or current revision", () => {
  const base = buildScript(15);
  let history = seedHistory(base);
  history = appendRevision(history, {
    script: withAction(base, 0, "Something else."),
    createdAt: AT,
  });
  assert.throws(
    () => revertToRevision(history, 99, EVERYTHING_EDITABLE, { createdAt: AT }),
    ScriptHistoryError,
  );
  assert.throws(
    () => revertToRevision(history, 2, EVERYTHING_EDITABLE, { createdAt: AT }),
    ScriptHistoryError,
  );
});

test("rejects a revert that would change a locked portion", () => {
  const base = buildScript(15);
  let history = seedHistory(base);
  history = appendRevision(history, {
    script: withAction(base, 2, "Edited before playback reached it."),
    createdAt: AT,
  });
  // Portions 0..3 are now locked; revision 1 differs at portion 2.
  assert.throws(
    () => revertToRevision(history, 1, 4, { createdAt: AT }),
    (error: unknown) =>
      error instanceof PortionLockedError && error.lockedIndex === 3,
  );
  // A boundary below the changed portion allows the same revert.
  const reverted = revertToRevision(history, 1, 2, { createdAt: AT });
  assert.equal(currentRevision(reverted).restoredFromRevision, 1);
});

test("addresses portions by flat index and patches within format bounds", () => {
  // States its own format: the default is now a 20-second jam of 5s portions,
  // whose hard bounds would reject the 12s patch this test is about.
  const format = {
    totalSeconds: 240,
    portionMinSeconds: 12,
    portionMaxSeconds: 15,
  };
  const base = buildScript(15);
  // 4 scenes × 4 portions: flat index 5 is scene 1, portion 1.
  const located = getPortionAt(base, 5);
  assert.equal(located?.sceneIndex, 1);
  assert.equal(located?.portionIndex, 1);
  assert.equal(getPortionAt(base, 16), null);

  const patched = applyPortionPatch(
    base,
    5,
    { dialogue: "“Who left this open?”", durationSeconds: 12 },
    format,
  );
  const portion = getPortionAt(patched, 5)!.portion;
  assert.equal(portion.dialogue, "“Who left this open?”");
  assert.equal(portion.durationSeconds, 12);
  // Untouched portions are structurally identical.
  assert.deepEqual(getPortionAt(patched, 0)!.portion, getPortionAt(base, 0)!.portion);

  assert.throws(
    () =>
      applyPortionPatch(base, 5, { durationSeconds: 59 }, format),
    ScriptHistoryError,
  );
  assert.throws(
    () => applyPortionPatch(base, 99, { action: "Nope." }, format),
    ScriptHistoryError,
  );
});

test("portionsDifferBelow only sees the locked prefix", () => {
  const base = buildScript(15);
  const edited = withAction(base, 10, "Changed late in the film.");
  assert.equal(portionsDifferBelow(base, edited, 10), false);
  assert.equal(portionsDifferBelow(base, edited, 11), true);
  assert.equal(portionsDifferBelow(base, edited, 0), false);
});

test("truncates the oldest revisions past the cap but keeps numbering", () => {
  const base = buildScript(15);
  let history = seedHistory(base);
  for (let i = 2; i <= MAX_REVISIONS_PER_JAM + 10; i += 1) {
    history = appendRevision(history, {
      script: withAction(base, 0, `Take ${i}.`),
      createdAt: AT,
    });
  }
  assert.equal(history.revisions.length, MAX_REVISIONS_PER_JAM);
  assert.equal(currentRevision(history).revision, MAX_REVISIONS_PER_JAM + 10);
  assert.equal(history.revisions[0].revision, 11);
});
