import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { grokIdentityOf, isGrokAccessExpiring, poolableGrokIssuer, readGrokAuthAt, readLiveGrokAuth, readParkedGrokAuth, writeLiveGrokAuth, writeParkedGrokAuth } from "../src/lib/grokauth.ts";
import { GrokAuthRejectedError, GrokUsageReadError, fetchGrokUsage, mapGrokCredits } from "../src/lib/grokusage.ts";
import { GROK_SWAP_IMPROVEMENT, grokCurrentWins, grokPacePressure, isGrokEngaged, isGrokExhausted, pickBestGrok } from "../src/lib/grokpick.ts";
import { performGrokSwap } from "../src/lib/grokswap.ts";
import { evaluateAndMaybeSwapGrok } from "../src/lib/grokdecide.ts";
import { loadGrokAccounts, loadGrokLastSwapAt, saveGrokAccounts } from "../src/lib/grokstate.ts";
import { liveGrokAccountId, sampleGrokAccount } from "../src/lib/groksample.ts";
import { presentGrokAccountIds, writeGrokPresence } from "../src/lib/grokpresence.ts";
import { grokHookFileContent, grokSupervisorLink, installGrokSupervisor, uninstallGrokSupervisor } from "../src/lib/install.ts";
import { GROK_SUPERVISOR_ID_ENV, scrubGrokAuthEnv, shouldManageGrok } from "../src/entries/groksupervisor.ts";
import { handleGrokStop } from "../src/entries/grokstophook.ts";
import { grokCredItemFor, grokPaths } from "../src/lib/paths.ts";
import { GrokAccountSchema, type GrokAccount, type GrokAuthJson } from "../src/lib/types.ts";

// ---- fixtures ---------------------------------------------------------------

const ISSUER_KEY = "https://auth.x.ai::client-test";

function authBlob(id: string, input?: { expiresInMs?: number; authMode?: string }): GrokAuthJson {
  return {
    [ISSUER_KEY]: {
      auth_mode: input?.authMode ?? "oidc",
      key: `key-${id}`,
      refresh_token: `rt-${id}`,
      user_id: `user-${id}`,
      principal_id: `principal-${id}`,
      principal_type: "User",
      email: `${id}@example.com`,
      expires_at: new Date(Date.now() + (input?.expiresInMs ?? 3 * 3600_000)).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "client-test",
      create_time: "2026-08-01T00:00:00Z",
      first_name: `sibling-${id}`,
    },
  };
}

function account(id: string, input?: { used?: number; resetInMs?: number | null; needsReauth?: boolean; sampledAt?: number }): GrokAccount {
  return {
    accountId: `user-${id}`,
    email: `${id}@example.com`,
    label: id,
    planType: "SuperGrokPro",
    credFile: grokCredItemFor(`user-${id}`),
    addedAt: "2026-08-01T00:00:00.000Z",
    needsReauth: input?.needsReauth,
    lastUsage:
      input?.used != null
        ? { weekly: { usedPercentage: input.used, resetsAt: input.resetInMs === null ? null : Date.now() + (input.resetInMs ?? 24 * 3600_000) } }
        : undefined,
    lastUsageAt: input?.sampledAt ?? Date.now(),
  };
}

function seedPool(input: { accounts: GrokAccount[]; activeId: string | null }): void {
  saveGrokAccounts({ index: { version: 1, activeAccountId: input.activeId, accounts: input.accounts } });
}

// ---- mock billing endpoint (port pinned by test/setup.ts env) ----------------

let usedPercent: number | ((key: string) => number) = 10;
let lastRequest: { headers: Headers; url: URL } | null = null;
let periodEnd = () => new Date(Date.now() + 4 * 24 * 3600_000).toISOString();
let server: ReturnType<typeof Bun.serve>;

/** The legacy monthly body the REAL endpoint returns without ?format=credits:
 *  zeros that must never become a weekly bar. The mock mirrors that so a
 *  client that loses the query fails the same way the live one would. */
const MONTHLY_ZEROS = { subscription: { monthlyLimit: 0, used: 0 } };

beforeAll(() => {
  server = Bun.serve({
    port: Number(new URL(process.env.TOKENMAXXING_GROK_BILLING_URL!).port),
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/grok-billing") return new Response("not found", { status: 404 });
      lastRequest = { headers: req.headers, url };
      // The CLI's own header is required; another client's (e.g. codex-cli)
      // 401s on the live proxy - documented by the ablation in issue #1.
      if (req.headers.get("x-xai-token-auth") !== "xai-grok-cli") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      const bearer = req.headers.get("authorization") ?? "";
      if (bearer.includes("key-DEAD")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      if (url.searchParams.get("format") !== "credits") {
        return Response.json(MONTHLY_ZEROS);
      }
      const used = typeof usedPercent === "function" ? usedPercent(bearer) : usedPercent;
      return Response.json({
        config: {
          creditUsagePercent: used,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-22T10:21:04Z", end: periodEnd() },
        },
        productUsage: [{ product: "GrokBuild", usagePercent: used }],
        prepaidBalance: { val: 0 },
        isUnifiedBillingUser: true,
      });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  usedPercent = 10;
  lastRequest = null;
  periodEnd = () => new Date(Date.now() + 4 * 24 * 3600_000).toISOString();
  rmSync(grokPaths.home, { recursive: true, force: true });
  rmSync(grokPaths.credsDir, { recursive: true, force: true });
  rmSync(grokPaths.accountsJson, { force: true });
  rmSync(grokPaths.lastSwapJson, { force: true });
  rmSync(grokPaths.respawnDir, { recursive: true, force: true });
  rmSync(grokPaths.presenceDir, { recursive: true, force: true });
  rmSync(grokPaths.lockFile, { force: true });
  mkdirSync(grokPaths.home, { recursive: true });
});

// ---- grokauth ---------------------------------------------------------------

describe("grok identity + auth blobs", () => {
  test("identity comes from the issuer's user_id with email as label", () => {
    const identity = grokIdentityOf({ auth: authBlob("A") });
    expect(identity).toEqual({ accountId: "user-A", email: "A@example.com" });
  });

  test("an api-key-only auth.json has no poolable issuer; corrupt still throws", () => {
    // no key/refresh_token/user_id: not a session login, nothing to pool
    writeFileSync(grokPaths.authJson, JSON.stringify({ [ISSUER_KEY]: { auth_mode: "api_key" } }));
    expect(poolableGrokIssuer({ auth: readLiveGrokAuth()! })).toBeNull();
    expect(liveGrokAccountId()).toBeNull();
    writeFileSync(grokPaths.authJson, "{ not json");
    expect(() => readLiveGrokAuth()).toThrow();
  });

  test("parked round-trip preserves the whole map and unknown siblings verbatim", () => {
    const auth = authBlob("A");
    writeParkedGrokAuth({ credFile: "tokenmaxxing-grok-test", auth });
    const back = readParkedGrokAuth({ credFile: "tokenmaxxing-grok-test" });
    expect(back).toEqual(auth);
    const issuer = z.record(z.string(), z.looseObject({ first_name: z.string() })).parse(back)[ISSUER_KEY]!;
    expect(issuer.first_name).toBe("sibling-A");
  });

  test("access expiry honors the 300s margin and fails closed on garbage", () => {
    const fresh = poolableGrokIssuer({ auth: authBlob("A", { expiresInMs: 3600_000 }) })!.issuer;
    const dying = poolableGrokIssuer({ auth: authBlob("A", { expiresInMs: 60_000 }) })!.issuer;
    expect(isGrokAccessExpiring({ issuer: fresh })).toBe(false);
    expect(isGrokAccessExpiring({ issuer: dying })).toBe(true);
    expect(isGrokAccessExpiring({ issuer: { ...fresh, expires_at: "not a date" } })).toBe(true);
    expect(isGrokAccessExpiring({ issuer: { ...fresh, expires_at: undefined } })).toBe(true);
    // epoch seconds and ms both read by magnitude
    expect(isGrokAccessExpiring({ issuer: { ...fresh, expires_at: Math.floor(Date.now() / 1000) + 3600 } })).toBe(false);
    expect(isGrokAccessExpiring({ issuer: { ...fresh, expires_at: Date.now() + 3600_000 } })).toBe(false);
  });

  test("a credFile with a path separator is refused at parse time", () => {
    expect(() => GrokAccountSchema.parse({ ...account("A"), credFile: "../evil" })).toThrow(/bare file name/);
  });
});

// ---- grokusage --------------------------------------------------------------

describe("grok credits mapping", () => {
  test("maps the live credits shape: used% + weekly period end", () => {
    const usage = mapGrokCredits({
      body: {
        config: { creditUsagePercent: 86, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-22T10:21:04Z", end: "2026-08-29T10:21:04Z" } },
        productUsage: [{ product: "GrokBuild", usagePercent: 86 }],
        prepaidBalance: { val: 0 },
        isUnifiedBillingUser: true,
      },
    });
    expect(usage.weekly.usedPercentage).toBe(86);
    expect(usage.weekly.resetsAt).toBe(Date.parse("2026-08-29T10:21:04Z"));
  });

  test("the GrokBuild product row is the fallback when config omits the percent", () => {
    const usage = mapGrokCredits({
      body: { config: { currentPeriod: { end: "2026-08-29T10:21:04Z" } }, productUsage: [{ product: "GrokBuild", usagePercent: 42 }] },
    });
    expect(usage.weekly.usedPercentage).toBe(42);
  });

  test("the legacy monthly-zeros body (format=credits lost) throws, never a 0% bar", () => {
    expect(() => mapGrokCredits({ body: MONTHLY_ZEROS })).toThrow(GrokUsageReadError);
    expect(() => mapGrokCredits({ body: null })).toThrow(GrokUsageReadError);
  });

  test("the GET always carries format=credits, the Bearer key, and the grok-cli auth header", async () => {
    const issuer = poolableGrokIssuer({ auth: authBlob("A") })!.issuer;
    const usage = await fetchGrokUsage({ issuer });
    expect(usage.weekly.usedPercentage).toBe(10);
    expect(lastRequest?.url.searchParams.get("format")).toBe("credits");
    expect(lastRequest?.headers.get("authorization")).toBe("Bearer key-A");
    expect(lastRequest?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
  });

  test("a 401 surfaces as GrokAuthRejectedError, other failures as read errors", async () => {
    const dead = poolableGrokIssuer({ auth: authBlob("DEAD") })!.issuer;
    await expect(fetchGrokUsage({ issuer: dead })).rejects.toBeInstanceOf(GrokAuthRejectedError);
  });
});

// ---- grokpick ---------------------------------------------------------------

describe("grok picking", () => {
  const bars = { session: 95, weekly: 98 };
  const now = () => Date.now();

  test("ranks by weekly pace pressure: most remaining before the soonest reset wins", () => {
    const behind = account("behind", { used: 5 });
    const ahead = account("ahead", { used: 80 });
    expect(grokPacePressure({ account: behind, now: now() })).toBeGreaterThan(grokPacePressure({ account: ahead, now: now() }));
    expect(pickBestGrok({ accounts: [ahead, behind], thresholds: bars, now: now(), currentAccountId: null })?.label).toBe("behind");
  });

  test("screens out accounts at/over the weekly bar until their reset passes", () => {
    const burnt = account("burnt", { used: 99, resetInMs: 3600_000 });
    const past = account("past", { used: 99, resetInMs: -60_000 });
    expect(isGrokExhausted({ account: burnt, thresholds: bars, now: now() })).toBe(true);
    expect(isGrokExhausted({ account: past, thresholds: bars, now: now() })).toBe(false);
    expect(pickBestGrok({ accounts: [burnt], thresholds: bars, now: now(), currentAccountId: null })).toBeNull();
  });

  test("unmeasured never looks safe: no sampled window ranks last, not first", () => {
    const unmeasured = account("unmeasured");
    const measured = account("measured", { used: 50 });
    expect(grokPacePressure({ account: unmeasured, now: now() })).toBe(0);
    expect(pickBestGrok({ accounts: [unmeasured, measured], thresholds: bars, now: now(), currentAccountId: null })?.label).toBe("measured");
  });

  test("currentWins keeps the seat within the churn margin, yields past it", () => {
    const cur = account("cur", { used: 40 });
    const marginal = account("marginal", { used: 35 });
    const better = account("better", { used: 5 });
    const curPressure = grokPacePressure({ account: cur, now: now() });
    expect(grokPacePressure({ account: marginal, now: now() })).toBeLessThanOrEqual(curPressure * GROK_SWAP_IMPROVEMENT);
    expect(grokCurrentWins({ active: cur, accounts: [cur, marginal], thresholds: bars, now: now() })).toBe(true);
    expect(grokPacePressure({ account: better, now: now() })).toBeGreaterThan(curPressure * GROK_SWAP_IMPROVEMENT);
    expect(grokCurrentWins({ active: cur, accounts: [cur, better], thresholds: bars, now: now() })).toBe(false);
    expect(grokCurrentWins({ active: better, accounts: [cur, better], thresholds: bars, now: now() })).toBe(true);
  });

  test("engagement floor reads against the weekly window", () => {
    expect(isGrokEngaged({ account: account("engaged", { used: 55 }), floor: 50, now: now() })).toBe(true);
    expect(isGrokEngaged({ account: account("fresh", { used: 10 }), floor: 50, now: now() })).toBe(false);
    expect(isGrokEngaged({ account: account("unmeasured"), floor: 50, now: now() })).toBe(false);
  });
});

// ---- presence ---------------------------------------------------------------

describe("grok presence", () => {
  test("a living supervisor's account is present; a dead pid is cleaned up", () => {
    writeGrokPresence({ supervisorId: "sup-1", accountId: "user-A" });
    expect(presentGrokAccountIds().has("user-A")).toBe(true);
    mkdirSync(grokPaths.presenceDir, { recursive: true });
    writeFileSync(
      join(grokPaths.presenceDir, "sup-dead"),
      JSON.stringify({ accountId: "user-B", pid: 2_147_483_646, startedAt: "Wed Jan  1 00:00:00 2020" }),
    );
    const present = presentGrokAccountIds();
    expect(present.has("user-B")).toBe(false);
    expect(existsSync(join(grokPaths.presenceDir, "sup-dead"))).toBe(false);
  });

  test("a corrupt presence file fails the read loudly instead of dropping protection", () => {
    mkdirSync(grokPaths.presenceDir, { recursive: true });
    writeFileSync(join(grokPaths.presenceDir, "sup-corrupt"), "not json");
    expect(() => presentGrokAccountIds()).toThrow("refusing to treat it as absent");
  });
});

// ---- groksample -------------------------------------------------------------

describe("grok sampling", () => {
  test("live samples via the live blob, parked via the parked blob", async () => {
    const accountA = account("A");
    const accountB = account("B");
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    usedPercent = (bearer) => (bearer.includes("key-A") ? 60 : 5);
    const liveOutcome = await sampleGrokAccount({ account: accountA, liveAccountId: "user-A" });
    const parkedOutcome = await sampleGrokAccount({ account: accountB, liveAccountId: "user-A" });
    expect(liveOutcome).toEqual({ ok: true, usage: { weekly: { usedPercentage: 60, resetsAt: expect.any(Number) } } });
    expect(parkedOutcome).toEqual({ ok: true, usage: { weekly: { usedPercentage: 5, resetsAt: expect.any(Number) } } });
  });

  test("an expired parked access token is an honest miss, never probed and never a dead grant", async () => {
    const accountB = account("B");
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B", { expiresInMs: 60_000 }) });
    const outcome = await sampleGrokAccount({ account: accountB, liveAccountId: "user-A" });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("expired"), deadGrant: false });
    expect(lastRequest).toBeNull(); // the rotted token never hit the endpoint
  });

  test("a parked token inside its TTL being refused IS a dead grant; the live one is not", async () => {
    const accountDead = account("DEAD");
    writeParkedGrokAuth({ credFile: accountDead.credFile, auth: authBlob("DEAD") });
    const parked = await sampleGrokAccount({ account: accountDead, liveAccountId: null });
    expect(parked).toEqual({ ok: false, reason: expect.any(String), deadGrant: true });
    writeLiveGrokAuth({ auth: authBlob("DEAD") });
    const live = await sampleGrokAccount({ account: accountDead, liveAccountId: "user-DEAD" });
    expect(live).toEqual({ ok: false, reason: expect.any(String), deadGrant: false });
  });

  test("a parked blob whose account runs in a live session is never sampled", async () => {
    const accountB = account("B");
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    writeGrokPresence({ supervisorId: "sup-b", accountId: "user-B" });
    const outcome = await sampleGrokAccount({ account: accountB, liveAccountId: "user-A" });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("superseded"), deadGrant: false });
    expect(lastRequest).toBeNull();
  });
});

// ---- grokswap ---------------------------------------------------------------

describe("grok swap", () => {
  test("full sequence: harvest live under its own identity, install the whole parked map, commit active", async () => {
    const accountA = account("A");
    const accountB = account("B");
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    const liveA = authBlob("A");
    (liveA[ISSUER_KEY] as { key: string }).key = "key-A-rotated"; // the live copy rotated past the parked one
    writeLiveGrokAuth({ auth: liveA });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    await performGrokSwap({ target: accountB });

    expect(liveGrokAccountId()).toBe("user-B");
    // A's harvest is the LIVE blob verbatim (the rotated key), not its stale parked copy
    const harvested = z.record(z.string(), z.looseObject({ key: z.string() })).parse(readParkedGrokAuth({ credFile: accountA.credFile }));
    expect(harvested[ISSUER_KEY]!.key).toBe("key-A-rotated");
    expect(loadGrokAccounts().activeAccountId).toBe("user-B");
    expect(loadGrokLastSwapAt()).not.toBeNull();
  });

  test("refuses an unpooled live credential, leaving it untouched", async () => {
    const accountB = account("B");
    seedPool({ accounts: [accountB], activeId: null });
    writeLiveGrokAuth({ auth: authBlob("STRANGER") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    await expect(performGrokSwap({ target: accountB })).rejects.toThrow(/not in the pool/);
    expect(liveGrokAccountId()).toBe("user-STRANGER");
  });

  test("refuses to install the live account over itself", async () => {
    const accountA = account("A");
    seedPool({ accounts: [accountA], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    await expect(performGrokSwap({ target: accountA })).rejects.toThrow(/onto itself/);
  });
});

// ---- grokdecide -------------------------------------------------------------

describe("grok decide", () => {
  test("greedy swap onto the pace-better account once the active one is engaged", async () => {
    const accountA = account("A", { used: 60 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("user-B");
    expect(decision.waitUntil).toBeNull();
    expect(liveGrokAccountId()).toBe("user-B");
  });

  test("stays put when the engaged active account already wins", async () => {
    const accountA = account("A", { used: 60 });
    const accountB = account("B", { used: 90 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.reason).toBe("current-best");
  });

  test("disengaged below the floor: no swap even with a fresher sibling", async () => {
    const accountA = account("A", { used: 20 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.reason).toBe("under-threshold-or-stale");
  });

  test("hard path: a crossed weekly bar swaps even when greedy would keep the seat", async () => {
    const accountA = account("A", { used: 99 });
    const accountB = account("B", { used: 70 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("user-B");
  });

  test("an unpooled live credential is the org-guard analog: no evaluation, no swap", async () => {
    seedPool({ accounts: [account("A", { used: 60 })], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("STRANGER") });
    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.reason).toBe("live-credential-not-in-pool");
  });

  test("a stale snapshot re-samples the LIVE credential and stamps its true owner", async () => {
    const old = Date.now() - 10 * 60_000;
    const accountA = account("A", { used: 10, sampledAt: old });
    seedPool({ accounts: [accountA], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    usedPercent = 42;
    await evaluateAndMaybeSwapGrok({});
    const sampled = loadGrokAccounts().accounts.find((entry) => entry.accountId === "user-A");
    expect(sampled?.lastUsage?.weekly.usedPercentage).toBe(42);
    expect(sampled?.lastUsageAt).toBeGreaterThan(old);
  });

  test("depleted within maxWaitMs: pre-park on the soonest reset with a waitUntil", async () => {
    const accountA = account("A", { used: 99, resetInMs: 40 * 60_000 });
    const accountB = account("B", { used: 99, resetInMs: 20 * 60_000 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.reason).toBe("depleted-wait");
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("user-B");
    expect(decision.waitUntil).toBe(accountB.lastUsage!.weekly.resetsAt!);
    expect(liveGrokAccountId()).toBe("user-B");
  });

  test("depleted with the active seat recovering soonest: hold the seat, still hand back the wait", async () => {
    const accountA = account("A", { used: 99, resetInMs: 20 * 60_000 });
    const accountB = account("B", { used: 99, resetInMs: 40 * 60_000 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision.reason).toBe("depleted-wait");
    expect(decision.swapped).toBe(false);
    expect(decision.account?.accountId).toBe("user-A");
    expect(decision.waitUntil).toBe(accountA.lastUsage!.weekly.resetsAt!);
    expect(liveGrokAccountId()).toBe("user-A");
  });

  test("depleted past maxWaitMs: all-depleted, no swap and no wait", async () => {
    const accountA = account("A", { used: 99, resetInMs: 2 * 3600_000 });
    const accountB = account("B", { used: 99, resetInMs: 3 * 3600_000 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    const decision = await evaluateAndMaybeSwapGrok({});
    expect(decision).toEqual({ swapped: false, account: null, reason: "all-depleted", waitUntil: null });
  });

  test("force (rate_limit) engages under the floor and re-samples despite a fresh cache", async () => {
    const accountA = account("A", { used: 20 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    usedPercent = (bearer) => (bearer.includes("key-A") ? 20 : 5);

    const decision = await evaluateAndMaybeSwapGrok({ force: true });
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("user-B");
    expect(lastRequest).not.toBeNull(); // the refusal proved the cache wrong: re-sampled
  });

  test("force with a healthy seat and no target never falls into the depleted pre-park", async () => {
    // capacity errors (503/529) classify as rate_limit too; a transient blip
    // must not park a 20%-used seat until a weekly reset (soonest reset here
    // is well inside maxWaitMs, so the depleted path WOULD have taken it).
    const accountA = account("A", { used: 20, resetInMs: 30 * 60_000 });
    seedPool({ accounts: [accountA], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    usedPercent = 20;
    const decision = await evaluateAndMaybeSwapGrok({ force: true });
    expect(decision).toEqual({ swapped: false, account: null, reason: "no-usable-target", waitUntil: null });
  });
});

// ---- grokstate fail-fast ----------------------------------------------------

describe("grok state fail-fast", () => {
  test("a corrupt grok-accounts.json throws instead of fabricating an empty pool", () => {
    writeFileSync(grokPaths.accountsJson, "{ not json");
    expect(() => loadGrokAccounts()).toThrow();
    writeFileSync(grokPaths.lastSwapJson, "{ not json");
    expect(() => loadGrokLastSwapAt()).toThrow();
  });
});

// ---- stop hook entry --------------------------------------------------------

describe("grok stop hook", () => {
  test("an end_turn swap hot-reloads: auth.json moves, NO respawn marker is written", async () => {
    const accountA = account("A", { used: 60 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    process.env[GROK_SUPERVISOR_ID_ENV] = "sup-hot";
    try {
      await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "stop", sessionId: "sess-1", reason: "end_turn" }) });
    } finally {
      delete process.env[GROK_SUPERVISOR_ID_ENV];
    }
    expect(liveGrokAccountId()).toBe("user-B");
    expect(existsSync(join(grokPaths.respawnDir, "sup-hot"))).toBe(false);
  });

  test("the session-end Stop fire (reason != end_turn) never decides", async () => {
    const accountA = account("A", { used: 60 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "stop", sessionId: "sess-2", reason: "channel_closed" }) });
    expect(liveGrokAccountId()).toBe("user-A");
  });

  test("StopFailure rate_limit force-swaps AND writes the restart-fallback marker", async () => {
    const accountA = account("A", { used: 20 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    usedPercent = (bearer) => (bearer.includes("key-A") ? 20 : 5);

    process.env[GROK_SUPERVISOR_ID_ENV] = "sup-429";
    try {
      await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "stop_failure", sessionId: "sess-3", error: "rate_limit" }) });
    } finally {
      delete process.env[GROK_SUPERVISOR_ID_ENV];
    }
    expect(liveGrokAccountId()).toBe("user-B");
    const marker = JSON.parse(readFileSync(join(grokPaths.respawnDir, "sup-429"), "utf8"));
    expect(marker.sessionId).toBe("sess-3");
    expect(marker.account).toBe("B");
    expect(marker.waitUntil).toBeNull();
  });

  test("a non-rate_limit StopFailure is observation only", async () => {
    const accountA = account("A", { used: 60 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "stop_failure", sessionId: "sess-4", error: "server_error" }) });
    expect(liveGrokAccountId()).toBe("user-A");
  });

  test("a depleted pool writes the countdown marker for a supervised session", async () => {
    const accountA = account("A", { used: 99, resetInMs: 40 * 60_000 });
    const accountB = account("B", { used: 99, resetInMs: 20 * 60_000 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    process.env[GROK_SUPERVISOR_ID_ENV] = "sup-wait";
    try {
      await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "stop", sessionId: "sess-5", reason: "end_turn" }) });
    } finally {
      delete process.env[GROK_SUPERVISOR_ID_ENV];
    }
    const marker = JSON.parse(readFileSync(join(grokPaths.respawnDir, "sup-wait"), "utf8"));
    expect(marker.account).toBe("B");
    expect(marker.sessionId).toBe("sess-5");
    expect(marker.waitUntil).toBe(accountB.lastUsage!.weekly.resetsAt!);
  });

  test("an unsupervised session still swaps (hot reload carries it) but never gets a marker", async () => {
    const accountA = account("A", { used: 60 });
    const accountB = account("B", { used: 5 });
    seedPool({ accounts: [accountA, accountB], activeId: "user-A" });
    writeLiveGrokAuth({ auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedGrokAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "stop", sessionId: "sess-6", reason: "end_turn" }) });
    expect(liveGrokAccountId()).toBe("user-B");
    expect(existsSync(grokPaths.respawnDir) ? readdirSync(grokPaths.respawnDir) : []).toEqual([]);
  });

  test("a broken pool never throws out of the hook", async () => {
    writeFileSync(grokPaths.accountsJson, "{ not json");
    await expect(handleGrokStop({ rawStdin: "not json either" })).resolves.toBeUndefined();
  });
});

// ---- supervisor shim + hook file lifecycle ----------------------------------

describe("grok supervisor install lifecycle", () => {
  test("install writes the shim + the always-trusted hook sibling; uninstall removes both", () => {
    installGrokSupervisor();
    expect(existsSync(grokSupervisorLink())).toBe(true);
    const hookFile = readFileSync(grokPaths.hooksJson, "utf8");
    expect(hookFile).toContain("__grok-stop-hook");
    expect(hookFile).toContain('"StopFailure"');
    expect(hookFile).toContain('"matcher": "rate_limit"');
    // quoted command: an install path with a space must not mis-split
    expect(hookFile).toContain('\\"');
    // global hooks are always trusted - nothing here may tell users to /hooks
    expect(grokHookFileContent()).not.toContain("/hooks");
    uninstallGrokSupervisor();
    expect(existsSync(grokSupervisorLink())).toBe(false);
    expect(existsSync(grokPaths.hooksJson)).toBe(false);
  });

  test("the Stop gate timeout stays far under grok's 600s default", () => {
    const parsed = z
      .object({ hooks: z.object({ Stop: z.array(z.object({ hooks: z.array(z.object({ timeout: z.number() })) })) }) })
      .parse(JSON.parse(grokHookFileContent()));
    expect(parsed.hooks.Stop[0]!.hooks[0]!.timeout).toBeLessThanOrEqual(30);
  });
});

// ---- supervisor arg analysis + env scrub ------------------------------------

describe("grok supervisor management decision", () => {
  test("interactive launches are managed, utility subcommands and version checks pass through", () => {
    expect(shouldManageGrok({ argv: [] })).toBe(true);
    expect(shouldManageGrok({ argv: ["fix the bug"] })).toBe(true);
    expect(shouldManageGrok({ argv: ["--resume"] })).toBe(true);
    expect(shouldManageGrok({ argv: ["-p", "do the thing"] })).toBe(true); // headless still needs scrub+presence
    expect(shouldManageGrok({ argv: ["login", "--oauth"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["mcp", "list"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["agent", "stdio"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["--version"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["-h"] })).toBe(false);
  });

  test("a value-taking root option's value is not mistaken for the subcommand", () => {
    expect(shouldManageGrok({ argv: ["-m", "grok-4", "export"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["-m", "grok-4", "fix the bug"] })).toBe(true);
    expect(shouldManageGrok({ argv: ["--output-format", "json", "-p", "prompt"] })).toBe(true);
  });

  test("the child env scrub drops the API key and auth-provider hooks, empty strings included", () => {
    const scrubbed = scrubGrokAuthEnv({ XAI_API_KEY: "xai-secret", GROK_AUTH_PROVIDER_COMMAND: "", PATH: "/usr/bin", HOME: "/tmp/h" });
    expect(scrubbed.XAI_API_KEY).toBeUndefined();
    expect(scrubbed.GROK_AUTH_PROVIDER_COMMAND).toBeUndefined();
    expect(scrubbed.PATH).toBe("/usr/bin");
  });
});

// ---- CLI dispatch (argv permutations) ---------------------------------------

describe("grok CLI dispatch", () => {
  const run = (args: string[]) => {
    // TOKENMAXXING_PROBE bypasses only the ambient-CLAUDE_CONFIG_DIR refusal
    // (the test env sets that dir for hermeticity); the grok commands under
    // test never read it.
    const p = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "src", "main.ts"), ...args], {
      env: { ...process.env, TOKENMAXXING_PROBE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };

  test("`switch <sel> --grok` reaches the grok switch, never a claude swap", () => {
    const flagLast = run(["switch", "somebody", "--grok"]);
    expect(flagLast.out).toContain("no grok accounts yet");
    const flagFirst = run(["switch", "--grok", "somebody"]);
    expect(flagFirst.out).toContain("no grok accounts yet");
  });

  test("--grok and --codex refuse to mix", () => {
    for (const args of [["switch", "--grok", "--codex"], ["init", "--codex", "--grok"], ["rm", "--grok", "--codex", "x"]]) {
      const res = run(args);
      expect(res.code).toBe(2);
      expect(res.out).toContain("mutually exclusive");
    }
  });

  test("doctor stays silent about grok while the pool is empty and no shim exists", () => {
    rmSync(grokSupervisorLink(), { force: true });
    const res = run(["doctor"]);
    expect(res.out).not.toContain("grok");
  });
});
