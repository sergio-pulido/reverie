import assert from "node:assert/strict";
import test from "node:test";
import {
  BEAT_LIKENESS_MESSAGE,
  decideFrameAccess,
  describeBeatLikeness,
  isLikenessRef,
  likenessConsents,
  MAX_LIKENESS_REFERENCES,
  plannedLikenessOwners,
  usableLikenesses,
  type BeatLikenessUse,
} from "../src/core/likeness";
import {
  liveConsentSchema,
  permittedKinds,
  type LiveConsent,
  type LiveConsentKind,
} from "../src/core/liveMedia";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const ALICE = "a0000000-0000-4000-8000-00000000000a";
const BRUNO = "b0000000-0000-4000-8000-00000000000b";
const JAM = "10000000-0000-4000-8000-000000000001";

let sequence = 0;

function consent(overrides: Partial<LiveConsent> = {}): LiveConsent {
  sequence += 1;
  const id = `c0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  return {
    id,
    jam_id: JAM,
    owner_id: ALICE,
    kind: "likeness" as LiveConsentKind,
    purpose: "appear as the lead character",
    asset_ref: `likeness:${id}`,
    granted_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 30 * 60_000).toISOString(),
    withdrawn_at: null,
    ...overrides,
  };
}

test("agreeing to appear is not agreeing to publish a track", () => {
  const consents = [consent({ owner_id: ALICE })];
  assert.deepEqual([...permittedKinds(consents, ALICE, NOW)], []);
  assert.equal(usableLikenesses(consents, NOW).length, 1);
});

test("turning on a camera is not agreeing to appear", () => {
  const consents = [consent({ owner_id: ALICE, kind: "camera", asset_ref: "live:1" })];
  assert.deepEqual([...permittedKinds(consents, ALICE, NOW)], ["camera"]);
  assert.deepEqual(usableLikenesses(consents, NOW), []);
});

test("a withdrawn likeness may seed nothing from then on", () => {
  const standing = consent();
  const withdrawn = { ...standing, withdrawn_at: new Date(NOW - 1_000).toISOString() };
  assert.equal(usableLikenesses([standing], NOW).length, 1);
  assert.deepEqual(usableLikenesses([withdrawn], NOW), []);
  assert.deepEqual(plannedLikenessOwners([withdrawn], NOW), []);
});

test("an expired likeness is refused exactly as a withdrawn one is", () => {
  const expired = consent({ expires_at: new Date(NOW - 1).toISOString() });
  assert.deepEqual(usableLikenesses([expired], NOW), []);
  assert.deepEqual(decideFrameAccess(expired, ALICE, NOW), {
    allowed: false,
    reason: "withdrawn_or_expired",
  });
});

test("a consent that expires one millisecond from now is still usable, and then is not", () => {
  const edge = consent({ expires_at: new Date(NOW + 1).toISOString() });
  assert.equal(usableLikenesses([edge], NOW).length, 1);
  assert.deepEqual(usableLikenesses([edge], NOW + 1), []);
});

test("a participant cannot grant, attach or read on another's behalf", () => {
  const hers = consent({ owner_id: ALICE });
  assert.deepEqual(decideFrameAccess(hers, BRUNO, NOW), { allowed: false, reason: "not_yours" });
  assert.deepEqual(decideFrameAccess(hers, ALICE, NOW), { allowed: true });
});

test("a track consent is not a door to a frame, whoever owns it", () => {
  const camera = consent({ kind: "camera", asset_ref: "live:2" });
  assert.deepEqual(decideFrameAccess(camera, ALICE, NOW), {
    allowed: false,
    reason: "not_a_likeness_consent",
  });
});

test("only a reference the register issued can seed a beat", () => {
  assert.equal(isLikenessRef("likeness:9f0e"), true);
  assert.equal(isLikenessRef("likeness:"), false);
  assert.equal(isLikenessRef("live:9f0e"), false);
  const forged = consent({ asset_ref: "https://example.invalid/face.jpg" });
  assert.deepEqual(usableLikenesses([forged], NOW), []);
});

test("references are taken in the order they were granted and capped", () => {
  const many = Array.from({ length: MAX_LIKENESS_REFERENCES + 2 }, (_, index) =>
    consent({
      owner_id: `owner-${index}`,
      granted_at: new Date(NOW - 10_000 + index).toISOString(),
    }),
  );
  const chosen = usableLikenesses([...many].reverse(), NOW);
  assert.equal(chosen.length, MAX_LIKENESS_REFERENCES);
  assert.deepEqual(
    chosen.map((c) => c.owner_id),
    ["owner-0", "owner-1", "owner-2"],
  );
});

test("a beat made before a withdrawal is never claimed to be clean", () => {
  const used = consent();
  const use: BeatLikenessUse = {
    consentIds: [used.id],
    assetRefs: [used.asset_ref],
    ownerIds: [used.owner_id],
    generatedAt: new Date(NOW - 5_000).toISOString(),
    model: "minimax/h3-max/reference-to-video",
  };
  assert.equal(describeBeatLikeness(use, [used], NOW), "standing");

  const withdrawn = { ...used, withdrawn_at: new Date(NOW).toISOString() };
  const standing = describeBeatLikeness(use, [withdrawn], NOW);
  assert.equal(standing, "withdrawn_since");
  assert.notEqual(standing, "none");
  assert.match(BEAT_LIKENESS_MESSAGE.withdrawn_since, /already exists and still shows them/);
});

test("a beat made from nobody says so, and never borrows someone else's standing", () => {
  assert.equal(describeBeatLikeness(null, [consent()], NOW), "none");
  assert.match(BEAT_LIKENESS_MESSAGE.none, /No one's likeness/);
});

test("one withdrawal among several is enough to change what the beat may claim", () => {
  const first = consent({ owner_id: ALICE });
  const second = consent({ owner_id: BRUNO });
  const use: BeatLikenessUse = {
    consentIds: [first.id, second.id],
    assetRefs: [first.asset_ref, second.asset_ref],
    ownerIds: [ALICE, BRUNO],
    generatedAt: new Date(NOW - 1_000).toISOString(),
    model: "minimax/h3-max/reference-to-video",
  };
  assert.equal(describeBeatLikeness(use, [first, second], NOW), "standing");
  assert.equal(
    describeBeatLikeness(use, [first, { ...second, withdrawn_at: new Date(NOW).toISOString() }], NOW),
    "withdrawn_since",
  );
});

test("the register still parses a likeness row, and still refuses an unknown kind", () => {
  const row = consent();
  assert.equal(liveConsentSchema.safeParse(row).success, true);
  assert.equal(liveConsentSchema.safeParse({ ...row, kind: "face" }).success, false);
});

test("the room's panel keeps ended grants so it can say they ended", () => {
  const ended = consent({ withdrawn_at: new Date(NOW).toISOString() });
  assert.equal(likenessConsents([ended]).length, 1);
  assert.deepEqual(usableLikenesses([ended], NOW), []);
});
