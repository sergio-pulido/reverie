import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inviteUrl, normalizeDisplayName, normalizeInviteCode } from "./invite";

describe("normalizeInviteCode", () => {
  it("accepts a bare code", () => {
    assert.deepEqual(normalizeInviteCode("ABCD2345"), { ok: true, value: "ABCD2345" });
  });

  it("uppercases and strips separators a host reads aloud", () => {
    assert.deepEqual(normalizeInviteCode(" abcd-2345 "), { ok: true, value: "ABCD2345" });
  });

  it("extracts the code from an invite URL", () => {
    const result = normalizeInviteCode("https://reverie.example/join?jam=night-signal-9f2a&code=KQ7TV3XZ");
    assert.deepEqual(result, { ok: true, value: "KQ7TV3XZ" });
  });

  it("extracts the code from a fragment invite URL", () => {
    assert.deepEqual(normalizeInviteCode("https://reverie.example/join#code=kq7tv3xz"), { ok: true, value: "KQ7TV3XZ" });
  });

  it("rejects a room URL that carries no invite entitlement", () => {
    const result = normalizeInviteCode("https://reverie.example/jams/night-signal-9f2a");
    assert.equal(result.ok, false);
  });

  it("rejects the ambiguous characters the alphabet excludes", () => {
    for (const code of ["ABCDIOU1", "IIIIIIII", "OOOO2345"]) {
      assert.equal(normalizeInviteCode(code).ok, false, code);
    }
  });

  it("rejects wrong lengths and empty input", () => {
    for (const code of ["", "   ", "ABCD234", "ABCD23456"]) {
      assert.equal(normalizeInviteCode(code).ok, false, JSON.stringify(code));
    }
  });
});

describe("normalizeDisplayName", () => {
  it("trims and collapses whitespace", () => {
    assert.deepEqual(normalizeDisplayName("  Ada   Lovelace  "), { ok: true, value: "Ada Lovelace" });
  });

  it("rejects an empty or whitespace-only name", () => {
    assert.equal(normalizeDisplayName("").ok, false);
    assert.equal(normalizeDisplayName("\n\t ").ok, false);
  });

  it("rejects a name longer than the column allows", () => {
    assert.equal(normalizeDisplayName("x".repeat(33)).ok, false);
    assert.equal(normalizeDisplayName("x".repeat(32)).ok, true);
  });
});

describe("inviteUrl", () => {
  it("builds a shareable link with no session material", () => {
    const url = inviteUrl("https://reverie.example/", "night-signal-9f2a", "KQ7TV3XZ");
    assert.equal(url, "https://reverie.example/join?jam=night-signal-9f2a&code=KQ7TV3XZ");
  });

  it("round-trips through the parser", () => {
    const url = inviteUrl("https://reverie.example", "night-signal-9f2a", "KQ7TV3XZ");
    assert.deepEqual(normalizeInviteCode(url), { ok: true, value: "KQ7TV3XZ" });
  });
});
