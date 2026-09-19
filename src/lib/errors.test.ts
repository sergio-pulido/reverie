import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JamError, safeMessageOf, toJamError } from "./errors";

describe("toJamError", () => {
  it("shows a message our own schema authored, without the marker", () => {
    const error = toJamError({ code: "42501", message: "jam: only the host can change membership" }, "fallback");
    assert.equal(error.code, "forbidden");
    assert.equal(error.safeMessage, "only the host can change membership");
  });

  it("replaces a native Postgres message that names schema internals", () => {
    const native = 'new row violates row-level security policy for table "jam_members"';
    const error = toJamError({ code: "42501", message: native }, "fallback");
    assert.equal(error.safeMessage, "You are not allowed to do that in this jam.");
    assert.equal(error.safeMessage.includes("jam_members"), false);
  });

  it("replaces a native unique-violation message", () => {
    const error = toJamError({ code: "23505", message: 'duplicate key value violates unique constraint "jams_invite_code_key"' }, "fallback");
    assert.equal(error.code, "conflict");
    assert.equal(error.safeMessage.includes("jams_invite_code_key"), false);
  });

  it("treats an unmapped code as a retryable outage and never forwards its text", () => {
    const error = toJamError({ code: "XX000", message: "internal driver detail" }, "The jam could not be reached.");
    assert.equal(error.code, "unavailable");
    assert.equal(error.retryable, true);
    assert.equal(error.safeMessage, "The jam could not be reached.");
  });

  it("maps a missing invite to not_found", () => {
    assert.equal(toJamError({ code: "P0002", message: "jam: invite not found" }, "f").code, "not_found");
  });

  it("maps an expired session to unauthenticated and ignores its raw text", () => {
    const error = toJamError({ code: "PGRST301", message: "JWT expired at 2026-09-19T00:00:00Z" }, "f");
    assert.equal(error.code, "unauthenticated");
    assert.equal(error.safeMessage.includes("JWT"), false);
  });

  it("handles a null error object", () => {
    assert.equal(toJamError(null, "fallback").safeMessage, "fallback");
  });
});

describe("safeMessageOf", () => {
  it("returns the safe message of a JamError", () => {
    assert.equal(safeMessageOf(new JamError("forbidden", "Not allowed."), "fallback"), "Not allowed.");
  });

  it("never forwards an arbitrary thrown error's text", () => {
    assert.equal(safeMessageOf(new Error("connect ECONNREFUSED 127.0.0.1:5432"), "fallback"), "fallback");
    assert.equal(safeMessageOf("some string", "fallback"), "fallback");
  });
});
