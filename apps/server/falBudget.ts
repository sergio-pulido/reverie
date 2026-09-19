/**
 * One budget for everything this process buys from fal.
 *
 * `FAL_ASSET_BUDGET_USD` was already the total the server may commit, and the live director
 * reserves against it per session. Beat generation is a second way to spend the same money,
 * so it reserves against the same ledger rather than getting a budget of its own — two
 * budgets would mean the stated total was never the real one.
 *
 * Every path reserves its worst case before it starts and settles afterwards. A reservation
 * that is never settled stays committed, which errs towards refusing work rather than
 * towards a bill nobody expected.
 */

export class FalBudget {
  private committedUsd = 0;
  private reservations = 0;

  constructor(private readonly budgetUsd: number) {}

  get totalUsd(): number {
    return this.budgetUsd;
  }

  get spentUsd(): number {
    return this.committedUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.committedUsd);
  }

  get openReservations(): number {
    return this.reservations;
  }

  /**
   * Commits `usd` if the budget can carry it. The caller gets back a settle function; calling
   * it with the real cost replaces the reservation, and calling it with zero refunds it in
   * full — for work that never started and so can never be billed.
   */
  reserve(usd: number): ((actualUsd: number) => void) | null {
    if (!Number.isFinite(usd) || usd < 0) return null;
    if (this.committedUsd + usd > this.budgetUsd) return null;
    this.committedUsd += usd;
    this.reservations += 1;
    let settled = false;
    return (actualUsd: number) => {
      if (settled) return;
      settled = true;
      this.reservations -= 1;
      const billed = Number.isFinite(actualUsd) && actualUsd > 0 ? Math.min(usd, actualUsd) : 0;
      this.committedUsd = this.committedUsd - usd + billed;
    };
  }
}

export function resolveFalBudget(env: NodeJS.ProcessEnv = process.env): FalBudget {
  const value = Number(env.FAL_ASSET_BUDGET_USD?.trim());
  return new FalBudget(Number.isFinite(value) && value > 0 ? value : 0);
}

/**
 * What a beat costs, per second of generated video, at the resolution this server generates.
 *
 * These are fal's published rates for the two allowlisted models, read from fal's own model
 * listing on 2026-09-20, and the reference model's rate is the higher of the two — it is not
 * on the promotional discount the plain model currently carries. They are defaults, not
 * measurements: no response from the provider carries a price, so the server cannot learn
 * the real figure and must be told it. Both are overridable, and both default to the list
 * rate so a stale default never understates the bill.
 */
export const DEFAULT_PLAIN_USD_PER_SECOND = 0.08;
export const DEFAULT_LIKENESS_USD_PER_SECOND = 0.08;

export interface BeatSpendRates {
  plainUsdPerSecond: number;
  likenessUsdPerSecond: number;
  maxConcurrentBeats: number;
}

export function resolveBeatSpendRates(env: NodeJS.ProcessEnv): BeatSpendRates {
  return {
    plainUsdPerSecond: positive(env.REVERIE_BEAT_USD_PER_SECOND, DEFAULT_PLAIN_USD_PER_SECOND),
    likenessUsdPerSecond: positive(
      env.REVERIE_BEAT_LIKENESS_USD_PER_SECOND,
      DEFAULT_LIKENESS_USD_PER_SECOND,
    ),
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

/** Worst-case cost of one beat, before it is generated. */
export function beatCostUsd(
  rates: BeatSpendRates,
  seconds: number,
  withLikeness: boolean,
): number {
  const rate = withLikeness ? rates.likenessUsdPerSecond : rates.plainUsdPerSecond;
  return Math.max(0, seconds) * rate;
}
