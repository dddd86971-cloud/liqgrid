#!/usr/bin/env node
// liqgrid CLI — deterministic grid-parameter engine for Hyperliquid perpetuals.
// This binary is ORCHESTRATED BY the liqgrid Plugin Store Skill.
// It does not place orders, does not handle keys, does not touch the network.
// Its sole job is to compute a GridPlan from user inputs plus live market data
// that the Skill fetches through the Hyperliquid basic plugin.
//
// Usage (JSON in, JSON out):
//   liqgrid plan --input plan-input.json
//   cat plan-input.json | liqgrid plan
//   liqgrid --help
//   liqgrid --version
//   liqgrid caps
import { readFileSync } from "node:fs";
import { computeGridPlan } from "./grid.js";
import { CAPS } from "./types.js";
const VERSION = "1.0.0";
function printHelp() {
    // eslint-disable-next-line no-console
    console.log(`liqgrid v${VERSION}

Deterministic grid-parameter engine for Hyperliquid perpetuals.
Called by the liqgrid Skill — not intended for direct human use.

Usage:
  liqgrid plan [--input <file>]     Compute a GridPlan from JSON input
  liqgrid explain [--input <file>]  Human-readable breakdown of a plan
  liqgrid caps                      Emit hard-coded safety caps as JSON
  liqgrid --help                    Show this help
  liqgrid --version                 Print version

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
  }' | liqgrid plan

The liqgrid Skill is responsible for presenting the plan to the user and
for executing any orders through the Hyperliquid basic plugin ONLY AFTER
explicit user confirmation.
`);
}
function readStdinSync() {
    try {
        // On a pipe/redirected stdin, readFileSync(0) works across Node versions.
        // On a TTY this would block, so bail out first.
        if (process.stdin.isTTY)
            return "";
        return readFileSync(0, "utf-8");
    }
    catch {
        return "";
    }
}
function parseJsonOrThrow(raw, what) {
    try {
        return JSON.parse(raw);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`${what} is not valid JSON: ${msg}`);
    }
}
function parseInput(argv) {
    const idx = argv.indexOf("--input");
    let raw;
    if (idx !== -1 && idx + 1 < argv.length) {
        raw = readFileSync(argv[idx + 1], "utf-8");
    }
    else {
        raw = readStdinSync();
    }
    if (!raw.trim()) {
        throw new Error("no input provided. Pass --input <file> or pipe JSON via stdin.");
    }
    return parseJsonOrThrow(raw, "plan input");
}
function main() {
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
                throw new Error("explain needs a GridPlan JSON. Pipe the output of `liqgrid plan` into it.");
            }
            const plan = parseJsonOrThrow(raw, "explain input");
            explainPlan(plan);
            return;
        }
        default:
            // eslint-disable-next-line no-console
            console.error(`unknown command: ${cmd}`);
            printHelp();
            process.exit(2);
    }
}
function explainPlan(plan) {
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
        if (plan[field] === undefined) {
            throw new Error(`explain: input is not a GridPlan — missing field \`${field}\`. Pipe the output of \`liqgrid plan\` into \`liqgrid explain\`.`);
        }
    }
    if (!Array.isArray(plan.levels)) {
        throw new Error("explain: input.levels is not an array");
    }
    if (typeof plan.planHash !== "string") {
        throw new Error("explain: input.planHash is not a string");
    }
    const lines = [];
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
    lines.push(`Liquidation buffer: ~${(plan.liquidationDistancePct * 100).toFixed(1)}% — liqgrid estimate only; Hyperliquid's risk engine is authoritative.`);
    lines.push(``);
    lines.push(`Expected fills/day: ${plan.expectedFillsPerDay} (based on ${(plan.realizedVolatilityDaily * 100).toFixed(2)}% realized daily vol)`);
    if (plan.warnings.length > 0) {
        lines.push(``);
        lines.push(`Warnings:`);
        for (const w of plan.warnings)
            lines.push(`  ! ${w}`);
    }
    lines.push(``);
    lines.push(`Buy rungs (below mark):  ${plan.levels.filter((l) => l.side === "buy").length}`);
    lines.push(`Sell rungs (above mark): ${plan.levels.filter((l) => l.side === "sell").length}`);
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
}
try {
    main();
}
catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`liqgrid error: ${msg}`);
    process.exit(1);
}
