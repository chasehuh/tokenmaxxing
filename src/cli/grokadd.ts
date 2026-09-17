// `tokenmaxxing add --grok` - register an ADDITIONAL grok account. Runs
// `grok login` inside a throwaway GROK_HOME so the primary login is never
// touched, then parks the resulting auth.json (the whole lossless map) under
// the token's OWN identity and indexes it. The browser OAuth flow is the
// default on a TTY (it binds localhost, which is fine at the desk); the
// device-code flow takes over when no TTY is attached (ssh/CI), mirroring
// grok's own guidance for headless environments.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "../lib/claudebin.ts";
import { resolveRealGrok } from "../lib/grokbin.ts";
import { grokIdentityOf, poolableGrokIssuer, readGrokAuthAt, writeParkedGrokAuth } from "../lib/grokauth.ts";
import { GrokAuthRejectedError, GrokUsageReadError, fetchGrokUsage } from "../lib/grokusage.ts";
import { loadGrokAccounts, saveGrokAccounts } from "../lib/grokstate.ts";
import { presentGrokAccountIds } from "../lib/grokpresence.ts";
import { liveGrokAccountId } from "../lib/groksample.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { withLock } from "../lib/lock.ts";
import { grokCredItemFor, grokPaths } from "../lib/paths.ts";
import type { GrokAccount, GrokUsage } from "../lib/types.ts";
import { c, count } from "./render.ts";

export async function cmdGrokAdd(): Promise<number> {
  const real = resolveRealGrok();
  const onboardDir = grokPaths.onboardDir;
  // Deliberate hard delete (the codex onboard rationale): the onboard dir
  // holds a plaintext live credential after login, and a trashed copy would
  // keep that token readable. Its one durable output is parked separately.
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });

  console.log(c.cyan("Opening an isolated grok login - your primary login is untouched."));
  console.log(c.dim("Sign in with the account to add; the command exits once you're in."));
  console.log();

  const loginFlag = process.stdin.isTTY ? "--oauth" : "--device-auth";
  const savedTermios = saveTermios();
  const p = Bun.spawn([real, "login", loginFlag], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      GROK_HOME: onboardDir,
      TOKENMAXXING_PROBE: "1",
      [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH),
    },
  });
  await p.exited;
  restoreTermios(savedTermios);

  // The finally guarantees the plaintext onboard home is destroyed on every
  // non-signal exit; an exception mid-registration must not strand it.
  let account: GrokAccount;
  let poolSize: number;
  try {
    const auth = readGrokAuthAt({ path: join(onboardDir, "auth.json") });
    const entry = auth ? poolableGrokIssuer({ auth }) : null;
    if (p.exitCode !== 0 || !auth || !entry) {
      console.error(c.red("no poolable grok OIDC login landed in the isolated home - nothing added."));
      return 1;
    }

    const identity = grokIdentityOf({ auth });
    // An account RUNNING in a supervised session refuses the re-add: its live
    // session owns the newest rotation, and parking this parallel login could
    // strand whichever session loses the next refresh. An idle existing
    // account UPSERTS instead (the codexadd pattern): re-add is the
    // advertised needs-reauth recovery, so it re-parks the fresh grant and
    // clears the flag rather than refusing.
    if (presentGrokAccountIds().has(identity.accountId)) {
      console.error(c.red(`${identity.email ?? identity.accountId.slice(0, 8)} is running in a live supervised grok session - close that session before re-adding it.`));
      return 1;
    }
    if (liveGrokAccountId() === identity.accountId) {
      console.error(c.red(`${identity.email ?? identity.accountId.slice(0, 8)} is the LIVE grok login - it is imported by \`tokenmaxxing init --grok\`, not add.`));
      return 1;
    }

    console.log(c.dim("sampling usage..."));
    let usage: GrokUsage | null = null;
    try {
      usage = await fetchGrokUsage({ issuer: entry.issuer });
    } catch (e) {
      if (!(e instanceof GrokUsageReadError || e instanceof GrokAuthRejectedError)) throw e;
      console.log(c.yellow("could not sample usage now - it will fill in on first use."));
    }

    const credFile = grokCredItemFor(identity.accountId);
    writeParkedGrokAuth({ credFile, auth });

    ({ account, poolSize } = await withLock(grokPaths.lockFile, () => {
      const index = loadGrokAccounts();
      const existing = index.accounts.find((entry) => entry.accountId === identity.accountId);
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
      saveGrokAccounts({ index });
      return { account: fresh, poolSize: index.accounts.length };
    }));
  } finally {
    rmSync(onboardDir, { recursive: true, force: true });
  }

  console.log();
  console.log(`${c.green("✓")} added grok account ${c.bold(account.label)} - grok pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
