import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureGrokStoreHome, grokRespawnArgs, GROK_CONTINUATION_PROMPT, pickGrokSeat, readGrokStoreIssuer } from "../src/lib/grok.ts";
import { mapGrokCredits } from "../src/lib/grokusage.ts";
import { handleGrokStop } from "../src/entries/grokstophook.ts";
import { GROK_SUPERVISOR_ID_ENV, shouldManageGrok } from "../src/entries/groksupervisor.ts";
import { grokHookFileContent } from "../src/lib/install.ts";
import { grokPaths, grokPool, grokStoreDirFor, paths } from "../src/lib/paths.ts";
import { writePresence } from "../src/lib/presence.ts";
import { loadAccounts, saveAccounts } from "../src/lib/state.ts";
import type { Account, Window } from "../src/lib/types.ts";

const WEEK = 7 * 24 * 3600;
const A = "aaaaaaaa-grok-A";
const B = "bbbbbbbb-grok-B";

function win(used: number, resetInMs: number): Window {
  return { name: null, usedPercentage: used, resetsAt: Date.now() + resetInMs, windowSeconds: WEEK, sampledAt: Date.now() };
}

function account(id: string, windows: Window[]): Account {
  return { id, label: id, email: null, tier: null, addedAt: "2026-09-01T00:00:00.000Z", windows, lastUsageAt: Date.now() };
}

function store(id: string, key: string): void {
  mkdirSync(grokStoreDirFor(id), { recursive: true });
  writeFileSync(
    join(grokStoreDirFor(id), "auth.json"),
    JSON.stringify({ "https://accounts.x.ai::client": { auth_mode: "oidc", key, refresh_token: `rt-${id}`, user_id: id, principal_type: "User", email: `${id}@example.com`, expires_at: new Date(Date.now() + 3_600_000).toISOString() } }),
  );
}

let usedByKey: Record<string, number> = {};
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: Number(new URL(process.env.TOKENMAXXING_GROK_BILLING_URL!).port),
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/grok-billing" || url.searchParams.get("format") !== "credits") return new Response("not found", { status: 404 });
      const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const used = usedByKey[key];
      if (used == null) return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
      return Response.json({ config: { creditUsagePercent: used, currentPeriod: { type: "weekly", end: new Date(Date.now() + 2 * 86_400_000).toISOString() } } });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  rmSync(grokPaths.storesDir, { recursive: true, force: true });
  rmSync(grokPaths.presenceDir, { recursive: true, force: true });
  rmSync(grokPaths.respawnDir, { recursive: true, force: true });
  rmSync(grokPool.accountsJson, { force: true });
  rmSync(paths.configJson, { force: true });
  rmSync(grokPaths.home, { recursive: true, force: true });
  mkdirSync(grokPaths.home, { recursive: true });
  usedByKey = {};
  delete process.env.GROK_HOME;
  delete process.env[GROK_SUPERVISOR_ID_ENV];
});

describe("grok credits mapping", () => {
  test("format=credits maps to one weekly window; a weekly period without a percent is an unused seat; the legacy monthly body throws", () => {
    const at = Date.now();
    const [w] = mapGrokCredits({ body: { config: { creditUsagePercent: 86, currentPeriod: { type: "weekly", end: "2026-09-20T00:00:00Z" } } }, at });
    expect(w).toMatchObject({ name: null, usedPercentage: 86, windowSeconds: WEEK, sampledAt: at });
    expect(w!.resetsAt).toBe(Date.parse("2026-09-20T00:00:00Z"));
    expect(mapGrokCredits({ body: { config: { currentPeriod: { type: "weekly", end: "2026-09-20T00:00:00Z" } } }, at })[0]!.usedPercentage).toBe(0);
    expect(mapGrokCredits({ body: { productUsage: [{ product: "GrokBuild", usagePercent: 40 }] }, at })[0]!.usedPercentage).toBe(40);
    expect(() => mapGrokCredits({ body: { monthlyLimit: 0, used: 0 }, at })).toThrow(/format=credits/);
  });
});

describe("grok per-account store home", () => {
  test("the store holds only auth.json; everything else in the real home is a symlink (lock file excluded)", () => {
    for (const name of ["hooks", "sessions", "skills", "config.toml"]) {
      if (name.includes(".")) writeFileSync(join(grokPaths.home, name), "x");
      else mkdirSync(join(grokPaths.home, name), { recursive: true });
    }
    writeFileSync(join(grokPaths.home, "auth.json"), "{}");
    writeFileSync(join(grokPaths.home, "auth.json.lock"), "");
    store(A, "key-A");
    const home = ensureGrokStoreHome(A);
    expect(home).toBe(grokStoreDirFor(A));
    for (const name of ["hooks", "sessions", "skills", "config.toml"]) expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(home, "auth.json.lock"))).toBe(false);
    expect(readGrokStoreIssuer(A)?.key).toBe("key-A");
    ensureGrokStoreHome(A);
  });
});

describe("grok respawn args", () => {
  test("keeps the launch shape, drops the prompt and session selectors, injects the continuation prompt for -p, adds --resume <sid>", () => {
    const argv = ["-p", "audit this", "--output-format", "streaming-messages-json", "--permission-mode", "bypassPermissions", "--always-approve", "--no-auto-update", "--resume", "old-sid", "--effort", "high"];
    expect(grokRespawnArgs({ argv, sessionId: "new-sid" })).toEqual(["-p", GROK_CONTINUATION_PROMPT, "--output-format", "streaming-messages-json", "--permission-mode", "bypassPermissions", "--always-approve", "--no-auto-update", "--effort", "high", "--resume", "new-sid"]);
    expect(grokRespawnArgs({ argv: ["--model", "grok-4", "fix the tests", "-c"], sessionId: null })).toEqual(["--model", "grok-4", "--resume"]);
    expect(grokRespawnArgs({ argv: ["-s", "pinned", "--resume=abc", "--fork-session"], sessionId: "x" })).toEqual(["--resume", "x"]);
  });

  test("interactive and -p launches are managed; utilities and version checks pass through", () => {
    expect(shouldManageGrok({ argv: [] })).toBe(true);
    expect(shouldManageGrok({ argv: ["-p", "hi", "--output-format", "streaming-messages-json"] })).toBe(true);
    expect(shouldManageGrok({ argv: ["-m", "grok-4", "export"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["--version"] })).toBe(false);
    expect(shouldManageGrok({ argv: ["login"] })).toBe(false);
  });
});

describe("grok placement and hook", () => {
  function pool(aUsed: number, bUsed: number): void {
    saveAccounts(grokPool, { version: 2, activeId: null, accounts: [account(A, [win(aUsed, 2 * 86_400_000)]), account(B, [win(bUsed, 2 * 86_400_000)])] });
    store(A, "key-A");
    store(B, "key-B");
  }

  test("placement prefers the usable account furthest behind its weekly pace; the wanted account wins while usable", () => {
    pool(50, 10);
    expect(pickGrokSeat(Date.now(), null)?.id).toBe(B);
    expect(pickGrokSeat(Date.now(), A)?.id).toBe(A);
    pool(99, 10);
    expect(pickGrokSeat(Date.now(), A)?.id).toBe(B);
  });

  test("end_turn under the bar writes no marker; a StopFailure rate_limit on a seat the server confirms walled moves the session", async () => {
    pool(50, 10);
    usedByKey = { "key-A": 100, "key-B": 10 };
    process.env.GROK_HOME = grokStoreDirFor(A);
    process.env[GROK_SUPERVISOR_ID_ENV] = "sup-1";
    writePresence({ dir: grokPaths.presenceDir, id: "sup-1", accountId: A, pid: process.pid });
    await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "Stop", sessionId: "sid-1", reason: "end_turn" }) });
    expect(existsSync(join(grokPaths.respawnDir, "sup-1"))).toBe(false);
    await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "StopFailure", sessionId: "sid-1", error: "rate_limit" }) });
    const marker = JSON.parse(readFileSync(join(grokPaths.respawnDir, "sup-1"), "utf8"));
    expect(marker).toMatchObject({ accountId: B, sessionId: "sid-1", waitUntil: null });
    const walled = loadAccounts(grokPool).accounts.find((a) => a.id === A)!;
    expect(walled.enforcedUntil).toBeGreaterThan(Date.now());
    expect(walled.windows[0]?.usedPercentage).toBe(100);
  });

  test("a StopFailure rate_limit on a seat the server still reads under the bar is transient: no wall, no marker", async () => {
    pool(50, 10);
    usedByKey = { "key-A": 12, "key-B": 10 };
    process.env.GROK_HOME = grokStoreDirFor(A);
    process.env[GROK_SUPERVISOR_ID_ENV] = "sup-2";
    await handleGrokStop({ rawStdin: JSON.stringify({ hookEventName: "StopFailure", sessionId: "sid-2", error: "rate_limit" }) });
    expect(existsSync(join(grokPaths.respawnDir, "sup-2"))).toBe(false);
    expect(loadAccounts(grokPool).accounts.find((a) => a.id === A)!.enforcedUntil).toBeUndefined();
  });

  test("the hook file declares Stop and a rate_limit-matched StopFailure pointing at the installed binary", () => {
    const parsed = JSON.parse(grokHookFileContent());
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("__grok-stop-hook");
    expect(parsed.hooks.StopFailure[0].matcher).toBe("rate_limit");
  });
});
