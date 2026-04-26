# Changelog

All notable changes to hyperliquid-aigrid are documented here.

## [1.2.1] — 2026-04-26

### Added

- **Small-account auto-adapt in `computeGridPlan`.** When the configured
  notional is too small for concentrated-liquidity sizing to keep every
  rung above `marketMeta.minOrderSizeUsd`, the engine now: (a) iteratively
  reduces `gridCount` toward `CAPS.MIN_GRID_COUNT` while every rung is
  still under min, and (b) falls back to UNIFORM per-rung sizing
  (`sigmaDaily=0` in `buildLevels`) if even MIN_GRID_COUNT under
  concentrated weighting can't satisfy the order-size floor. Two warnings
  surface the auto-reduce + the fallback decision so the user knows what
  happened and how to restore concentrated geometry. Funding bias is
  preserved through the fallback.

- **Self-tests: 30 → 33.** New cases: small-account auto-reduce,
  large-account no-trigger invariant, tiny-account uniform-fallback.

### Notes

- Pure additive logic in the post-`buildLevels` pipeline. No change to
  `buildLevels`, `computeStopLoss`, `runBacktest`, `runQuickstart`, or
  `runOptimize` algorithms. Same input on `≥ $300 × 1×` accounts produces
  byte-identical output to v1.2.0. Behavior change is scoped to small
  notionals where v1.2.0 emitted warnings but produced unplaceable rungs.

## [1.2.0] — 2026-04-25

Two new binary subcommands. The runtime contract on `plan`, `backtest`,
`explain`, `caps` is unchanged — `quickstart` and `optimize` are additive
helpers.

### Added

- **`hyperliquid-aigrid quickstart`** — zero-friction first-time use. Given just
  `coin`, `totalNotionalUsd`, `candles`, and `marketMeta`, the engine
  derives a sensible `(rangeLow, rangeHigh, leverage, riskProfile)` from
  the recent vol regime (mark ± 1.5 × σ_daily × √7 × profileWidth, then
  clamped to the recent local low/high so the range stays plausible vs the
  current market). Returns a ready-to-pipe `PlanInput`. Implementation:
  `runQuickstart()` in `src/grid.ts`.

- **`hyperliquid-aigrid optimize`** — deterministic parameter sweep. Iterates over
  5 range-widths × 5 leverages × 3 risk profiles = up to 75 combinations,
  runs `runBacktest` on each, ranks by a Calmar-style score
  (`realizedPnlUsd / max(maxDrawdownUsd, 1)`), and returns the top N.
  Same input bytes → same ranking, byte-for-byte. Implementation:
  `runOptimize()` in `src/grid.ts`.

- **Self-tests: 26 → 30.** Quickstart producing a downstream-valid
  `PlanInput`; quickstart input validation; optimize determinism + ranking
  invariants; optimize input validation.

### Notes

- Quickstart respects `marketMeta.maxLeverage` and `CAPS.MAX_LEVERAGE`
  hard caps when picking leverage.
- Optimize candidate sweep is fixed at compile time (constants
  `OPTIMIZE_RANGE_WIDTH_PCTS`, `OPTIMIZE_LEVERAGES`, `OPTIMIZE_PROFILES`)
  so determinism is preserved regardless of inputs. Adding a candidate
  outside the sweep requires a code change + version bump.

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

- **`hyperliquid-aigrid backtest` subcommand.** New deterministic candle-by-candle
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
