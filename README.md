# hyperliquid-aigrid

Deterministic grid-parameter engine for Hyperliquid perpetuals. Powers the
[`hyperliquid-aigrid`](https://github.com/okx/plugin-store) Plugin Store Skill.

This CLI is **orchestrated by the `hyperliquid-aigrid` Skill**, not intended for direct
human use. It accepts JSON inputs (market meta + candles + user parameters),
returns a deterministic `GridPlan` JSON. It does **not** place orders, handle
private keys, or make network calls.

## What's inside

```
User (natural language)
  │
  ▼
hyperliquid-aigrid Skill (SKILL.md, lives in okx/plugin-store)
  │
  ├── hyperliquid-plugin   (fetches mark / funding / 1h candles, signs TX)
  │
  └── hyperliquid-aigrid binary       ◄── this repo
       ├─ plan      → compute grid levels, stop-loss, expected PnL
       ├─ backtest  → simulate plan over historical candles
       ├─ explain   → human-readable breakdown of a plan JSON
       └─ caps      → emit the hard-coded safety limits
```

## Why a separate binary

Grid math must be **deterministic** — same inputs always produce the same
plan, across Node versions, across machines, across LLM model generations.
Pure Skill-markdown implementations leave the math to the LLM and drift call
to call. A compiled binary with a stable `planHash` SHA-256 fingerprint
guarantees reproducibility.

## What's new

### v1.2.0 (current)

- **`hyperliquid-aigrid quickstart`** — zero-friction first-time use. Given
  just `coin`, `totalNotionalUsd`, `candles`, and `marketMeta`, the engine
  derives sensible `(rangeLow, rangeHigh, leverage, riskProfile)` and
  returns a ready-to-pipe `PlanInput`.
- **`hyperliquid-aigrid optimize`** — deterministic sweep over 5 range-widths
  × 5 leverages × 3 profiles (75 combinations). Each candidate runs through
  `runBacktest`, ranked by Calmar score (`realizedPnl / max(maxDD, 1)`),
  returns the top N.

### v1.1.0

- **Funding-aware asymmetric sizing**: when `marketMeta.fundingRateHourly` is
  provided, per-rung notional tilts up to ±20% to collect funding as alpha.
  Symmetric below 10% annualized noise floor; saturates at 50% annualized.
- **Concentrated-liquidity rung sizing**: each rung's `sizeUsd` is weighted
  by its Gaussian fill-probability in log-price space. Near-mark rungs get
  more capital, edge rungs less. `sum(sizeUsd) == totalNotionalUsd` invariant.
- **`hyperliquid-aigrid backtest`** subcommand: candle-by-candle simulation with
  FIFO buy-to-sell pairing, realized + unrealized PnL, max drawdown, Sharpe
  approximation, stop-loss trigger detection.

## Install (local development)

```bash
npm install
npm run build
node dist/test.js       # 30 self-tests
node dist/index.js --help
```

## CLI

```bash
hyperliquid-aigrid plan      --input plan.json       # compute a GridPlan
hyperliquid-aigrid backtest  --input backtest.json   # simulate over historical candles
hyperliquid-aigrid explain   --input plan.json       # human-readable plan breakdown
hyperliquid-aigrid caps                              # emit hard-coded safety caps
hyperliquid-aigrid --help
hyperliquid-aigrid --version
```

Input JSON shape (matches `src/types.ts:PlanInput`):

```json
{
  "coin": "BTC",
  "rangeLow": 90000,
  "rangeHigh": 95000,
  "totalNotionalUsd": 300,
  "leverage": 2,
  "riskProfile": "conservative",
  "marketMeta": {
    "coin": "BTC",
    "tickSize": 1,
    "minOrderSizeUsd": 10,
    "markPrice": 92500,
    "maxLeverage": 20,
    "fundingRateHourly": -0.000019
  },
  "candles": [ { "open": ..., "high": ..., "low": ..., "close": ..., "timestamp": ... }, ... ]
}
```

Backtest also takes `backtestWindowBars: <positive int>` to split `candles`
into history (for vol estimate) and backtest window (for simulation).

Output: a `GridPlan` (or `BacktestResult`) with `dryRun: true`, `warnings[]`,
and a stable `planHash`.

## Safety caps (enforced in `src/types.ts`)

| Cap | Value |
|---|---|
| Max total notional | $5,000 |
| Max leverage | 10× |
| Max grid count | 50 |
| Min grid count | 4 |
| Max loss at range break | 30% of notional |

Inputs above these caps are clamped silently and a warning is added to the
plan. The `hyperliquid-aigrid` Skill surfaces these warnings to the user before any
order is placed.

## Determinism

The engine is deterministic: no `Math.random`, no wall-clock reads, no
network I/O. The only external dependency is Node's built-in `crypto` module
for `planHash` computation. Given the same input bytes, it produces the same
output bytes. The test suite in `src/test.ts` verifies this across run
iterations (test `deterministic across runs`, `serialization hash is
stable`, `plan.planHash is embedded and deterministic`, `backtest:
deterministic and produces valid result`).

## Tests

```bash
npm test
```

30 invariants covering:

- Baseline plan correctness (risk profiles, gridCount, level tick alignment)
- Determinism (JSON serialization + planHash stability across runs)
- Cap enforcement (notional / leverage / conservative-high-lev downshift)
- Input validation (missing candles / marketMeta / riskProfile, inverted
  range, non-positive rangeLow)
- v1.1 funding bias (noise floor, sign, saturation at ±20%)
- v1.1 concentrated liquidity (center-heavy sizing invariant)
- v1.1 backtest (determinism + valid numeric outputs + input validation)
- v1.2 quickstart (downstream-valid `PlanInput`, candle-count validation)
- v1.2 optimize (75-combo sweep determinism, top-N ranking invariant,
  `realizedPnl / max(maxDD, 1)` Calmar-style score)

## License

MIT — see `LICENSE`.
