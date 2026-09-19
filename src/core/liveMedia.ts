// Provider-free live-media rules: what a membership is allowed to do on the live stage,
// what a consent record means, and the shapes crossing the browser/server boundary.
// Nothing here talks to Vonage, Supabase or the DOM.

import { z } from "zod";

export const LIVE_TRACK_KINDS = ["camera", "microphone", "screen"] as const;
export type LiveTrackKind = (typeof LIVE_TRACK_KINDS)[number];

export const liveRoleSchema = z.enum(["subscriber", "publisher", "moderator"]);
export type LiveRole = z.infer<typeof liveRoleSchema>;

export const liveTokenRequestSchema = z.object({ jamId: z.string().uuid() }).strict();

export const liveTokenResponseSchema = z.object({
  status: z.literal("ok"),
  authId: z.string().min(1),
  sessionId: z.string().min(16),
  token: z.string().min(16),
  role: liveRoleSchema,
  expiresAt: z.string(),
});
export type LiveTokenResponse = z.infer<typeof liveTokenResponseSchema>;

export const liveConsentSchema = z.object({
  id: z.string().uuid(),
  jam_id: z.string().uuid(),
  owner_id: z.string().uuid(),
  kind: z.enum(LIVE_TRACK_KINDS),
  purpose: z.string(),
  asset_ref: z.string(),
  granted_at: z.string(),
  expires_at: z.string(),
  withdrawn_at: z.string().nullable(),
});
export type LiveConsent = z.infer<typeof liveConsentSchema>;

export const CONSENT_MIN_PURPOSE = 3;
export const CONSENT_MAX_PURPOSE = 200;
/** The register clamps a lifetime to this; a longer stay is a fresh, deliberate grant. */
export const CONSENT_MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
export const CONSENT_DEFAULT_LIFETIME_MS = 30 * 60 * 1_000;

/**
 * The only definition of "this contribution may be used". Withdrawal and expiry are the
 * same answer to the caller, so nothing downstream needs to know which one happened.
 */
export function isConsentEffective(consent: LiveConsent, now = Date.now()): boolean {
  if (consent.withdrawn_at !== null) return false;
  const expires = Date.parse(consent.expires_at);
  return Number.isFinite(expires) && expires > now;
}

export function effectiveConsents(consents: readonly LiveConsent[], now = Date.now()): LiveConsent[] {
  return consents.filter((consent) => isConsentEffective(consent, now));
}

/** Which of a participant's own track kinds are currently permitted to publish. */
export function permittedKinds(
  consents: readonly LiveConsent[],
  ownerId: string,
  now = Date.now(),
): Set<LiveTrackKind> {
  return new Set(
    effectiveConsents(consents, now)
      .filter((consent) => consent.owner_id === ownerId)
      .map((consent) => consent.kind),
  );
}

export function normalizePurpose(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < CONSENT_MIN_PURPOSE || value.length > CONSENT_MAX_PURPOSE) {
    return { ok: false, message: `Say what this is for, in ${CONSENT_MIN_PURPOSE} to ${CONSENT_MAX_PURPOSE} characters.` };
  }
  return { ok: true, value };
}

export type LiveAccessDecision =
  | { allowed: true; role: LiveRole }
  | { allowed: false; reason: "not_active" | "jam_closed" };

/**
 * The server's role decision. A client cannot ask for `moderator`: the only input is the
 * membership row the database returned for that caller.
 */
export function decideLiveAccess(facts: { role: "host" | "member"; status: string; jamStatus: string }): LiveAccessDecision {
  if (facts.jamStatus === "closed" || facts.jamStatus === "completed") {
    return { allowed: false, reason: "jam_closed" };
  }
  if (facts.status !== "active") return { allowed: false, reason: "not_active" };
  return { allowed: true, role: facts.role === "host" ? "moderator" : "publisher" };
}

export type MediaPermissionOutcome = "denied" | "unavailable" | "in_use" | "failed";

/**
 * Maps a getUserMedia/getDisplayMedia rejection onto a stated outcome. A refused permission
 * is never retried silently and never reported as a network fault.
 */
export function classifyMediaError(error: unknown): MediaPermissionOutcome {
  const name = (error as { name?: unknown })?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "unavailable";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "in_use";
  return "failed";
}

export const MEDIA_OUTCOME_MESSAGE: Record<MediaPermissionOutcome, string> = {
  denied: "Your browser refused access. Allow it in the address bar, then try again.",
  unavailable: "No matching device was found on this machine.",
  in_use: "That device is already in use by another application.",
  failed: "That device could not be started.",
};
