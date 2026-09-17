import { claude } from "../lib/claude.ts";
import { codex } from "../lib/codex.ts";
import { grok } from "../lib/grok.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { withLock } from "../lib/lock.ts";
import type { Provider } from "../lib/provider.ts";
import { sampleOldest } from "../lib/sample.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { loadConfig } from "../lib/state.ts";
import { maybeAutoUpdate } from "../lib/update.ts";
import { log } from "../lib/log.ts";
import { c, emitError, emitJson, fmtReset } from "./render.ts";

const POOL_SAMPLE_BATCH = 3;

async function sampleIdlePool(p: Provider, now: number, ttlMs: number): Promise<void> {
  const present = p.presence();
  const stale = loadAccounts(p.pool)
    .accounts.filter((a) => a.needsReauth !== true && !present.has(a.id) && (a.lastUsageAt == null || now - a.lastUsageAt > ttlMs))
    .sort((a, b) => (a.lastUsageAt ?? 0) - (b.lastUsageAt ?? 0))
    .slice(0, POOL_SAMPLE_BATCH);
  if (stale.length === 0) return;
  const reports = await p.samplePool(stale, null, now);
  await withLock(p.pool.lockFile, () => {
    const idx = loadAccounts(p.pool);
    for (const sampled of stale) {
      const stored = idx.accounts.find((a) => a.id === sampled.id);
      if (!stored) continue;
      if (sampled.lastUsageAt != null && (stored.lastUsageAt == null || sampled.lastUsageAt > stored.lastUsageAt)) {
        stored.windows = sampled.windows;
        stored.lastUsageAt = sampled.lastUsageAt;
      }
      if (sampled.needsReauth) stored.needsReauth = true;
      const report = reports.get(sampled.id);
      log(report?.ok ? "sample.ok" : "sample.failed", { pool: p.name, account: sampled.id.slice(0, 8), ...(report && !report.ok ? { reason: report.reason.slice(0, 200) } : {}) });
    }
    saveAccounts(p.pool, idx);
  });
}

export async function cmdCheck(json = false): Promise<number> {
  const now = Date.now();
  let d;
  try {
    d = await evaluateAndMaybeSwap(claude, now);
    const cfg = loadConfig();
    await sampleOldest(cfg);
    for (const p of [codex, grok]) {
      try {
        await sampleIdlePool(p, now, cfg.policy.usagePollTtlMs);
      } catch (e) {
        log("check.pool_sample_error", { pool: p.name, err: e instanceof Error ? e.message : String(e) });
      }
    }
    await maybeAutoUpdate();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log("check.error", { err: detail });
    emitError({ json, message: `check failed: ${detail}` });
    return 1;
  }
  if (json) {
    emitJson({
      ok: true,
      swapped: d.swapped,
      account: d.account?.label ?? null,
      reason: d.reason,
      waitUntil: d.waitUntil ?? null,
    });
    return 0;
  }
  if (d.swapped && d.account) {
    console.log(`${c.green("↻")} switched to ${c.bold(d.account.label)}`);
  } else if (d.waitUntil !== undefined && d.account) {
    console.log(c.yellow(`all accounts at limit - staying on ${c.bold(d.account.label)} (${fmtReset(d.waitUntil)})`));
  } else {
    console.log(c.dim(`no switch (${d.reason})`));
  }
  return 0;
}
