// Browser side of the consent register and the token exchange. The browser never learns a
// provider secret, never picks its own role, and never writes an asset reference.

import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  liveConsentSchema,
  liveTokenResponseSchema,
  normalizePurpose,
  type LiveConsent,
  type LiveTokenResponse,
  type LiveTrackKind,
} from "../core/liveMedia";
import { JamError, notConfigured, toJamError } from "./errors";
import { supabase } from "./supabase";

const CONSENT_COLUMNS = "id, jam_id, owner_id, kind, purpose, asset_ref, granted_at, expires_at, withdrawn_at";
const CONSENT_PAGE = 200;

export type LiveTokenOutcome =
  | { status: "ok"; live: LiveTokenResponse }
  | { status: "not_configured"; safeMessage: string };

/**
 * Exchanges the caller's Supabase session for a short-lived Vonage token. The request body
 * carries only a jam id: identity, membership and role are the server's to decide.
 */
export async function requestLiveToken(jamId: string): Promise<LiveTokenOutcome> {
  if (!supabase) throw notConfigured("Joining the live stage");

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new JamError("unauthenticated", "Your session is no longer signed in. Reload the page to continue.");

  let response: Response;
  try {
    response = await fetch("/api/live/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jamId }),
    });
  } catch {
    throw new JamError("unavailable", "The live stage could not be reached.", true);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JamError("unavailable", "The live stage returned an unexpected response.", true);
  }

  const envelope = body as { status?: unknown; safeMessage?: unknown; retryable?: unknown };
  if (envelope?.status === "live_not_configured") {
    return {
      status: "not_configured",
      safeMessage: typeof envelope.safeMessage === "string" ? envelope.safeMessage : "Live media is not enabled for this deployment.",
    };
  }
  if (!response.ok) {
    throw new JamError(
      response.status === 403 ? "forbidden" : response.status === 401 ? "unauthenticated" : "unavailable",
      typeof envelope?.safeMessage === "string" ? envelope.safeMessage : "The live stage refused that request.",
      envelope?.retryable === true,
    );
  }

  const parsed = liveTokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new JamError("unavailable", "The live stage returned an unexpected response.", true);
  return { status: "ok", live: parsed.data };
}

export async function loadLiveConsents(jamId: string): Promise<LiveConsent[]> {
  if (!supabase) throw notConfigured("Reading live consent");
  const { data, error } = await supabase
    .from("jam_live_consents")
    .select(CONSENT_COLUMNS)
    .eq("jam_id", jamId)
    .order("granted_at", { ascending: true })
    .limit(CONSENT_PAGE);
  if (error) throw toJamError(error, "The live consent register could not be loaded.");

  return (data ?? []).flatMap((row) => {
    const parsed = liveConsentSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Records consent for one track kind. `asset_ref` and the lifetime are omitted on purpose:
 * a database trigger issues the reference and clamps the expiry, so neither is the
 * browser's to choose.
 */
export async function grantLiveConsent(jamId: string, kind: LiveTrackKind, rawPurpose: string): Promise<LiveConsent> {
  if (!supabase) throw notConfigured("Granting live consent");
  const purpose = normalizePurpose(rawPurpose);
  if (!purpose.ok) throw new JamError("invalid_input", purpose.message);

  const { data, error } = await supabase
    .from("jam_live_consents")
    .insert({ jam_id: jamId, kind, purpose: purpose.value })
    .select(CONSENT_COLUMNS)
    .single();
  if (error) throw toJamError(error, "That consent could not be recorded.");

  const parsed = liveConsentSchema.safeParse(data);
  if (!parsed.success) throw new JamError("unavailable", "The consent register returned an unexpected record.", true);
  return parsed.data;
}

/** Withdrawal is a constrained function: it can only stamp the caller's own row. */
export async function withdrawLiveConsent(consentId: string): Promise<void> {
  if (!supabase) throw notConfigured("Withdrawing live consent");
  const { error } = await supabase.rpc("withdraw_live_consent", { p_consent_id: consentId });
  if (error) throw toJamError(error, "That consent could not be withdrawn.");
}

/**
 * Watches the register. A withdrawal elsewhere in the room arrives here as an UPDATE, which
 * is what stops another participant from continuing to use the reference.
 */
export function subscribeToLiveConsents(
  jamId: string,
  onConsent: (consent: LiveConsent) => void,
): () => void {
  if (!supabase) return () => {};

  const client = supabase;
  let disposed = false;
  const channel: RealtimeChannel = client
    .channel(`jam-live:${jamId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "jam_live_consents", filter: `jam_id=eq.${jamId}` },
      ({ new: row }: { new: unknown }) => {
        if (disposed) return;
        const parsed = liveConsentSchema.safeParse(row);
        if (parsed.success) onConsent(parsed.data);
      },
    )
    .subscribe();

  return () => {
    disposed = true;
    void client.removeChannel(channel);
  };
}
