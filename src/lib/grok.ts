import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { grokSupervisorLink, installGrokSupervisor } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { grokAuthJsonFor, grokPaths, grokPool, grokSeatFromEnv, grokStoreDirFor, paths } from "./paths.ts";
import { isExhausted, pickBest, pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { seatCounts } from "./presence.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, pinBinOverride, saveAccounts, type Harvest } from "./state.ts";
import { fetchGrokUsage, GrokAuthRejectedError, GrokUsageReadError, isGrokAccessExpiring } from "./grokusage.ts";
import { ErrnoSchema, GrokIssuerSchema, JsonTextSchema, type Account, type Config, type GrokIssuer } from "./types.ts";
import { c } from "../cli/render.ts";

class StoreUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnusableError";
  }
}

class GrokDeadGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokDeadGrantError";
  }
}

export function parseGrokAuthFile(path: string): { key: string; issuer: GrokIssuer }[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return [];
    throw e;
  }
  const map = z.record(z.string(), z.unknown()).safeParse(JsonTextSchema.safeParse(raw).data);
  if (!map.success) return [];
  const out: { key: string; issuer: GrokIssuer }[] = [];
  for (const [key, value] of Object.entries(map.data)) {
    const parsed = GrokIssuerSchema.safeParse(value);
    if (parsed.success) out.push({ key, issuer: parsed.data });
  }
  return out;
}

export function poolableIssuer(entries: { key: string; issuer: GrokIssuer }[]): { key: string; issuer: GrokIssuer } | null {
  if (entries.length === 0) return null;
  return entries.find((e) => e.issuer.principal_type === "User") ?? entries[0]!;
}

export function readGrokStoreIssuer(accountId: string): GrokIssuer | null {
  const entries = parseGrokAuthFile(grokAuthJsonFor(accountId));
  return entries.find((e) => e.issuer.user_id === accountId)?.issuer ?? poolableIssuer(entries)?.issuer ?? null;
}

export function resolveRealGrok(): string {
  const cfg = loadConfig();
  if (cfg.grokBin) {
    if (!existsSync(cfg.grokBin)) throw new Error(`configured grokBin does not exist: ${cfg.grokBin} - fix config.json`);
    return cfg.grokBin;
  }
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d || d === paths.binDir) continue;
    const cand = join(d, "grok");
    try {
      if (existsSync(cand)) return cand;
    } catch {
      continue;
    }
  }
  throw new Error("could not locate the real `grok` binary (set grokBin in config.json)");
}

export function ensureGrokStoreHome(accountId: string): string {
  const store = grokStoreDirFor(accountId);
  mkdirSync(store, { recursive: true });
  let names: string[] = [];
  try {
    names = readdirSync(grokPaths.home);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return store;
    throw e;
  }
  for (const name of names) {
    if (name === "auth.json" || name === "auth.json.lock") continue;
    const link = join(store, name);
    if (existsSync(link)) continue;
    try {
      if (lstatSync(link).isSymbolicLink()) continue;
    } catch {}
    try {
      symlinkSync(join(grokPaths.home, name), link);
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "EEXIST") throw e;
    }
  }
  return store;
}

function liveId(): string | null {
  return grokSeatFromEnv(loadAccounts(grokPool).accounts.map((a) => a.id));
}

function presence(): Map<string, number> {
  return seatCounts(grokPaths.presenceDir);
}

type GrokReadOutcome = { ok: true; windows: Observation["windows"]; at: number } | { ok: false; reason: string; deadGrant: boolean };

export async function readGrokUsage(account: Account, now: number): Promise<GrokReadOutcome> {
  let issuer: GrokIssuer | null;
  try {
    issuer = readGrokStoreIssuer(account.id);
  } catch (e) {
    return { ok: false, reason: `store credential unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`, deadGrant: false };
  }
  if (!issuer) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth --grok`", deadGrant: false };
  const running = seatCounts(grokPaths.presenceDir).has(account.id);
  const expiring = isGrokAccessExpiring({ issuer, now });
  if (expiring && !running) return { ok: false, reason: "store access token expired (grok refreshes it on the next session)", deadGrant: false };
  try {
    const at = Date.now();
    return { ok: true, windows: await fetchGrokUsage({ issuer, at }), at };
  } catch (e) {
    if (e instanceof GrokAuthRejectedError) return { ok: false, reason: e.message, deadGrant: !running && !expiring };
    if (e instanceof GrokUsageReadError) return { ok: false, reason: e.message, deadGrant: false };
    throw e;
  }
}

function recordOutcome(idx: { accounts: Account[] }, accountId: string, outcome: GrokReadOutcome): void {
  const a = idx.accounts.find((x) => x.id === accountId);
  if (!a) return;
  if (outcome.ok) {
    if (a.lastUsageAt == null || outcome.at > a.lastUsageAt) {
      a.windows = outcome.windows;
      a.lastUsageAt = outcome.at;
    }
  } else if (outcome.deadGrant) {
    a.needsReauth = true;
  }
}

export async function sampleGrokSeat(account: Account, now: number): Promise<Observation | null> {
  const outcome = await readGrokUsage(account, now);
  await withLock(grokPool.lockFile, () => {
    const idx = loadAccounts(grokPool);
    recordOutcome(idx, account.id, outcome);
    saveAccounts(grokPool, idx);
  });
  if (!outcome.ok) log("grok.sample_miss", { account: account.id.slice(0, 8), reason: outcome.reason.slice(0, 120) });
  const current = loadAccounts(grokPool).accounts.find((a) => a.id === account.id) ?? account;
  return current.lastUsageAt != null ? { windows: current.windows, at: current.lastUsageAt } : null;
}

async function observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    return sampleGrokSeat(account, now);
  }
  const current = loadAccounts(grokPool).accounts.find((a) => a.id === account.id) ?? account;
  return current.lastUsageAt != null ? { windows: current.windows, at: current.lastUsageAt } : null;
}

async function samplePool(accounts: Account[], _liveId: string | null, now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const outcome = await readGrokUsage(account, now);
      recordOutcome({ accounts }, account.id, outcome);
      reports.set(account.id, outcome.ok ? { ok: true, source: "probe" } : { ok: false, reason: outcome.reason });
    }),
  );
  return reports;
}

async function prepareMove(target: Account): Promise<void> {
  let issuer: GrokIssuer | null;
  try {
    issuer = readGrokStoreIssuer(target.id);
  } catch (e) {
    throw new StoreUnusableError(`${target.label}'s store is unreadable (${e instanceof Error ? e.message : String(e)}) - re-auth with \`tokenmaxxing auth --grok ${target.label}\``);
  }
  if (!issuer) throw new StoreUnusableError(`${target.label} has no credential in its store - re-auth with \`tokenmaxxing auth --grok ${target.label}\``);
  if (issuer.refresh_token === "") {
    const idx = loadAccounts(grokPool);
    const t = idx.accounts.find((a) => a.id === target.id);
    if (t) {
      t.needsReauth = true;
      saveAccounts(grokPool, idx);
    }
    throw new GrokDeadGrantError(`${target.label}'s store holds no refresh token - re-auth with \`tokenmaxxing auth --grok ${target.label}\``);
  }
  log("move.prepared", { account: target.id.slice(0, 8), label: target.label });
}

async function storeUsable(a: Account): Promise<boolean> {
  try {
    const issuer = readGrokStoreIssuer(a.id);
    return issuer != null && issuer.refresh_token !== "";
  } catch {
    return false;
  }
}

async function removeCredentials(a: Account): Promise<void> {
  rmSync(grokStoreDirFor(a.id), { recursive: true, force: true });
}

function harvestOf(key: string, issuer: GrokIssuer): Harvest {
  const id = issuer.user_id;
  return {
    id,
    email: issuer.email ?? null,
    tier: null,
    sample: null,
    park: async () => {
      mkdirSync(grokStoreDirFor(id), { recursive: true });
      writeFileAtomic(grokAuthJsonFor(id), JSON.stringify({ [key]: issuer }, null, 2), 0o600);
    },
  };
}

async function login(): Promise<Harvest | null> {
  const real = resolveRealGrok();
  const onboardDir = grokPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const p = Bun.spawn([real, "login"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...scrubGrokAuthEnv(process.env), GROK_HOME: onboardDir, TOKENMAXXING_PROBE: "1" },
  });
  await p.exited;
  try {
    const entry = poolableIssuer(parseGrokAuthFile(join(onboardDir, "auth.json")));
    if (p.exitCode !== 0 || !entry) {
      console.error(c.red("no grok login landed in the isolated home - nothing added."));
      return null;
    }
    return harvestOf(entry.key, entry.issuer);
  } finally {
    rmSync(onboardDir, { recursive: true, force: true });
  }
}

async function importLive(): Promise<Harvest | null> {
  const live = poolableIssuer(parseGrokAuthFile(join(grokPaths.home, "auth.json")));
  if (live) {
    console.log(c.dim(`found a grok login in ${grokPaths.home} - pooling it; use \`tokenmaxxing add --grok\` for the rest.`));
    return harvestOf(live.key, live.issuer);
  }
  console.log(c.cyan("Opening an isolated grok login for your first pooled account."));
  console.log();
  return login();
}

function preflight(): void {
  const real = resolveRealGrok();
  const p = Bun.spawnSync([real, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 15_000, env: { ...process.env, TOKENMAXXING_PROBE: "1" } });
  const out = (p.stdout?.toString() ?? "").trim().toLowerCase();
  if (p.exitCode !== 0 || !out.includes("grok")) throw new Error(`grok binary failed verification: ${real}`);
  pinBinOverride({ key: "grokBin", bin: real });
}

function install(): void {
  installGrokSupervisor();
  console.log(`${c.green("✓")} grok supervisor installed at ${grokSupervisorLink()}`);
  console.log(`${c.green("✓")} Stop + StopFailure hooks declared in ${grokPaths.hooksJson} (grok trusts its global hooks dir)`);
}

export function scrubGrokAuthEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const scrubbed = { ...env };
  delete scrubbed.XAI_API_KEY;
  delete scrubbed.GROK_AUTH_PROVIDER_COMMAND;
  return scrubbed;
}

export function grokPickCtx(now: number, currentId: string | null): PickCtx {
  return { now, thresholds: thresholdBars(loadConfig()), currentId, families: null, seats: presence() };
}

export function pickGrokSeat(now: number, wantedId: string | null = null): Account | null {
  const idx = loadAccounts(grokPool);
  const ctx = grokPickCtx(now, null);
  if (wantedId != null) {
    const wanted = idx.accounts.find((a) => a.id === wantedId && a.needsReauth !== true && !isExhausted(a, { ...ctx, currentId: wantedId }));
    if (wanted) return wanted;
  }
  return pickBest(idx.accounts, ctx) ?? pickEarliestReset(idx.accounts, ctx)?.account ?? null;
}

export const GROK_CONTINUATION_PROMPT = "continue";

const GROK_VALUE_TAKING_ROOT_FLAGS = new Set([
  "--agent", "--agents", "--allow", "--allowedTools", "--cwd", "--debug-file",
  "--deny", "--disallowedTools", "--disallowed-tools", "--json-schema",
  "--leader-socket", "-m", "--model", "--max-turns", "--output-format",
  "-p", "--single", "--permission-mode", "--prompt-file", "--prompt-json",
  "--reasoning-effort", "--effort", "--rules", "-s", "--session-id",
  "--sandbox", "--system-prompt-override", "--system-prompt", "--tools",
  "--worktree-ref", "--ref",
]);

export function grokValueTakingRootFlags(): Set<string> {
  return GROK_VALUE_TAKING_ROOT_FLAGS;
}

export function grokRespawnArgs(input: { argv: string[]; sessionId: string | null }): string[] {
  const out: string[] = [];
  const { argv } = input;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-r" || a === "--resume") {
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--resume=")) continue;
    if (a === "-s" || a === "--session-id") {
      i++;
      continue;
    }
    if (a === "-c" || a === "--continue" || a === "--fork-session") continue;
    if (a === "-p" || a === "--single") {
      out.push(a, GROK_CONTINUATION_PROMPT);
      i++;
      continue;
    }
    if (GROK_VALUE_TAKING_ROOT_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < argv.length) out.push(argv[++i]!);
      continue;
    }
    if (!a.startsWith("-")) continue;
    out.push(a);
  }
  out.push("--resume");
  if (input.sessionId != null) out.push(input.sessionId);
  return out;
}

export const grok: Provider = {
  name: "grok",
  flag: " --grok",
  pool: grokPool,
  seats: "shared",
  waitsWhenDepleted: true,
  statusOnly: false,
  liveId,
  presence,
  gatedFamilies: () => null,
  observeLive,
  samplePool,
  mergeWindows: (next) => next,
  swap: prepareMove,
  classifySwapError: (e) => (e instanceof GrokDeadGrantError ? "dead-grant" : e instanceof StoreUnusableError ? "skip" : "fatal"),
  removeCredentials,
  storeUsable,
  login,
  importLive,
  preflight,
  install,
  loginStep: () => `Sign in in the browser session that opens (or run ${c.bold("grok login --device-auth")} on headless hosts first).`,
  windowLabel: (name) => name.toLowerCase(),
};
