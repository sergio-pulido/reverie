import type { JamScript } from "../src/core/script";

/**
 * A script of `scenes × portionsPerScene` portions, each `portionSeconds` long.
 *
 * The default shape (16 × 15s = 240s) predates the MiniMax portion band and is
 * kept because most callers only need *a* structurally valid script. Tests that
 * validate against a specific format pass the shape they need; `buildDefaultFormatScript`
 * covers the common case of "valid under DEFAULT_SCRIPT_FORMAT".
 */
export function buildScript(
  portionSeconds = 15,
  scenes = 4,
  portionsPerScene = 4,
): JamScript {
  return {
    title: "The Salt Door",
    logline: "A lighthouse keeper finds a door at the bottom of the sea.",
    scenes: Array.from({ length: scenes }, (_, sceneIndex) => ({
      heading: `Beat ${sceneIndex + 1}`,
      portions: Array.from({ length: portionsPerScene }, (_, portionIndex) => ({
        durationSeconds: portionSeconds,
        action: `Scene ${sceneIndex + 1}, portion ${portionIndex + 1} action.`,
        dialogue: portionIndex === 0 ? "Someone speaks." : undefined,
        visualDirection: "Slow push in.",
      })),
    })),
  };
}

/** 2 scenes × 2 portions × 15s = 60s: exactly DEFAULT_SCRIPT_FORMAT. */
export function buildDefaultFormatScript(): JamScript {
  return buildScript(15, 2, 2);
}
