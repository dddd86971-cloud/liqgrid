// Shared types for the hyperliquid-aigrid parameter engine.
// All types use explicit number ranges and string enums to keep the
// grid computation deterministic across Node versions.

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

export interface MarketMeta {
  coin: string;
  tickSize: number;
  minOrderSizeUsd: number;
  markPrice: number;
  maxLeverage: number;
  // Optional: hourly funding rate as a fraction (e.g. 0.0001 = 1bp/hour ≈ 0.88% annualized).
  // When provided, hyperliquid-aigrid tilts per-rung notional asymmetrically to collect funding
  // as alpha — positive funding biases toward sell-side rungs, negative toward buy.
  // Omit / undefined / 0 disables the bias and the engine behaves symmetrically.
  fundingRateHourly?: number;
}

export interface PlanInput {
  coin: string;
  rangeLow: number;
  rangeHigh: number;
  totalNotionalUsd: number;
  leverage: number;
  riskProfile: RiskProfile;
  marketMeta: MarketMeta;
  candles: Candle[];
}

// Input to `hyperliquid-aigrid backtest`. Reuses PlanInput shape but adds a split: candles
// before index (candles.length - backtestWindowBars) are used for vol estimate
// (i.e. "what the engine would see when planning"), candles from that index
// to the end are walked bar-by-bar to simulate fills against the grid.
export interface BacktestInput extends PlanInput {
  backtestWindowBars: number;
}

// Input to `hyperliquid-aigrid quickstart`. Minimal: coin + notional + candles. Engine
// suggests sensible (rangeLow, rangeHigh, leverage, riskProfile) defaults
// from the recent vol regime so the user doesn't need to pick range manually.
export interface QuickstartInput {
  coin: string;
  totalNotionalUsd: number;
  candles: Candle[];
  marketMeta: MarketMeta;
  riskProfile?: RiskProfile;
  // optional override for "how much recent history defines the range" (default 168h = 7d)
  windowBars?: number;
}

export interface QuickstartResult {
  coin: string;
  recommendedRangeLow: number;
  recommendedRangeHigh: number;
  recommendedLeverage: number;
  riskProfile: RiskProfile;
  totalNotionalUsd: number;
  // contextual signals the recommendation was derived from
  markPrice: number;
  realizedDailyVol: number;
  windowBars: number;
  localLow: number;
  localHigh: number;
  rationale: string;
  // ready-to-pipe PlanInput so the agent can run `hyperliquid-aigrid plan` directly
  planInput: PlanInput;
  warnings: string[];
}

// Input to `hyperliquid-aigrid optimize`. Engine sweeps over a small grid of
// (range_width_pct, leverage, riskProfile) combinations, runs `runBacktest`
// on each, and ranks by a Calmar-style score (realizedPnl / max(maxDD, 1)).
// Pure compute, deterministic, no network.
export interface OptimizeInput {
  coin: string;
  totalNotionalUsd: number;
  candles: Candle[];
  marketMeta: MarketMeta;
  // window of candles used for the per-trial backtest (default 168h = 7d)
  backtestWindowBars?: number;
  // how many top candidates to return (default 3, hard max 10)
  topN?: number;
}

export interface OptimizeCandidate {
  rangeLow: number;
  rangeHigh: number;
  leverage: number;
  riskProfile: RiskProfile;
  rangeWidthPct: number; // (rangeHigh - rangeLow) / mark
  realizedPnlUsd: number;
  maxDrawdownUsd: number;
  fills: number;
  hitStopLoss: boolean;
  score: number; // higher is better
}

export interface OptimizeResult {
  coin: string;
  totalNotionalUsd: number;
  totalEvaluated: number;
  candidates: OptimizeCandidate[]; // top N, descending score
  warnings: string[];
}

export interface BacktestResult {
  coin: string;
  planHash: string; // same hash as the plan produced from the history window
  gridCount: number;
  totalNotionalUsd: number;
  leverage: number;
  riskProfile: RiskProfile;
  windowBars: number;
  firstCandleTimestamp: number;
  lastCandleTimestamp: number;
  fills: number;
  fillsBuy: number;
  fillsSell: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number; // on any open inventory at window end
  totalPnlUsd: number;
  maxDrawdownUsd: number;
  sharpeApprox: number; // realized PnL / stdev of per-bar PnL * sqrt(bars per year)
  hitStopLoss: boolean;
  dryRun: true;
  warnings: string[];
}

export interface GridLevel {
  index: number;
  price: number;
  side: "buy" | "sell";
  sizeUsd: number;
  sizeCoin: number;
}

export interface GridPlan {
  coin: string;
  gridCount: number;
  levels: GridLevel[];
  rangeLow: number;
  rangeHigh: number;
  totalNotionalUsd: number;
  marginRequiredUsd: number; // actual USDC margin the user needs; = notional / leverage
  leverage: number;
  riskProfile: RiskProfile;
  stopLossTriggerPrice: number;
  stopLossSide: "long" | "short";
  maxLossAtRangeBreakUsd: number;
  maxLossPctOfNotional: number;
  liquidationDistancePct: number;
  expectedFillsPerDay: number;
  realizedVolatilityDaily: number;
  dryRun: true;
  warnings: string[];
  planHash: string; // sha256 over (rounded) input params — stable identifier
}

// Hard caps — these are the safety boundaries for hyperliquid-aigrid v1.0.0.
// They match exactly what SKILL.md documents to the user.
// Do not widen without a corresponding SKILL.md version bump.
export const CAPS = {
  MAX_NOTIONAL_USD: 5000,
  MAX_LEVERAGE: 10,
  MAX_GRID_COUNT: 50,
  MIN_GRID_COUNT: 4,
  MAX_LOSS_PCT_OF_NOTIONAL: 0.3, // stop-loss must bound loss to <=30% of notional
} as const;
