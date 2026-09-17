// Managed-headless jobs (docs/auto-swap-long-sessions.md). A headless launch
// (`codex exec`, `claude -p`, `grok -p`) is a session-bearing process with no
// statusLine and, for codex, no Stop boundary: the only quota signal the
// supervisor can rely on is the server's REFUSAL, classified at process exit
// from the CLI's own on-disk session state (rollout / transcript), never from
// the live stdout stream (owner decision 2026-09-17: side-channel only) and
// never from assistant prose (the reverted Stop-hook text-sniffing lesson).
//
// This module is the backend-agnostic half: job records, the refusal text
// classifier, the codex/claude side channels, argv helpers, and the job loop
// itself (spawn gate → run → classify → swap → resume | wait | park). The
// backend adapters live next to their supervisors.

import { existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexPaths, paths } from "./paths.ts";
import { pidExists, pidStartTime } from "./proc.ts";
import { log } from "./log.ts";
import type { Config } from "./types.ts";

export const HEADLESS_JOB_ID_ENV = "TOKENMAXXING_JOB_ID";
/** sysexits EX_TEMPFAIL: the job is resumable later (a parked quota wait),
 *  distinct from a genuine failure. Wrappers key on it. */
export const EX_TEMPFAIL = 75;

const HeadlessBackendSchema = z.enum(["claude", "codex", "grok"]);
export type HeadlessBackend = z.infer<typeof HeadlessBackendSchema>;

// ---- job records ------------------------------------------------------------

export const JobRecordSchema = z.object({
  backend: HeadlessBackendSchema,
  jobId: z.string(),
  cwd: z.string(),
  /** the CLI's own session/thread id once known (argv, or the side channel). */
  sessionId: z.string().nullable(),
  /** the pooled account the current/last spawn ran on (codex account id,
   *  claude organizationUuid, grok account id). */
  accountId: z.string().nullable(),
  launchArgs: z.array(z.string()),
  respawns: z.number().int().nonnegative(),
  state: z.enum(["running", "waiting", "done", "failed", "parked"]),
  /** set while waiting / parked: when the soonest seat recovers. */
  waitUntil: z.number().nullable(),
  pid: z.number().nullable(),
  /** ps lstart of `pid` (process identity, never bare pid-aliveness). */
  startedAt: z.string().nullable(),
  reason: z.string().optional(),
  ts: z.number(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

function jobFile(jobId: string): string {
  return join(paths.jobsDir, `${jobId}.json`);
}

export function writeJobRecord(record: JobRecord): void {
  mkdirSync(paths.jobsDir, { recursive: true });
  writeFileAtomic(jobFile(record.jobId), JSON.stringify(JobRecordSchema.parse(record), null, 2) + "\n");
}

export function readJobRecord(jobId: string): JobRecord | null {
  const file = jobFile(jobId);
  if (!existsSync(file)) return null;
  return JobRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Jobs whose recorded process is still the SAME process (pid + lstart). A
 *  record that fails to parse is dropped loudly: job records are advisory
 *  (greedy suppression, wrapper status) - the account-protecting state is the
 *  codex/grok presence file, which keeps its fail-loud contract. */
export function livingHeadlessJobs(backend?: HeadlessBackend): JobRecord[] {
  const living: JobRecord[] = [];
  if (!existsSync(paths.jobsDir)) return living;
  for (const name of readdirSync(paths.jobsDir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(paths.jobsDir, name);
    let record: JobRecord;
    try {
      record = JobRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      const errno = z.object({ code: z.string() }).safeParse(e);
      if (errno.success && errno.data.code === "ENOENT") continue;
      rmSync(file, { force: true });
      log("headless.job_record_invalid", { file: name, err: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (backend != null && record.backend !== backend) continue;
    if (record.state !== "running" && record.state !== "waiting") continue;
    if (record.pid == null || record.startedAt == null) continue;
    const observed = pidStartTime(record.pid);
    if (observed !== record.startedAt) {
      // the same ambiguity rule as codex presence: a live pid whose start
      // time ps cannot read is left alone, a dead or recycled pid is stale.
      if (observed == null && pidExists(record.pid)) continue;
      continue;
    }
    living.push(record);
  }
  return living;
}

const JOB_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Drop finished records past the retention window (mirrors sessions/). */
export function pruneStaleJobs(now: number): void {
  if (!existsSync(paths.jobsDir)) return;
  for (const name of readdirSync(paths.jobsDir)) {
    const file = join(paths.jobsDir, name);
    try {
      if (now - statSync(file).mtimeMs > JOB_RETENTION_MS) rmSync(file, { force: true });
    } catch {
      // vanished between readdir and stat
    }
  }
}

// ---- refusal classification ------------------------------------------------

/** Server-side quota refusal families, matched by substring so display text
 *  can drift without silently disabling the classifier (the exact-match
 *  lesson from the Fable model gate). Verified 2026-09-17: codex 0.153.4
 *  "You've hit your usage limit ... try again at <date>"; Claude Code 2.1.258
 *  binary strings "You've hit your limit" and "out of extra usage"; the codex
 *  thread-status vocabulary `usage_limited` / `rate_limit_exceeded`. A bare
 *  "rate limit" is deliberately NOT a family: capacity blips (503/529) and
 *  tool output mentioning rate limits must never classify as quota. */
const REFUSAL_FAMILIES = [
  /hit your (usage )?limit/i,
  /usage limit reached/i,
  /out of extra usage/i,
  /\busage_limited\b/,
  /\brate_limit_exceeded\b/,
];

export function isQuotaRefusalText(text: string): boolean {
  return REFUSAL_FAMILIES.some((re) => re.test(text));
}

/** The last `bytes` of a file as UTF-8 text (whole file when smaller). */
function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Parsed JSON lines from a file tail; a partial first line (cut by the
 *  byte window) is skipped by the parse failure. */
function tailJsonLines(file: string, bytes: number): unknown[] {
  const out: unknown[] = [];
  for (const line of readTail(file, bytes).split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial or foreign line
    }
  }
  return out;
}

const TAIL_BYTES = 256 * 1024;
/** Clock slack between our spawn timestamp and the CLI's own stamps. */
const CLOCK_SLACK_MS = 5_000;

// ---- codex side channel ------------------------------------------------------

/** All rollout files under $CODEX_HOME/sessions (rollout-<ts>-<thread>.jsonl,
 *  nested by year/month/day; a directory is fine to scan whole - a few
 *  hundred entries). `minMtime` prunes the stat pass for the fresh-thread
 *  lookup. */
function codexRolloutFiles(input: { minMtime?: number } = {}): string[] {
  const root = join(codexPaths.home, "sessions");
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        if (input.minMtime != null && st.mtimeMs < input.minMtime) continue;
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

export function codexRolloutFor(input: { threadId: string }): string | null {
  return codexRolloutFiles().find((p) => p.endsWith(`-${input.threadId}.jsonl`)) ?? null;
}

const SessionMetaSchema = z.looseObject({
  type: z.literal("session_meta"),
  payload: z.looseObject({
    id: z.string(),
    timestamp: z.string(),
    cwd: z.string(),
  }),
});

const ThreadResolutionSchema = z.union([
  z.object({ kind: z.literal("id"), id: z.string() }),
  z.object({ kind: z.literal("ambiguous"), ids: z.array(z.string()) }),
  z.object({ kind: z.literal("none") }),
]);
export type ThreadResolution = z.infer<typeof ThreadResolutionSchema>;

/** Which thread a fresh `codex exec` (no id in argv) created: the rollout
 *  whose session_meta was stamped after our spawn under this cwd. Two
 *  candidates (parallel launches in one cwd, common on a desk) = ambiguous:
 *  the caller must NOT resume either - `resume --last` could revive a
 *  sibling's transcript (the codex hook's blank-id rule, extended). */
export function resolveCodexThreadId(input: { cwd: string; since: number; now: number }): ThreadResolution {
  const { cwd, since, now } = input;
  const ids: string[] = [];
  for (const file of codexRolloutFiles({ minMtime: since - CLOCK_SLACK_MS })) {
    let first: string;
    try {
      first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = SessionMetaSchema.safeParse(JSON.parse(first));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const at = Date.parse(parsed.data.payload.timestamp);
    if (Number.isNaN(at) || at < since - CLOCK_SLACK_MS || at > now + CLOCK_SLACK_MS) continue;
    if (parsed.data.payload.cwd !== cwd) continue;
    ids.push(parsed.data.payload.id);
  }
  if (ids.length === 1) return { kind: "id", id: ids[0]! };
  if (ids.length > 1) return { kind: "ambiguous", ids };
  return { kind: "none" };
}

const RolloutEventSchema = z.looseObject({
  timestamp: z.string().optional(),
  type: z.string().optional(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      message: z.string().optional(),
      error: z.looseObject({ message: z.string().optional() }).nullish(),
    })
    .optional(),
});

/** The quota-refusal message codex persisted for the thread's LAST turn, or
 *  null. Verified 2026-09-17 (0.153.4): the refused turn ends with an
 *  `event_msg` `task_complete` whose `error.message` carries the limit text
 *  (and the `--json` stream mirrors it as `error` + `turn.failed`). Only
 *  events stamped after our spawn count, so an old refusal in a resumed
 *  thread cannot re-classify a later clean failure. */
export function codexRolloutRefusal(input: { threadId: string; since: number }): string | null {
  const file = codexRolloutFor({ threadId: input.threadId });
  if (!file) return null;
  let found: string | null = null;
  for (const raw of tailJsonLines(file, TAIL_BYTES)) {
    const parsed = RolloutEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== "event_msg") continue;
    const at = parsed.data.timestamp != null ? Date.parse(parsed.data.timestamp) : Number.NaN;
    if (Number.isNaN(at) || at < input.since - CLOCK_SLACK_MS) continue;
    const message = parsed.data.payload?.error?.message ?? (parsed.data.payload?.type === "error" ? parsed.data.payload.message : undefined);
    if (message != null && isQuotaRefusalText(message)) found = message;
  }
  return found;
}

// ---- claude side channel -----------------------------------------------------

/** claude's project-dir slug: EVERY non-alphanumeric byte becomes "-"
 *  (binary-verified 2.1.215, mirrored from the supervisor's `-c` lookup). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeTranscriptFor(input: { sessionId: string; cwd: string }): string {
  return join(paths.claudeDir, "projects", claudeProjectSlug(input.cwd), `${input.sessionId}.jsonl`);
}

/** Which transcript a fresh `claude -p` without a pinned id wrote (a `-c`
 *  launch whose latest transcript we could not pre-resolve): the project-dir
 *  transcript whose first entry is stamped after our spawn. Same ambiguity
 *  rule as codex: two candidates = no resume. */
export function resolveClaudeSessionId(input: { cwd: string; since: number; now: number }): ThreadResolution {
  const dir = join(paths.claudeDir, "projects", claudeProjectSlug(input.cwd));
  if (!existsSync(dir)) return { kind: "none" };
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < input.since - CLOCK_SLACK_MS) continue;
    let first: unknown;
    try {
      first = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0] ?? "");
    } catch {
      continue;
    }
    const head = z.looseObject({ timestamp: z.string().optional(), sessionId: z.string().optional() }).safeParse(first);
    if (!head.success || head.data.timestamp == null) continue;
    const at = Date.parse(head.data.timestamp);
    if (Number.isNaN(at) || at < input.since - CLOCK_SLACK_MS || at > input.now + CLOCK_SLACK_MS) continue;
    ids.push(head.data.sessionId ?? name.replace(/\.jsonl$/, ""));
  }
  if (ids.length === 1) return { kind: "id", id: ids[0]! };
  if (ids.length > 1) return { kind: "ambiguous", ids };
  return { kind: "none" };
}

const TranscriptEntrySchema = z.looseObject({
  timestamp: z.string().optional(),
  type: z.string().optional(),
  isApiErrorMessage: z.boolean().optional(),
  content: z.unknown().optional(),
  message: z.looseObject({ content: z.unknown().optional() }).optional(),
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = z.looseObject({ type: z.string().optional(), text: z.string().optional() }).safeParse(part);
      return p.success && p.data.type === "text" ? (p.data.text ?? "") : "";
    })
    .join("\n");
}

/** The quota-refusal text claude recorded in the session transcript after our
 *  spawn, or null. Only API-error entries (`isApiErrorMessage`) and `system`
 *  entries are consulted: a tool result or an assistant turn that merely
 *  QUOTES a limit message must never classify (this very design was drafted
 *  by a session whose transcript is full of the strings). UNVERIFIED against
 *  a real refusal transcript as of 2026-09-17 - no claude worker on this desk
 *  has died on a limit since the pool existed; a miss here degrades to
 *  today's behavior (the job exits non-zero, nothing resumes). */
export function claudeTranscriptRefusal(input: { sessionId: string; cwd: string; since: number }): string | null {
  const file = claudeTranscriptFor({ sessionId: input.sessionId, cwd: input.cwd });
  if (!existsSync(file)) return null;
  let found: string | null = null;
  for (const raw of tailJsonLines(file, TAIL_BYTES)) {
    const parsed = TranscriptEntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const at = parsed.data.timestamp != null ? Date.parse(parsed.data.timestamp) : Number.NaN;
    if (Number.isNaN(at) || at < input.since - CLOCK_SLACK_MS) continue;
    if (parsed.data.isApiErrorMessage !== true && parsed.data.type !== "system") continue;
    const text = textOf(parsed.data.message?.content ?? parsed.data.content);
    if (isQuotaRefusalText(text)) found = text;
  }
  return found;
}

// ---- codex argv --------------------------------------------------------------

/** `codex exec` options that consume the NEXT token (verified against
 *  `codex exec --help` 0.153.4). `-i/--image <FILE>...` is variadic. Without
 *  this table a flag value would read as the prompt positional. */
const CODEX_EXEC_VALUE_FLAGS = new Set([
  "-c", "--config", "--enable", "--disable", "-m", "--model", "--local-provider",
  "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "--thread-source",
  "--output-schema", "--color", "-o", "--output-last-message",
]);
const CODEX_EXEC_VARIADIC_FLAGS = new Set(["-i", "--image"]);

const CodexExecLaunchSchema = z.object({
  /** `exec` | `exec resume` | `exec fork`; anything else is not a headless job. */
  mode: z.enum(["exec", "resume", "fork"]),
  /** the id given to resume/fork (null = `--last` or a fresh exec). */
  sessionId: z.string().nullable(),
  /** every flag (with its values) minus the subcommand, its id/--last, and the prompt. */
  flags: z.array(z.string()),
});
export type CodexExecLaunch = z.infer<typeof CodexExecLaunchSchema>;

/** Parse a `codex exec ...` argv into its persistable shape, or null when it
 *  is not a job (help/version, `exec review`, no `exec` at all). */
export function parseCodexExecLaunch(argv: string[]): CodexExecLaunch | null {
  if (argv[0] !== "exec") return null;
  let mode: CodexExecLaunch["mode"] = "exec";
  let sessionId: string | null = null;
  const flags: string[] = [];
  const positionals: string[] = [];
  let sawLast = false;
  let i = 1;
  if (argv[1] === "resume" || argv[1] === "fork") {
    mode = argv[1];
    i = 2;
  } else if (argv[1] === "review" || argv[1] === "help") {
    return null;
  }
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h" || a === "--version" || a === "-V") return null;
    if (a === "--last" && mode !== "exec") {
      sawLast = true;
      continue;
    }
    if (CODEX_EXEC_VALUE_FLAGS.has(a)) {
      flags.push(a);
      if (i + 1 < argv.length) flags.push(argv[++i]!);
      continue;
    }
    if (a.startsWith("--") && a.includes("=")) {
      flags.push(a);
      continue;
    }
    if (CODEX_EXEC_VARIADIC_FLAGS.has(a)) {
      flags.push(a);
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) flags.push(argv[++i]!);
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      flags.push(a);
      continue;
    }
    positionals.push(a);
  }
  // `[SESSION_ID] [PROMPT]`: the first positional is the id unless --last
  // picked the thread, in which case the only positional is the prompt.
  if (mode !== "exec" && !sawLast && positionals.length > 0) sessionId = positionals[0]!;
  return CodexExecLaunchSchema.parse({ mode, sessionId, flags });
}

/** The respawn form: continue the SAME thread on the freshly installed
 *  account with the original flags and an EMPTY prompt (owner decision
 *  2026-09-17: no injected continuation text; the main agent steers). Verified
 *  2026-09-17 on 0.153.4: `exec resume <id>` with no prompt argument exits 1
 *  locally ("No prompt provided via stdin"), `exec resume <id> ""` reaches
 *  the server. */
export function codexResumeArgs(input: { threadId: string; flags: string[] }): string[] {
  return ["exec", "resume", ...input.flags, input.threadId, ""];
}

// ---- the job loop -----------------------------------------------------------

/** The subset of Bun.Subprocess the loop needs (mockable). */
export interface HeadlessChild {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

const RefusalDecisionSchema = z.object({
  swapped: z.boolean(),
  /** label of the seat landed on (banner text), when known */
  account: z.string().nullable(),
  /** the soonest recovery when nothing is usable now */
  waitUntil: z.number().nullable(),
  reason: z.string(),
});
export type RefusalDecision = z.infer<typeof RefusalDecisionSchema>;

/** What a backend supplies to the shared loop. Every method may throw; the
 *  loop turns throws into a logged, non-resuming exit (never a spin). */
export interface HeadlessAdapter {
  backend: HeadlessBackend;
  /** the pooled identity of the live seat right now (null: absent/unpooled) */
  liveAccountId(): string | null;
  /** run the pool decision before a spawn (free reads; may swap) */
  spawnGate(): Promise<{ swapped: boolean; reason: string }>;
  /** spawn the CLI (under the pool flock with presence where the backend has
   *  one) and report which account it was seated on */
  spawn(input: { args: string[]; jobId: string }): Promise<{ child: HeadlessChild; accountId: string | null }>;
  /** presence cleanup after the child is gone */
  afterExit(input: { jobId: string }): void;
  /** the session/thread id when the launch already names it (argv or a
   *  pinned id) - recorded at spawn so a parked/running job record is
   *  resumable without waiting for a refusal */
  knownSessionId(input: { launchArgs: string[] }): string | null;
  /** the session/thread id: from argv when given, else the side channel */
  resolveSessionId(input: { launchArgs: string[]; spawnedAt: number; now: number }): ThreadResolution;
  /** the refusal text the CLI persisted for this run, or null (not a refusal);
   *  `resolution` lets an ambiguous fresh thread still be classified */
  refusalEvidence(input: { sessionId: string | null; resolution: ThreadResolution; spawnedAt: number; now: number }): string | null;
  /** after a classified refusal on `refusedAccountId`: move the seat, or say
   *  it already moved ("seat-moved"), or report the soonest recovery */
  refusalDecision(input: { refusedAccountId: string | null }): Promise<RefusalDecision>;
  /** the resume form for this backend */
  resumeArgs(input: { sessionId: string; originalArgv: string[] }): string[];
}

export interface HeadlessLoopInput {
  adapter: HeadlessAdapter;
  argv: string[];
  cfg: Config;
  cwd: string;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** where the one-line banners go (stderr by default: stdout is the stream) */
  say?: (line: string) => void;
}

/** Run one managed-headless job to completion. Returns the exit code to
 *  propagate: the CLI's own on a clean or non-quota exit, EX_TEMPFAIL (75)
 *  when the job is parked on a quota wait the wrapper should re-enqueue. */
export async function runHeadlessJob(input: HeadlessLoopInput): Promise<number> {
  const { adapter, argv, cfg, cwd } = input;
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = input.now ?? (() => Date.now());
  const say = input.say ?? ((line: string) => process.stderr.write(`\x1b[36mtokenmaxxing: ${line}\x1b[0m\n`));
  const jobId = crypto.randomUUID();
  const policy = cfg.policy;

  let launchArgs = argv;
  let sessionId: string | null = null;
  let respawns = 0;
  let lastSpawnAt: number | null = null;
  const record = (over: Partial<JobRecord>): JobRecord => {
    const base: JobRecord = {
      backend: adapter.backend,
      jobId,
      cwd,
      sessionId,
      accountId: null,
      launchArgs,
      respawns,
      state: "running",
      waitUntil: null,
      pid: null,
      startedAt: null,
      ts: now(),
      ...over,
    };
    writeJobRecord(base);
    return base;
  };
  pruneStaleJobs(now());

  while (true) {
    // spawn gate: a free decision, never fatal (a probe hiccup must not stop
    // the job from launching on whatever seat is live).
    try {
      const gate = await adapter.spawnGate();
      if (gate.swapped) say(`switched ${adapter.backend} to a fresher account before launch (${gate.reason})`);
      log("headless.gate", { backend: adapter.backend, job: jobId.slice(0, 8), swapped: gate.swapped, reason: gate.reason });
    } catch (e) {
      log("headless.gate_error", { backend: adapter.backend, job: jobId.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
    }

    if (lastSpawnAt != null) {
      const gap = policy.headlessMinRespawnGapMs - (now() - lastSpawnAt);
      if (gap > 0) await sleep(gap);
    }
    const spawnedAt = now();
    lastSpawnAt = spawnedAt;
    sessionId = adapter.knownSessionId({ launchArgs }) ?? sessionId;
    const { child, accountId } = await adapter.spawn({ args: launchArgs, jobId });
    const startedAt = pidStartTime(child.pid);
    record({ accountId, pid: child.pid, startedAt, state: "running" });
    log("headless.launch", { backend: adapter.backend, job: jobId.slice(0, 8), respawns, args: launchArgs.join(" ") });

    // a SIGTERM to the supervisor (wrapper steer / kill) ends the job: forward
    // it and let the signal exit below stand - a killed child is never a refusal.
    const onTerm = () => child.kill("SIGTERM");
    process.on("SIGTERM", onTerm);
    await child.exited;
    process.removeListener("SIGTERM", onTerm);
    adapter.afterExit({ jobId });
    const code = child.exitCode ?? (child.signalCode ? 1 : 0);

    if (child.signalCode != null) {
      record({ accountId, state: "failed", reason: `signal ${child.signalCode}` });
      log("headless.exit", { backend: adapter.backend, job: jobId.slice(0, 8), signal: child.signalCode });
      return code;
    }
    if (code === 0) {
      record({ accountId, state: "done" });
      log("headless.exit", { backend: adapter.backend, job: jobId.slice(0, 8), code });
      return 0;
    }

    // non-zero: classify. Any throw here means "not a refusal" - the CLI's
    // own exit code stands and nothing resumes.
    let evidence: string | null = null;
    let resolution: ThreadResolution = { kind: "none" };
    try {
      resolution = adapter.resolveSessionId({ launchArgs, spawnedAt, now: now() });
      if (resolution.kind === "id") sessionId = resolution.id;
      evidence = adapter.refusalEvidence({ sessionId, resolution, spawnedAt, now: now() });
    } catch (e) {
      log("headless.classify_error", { backend: adapter.backend, job: jobId.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
    }
    if (evidence == null) {
      record({ accountId, state: "failed", reason: `exit ${code}` });
      log("headless.exit", { backend: adapter.backend, job: jobId.slice(0, 8), code });
      return code;
    }
    log("headless.refusal", { backend: adapter.backend, job: jobId.slice(0, 8), account: accountId?.slice(0, 8) ?? null, session: sessionId?.slice(0, 8) ?? null });
    say(`${adapter.backend} refused the turn on a quota limit - switching accounts`);

    // move the seat FIRST, whatever happens to this job: the next steer/resume
    // must not land on the walled account either.
    let decision: RefusalDecision;
    try {
      decision = await adapter.refusalDecision({ refusedAccountId: accountId });
    } catch (e) {
      log("headless.decision_error", { backend: adapter.backend, job: jobId.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
      record({ accountId, state: "failed", reason: "swap failed" });
      return code;
    }
    log("headless.decision", { backend: adapter.backend, job: jobId.slice(0, 8), ...decision });

    if (resolution.kind !== "id" || sessionId == null) {
      const why = resolution.kind === "ambiguous" ? "ambiguous session id" : "unknown session id";
      record({ accountId, state: "parked", reason: why, waitUntil: decision.waitUntil });
      say(`cannot resume: ${why} - parked (exit ${EX_TEMPFAIL}); the seat is ${decision.swapped ? "switched" : "unchanged"}`);
      return EX_TEMPFAIL;
    }
    if (respawns >= policy.headlessMaxRespawns) {
      record({ accountId, state: "parked", reason: "respawn cap", waitUntil: decision.waitUntil });
      say(`respawn cap (${policy.headlessMaxRespawns}) reached - parked (exit ${EX_TEMPFAIL})`);
      return EX_TEMPFAIL;
    }

    if (!decision.swapped && decision.reason !== "seat-moved") {
      const wait = decision.waitUntil != null ? decision.waitUntil - now() : Number.POSITIVE_INFINITY;
      if (!(wait <= policy.headlessMaxWaitMs)) {
        record({ accountId, state: "parked", reason: decision.reason, waitUntil: decision.waitUntil });
        say(`every account is at its limit - parked (exit ${EX_TEMPFAIL}); resume ${adapter.backend} session ${sessionId} later`);
        return EX_TEMPFAIL;
      }
      record({ accountId, state: "waiting", reason: decision.reason, waitUntil: decision.waitUntil });
      say(`every account is at its limit - waiting ${Math.ceil(wait / 60_000)}m for the soonest reset`);
      if (wait > 0) await sleep(wait);
    } else if (decision.swapped) {
      say(`switched ${adapter.backend} to ${decision.account ?? "a fresher account"} - resuming ${sessionId}`);
    } else {
      say(`the seat already moved - resuming ${sessionId}`);
    }
    respawns++;
    launchArgs = adapter.resumeArgs({ sessionId, originalArgv: argv });
  }
}
