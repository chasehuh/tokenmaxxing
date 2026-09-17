// `tokenmaxxing rename [--codex|--grok] <selector> <new-label>` - relabel a
// pooled account. The pools are separate namespaces and one email can hold
// accounts in all three, so the codex/grok pools are targeted explicitly via
// their flag (mirroring `switch`), never by searching across pools.

import { withLock } from "../lib/lock.ts";
import { codexPaths, grokPaths, paths } from "../lib/paths.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { loadGrokAccounts, saveGrokAccounts } from "../lib/grokstate.ts";
import { c } from "./render.ts";
import type { Account, CodexAccount, GrokAccount } from "../lib/types.ts";

/** Resolve a claude account by email, label, or accountUuid prefix. */
export function findAccount(accounts: Account[], selector: string): Account | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.accountUuid.toLowerCase().startsWith(s))
  );
}

/** Resolve a codex account by email, label, or accountId prefix. */
export function findCodexAccount(accounts: CodexAccount[], selector: string): CodexAccount | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email?.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.accountId.toLowerCase().startsWith(s))
  );
}

/** Resolve a grok account by email, label, or accountId prefix. */
export function findGrokAccount(accounts: GrokAccount[], selector: string): GrokAccount | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email?.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.accountId.toLowerCase().startsWith(s))
  );
}

async function renameGrokAccount(input: { selector: string; newLabel: string }): Promise<number> {
  // under the grok flock: a concurrent grok swap's index write must not be clobbered.
  return withLock(grokPaths.lockFile, async () => {
    const index = loadGrokAccounts();
    const account = findGrokAccount(index.accounts, input.selector);
    if (!account) {
      console.error(c.red(`no grok account matches "${input.selector}"`));
      return 1;
    }
    // same label-uniqueness rule as the other pools: a duplicate would make
    // the other account unreachable by selector and misdirect `rm`.
    const taken = index.accounts.find((x) => x.accountId !== account.accountId && x.label.toLowerCase() === input.newLabel.toLowerCase());
    if (taken) {
      console.error(c.red(`label "${input.newLabel}" is already used by ${taken.accountId.slice(0, 8)} - labels must be unique within the pool`));
      return 1;
    }
    const old = account.label;
    account.label = input.newLabel;
    saveGrokAccounts({ index });
    console.log(`renamed grok account ${c.dim(old)} → ${c.bold(input.newLabel)}`);
    return 0;
  });
}

async function renameCodexAccount(input: { selector: string; newLabel: string }): Promise<number> {
  // under the codex flock: a concurrent codex swap's index write must not be clobbered.
  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    const account = findCodexAccount(index.accounts, input.selector);
    if (!account) {
      console.error(c.red(`no codex account matches "${input.selector}"`));
      return 1;
    }
    // labels resolve selectors first-match: a duplicate would make the other
    // account unreachable by label and misdirect destructive commands like
    // `rm` onto the wrong one (adversarial-review catch)
    // case-insensitive, matching how findCodexAccount resolves selectors (PR
    // #37 review catch: a casing-only duplicate slipped the === guard)
    const taken = index.accounts.find((x) => x.accountId !== account.accountId && x.label.toLowerCase() === input.newLabel.toLowerCase());
    if (taken) {
      console.error(c.red(`label "${input.newLabel}" is already used by ${taken.accountId.slice(0, 8)} - labels must be unique within the pool`));
      return 1;
    }
    const old = account.label;
    account.label = input.newLabel;
    saveCodexAccounts({ index });
    console.log(`renamed codex account ${c.dim(old)} → ${c.bold(input.newLabel)}`);
    return 0;
  });
}

export async function cmdRename(argv: string[]): Promise<number> {
  const codex = argv.includes("--codex");
  const grok = argv.includes("--grok");
  if (codex && grok) {
    console.error(c.red("--codex and --grok are mutually exclusive"));
    return 2;
  }
  const [selector, newLabel] = argv.filter((a) => a !== "--codex" && a !== "--grok");
  if (!selector || !newLabel) {
    console.error("usage: tokenmaxxing rename [--codex|--grok] <email|label|id> <new-label>");
    return 2;
  }
  if (grok) return renameGrokAccount({ selector, newLabel });
  if (codex) return renameCodexAccount({ selector, newLabel });
  // under the flock: a concurrent swap's index write must not be clobbered.
  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const a = findAccount(idx.accounts, selector);
    if (!a) {
      console.error(c.red(`no claude account matches "${selector}" (codex/grok accounts rename via --codex/--grok)`));
      return 1;
    }
    // labels resolve selectors first-match: a duplicate would make the other
    // account unreachable by label and misdirect destructive commands like
    // `rm` onto the wrong one (adversarial-review catch)
    // case-insensitive, matching how findAccount resolves selectors (PR #37
    // review catch: a casing-only duplicate slipped the === guard)
    const taken = idx.accounts.find((x) => x.accountUuid !== a.accountUuid && x.label.toLowerCase() === newLabel.toLowerCase());
    if (taken) {
      console.error(c.red(`label "${newLabel}" is already used by ${taken.email} - labels must be unique within the pool`));
      return 1;
    }
    const old = a.label;
    a.label = newLabel;
    saveAccounts(idx);
    console.log(`renamed ${c.dim(old)} → ${c.bold(newLabel)}`);
    return 0;
  });
}
