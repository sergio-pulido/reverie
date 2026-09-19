// Identity always comes from Supabase Auth. The browser never supplies an author id.

import { JamError, isStaleIdentityError, notConfigured } from "./errors";
import { supabase } from "./supabase";

/** The identity we have already confirmed with the auth server during this page load. */
let confirmedUserId: string | null = null;

export async function currentUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
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
export async function ensureUserId(action = "Joining a jam"): Promise<string> {
  if (!supabase) throw notConfigured(action);
  const existing = await currentUserId();
  if (existing && existing === confirmedUserId) return existing;

  if (existing) {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      confirmedUserId = data.user.id;
      return data.user.id;
    }
    if (!isStaleIdentityError(error)) {
      throw new JamError("unavailable", "Your session could not be confirmed. Check your connection and try again.", true);
    }
    await supabase.auth.signOut({ scope: "local" });
    confirmedUserId = null;
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    throw new JamError("unauthenticated", "Anonymous sign-in could not start. Check the Supabase Auth configuration.", true);
  }
  confirmedUserId = data.user.id;
  return data.user.id;
}

/** The caller's access token, signing in anonymously first if this profile has no session. */
export async function ensureAccessToken(action: string): Promise<string> {
  if (!supabase) throw notConfigured(action);
  await ensureUserId(action);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new JamError("unauthenticated", "Your session is no longer signed in. Reload the page to continue.", true);
  return token;
}
