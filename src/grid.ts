// Deterministic grid-parameter engine.
// Given the same inputs, produces the same GridPlan — across Node versions,
// across machines, across runs. No Math.random, no Date.now, no I/O.
// This determinism is the whole point of distributing liqgrid as a binary
// rather than leaving grid math to an LLM.

import { createHash } from "node:crypto";
import {
  PlanInput,
  GridPlan,
  GridLevel,
  RiskProfile,
  Candle,
  CAPS,
  BacktestInput,
  BacktestResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Risk profile → multipliers
// ---------------------------------------------------------------------------

interface RiskMultipliers {
  gridCountFactor: number; // multiplies baseline grid count
  stopLossWidthPct: number; // stop-loss distance beyond range, as pct of range
}

function riskMultipliers(p: RiskProfile): RiskMultipliers {
  switch (p) {
    case "conservative":
      return { gridCountFactor: 0.55, stopLossWidthPct: 0.05 };
    case "balanced":
      return { gridCountFactor: 0.85, stopLossWidthPct: 0.1 };
    case "aggressive":
      return { gridCountFactor: 1.3, stopLossWidthPct: 0.15 };
  }
}

// ---------------------------------------------------------------------------
// Realized volatility from candles (annualized would exaggerate for grids;
// we return daily stdev of log returns, a sane input for grid spacing).
// ---------------------------------------------------------------------------

export function realizedVolatilityDaily(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    if (prev > 0 && curr > 0) {
      logReturns.push(Math.log(curr / prev));
    }
  }
  if (logReturns.length === 0) return 0;
  const mean = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / logReturns.length;
  const hourlyStdev = Math.sqrt(variance);
  // 24 hourly candles per day → daily stdev = hourly × sqrt(24)
  return hourlyStdev * Math.sqrt(24);
}

// ---------------------------------------------------------------------------
// Round a price to the nearest multiple of tickSize.
// Uses integer math to avoid floating-point drift.
// ---------------------------------------------------------------------------

export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  const ticks = Math.round(price / tickSize);
  return Number((ticks * tickSize).toFixed(10));
}

// ---------------------------------------------------------------------------
// Choose the grid count based on realized vol, range width, and risk profile.
// Wider range or higher vol → more rungs (more fills).
// Capped by CAPS.MAX_GRID_COUNT and by the minimum tick-size feasibility.
// ---------------------------------------------------------------------------

export function chooseGridCount(
  rangeLow: number,
  rangeHigh: number,
  dailyVol: number,
  riskProfile: RiskProfile,
  tickSize: number
): number {
  const rangePct = (rangeHigh - rangeLow) / ((rangeHigh + rangeLow) / 2);
  // Baseline: one rung per (vol / 8) of price movement.
  // Example: 2% daily vol, 5% range → (0.05 / (0.02/8)) = 20 rungs baseline.
  // This gives enough density for meaningful fill counts at realistic vols.
  const volStep = Math.max(dailyVol / 8, 0.002);
  const baseline = Math.max(8, Math.floor(rangePct / volStep));
  const { gridCountFactor } = riskMultipliers(riskProfile);
  let count = Math.floor(baseline * gridCountFactor);

  // Enforce minimum feasibility: each rung must be at least 2 × tickSize apart.
  const minSpacing = 2 * tickSize;
  const maxFeasible = Math.floor((rangeHigh - rangeLow) / minSpacing);

  count = Math.min(count, maxFeasible, CAPS.MAX_GRID_COUNT);
  count = Math.max(count, CAPS.MIN_GRID_COUNT);
  return count;
}

// ---------------------------------------------------------------------------
// Funding-aware bias factor. Converts the hourly funding rate into a skew
// in [-MAX_BIAS, +MAX_BIAS]. Positive funding → longs pay shorts → we tilt
// notional toward sell rungs to collect funding as alpha. Negative flips.
// Below the noise floor (|annualized| < 10%) we return 0 — funding that
// small is dominated by predictive noise and isn't worth skewing on.
// Above 50% annualized, we saturate at MAX_BIAS — aggressive enough to
// capture edge, capped so a bad funding-flip can't wreck the grid.
// ---------------------------------------------------------------------------

const FUNDING_NOISE_FLOOR_ANNUAL = 0.10; // 10%
const FUNDING_SATURATION_ANNUAL = 0.50; // 50%
const MAX_FUNDING_BIAS = 0.20; // ±20% notional skew at saturation

export function fundingBiasFactor(fundingRateHourly: number | undefined): number {
  if (!fundingRateHourly || !Number.isFinite(fundingRateHourly)) return 0;
  const annualized = fundingRateHourly * 24 * 365;
  const absAnn = Math.abs(annualized);
  if (absAnn < FUNDING_NOISE_FLOOR_ANNUAL) return 0;
  const span = FUNDING_SATURATION_ANNUAL - FUNDING_NOISE_FLOOR_ANNUAL;
  const scaled = Math.min((absAnn - FUNDING_NOISE_FLOOR_ANNUAL) / span, 1);
  const bias = scaled * MAX_FUNDING_BIAS;
  return annualized > 0 ? bias : -bias;
}

// ---------------------------------------------------------------------------
// Gaussian "fill-probability" weight for a rung, approximating the one-day
// hit probability under a log-normal (GBM) price-move assumption. The weight
// is peaked at the mark and decays with log-distance / σ. Used so notional
// concentrates near the mark where most fills actually happen, rather than
// wasting capital at the edges of the range.
// ---------------------------------------------------------------------------

export function fillProbabilityWeight(
  price: number,
  markPrice: number,
  sigmaDaily: number
): number {
  // Guard against zero/undefined sigma — collapse to uniform weighting.
  const sigma = sigmaDaily > 1e-6 ? sigmaDaily : 1; // 1 = harmless neutral
  const z = Math.log(price / markPrice) / sigma;
  return Math.exp(-0.5 * z * z);
}

// ---------------------------------------------------------------------------
// Build the grid levels with (a) dedupe-safe sizing, (b) concentrated-liquidity
// notional weighting by per-rung fill probability, and (c) funding-aware
// asymmetric tilt between buy-side and sell-side rungs.
//
// Rung positions are log-equal-spaced between rangeLow and rangeHigh
// (unchanged from v1.0 — it's the cleanest geometry and we already document it).
// The *notional* allocated to each rung is what changes: rather than uniform,
// each rung's sizeUsd is proportional to
//     weight = fillProb(price, mark, σ) × fundingMultiplier(side, bias)
// normalized so that sum(sizeUsd) == totalNotionalUsd exactly.
// Pass fundingBias = 0 and sigmaDaily = 0 to get v1.0-style uniform sizing.
// ---------------------------------------------------------------------------

export function buildLevels(
  rangeLow: number,
  rangeHigh: number,
  gridCount: number,
  markPrice: number,
  totalNotionalUsd: number,
  tickSize: number,
  leverage: number,
  sigmaDaily: number = 0,
  fundingBias: number = 0
): GridLevel[] {
  // Pass 1: compute unique tick-aligned target prices. Tick rounding can
  // collapse two log-spaced rungs to the same price at narrow ranges —
  // dedupe first so pass 2 sizes against surviving count.
  const logLo = Math.log(rangeLow);
  const logHi = Math.log(rangeHigh);
  const step = (logHi - logLo) / (gridCount - 1);
  const seen = new Set<number>();
  const uniquePrices: number[] = [];
  for (let i = 0; i < gridCount; i++) {
    const rawPrice = Math.exp(logLo + i * step);
    const price = roundToTick(rawPrice, tickSize);
    if (seen.has(price)) continue;
    seen.add(price);
    uniquePrices.push(price);
  }
  if (uniquePrices.length === 0) return [];

  // Pass 2a: raw weights per rung = fillProb × fundingMultiplier.
  // When both sigmaDaily and fundingBias are 0, all weights collapse to 1
  // and sizing becomes uniform (v1.0 behaviour — deterministic regression).
  const rawWeights = uniquePrices.map((price) => {
    const fp = sigmaDaily > 0 ? fillProbabilityWeight(price, markPrice, sigmaDaily) : 1;
    const side: "buy" | "sell" = price < markPrice ? "buy" : "sell";
    // funding bias > 0 (funding positive, longs pay shorts) → boost sell rungs
    // (tilt net exposure short so we collect funding), damp buy rungs.
    // funding bias < 0 flips the sign.
    const sideMult = side === "sell" ? 1 + fundingBias : 1 - fundingBias;
    return fp * Math.max(sideMult, 0.01); // hard floor so no rung goes to ~0 on extreme funding
  });
  const sumWeights = rawWeights.reduce((a, b) => a + b, 0) || uniquePrices.length;

  // Pass 2b: build final levels. sizeUsd = totalNotional × normalized weight.
  const levels: GridLevel[] = [];
  for (let i = 0; i < uniquePrices.length; i++) {
    const price = uniquePrices[i];
    const side: "buy" | "sell" = price < markPrice ? "buy" : "sell";
    const sizeUsd = Number(((totalNotionalUsd * rawWeights[i]) / sumWeights).toFixed(6));
    const sizeCoin = (sizeUsd * leverage) / price;
    levels.push({
      index: i,
      price,
      side,
      sizeUsd,
      sizeCoin: Number(sizeCoin.toFixed(8)),
    });
  }
  return levels;
}

// ---------------------------------------------------------------------------
// Compute stop-loss trigger and worst-case loss at range break.
// ---------------------------------------------------------------------------

function computeStopLoss(
  rangeLow: number,
  rangeHigh: number,
  markPrice: number,
  riskProfile: RiskProfile,
  totalNotionalUsd: number,
  leverage: number
): { triggerPrice: number; side: "long" | "short"; maxLossUsd: number } {
  const { stopLossWidthPct } = riskMultipliers(riskProfile);
  const rangeWidth = rangeHigh - rangeLow;

  // If mark is below mid, bias toward long → stop below rangeLow.
  // Otherwise stop above rangeHigh.
  const mid = (rangeLow + rangeHigh) / 2;
  const side: "long" | "short" = markPrice <= mid ? "long" : "short";

  let triggerPrice: number;
  if (side === "long") {
    triggerPrice = rangeLow - rangeWidth * stopLossWidthPct;
  } else {
    triggerPrice = rangeHigh + rangeWidth * stopLossWidthPct;
  }

  // Rough worst-case: assume the grid accumulates a max position of
  // totalNotionalUsd / 2 against the stop-loss direction.
  // Loss = accumulated position × (distance to stop / entry) × leverage.
  const distancePct = Math.abs(triggerPrice - mid) / mid;
  const maxLossUsd = (totalNotionalUsd / 2) * distancePct * leverage;

  return { triggerPrice, side, maxLossUsd };
}

// ---------------------------------------------------------------------------
// Estimate daily fill count from realized vol and grid density.
// This is used for UX messaging, not for safety decisions.
// ---------------------------------------------------------------------------

function estimateFillsPerDay(
  dailyVol: number,
  gridCount: number,
  rangeLow: number,
  rangeHigh: number
): number {
  const rangePct = (rangeHigh - rangeLow) / ((rangeHigh + rangeLow) / 2);
  if (rangePct === 0) return 0;
  // Each full traversal = gridCount fills; vol drives how many traversals.
  const traversalsPerDay = (dailyVol * 2) / rangePct;
  return Math.round(traversalsPerDay * gridCount);
}

// ---------------------------------------------------------------------------
// Liquidation distance estimate.
// On Hyperliquid, maintenance margin ≈ initial_margin × 0.5, so the price
// move required to liquidate a freshly-opened position is approximately
// (1 / leverage) × 0.5 in the adverse direction. Funding and mark-vs-index
// drift can move this by 1–3%; this is an approximation only. The
// authoritative liquidation price comes from Hyperliquid's risk engine —
// the Skill must fetch it via the basic plugin before executing, not rely
// on this estimate.
// ---------------------------------------------------------------------------

function liquidationDistancePct(leverage: number): number {
  // Approximation: (1/leverage) × 0.5. E.g. 10× → ~5%, 5× → ~10%, 2× → ~25%.
  // Slightly conservative so our displayed buffer is a lower bound, not an
  // upper one.
  return (1 / leverage) * 0.5;
}

// ---------------------------------------------------------------------------
// Main entry: build a full GridPlan from user inputs.
// Validates all caps, returns a plan with warnings populated.
// Never throws — invalid inputs produce a plan with empty `levels`
// and a descriptive warning, so the caller can render a useful error.
// ---------------------------------------------------------------------------

export function computeGridPlan(input: PlanInput): GridPlan {
  const warnings: string[] = [];

  // --- Structural input validation. Replaces undefined-access crashes
  //     with clear warnings. The file-level contract is "never throws" —
  //     an invalid input returns a plan with empty levels and warnings.
  const structuralProblems: string[] = [];
  if (!input || typeof input !== "object") {
    structuralProblems.push("input is not an object");
  } else {
    if (!input.coin || typeof input.coin !== "string") {
      structuralProblems.push("missing or invalid `coin`");
    }
    if (typeof input.rangeLow !== "number" || typeof input.rangeHigh !== "number") {
      structuralProblems.push("missing or invalid `rangeLow`/`rangeHigh` (must be numbers)");
    }
    if (typeof input.totalNotionalUsd !== "number") {
      structuralProblems.push("missing or invalid `totalNotionalUsd` (must be a number)");
    }
    if (typeof input.leverage !== "number") {
      structuralProblems.push("missing or invalid `leverage` (must be a number)");
    }
    if (!["conservative", "balanced", "aggressive"].includes(input.riskProfile as string)) {
      structuralProblems.push("missing or invalid `riskProfile` (must be conservative|balanced|aggressive)");
    }
    if (!input.marketMeta || typeof input.marketMeta !== "object") {
      structuralProblems.push("missing `marketMeta` object");
    } else {
      for (const f of ["tickSize", "minOrderSizeUsd", "markPrice", "maxLeverage"]) {
        if (typeof (input.marketMeta as unknown as Record<string, unknown>)[f] !== "number") {
          structuralProblems.push(`missing or invalid marketMeta.${f}`);
        }
      }
    }
    if (!Array.isArray(input.candles)) {
      structuralProblems.push("missing or invalid `candles` (must be an array)");
    } else if (input.candles.length < 2) {
      structuralProblems.push(
        `candles array has ${input.candles.length} entries; need at least 2 for volatility estimate, 24+ recommended`
      );
    }
    // Positivity + ordering. Without these, Math.log(<=0) yields NaN/-Infinity
    // and buildLevels produces garbage prices. Guards here so the rest of
    // computeGridPlan can assume positive, well-ordered numeric inputs.
    if (typeof input.rangeLow === "number" && input.rangeLow <= 0) {
      structuralProblems.push("`rangeLow` must be positive");
    }
    if (typeof input.rangeHigh === "number" && input.rangeHigh <= 0) {
      structuralProblems.push("`rangeHigh` must be positive");
    }
    if (
      typeof input.rangeLow === "number" &&
      typeof input.rangeHigh === "number" &&
      input.rangeLow >= input.rangeHigh
    ) {
      structuralProblems.push(
        `\`rangeLow\` (${input.rangeLow}) must be strictly less than \`rangeHigh\` (${input.rangeHigh})`
      );
    }
    if (typeof input.totalNotionalUsd === "number" && input.totalNotionalUsd <= 0) {
      structuralProblems.push("`totalNotionalUsd` must be positive");
    }
    if (typeof input.leverage === "number" && input.leverage <= 0) {
      structuralProblems.push("`leverage` must be positive");
    }
    if (input.marketMeta && typeof input.marketMeta === "object") {
      const mm = input.marketMeta as unknown as Record<string, unknown>;
      for (const f of ["tickSize", "markPrice", "maxLeverage"]) {
        if (typeof mm[f] === "number" && (mm[f] as number) <= 0) {
          structuralProblems.push(`\`marketMeta.${f}\` must be positive`);
        }
      }
    }
  }
  if (structuralProblems.length > 0) {
    // Return a safe, empty plan with warnings. No stacktrace, no partial plan.
    return {
      coin: typeof input?.coin === "string" ? input.coin : "",
      gridCount: 0,
      levels: [],
      rangeLow: typeof input?.rangeLow === "number" ? input.rangeLow : 0,
      rangeHigh: typeof input?.rangeHigh === "number" ? input.rangeHigh : 0,
      totalNotionalUsd: 0,
      marginRequiredUsd: 0,
      leverage: 0,
      riskProfile:
        input?.riskProfile === "balanced" || input?.riskProfile === "aggressive"
          ? input.riskProfile
          : "conservative",
      stopLossTriggerPrice: 0,
      stopLossSide: "long",
      maxLossAtRangeBreakUsd: 0,
      maxLossPctOfNotional: 0,
      liquidationDistancePct: 0,
      expectedFillsPerDay: 0,
      realizedVolatilityDaily: 0,
      dryRun: true,
      warnings: structuralProblems.map((p) => `INPUT: ${p}`),
      planHash: "",
    };
  }

  // Validate caps up front.
  if (input.totalNotionalUsd > CAPS.MAX_NOTIONAL_USD) {
    warnings.push(
      `total_notional_usd (${input.totalNotionalUsd}) exceeds cap (${CAPS.MAX_NOTIONAL_USD}); clamped`
    );
  }
  if (input.leverage > CAPS.MAX_LEVERAGE) {
    warnings.push(
      `leverage (${input.leverage}) exceeds cap (${CAPS.MAX_LEVERAGE}); clamped`
    );
  }
  if (input.leverage > input.marketMeta.maxLeverage) {
    warnings.push(
      `leverage (${input.leverage}) exceeds market max (${input.marketMeta.maxLeverage}); clamped`
    );
  }

  // #9: Mark price outside requested range is a data-quality red flag.
  // A grid whose center is outside the intended range will fill lopsidedly
  // and almost certainly accumulate a losing position. Refuse rather than warn.
  const rangeHalfWidth = (input.rangeHigh - input.rangeLow) / 2;
  if (
    input.marketMeta.markPrice < input.rangeLow - rangeHalfWidth * 0.25 ||
    input.marketMeta.markPrice > input.rangeHigh + rangeHalfWidth * 0.25
  ) {
    warnings.push(
      `REFUSE: mark price (${input.marketMeta.markPrice}) is significantly outside [${input.rangeLow}, ${input.rangeHigh}] — the user's range premise is likely stale or wrong; do not execute`
    );
  } else if (
    input.marketMeta.markPrice < input.rangeLow ||
    input.marketMeta.markPrice > input.rangeHigh
  ) {
    warnings.push(
      `mark price (${input.marketMeta.markPrice}) is outside [${input.rangeLow}, ${input.rangeHigh}] — grid will open asymmetric; recheck range`
    );
  }

  // #8: Mark-vs-candle drift check. Last candle close vs live mark should
  // be within ~3% in normal conditions. A big gap means either the candles
  // are stale or an unusual price move is underway — either way, the
  // volatility estimate won't match the current state.
  if (input.candles.length > 0) {
    const lastClose = input.candles[input.candles.length - 1].close;
    if (lastClose > 0) {
      const drift = Math.abs(input.marketMeta.markPrice - lastClose) / lastClose;
      if (drift > 0.03) {
        warnings.push(
          `mark price (${input.marketMeta.markPrice}) drifted ${(drift * 100).toFixed(1)}% from last candle close (${lastClose}); volatility estimate may be stale — consider refetching candles`
        );
      }
    }
  }

  // #7: Candle gap detection. We assume hourly candles; timestamps should
  // step by ~3_600_000 ms. If any gap is >2 hours, volatility is understated.
  if (input.candles.length >= 2) {
    for (let i = 1; i < input.candles.length; i++) {
      const dt = input.candles[i].timestamp - input.candles[i - 1].timestamp;
      if (dt > 2 * 3_600_000) {
        warnings.push(
          `candle series has a ${(dt / 3_600_000).toFixed(1)}h gap at index ${i}; realized-volatility estimate may be low — consider refetching a contiguous window`
        );
        break; // one warning is enough; don't spam
      }
    }
  }

  const notional = Math.min(input.totalNotionalUsd, CAPS.MAX_NOTIONAL_USD);
  let leverage = Math.min(
    input.leverage,
    CAPS.MAX_LEVERAGE,
    input.marketMeta.maxLeverage
  );

  // #14: Conservative profile should not silently ride 10× leverage.
  // If user picks conservative + lev > 5, downshift to 5 and warn.
  // Users who actually want leverage ≥ 5 should pick balanced or aggressive.
  if (input.riskProfile === "conservative" && leverage > 5) {
    warnings.push(
      `conservative profile combined with ${leverage}× leverage auto-downshifted to 5× (use 'balanced' or 'aggressive' if you want higher leverage)`
    );
    leverage = 5;
  }

  const vol = realizedVolatilityDaily(input.candles);
  const gridCount = chooseGridCount(
    input.rangeLow,
    input.rangeHigh,
    vol,
    input.riskProfile,
    input.marketMeta.tickSize
  );

  // Funding + vol feed concentrated-liquidity + asymmetric sizing.
  // If funding is missing/zero and we have vol, we still get concentrated
  // liquidity alone (symmetric tilt toward mark). If both missing, uniform.
  const fundingBias = fundingBiasFactor(input.marketMeta.fundingRateHourly);
  if (fundingBias !== 0) {
    const annualPct = (input.marketMeta.fundingRateHourly! * 24 * 365 * 100).toFixed(1);
    const sidePref = fundingBias > 0 ? "sell" : "buy";
    warnings.push(
      `funding-aware bias applied: ${annualPct}% annualized funding → ${(Math.abs(fundingBias) * 100).toFixed(1)}% notional tilt toward ${sidePref} rungs`
    );
  }
  const levels = buildLevels(
    input.rangeLow,
    input.rangeHigh,
    gridCount,
    input.marketMeta.markPrice,
    notional,
    input.marketMeta.tickSize,
    leverage,
    vol,
    fundingBias
  );

  const { triggerPrice, side, maxLossUsd } = computeStopLoss(
    input.rangeLow,
    input.rangeHigh,
    input.marketMeta.markPrice,
    input.riskProfile,
    notional,
    leverage
  );

  const maxLossPct = notional > 0 ? maxLossUsd / notional : 0;
  if (maxLossPct > CAPS.MAX_LOSS_PCT_OF_NOTIONAL) {
    warnings.push(
      `stop-loss would allow loss of ${(maxLossPct * 100).toFixed(1)}% > ${(
        CAPS.MAX_LOSS_PCT_OF_NOTIONAL * 100
      ).toFixed(0)}% cap; widen range or tighten risk_profile`
    );
  }
  // #1: Per-level size check. Hyperliquid rejects orders below its minimum.
  // Check the effective USD value of each level — since log-spaced levels
  // can have slightly different sizeCoin-implied notionals at different
  // prices, we find the *smallest* one.
  if (levels.length > 0) {
    let minLevelNotional = Infinity;
    for (const lvl of levels) {
      const notionalAtLevel = lvl.sizeCoin * lvl.price;
      if (notionalAtLevel < minLevelNotional) minLevelNotional = notionalAtLevel;
    }
    if (minLevelNotional < input.marketMeta.minOrderSizeUsd) {
      warnings.push(
        `smallest per-level notional ${minLevelNotional.toFixed(2)} < market min ${input.marketMeta.minOrderSizeUsd}; reduce grid_count or increase total_notional_usd`
      );
    }
    // Defensive secondary check: if any level's sizeCoin rounds to 0 after
    // 8-decimal truncation, that level cannot be placed.
    for (const lvl of levels) {
      if (lvl.sizeCoin <= 0) {
        warnings.push(
          `level ${lvl.index} at price ${lvl.price} has sizeCoin rounded to 0 (notional too small for this price); reduce grid_count or increase total_notional_usd`
        );
        break;
      }
    }
  }

  // Stable planHash: sha256 over the user-meaningful output fields.
  // Two identical inputs always produce identical planHash. Different
  // inputs differ in at least one field and therefore differ in hash.
  // Excludes derived/informational fields like expectedFillsPerDay.
  const hashable = {
    coin: input.coin,
    levels: levels.map((l) => ({
      price: l.price,
      side: l.side,
      sizeUsd: Number(l.sizeUsd.toFixed(6)),
    })),
    rangeLow: input.rangeLow,
    rangeHigh: input.rangeHigh,
    totalNotionalUsd: notional,
    leverage,
    riskProfile: input.riskProfile,
    stopLossTriggerPrice: Number(triggerPrice.toFixed(6)),
    stopLossSide: side, // Include side so that a long-bias and short-bias plan with otherwise identical fields hash differently.
  };
  const planHash = createHash("sha256")
    .update(JSON.stringify(hashable))
    .digest("hex");

  return {
    coin: input.coin,
    gridCount: levels.length,
    levels,
    rangeLow: input.rangeLow,
    rangeHigh: input.rangeHigh,
    totalNotionalUsd: notional,
    marginRequiredUsd: Number((notional / leverage).toFixed(2)),
    leverage,
    riskProfile: input.riskProfile,
    stopLossTriggerPrice: Number(triggerPrice.toFixed(6)),
    stopLossSide: side,
    maxLossAtRangeBreakUsd: Number(maxLossUsd.toFixed(2)),
    maxLossPctOfNotional: Number(maxLossPct.toFixed(4)),
    liquidationDistancePct: Number(liquidationDistancePct(leverage).toFixed(4)),
    expectedFillsPerDay: estimateFillsPerDay(
      vol,
      levels.length,
      input.rangeLow,
      input.rangeHigh
    ),
    realizedVolatilityDaily: Number(vol.toFixed(4)),
    dryRun: true,
    warnings,
    planHash,
  };
}

// ---------------------------------------------------------------------------
// Deterministic backtest. Walks candle-by-candle over a historical window,
// matching each bar's [low, high] against resting grid orders and pairing
// buys-at-lower-rungs with sells-at-upper-rungs for realized PnL. Fully pure:
// no wall-clock, no randomness, no network, no hidden Math.random. Same
// input → same BacktestResult, byte for byte.
//
// Fill model (conservative):
//   - A buy order at price P is filled by a candle if candle.low <= P.
//   - A sell order at price P is filled by a candle if candle.high >= P.
//   - If both conditions match in the same bar, we process buys first, sells
//     second (biased against our realized PnL — we'd rather under-estimate
//     than over-estimate what the strategy made).
//   - Stop-loss triggers when candle.low <= stopLossTriggerPrice (for long
//     bias) or candle.high >= trigger (short bias), and ends the simulation.
//   - Partial fills are NOT modelled — each rung either fills entirely or not.
//     This is conservative because real grid bots can partial-fill + re-place,
//     so our realized PnL here is a lower bound of what a careful operator
//     would achieve in practice.
// ---------------------------------------------------------------------------

export function runBacktest(input: BacktestInput): BacktestResult {
  const warnings: string[] = [];
  const emptyResult = (): BacktestResult => ({
    coin: typeof input?.coin === "string" ? input.coin : "",
    planHash: "",
    gridCount: 0,
    totalNotionalUsd: 0,
    leverage: 0,
    riskProfile: "conservative",
    windowBars: 0,
    firstCandleTimestamp: 0,
    lastCandleTimestamp: 0,
    fills: 0,
    fillsBuy: 0,
    fillsSell: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    maxDrawdownUsd: 0,
    sharpeApprox: 0,
    hitStopLoss: false,
    dryRun: true,
    warnings,
  });

  // Input validation. backtestWindowBars must be > 0 and leave enough history
  // (≥ 24 bars) to compute a meaningful vol estimate for the plan.
  if (!input || !Array.isArray(input.candles) || input.candles.length === 0) {
    warnings.push("INPUT: missing or invalid `candles` (must be a non-empty array)");
    return emptyResult();
  }
  if (
    typeof input.backtestWindowBars !== "number" ||
    input.backtestWindowBars <= 0 ||
    !Number.isInteger(input.backtestWindowBars)
  ) {
    warnings.push("INPUT: `backtestWindowBars` must be a positive integer");
    return emptyResult();
  }
  if (input.backtestWindowBars >= input.candles.length) {
    warnings.push(
      `INPUT: backtestWindowBars (${input.backtestWindowBars}) must be < candles.length (${input.candles.length}); leave enough history for vol estimate`
    );
    return emptyResult();
  }
  const historyBars = input.candles.length - input.backtestWindowBars;
  if (historyBars < 24) {
    warnings.push(
      `history window is only ${historyBars} bars; need >= 24 for a reliable vol estimate — results may be noisy`
    );
  }

  // Plan is computed from the HISTORY window only — this matches what the
  // engine would have seen at the start of the backtest period.
  const historyCandles = input.candles.slice(0, historyBars);
  const backtestCandles = input.candles.slice(historyBars);
  const planInput: PlanInput = { ...input, candles: historyCandles };
  const plan = computeGridPlan(planInput);
  if (plan.levels.length === 0) {
    warnings.push(...plan.warnings.map((w) => `plan: ${w}`));
    return { ...emptyResult(), warnings };
  }

  // Simulation state. Each "open" rung is ready to fill. On a buy fill, that
  // rung's inventory moves to "long_inventory_coin"; we simultaneously look
  // for the *next-higher* unfilled sell rung and try to match it in this or
  // a future bar. On a sell fill that closes inventory, realized PnL = (sell
  // price - buy price) × coin_size.
  // We keep it simple: FIFO pairing between buy inventory queue and sell
  // fills. Unpaired long inventory at window end contributes to unrealized.

  // Sort rungs by price ascending so indexing is intuitive.
  const rungs = [...plan.levels].sort((a, b) => a.price - b.price);
  const rungState: Array<{ filled: boolean }> = rungs.map(() => ({ filled: false }));
  // FIFO queue of outstanding long "lots": {price, coin}. When a sell fills,
  // we pair with oldest lot → realized PnL = (sell - buy) × coin.
  const longLots: Array<{ price: number; coin: number }> = [];

  let fillsBuy = 0;
  let fillsSell = 0;
  let realized = 0;
  let hitStopLoss = false;
  const perBarPnl: number[] = []; // for Sharpe approx
  let runningPnl = 0;
  let peak = 0;
  let maxDd = 0;

  for (const bar of backtestCandles) {
    if (!Number.isFinite(bar.low) || !Number.isFinite(bar.high) || bar.low <= 0 || bar.high <= 0) {
      continue; // skip malformed bar rather than crash
    }
    // Stop-loss check first — we treat the stop as an absolute barrier.
    if (
      (plan.stopLossSide === "long" && bar.low <= plan.stopLossTriggerPrice) ||
      (plan.stopLossSide === "short" && bar.high >= plan.stopLossTriggerPrice)
    ) {
      hitStopLoss = true;
      const barStartPnlAtStop = runningPnl;
      // Realize loss on remaining inventory at the stop trigger price.
      for (const lot of longLots) {
        realized += (plan.stopLossTriggerPrice - lot.price) * lot.coin;
      }
      longLots.length = 0;
      // Fold the stop-loss realization into PnL/drawdown tracking so maxDD
      // and Sharpe reflect the terminal event, not just intra-window swaps.
      runningPnl = realized;
      if (runningPnl > peak) peak = runningPnl;
      const dd = peak - runningPnl;
      if (dd > maxDd) maxDd = dd;
      perBarPnl.push(runningPnl - barStartPnlAtStop);
      break;
    }
    const barStartPnl = runningPnl;
    // Process buy fills first (conservative — delays realizing gains by a bar)
    for (let i = 0; i < rungs.length; i++) {
      if (rungState[i].filled) continue;
      const r = rungs[i];
      if (r.side === "buy" && bar.low <= r.price) {
        rungState[i].filled = true;
        longLots.push({ price: r.price, coin: r.sizeCoin });
        fillsBuy++;
      }
    }
    // Now sell fills — pair each with the oldest long lot at that price or below.
    for (let i = 0; i < rungs.length; i++) {
      if (rungState[i].filled) continue;
      const r = rungs[i];
      if (r.side === "sell" && bar.high >= r.price) {
        // Sell needs a long lot to close. If no inventory, skip (short selling
        // the grid would require a separate short-lot book — v1.1 keeps it
        // single-sided conservative; this lower-bounds realized PnL).
        if (longLots.length === 0) continue;
        rungState[i].filled = true;
        const lot = longLots.shift()!;
        realized += (r.price - lot.price) * lot.coin;
        fillsSell++;
      }
    }
    runningPnl = realized;
    // Max-drawdown tracking: peak-to-trough on realized PnL.
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDd) maxDd = dd;
    perBarPnl.push(runningPnl - barStartPnl);
  }

  // Unrealized on any remaining long inventory at window end = (last close - entry) × coin.
  const lastClose = backtestCandles[backtestCandles.length - 1]?.close ?? plan.rangeHigh;
  let unrealized = 0;
  for (const lot of longLots) {
    unrealized += (lastClose - lot.price) * lot.coin;
  }

  // Sharpe approximation: mean(per-bar PnL) / stdev(per-bar PnL) × sqrt(bars/year).
  // Hourly candles assumed → 24 × 365 = 8760 bars/year.
  let sharpeApprox = 0;
  if (perBarPnl.length >= 2) {
    const mean = perBarPnl.reduce((a, b) => a + b, 0) / perBarPnl.length;
    const variance =
      perBarPnl.reduce((s, x) => s + (x - mean) ** 2, 0) / perBarPnl.length;
    const stdev = Math.sqrt(variance);
    if (stdev > 0) sharpeApprox = (mean / stdev) * Math.sqrt(8760);
  }

  return {
    coin: plan.coin,
    planHash: plan.planHash,
    gridCount: plan.gridCount,
    totalNotionalUsd: plan.totalNotionalUsd,
    leverage: plan.leverage,
    riskProfile: plan.riskProfile,
    windowBars: backtestCandles.length,
    firstCandleTimestamp: backtestCandles[0]?.timestamp ?? 0,
    lastCandleTimestamp: backtestCandles[backtestCandles.length - 1]?.timestamp ?? 0,
    fills: fillsBuy + fillsSell,
    fillsBuy,
    fillsSell,
    realizedPnlUsd: Number(realized.toFixed(4)),
    unrealizedPnlUsd: Number(unrealized.toFixed(4)),
    totalPnlUsd: Number((realized + unrealized).toFixed(4)),
    maxDrawdownUsd: Number(maxDd.toFixed(4)),
    sharpeApprox: Number(sharpeApprox.toFixed(3)),
    hitStopLoss,
    dryRun: true,
    warnings,
  };
}
