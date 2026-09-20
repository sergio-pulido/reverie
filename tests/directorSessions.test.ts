import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DirectorSessionLedger,
  resolveDirectorLimits,
  SESSION_IDLE_TIMEOUT_MS,
} from "../apps/server/directorSessions";

function ledgerAt(now: { value: number }, overrides = {}) {
  return new DirectorSessionLedger(
    {
      budgetUsd: 20,
      usdPerSecond: 0.08,
      maxConcurrentSessions: 1,
      maxSessionSeconds: 300,
      ...overrides,
    },
    () => now.value,
  );
}

test("limits fall back to list price and a single session", () => {
  const limits = resolveDirectorLimits({});
  assert.equal(limits.usdPerSecond, 0.08);
  assert.equal(limits.maxConcurrentSessions, 1);
  assert.equal(limits.budgetUsd, 0);
  // A session may not be capped below what fal bills as its minimum.
  assert.equal(limits.maxSessionSeconds, 120);
  assert.equal(
    resolveDirectorLimits({ REVERIE_DIRECTOR_MAX_SESSION_SECONDS: "5" })
      .maxSessionSeconds,
    60,
  );
});

test("the shipped $20 budget can actually open a session", () => {
  const limits = { ...resolveDirectorLimits({ FAL_ASSET_BUDGET_USD: "20" }) };
  const ledger = new DirectorSessionLedger(limits, () => 0);
  assert.notEqual(typeof ledger.open("jam"), "string");
});

test("a session with no budget cannot be opened at all", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { budgetUsd: 0 });
  assert.equal(ledger.open("jam"), "budget_exhausted");
});

test("opening a session reserves its worst case, not its minimum", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 300 });
  // A 300s ceiling at $0.08/s reserves $24, which does not fit the
  // $20 budget - even though the session would only bill $4.80 at the minimum.
  assert.equal(ledger.open("jam"), "budget_exhausted");
  assert.equal(ledger.committedUsd, 0);
});

test("a session that fits reserves its ceiling and refunds on close", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 120 });
  const session = ledger.open("jam");
  assert.notEqual(typeof session, "string");
  // 120s x $0.08 = $9.60 held while it runs.
  assert.equal(ledger.committedUsd.toFixed(2), "9.60");

  now.value = 10_000; // ran 10s, billed at the 60s minimum
  assert.ok(ledger.close((session as { sessionId: string }).sessionId));
  assert.equal(ledger.committedUsd.toFixed(2), "4.80");
});

test("a long session is never billed above its reservation", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 120 });
  const session = ledger.open("jam") as { sessionId: string };
  now.value = 10_000_000;
  ledger.close(session.sessionId);
  assert.equal(ledger.committedUsd.toFixed(2), "9.60");
});

test("one stream per configuration, and a bounded number overall", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 60, maxConcurrentSessions: 2 });
  assert.notEqual(typeof ledger.open("jam:en|"), "string");
  assert.equal(ledger.open("jam:en|"), "already_open");
  // Same jam, different configuration: its own stream.
  assert.notEqual(typeof ledger.open("jam:es|"), "string");
  assert.equal(ledger.open("jam:fr|"), "too_many_sessions");
});

test("an abandoned session is reclaimed but keeps its reservation spent", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 60 });
  ledger.open("jam");
  assert.equal(ledger.openCount, 1);
  assert.equal(ledger.committedUsd.toFixed(2), "4.80");

  now.value = SESSION_IDLE_TIMEOUT_MS + 1;
  // The slot is freed for a new jam...
  assert.notEqual(typeof ledger.open("other"), "string");
  assert.equal(ledger.openCount, 1);
  // ...but the abandoned session's spend is not refunded: the server cannot
  // prove fal stopped generating, and guessing low would understate cost.
  assert.equal(ledger.committedUsd.toFixed(2), "9.60");
});

test("renew keeps a live session from being reclaimed", () => {
  const now = { value: 0 };
  // Keep the hard session ceiling beyond this test's idle-renewal window.
  const ledger = ledgerAt(now, { maxSessionSeconds: 180 });
  const session = ledger.open("jam") as { sessionId: string };
  now.value = SESSION_IDLE_TIMEOUT_MS - 1;
  assert.ok(ledger.renew(session.sessionId));
  now.value = SESSION_IDLE_TIMEOUT_MS + 1;
  ledger.expireIdle();
  assert.equal(ledger.openCount, 1);
  assert.equal(ledger.renew("not-a-session"), false);
});

test("the budget refuses the session that would cross it", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, {
    budgetUsd: 10,
    maxSessionSeconds: 60,
    maxConcurrentSessions: 5,
  });
  assert.notEqual(typeof ledger.open("a"), "string"); // $4.80
  assert.notEqual(typeof ledger.open("b"), "string"); // $9.60
  assert.equal(ledger.open("c"), "budget_exhausted"); // would be $14.40
  assert.equal(ledger.remainingUsd.toFixed(2), "0.40");
});

test("a handshake that never opened refunds its whole reservation", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 120 });
  const session = ledger.open("jam") as { sessionId: string };
  assert.equal(ledger.committedUsd.toFixed(2), "9.60");

  // fal refused it, so there is no session to bill a 60-second minimum for.
  assert.ok(ledger.release(session.sessionId));
  assert.equal(ledger.committedUsd, 0);
  assert.equal(ledger.openCount, 0);
  assert.equal(ledger.release(session.sessionId), false);
});

test("release and close are not interchangeable", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 120, maxConcurrentSessions: 2 });
  const opened = ledger.open("jam:ran|") as { sessionId: string };
  const refused = ledger.open("jam:never-ran|") as { sessionId: string };

  ledger.close(opened.sessionId); // billed at the 60s minimum: $4.80
  ledger.release(refused.sessionId); // billed nothing
  assert.equal(ledger.committedUsd.toFixed(2), "4.80");
});

test("an open stream is found by its configuration so viewers can attach", () => {
  const now = { value: 0 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 60, maxConcurrentSessions: 2 });
  const session = ledger.open("jam:en|") as { sessionId: string };
  assert.equal(ledger.findByStreamKey("jam:en|")?.sessionId, session.sessionId);
  assert.equal(ledger.findByStreamKey("jam:es|"), undefined);

  // An abandoned stream is not offered to a new viewer to attach to.
  now.value = SESSION_IDLE_TIMEOUT_MS + 1;
  assert.equal(ledger.findByStreamKey("jam:en|"), undefined);
});

test("a shared stream outlives one viewer leaving, and ends with the last", () => {
  const now = { value: 1_000 };
  const closed: string[] = [];
  const ledger = new DirectorSessionLedger(
    { budgetUsd: 20, usdPerSecond: 0.08, maxConcurrentSessions: 1, maxSessionSeconds: 60 },
    () => now.value,
    (sessionId) => closed.push(sessionId),
  );
  const session = ledger.open("jam:en|");
  assert.notEqual(typeof session, "string");
  const { sessionId } = session as { sessionId: string };

  const first = ledger.attach(sessionId) as string;
  const second = ledger.attach(sessionId) as string;
  assert.equal(ledger.viewerCount(sessionId), 2);

  // One person closing their tab must not end the film for the other.
  assert.deepEqual(ledger.detach(sessionId, first), { remaining: 1 });
  assert.equal(ledger.viewerCount(sessionId), 1);
  assert.deepEqual(closed, []);

  assert.deepEqual(ledger.detach(sessionId, second), { remaining: 0 });
  // Reaching zero is the caller's signal to settle; the ledger does not guess.
  ledger.close(sessionId);
  assert.deepEqual(closed, [sessionId]);
});

test("one viewer still checking in keeps the stream for everyone", () => {
  const now = { value: 1_000 };
  // This test isolates idle renewal; the hard duration cap is covered below.
  const ledger = ledgerAt(now, { maxSessionSeconds: 180 });
  const session = ledger.open("jam:en|") as { sessionId: string };
  const staying = ledger.attach(session.sessionId) as string;
  ledger.attach(session.sessionId);

  now.value += SESSION_IDLE_TIMEOUT_MS - 1;
  assert.equal(ledger.renew(session.sessionId, staying), true);
  now.value += SESSION_IDLE_TIMEOUT_MS - 1;
  ledger.expireIdle();

  // The silent viewer is dropped; the stream survives because someone is
  // demonstrably still watching it.
  assert.equal(ledger.openCount, 1);
  assert.equal(ledger.viewerCount(session.sessionId), 1);
});

test("an active viewer cannot extend a session past its paid ceiling", () => {
  const now = { value: 1_000 };
  const closed: string[] = [];
  const ledger = new DirectorSessionLedger(
    { budgetUsd: 20, usdPerSecond: 0.08, maxConcurrentSessions: 1, maxSessionSeconds: 60 },
    () => now.value,
    (sessionId) => closed.push(sessionId),
  );
  const session = ledger.open("jam:en|") as { sessionId: string };
  const viewer = ledger.attach(session.sessionId) as string;

  now.value += 59_999;
  assert.equal(ledger.renew(session.sessionId, viewer), true);
  ledger.expireIdle();
  assert.equal(ledger.openCount, 1);

  now.value += 1;
  ledger.expireIdle();
  assert.equal(ledger.openCount, 0);
  assert.deepEqual(closed, [session.sessionId]);
});

test("a stream every viewer abandoned is reclaimed, and the caller is told", () => {
  const now = { value: 1_000 };
  const closed: string[] = [];
  const ledger = new DirectorSessionLedger(
    { budgetUsd: 20, usdPerSecond: 0.08, maxConcurrentSessions: 1, maxSessionSeconds: 60 },
    () => now.value,
    (sessionId) => closed.push(sessionId),
  );
  const session = ledger.open("jam:en|") as { sessionId: string };
  ledger.attach(session.sessionId);

  now.value += SESSION_IDLE_TIMEOUT_MS + 1;
  ledger.expireIdle();

  assert.equal(ledger.openCount, 0);
  // Without this the stream keeps running, and keeps billing, with nobody left.
  assert.deepEqual(closed, [session.sessionId]);
});

test("renewing as a viewer who was already dropped does not resurrect them", () => {
  const now = { value: 1_000 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 60 });
  const session = ledger.open("jam:en|") as { sessionId: string };
  const viewer = ledger.attach(session.sessionId) as string;

  assert.equal(ledger.detach(session.sessionId, viewer)?.remaining, 0);
  // Attaching is what admits a viewer. A renew that recreated one would let a
  // stale client keep a stream alive after it had been counted out.
  assert.equal(ledger.renew(session.sessionId, viewer), false);
  assert.equal(ledger.viewerCount(session.sessionId), 0);
  // The server's own renew, with no viewer of its own, still works.
  assert.equal(ledger.renew(session.sessionId), true);
});

test("viewer ids are issued by the server and never collide", () => {
  const now = { value: 1_000 };
  const ledger = ledgerAt(now, { maxSessionSeconds: 60 });
  const session = ledger.open("jam:en|") as { sessionId: string };
  const ids = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    ids.add(ledger.attach(session.sessionId) as string);
  }
  // Two viewers looking like one would end a stream somebody was watching.
  assert.equal(ids.size, 50);
  assert.equal(ledger.viewerCount(session.sessionId), 50);
});

test("a dropped viewer's renewal does not keep the session's own clock alive", () => {
  const now = { value: 1_000 };
  const closed: string[] = [];
  const ledger = new DirectorSessionLedger(
    { budgetUsd: 20, usdPerSecond: 0.08, maxConcurrentSessions: 1, maxSessionSeconds: 60 },
    () => now.value,
    (sessionId) => closed.push(sessionId),
  );
  const session = ledger.open("jam:en|") as { sessionId: string };
  const viewer = ledger.attach(session.sessionId) as string;

  // The viewer goes silent long enough to be dropped — a backgrounded mobile
  // tab whose renew timer was throttled past the cutoff.
  now.value += SESSION_IDLE_TIMEOUT_MS + 1;
  ledger.expireIdle();
  assert.deepEqual(closed, [session.sessionId]);

  // It wakes and keeps renewing with the id it still holds. The route answers
  // 404 and the client ignores it — but if that call refreshed the session
  // clock, a viewerless stream would never be reclaimed and would bill on.
  const revived = ledger.open("jam:en|") as { sessionId: string };
  const stale = ledger.attach(revived.sessionId) as string;
  ledger.detach(revived.sessionId, stale);
  now.value += 10_000;
  assert.equal(ledger.renew(revived.sessionId, stale), false);
  now.value += SESSION_IDLE_TIMEOUT_MS - 9_000;
  ledger.expireIdle();
  assert.equal(ledger.openCount, 0, "a stale renewal must not postpone reclaim");
});
