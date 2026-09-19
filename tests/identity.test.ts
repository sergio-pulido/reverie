import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentity, type AuthClient } from "../src/lib/session";

/** An auth server stand-in: anonymous sign-in takes a moment, as a real one does. */
function fakeAuth() {
  let session: { user: { id: string }; access_token: string } | null = null;
  const counts = { signIns: 0, getUser: 0 };
  const auth = {
    getSession: async () => ({ data: { session } }),
    getUser: async () => {
      counts.getUser += 1;
      return { data: { user: session?.user ?? null }, error: null };
    },
    signOut: async () => ({ error: null }),
    signInAnonymously: async () => {
      counts.signIns += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      session = { user: { id: `user-${counts.signIns}` }, access_token: `token-${counts.signIns}` };
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

  it("refuses plainly when no project is configured", async () => {
    const identity = createIdentity(null);
    await assert.rejects(identity.ensureAccessToken("Browsing films"), { code: "not_configured" });
    assert.equal(await identity.currentUserId(), null);
  });
});
