import type { JamScript } from "../src/core/script";

/** A valid 4-minute script: 4 scenes × 4 portions × 15s = 240s. */
export function buildScript(portionSeconds = 15): JamScript {
  return {
    title: "The Salt Door",
    logline: "A lighthouse keeper finds a door at the bottom of the sea.",
    scenes: Array.from({ length: 4 }, (_, sceneIndex) => ({
      heading: `Beat ${sceneIndex + 1}`,
      portions: Array.from({ length: 4 }, (_, portionIndex) => ({
        durationSeconds: portionSeconds,
        action: `Scene ${sceneIndex + 1}, portion ${portionIndex + 1} action.`,
        dialogue: portionIndex === 0 ? "Someone speaks." : undefined,
        visualDirection: "Slow push in.",
      })),
    })),
  };
}
