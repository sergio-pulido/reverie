import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admissionResultSchema,
  authorName,
  canContribute,
  jamMemberSchema,
  jamMessageSchema,
  mergeMember,
  mergeRow,
  mergeRows,
  type Jam,
  type JamMember,
  type JamMessage,
} from "./jam";

const JAM_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "22222222-2222-4222-8222-222222222222";
const GUEST_ID = "33333333-3333-4333-8333-333333333333";

function message(id: string, created_at: string, body = "line"): JamMessage {
  return { id, jam_id: JAM_ID, author_id: HOST_ID, body, created_at };
}

function member(user_id: string, status: JamMember["status"], joined_at = "2026-09-19T10:00:00Z"): JamMember {
  return { jam_id: JAM_ID, user_id, display_name: `name-${user_id.slice(0, 4)}`, role: user_id === HOST_ID ? "host" : "member", status, joined_at };
}

const jam: Jam = { id: JAM_ID, slug: "night-signal", title: "Night Signal", premise: "A signal arrives.", visibility: "invite_only", status: "live" };

describe("mergeRow", () => {
  it("orders by creation time", () => {
    const rows = mergeRow(mergeRow([], message("b", "2026-09-19T10:00:02Z")), message("a", "2026-09-19T10:00:01Z"));
    assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
  });

  it("breaks an identical timestamp by id so clients converge", () => {
    const stamp = "2026-09-19T10:00:00Z";
    const rows = mergeRows([], [message("b", stamp), message("a", stamp)]);
    assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
  });

  it("is idempotent when a Postgres Change is redelivered after a reconnect", () => {
    const first = mergeRow([], message("a", "2026-09-19T10:00:00Z"));
    const again = mergeRow(first, message("a", "2026-09-19T10:00:00Z"));
    assert.equal(again.length, 1);
  });

  it("lets the server row replace an optimistic copy of the same id", () => {
    const optimistic = mergeRow([], message("a", "2026-09-19T10:00:00Z", "pending"));
    const confirmed = mergeRow(optimistic, message("a", "2026-09-19T10:00:00Z", "stored"));
    assert.deepEqual(confirmed.map((row) => row.body), ["stored"]);
  });

  it("does not mutate the list it was given", () => {
    const original = mergeRow([], message("a", "2026-09-19T10:00:00Z"));
    const next = mergeRow(original, message("b", "2026-09-19T10:00:01Z"));
    assert.equal(original.length, 1);
    assert.equal(next.length, 2);
  });
});

describe("mergeRows", () => {
  it("folds a reconnect snapshot over local rows without duplicating", () => {
    const local = mergeRows([], [message("a", "2026-09-19T10:00:00Z"), message("b", "2026-09-19T10:00:01Z")]);
    const snapshot = mergeRows(local, [message("b", "2026-09-19T10:00:01Z"), message("c", "2026-09-19T10:00:02Z")]);
    assert.deepEqual(snapshot.map((row) => row.id), ["a", "b", "c"]);
  });
});

describe("mergeMember", () => {
  it("keys the roster by user, not by event order", () => {
    const waiting = mergeMember([], member(GUEST_ID, "waiting"));
    const admitted = mergeMember(waiting, member(GUEST_ID, "active"));
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].status, "active");
  });

  it("drops a removed or departed participant from the roster", () => {
    const roster = mergeMember(mergeMember([], member(HOST_ID, "active")), member(GUEST_ID, "active"));
    assert.equal(mergeMember(roster, member(GUEST_ID, "removed")).length, 1);
    assert.equal(mergeMember(roster, member(GUEST_ID, "left")).length, 1);
  });
});

describe("contribution rules", () => {
  it("allows only an active member to contribute", () => {
    assert.equal(canContribute(jam, member(GUEST_ID, "active")), true);
    assert.equal(canContribute(jam, member(GUEST_ID, "waiting")), false);
    assert.equal(canContribute(jam, member(GUEST_ID, "removed")), false);
    assert.equal(canContribute(jam, null), false);
  });

  it("stops contributions once the jam is closed", () => {
    assert.equal(canContribute({ ...jam, status: "closed" }, member(GUEST_ID, "active")), false);
    assert.equal(canContribute({ ...jam, status: "completed" }, member(GUEST_ID, "active")), false);
  });
});

describe("authorName", () => {
  it("shows a roster name and never a raw user id", () => {
    const roster = [member(GUEST_ID, "active")];
    assert.equal(authorName(roster, GUEST_ID), "name-3333");
    assert.equal(authorName(roster, HOST_ID), "Someone");
    assert.equal(authorName(roster, HOST_ID).includes(HOST_ID), false);
  });
});

describe("schemas reject untrusted shapes", () => {
  it("rejects an unknown member status", () => {
    assert.equal(jamMemberSchema.safeParse({ ...member(GUEST_ID, "active"), status: "admin" }).success, false);
  });

  it("rejects a non-uuid author id", () => {
    assert.equal(jamMessageSchema.safeParse({ ...message("a", "2026-09-19T10:00:00Z"), author_id: "root" }).success, false);
  });

  it("rejects an admission payload missing its status", () => {
    assert.equal(admissionResultSchema.safeParse({ jamId: JAM_ID, slug: "s", title: "t" }).success, false);
  });

  it("accepts the admission payload the RPC returns", () => {
    const parsed = admissionResultSchema.safeParse({ jamId: JAM_ID, slug: "night-signal", title: "Night Signal", memberStatus: "waiting" });
    assert.equal(parsed.success, true);
  });

  it("rejects a message id that is not a uuid", () => {
    assert.equal(jamMessageSchema.safeParse(message("not-a-uuid", "2026-09-19T10:00:00Z")).success, false);
  });
});
