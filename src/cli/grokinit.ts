// `tokenmaxxing init --grok` - bring the grok side up: verify + pin the real
// grok binary (the newest downloads/ Mach-O, never PATH `grok` - the desk's
// ~/.grok/bin launcher gets clobbered by `grok update` and ~/.local/bin/grok
// shadows everything), import the existing live OIDC login as grok account #1,
// install the on-PATH grok supervisor shim and the always-trusted hook sibling
// file. No trust step exists: global ~/.grok/hooks/*.json runs as-is, so
// unlike codex there is nothing manual to tell the user to do.

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newestDownloadedGrok, scanPathForGrok, verifyRealGrok } from "../lib/grokbin.ts";
import { grokIdentityOf, poolableGrokIssuer, readLiveGrokAuth, writeParkedGrokAuth } from "../lib/grokauth.ts";
import { GrokAuthRejectedError, GrokUsageReadError, fetchGrokUsage } from "../lib/grokusage.ts";
import { loadGrokAccounts, saveGrokAccounts } from "../lib/grokstate.ts";
import { loadConfig, pinBinOverride } from "../lib/state.ts";
import { installGrokSupervisor, grokSupervisorLink, ensurePathInRc, managedShellRcSkipLines, shellRcPath } from "../lib/install.ts";
import { withLock } from "../lib/lock.ts";
import { presentGrokAccountIds } from "../lib/grokpresence.ts";
import { pointsBackAtUs } from "../lib/claudebin.ts";
import { grokCredItemFor, grokPaths, paths } from "../lib/paths.ts";
import type { GrokAccount, GrokUsage } from "../lib/types.ts";
import { c } from "./render.ts";

/** The pin candidate, in trust order: an existing config pin, the newest
 *  versioned binary under $GROK_HOME/downloads (survives `grok update`
 *  rewriting the ~/.grok/bin launcher), then the PATH scan. */
function resolveGrokForInit(): string | null {
  const cfg = loadConfig();
  if (cfg.grokBin) return cfg.grokBin;
  return newestDownloadedGrok() ?? scanPathForGrok();
}

/** PATH entries that resolve `grok` ahead of our shim (the desk reality:
 *  ~/.grok/bin and ~/.local/bin/grok both shadow tokenmaxxing/bin). */
export function grokPathShadowers(): string[] {
  const shadowers: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    if (dir === paths.binDir) break; // everything after us loses resolution
    const cand = join(dir, "grok");
    try {
      if (existsSync(cand) && statSync(cand).isFile() && !pointsBackAtUs(cand)) shadowers.push(cand);
    } catch {
      continue;
    }
  }
  return shadowers;
}

export async function cmdGrokInit(): Promise<number> {
  // Fail fast on a broken merged config before installing (see cmdInit).
  loadConfig();
  const real = resolveGrokForInit();
  if (real == null) {
    console.error(c.red(`could not locate a grok binary (no ${grokPaths.downloadsDir} download, none on PATH) - install grok first, or set grokBin in ${paths.configJson}`));
    return 1;
  }
  const fail = verifyRealGrok({ bin: real });
  if (fail !== null) {
    console.error(c.red(`grok binary failed verification: ${real}: ${fail}`));
    return 1;
  }
  // Sparse write: only the pin lands in the file, never the merged config.
  pinBinOverride({ key: "grokBin", bin: real });

  const live = readLiveGrokAuth();
  const entry = live ? poolableGrokIssuer({ auth: live }) : null;
  if (!live || !entry) {
    console.error(c.red(`no poolable grok OIDC login found at ${grokPaths.authJson} - run \`grok login\` (a SuperGrok session, not an API key), then re-run this.`));
    return 1;
  }
  const identity = grokIdentityOf({ auth: live });

  console.log(c.dim("sampling usage..."));
  let usage: GrokUsage | null = null;
  try {
    usage = await fetchGrokUsage({ issuer: entry.issuer });
  } catch (e) {
    if (!(e instanceof GrokUsageReadError || e instanceof GrokAuthRejectedError)) throw e;
    console.log(c.yellow("could not sample usage now - it will fill in on first use."));
  }

  const credFile = grokCredItemFor(identity.accountId);

  // A RUNNING supervised session on this account can rotate auth.json at any
  // moment - a snapshot parked around that would hold an already-superseded
  // refresh token. Refuse loudly (the codex init catch); the same check
  // re-runs INSIDE the critical section below.
  if (presentGrokAccountIds().has(identity.accountId)) {
    console.error(c.red("a live supervised grok session is running this account - its token rotates under us, so parking a snapshot now could poison the backup."));
    console.error(c.dim("close that grok session (or let it exit) and re-run `tokenmaxxing init --grok`."));
    return 1;
  }

  const account = await withLock(grokPaths.lockFile, async () => {
    if (presentGrokAccountIds().has(identity.accountId)) {
      throw new Error("a live supervised grok session started running this account mid-init - close it and re-run `tokenmaxxing init --grok`");
    }
    // Park from a blob RE-READ under grok's OWN auth.json.lock: the pre-lock
    // snapshot is seconds stale (a network usage GET sits in between), and
    // grok itself can rotate the live file at any moment - its flock is the
    // one serialization point that makes the parked snapshot the newest
    // rotation. An identity that changed since the pre-lock read means a
    // swap or manual login landed mid-init: abort rather than file the
    // wrong account.
    await withLock(grokPaths.authJsonLock, () => {
      const fresh2 = readLiveGrokAuth();
      if (!fresh2 || grokIdentityOf({ auth: fresh2 }).accountId !== identity.accountId) {
        throw new Error("the live grok login changed while init was running (a concurrent swap?) - re-run `tokenmaxxing init --grok`");
      }
      writeParkedGrokAuth({ credFile, auth: fresh2 });
    });
    const index = loadGrokAccounts();
    const existing = index.accounts.find((account) => account.accountId === identity.accountId);
    const fresh: GrokAccount = {
      accountId: identity.accountId,
      email: identity.email,
      label: existing?.label ?? identity.email ?? identity.accountId.slice(0, 8),
      planType: existing?.planType ?? null,
      credFile,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      needsReauth: false,
      lastUsage: usage ? { weekly: usage.weekly } : existing?.lastUsage,
      lastUsageAt: usage ? Date.now() : existing?.lastUsageAt,
    };
    if (existing) Object.assign(existing, fresh);
    else index.accounts.push(fresh);
    index.activeAccountId = identity.accountId;
    saveGrokAccounts({ index });
    return fresh;
  });

  installGrokSupervisor();
  const rc = shellRcPath();
  if (rc) {
    const pathOutcome = ensurePathInRc(rc);
    if (pathOutcome === "skipped") {
      const hint = managedShellRcSkipLines();
      console.log();
      console.log(c.yellow(`⚠ ${hint.headline}`));
      console.log(c.yellow(`  ${hint.detail}`));
      console.log(c.yellow(`  ${hint.exportLine}`));
    }
  }

  console.log();
  console.log(`${c.green("✓")} imported grok account ${c.bold(account.label)}`);
  console.log(`${c.green("✓")} grok supervisor installed at ${grokSupervisorLink()}`);
  console.log(`${c.green("✓")} Stop + StopFailure hooks installed at ${grokPaths.hooksJson} (global hooks are always trusted - no /hooks step)`);

  // PATH reality check: ~/.grok/bin (the installer) and ~/.local/bin/grok
  // commonly sit AHEAD of tokenmaxxing/bin, so `grok` would bypass the
  // supervisor entirely. Never overwrite ~/.grok/bin/grok (the next `grok
  // update` clobbers it back); a ~/.local/bin symlink is the user's to
  // retarget, so print the exact command instead of editing it.
  const shadowers = grokPathShadowers();
  if (shadowers.length > 0) {
    console.log();
    for (const shadow of shadowers) {
      console.log(c.yellow(`⚠ ${shadow} resolves ahead of the supervisor on PATH - \`grok\` launches bypass tokenmaxxing`));
    }
    const local = shadowers.find((shadow) => dirname(shadow).endsWith("/.local/bin"));
    if (local) console.log(c.yellow(`  retarget it: ln -sf ${grokSupervisorLink()} ${local}`));
    console.log(c.yellow(`  or put ${paths.binDir} ahead of ${shadowers.map((shadow) => dirname(shadow)).join(" and ")} in your shell rc`));
  }
  console.log();
  console.log(c.dim("add more accounts with `tokenmaxxing add --grok`."));
  return 0;
}
