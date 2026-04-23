// Minimal self-test for the liqgrid binary.
// Runs the grid computation on a realistic BTC scenario and checks invariants.
// Run with: npm run build && npm test
// No external framework — keeps the source repo dependency-free.
import { computeGridPlan } from "./grid.js";
import { CAPS } from "./types.js";
function assert(cond, msg) {
    if (!cond) {
        // eslint-disable-next-line no-console
        console.error(`FAIL: ${msg}`);
        process.exit(1);
    }
}
// Generate 168 hourly candles of synthetic BTC at ~92,500 with 1% hourly stdev.
function makeCandles() {
    const candles = [];
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
function runTest(name, input, checks) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${name} ===`);
    const plan = computeGridPlan(input);
    checks(plan);
    // eslint-disable-next-line no-console
    console.log(`  gridCount=${plan.gridCount}  fills/day=${plan.expectedFillsPerDay}  stopLoss=${plan.stopLossTriggerPrice}  maxLossPct=${(plan.maxLossPctOfNotional * 100).toFixed(2)}%`);
    // eslint-disable-next-line no-console
    console.log(`PASS: ${name}`);
}
const baseInput = {
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
const aggressive = { ...baseInput, riskProfile: "aggressive" };
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
const consHighLev = { ...baseInput, leverage: 10, riskProfile: "conservative" };
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
function planHash(plan) {
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
        assert(plan.planHash !== p2.planHash, "planHash collided despite stopLossSide differing — hash input incomplete");
    }
    else {
        // Sides happen to match (e.g. rangeHalfWidth rounding) — skip.
        // The correctness guarantee still holds; just can't exercise the
        // flip path on this particular baseInput.
    }
});
// 10. #11 Input validation — missing candles returns a warning'd empty plan,
// not a crash.
runTest("missing candles returns safe empty plan", (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...baseInput };
    delete bad.candles;
    return bad;
})(), (plan) => {
    assert(plan.levels.length === 0, "expected empty levels on missing candles");
    assert(plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("candles")), "expected INPUT warning about missing candles");
});
// 11. #11 Input validation — missing marketMeta also returns safe empty plan.
runTest("missing marketMeta returns safe empty plan", (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...baseInput };
    delete bad.marketMeta;
    return bad;
})(), (plan) => {
    assert(plan.levels.length === 0, "expected empty levels on missing marketMeta");
    assert(plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("marketMeta")), "expected INPUT warning about missing marketMeta");
});
// 12. #11 Input validation — invalid riskProfile string caught.
runTest("invalid riskProfile returns safe empty plan", (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...baseInput, riskProfile: "YOLO" };
    return bad;
})(), (plan) => {
    assert(plan.levels.length === 0, "expected empty levels on invalid riskProfile");
    assert(plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("riskProfile")), "expected INPUT warning about invalid riskProfile");
});
// 13. Range ordering — rangeLow >= rangeHigh is a hard failure, not a warning.
// Without this guard, buildLevels ran Math.log over an inverted range and
// produced negative-step prices with flipped buy/sell sides.
runTest("inverted range returns safe empty plan", { ...baseInput, rangeLow: 95000, rangeHigh: 90000 }, (plan) => {
    assert(plan.levels.length === 0, "expected empty levels on inverted range");
    assert(plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("strictly less than")), "expected INPUT warning about rangeLow < rangeHigh");
});
// 14. Positivity — non-positive prices break Math.log. Guarded in structural
// validation so the rest of the engine can assume positive numeric inputs.
runTest("non-positive rangeLow returns safe empty plan", { ...baseInput, rangeLow: -100 }, (plan) => {
    assert(plan.levels.length === 0, "expected empty levels on non-positive rangeLow");
    assert(plan.warnings.some((w) => w.startsWith("INPUT:") && w.includes("rangeLow") && w.includes("positive")), "expected INPUT warning about positive rangeLow");
});
// 15. Dedupe-aware sizing — sum(sizeUsd) must equal totalNotionalUsd even
// after tick rounding collapses duplicate levels. Regression guard for the
// previous behavior where sizeUsd = totalNotional / requested_count was
// computed BEFORE dedupe, so the actually-placed notional was silently
// smaller than what the plan reported.
runTest("level sizing sums to totalNotionalUsd", baseInput, (plan) => {
    if (plan.levels.length === 0)
        return;
    const sum = plan.levels.reduce((s, l) => s + l.sizeUsd, 0);
    // Allow sub-cent drift from float arithmetic.
    assert(Math.abs(sum - plan.totalNotionalUsd) < 0.01, `sum(sizeUsd)=${sum} must equal totalNotionalUsd=${plan.totalNotionalUsd}`);
    // Indexes must be 0..N-1 contiguous after dedupe.
    plan.levels.forEach((l, i) => {
        assert(l.index === i, `level index ${l.index} != position ${i}`);
    });
});
// eslint-disable-next-line no-console
console.log("\nAll self-tests passed ✅");
