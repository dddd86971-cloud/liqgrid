#!/usr/bin/env node

// hyperliquid-aigrid CLI — deterministic grid-parameter engine for Hyperliquid perpetuals.
// This binary is ORCHESTRATED BY the hyperliquid-aigrid Plugin Store Skill.
// It does not place orders, does not handle keys, does not touch the network.
// Its sole job is to compute a GridPlan from user inputs plus live market data
// that the Skill fetches through the Hyperliquid basic plugin.
//
// Usage (JSON in, JSON out):
//   hyperliquid-aigrid plan --input plan-input.json
//   cat plan-input.json | hyperliquid-aigrid plan
//   hyperliquid-aigrid --help
//   hyperliquid-aigrid --version
//   hyperliquid-aigrid caps

import { readFileSync } from "node:fs";
import { computeGridPlan, runBacktest, runQuickstart, runOptimize } from "./grid.js";
import type { PlanInput, BacktestInput, QuickstartInput, OptimizeInput } from "./types.js";
import { CAPS } from "./types.js";

const VERSION = "1.2.2";

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`hyperliquid-aigrid v${VERSION}

Deterministic grid-parameter engine for Hyperliquid perpetuals.
Called by the hyperliquid-aigrid Skill — not intended for direct human use.

Usage:
  hyperliquid-aigrid plan [--input <file>]       Compute a GridPlan from JSON input
  hyperliquid-aigrid quickstart [--input <file>] Suggest defaults (range, leverage, profile)
                                       from coin + notional + candles
  hyperliquid-aigrid optimize [--input <file>]   Sweep (range, leverage, profile) on
                                       historical candles, return top-N
  hyperliquid-aigrid backtest [--input <file>]   Simulate a plan over historical candles
  hyperliquid-aigrid explain [--input <file>]    Human-readable breakdown of a plan
  hyperliquid-aigrid caps                        Emit hard-coded safety caps as JSON
  hyperliquid-aigrid --help                      Show this help
  hyperliquid-aigrid --version                   Print version

Note: plan accepts optional marketMeta.fundingRateHourly (hourly funding
rate as a fraction). When provided and |annualized| >= 10%, hyperliquid-aigrid tilts
per-rung notional asymmetrically (up to ±20%) to collect funding as alpha.

Input shape (JSON):
  {
    "coin": "BTC",
    "rangeLow": 90000,
    "rangeHigh": 95000,
    "totalNotionalUsd": 300,
    "leverage": 2,
    "riskProfile": "conservative" | "balanced" | "aggressive",
    "marketMeta": { coin, tickSize, minOrderSizeUsd, markPrice, maxLeverage },
    "candles": [{ open, high, low, close, timestamp }, ...]
  }

Output: a GridPlan with "dryRun": true and a "warnings" array.

Minimal example you can paste into a shell:

  echo '{
    "coin": "BTC",
    "rangeLow": 90000, "rangeHigh": 95000,
    "totalNotionalUsd": 300, "leverage": 2,
    "riskProfile": "conservative",
    "marketMeta": {
      "coin": "BTC", "tickSize": 1, "minOrderSizeUsd": 10,
      "markPrice": 92500, "maxLeverage": 20
    },
    "candles": [
      {"open":92000,"high":92600,"low":91800,"close":92300,"timestamp":0},
      {"open":92300,"high":92700,"low":92100,"close":92500,"timestamp":3600000}
    ]
  }' | hyperliquid-aigrid plan

The hyperliquid-aigrid Skill is responsible for presenting the plan to the user and
for executing any orders through the Hyperliquid basic plugin ONLY AFTER
explicit user confirmation.
`);
}

function readStdinSync(): string {
  try {
    // On a pipe/redirected stdin, readFileSync(0) works across Node versions.
    // On a TTY this would block, so bail out first.
    if (process.stdin.isTTY) return "";
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function parseJsonOrThrow<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${what} is not valid JSON: ${msg}`);
  }
}

function parseInput(argv: string[]): PlanInput {
  const idx = argv.indexOf("--input");
  let raw: string;
  if (idx !== -1 && idx + 1 < argv.length) {
    raw = readFileSync(argv[idx + 1], "utf-8");
  } else {
    raw = readStdinSync();
  }
  if (!raw.trim()) {
    throw new Error(
      "no input provided. Pass --input <file> or pipe JSON via stdin."
    );
  }
  return parseJsonOrThrow<PlanInput>(raw, "plan input");
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    // eslint-disable-next-line no-console
    console.log(VERSION);
    return;
  }
  const cmd = argv[0];
  switch (cmd) {
    case "caps":
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(CAPS, null, 2));
      return;
    case "plan": {
      const input = parseInput(argv);
      const plan = computeGridPlan(input);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    case "quickstart": {
      // Zero-friction first-time use. Input: coin + notional + candles +
      // marketMeta. Output: a recommended (rangeLow, rangeHigh, leverage,
      // riskProfile) plus a ready-to-pipe PlanInput.
      const input = parseInput(argv) as unknown as QuickstartInput;
      const result = runQuickstart(input);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "optimize": {
      // Deterministic parameter sweep. Input: coin + notional + candles +
      // marketMeta. Output: top-N (rangeLow, rangeHigh, leverage, profile)
      // candidates ranked by realizedPnl / max(maxDD, 1) Calmar-style score.
      const input = parseInput(argv) as unknown as OptimizeInput;
      const result = runOptimize(input);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "backtest": {
      // Takes a BacktestInput (same as PlanInput + `backtestWindowBars`) and
      // returns a BacktestResult with fill counts, realized PnL, max drawdown,
      // and a Sharpe approximation. Fully deterministic — same candles in,
      // same numbers out. No network, no wall-clock, no randomness.
      const input = parseInput(argv) as unknown as BacktestInput;
      const result = runBacktest(input);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "explain": {
      // Takes a GridPlan JSON (via --input or stdin) and emits a
      // human-readable breakdown. Does NOT recompute — just describes
      // what the Skill/agent is about to present to the user.
      const raw = (() => {
        const idx = argv.indexOf("--input");
        if (idx !== -1 && idx + 1 < argv.length) {
          return readFileSync(argv[idx + 1], "utf-8");
        }
        return readStdinSync();
      })();
      if (!raw.trim()) {
        throw new Error(
          "explain needs a GridPlan JSON. Pipe the output of `hyperliquid-aigrid plan` into it."
        );
      }
      const plan = parseJsonOrThrow<Record<string, unknown>>(raw, "explain input");
      explainPlan(plan as Parameters<typeof explainPlan>[0]);
      return;
    }
    default:
      // eslint-disable-next-line no-console
      console.error(`unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

function explainPlan(plan: {
  coin: string;
  gridCount: number;
  totalNotionalUsd: number;
  marginRequiredUsd?: number;
  leverage: number;
  riskProfile: string;
  rangeLow: number;
  rangeHigh: number;
  stopLossTriggerPrice: number;
  stopLossSide: string;
  maxLossAtRangeBreakUsd: number;
  maxLossPctOfNotional: number;
  liquidationDistancePct: number;
  expectedFillsPerDay: number;
  realizedVolatilityDaily: number;
  planHash: string;
  warnings: string[];
  levels: Array<{ price: number; side: string }>;
}): void {
  // Defensive validation — explain can be called on any JSON the user pipes in.
  // Surface a clear error instead of crashing on undefined access.
  const required = [
    "coin",
    "gridCount",
    "totalNotionalUsd",
    "leverage",
    "riskProfile",
    "rangeLow",
    "rangeHigh",
    "stopLossTriggerPrice",
    "planHash",
    "warnings",
    "levels",
  ];
  for (const field of required) {
    if ((plan as Record<string, unknown>)[field] === undefined) {
      throw new Error(
        `explain: input is not a GridPlan — missing field \`${field}\`. Pipe the output of \`hyperliquid-aigrid plan\` into \`hyperliquid-aigrid explain\`.`
      );
    }
  }
  if (!Array.isArray(plan.levels)) {
    throw new Error("explain: input.levels is not an array");
  }
  if (typeof plan.planHash !== "string") {
    throw new Error("explain: input.planHash is not a string");
  }

  const lines: string[] = [];
  lines.push(`Plan ${plan.planHash.slice(0, 6)}  (${plan.coin}-PERP, ${plan.riskProfile})`);
  lines.push(``);
  lines.push(`• Range:           ${plan.rangeLow} — ${plan.rangeHigh}`);
  lines.push(`• Rungs:           ${plan.gridCount}`);
  lines.push(`• Total notional:  $${plan.totalNotionalUsd}`);
  if (plan.marginRequiredUsd !== undefined) {
    lines.push(`• Margin required: ~$${plan.marginRequiredUsd.toFixed(2)} (notional / leverage)`);
  }
  lines.push(`• Leverage:        ${plan.leverage}×`);
  lines.push(``);
  lines.push(`Stop-loss:`);
  lines.push(`  ${plan.stopLossSide === "long" ? "below" : "above"} ${plan.stopLossTriggerPrice}`);
  lines.push(`  worst case loss at range break: $${plan.maxLossAtRangeBreakUsd.toFixed(2)} (${(plan.maxLossPctOfNotional * 100).toFixed(1)}% of notional)`);
  lines.push(``);
  lines.push(`Liquidation buffer: ~${(plan.liquidationDistancePct * 100).toFixed(1)}% — hyperliquid-aigrid estimate only; Hyperliquid's risk engine is authoritative.`);
  lines.push(``);
  lines.push(`Expected fills/day: ${plan.expectedFillsPerDay} (based on ${(plan.realizedVolatilityDaily * 100).toFixed(2)}% realized daily vol)`);
  if (plan.warnings.length > 0) {
    lines.push(``);
    lines.push(`Warnings:`);
    for (const w of plan.warnings) lines.push(`  ! ${w}`);
  }
  lines.push(``);
  lines.push(`Buy rungs (below mark):  ${plan.levels.filter((l) => l.side === "buy").length}`);
  lines.push(`Sell rungs (above mark): ${plan.levels.filter((l) => l.side === "sell").length}`);
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`hyperliquid-aigrid error: ${msg}`);
  process.exit(1);
}
