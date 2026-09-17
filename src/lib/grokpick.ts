// Choose the grok account to switch TO. Same policy as the claude/codex
// pickers, reduced to the ONE window grok has: among usable accounts (no
// reauth, weekly under its bar or already reset), take the one furthest
// behind its own weekly pace (highest pacePressure) - weekly allowance is
// forfeited at a fixed per-account reset. There is NO 5h window in the
// credits payload (issue #1): the session threshold never applies here.

import { sortBy } from "es-toolkit";
import { nextWeeklyReset } from "./picker.ts";
import type { GrokAccount, GrokWindow, Thresholds } from "./types.ts";

/** A window whose reset has passed reads as empty (the weekly anchor recurs,
 *  nextWeeklyReset extrapolates it forward). A null reset trusts the reading:
 *  unmeasured recovery must not look safe. */
function liveUsed(input: { window: GrokWindow; now: number }): number {
  const { window, now } = input;
  if (window.resetsAt != null && window.resetsAt <= now) return 0;
  return window.usedPercentage;
}

/** The weekly window at/over the weekly bar (and not yet reset) blocks the
 *  account. An UNMEASURED account is not exhausted but ranks last in the
 *  picker (pressure 0) - it can be landed on only when nothing measured is
 *  usable. */
export function isGrokExhausted(input: { account: GrokAccount; thresholds: Thresholds; now: number }): boolean {
  const { account, thresholds, now } = input;
  const weekly = account.lastUsage?.weekly;
  if (!weekly) return false;
  return liveUsed({ window: weekly, now }) >= thresholds.weekly;
}

/** Forward pace pressure on the weekly window: the burn rate the remaining
 *  weekly quota demands before its reset forfeits it. No sampled window or no
 *  reset anchor ranks last (0): unmeasured must not look urgent. */
export function grokPacePressure(input: { account: GrokAccount; now: number }): number {
  const { account, now } = input;
  const weekly = account.lastUsage?.weekly;
  if (!weekly) return 0;
  const reset = nextWeeklyReset(weekly.resetsAt, now);
  if (reset == null) return 0;
  return Math.max(0, 100 - liveUsed({ window: weekly, now })) / Math.max(1, reset - now);
}

/** Epoch ms when the account's weekly quota next resets; no anchor sorts last. */
export function grokWeeklyExpiry(input: { account: GrokAccount; now: number }): number {
  const { account, now } = input;
  return nextWeeklyReset(account.lastUsage?.weekly.resetsAt ?? null, now) ?? Number.POSITIVE_INFINITY;
}

const grokSwapPreference = (now: number) => [
  (account: GrokAccount) => -grokPacePressure({ account, now }),
  (account: GrokAccount) => grokWeeklyExpiry({ account, now }),
];

export function pickBestGrok(input: {
  accounts: GrokAccount[];
  thresholds: Thresholds;
  now: number;
  currentAccountId: string | null;
}): GrokAccount | null {
  const { accounts, thresholds, now, currentAccountId } = input;
  const usable = accounts.filter(
    (account) =>
      account.accountId !== currentAccountId &&
      account.needsReauth !== true &&
      !isGrokExhausted({ account, thresholds, now }),
  );
  return sortBy(usable, grokSwapPreference(now))[0] ?? null;
}

/** A grok swap hot-reloads into every default-home session (no respawn), but
 *  engagement is chronic on a weekly-only pool exactly like codex: without a
 *  margin, every hair of pace-pressure drift would churn the seat on the
 *  cooldown beat. Same factor as CODEX_SWAP_IMPROVEMENT (issue #1). */
export const GROK_SWAP_IMPROVEMENT = 1.2;

/** Greedy idempotence: the active account keeps its seat while usable unless
 *  a challenger beats its pace pressure by GROK_SWAP_IMPROVEMENT. */
export function grokCurrentWins(input: {
  active: GrokAccount | null;
  accounts: GrokAccount[];
  thresholds: Thresholds;
  now: number;
}): boolean {
  const { active, accounts, thresholds, now } = input;
  if (!active || active.needsReauth === true || isGrokExhausted({ account: active, thresholds, now })) return false;
  const best = pickBestGrok({ accounts, thresholds, now, currentAccountId: null });
  if (best == null || best.accountId === active.accountId) return true;
  return grokPacePressure({ account: best, now }) <= grokPacePressure({ account: active, now }) * GROK_SWAP_IMPROVEMENT;
}

/** True once the weekly window is at/over the greedy engagement floor: with
 *  no 5h window, the floor reads against the one window there is. */
export function isGrokEngaged(input: { account: GrokAccount; floor: number; now: number }): boolean {
  const { account, floor, now } = input;
  const weekly = account.lastUsage?.weekly;
  if (!weekly) return false;
  return liveUsed({ window: weekly, now }) >= floor;
}
