/**
 * The two ways to work.
 *
 * Direct keeps the microphone armed and applies each completed instruction on
 * its own: hold, speak, release, and it goes. Review is the stopped mode —
 * the microphone is closed, a transcript waits in the field, and the beats
 * carry their own tools.
 *
 * Direct is not an open microphone. Continuous transcription of a session is
 * a provider-load question rather than a feature one (`docs/specs/
 * multimodal-creative-turns.md`), so the gesture bounds it: audio is captured
 * while the control is held and at no other time.
 */
export type DirectorMode = "direct" | "review";

export const MODE_LABEL: Readonly<Record<DirectorMode, string>> = {
  direct: "Direct",
  review: "Review",
};

export const MODE_MEANING: Readonly<Record<DirectorMode, string>> = {
  direct: "Hold to speak. Each finished instruction goes straight to the stream.",
  review: "Stopped. Pick a beat, read it back, and send only what you mean to.",
};
