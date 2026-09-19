import { finalizeScriptDraft } from "./scriptDraft";
import { hardPortionBounds, type JamScript, type ScriptFormat } from "./script";

export class ScriptImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptImportError";
  }
}

// A portion should carry a real chunk of the script, not a handful of words.
// The target is what a reader covers in an average portion; the floor is the
// point below which the runtime simply has too little text to fill.
const TARGET_CHARS_PER_PORTION = 200;
const MIN_CHARS_PER_PORTION = 40;
const MAX_PORTION_CHARS = 600;

/**
 * Builds the timed portion projection needed by playback while revision 1
 * keeps the exact imported markdown. No model call or interpretation occurs.
 *
 * The portion count follows the text: it aims for a readable chunk per portion
 * and never exceeds the jam format's hard timing bounds. A script too short or
 * too long for the selected runtime is rejected instead of being padded or
 * sliced into meaningless fragments.
 */
export function projectImportedScript(
  title: string,
  markdown: string,
  format: ScriptFormat,
): JamScript {
  const text = markdown.trim();
  const bounds = hardPortionBounds(format);
  const minForTiming = Math.ceil(format.totalSeconds / bounds.max);
  const maxForTiming = Math.min(
    Math.floor(format.totalSeconds / bounds.min),
    48,
  );
  const byText = Math.round(text.length / TARGET_CHARS_PER_PORTION);
  const portionCount = Math.min(maxForTiming, Math.max(minForTiming, byText));

  if (text.length < minForTiming * MIN_CHARS_PER_PORTION) {
    throw new ScriptImportError(
      "This script is too short for the selected runtime. Lengthen the script or shorten the total length.",
    );
  }
  if (
    portionCount < minForTiming ||
    text.length / portionCount > MAX_PORTION_CHARS
  ) {
    throw new ScriptImportError(
      "This script is too long for the selected runtime. Shorten it or increase the total length.",
    );
  }

  const chunks = splitIntoChunks(text, portionCount);
  const duration = format.totalSeconds / portionCount;
  return finalizeScriptDraft({
    title,
    logline: `An imported script prepared for this Movie Jam.`,
    scenes: [{
      heading: "Imported script",
      portions: chunks.map((action) => ({ durationSeconds: duration, action })),
    }],
  }, format);
}

/**
 * Splits on word boundaries into `count` roughly even chunks. Each cut targets
 * an even share of the remaining text and snaps to the nearest space so a word
 * is never split across portions.
 */
function splitIntoChunks(text: string, count: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  for (let index = 0; index < count; index += 1) {
    const remaining = count - index;
    if (remaining === 1) {
      chunks.push(rest.trim());
      break;
    }
    const target = Math.min(
      MAX_PORTION_CHARS,
      Math.max(1, Math.ceil(rest.length / remaining)),
    );
    let cut = rest.lastIndexOf(" ", target);
    if (cut <= 0) {
      const next = rest.indexOf(" ", target);
      cut = next === -1 ? Math.min(target, rest.length) : next;
    }
    const chunk = rest.slice(0, cut).trim();
    chunks.push(chunk || rest.slice(0, 1));
    rest = rest.slice(cut).trim();
  }
  return chunks;
}
