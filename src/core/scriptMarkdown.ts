import { totalDurationSeconds, type JamScript } from "./script";
import type { JamSource } from "./jam";
import type { JamSession } from "./session";

export function renderScriptMarkdown(
  script: JamScript,
  source: JamSource,
  session?: JamSession,
): string {
  const lines: string[] = [];
  const total = totalDurationSeconds(script);
  const portionCount = script.scenes.reduce(
    (sum, scene) => sum + scene.portions.length,
    0,
  );

  lines.push(`# ${script.title}`);
  lines.push("");
  lines.push(`> ${script.logline}`);
  lines.push("");
  lines.push(`- Source: ${describeSource(source)}`);
  lines.push(
    `- Runtime: ${formatClock(total)} (${total}s) across ${count(script.scenes.length, "scene")} and ${count(portionCount, "scene portion")}`,
  );
  lines.push(
    "- This is a generated Movie Jam script, not an existing film or catalogue title.",
  );
  if (session) {
    lines.push(
      `- Playback for ${session.owner.displayName}: language ${session.settings.language}` +
        (session.settings.ambientation
          ? `, ambientation “${session.settings.ambientation}”`
          : ", ambientation as written"),
    );
  }

  let elapsed = 0;
  script.scenes.forEach((scene, sceneIndex) => {
    lines.push("");
    lines.push(`## Scene ${sceneIndex + 1} — ${scene.heading}`);
    scene.portions.forEach((portion, portionIndex) => {
      const start = elapsed;
      elapsed += portion.durationSeconds;
      lines.push("");
      lines.push(
        `### Portion ${sceneIndex + 1}.${portionIndex + 1} · ${formatClock(start)}–${formatClock(elapsed)} (${portion.durationSeconds}s)`,
      );
      lines.push("");
      lines.push(`**Action.** ${portion.action}`);
      if (portion.dialogue) {
        lines.push("");
        lines.push(`**Dialogue.** ${portion.dialogue}`);
      }
      if (portion.visualDirection) {
        lines.push("");
        lines.push(`**Visuals.** ${portion.visualDirection}`);
      }
    });
  });

  lines.push("");
  return lines.join("\n");
}

function describeSource(source: JamSource): string {
  if (source.kind === "from-scratch") {
    return `from scratch, prompted by “${source.prompt}”`;
  }
  if (source.kind === "imported-script") {
    return `imported script “${source.scriptTitle}”`;
  }
  return `an original story inspired by “${source.movieTitle}”`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
