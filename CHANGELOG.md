# Changelog

All notable changes to hyperliquid-aigrid are documented here.

## [1.2.4] — 2026-04-26

### Added

- **Fee-aware plan output** — driven by direct observation on live HL
  fills (`crossed: false` carrying fee = 1.5 bps = $0.0019 on a $11.69
  notional). Pre-v1.2.4 the plan reported `expectedFillsPerDay` but
  not what each fill actually netted after fees, leaving users guessing
  whether their grid was profitable. Four new fields:
  - `avgRungGapPct` — average geometric gap between adjacent same-side
    rungs (≈ `rangeWidthPct / (gridCount - 1)`).
  - `expectedFeePerRoundtripUsd` — round-trip fee for ONE rung pair
    (`2 × rungNotional × leverage × feeRateMaker`).
  - `breakEvenGapPct` — the gap below which fees swallow gross profit.
    For HL tier-0 maker (1.5 bps), this is 3 bps.
  - `feeAwareNetEdgePerRoundtripUsd` — gross excursion captured per
    roundtrip minus the round-trip fee.
- **`MarketMeta.feeRateMaker` / `feeRateTaker`** (optional). Defaults
  match Hyperliquid tier-0: maker 1.5 bps (0.00015), taker 4.5 bps
  (0.00045). Users on higher tiers / fee-free venues can override.
- **Fee-erosion warning** — fires when `avgRungGapPct < 2 × breakEvenGapPct`.
  At that point fees eat ≥ 50% of gross profit per roundtrip — the user
  should either widen the range or accept that fees dominate returns.
- **Self-tests: 41 → 45.** New cases: fee fields with HL defaults;
  user-overridden fee rate scales `breakEvenGapPct`; net edge =
  gross − expected fee; fee-erosion warning fires below 2× break-even.

### Notes

- **`planHash` unchanged** for the same input bytes. Like v1.2.2 / v1.2.3,
  the new fields are derived (not in the hashable spec). v1.2.3 → v1.2.4
  is purely additive output extension.
- **Real-world calibration.** The 1.5 bps default came from a live
  $24-account 4-rung grid placed during PR-#360 testing: a
  `crossed: false` (maker) buy fill of 0.00016 BTC at $77,822 carried
  fee $0.001867 USDC, which is 1.5 bps of $12.45 notional. Matches HL's
  published tier-0 maker schedule.

## [1.2.3] — 2026-04-26

### Changed

- **Notional-aware `quickstart` range derivation.** Pre-v1.2.3 the range
  was purely vol-driven (`mark ± k × σ_daily × √7 × profileWidth`),
  giving the same ±4-7% range to all account sizes. For small accounts
  forced into `MIN_GRID_COUNT=4` rungs, this meant rungs ~1%+ apart while
  hourly vol was ~0.3% — so the grid would sit inactive for hours waiting
  for an outlier move. v1.2.3 picks the **tighter** of:
  - **(a) natural geometry** — `(rungs - 1) × σ_hourly × profileGap`,
    where `rungs` is bounded by `floor(notional × leverage / minOrder)`
    clamped to `[MIN_GRID_COUNT, MAX_GRID_COUNT]`. Each gap is one
    σ_hourly × profile multiplier, so the grid trades on ordinary
    intraday wiggles.
  - **(b) vol envelope** — the original `k × σ_daily × √7 × profileWidth`,
    preserved as an upper bound so large notionals don't blow out to a
    30%+ range.

  Real-world impact at σ_d=1.35% (BTC, calm day):

  | Account | Range pre-1.2.3 | Range post-1.2.3 | Source |
  |---|---|---|---|
  | $24 | ±4.4% (always) | **±0.41%** | natural — 4 rungs × σ_h |
  | $100 | ±4.4% | **±2.61%** | natural — 20 rungs × σ_h |
  | $5000 | ±4.4% | ±4.36% | vol envelope (unchanged) |

- **New `PROFILE_GAP` constants** — `1.0 / 1.5 / 2.0` for
  conservative / balanced / aggressive. Conservative trades on hourly
  vol; aggressive accepts ~4-hour gaps.

### Added

- **`tiny notional` quickstart warning.** When
  `notional × leverage < MIN_GRID_COUNT × minOrder`, quickstart now
  emits a clear warning that `plan()` will auto-fall back to uniform
  sizing, with the exact recommended bump amount
  (`≥ MIN_GRID_COUNT × minOrder / leverage`) to restore full coverage.
- **Self-tests: 37 → 41.** New cases: small-account uses natural
  geometry; large-account uses vol-envelope; rung count monotonically
  grows with notional; tiny notional emits min-order warning.

### Notes

- Existing `plan()` semantics unchanged. Only `quickstart()` was
  modified. Users who pass an explicit `(rangeLow, rangeHigh)` to
  `plan` see no behavior change. Users who go through `quickstart`
  see better defaults — especially small accounts.
- `planHash` for plans built from explicit inputs is byte-identical
  to v1.2.2. Plans built via `quickstart → plan` will produce different
  `planHash` because the range itself differs (intentional — that's
  the point of the change).

## [1.2.2] — 2026-04-26

### Added

- **Three new `GridPlan` output fields** for direct visibility into
  the funding-bias tilt and grid geometry, no longer requiring the
  caller to walk `levels[]`:
  - `buySideNotionalUsd`: sum of `sizeUsd` across all buy rungs.
  - `sellSideNotionalUsd`: sum across all sell rungs.
  - `rangeWidthPct`: `(rangeHigh - rangeLow) / markPrice`. Matches
    the same metric on `OptimizeCandidate.rangeWidthPct`.
- **`expected fills/day < 1` warning.** When realized vol is too low
  for the configured range, the grid would sit idle and pay funding
  for nothing. The warning suggests tightening the range to ±2σ daily
  of mark, or waiting for higher vol. Added to `computeGridPlan`
  after the stop-loss/min-order checks.
- **Self-tests: 33 → 37.** New cases: buy/sell-side fields match
  `levels[]` sum; `rangeWidthPct` math correctness; positive funding
  → `sellSide > buySide` via the new fields; `expected fills/day < 1`
  warning fires with a "tighten range" suggestion.

### Notes

- **`planHash` unchanged** for the same input bytes. The new output
  fields are derived from existing inputs (`levels[]`, `rangeLow`,
  `rangeHigh`, `markPrice`), and they are NOT in the planHash hashable
  spec. v1.2.1 → v1.2.2 is a purely additive output extension —
  upgrading the binary in place does not invalidate cached planHash
  references in user UIs or audit logs.
- The SKILL.md now documents an explicit **REFUSE-prefix abort rule**
  in pre-execution checks: any `plan.warnings` element starting with
  `REFUSE:` is a hard stop; the agent must not place orders. This
  formalizes existing behavior for stale-range guards.

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
