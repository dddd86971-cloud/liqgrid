// Shared types for the hyperliquid-aigrid parameter engine.
// All types use explicit number ranges and string enums to keep the
// grid computation deterministic across Node versions.
// Hard caps — these are the safety boundaries for hyperliquid-aigrid.
// They match exactly what SKILL.md documents to the user.
// Do not widen without a corresponding SKILL.md version bump.
export const CAPS = {
    MAX_NOTIONAL_USD: 5000,
    MAX_LEVERAGE: 10,
    MAX_GRID_COUNT: 50,
    MIN_GRID_COUNT: 4,
    MAX_LOSS_PCT_OF_NOTIONAL: 0.3, // stop-loss must bound loss to <=30% of notional
};
