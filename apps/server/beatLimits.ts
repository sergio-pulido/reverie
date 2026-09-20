/**
 * How much beat generation this process runs at once.
 *
 * This is a concurrency guard, not a spend guard. The demo does not track what
 * generation costs (docs/DECISIONS.md), so nothing here reserves, bills, or
 * refuses work for being expensive; the only limit left is how many fal
 * requests may be in flight together, which protects the provider's rate
 * limits and this server's memory rather than a budget.
 */

export interface BeatLimits {
  maxConcurrentBeats: number;
}

export function resolveBeatLimits(env: NodeJS.ProcessEnv): BeatLimits {
  return {
    maxConcurrentBeats: Math.max(
      1,
      Math.floor(positive(env.REVERIE_BEAT_MAX_CONCURRENT, 2)),
    ),
  };
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
