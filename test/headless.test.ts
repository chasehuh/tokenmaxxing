// Managed-headless building blocks (docs/auto-swap-long-sessions.md): the
// refusal text classifier, job records, the codex/claude side channels, the
// argv shapes each backend persists and resumes with, and the launch
// classification each supervisor performs. Every fixture line that matters
// is a real line captured on 2026-09-17 (codex 0.153.4, claude 2.1.258).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EX_TEMPFAIL,
  claudeTranscriptFor,
  claudeTranscriptRefusal,
  codexResumeArgs,
  codexRolloutRefusal,
  isQuotaRefusalText,
  livingHeadlessJobs,
  parseCodexExecLaunch,
  readJobRecord,
  resolveClaudeSessionId,
  resolveCodexThreadId,
  writeJobRecord,
  type JobRecord,
} from "../src/lib/headless.ts";
import { codexPaths, paths } from "../src/lib/paths.ts";
import { pidStartTime } from "../src/lib/proc.ts";
import { analyzeArgs } from "../src/entries/supervisor.ts";
import { isHeadlessCodexLaunch, shouldManageCodex } from "../src/entries/codexsupervisor.ts";
import { GROK_CONTINUATION_PROMPT, grokRespawnArgs } from "../src/entries/groksupervisor.ts";
import { loadConfig } from "../src/lib/state.ts";
import { KNOWN_KEYS } from "../src/cli/config.ts";

const CODEX_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 9:44 PM.";
const THREAD = "01a0ad51-919e-7ec2-885b-ee1e23d088d9";
const SID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  rmSync(paths.jobsDir, { recursive: true, force: true });
  rmSync(join(codexPaths.home, "sessions"), { recursive: true, force: true });
  rmSync(join(paths.claudeDir, "projects"), { recursive: true, force: true });
  rmSync(paths.configJson, { force: true });
});
afterEach(() => {
  rmSync(paths.jobsDir, { recursive: true, force: true });
});

describe("quota refusal classifier", () => {
  test("matches the vendor refusal families by substring, never bare 'rate limit'", () => {
    expect(isQuotaRefusalText(CODEX_LIMIT)).toBe(true);
    expect(isQuotaRefusalText("API Error: You've hit your limit · resets 3pm")).toBe(true);
    expect(isQuotaRefusalText("Claude AI usage limit reached|1789600000")).toBe(true);
    expect(isQuotaRefusalText("You're out of extra usage")).toBe(true);
    expect(isQuotaRefusalText('{"status":"usage_limited"}')).toBe(true);
    expect(isQuotaRefusalText("gh: You have exceeded a secondary rate limit")).toBe(false);
    expect(isQuotaRefusalText("The catalog read hit a temporary rate limit; retrying")).toBe(false);
    expect(isQuotaRefusalText("")).toBe(false);
  });

  test("EX_TEMPFAIL is the sysexits value wrappers key on", () => {
    expect(EX_TEMPFAIL).toBe(75);
  });
});

function rollout(input: { id: string; cwd: string; at: number; lines?: string[]; day?: string }): string {
  const day = input.day ?? "2026/09/17";
  const dir = join(codexPaths.home, "sessions", day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${new Date(input.at).toISOString().replace(/[:.]/g, "-")}-${input.id}.jsonl`);
  const meta = JSON.stringify({
    timestamp: new Date(input.at).toISOString(),
    ordinal: 0,
    type: "session_meta",
    payload: { session_id: input.id, id: input.id, timestamp: new Date(input.at).toISOString(), cwd: input.cwd, originator: "codex_exec", source: "exec" },
  });
  writeFileSync(file, [meta, ...(input.lines ?? [])].join("\n") + "\n");
  return file;
}

/** the exact event codex 0.153.4 persisted for today's refused turn */
function taskCompleteRefusal(at: number, message = CODEX_LIMIT): string {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    ordinal: 390,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "01a0ad1c-4974-7cf0-83bc-100d2fc2d1de", last_agent_message: null, error: { message } },
  });
}

describe("codex side channel", () => {
  test("a fresh exec's thread resolves from the rollout stamped after spawn under this cwd", () => {
    const now = Date.now();
    rollout({ id: "old-thread", cwd: "/w", at: now - 600_000 });
    rollout({ id: "other-cwd", cwd: "/elsewhere", at: now - 1000 });
    rollout({ id: THREAD, cwd: "/w", at: now - 1000 });
    expect(resolveCodexThreadId({ cwd: "/w", since: now - 2000, now })).toEqual({ kind: "id", id: THREAD });
    expect(resolveCodexThreadId({ cwd: "/nowhere", since: now - 2000, now })).toEqual({ kind: "none" });
  });

  test("two threads started in one cwd inside the window are AMBIGUOUS, never a guess", () => {
    const now = Date.now();
    rollout({ id: "t-1", cwd: "/w", at: now - 1500 });
    rollout({ id: "t-2", cwd: "/w", at: now - 1000 });
    const r = resolveCodexThreadId({ cwd: "/w", since: now - 2000, now });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.ids.sort()).toEqual(["t-1", "t-2"]);
  });

  test("the refusal is read from task_complete.error after the spawn; older refusals do not count", () => {
    const now = Date.now();
    rollout({ id: THREAD, cwd: "/w", at: now - 3 * 86_400_000, day: "2026/09/14", lines: [
      taskCompleteRefusal(now - 86_400_000), // yesterday's refusal on a resumed thread
      JSON.stringify({ timestamp: new Date(now - 500).toISOString(), type: "event_msg", payload: { type: "token_count" } }),
    ] });
    expect(codexRolloutRefusal({ threadId: THREAD, since: now - 2000 })).toBeNull();
    rollout({ id: "fresh", cwd: "/w", at: now - 1000, lines: [taskCompleteRefusal(now - 100)] });
    expect(codexRolloutRefusal({ threadId: "fresh", since: now - 2000 })).toBe(CODEX_LIMIT);
    // a non-quota task_complete error is not a refusal
    rollout({ id: "crash", cwd: "/w", at: now - 1000, lines: [taskCompleteRefusal(now - 100, "stream disconnected before completion")] });
    expect(codexRolloutRefusal({ threadId: "crash", since: now - 2000 })).toBeNull();
    expect(codexRolloutRefusal({ threadId: "missing", since: now - 2000 })).toBeNull();
  });
});

describe("claude side channel", () => {
  function transcript(input: { sid: string; cwd: string; entries: unknown[] }): string {
    const file = claudeTranscriptFor({ sessionId: input.sid, cwd: input.cwd });
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, input.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  }

  test("only API-error / system entries after the spawn classify; quoted text in tool results never does", () => {
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();
    transcript({ sid: SID, cwd: "/w", entries: [
      { type: "user", timestamp: at(now - 900), sessionId: SID, message: { role: "user", content: [{ type: "tool_result", content: "grep: You've hit your limit" }] } },
      { type: "assistant", timestamp: at(now - 800), sessionId: SID, message: { role: "assistant", content: [{ type: "text", text: "The log says: You've hit your limit" }] } },
    ] });
    expect(claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now - 2000 })).toBeNull();
    transcript({ sid: SID, cwd: "/w", entries: [
      { type: "assistant", timestamp: at(now - 5000), sessionId: SID, isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "API Error: You've hit your limit" }] } },
    ] });
    expect(claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now + 10_000 })).toBeNull(); // before the spawn
    transcript({ sid: SID, cwd: "/w", entries: [
      { type: "assistant", timestamp: at(now - 100), sessionId: SID, isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "API Error: Claude AI usage limit reached|1789600000" }] } },
    ] });
    expect(claudeTranscriptRefusal({ sessionId: SID, cwd: "/w", since: now - 2000 })).toContain("usage limit reached");
    expect(claudeTranscriptRefusal({ sessionId: "nope", cwd: "/w", since: now - 2000 })).toBeNull();
  });

  test("a fresh transcript resolves by its first entry's stamp; two in the window are ambiguous", () => {
    const now = Date.now();
    transcript({ sid: "a-old", cwd: "/w", entries: [{ type: "user", timestamp: new Date(now - 600_000).toISOString(), sessionId: "a-old" }] });
    transcript({ sid: SID, cwd: "/w", entries: [{ type: "user", timestamp: new Date(now - 1000).toISOString(), sessionId: SID }] });
    expect(resolveClaudeSessionId({ cwd: "/w", since: now - 2000, now })).toEqual({ kind: "id", id: SID });
    transcript({ sid: "b-new", cwd: "/w", entries: [{ type: "user", timestamp: new Date(now - 900).toISOString(), sessionId: "b-new" }] });
    expect(resolveClaudeSessionId({ cwd: "/w", since: now - 2000, now }).kind).toBe("ambiguous");
    expect(resolveClaudeSessionId({ cwd: "/none", since: now - 2000, now })).toEqual({ kind: "none" });
  });
});

describe("job records", () => {
  const base: JobRecord = {
    backend: "claude", jobId: "job-1", cwd: "/w", sessionId: null, accountId: "org-A", launchArgs: ["-p", "x"],
    respawns: 0, state: "running", waitUntil: null, pid: null, startedAt: null, ts: Date.now(),
  };

  test("a running record whose process identity still matches is living; done/dead/recycled are not", () => {
    writeJobRecord({ ...base, pid: process.pid, startedAt: pidStartTime(process.pid) });
    writeJobRecord({ ...base, jobId: "job-done", state: "done", pid: process.pid, startedAt: pidStartTime(process.pid) });
    writeJobRecord({ ...base, jobId: "job-recycled", pid: process.pid, startedAt: "Mon Jan  1 00:00:00 1990" });
    writeJobRecord({ ...base, jobId: "job-codex", backend: "codex", pid: process.pid, startedAt: pidStartTime(process.pid) });
    expect(livingHeadlessJobs("claude").map((j) => j.jobId)).toEqual(["job-1"]);
    expect(livingHeadlessJobs().map((j) => j.jobId).sort()).toEqual(["job-1", "job-codex"]);
    expect(readJobRecord("job-done")?.state).toBe("done");
  });

  test("a corrupt record is dropped loudly instead of poisoning the listing", () => {
    mkdirSync(paths.jobsDir, { recursive: true });
    writeFileSync(join(paths.jobsDir, "garbage.json"), "{not json");
    writeJobRecord({ ...base, pid: process.pid, startedAt: pidStartTime(process.pid) });
    expect(livingHeadlessJobs().map((j) => j.jobId)).toEqual(["job-1"]);
    expect(() => readFileSync(join(paths.jobsDir, "garbage.json"))).toThrow();
  });
});

describe("codex exec argv", () => {
  test("parses the Sume wrapper's launch shapes: fresh, resume, fork; keeps flags, drops id/prompt", () => {
    const fresh = parseCodexExecLaunch(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", 'model_reasoning_effort="high"', "-m", "gpt-5.5", "do the thing"]);
    expect(fresh).toEqual({ mode: "exec", sessionId: null, flags: ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", 'model_reasoning_effort="high"', "-m", "gpt-5.5"] });
    const resume = parseCodexExecLaunch(["exec", "resume", "--json", "--skip-git-repo-check", THREAD, "follow up"]);
    expect(resume).toEqual({ mode: "resume", sessionId: THREAD, flags: ["--json", "--skip-git-repo-check"] });
    const last = parseCodexExecLaunch(["exec", "resume", "--json", "--last", "follow up"]);
    expect(last).toEqual({ mode: "resume", sessionId: null, flags: ["--json"] });
    const fork = parseCodexExecLaunch(["exec", "fork", "--json", THREAD, "branch"]);
    expect(fork?.mode).toBe("fork");
    expect(fork?.sessionId).toBe(THREAD);
    // variadic images and `--flag=value` forms stay whole
    expect(parseCodexExecLaunch(["exec", "-i", "a.png", "b.png", "--color=never", "p"])?.flags).toEqual(["-i", "a.png", "b.png", "--color=never"]);
  });

  test("help/version/review/non-exec are not jobs", () => {
    expect(parseCodexExecLaunch(["exec", "--help"])).toBeNull();
    expect(parseCodexExecLaunch(["exec", "review"])).toBeNull();
    expect(parseCodexExecLaunch(["--version"])).toBeNull();
    expect(parseCodexExecLaunch([])).toBeNull();
    expect(parseCodexExecLaunch(["resume", "x"])).toBeNull();
  });

  test("the resume form continues the SAME thread with the flags and an EMPTY prompt", () => {
    expect(codexResumeArgs({ threadId: THREAD, flags: ["--json", "-c", "k=v"] })).toEqual(["exec", "resume", "--json", "-c", "k=v", THREAD, ""]);
  });
});

describe("supervisor launch classification", () => {
  test("codex: exec is headless-managed, the TUI stays interactive, utilities pass through", () => {
    expect(isHeadlessCodexLaunch({ argv: ["exec", "--json", "hi"] })).toBe(true);
    expect(isHeadlessCodexLaunch({ argv: ["exec", "resume", THREAD, "hi"] })).toBe(true);
    expect(isHeadlessCodexLaunch({ argv: [] })).toBe(false);
    expect(isHeadlessCodexLaunch({ argv: ["--version"] })).toBe(false);
    expect(isHeadlessCodexLaunch({ argv: ["login"] })).toBe(false);
    // the pre-existing classification is untouched: exec still reads as non-interactive
    expect(shouldManageCodex({ argv: ["exec", "hi"] })).toBe(false);
    expect(shouldManageCodex({ argv: [] })).toBe(true);
  });

  test("claude: -p with a prompt is headless; help/version, subcommands, picker resumes are not", () => {
    const p = analyzeArgs(["-p", "audit this", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]);
    expect(p.headless).toBe(true);
    expect(p.manage).toBe(false);
    const r = analyzeArgs(["-p", "x", "--resume", SID]);
    expect(r.headless).toBe(true);
    expect(r.resumeId).toBe(SID);
    expect(analyzeArgs(["--version"]).headless).toBe(false);
    expect(analyzeArgs(["-p", "x", "-r"]).headless).toBe(false); // picker resume: claude picks the sid
    expect(analyzeArgs(["mcp", "list"]).headless).toBe(false);
    expect(analyzeArgs(["-p", "x", "--session-id", "not-a-uuid"]).headless).toBe(false);
    expect(analyzeArgs(["-p", "x", "--resume", SID, "--fork-session"]).headless).toBe(false);
    // interactive classification is unchanged
    expect(analyzeArgs(["--model", "opus"]).manage).toBe(true);
    expect(analyzeArgs(["--model", "opus"]).headless).toBe(false);
  });

  test("grok: the respawn keeps the launch shape (-p, output format, model), drops the prompt and session selectors, adds --resume <sid>", () => {
    const argv = ["-p", "audit this", "--output-format", "streaming-messages-json", "--permission-mode", "bypassPermissions", "--always-approve", "--no-auto-update", "--resume", "old-sid", "--effort", "high"];
    expect(grokRespawnArgs({ argv, sessionId: "new-sid" })).toEqual([
      "-p", GROK_CONTINUATION_PROMPT, "--output-format", "streaming-messages-json", "--permission-mode", "bypassPermissions",
      "--always-approve", "--no-auto-update", "--effort", "high", "--resume", "new-sid",
    ]);
    // interactive: the one-shot positional prompt is never replayed; bare --resume when the sid is unknown
    expect(grokRespawnArgs({ argv: ["--model", "grok-4", "fix the tests", "-c"], sessionId: null })).toEqual(["--model", "grok-4", "--resume"]);
    expect(grokRespawnArgs({ argv: ["-s", "pinned", "--resume=abc", "--fork-session"], sessionId: "x" })).toEqual(["--resume", "x"]);
  });
});

describe("headless config", () => {
  test("defaults: managed on, greedy suppressed with jobs, 5 respawns 10s apart, 1h wait cap; keys are editable", () => {
    const cfg = loadConfig();
    expect(cfg.policy.headlessManage).toBe(true);
    expect(cfg.policy.headlessGreedyWithJobs).toBe(false);
    expect(cfg.policy.headlessMaxRespawns).toBe(5);
    expect(cfg.policy.headlessMinRespawnGapMs).toBe(10_000);
    expect(cfg.policy.headlessMaxWaitMs).toBe(3_600_000);
    for (const key of ["policy.headlessManage", "policy.headlessGreedyWithJobs", "policy.headlessMaxRespawns", "policy.headlessMinRespawnGapMs", "policy.headlessMaxWaitMs"]) {
      expect(KNOWN_KEYS as readonly string[]).toContain(key);
    }
    writeFileSync(paths.configJson, JSON.stringify({ policy: { headlessManage: false, headlessMaxRespawns: 0 } }));
    const off = loadConfig();
    expect(off.policy.headlessManage).toBe(false);
    expect(off.policy.headlessMaxRespawns).toBe(0);
  });
});
