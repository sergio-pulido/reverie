// Identity always comes from Supabase Auth. The browser never supplies an author id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { JamError, isStaleIdentityError, notConfigured } from "./errors";
import { supabase } from "./supabase";

/** The part of the Supabase client identity needs, so a test can stand in for it. */
export type AuthClient = Pick<SupabaseClient, "auth">;

/**
 * Identity for one Supabase client.
 *
 * `ensureUserId` is single-flight: callers that arrive while an identity is being confirmed or
 * created share that one attempt. Without it, two reads started together on a first visit (the
 * home's first two shelves) would each find no session and each sign in anonymously, leaving the
 * browser with whichever identity finished last.
 */
export function createIdentity(client: AuthClient | null) {
  /** The identity already confirmed with the auth server during this page load. */
  let confirmedUserId: string | null = null;
  let inFlight: Promise<string> | null = null;

  async function currentUserId(): Promise<string | null> {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  }

  /**
   * Signs in anonymously once per browser profile and reuses that identity afterwards.
   *
   * A persisted Supabase session can outlive the user it points at — for example after the
   * project's database is reset. `getSession` reads that record straight from storage
   * without asking the server, so the identity is confirmed with `getUser` before it is
   * trusted. When the auth server reports the identity is gone, the dead local session is
   * discarded and a fresh anonymous identity is created; otherwise every room insert would
   * fail on the orphaned `host_id` foreign key forever. A transient network failure is
   * surfaced instead of silently replacing the participant's identity.
   */
  async function resolveUserId(auth: AuthClient["auth"]): Promise<string> {
    const existing = await currentUserId();
    if (existing && existing === confirmedUserId) return existing;

    if (existing) {
      const { data, error } = await auth.getUser();
      if (!error && data.user) {
        confirmedUserId = data.user.id;
        return data.user.id;
      }
      if (!isStaleIdentityError(error)) {
        throw new JamError("unavailable", "Your session could not be confirmed. Check your connection and try again.", true);
      }
      await auth.signOut({ scope: "local" });
      confirmedUserId = null;
    }

    const { data, error } = await auth.signInAnonymously();
    if (error || !data.user) {
      throw new JamError("unauthenticated", "Anonymous sign-in could not start. Check the Supabase Auth configuration.", true);
    }
    confirmedUserId = data.user.id;
    return data.user.id;
  }

  async function ensureUserId(action = "Joining a jam"): Promise<string> {
    if (!client) throw notConfigured(action);
    inFlight ??= resolveUserId(client.auth).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** The caller's access token, signing in anonymously first if this profile has no session. */
  async function ensureAccessToken(action: string): Promise<string> {
    if (!client) throw notConfigured(action);
    await ensureUserId(action);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new JamError("unauthenticated", "Your session is no longer signed in. Reload the page to continue.", true);
    return token;
  }

  /**
   * A real sign-out: Supabase discards the anonymous session and the identity confirmed during
   * this page load is forgotten, so the next `ensureUserId` mints a new anonymous user rather
   * than handing back the one that was just abandoned.
   *
   * The local state is cleared first, so a sign-out that fails at the auth server still leaves
   * nothing here pointing at the old identity.
   */
  async function signOut(): Promise<void> {
    confirmedUserId = null;
    inFlight = null;
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw new JamError("unavailable", "You could not be signed out. Check your connection and try again.", true);
  }

  /**
   * Reports the signed-in user id now and again whenever Supabase Auth changes it, so a surface
   * that only *shows* the viewer (the account avatar) never signs anyone in to find out who they
   * are — it waits for the sign-in the screens themselves cause.
   */
  function observeUserId(listener: (userId: string | null) => void): () => void {
    void currentUserId().then(listener);
    if (!client) return () => undefined;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      // Only ever invalidates the cache: an id is confirmed with `getUser` before it is trusted.
      if (!session) confirmedUserId = null;
      listener(session?.user.id ?? null);
    });
    return () => data.subscription.unsubscribe();
  }

  return { currentUserId, ensureUserId, ensureAccessToken, signOut, observeUserId };
}

const identity = createIdentity(supabase);

export const currentUserId = identity.currentUserId;
export const ensureUserId = identity.ensureUserId;
export const ensureAccessToken = identity.ensureAccessToken;
export const signOutViewer = identity.signOut;
export const observeUserId = identity.observeUserId;
