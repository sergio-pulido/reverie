import assert from "node:assert/strict";
import { test } from "node:test";
import { FalBudget } from "../apps/server/falBudget";
import { resolveSpendAccount, SpendAccount } from "../apps/server/spendLedger";
import { DirectorSessionLedger } from "../apps/server/directorSessions";

const LIMITS = {
  budgetUsd: 20,
  usdPerSecond: 0.08,
  maxConcurrentSessions: 4,
  maxSessionSeconds: 60,
};

test("the account refuses a commitment it cannot cover, and commits nothing", () => {
  const account = new SpendAccount(10);
  assert.equal(account.commit(6), true);
  assert.equal(account.commit(6), false);
  assert.equal(account.committedUsd, 6);
  assert.equal(account.remainingUsd, 4);
  assert.equal(account.affords(4), true);
  assert.equal(account.affords(4.01), false);
});

test("settling replaces a reservation and never charges past it", () => {
  const account = new SpendAccount(10);
  account.commit(5);
  account.settle(5, 2);
  assert.equal(account.committedUsd, 2);
  account.commit(5);
  account.settle(5, 9);
  assert.equal(account.committedUsd, 7, "the reservation was the worst case");
});

test("a refund gives back work that never reached the provider", () => {
  const account = new SpendAccount(10);
  account.commit(4);
  account.refund(4);
  assert.equal(account.committedUsd, 0);
  account.refund(4);
  assert.equal(account.committedUsd, 0, "a refund cannot push the account negative");
});

test("two features sharing one account share one ceiling", () => {
  // The whole reason the account exists: a director session and an escape
  // room segment must not each believe they own FAL_ASSET_BUDGET_USD.
  const account = new SpendAccount(20);
  // The ledger reserves through the budget's face on that same account, so the
  // two APIs are two ways of spending one ceiling, not two ceilings.
  const director = new DirectorSessionLedger(LIMITS, () => 1_000, new FalBudget(20, account));
  assert.notEqual(typeof director.open("jam:a"), "string");
  assert.equal(account.committedUsd, 60 * 0.08);
  assert.equal(account.commit(20 - 60 * 0.08), true, "the rest of the budget is still there");
  assert.equal(typeof director.open("jam:b"), "string", "and no more sessions fit");
});

test("a ledger given no account keeps its own, at its own limit", () => {
  const director = new DirectorSessionLedger({ ...LIMITS, budgetUsd: 4.8 }, () => 1_000);
  assert.notEqual(typeof director.open("jam:a"), "string");
  assert.equal(director.open("jam:b"), "budget_exhausted");
});

test("the account reads the ceiling the repository already documents", () => {
  assert.equal(resolveSpendAccount({ FAL_ASSET_BUDGET_USD: "20" } as NodeJS.ProcessEnv).budgetUsd, 20);
  assert.equal(resolveSpendAccount({} as NodeJS.ProcessEnv).budgetUsd, 0, "no budget means no spending");
  assert.equal(
    resolveSpendAccount({ FAL_ASSET_BUDGET_USD: "-5" } as NodeJS.ProcessEnv).budgetUsd,
    0,
  );
});
