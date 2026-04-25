# Changelog

All notable changes to liqgrid are documented here.

## [1.1.0] — 2026-04-25

Three additions to the deterministic engine. Same input still produces a
byte-identical output; the output shape (`GridPlan`) is unchanged.

### Added

- **Funding-aware asymmetric sizing.** New optional input field
  `marketMeta.fundingRateHourly` (decimal fraction, e.g. `0.000019` =
  1.9 bp/hour ≈ 16.6% annualized). When provided and `|annualized| ≥ 10%`,
  per-rung notional tilts up to ±20% toward the side that collects funding
  as alpha (sells under positive funding, buys under negative). Below the
  10% noise floor the engine remains symmetric. Saturates at 50%
  annualized so a bad funding flip can't wreck the grid. Implementation:
  `fundingBiasFactor()` in `src/grid.ts`.

- **Concentrated-liquidity rung sizing.** Each rung's `sizeUsd` is now
  weighted by its Gaussian fill-probability in log-price space. Center
  rungs near the mark get more capital, edge rungs less. `sum(sizeUsd) ==
  totalNotionalUsd` invariant still holds. Pass `sigmaDaily = 0` to recover
  v1.0-style uniform sizing. Implementation: `fillProbabilityWeight()` in
  `src/grid.ts`.

- **`liqgrid backtest` subcommand.** New deterministic candle-by-candle
  simulation. Splits `candles` into history (vol estimate) + window
  (simulation), pairs buy fills to sell fills FIFO, reports `realizedPnlUsd`,
  `unrealizedPnlUsd`, `maxDrawdownUsd`, `sharpeApprox`, `hitStopLoss`.
  Conservative fill model — no partials, buy-first within bar, stop-loss is
  a hard barrier. New types: `BacktestInput`, `BacktestResult` in
  `src/types.ts`.

- **Self-tests: 19 → 26.** New cases: funding-bias noise-floor / sign /
  saturation, fill-probability symmetry, center-heavy sizing invariant,
  funding-positive sell-bias, backtest determinism, backtest input
  validation.

### Changed

- `buildLevels` is now dedupe-aware *before* sizing. When tick rounding
  collapses two log-spaced rungs to the same price, sizing happens against
  the surviving count so `sum(sizeUsd)` always equals `totalNotionalUsd`.
  v1.0 silently under-deployed capital in this case.
- Level `index` is contiguous `0..N-1` after dedupe.
- `planHash` for v1.0-identical inputs may differ in v1.1 because rung
  sizing is now concentrated rather than uniform — the plan IS different.

### Migration from v1.0

No code changes required. To opt out of v1.1 sizing and reproduce v1.0
behavior, omit `fundingRateHourly` (or pass `0`); concentrated-liquidity
weighting still applies (it's the new default geometry). To get exact v1.0
uniform sizing, pin to v1.0.0 source commit.

## [1.0.0] — 2026-04-23

Initial release.

- Deterministic grid-parameter engine (TypeScript → compiled JS).
- Hard caps: $5k notional / 10× leverage / 50 rungs / 30% max loss.
- Risk profiles: conservative / balanced / aggressive (gridCount and
  stop-loss-width multipliers).
- Realized-volatility-driven `gridCount` selection.
- Tick-aligned log-spaced rung prices.
- Stable `planHash` (sha256 over user-meaningful output fields).
- 19 self-tests (determinism, cap enforcement, tick alignment,
  risk-profile monotonicity, input validation).
- CLI: `plan`, `explain`, `caps`.
- Distributed via `bun install -g` by Plugin Store CI from this repo at a
  pinned commit.
