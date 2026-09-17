// The grok account-switch sequence. Runs under tokenmaxxing's grok flock
// (held by the caller); the live-file critical section additionally holds
// grok's OWN auth.json.lock, the flock the running binary takes for its own
// refresh writes - so unlike codex, nothing can rotate the live file inside
// our harvest-install window.
//
//   resolve the live credential's owner from the blob itself (labels drift,
//     user_id cannot lie; an unknown live identity refuses the swap)
//   under auth.json.lock: re-read live at the last moment, harvest it
//     verbatim into its owner's parked file, install the target's whole
//     lossless parked map as the live auth.json
//   commit activeAccountId in the same critical section
//
// No token refresh happens here (issue #1): grok's OIDC refresh is the real
// binary's job - a running session hot-reloads the installed credential and
// refreshes it on the next API call; the next spawn does the same. An
// installed access token past its hours-scale TTL is therefore fine as long
// as the refresh token holds; a dead grant surfaces as needs-reauth at the
// next sample.

import { withLock } from "./lock.ts";
import { grokPaths } from "./paths.ts";
import { grokIdentityOf, readLiveGrokAuth, readParkedGrokAuth, writeLiveGrokAuth, writeParkedGrokAuth } from "./grokauth.ts";
import { loadGrokAccounts, saveGrokAccounts, saveGrokLastSwapAt } from "./grokstate.ts";
import { log } from "./log.ts";
import type { GrokAccount } from "./types.ts";

export async function performGrokSwap(input: { target: GrokAccount }): Promise<void> {
  const { target } = input;
  const index = loadGrokAccounts();

  const parked = readParkedGrokAuth({ credFile: target.credFile });
  if (!parked) throw new Error(`no parked grok credential for ${target.label}`);

  const live = readLiveGrokAuth();
  let liveOwner: GrokAccount | null = null;
  if (live) {
    const liveIdentity = grokIdentityOf({ auth: live });
    // Backstop against a drifted caller: installing the LIVE account over
    // itself would clobber the newest rotation with a possibly-stale parked
    // copy out from under every running session.
    if (liveIdentity.accountId === target.accountId) {
      throw new Error(`${target.label} is already the live grok credential - refusing to swap an account onto itself`);
    }
    liveOwner = index.accounts.find((account) => account.accountId === liveIdentity.accountId) ?? null;
    if (!liveOwner) {
      throw new Error(
        `live grok credential belongs to ${liveIdentity.email ?? liveIdentity.accountId.slice(0, 8)}, which is not in the pool - refusing to swap over it; import it first with \`tokenmaxxing init --grok\``,
      );
    }
    if (liveOwner.accountId !== index.activeAccountId) {
      log("grokswap.harvest_drift", {
        labeled: index.activeAccountId?.slice(0, 8) ?? null,
        actual: liveOwner.accountId.slice(0, 8),
      });
    }
  }

  // The whole live-file mutation under grok's own flock: the running binary
  // takes this lock for its refresh writes, so holding it closes the window
  // where a rotation lands between our harvest read and the install.
  await withLock(grokPaths.authJsonLock, () => {
    if (live && liveOwner) {
      // Last-moment re-read INSIDE the lock: a rotation that landed before we
      // acquired it must be the snapshot we park, or the parked copy strands
      // a superseded refresh token. An identity that changed refuses rather
      // than harvesting under a stale owner.
      const liveNow = readLiveGrokAuth();
      if (!liveNow || grokIdentityOf({ auth: liveNow }).accountId !== liveOwner.accountId) {
        throw new Error("live grok credential changed mid-swap - refusing to harvest under a stale identity; retry");
      }
      writeParkedGrokAuth({ credFile: liveOwner.credFile, auth: liveNow });
      log("grokswap.harvest", { account: liveOwner.accountId.slice(0, 8) });
    }
    writeLiveGrokAuth({ auth: parked });
  });

  index.activeAccountId = target.accountId;
  saveGrokAccounts({ index });
  saveGrokLastSwapAt({ ts: Date.now() });
  log("grokswap.done", { account: target.accountId.slice(0, 8), label: target.label });
}
