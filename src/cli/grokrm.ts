// `tokenmaxxing rm --grok <selector>` - remove a pooled grok account (not
// the live one, and never one running in a live session).

import { withLock } from "../lib/lock.ts";
import { grokPaths } from "../lib/paths.ts";
import { loadGrokAccounts, saveGrokAccounts } from "../lib/grokstate.ts";
import { deleteParkedGrokAuth } from "../lib/grokauth.ts";
import { liveGrokAccountId } from "../lib/groksample.ts";
import { presentGrokAccountIds } from "../lib/grokpresence.ts";
import { findGrokAccount } from "./rename.ts";
import { c } from "./render.ts";

export async function cmdGrokRm(selector?: string): Promise<number> {
  if (!selector) {
    console.error("usage: tokenmaxxing rm --grok <email|label|id>");
    return 2;
  }
  // under the grok flock: a concurrent swap's index write must not be clobbered.
  return withLock(grokPaths.lockFile, async () => {
    const index = loadGrokAccounts();
    const account = findGrokAccount(index.accounts, selector);
    if (!account) {
      console.error(c.red(`no grok account matches "${selector}"`));
      return 1;
    }
    // The live identity is decoded from auth.json itself, offline ground
    // truth - labels drift, the blob cannot lie. An unreadable live blob
    // THROWS out of liveGrokAccountId, failing this destructive command
    // loudly rather than trusting a label.
    if (liveGrokAccountId() === account.accountId) {
      console.error(c.red(`${account.label} is the LIVE grok account - run \`tokenmaxxing switch --grok\` to move off it first.`));
      return 1;
    }
    if (presentGrokAccountIds().has(account.accountId)) {
      console.error(c.red(`${account.label} is running in a live grok session - close that session before removing it.`));
      return 1;
    }
    // Parked grok blobs are plain 0600 files; hard delete on purpose (the
    // credential-dir cleanup exception - trashing would move a credential
    // into the Trash folder).
    deleteParkedGrokAuth({ credFile: account.credFile });
    index.accounts = index.accounts.filter((x) => x.accountId !== account.accountId);
    saveGrokAccounts({ index });
    console.log(`removed grok account ${c.bold(account.label)} from the pool (${index.accounts.length} left)`);
    return 0;
  });
}
