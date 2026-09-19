import { DEFAULT_SESSION_LANGUAGE, type SessionSettings } from "./session";

/**
 * How a viewer's configuration selects a stream.
 *
 * One director stream is generated per distinct configuration in a room, not
 * one per participant, so this key is what decides whether two viewers share
 * a paid stream or each cause another (docs/DECISIONS.md).
 */

/** What a viewer without a session of their own watches: the script as written. */
export const DEFAULT_CONFIGURATION: SessionSettings = {
  language: DEFAULT_SESSION_LANGUAGE,
  ambientation: "",
};

/**
 * The normalized configuration a session selects
 * (docs/specs/configuration-keyed-streams.md): language tag casing and
 * surrounding or repeated whitespace are cosmetic, so they must not multiply
 * streams. The spec leaves exact canonicalisation open; this is the choice
 * this build makes, and the one place it is made.
 */
export function configurationKey(settings: SessionSettings): string {
  const language = settings.language.trim().toLowerCase();
  const ambientation = settings.ambientation.trim().replace(/\s+/g, " ").toLowerCase();
  return `${language}|${encodeURIComponent(ambientation)}`;
}

/** The configuration in the same words the annotated script view uses. */
export function describeConfiguration(settings: SessionSettings): string {
  return (
    `language ${settings.language.trim().toLowerCase()}` +
    (settings.ambientation.trim()
      ? `, ambientation “${settings.ambientation.trim()}”`
      : ", ambientation as written")
  );
}
