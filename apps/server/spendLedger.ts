/**
 * One account for everything this process may spend at fal.
 *
 * `FAL_ASSET_BUDGET_USD` is a ceiling on the process, not on a feature. Two
 * features each holding their own copy of that number would each believe they
 * could spend all of it, and the documented ceiling would quietly become twice
 * what it says — so the director's per-second sessions and the escape room's
 * per-segment generations debit the same account.
 *
 * Money is committed before the provider is called and settled afterwards,
 * never the other way round: a crash between the two must leave the budget
 * overstated rather than understated.
 */

export function readPositive(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class SpendAccount {
  private committed = 0;

  constructor(readonly budgetUsd: number) {}

  get committedUsd(): number {
    return this.committed;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.committed);
  }

  /** Whether `usd` could be committed right now, without committing it. */
  affords(usd: number): boolean {
    return this.committed + usd <= this.budgetUsd;
  }

  /** Commits `usd`, or answers false and commits nothing. */
  commit(usd: number): boolean {
    if (!this.affords(usd)) return false;
    this.committed += usd;
    return true;
  }

  /** Gives back money for work that never reached the provider. */
  refund(usd: number): void {
    this.committed = Math.max(0, this.committed - usd);
  }

  /**
   * Replaces a reservation with what the work actually cost. Never settles
   * above the reservation: the reservation was the worst case, and charging
   * past it would mean the ceiling was never a ceiling.
   */
  settle(reservedUsd: number, actualUsd: number): void {
    this.committed = Math.max(0, this.committed - reservedUsd + Math.min(reservedUsd, actualUsd));
  }
}

export function resolveSpendAccount(env: NodeJS.ProcessEnv = process.env): SpendAccount {
  return new SpendAccount(readPositive(env.FAL_ASSET_BUDGET_USD, 0));
}
