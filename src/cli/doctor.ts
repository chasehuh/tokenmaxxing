// `tokenmaxxing doctor` - verify the supervisor + four settings entries survived
// and the pool is healthy.

import { existsSync, readFileSync } from "node:fs";
import { verifyRealClaude } from "../lib/claudebin.ts";
import { checkSettings, installedBin } from "../lib/settings.ts";
import { checkTimerHealthy, findClaudeShadowers, grokSupervisorLink, isBinDirAhead, shellRcPath, timerActivationHint } from "../lib/install.ts";
import { grokPaths, paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { loadGrokAccounts } from "../lib/grokstate.ts";
import { liveGrokAccountId } from "../lib/groksample.ts";
import { verifyRealGrok } from "../lib/grokbin.ts";
import { readParkedGrokAuth } from "../lib/grokauth.ts";
import { grokPathShadowers } from "./grokinit.ts";
import { readItem, liveTarget, parkedTarget } from "../lib/credstore.ts";
import { isAccessTokenExpiring, fetchTokenOrg } from "../lib/oauth.ts";
import { CredentialBlobSchema, type RolesResponse } from "../lib/types.ts";
import { c } from "./render.ts";

/** The org a stored blob's token truly belongs to; null = expired (unverifiable
 *  read-only - doctor never refreshes). Throws on unreadable blob / API failure. */
async function blobOrg(raw: string): Promise<RolesResponse | null> {
  const creds = CredentialBlobSchema.parse(JSON.parse(raw)).claudeAiOauth;
  if (isAccessTokenExpiring(creds)) return null;
  return fetchTokenOrg(creds.accessToken);
}

export async function cmdDoctor(): Promise<number> {
  let ok = true;
  const check = (cond: boolean, label: string, hint?: string) => {
    console.log(`${cond ? c.green("✓") : c.red("✗")} ${label}${!cond && hint ? c.dim(`  - ${hint}`) : ""}`);
    if (!cond) ok = false;
  };

  check(existsSync(paths.supervisorLink), "claude supervisor wrapper present", "run `tokenmaxxing init`");
  check(existsSync(installedBin()), "tokenmaxxing binary installed", "run `tokenmaxxing init`");
  check(isBinDirAhead(), `${paths.binDir} is ahead of the real claude on PATH`, `export PATH="${paths.binDir}:$PATH"`);

  const s = checkSettings();
  check(s.statusLineOk, "statusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.subagentStatusLineOk, "subagentStatusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.stopOk, "Stop hook installed in settings.json", "run `tokenmaxxing init`");
  check(s.sessionStartOk, "SessionStart hook installed in settings.json", "run `tokenmaxxing init`");
  check(checkTimerHealthy(), "periodic check timer active", timerActivationHint());

  const idx = loadAccounts();
  check(idx.accounts.length > 0, "at least one account in the pool", "run `tokenmaxxing init`");
  check(!!idx.activeAccountUuid, "an active account is set");

  const live = await readItem(liveTarget());
  check(!!live, "live credential readable");

  // Identity agreement: a stored credential must belong to the account it is
  // filed under - a mislabeled blob once made every consumer of a backup
  // (sampling, swap) silently act on another account.
  const active = idx.accounts.find((a) => a.accountUuid === idx.activeAccountUuid);
  if (live && active) {
    try {
      const org = await blobOrg(live);
      if (org) check(org.organization_uuid === active.organizationUuid, `live credential identity matches active (${active.email})`, `token belongs to ${org.organization_name} - run \`tokenmaxxing switch\``);
      else console.log(c.dim(`  - live credential identity unverifiable (access token expired)`));
    } catch (e) {
      check(false, `live credential identity matches active (${active.email})`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
    }
  }

  for (const a of idx.accounts) {
    const parked = await readItem(parkedTarget(a.keychainItem));
    check(!!parked, `parked credential present for ${a.email}`, `run \`tokenmaxxing auth ${a.label}\``);
    if (parked) {
      try {
        const org = await blobOrg(parked);
        if (org) check(org.organization_uuid === a.organizationUuid, `parked credential identity matches ${a.email}`, `token belongs to ${org.organization_name} - run \`tokenmaxxing auth ${a.label}\``);
        else console.log(c.dim(`  - ${a.email} identity unverifiable (access token expired)`));
      } catch (e) {
        check(false, `parked credential identity matches ${a.email}`, (e instanceof Error ? e.message : String(e)).slice(0, 100));
      }
    }
    if (a.needsReauth) check(false, `${a.email} needs re-auth`, `run \`tokenmaxxing auth ${a.label}\` to re-login`);
  }

  const cfg = loadConfig();
  check(!!cfg.claudeBin && existsSync(cfg.claudeBin), "real claude binary resolved", "set claudeBin in config.json");
  if (cfg.claudeBin && existsSync(cfg.claudeBin)) {
    // Behavioral: the pin must answer --version without re-entering the wrapper.
    // Catches a poisoned pin (a shim that resolves `claude` back to us) that
    // existence checks cannot - the 2026-07-12 recursive-spawn incident.
    const fail = verifyRealClaude(cfg.claudeBin);
    check(fail === null, "claudeBin launches the real claude", fail ?? undefined);
  }

  // Grok checks only when the grok pool or its shim exists: a claude-only
  // install must stay green with zero new findings (issue #1).
  const grokIdx = loadGrokAccounts();
  if (grokIdx.accounts.length > 0 || existsSync(grokSupervisorLink())) {
    console.log();
    console.log(c.dim("grok"));
    check(existsSync(grokSupervisorLink()), "grok supervisor wrapper present", "run `tokenmaxxing init --grok`");
    check(!!cfg.grokBin && existsSync(cfg.grokBin), "real grok binary resolved", "set grokBin in config.json (or re-run `tokenmaxxing init --grok`)");
    if (cfg.grokBin && existsSync(cfg.grokBin)) {
      // Behavioral: the pin must answer --version without re-entering the
      // wrapper - the same poisoned-pin class as the claudeBin incident.
      const fail = verifyRealGrok({ bin: cfg.grokBin });
      check(fail === null, "grokBin launches the real grok", fail ?? undefined);
    }
    const hookOk = existsSync(grokPaths.hooksJson) && readFileSync(grokPaths.hooksJson, "utf8").includes("__grok-stop-hook");
    check(hookOk, `grok hook file declares the Stop hook (${grokPaths.hooksJson})`, "run `tokenmaxxing init --grok`");
    // PATH resolution is load-bearing and commonly hostile here: the grok
    // installer's ~/.grok/bin and a ~/.local/bin/grok symlink both shadow
    // tokenmaxxing/bin on real machines, silently bypassing the supervisor.
    for (const shadow of grokPathShadowers()) {
      check(false, `\`grok\` resolves to the supervisor on PATH`, `${shadow} wins resolution - retarget it (ln -sf ${grokSupervisorLink()} <link>) or reorder PATH`);
    }
    if (grokIdx.accounts.length > 0) {
      check(!!grokIdx.activeAccountId, "an active grok account is set");
      // Offline identity agreement: the live blob's own user_id vs the label.
      // liveGrokAccountId throws on an unreadable blob (fail loud, like every
      // grok loader); null just means no login is installed right now.
      const liveId = liveGrokAccountId();
      check(liveId != null, "live grok credential readable", "run `grok login` or `tokenmaxxing switch --grok`");
      if (liveId != null && grokIdx.activeAccountId != null) {
        check(liveId === grokIdx.activeAccountId, "live grok credential identity matches the active label", "run `tokenmaxxing switch --grok` to realign");
      }
      for (const account of grokIdx.accounts) {
        check(readParkedGrokAuth({ credFile: account.credFile }) != null, `parked grok credential present for ${account.label}`, "re-add it with `tokenmaxxing add --grok`");
        if (account.needsReauth) check(false, `${account.label} needs re-auth`, "re-add it with `tokenmaxxing add --grok`");
      }
    }
  }

  // Warnings only: an interactive alias/function can shadow or bypass the
  // wrapper in ways PATH checks cannot see (`alias claude=...`, or a `cc`-style
  // alias hardcoding an absolute path to the real binary).
  const rc = shellRcPath();
  if (rc && existsSync(rc)) {
    for (const s of findClaudeShadowers(readFileSync(rc, "utf8"))) {
      if (s.kind === "shadow") console.log(c.yellow(`⚠ ${rc}: \`${s.line}\` shadows the supervised claude wrapper - launches through it skip tokenmaxxing`));
      else console.log(c.yellow(`⚠ ${rc}: alias \`${s.name}\` hardcodes a claude path and bypasses the supervisor - use plain \`claude\` in its body instead`));
    }
  }

  console.log();
  console.log(ok ? c.green("all good ✓") : c.yellow("issues found - see above"));
  return ok ? 0 : 1;
}
