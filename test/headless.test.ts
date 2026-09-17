import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EX_TEMPFAIL,
  claudeTranscriptRefusal,
  codexResumeArgs,
  codexRolloutRefusal,
  isQuotaRefusalText,
  livingHeadlessJobs,
  parseCodexExecLaunch,
  parseRefusalReset,
  readJobRecord,
  resolveClaudeSessionId,
  resolveCodexThreadId,
  writeJobRecord,
  type JobRecord,
} from "../src/lib/headless.ts";
import { claudeTranscriptFor, codexPaths, paths, claudePool, codexPool } from "../src/lib/paths.ts";
import { pidStartTime } from "../src/lib/proc.ts";
import { analyzeArgs } from "../src/entries/supervisor.ts";
import { isHeadlessCodexLaunch, shouldManageCodex } from "../src/entries/codexsupervisor.ts";
import { placeSeat } from "../src/lib/claude.ts";
import { placeCodexSeat } from "../src/lib/codex.ts";
import { writePresence } from "../src/lib/presence.ts";
import { loadConfig, saveAccounts } from "../src/lib/state.ts";
import type { Account, Window } from "../src/lib/types.ts";

const CODEX_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 9:44 PM.";
const THREAD = "01a0ad51-919e-7ec2-885b-ee1e23d088d9";
const SID = "44444444-4444-4444-8444-444444444444";
const WEEK = 7 * 24 * 3600;
const FIVE_H = 5 * 3600;

function win(used: number, seconds: number, resetInMs: number, name: string | null = null): Window {
  return { name, usedPercentage: used, resetsAt: Date.now() + resetInMs, windowSeconds: seconds, sampledAt: Date.now() };
}

function account(id: string, windows: Window[], over: Partial<Account> = {}): Account {
  return { id, label: id, email: null, tier: null, addedAt: new Date(0).toISOString(), windows, lastUsageAt: Date.now(), ...over };
}

beforeEach(() => {
  for (const d of [paths.jobsDir, paths.presenceDir, codexPaths.presenceDir, join(codexPaths.home, "sessions"), join(paths.claudeDir, "projects")]) rmSync(d, { recursive: true, force: true });
  for (const f of [paths.configJson, claudePool.accountsJson, codexPool.accountsJson]) rmSync(f, { force: true });
});
afterEach(() => rmSync(paths.jobsDir, { recursive: true, force: true }));

describe("quota refusal classifier", () => {
  test("matches the vendor refusal families by substring, never bare 'rate limit'", () => {
    expect(isQuotaRefusalText(CODEX_LIMIT)).toBe(true);
    expect(isQuotaRefusalText("API Error: You've hit your limit · resets 3pm")).toBe(true);
    expect(isQuotaRefusalText("Claude AI usage limit reached|1789600000")).toBe(true);
    expect(isQuotaRefusalText("You're out of extra usage")).toBe(true);
    expect(isQuotaRefusalText("gh: You have exceeded a secondary rate limit")).toBe(false);
    expect(isQuotaRefusalText("")).toBe(false);
  });

  test("the reset clock in a codex refusal parses to a local wall time; no clock = null", () => {
    const at = parseRefusalReset(CODEX_LIMIT);
    expect(at).not.toBeNull();
    const d = new Date(at!);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 8, 19, 21, 44]);
    expect(parseRefusalReset("You've hit your usage limit.")).toBeNull();
  });

  test("EX_TEMPFAIL is the sysexits value wrappers key on", () => {
    expect(EX_TEMPFAIL).toBe(75);
  });
});

function rollout(input: { id: string; cwd: string; at: number; lines?: string[]; day?: string }): string {
  const dir = join(codexPaths.home, "sessions", input.day ?? "2026/09/17");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${new Date(input.at).toISOString().replace(/[:.]/g, "-")}-${input.id}.jsonl`);
  const meta = JSON.stringify({ timestamp: new Date(input.at).toISOString(), ordinal: 0, type: "session_meta", payload: { id: input.id, timestamp: new Date(input.at).toISOString(), cwd: input.cwd, source: "exec" } });
  writeFileSync(file, [meta, ...(input.lines ?? [])].join("\n") + "\n");
  return file;
}

function taskCompleteRefusal(at: number, message = CODEX_LIMIT): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), ordinal: 390, type: "event_msg", payload: { type: "task_complete", turn_id: "t", last_agent_message: null, error: { message } } });
}

describe("codex side channel", () => {
  test("a fresh exec's thread resolves from the rollout stamped after spawn under this cwd; two are ambiguous", () => {
    const now = Date.now();
    rollout({ id: "old-thread", cwd: "/w", at: now - 600_000 });
    rollout({ id: "other-cwd", cwd: "/elsewhere", at: now - 1000 });
    rollout({ id: THREAD, cwd: "/w", at: now - 1000 });
    expect(resolveCodexThreadId({ cwd: "/w", since: now - 2000, now })).toEqual({ kind: "id", id: THREAD });
    expect(resolveCodexThreadId({ cwd: "/nowhere", since: now - 2000, now })).toEqual({ kind: "none" });
    rollout({ id: "t-2", cwd: "/w", at: now - 900 });
    expect(resolveCodexThreadId({ cwd: "/w", since: now - 2000, now }).kind).toBe("ambiguous");
  });

  test("the refusal is read from task_complete.error after the spawn; older refusals and non-quota errors do not count", () => {
    const now = Date.now();
    rollout({ id: THREAD, cwd: "/w", at: now - 3 * 86_400_000, day: "2026/09/14", lines: [taskCompleteRefusal(now - 86_400_000)] });
    expect(codexRolloutRefusal({ threadId: THREAD, since: now - 2000 })).toBeNull();
    rollout({ id: "fresh", cwd: "/w", at: now - 1000, lines: [taskCompleteRefusal(now - 100)] });
    expect(codexRolloutRefusal({ threadId: "fresh", since: now - 2000 })).toBe(CODEX_LIMIT);
    rollout({ id: "crash", cwd: "/w", at: now - 1000, lines: [taskCompleteRefusal(now - 100, "stream disconnected before completion")] });
    expect(codexRolloutRefusal({ threadId: "crash", since: now - 2000 })).toBeNull();
    expect(codexRolloutRefusal({ threadId: "missing", since: now - 2000 })).toBeNull();
  });
});

describe("claude side channel", () => {
  function transcript(sid: string, entries: unknown[]): void {
    const file = claudeTranscriptFor(sid, "/w");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  const at = (ms: number) => new Date(ms).toISOString();

  test("only the structured API-error row after the spawn classifies; quoted text and transient errors never do", () => {
    const now = Date.now();
    transcript(SID, [
      { type: "user", timestamp: at(now - 900), message: { role: "user", content: [{ type: "tool_result", content: "grep: You've hit your limit" }] } },
      { type: "assistant", timestamp: at(now - 800), message: { role: "assistant", content: [{ type: "text", text: "The log says: You've hit your limit" }] } },
      { type: "assistant", timestamp: at(now - 700), isApiErrorMessage: true, error: "rate_limit", apiErrorIsTransient: true, message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 overloaded" }] } },
    ]);
    expect(claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now - 2000, switchModels: ["fable"] })).toBeNull();
    transcript(SID, [
      { type: "assistant", timestamp: at(now - 5000), isApiErrorMessage: true, error: "rate_limit", quotaLimits: { rateLimitType: "five_hour", resetsAt: Math.floor(now / 1000) + 3600 }, message: { role: "assistant", content: [{ type: "text", text: "You've hit your limit" }] } },
    ]);
    expect(claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now + 10_000, switchModels: ["fable"] })).toBeNull();
    const found = claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now - 20_000, switchModels: ["fable"] });
    expect(found?.kind).toBe("session");
    expect(found?.resetsAt).toBe((Math.floor(now / 1000) + 3600) * 1000);
    transcript(SID, [
      { type: "assistant", timestamp: at(now - 100), isApiErrorMessage: true, error: "rate_limit", quotaLimits: { rateLimitType: "seven_day_fable" }, message: { role: "assistant", content: [] } },
    ]);
    const model = claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now - 2000, switchModels: ["fable"] });
    expect(model).toEqual({ kind: "model", family: "fable", resetsAt: null });
    expect(claudeTranscriptRefusal({ sessionId: "nope", cwd: "/w", since: now - 2000, switchModels: ["fable"] })).toBeNull();
  });

  test("a fresh transcript resolves by its first entry's stamp; two in the window are ambiguous", () => {
    const now = Date.now();
    transcript("a-old", [{ type: "user", timestamp: at(now - 600_000), sessionId: "a-old" }]);
    transcript(SID, [{ type: "user", timestamp: at(now - 1000), sessionId: SID }]);
    expect(resolveClaudeSessionId({ cwd: "/w", since: now - 2000, now })).toEqual({ kind: "id", id: SID });
    transcript("b-new", [{ type: "user", timestamp: at(now - 900), sessionId: "b-new" }]);
    expect(resolveClaudeSessionId({ cwd: "/w", since: now - 2000, now }).kind).toBe("ambiguous");
    expect(resolveClaudeSessionId({ cwd: "/none", since: now - 2000, now })).toEqual({ kind: "none" });
  });
});

describe("job records", () => {
  const base: JobRecord = { backend: "claude", jobId: "job-1", cwd: "/w", sessionId: null, accountId: "A", launchArgs: ["-p", "x"], respawns: 0, state: "running", waitUntil: null, pid: null, startedAt: null, ts: Date.now() };

  test("a running record whose process identity still matches is living; done/recycled are not; corrupt files are dropped", () => {
    writeJobRecord({ ...base, pid: process.pid, startedAt: pidStartTime(process.pid) });
    writeJobRecord({ ...base, jobId: "job-done", state: "done", pid: process.pid, startedAt: pidStartTime(process.pid) });
    writeJobRecord({ ...base, jobId: "job-recycled", pid: process.pid, startedAt: "Mon Jan  1 00:00:00 1990" });
    writeJobRecord({ ...base, jobId: "job-codex", backend: "codex", pid: process.pid, startedAt: pidStartTime(process.pid) });
    mkdirSync(paths.jobsDir, { recursive: true });
    writeFileSync(join(paths.jobsDir, "garbage.json"), "{not json");
    expect(livingHeadlessJobs("claude").map((j) => j.jobId)).toEqual(["job-1"]);
    expect(livingHeadlessJobs().map((j) => j.jobId).sort()).toEqual(["job-1", "job-codex"]);
    expect(readJobRecord("job-done")?.state).toBe("done");
    expect(() => readFileSync(join(paths.jobsDir, "garbage.json"))).toThrow();
  });
});

describe("codex exec argv", () => {
  test("parses the wrapper's launch shapes: fresh, resume, --last, fork; keeps flags, drops id/prompt", () => {
    expect(parseCodexExecLaunch(["exec", "--json", "--skip-git-repo-check", "-c", 'model_reasoning_effort="high"', "-m", "gpt-5.5", "do the thing"])).toEqual({ mode: "exec", sessionId: null, flags: ["--json", "--skip-git-repo-check", "-c", 'model_reasoning_effort="high"', "-m", "gpt-5.5"] });
    expect(parseCodexExecLaunch(["exec", "resume", "--json", THREAD, "follow up"])).toEqual({ mode: "resume", sessionId: THREAD, flags: ["--json"] });
    expect(parseCodexExecLaunch(["exec", "resume", "--json", "--last", "follow up"])).toEqual({ mode: "resume", sessionId: null, flags: ["--json"] });
    expect(parseCodexExecLaunch(["exec", "fork", "--json", THREAD, "branch"])?.mode).toBe("fork");
    expect(parseCodexExecLaunch(["exec", "-i", "a.png", "b.png", "--color=never", "p"])?.flags).toEqual(["-i", "a.png", "b.png", "--color=never"]);
    for (const argv of [["exec", "--help"], ["exec", "review"], ["--version"], [], ["resume", "x"]]) expect(parseCodexExecLaunch(argv)).toBeNull();
  });

  test("the resume form continues the SAME thread with the flags and the configured prompt (empty by default)", () => {
    expect(codexResumeArgs({ threadId: THREAD, flags: ["--json"], prompt: "" })).toEqual(["exec", "resume", "--json", THREAD, ""]);
    expect(loadConfig().policy.headlessResumePrompt).toBe("");
  });
});

describe("launch classification", () => {
  test("codex: exec is headless-managed, the TUI stays interactive, utilities pass through", () => {
    expect(isHeadlessCodexLaunch({ argv: ["exec", "--json", "hi"] })).toBe(true);
    expect(isHeadlessCodexLaunch({ argv: ["exec", "resume", THREAD, "hi"] })).toBe(true);
    for (const argv of [[], ["--version"], ["login"]]) expect(isHeadlessCodexLaunch({ argv })).toBe(false);
    expect(shouldManageCodex({ argv: ["exec", "hi"] })).toBe(false);
    expect(shouldManageCodex({ argv: [] })).toBe(true);
  });

  test("claude: -p with a prompt is headless; help/version, subcommands, picker and fork resumes are not; interactive is unchanged", () => {
    const p = analyzeArgs(["-p", "audit this", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]);
    expect([p.headless, p.manage]).toEqual([true, false]);
    const r = analyzeArgs(["-p", "x", "--resume", SID]);
    expect([r.headless, r.resumeId]).toEqual([true, SID]);
    for (const argv of [["--version"], ["-p", "x", "-r"], ["mcp", "list"], ["-p", "x", "--session-id", "not-a-uuid"], ["-p", "x", "--resume", SID, "--fork-session"]]) expect(analyzeArgs(argv).headless).toBe(false);
    expect(analyzeArgs(["--model", "opus"]).manage).toBe(true);
    expect(analyzeArgs(["--model", "opus"]).headless).toBe(false);
  });
});

describe("placement", () => {
  test("claude: a usable account seats the job; a walled pool waits for the soonest reset; the wanted account wins while usable", () => {
    const A = account("aaaaaaaa-A", [win(96, FIVE_H, 3_600_000), win(20, WEEK, 5 * 86_400_000)]);
    const B = account("bbbbbbbb-B", [win(10, FIVE_H, 3_600_000), win(20, WEEK, 3 * 86_400_000)]);
    saveAccounts(claudePool, { version: 2, activeId: null, accounts: [A, B] });
    const seat = placeSeat(Date.now(), null);
    expect(seat.kind === "seat" && seat.account.id).toBe(B.id);
    expect(placeSeat(Date.now(), A.id)).toMatchObject({ kind: "seat", account: { id: B.id } });
    saveAccounts(claudePool, { version: 2, activeId: null, accounts: [A, { ...B, windows: [win(97, FIVE_H, 1_800_000), win(20, WEEK, 3 * 86_400_000)] }] });
    const wait = placeSeat(Date.now(), null);
    expect(wait.kind).toBe("wait");
    if (wait.kind === "wait") {
      expect(wait.account?.id).toBe(B.id);
      expect(wait.until - Date.now()).toBeLessThan(1_900_000);
    }
    saveAccounts(claudePool, { version: 2, activeId: null, accounts: [] });
    expect(placeSeat(Date.now(), null)).toEqual({ kind: "none" });
  });

  test("codex: a free usable account wins; with every usable account present, sharing seats the least-loaded one, else the job waits", () => {
    const A = account("aaaaaaaa-A", [win(10, WEEK, 5 * 86_400_000)]);
    const B = account("bbbbbbbb-B", [win(50, WEEK, 2 * 86_400_000)]);
    saveAccounts(codexPool, { version: 2, activeId: null, accounts: [A, B] });
    writePresence({ dir: codexPaths.presenceDir, id: "job-a", accountId: A.id, pid: process.pid });
    expect(placeCodexSeat(Date.now(), null, false)).toMatchObject({ kind: "seat", account: { id: B.id }, shared: false });
    writePresence({ dir: codexPaths.presenceDir, id: "job-b", accountId: B.id, pid: process.pid });
    writePresence({ dir: codexPaths.presenceDir, id: "job-b2", accountId: B.id, pid: process.pid });
    const shared = placeCodexSeat(Date.now(), null, true);
    expect(shared).toMatchObject({ kind: "seat", account: { id: A.id }, shared: true });
    expect(placeCodexSeat(Date.now(), null, false)).toEqual({ kind: "none" });
    saveAccounts(codexPool, { version: 2, activeId: null, accounts: [{ ...A, windows: [win(99, WEEK, 3_600_000)] }, { ...B, windows: [win(99, WEEK, 7_200_000)] }] });
    const walled = placeCodexSeat(Date.now(), null, true);
    expect(walled.kind).toBe("wait");
    if (walled.kind === "wait") expect(walled.account?.id).toBe(A.id);
  });
});

describe("headless config", () => {
  test("defaults: managed on, 5 respawns 10s apart, 1h wait cap, empty resume prompt, codex seat sharing on", () => {
    const cfg = loadConfig();
    expect(cfg.policy.headlessManage).toBe(true);
    expect(cfg.policy.headlessMaxRespawns).toBe(5);
    expect(cfg.policy.headlessMinRespawnGapMs).toBe(10_000);
    expect(cfg.policy.headlessMaxWaitMs).toBe(3_600_000);
    expect(cfg.policy.headlessResumePrompt).toBe("");
    expect(cfg.policy.headlessShareCodexSeats).toBe(true);
    writeFileSync(paths.configJson, JSON.stringify({ policy: { headlessManage: false, headlessMaxRespawns: 0, headlessResumePrompt: "continue" } }));
    const off = loadConfig();
    expect([off.policy.headlessManage, off.policy.headlessMaxRespawns, off.policy.headlessResumePrompt]).toEqual([false, 0, "continue"]);
  });
});
