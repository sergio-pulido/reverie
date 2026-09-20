import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentity, type AuthClient } from "../src/lib/session";

/** An auth server stand-in: anonymous sign-in takes a moment, as a real one does. */
function fakeAuth() {
  let session: { user: { id: string }; access_token: string } | null = null;
  const counts = { signIns: 0, getUser: 0, signOuts: 0 };
  const listeners: ((event: string, session: unknown) => void)[] = [];
  const auth = {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
      listeners.push(listener);
      return { data: { subscription: { unsubscribe: () => { listeners.length = 0; } } } };
    },
    getUser: async () => {
      counts.getUser += 1;
      return { data: { user: session?.user ?? null }, error: null };
    },
    signOut: async () => {
      counts.signOuts += 1;
      session = null;
      for (const listener of [...listeners]) listener("SIGNED_OUT", null);
      return { error: null };
    },
    signInAnonymously: async () => {
      counts.signIns += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      session = { user: { id: `user-${counts.signIns}` }, access_token: `token-${counts.signIns}` };
      // The real client announces the new session to its auth-state listeners, as this does.
      for (const listener of [...listeners]) listener("SIGNED_IN", session);
      return { data: { user: session.user }, error: null };
    },
  };
  return { client: { auth } as unknown as AuthClient, counts };
}

describe("createIdentity", () => {
  it("signs in once when several reads start together on a first visit", async () => {
    const { client, counts } = fakeAuth();
    const identity = createIdentity(client);
    const tokens = await Promise.all([identity.ensureAccessToken("a shelf"), identity.ensureAccessToken("another shelf"), identity.ensureUserId()]);
    assert.equal(counts.signIns, 1);
    assert.equal(tokens[0], tokens[1]);
    assert.equal(tokens[2], "user-1");
  });

  it("confirms an identity once per page load, then reuses it", async () => {
    const { client, counts } = fakeAuth();
    const identity = createIdentity(client);
    await identity.ensureUserId();
    const fresh = createIdentity(client);
    await Promise.all([fresh.ensureUserId(), fresh.ensureUserId()]);
    await fresh.ensureUserId();
    assert.equal(counts.signIns, 1);
    assert.equal(counts.getUser, 1);
  });

  it("signs out for real: the next visit mints a new anonymous user", async () => {
    const { client, counts } = fakeAuth();
    const identity = createIdentity(client);
    assert.equal(await identity.ensureUserId(), "user-1");

    await identity.signOut();
    assert.equal(counts.signOuts, 1, "Supabase is asked to end the session");
    assert.equal(await identity.currentUserId(), null, "nothing local still points at the old identity");

    assert.equal(await identity.ensureUserId(), "user-2", "a new anonymous user, not the abandoned one");
    assert.equal(counts.signIns, 2);
  });

  it("reports the viewer without signing anyone in, and again when the session changes", async () => {
    const { client, counts } = fakeAuth();
    const identity = createIdentity(client);
    const seen: (string | null)[] = [];
    const stop = identity.observeUserId((userId) => seen.push(userId));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, [null], "nobody is signed in yet, and watching did not sign anyone in");
    assert.equal(counts.signIns, 0);

    await identity.ensureUserId();
    assert.equal(seen.at(-1), "user-1", "the sign-in the screens caused is reported");
    await identity.signOut();
    assert.equal(seen.at(-1), null);
    stop();
  });

  it("signs out cleanly with no project configured", async () => {
    const identity = createIdentity(null);
    await identity.signOut();
    assert.equal(await identity.currentUserId(), null);
  });

  it("refuses plainly when no project is configured", async () => {
    const identity = createIdentity(null);
    await assert.rejects(identity.ensureAccessToken("Browsing films"), { code: "not_configured" });
    assert.equal(await identity.currentUserId(), null);
  });
});
