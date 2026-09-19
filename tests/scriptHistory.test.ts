import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  appendRevision,
  createInitialHistory,
  currentRevision,
  revertToRevision,
  MAX_REVISIONS_PER_JAM,
  ScriptHistoryError,
} from "../src/core/scriptHistory";

const AT = "2026-09-19T12:00:00.000Z";

function seedHistory(markdown = "# Draft one") {
  return createInitialHistory(randomUUID(), { markdown, createdAt: AT });
}

test("starts a history at revision 1", () => {
  const history = seedHistory();
  assert.equal(currentRevision(history).revision, 1);
  assert.equal(currentRevision(history).markdown, "# Draft one");
});

test("appends live edits as increasing revisions", () => {
  let history = seedHistory();
  history = appendRevision(history, { markdown: "# Draft two", createdAt: AT });
  history = appendRevision(history, {
    markdown: "# Draft three",
    createdAt: AT,
    authorId: "host",
  });
  assert.equal(currentRevision(history).revision, 3);
  assert.equal(currentRevision(history).authorId, "host");
  assert.equal(history.revisions.length, 3);
});

test("ignores an append whose markdown matches the current revision", () => {
  const history = seedHistory();
  const unchanged = appendRevision(history, {
    markdown: "# Draft one",
    createdAt: AT,
  });
  assert.equal(unchanged, history);
});

test("undo restores an earlier revision as a new revision", () => {
  let history = seedHistory();
  history = appendRevision(history, { markdown: "# Draft two", createdAt: AT });
  history = revertToRevision(history, 1, { createdAt: AT, authorId: "host" });
  const current = currentRevision(history);
  assert.equal(current.revision, 3);
  assert.equal(current.markdown, "# Draft one");
  assert.equal(current.restoredFromRevision, 1);
  // History is append-only: the undone revision is still there for redo.
  assert.equal(history.revisions.length, 3);
});

test("rejects reverting to a missing or current revision", () => {
  let history = seedHistory();
  history = appendRevision(history, { markdown: "# Draft two", createdAt: AT });
  assert.throws(
    () => revertToRevision(history, 99, { createdAt: AT }),
    ScriptHistoryError,
  );
  assert.throws(
    () => revertToRevision(history, 2, { createdAt: AT }),
    ScriptHistoryError,
  );
});

test("truncates the oldest revisions past the cap but keeps numbering", () => {
  let history = seedHistory();
  for (let i = 2; i <= MAX_REVISIONS_PER_JAM + 10; i += 1) {
    history = appendRevision(history, {
      markdown: `# Draft ${i}`,
      createdAt: AT,
    });
  }
  assert.equal(history.revisions.length, MAX_REVISIONS_PER_JAM);
  assert.equal(currentRevision(history).revision, MAX_REVISIONS_PER_JAM + 10);
  assert.equal(history.revisions[0].revision, 11);
});
