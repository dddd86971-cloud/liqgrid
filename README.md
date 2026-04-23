# liqgrid

Deterministic grid-parameter engine for Hyperliquid perpetuals.
Powers the [`liqgrid`](https://github.com/okx/plugin-store) Plugin Store Skill.

This CLI is **orchestrated by the `liqgrid` Skill**, not meant for direct
human use. It accepts JSON inputs (market meta + candles + user parameters),
returns a deterministic `GridPlan` JSON. It does not place orders, does not
handle private keys, does not make network calls.

## Why a separate binary?

Grid math needs to be **deterministic** — same inputs always produce the
same plan. Pure Skill-markdown implementations rely on the LLM to compute
grid levels, which gives different results across models and even across
runs with the same model. A compiled binary guarantees consistency.

## Install

End users never install this directly. The Plugin Store installs it
automatically when they add the `liqgrid` Skill:

```
npx skills add okx/plugin-store --skill liqgrid
```

For local development:

```
npm install
npm run build
node dist/test.js    # run self-tests
node dist/index.js --help
```

## CLI

```
liqgrid plan --input plan.json        # compute a GridPlan
liqgrid explain --input plan.json     # human-readable breakdown of a plan
liqgrid caps                          # emit hard-coded safety caps
liqgrid --help
liqgrid --version
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
    "maxLeverage": 20
  },
  "candles": [ ... ]
}
```

Output: a `GridPlan` with `dryRun: true`, `levels`, `stopLossTriggerPrice`,
`maxLossPctOfNotional`, `expectedFillsPerDay`, `marginRequiredUsd`
(distinct from `totalNotionalUsd` — margin is what the user needs to
deposit), a `warnings` array, and a `planHash` (stable sha256 over the
output's user-meaningful fields — used as a strategy identifier for
support and for external verification).

## Safety caps (enforced in `src/types.ts`)

| Cap | Value |
|---|---|
| Max total notional | $5,000 |
| Max leverage | 10× |
| Max grid count | 50 |
| Min grid count | 4 |
| Max loss at range break | 30% of notional |

Inputs above these caps are clamped silently and a warning is added to the
plan. The `liqgrid` Skill surfaces these warnings to the user before any
order is placed.

## Determinism

The engine is deterministic: it uses no randomness, no wall-clock reads,
and no network I/O. Its only external dependency is Node's built-in
`crypto` module (for `planHash` computation). Given the same input
bytes, it produces the same output bytes. The test suite in
`src/test.ts` verifies this across run iterations.

## License

MIT — see `LICENSE`.
