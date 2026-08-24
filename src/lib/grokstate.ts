// grok-accounts.json + grok-lastswap.json persistence. Parallel to
// codexstate.ts, deliberately a separate file pair: the three pools have
// different shapes and swap independently, so no index can clobber another.
// Absent files are the empty state; a file that exists but fails to parse
// THROWS (a fabricated empty pool would silently orphan parked credentials).

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { grokPaths } from "./paths.ts";
import { GrokAccountsIndexSchema, LastSwapSchema, type GrokAccountsIndex } from "./types.ts";

export function loadGrokAccounts(): GrokAccountsIndex {
  if (!existsSync(grokPaths.accountsJson)) return { version: 1, activeAccountId: null, accounts: [] };
  return GrokAccountsIndexSchema.parse(JSON.parse(readFileSync(grokPaths.accountsJson, "utf8")));
}

export function saveGrokAccounts(input: { index: GrokAccountsIndex }): void {
  writeFileAtomic(grokPaths.accountsJson, JSON.stringify(GrokAccountsIndexSchema.parse(input.index), null, 2) + "\n");
}

export function loadGrokLastSwapAt(): number | null {
  if (!existsSync(grokPaths.lastSwapJson)) return null;
  return LastSwapSchema.parse(JSON.parse(readFileSync(grokPaths.lastSwapJson, "utf8"))).ts;
}

export function saveGrokLastSwapAt(input: { ts: number }): void {
  writeFileAtomic(grokPaths.lastSwapJson, JSON.stringify(LastSwapSchema.parse({ ts: input.ts })));
}
