import assert from "node:assert/strict";
import test from "node:test";
import {
  describeInvite,
  inviteState,
  isInviteShareable,
  normalizeInviteMinutes,
} from "../src/core/invite";
import { jamInviteSchema, jamRoomSchema } from "../src/core/room";
import { toJamError } from "../src/lib/errors";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const in30 = new Date(NOW + 30 * 60_000).toISOString();
const ago30 = new Date(NOW - 30 * 60_000).toISOString();

test("an invite without an expiry stays active", () => {
  assert.equal(inviteState({ expiresAt: null, revokedAt: null }, NOW), "active");
  assert.equal(isInviteShareable({ expiresAt: null, revokedAt: null }, NOW), true);
});

test("an invite past its expiry is expired", () => {
  assert.equal(inviteState({ expiresAt: ago30, revokedAt: null }, NOW), "expired");
  assert.equal(isInviteShareable({ expiresAt: ago30, revokedAt: null }, NOW), false);
});

test("an expiry exactly now has already passed", () => {
  assert.equal(inviteState({ expiresAt: new Date(NOW).toISOString(), revokedAt: null }, NOW), "expired");
});

test("revocation outranks an expiry that has not been reached", () => {
  assert.equal(inviteState({ expiresAt: in30, revokedAt: ago30 }, NOW), "revoked");
});

test("an unparseable expiry does not silently lock a host out of their own invite", () => {
  assert.equal(inviteState({ expiresAt: "not a date", revokedAt: null }, NOW), "active");
});

test("the host-facing description names the state and never the raw timestamp", () => {
  assert.match(describeInvite({ expiresAt: in30, revokedAt: null }, NOW), /another 30 minutes/);
  assert.match(describeInvite({ expiresAt: null, revokedAt: null }, NOW), /does not expire/);
  assert.match(describeInvite({ expiresAt: ago30, revokedAt: null }, NOW), /expired/);
  assert.match(describeInvite({ expiresAt: in30, revokedAt: ago30 }, NOW), /revoked/);
  for (const invite of [{ expiresAt: in30, revokedAt: null }, { expiresAt: ago30, revokedAt: null }]) {
    assert.equal(describeInvite(invite, NOW).includes("2026-09-19T"), false);
  }
});

test("an hour or more is described in hours", () => {
  const in3h = new Date(NOW + 3 * 3_600_000).toISOString();
  assert.match(describeInvite({ expiresAt: in3h, revokedAt: null }, NOW), /about another 3 hours/);
});

test("a rotation lifetime outside the 5 minute to 24 hour band is rejected", () => {
  assert.deepEqual(normalizeInviteMinutes(null), { ok: true, value: null });
  assert.deepEqual(normalizeInviteMinutes(30), { ok: true, value: 30 });
  assert.deepEqual(normalizeInviteMinutes(1440), { ok: true, value: 1440 });
  for (const minutes of [0, 4, 1441, -30, 12.5, Number.NaN]) {
    assert.equal(normalizeInviteMinutes(minutes).ok, false, `${minutes} was accepted`);
  }
});

test("the invite record schema rejects a malformed code", () => {
  const base = {
    jamId: "8f1c3b7e-0000-4000-8000-000000000001",
    slug: "a-jam",
    expiresAt: null,
    revokedAt: null,
    state: "active",
  };
  assert.equal(jamInviteSchema.safeParse({ ...base, code: "ABCD2345" }).success, true);
  // I, O and U are absent from the alphabet, so a lookalike never validates.
  assert.equal(jamInviteSchema.safeParse({ ...base, code: "ABCD234I" }).success, false);
  assert.equal(jamInviteSchema.safeParse({ ...base, code: "abcd2345" }).success, false);
  assert.equal(jamInviteSchema.safeParse({ ...base, code: "ABCD234" }).success, false);
});

test("a jam row carries no invite code, so a member snapshot cannot leak the entitlement", () => {
  const parsed = jamRoomSchema.safeParse({
    id: "8f1c3b7e-0000-4000-8000-000000000001",
    slug: "a-jam",
    title: "A Jam",
    premise: "A premise.",
    visibility: "invite_only",
    status: "lobby",
    invite_code: "ABCD2345",
  });
  assert.equal(parsed.success, true);
  assert.equal("invite_code" in (parsed.success ? parsed.data : {}), false);
});

test("a throttled admission is a marked, retryable rate limit", () => {
  const error = toJamError(
    { code: "53400", message: "jam: too many invite attempts. Wait a few minutes and try again." },
    "The jam could not be joined right now.",
  );
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retryable, true);
  assert.match(error.safeMessage, /too many invite attempts/);
});

test("a throttle message Postgres itself authored is replaced by fixed safe text", () => {
  const error = toJamError(
    { code: "53400", message: 'relation "public.jam_admission_attempts" hit a limit' },
    "fallback",
  );
  assert.equal(error.code, "rate_limited");
  assert.equal(error.safeMessage.includes("jam_admission_attempts"), false);
});
