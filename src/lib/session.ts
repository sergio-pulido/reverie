// Identity always comes from Supabase Auth. The browser never supplies an author id.

import { JamError, notConfigured } from "./errors";
import { supabase } from "./supabase";

export async function currentUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

/** Signs in anonymously once per browser profile and reuses that identity afterwards. */
export async function ensureUserId(action = "Joining a jam"): Promise<string> {
  if (!supabase) throw notConfigured(action);
  const existing = await currentUserId();
  if (existing) return existing;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    throw new JamError("unauthenticated", "Anonymous sign-in could not start. Check the Supabase Auth configuration.", true);
  }
  return data.user.id;
}
