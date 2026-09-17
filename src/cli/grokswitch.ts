// `tokenmaxxing switch --grok [sel]`. Bare form is GREEDY and IDEMPOTENT off
// cached windows, exactly like the claude/codex switches: rank every grok
// account (current included) by weekly pace pressure among those under the
// bar; when the current account already wins, do nothing. The current account
// is the LIVE auth.json's own identity, never the stored label. The swap
// takes effect on the next API call of every default-home grok session (auth
// hot-reload); the restart fallback exists only for the hook's rate_limit
// path, not here.

import { withLock } from "../lib/lock.ts";
import { grokPaths } from "../lib/paths.ts";
import { loadConfig } from "../lib/state.ts";
import { loadGrokAccounts } from "../lib/grokstate.ts";
import { grokCurrentWins, pickBestGrok } from "../lib/grokpick.ts";
import { performGrokSwap } from "../lib/grokswap.ts";
import { liveGrokAccountId } from "../lib/groksample.ts";
import { effectiveBars } from "../lib/picker.ts";
import { findGrokAccount } from "./rename.ts";
import { c } from "./render.ts";

export async function cmdGrokSwitch(sel?: string): Promise<number> {
  const cfg = loadConfig();
  const bars = effectiveBars(cfg);
  const now = Date.now();

  return withLock(grokPaths.lockFile, async () => {
    const index = loadGrokAccounts();
    if (index.accounts.length === 0) {
      console.log(c.dim("no grok accounts yet - run `tokenmaxxing init --grok`"));
      return 1;
    }
    const currentId = liveGrokAccountId();

    // truthiness on purpose, mirroring the claude/codex switches: an EMPTY
    // selector must mean "no selector", or `startsWith("")` matches everyone.
    if (sel) {
      const target = findGrokAccount(index.accounts, sel);
      if (!target) {
        console.error(c.red(`no grok account matches "${sel}"`));
        for (const account of index.accounts) console.error(c.dim(`  ${account.label} (${account.accountId.slice(0, 8)})`));
        return 1;
      }
      if (target.accountId === currentId) {
        console.log(`already on ${c.bold(target.label)}`);
        return 0;
      }
      if (target.needsReauth) {
        console.error(c.red(`${target.label} needs re-auth - re-add it with \`tokenmaxxing add --grok\``));
        return 1;
      }
      await performGrokSwap({ target });
      console.log(`${c.green("✓")} switched grok to ${c.bold(target.label)} (running sessions pick it up on their next API call)`);
      return 0;
    }

    const active = index.accounts.find((account) => account.accountId === currentId) ?? null;
    if (grokCurrentWins({ active, accounts: index.accounts, thresholds: bars, now })) {
      console.log(`already on the best grok account: ${c.bold(active?.label ?? "?")}`);
      return 0;
    }
    const best = pickBestGrok({ accounts: index.accounts, thresholds: bars, now, currentAccountId: currentId });
    if (!best) {
      console.log(c.yellow("no usable grok switch target (all at the weekly bar, unmeasured, or needing reauth)"));
      return 1;
    }
    await performGrokSwap({ target: best });
    console.log(`${c.green("✓")} switched grok to ${c.bold(best.label)} (running sessions pick it up on their next API call)`);
    return 0;
  });
}
