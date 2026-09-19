// Whether a participant's own face may seed the film the room is making, and what may
// honestly be said about a beat once it exists. Provider-free: nothing here talks to fal,
// Supabase or the DOM, and nothing here holds a pixel.
//
// The rules are deliberately small and total, because they are the feature. Every path that
// could put a person on screen goes through `usableLikenesses`, and every claim the
// interface makes about a finished beat goes through `describeBeatLikeness`.

import {
  isConsentEffective,
  LIKENESS_CONSENT_KIND,
  type LiveConsent,
} from "./liveMedia";

/** The prefix the register's trigger issues for a likeness grant. */
export const LIKENESS_REF_PREFIX = "likeness:";

/**
 * How many consenting participants can seed one beat.
 *
 * The model accepts nine reference images; three is ours. Each reference is a whole frame in
 * a bounded request body and each one costs, so the cap is a spend and payload decision
 * rather than the provider's limit.
 */
export const MAX_LIKENESS_REFERENCES = 3;

/** An approved frame, bounded so a request body cannot grow without limit. */
export const MAX_FRAME_BYTES = 512 * 1_024;
export const FRAME_CONTENT_TYPE = "image/jpeg";

export function isLikenessRef(assetRef: string): boolean {
  return assetRef.startsWith(LIKENESS_REF_PREFIX) && assetRef.length > LIKENESS_REF_PREFIX.length;
}

export function isLikenessConsent(consent: LiveConsent): boolean {
  return consent.kind === LIKENESS_CONSENT_KIND;
}

/**
 * Every likeness grant in the room, whatever its state.
 *
 * Withdrawn and expired rows stay in the list because the room's own panel has to be able to
 * show a participant that their grant has ended, rather than silently forgetting them.
 */
export function likenessConsents(consents: readonly LiveConsent[]): LiveConsent[] {
  return consents.filter(isLikenessConsent);
}

/**
 * The grants that may seed a beat generated *now*, in the order they were given.
 *
 * This is the only answer to "may this person be in the film". It is evaluated at the moment
 * a generation is submitted, never cached, so a withdrawal a second earlier is honoured by
 * the next beat without anything having to invalidate anything.
 */
export function usableLikenesses(
  consents: readonly LiveConsent[],
  now = Date.now(),
): LiveConsent[] {
  return likenessConsents(consents)
    .filter((consent) => isConsentEffective(consent, now))
    .filter((consent) => isLikenessRef(consent.asset_ref))
    .sort((a, b) =>
      a.granted_at === b.granted_at ? a.id.localeCompare(b.id) : a.granted_at < b.granted_at ? -1 : 1,
    )
    .slice(0, MAX_LIKENESS_REFERENCES);
}

export type LikenessRefusal =
  | "not_a_likeness_consent"
  | "not_yours"
  | "withdrawn_or_expired"
  | "no_frame";

/**
 * Whether this caller may attach or read the frame behind one consent.
 *
 * Only the owner, only their own grant, only while it stands. A participant cannot grant on
 * another's behalf and cannot reach another's frame, and both refusals are the same shape so
 * neither reveals anything about the other.
 */
export function decideFrameAccess(
  consent: LiveConsent,
  callerId: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; reason: LikenessRefusal } {
  if (!isLikenessConsent(consent)) return { allowed: false, reason: "not_a_likeness_consent" };
  if (consent.owner_id !== callerId) return { allowed: false, reason: "not_yours" };
  if (!isConsentEffective(consent, now)) return { allowed: false, reason: "withdrawn_or_expired" };
  return { allowed: true };
}

/**
 * What one finished beat used.
 *
 * Recorded when the beat was generated and never rewritten. A beat is a thing that happened:
 * the references it was made from are a fact about the past, and the only honest thing the
 * interface can do with a later withdrawal is say so.
 */
export interface BeatLikenessUse {
  /** Consent ids whose frames seeded this beat, in the order they were sent. */
  readonly consentIds: readonly string[];
  readonly assetRefs: readonly string[];
  readonly ownerIds: readonly string[];
  readonly generatedAt: string;
  /** The allowlisted model that made it. */
  readonly model: string;
}

export type BeatLikenessStanding = "none" | "standing" | "withdrawn_since";

/**
 * How a finished beat may be described now.
 *
 * - `none`: no likeness seeded it, so nothing may suggest one did.
 * - `standing`: every grant it used is still effective.
 * - `withdrawn_since`: at least one has ended. The beat still shows that person, because it
 *   was already made. Saying anything else would be a lie, so the caller must say this.
 *
 * Withdrawal never converts a `standing` beat into a `none` beat. That mistake is the whole
 * reason this function exists rather than a boolean.
 */
export function describeBeatLikeness(
  use: BeatLikenessUse | null,
  consents: readonly LiveConsent[],
  now = Date.now(),
): BeatLikenessStanding {
  if (!use || use.consentIds.length === 0) return "none";
  const stillEffective = new Set(
    usableLikenesses(consents, now).map((consent) => consent.id),
  );
  return use.consentIds.every((id) => stillEffective.has(id)) ? "standing" : "withdrawn_since";
}

/** The words the room sees. They state what is true of a beat, never what would be kinder. */
export const BEAT_LIKENESS_MESSAGE: Record<BeatLikenessStanding, string> = {
  none: "No one's likeness was used for this beat.",
  standing: "Made with the likeness of everyone who agreed, and they still agree.",
  withdrawn_since:
    "Made before that agreement ended. This beat already exists and still shows them; " +
    "ending the agreement stops the next beat, not this one.",
};

/**
 * Which people a beat about to be generated will show, for the sentence shown before the
 * press. It is derived from the same function the generation uses, so the interface cannot
 * promise a likeness the server will not use, or omit one it will.
 */
export function plannedLikenessOwners(
  consents: readonly LiveConsent[],
  now = Date.now(),
): string[] {
  return usableLikenesses(consents, now).map((consent) => consent.owner_id);
}
