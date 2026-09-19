import { formatClock } from "./clock";
import { buildOutline } from "./outline";
import { totalDurationSeconds, type JamScript } from "./script";

/**
 * The film's beats against the clock: when each one starts, how long it runs,
 * and the phrase that describes it.
 *
 * A different document from the screenplay, not a second copy of it. The
 * screenplay is what gets generated; this is what gets checked against a
 * stopwatch, so it carries timing and the beat phrase and no prose.
 *
 * It invents nothing. Every cell is the script's own: the offsets come from
 * the same cumulative arithmetic the stream's timeline uses, and a beat
 * written before outlines existed has no phrase, which the table shows as a
 * dash and the document explains.
 */
export function renderTimedOutline(script: JamScript): string {
  const beats = buildOutline(script);
  const total = totalDurationSeconds(script);
  const unnamed = beats.filter((beat) => !beat.summary).length;

  const lines = [
    `# ${script.title} — timed outline`,
    "",
    `> ${script.logline}`,
    "",
    `- Runtime: ${formatClock(total)} (${total}s) across ${beats.length} beat${beats.length === 1 ? "" : "s"}`,
    "- This is a generated Movie Jam outline, not an existing film or catalogue title.",
  ];
  if (unnamed > 0) {
    lines.push(
      `- ${unnamed} beat${unnamed === 1 ? " has" : "s have"} no phrase: ${unnamed === 1 ? "it was" : "they were"} written before the outline existed, and history is append-only.`,
    );
  }
  lines.push("", "| # | In | Out | Length | Scene | Beat |", "| ---: | --- | --- | ---: | --- | --- |");
  for (const beat of beats) {
    const out = beat.startSeconds + beat.durationSeconds;
    lines.push(
      `| ${beat.portionIndex + 1} | ${formatClock(beat.startSeconds)} | ${formatClock(out)} | ${beat.durationSeconds}s | ${cell(beat.sceneHeading)} | ${cell(beat.summary)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** A table cell: a pipe would break the row, and nothing to say reads as a dash. */
function cell(value: string | undefined): string {
  const text = value?.trim();
  return text ? text.replace(/\|/g, "\\|") : "—";
}
