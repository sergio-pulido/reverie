import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NEUTRAL_AVATAR_COLOUR, avatarColour, initialsOf } from "../src/shell/avatar";

const IDS = [
  "8f2b1c44-6a2e-4b1f-9a7d-2c0e5f8a1b33",
  "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
  "00000000-0000-4000-8000-000000000000",
  "ffffffff-ffff-4fff-bfff-ffffffffffff",
  "3c9d0e21-77aa-4c55-9e10-bb44dd22ee11",
  "d41d8cd9-8f00-4204-a980-0998ecf8427e",
];

describe("the account avatar's colour", () => {
  it("is the same every time for the same Supabase user id", () => {
    for (const id of IDS) {
      const first = avatarColour(id);
      // Derived, never stored: asking again — this visit or any other — answers the same colour.
      for (let again = 0; again < 5; again += 1) assert.equal(avatarColour(id), first, id);
    }
  });

  it("is a colour from the fixed list, and is not the neutral one", () => {
    const colours = new Set(IDS.map(avatarColour));
    for (const colour of colours) {
      assert.match(colour, /^#[0-9a-f]{6}$/);
      assert.notEqual(colour, NEUTRAL_AVATAR_COLOUR, "a signed-in viewer never draws the neutral circle");
    }
  });

  it("tells different viewers apart rather than answering one colour for everyone", () => {
    assert.ok(new Set(IDS.map(avatarColour)).size > 1);
  });

  it("is the neutral colour when there is no session to derive one from", () => {
    assert.equal(avatarColour(null), NEUTRAL_AVATAR_COLOUR);
    assert.equal(avatarColour(""), NEUTRAL_AVATAR_COLOUR);
  });
});

describe("the account avatar's initials", () => {
  it("takes the first letter of the first and last words", () => {
    assert.equal(initialsOf("Ada Lovelace"), "AL");
    assert.equal(initialsOf("Ada Byron King Lovelace"), "AL");
    assert.equal(initialsOf("ada lovelace"), "AL");
    assert.equal(initialsOf("  Ada   Lovelace  "), "AL");
  });

  it("takes one letter from a single word", () => {
    assert.equal(initialsOf("Ada"), "A");
    assert.equal(initialsOf("señora"), "S");
  });

  it("is empty with no name, so the circle shows a neutral mark instead of a guess", () => {
    assert.equal(initialsOf(null), "");
    assert.equal(initialsOf(""), "");
    assert.equal(initialsOf("   "), "");
  });
});
