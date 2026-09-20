import assert from "node:assert/strict";
import test from "node:test";
import {
  billedSeconds,
  budgetSpent,
  canAfford,
  formatUsd,
  sessionSpendUsd,
  unopenedSpend,
  type DirectorRates,
} from "../src/core/directorSpend";

/** fal's list price, and the $20 budget the project ships with. */
const RATES: DirectorRates = { budgetUsd: 20, usdPerSecond: 0.08, minBilledSeconds: 60 };

test("nothing is spent until a session is opened", () => {
  const spend = unopenedSpend(RATES);
  assert.equal(spend.sessionUsd, 0);
  assert.equal(spend.remainingUsd, 20);
  assert.equal(formatUsd(spend.sessionUsd), "$0.00");
});

test("an open session bills the provider's minimum even before it generates anything", () => {
  assert.equal(billedSeconds(0, 60), 60);
  assert.equal(billedSeconds(4.2, 60), 60);
  assert.equal(sessionSpendUsd(0, RATES).toFixed(2), "4.80");
});

test("past the minimum the figure follows the seconds actually generated", () => {
  assert.equal(billedSeconds(61.2, 60), 62, "whole seconds, rounded the provider's way");
  assert.equal(sessionSpendUsd(90, RATES).toFixed(2), "7.20");
  assert.equal(sessionSpendUsd(120, RATES).toFixed(2), "9.60");
});

test("negative or nonsensical seconds never reduce the bill below the minimum", () => {
  assert.equal(billedSeconds(-5, 60), 60);
  assert.equal(sessionSpendUsd(Number.NaN, RATES).toFixed(2), "4.80");
});

test("a beat is affordable only while the budget left covers its seconds", () => {
  const spend = { ...RATES, sessionUsd: 0, remainingUsd: 0.8 };
  assert.equal(canAfford(spend, 10), true, "10s at $0.08 is exactly $0.80");
  assert.equal(canAfford(spend, 11), false);
  assert.equal(budgetSpent(spend), false);
});

test("an exhausted budget affords nothing", () => {
  const spend = { ...RATES, sessionUsd: 20, remainingUsd: 0 };
  assert.equal(budgetSpent(spend), true);
  assert.equal(canAfford(spend, 5), false);
});

test("an unconfigured budget is zero, and says so rather than looking unlimited", () => {
  const spend = unopenedSpend({ ...RATES, budgetUsd: 0 });
  assert.equal(spend.remainingUsd, 0);
  assert.equal(budgetSpent(spend), true);
  assert.equal(canAfford(spend, 1), false);
});

test("money is shown in US dollars with two decimals, never re-labelled", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(4.8), "$4.80");
  assert.equal(formatUsd(12.345), "$12.35");
  assert.equal(formatUsd(-1), "$0.00", "a negative remainder reads as nothing left");
  assert.equal(formatUsd(Number.NaN), "$0.00");
});

test("what is already committed elsewhere comes off the budget before a session opens", () => {
  const spend = unopenedSpend(RATES, 9.6);
  assert.equal(spend.remainingUsd.toFixed(2), "10.40");
});
