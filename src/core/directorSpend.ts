/**
 * What a Director session costs, in US dollars.
 *
 * Every figure here is derived from seconds the provider actually generated
 * and the rates this server is configured with. Nothing is a placeholder and
 * nothing is converted: fal prices the model per generated second in USD, so
 * showing it in any other currency would mean inventing a rate.
 *
 * The rates live on the server (`FAL_ASSET_BUDGET_USD`,
 * `REVERIE_DIRECTOR_USD_PER_SECOND`) and the arithmetic lives here, so the
 * ledger that reserves the money and the screen that reports it cannot drift.
 */

export interface DirectorRates {
  /** The ceiling, from `FAL_ASSET_BUDGET_USD`. Zero when it is not set. */
  budgetUsd: number;
  /** fal's price per generated second. */
  usdPerSecond: number;
  /** The provider's per-session minimum, billed whether or not it is used. */
  minBilledSeconds: number;
}

export interface DirectorSpend extends DirectorRates {
  /**
   * Billed for this session so far, from the seconds it has generated. Zero
   * before a session is opened; from the moment one is, it is at least the
   * provider's minimum, because that is what the minimum means.
   */
  sessionUsd: number;
  /** The ceiling less everything committed, including this session. */
  remainingUsd: number;
}

/** No session open yet: nothing spent, the whole budget still ahead. */
export function unopenedSpend(rates: DirectorRates, committedUsd = 0): DirectorSpend {
  return { ...rates, sessionUsd: 0, remainingUsd: Math.max(0, rates.budgetUsd - committedUsd) };
}

/**
 * Seconds a session is billed for. The provider charges whole seconds and
 * never fewer than its minimum, so a session that generated four seconds is
 * billed the same as one that generated none.
 */
export function billedSeconds(generatedSeconds: number, minBilledSeconds: number): number {
  // A number that is not one — a counter that never arrived — must not make
  // the bill unreadable. It reads as nothing generated, which is the minimum.
  const seconds = Number.isFinite(generatedSeconds) ? Math.max(0, generatedSeconds) : 0;
  return Math.max(minBilledSeconds, Math.ceil(seconds));
}

/** What an open session has cost, from the seconds it has generated. */
export function sessionSpendUsd(generatedSeconds: number, rates: DirectorRates): number {
  return billedSeconds(generatedSeconds, rates.minBilledSeconds) * rates.usdPerSecond;
}

/**
 * Whether the budget left can pay for `seconds` of generation.
 *
 * A tenth of a cent of slack, because these are sums of floating-point
 * products: a beat that costs exactly what is left must not be refused for
 * being 0.0000000001 over.
 */
export function canAfford(spend: DirectorSpend, seconds: number): boolean {
  return spend.remainingUsd + 0.0005 >= seconds * spend.usdPerSecond;
}

/** True when nothing more can be generated at all. */
export function budgetSpent(spend: DirectorSpend): boolean {
  return spend.remainingUsd <= 0;
}

/**
 * A dollar amount as the screen shows it: always USD, always two decimals.
 * Not `Intl.NumberFormat` with the viewer's locale, which would re-label the
 * same number as their own currency without converting it.
 */
export function formatUsd(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `$${safe.toFixed(2)}`;
}
