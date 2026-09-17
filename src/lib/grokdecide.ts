// Shared grok switch decision, used by the grok Stop/StopFailure hook and
// `xx switch --grok`. Same policy as decide.ts/codexdecide.ts, reshaped for
// grok mechanics: usage is the free credits GET (weekly-only - no 5h window
// exists, none is invented), the swap hot-reloads into every default-home
// session (so there is no codex-style sibling reconcile - all sessions follow
// the seat by construction, the documented blast radius), and the depleted
// pool CAN pre-park onto the soonest-recovering account with a waitUntil the
// supervisor counts down (grok resumes cleanly via `--resume <sid>`).

import { z } from "zod";
import { withLock } from "./lock.ts";
import { grokPaths } from "./paths.ts";
import { loadConfig } from "./state.ts";
import { loadGrokAccounts, loadGrokLastSwapAt, saveGrokAccounts } from "./grokstate.ts";
import { grokCurrentWins, grokWeeklyExpiry, isGrokEngaged, isGrokExhausted, pickBestGrok } from "./grokpick.ts";
import { performGrokSwap } from "./grokswap.ts";
import { GrokAuthRejectedError, GrokUsageReadError, fetchGrokUsage } from "./grokusage.ts";
import { grokIdentityOf, poolableGrokIssuer, readLiveGrokAuth } from "./grokauth.ts";
import { liveGrokAccountId } from "./groksample.ts";
import { effectiveBars } from "./picker.ts";
import { log } from "./log.ts";
import { GrokAccountSchema } from "./types.ts";

const GrokSwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: GrokAccountSchema.nullable(),
  reason: z.string(),
  /** set on the depleted-wait path: the soonest weekly reset the supervisor
   *  should count down to before resuming (within policy.maxWaitMs). */
  waitUntil: z.number().nullable(),
});
export type GrokSwapDecision = z.infer<typeof GrokSwapDecisionSchema>;

const POST_SWAP_COOLDOWN_MS = 45_000;

/**
 * Sample the LIVE credential's usage and stamp it onto its TRUE owner in the
 * pool (the blob's own user_id: labels drift, the token cannot lie). A failed
 * read is a logged miss, not a decision-stopper: the cached windows still
 * rank, and a live token expired between sessions heals itself on the next
 * grok spawn (there is no self-refresh to attempt). Returns the owner id, or
 * null when the live credential is absent or unpooled.
 */
async function sampleLiveOntoOwner(input: { now: number }): Promise<string | null> {
  const { now } = input;
  const live = readLiveGrokAuth();
  if (!live) return null;
  const entry = poolableGrokIssuer({ auth: live });
  if (!entry) return null;
  const index = loadGrokAccounts();
  const identity = grokIdentityOf({ auth: live });
  const owner = index.accounts.find((account) => account.accountId === identity.accountId);
  if (!owner) return null;
  try {
    const usage = await fetchGrokUsage({ issuer: entry.issuer });
    owner.lastUsage = { weekly: usage.weekly };
    owner.lastUsageAt = now;
    if (identity.email != null) owner.email = identity.email;
    saveGrokAccounts({ index });
  } catch (e) {
    if (!(e instanceof GrokAuthRejectedError || e instanceof GrokUsageReadError)) throw e;
    log("grokdecide.live_sample_miss", { err: e.message });
  }
  return owner.accountId;
}

/**
 * Evaluate the grok pool and swap when warranted. `force` is the StopFailure
 * rate_limit path: the server just refused the live account, so the decision
 * engages regardless of the cached floor (the cache may be minutes stale).
 */
export async function evaluateAndMaybeSwapGrok(input: { now?: number; force?: boolean }): Promise<GrokSwapDecision> {
  const now = input.now ?? Date.now();
  const cfg = loadConfig();
  const bars = effectiveBars(cfg);

  return withLock(grokPaths.lockFile, async () => {
    const index0 = loadGrokAccounts();
    if (index0.accounts.length === 0) return { swapped: false, account: null, reason: "no-pool", waitUntil: null };

    // The current account is ALWAYS the live auth.json's own identity: the
    // stored activeAccountId label drifts (a manual `grok login`, a crash
    // before saveGrokAccounts). A live identity outside the pool is the
    // org-guard analog: do nothing, a swap over an unknown credential could
    // destroy its only copy.
    const activeId = liveGrokAccountId();
    if (activeId == null || !index0.accounts.some((account) => account.accountId === activeId)) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool", waitUntil: null };
    }

    const lastSwapAt = loadGrokLastSwapAt();
    if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
      return { swapped: false, account: null, reason: "post-swap-cooldown", waitUntil: null };
    }

    // Freshness: re-sample the live credential once its owner's cached
    // snapshot ages past the poll TTL (there is no push feed in between).
    // A forced (rate-limited) evaluation always re-samples: the refusal
    // proves the cache wrong.
    const activeEntry = index0.accounts.find((account) => account.accountId === activeId);
    const stale = input.force === true || activeEntry?.lastUsageAt == null || now - activeEntry.lastUsageAt > cfg.policy.usagePollTtlMs;
    if (stale) await sampleLiveOntoOwner({ now });
    const index = loadGrokAccounts();

    const active = index.accounts.find((account) => account.accountId === activeId) ?? null;
    if (!active) return { swapped: false, account: null, reason: "no-active-account", waitUntil: null };

    const engaged =
      input.force === true ||
      active.needsReauth === true ||
      isGrokEngaged({ account: active, floor: cfg.policy.greedySessionFloor, now }) ||
      isGrokExhausted({ account: active, thresholds: bars, now });
    if (!engaged) return { swapped: false, account: null, reason: "under-threshold-or-stale", waitUntil: null };

    // Greedy path: engaged but under the bar. Swap only onto an account that
    // beats the seat by the churn margin; hot-reload makes the swap itself
    // free for every running session.
    if (!input.force && !isGrokExhausted({ account: active, thresholds: bars, now }) && active.needsReauth !== true) {
      if (grokCurrentWins({ active, accounts: index.accounts, thresholds: bars, now })) {
        return { swapped: false, account: null, reason: "current-best", waitUntil: null };
      }
      const best = pickBestGrok({ accounts: index.accounts, thresholds: bars, now, currentAccountId: activeId });
      if (!best) return { swapped: false, account: null, reason: "no-usable-target", waitUntil: null };
      await performGrokSwap({ target: best });
      log("grokdecide.greedy_swap", { account: best.accountId.slice(0, 8) });
      return { swapped: true, account: best, reason: "swapped", waitUntil: null };
    }

    // Hard path: the bar is crossed, the grant is dead, or the server just
    // rate-limited the seat (force). Land on the best usable candidate.
    const best = pickBestGrok({ accounts: index.accounts, thresholds: bars, now, currentAccountId: activeId });
    if (best) {
      await performGrokSwap({ target: best });
      log("grokdecide.hard_swap", { account: best.accountId.slice(0, 8) });
      return { swapped: true, account: best, reason: "swapped", waitUntil: null };
    }

    // A forced (rate-limited) evaluation whose seat is NOT measurably
    // exhausted stops here: capacity errors (503/529) classify as rate_limit
    // too, and parking a session until a weekly reset hours away over a
    // transient blip would be far worse than riding it out. A genuinely
    // depleted seat re-enters below via its own sampled bar.
    if (input.force === true && active.needsReauth !== true && !isGrokExhausted({ account: active, thresholds: bars, now })) {
      return { swapped: false, account: null, reason: "no-usable-target", waitUntil: null };
    }

    // All depleted: pre-park on the soonest-recovering account (weekly resets
    // are forfeit-at-reset, so the soonest reset is the soonest usable seat)
    // and hand the supervisor a countdown when the wait fits maxWaitMs. A
    // needs-reauth account never recovers by waiting and is excluded.
    const waitable = index.accounts.filter((account) => account.needsReauth !== true);
    const soonest = waitable.reduce<{ account: (typeof waitable)[number]; at: number } | null>((acc, account) => {
      const at = grokWeeklyExpiry({ account, now });
      return acc == null || at < acc.at ? { account, at } : acc;
    }, null);
    if (soonest == null || !Number.isFinite(soonest.at) || soonest.at - now > cfg.policy.maxWaitMs) {
      return { swapped: false, account: null, reason: "all-depleted", waitUntil: null };
    }
    if (soonest.account.accountId === activeId) {
      return { swapped: false, account: soonest.account, reason: "depleted-wait", waitUntil: soonest.at };
    }
    await performGrokSwap({ target: soonest.account });
    log("grokdecide.depleted_prepark", { account: soonest.account.accountId.slice(0, 8), waitUntil: soonest.at });
    return { swapped: true, account: soonest.account, reason: "depleted-wait", waitUntil: soonest.at };
  });
}
