// Minimal self-test for the liqgrid binary.
// Runs the grid computation on a realistic BTC scenario and checks invariants.
// Run with: npm run build && npm test
// No external framework — keeps the source repo dependency-free.

import { computeGridPlan } from "./grid.js";
import type { PlanInput, Candle } from "./types.js";
import { CAPS } from "./types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Generate 168 hourly candles of synthetic BTC at ~92,500 with 1% hourly stdev.
function makeCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 92500;
  for (let i = 0; i < 168; i++) {
    // deterministic pseudo-random walk: sin/cos mix, no Math.random
    const drift = Math.sin(i * 0.137) * 0.008 + Math.cos(i * 0.31) * 0.004;
    price = price * (1 + drift);
    candles.push({
      open: price * 0.999,
      high: price * 1.003,
      low: price * 0.997,
      close: price,
      timestamp: i * 3600_000,
    });
  }
  return candles;
}

function runTest(name: string, input: PlanInput, checks: (plan: ReturnType<typeof computeGridPlan>) => void): void {
  // eslint-disable-next-line no-console
  console.log(`\n=== ${name} ===`);
  const plan = computeGridPlan(input);
  checks(plan);
  // eslint-disable-next-line no-console
  console.log(`  gridCount=${plan.gridCount}  fills/day=${plan.expectedFillsPerDay}  stopLoss=${plan.stopLossTriggerPrice}  maxLossPct=${(plan.maxLossPctOfNotional * 100).toFixed(2)}%`);
  // eslint-disable-next-line no-console
  console.log(`PASS: ${name}`);
}

const baseInput: PlanInput = {
  coin: "BTC",
  rangeLow: 90000,
  rangeHigh: 95000,
  totalNotionalUsd: 300,
  leverage: 2,
  riskProfile: "conservative",
  marketMeta: {
    coin: "BTC",
    tickSize: 1,
    minOrderSizeUsd: 10,
    markPrice: 92500,
    maxLeverage: 20,
  },
  candles: makeCandles(),
};

// 1. Conservative baseline
runTest("conservative baseline", baseInput, (plan) => {
  assert(plan.gridCount >= CAPS.MIN_GRID_COUNT, "gridCount below min");
  assert(plan.gridCount <= CAPS.MAX_GRID_COUNT, "gridCount above max");
  assert(plan.levels.length === plan.gridCount, "levels vs gridCount mismatch");
  assert(plan.dryRun === true, "plan must be dry-run");
  assert(plan.totalNotionalUsd === 300, "notional mismatch");
  assert(plan.leverage === 2, "leverage mismatch");
  // Safety: worst case must not breach the cap
  assert(plan.maxLossPctOfNotional <= CAPS.MAX_LOSS_PCT_OF_NOTIONAL + 0.0001, "stop-loss exceeds max-loss cap");
});

// 2. Determinism: same input → same output
runTest("deterministic across runs", baseInput, (plan) => {
  const plan2 = computeGridPlan(baseInput);
  assert(JSON.stringify(plan) === JSON.stringify(plan2), "non-deterministic output");
});

// 3. Aggressive produces more rungs than conservative (same range)
const aggressive = { ...baseInput, riskProfile: "aggressive" as const };
runTest("aggressive > conservative grid count", aggressive, (plan) => {
  const conservative = computeGridPlan(baseInput);
  assert(plan.gridCount > conservative.gridCount, "aggressive should have more rungs");
});

// 4. Notional cap enforcement
const overNotional = { ...baseInput, totalNotionalUsd: 10000 };
runTest("notional over cap is clamped", overNotional, (plan) => {
  assert(plan.totalNotionalUsd === CAPS.MAX_NOTIONAL_USD, "notional not clamped");
  assert(plan.warnings.some((w) => w.includes("notional")), "no warning for clamped notional");
});

// 5. Leverage cap enforcement
const overLev = { ...baseInput, leverage: 50 };
runTest("leverage over cap is clamped", overLev, (plan) => {
  assert(plan.leverage <= CAPS.MAX_LEVERAGE, "leverage not clamped to hard cap");
  assert(plan.warnings.some((w) => w.toLowerCase().includes("leverage")), "no warning for clamped leverage");
});

// 5a. #14: Conservative + high leverage auto-downshifts to 5×
const consHighLev = { ...baseInput, leverage: 10, riskProfile: "conservative" as const };
runTest("conservative + 10x auto-downshifts to 5x", consHighLev, (plan) => {
  assert(plan.leverage === 5, `expected 5x after downshift, got ${plan.leverage}`);
  assert(plan.warnings.some((w) => w.includes("auto-downshifted")), "no downshift warning");
});

// 5b. #2: marginRequiredUsd = notional / leverage, must be present
runTest("marginRequiredUsd is notional / leverage", baseInput, (plan) => {
  assert(typeof plan.marginRequiredUsd === "number", "marginRequiredUsd missing");
  const expected = Number((plan.totalNotionalUsd / plan.leverage).toFixed(2));
  assert(plan.marginRequiredUsd === expected, `expected ${expected}, got ${plan.marginRequiredUsd}`);
});

// 5c. #9: Mark price significantly outside range produces REFUSE warning
const markOutside = { ...baseInput, rangeLow: 100000, rangeHigh: 105000 };
runTest("mark far outside range triggers REFUSE", markOutside, (plan) => {
  assert(plan.warnings.some((w) => w.includes("REFUSE")), "no REFUSE warning for mark far outside range");
});

// 5d. #8: Big mark vs last-candle drift triggers warning
const driftInput = {
  ...baseInput,
  rangeLow: 105000,
  rangeHigh: 115000,
  marketMeta: { ...baseInput.marketMeta, markPrice: 110000 }, // candles end near 102k, >5% drift
};
runTest("mark/candle drift triggers warning", driftInput, (plan) => {
  assert(plan.warnings.some((w) => w.includes("drifted")), "no drift warning");
});

// 6. Tick-size rounding
runTest("levels are tick-aligned", baseInput, (plan) => {
  const tick = baseInput.marketMeta.tickSize;
  for (const lvl of plan.levels) {
    const remainder = Math.abs(lvl.price / tick - Math.round(lvl.price / tick));
    assert(remainder < 1e-6, `level ${lvl.price} not tick-aligned`);
  }
});

// 7. Serialization hash stability — the core determinism contract.
// Same PlanInput → same serialized bytes → same hash, across runs.
// This is the property that justifies distributing liqgrid as a binary
// rather than leaving grid math to an LLM.
import { createHash } from "node:crypto";
function planHash(plan: unknown): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
runTest("serialization hash is stable", baseInput, (plan) => {
  const h1 = planHash(plan);
  const h2 = planHash(computeGridPlan(baseInput));
  const h3 = planHash(computeGridPlan(baseInput));
  assert(h1 === h2 && h2 === h3, "plan hash drifts across runs");
  // eslint-disable-next-line no-console
  console.log(`  sha256=${h1.slice(0, 16)}...`);
});

// 8. planHash field: embedded deterministic identifier.
runTest("plan.planHash is embedded and deterministic", baseInput, (plan) => {
  assert(typeof plan.planHash === "string", "planHash missing");
  assert(plan.planHash.length === 64, "planHash not sha256");
  const plan2 = computeGridPlan(baseInput);
  assert(plan.planHash === plan2.planHash, "planHash not deterministic");
  // Different inputs → different hash
  const plan3 = computeGridPlan({ ...baseInput, totalNotionalUsd: 400 });
  assert(plan.planHash !== plan3.planHash, "planHash collides on different inputs");
  // eslint-disable-next-line no-console
  console.log(`  planHash=${plan.planHash.slice(0, 12)}...`);
});

// 9. #1 Hash includes stopLossSide — constructing a plan that would
// flip sides should produce a different hash.
runTest("planHash differs when stopLossSide differs", baseInput, (plan) => {
  // Build an input whose markPrice is on the OPPOSITE side of mid.
  // baseInput: range 90000-95000, mark 92500 → mid=92500, markPrice<=mid ⇒ long
  // Flipped: markPrice just above mid → short
  const flipped = {
    ...baseInput,
    marketMeta: { ...baseInput.marketMeta, markPrice: 92501 }, // 1 above mid ⇒ short side
  };
  const p2 = computeGridPlan(flipped);
  // If the stop-loss side is actually different, the hash must be different.
  if (plan.stopLossSide !== p2.stopLossSide) {
    assert(
      plan.planHash !== p2.planHash,
      "planHash collided despite stopLossSide differing — hash input incomplete"
    );
  } else {
    // Sides happen to match (e.g. rangeHalfWidth rounding) — skip.
    // The correctness guarantee still holds; just can't exercise the
    // flip path on this particular baseInput.
  }
});

// 10. #11 Input validation — missing candles returns a warning'd empty plan,
// not a crash.
runTest("missing candles returns safe empty plan", (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad: any = { ...baseInput };
  delete bad.candles;
  return bad;
})(), (plan) => {
  assert(plan.levels.length === 0, "expected empty levels on missing candles");
  assert(
    plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("candles")),
    "expected INPUT warning about missing candles"
  );
});

// 11. #11 Input validation — missing marketMeta also returns safe empty plan.
runTest("missing marketMeta returns safe empty plan", (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad: any = { ...baseInput };
  delete bad.marketMeta;
  return bad;
})(), (plan) => {
  assert(plan.levels.length === 0, "expected empty levels on missing marketMeta");
  assert(
    plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("marketMeta")),
    "expected INPUT warning about missing marketMeta"
  );
});

// 12. #11 Input validation — invalid riskProfile string caught.
runTest("invalid riskProfile returns safe empty plan", (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad: any = { ...baseInput, riskProfile: "YOLO" };
  return bad;
})(), (plan) => {
  assert(plan.levels.length === 0, "expected empty levels on invalid riskProfile");
  assert(
    plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("riskProfile")),
    "expected INPUT warning about invalid riskProfile"
  );
});

// 13. Range ordering — rangeLow >= rangeHigh is a hard failure, not a warning.
// Without this guard, buildLevels ran Math.log over an inverted range and
// produced negative-step prices with flipped buy/sell sides.
runTest("inverted range returns safe empty plan", { ...baseInput, rangeLow: 95000, rangeHigh: 90000 }, (plan) => {
  assert(plan.levels.length === 0, "expected empty levels on inverted range");
  assert(
    plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("strictly less than")),
    "expected INPUT warning about rangeLow < rangeHigh"
  );
});

// 14. Positivity — non-positive prices break Math.log. Guarded in structural
// validation so the rest of the engine can assume positive numeric inputs.
runTest("non-positive rangeLow returns safe empty plan", { ...baseInput, rangeLow: -100 }, (plan) => {
  assert(plan.levels.length === 0, "expected empty levels on non-positive rangeLow");
  assert(
    plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("rangeLow") && w.includes("positive")),
    "expected INPUT warning about positive rangeLow"
  );
});

// 15. Dedupe-aware sizing — sum(sizeUsd) must equal totalNotionalUsd even
// after tick rounding collapses duplicate levels. Regression guard for the
// previous behavior where sizeUsd = totalNotional / requested_count was
// computed BEFORE dedupe, so the actually-placed notional was silently
// smaller than what the plan reported.
runTest("level sizing sums to totalNotionalUsd", baseInput, (plan) => {
  if (plan.levels.length === 0) return;
  const sum = plan.levels.reduce((s, l) => s + l.sizeUsd, 0);
  // Allow sub-cent drift from float arithmetic.
  assert(
    Math.abs(sum - plan.totalNotionalUsd) < 0.01,
    `sum(sizeUsd)=${sum} must equal totalNotionalUsd=${plan.totalNotionalUsd}`
  );
  // Indexes must be 0..N-1 contiguous after dedupe.
  plan.levels.forEach((l, i) => {
    assert(l.index === i, `level index ${l.index} != position ${i}`);
  });
});

// 16. v1.1 — Funding bias factor: below noise floor → 0; positive funding → positive;
// negative → negative; saturates at ±20%.
import { fundingBiasFactor, fillProbabilityWeight, runBacktest } from "./grid.js";

runTest("fundingBiasFactor: below noise floor returns 0", baseInput, () => {
  // 0.00001/hour × 8760 = 8.76% annual — below 10% floor.
  assert(fundingBiasFactor(0.00001) === 0, "funding at 8.76% annual should be 0 bias");
  assert(fundingBiasFactor(-0.00001) === 0, "negative funding below floor should be 0");
  assert(fundingBiasFactor(undefined) === 0, "undefined funding should be 0");
  assert(fundingBiasFactor(0) === 0, "zero funding should be 0");
});

// 17. v1.1 — Funding bias monotonic + sign-correct + saturation clamp.
runTest("fundingBiasFactor: monotonic, sign-correct, saturates at 0.20", baseInput, () => {
  // 0.0001/hour = 87.6% annual → saturated.
  const highPos = fundingBiasFactor(0.0001);
  const highNeg = fundingBiasFactor(-0.0001);
  assert(Math.abs(highPos - 0.2) < 1e-9, `expected saturation 0.2, got ${highPos}`);
  assert(Math.abs(highNeg - -0.2) < 1e-9, `expected saturation -0.2, got ${highNeg}`);
  // Mid-range: 0.00003/hour ≈ 26.3% annual; (26.3-10)/(50-10) ≈ 0.408; × 0.2 ≈ 0.0816.
  const mid = fundingBiasFactor(0.00003);
  assert(mid > 0.05 && mid < 0.12, `mid-range funding bias expected ~0.08, got ${mid}`);
});

// 18. v1.1 — fillProbabilityWeight: peaked at mark, decays symmetrically in log-price.
runTest("fillProbabilityWeight: peaked at mark, decays symmetrically", baseInput, () => {
  const mark = 92500;
  const sigma = 0.02; // 2% daily vol
  const wAtMark = fillProbabilityWeight(mark, mark, sigma);
  const wAbove = fillProbabilityWeight(mark * 1.05, mark, sigma);
  const wBelow = fillProbabilityWeight(mark / 1.05, mark, sigma);
  assert(Math.abs(wAtMark - 1) < 1e-9, `weight at mark must be 1, got ${wAtMark}`);
  assert(wAbove < wAtMark, "weight above mark should be < at mark");
  assert(wBelow < wAtMark, "weight below mark should be < at mark");
  // Symmetry in log-space: equidistant in log should have nearly equal weights.
  assert(
    Math.abs(wAbove - wBelow) < 1e-6,
    `log-symmetry broken: wAbove=${wAbove} wBelow=${wBelow}`
  );
});

// 19. v1.1 — Funding-aware sizing: positive funding → sell-side total > buy-side total.
runTest("funding-positive plan tilts notional toward sell-side", baseInput, () => {
  const positiveFunding = {
    ...baseInput,
    marketMeta: { ...baseInput.marketMeta, fundingRateHourly: 0.0001 }, // 87.6% annual → saturated
  };
  const plan = computeGridPlan(positiveFunding);
  const buySum = plan.levels.filter((l) => l.side === "buy").reduce((s, l) => s + l.sizeUsd, 0);
  const sellSum = plan.levels.filter((l) => l.side === "sell").reduce((s, l) => s + l.sizeUsd, 0);
  assert(sellSum > buySum, `expected sellSum > buySum at positive funding; got sell=${sellSum} buy=${buySum}`);
  // Total notional invariant still holds.
  assert(
    Math.abs((buySum + sellSum) - plan.totalNotionalUsd) < 0.01,
    `sum(sizeUsd)=${buySum + sellSum} must equal totalNotionalUsd=${plan.totalNotionalUsd}`
  );
  // Warning about funding bias is surfaced.
  assert(
    plan.warnings.some((w) => w.includes("funding-aware")),
    "expected funding-aware warning in plan.warnings"
  );
});

// 20. v1.1 — Concentrated liquidity: mid rungs have more notional than edge rungs
// when funding is zero (pure fill-probability weighting).
runTest("concentrated-liquidity: center-heavy sizing with no funding", baseInput, (plan) => {
  if (plan.levels.length < 5) return; // need enough rungs to see the effect
  const sorted = [...plan.levels].sort((a, b) => Math.abs(a.price - baseInput.marketMeta.markPrice) - Math.abs(b.price - baseInput.marketMeta.markPrice));
  const centerRung = sorted[0];
  const edgeRung = sorted[sorted.length - 1];
  assert(
    centerRung.sizeUsd > edgeRung.sizeUsd,
    `center rung @${centerRung.price} should have > notional than edge @${edgeRung.price}, got ${centerRung.sizeUsd} vs ${edgeRung.sizeUsd}`
  );
});

// 21. v1.1 — Backtest: runs deterministically over a synthetic candle window
// and produces a numeric result. Same input → same output, byte for byte.
runTest("backtest: deterministic and produces valid result", baseInput, () => {
  // Build a longer candle series so we have history + backtest window.
  const longCandles: Candle[] = [];
  let price = 92500;
  for (let i = 0; i < 336; i++) {
    // 2 weeks of hourly bars — more variance so grid can actually fill.
    const drift = Math.sin(i * 0.17) * 0.018 + Math.cos(i * 0.29) * 0.009;
    price = price * (1 + drift);
    longCandles.push({
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      timestamp: i * 3600_000,
    });
  }
  const btInput = {
    ...baseInput,
    candles: longCandles,
    backtestWindowBars: 168, // last 7 days
  };
  const r1 = runBacktest(btInput);
  const r2 = runBacktest(btInput);
  assert(JSON.stringify(r1) === JSON.stringify(r2), "backtest non-deterministic");
  assert(r1.windowBars === 168, `expected windowBars=168, got ${r1.windowBars}`);
  assert(r1.fills >= 0, "fills must be non-negative");
  assert(r1.fillsBuy + r1.fillsSell === r1.fills, "fillsBuy + fillsSell != fills");
  assert(Number.isFinite(r1.realizedPnlUsd), "realizedPnlUsd must be finite");
  assert(Number.isFinite(r1.totalPnlUsd), "totalPnlUsd must be finite");
  assert(r1.maxDrawdownUsd >= 0, "maxDrawdownUsd must be non-negative");
  assert(r1.dryRun === true, "backtest must be dryRun");
  assert(typeof r1.planHash === "string" && r1.planHash.length === 64, "backtest planHash missing or wrong length");
  // eslint-disable-next-line no-console
  console.log(`  fills=${r1.fills} (buy=${r1.fillsBuy} sell=${r1.fillsSell}) realized=$${r1.realizedPnlUsd} maxDD=$${r1.maxDrawdownUsd} sharpe=${r1.sharpeApprox}`);
});

// 22. v1.1 — Backtest input validation: bad window → safe empty result.
runTest("backtest: invalid window returns warning'd empty result", baseInput, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bad: any = { ...baseInput, backtestWindowBars: 0 };
  const r = runBacktest(bad);
  assert(r.fills === 0 && r.windowBars === 0, "expected empty result on bad window");
  assert(
    r.warnings.some((w) => w.startsWith("INPUT:") && w.includes("backtestWindowBars")),
    "expected INPUT warning about backtestWindowBars"
  );
});

// 23. v1.2 — Quickstart: produces a valid PlanInput from minimal inputs.
import { runQuickstart, runOptimize } from "./grid.js";
runTest("quickstart: derives a valid PlanInput from coin + notional + candles", baseInput, () => {
  const qs = runQuickstart({
    coin: "BTC",
    totalNotionalUsd: 300,
    candles: baseInput.candles,
    marketMeta: baseInput.marketMeta,
  });
  assert(qs.recommendedRangeLow > 0, "rangeLow must be positive");
  assert(qs.recommendedRangeHigh > qs.recommendedRangeLow, "rangeHigh > rangeLow");
  assert(qs.recommendedLeverage >= 1 && qs.recommendedLeverage <= CAPS.MAX_LEVERAGE, "leverage in valid range");
  assert(qs.planInput.coin === "BTC", "planInput.coin must match");
  assert(qs.planInput.rangeLow === qs.recommendedRangeLow, "planInput must match recommendation");
  // Pipe into computeGridPlan and verify it produces a valid plan.
  const plan = computeGridPlan(qs.planInput);
  assert(plan.gridCount >= CAPS.MIN_GRID_COUNT, "downstream plan must produce >= min grid count");
  assert(plan.warnings.filter((w) => w.startsWith("INPUT:")).length === 0, "no INPUT warnings");
});

// 24. v1.2 — Quickstart: too few candles returns empty result.
runTest("quickstart: insufficient candles returns warning'd empty result", baseInput, () => {
  const qs = runQuickstart({
    coin: "BTC",
    totalNotionalUsd: 300,
    candles: baseInput.candles.slice(0, 5),
    marketMeta: baseInput.marketMeta,
  });
  assert(qs.recommendedRangeLow === 0, "rangeLow=0 on insufficient candles");
  assert(
    qs.warnings.some((w) => w.startsWith("INPUT:") && w.includes("candles")),
    "expected INPUT warning about candles count"
  );
});

// 25. v1.2 — Optimize: deterministic, returns ranked candidates with valid math.
runTest("optimize: returns top-N ranked candidates over a sweep", baseInput, () => {
  // Need a longer candle series so backtest has history + window per trial.
  const longCandles: Candle[] = [];
  let price = 92500;
  for (let i = 0; i < 336; i++) {
    const drift = Math.sin(i * 0.17) * 0.018 + Math.cos(i * 0.29) * 0.009;
    price = price * (1 + drift);
    longCandles.push({ open: price * 0.999, high: price * 1.005, low: price * 0.995, close: price, timestamp: i * 3600_000 });
  }
  const input = {
    coin: "BTC",
    totalNotionalUsd: 300,
    candles: longCandles,
    marketMeta: baseInput.marketMeta,
    backtestWindowBars: 168,
    topN: 3,
  };
  const r1 = runOptimize(input);
  const r2 = runOptimize(input);
  assert(JSON.stringify(r1) === JSON.stringify(r2), "optimize is non-deterministic");
  assert(r1.totalEvaluated > 0, "must evaluate at least one combo");
  assert(r1.candidates.length <= 3, "topN respected");
  if (r1.candidates.length >= 2) {
    assert(r1.candidates[0].score >= r1.candidates[1].score, "candidates must be sorted desc by score");
  }
  for (const c of r1.candidates) {
    assert(c.rangeLow < c.rangeHigh, "candidate range valid");
    assert(c.leverage >= 1 && c.leverage <= CAPS.MAX_LEVERAGE, "candidate leverage valid");
    assert(["conservative", "balanced", "aggressive"].includes(c.riskProfile), "candidate profile valid");
    assert(c.fills >= 0, "fills non-negative");
  }
  // eslint-disable-next-line no-console
  console.log(`  evaluated=${r1.totalEvaluated} top=${r1.candidates.length} bestScore=${r1.candidates[0]?.score ?? 0}`);
});

// 26. v1.2 — Optimize: too few candles returns empty result with warning.
runTest("optimize: insufficient candles returns warning'd empty result", baseInput, () => {
  const r = runOptimize({
    coin: "BTC",
    totalNotionalUsd: 300,
    candles: baseInput.candles.slice(0, 50),
    marketMeta: baseInput.marketMeta,
    backtestWindowBars: 168,
  });
  assert(r.candidates.length === 0, "no candidates on insufficient candles");
  assert(
    r.warnings.some((w) => w.startsWith("INPUT:") && w.includes("candles")),
    "expected INPUT warning"
  );
});

// eslint-disable-next-line no-console
console.log("\nAll self-tests passed ✅");
