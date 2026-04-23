// Shared types for the liqgrid parameter engine.
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

// Hard caps — these are the safety boundaries for liqgrid v1.0.0.
// They match exactly what SKILL.md documents to the user.
// Do not widen without a corresponding SKILL.md version bump.
export const CAPS = {
  MAX_NOTIONAL_USD: 5000,
  MAX_LEVERAGE: 10,
  MAX_GRID_COUNT: 50,
  MIN_GRID_COUNT: 4,
  MAX_LOSS_PCT_OF_NOTIONAL: 0.3, // stop-loss must bound loss to <=30% of notional
} as const;
