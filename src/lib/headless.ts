import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { evaluateAndMaybeSwap } from "./decide.ts";
import { log } from "./log.ts";
import { claudeTranscriptFor, codexPaths, paths } from "./paths.ts";
import { pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { pidExists, pidStartTime } from "./proc.ts";
import type { Provider } from "./provider.ts";
import { loadAccounts, loadConfig } from "./state.ts";
import { classifyEnforcedLimit, readTranscriptTail, type EnforcedClass } from "./usage.ts";
import { JsonTextSchema, type Account, type Config, type EnforcedLimit } from "./types.ts";

export const HEADLESS_JOB_ID_ENV = "TOKENMAXXING_JOB_ID";
export const EX_TEMPFAIL = 75;

const HeadlessBackendSchema = z.enum(["claude", "codex", "grok"]);
export type HeadlessBackend = z.infer<typeof HeadlessBackendSchema>;

export const JobRecordSchema = z.object({
  backend: HeadlessBackendSchema,
  jobId: z.string(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  accountId: z.string().nullable(),
  launchArgs: z.array(z.string()),
  respawns: z.number().int().nonnegative(),
  state: z.enum(["running", "waiting", "done", "failed", "parked"]),
  waitUntil: z.number().nullable(),
  pid: z.number().nullable(),
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
    if (pidStartTime(record.pid) !== record.startedAt) {
      if (pidStartTime(record.pid) == null && pidExists(record.pid)) continue;
      continue;
    }
    living.push(record);
  }
  return living;
}

const JOB_RETENTION_MS = 30 * 24 * 3600 * 1000;

export function pruneStaleJobs(now: number): void {
  if (!existsSync(paths.jobsDir)) return;
  for (const name of readdirSync(paths.jobsDir)) {
    const file = join(paths.jobsDir, name);
    try {
      if (now - statSync(file).mtimeMs > JOB_RETENTION_MS) rmSync(file, { force: true });
    } catch {}
  }
}

const REFUSAL_FAMILIES = [/hit your (usage )?limit/i, /usage limit reached/i, /out of extra usage/i, /\busage_limited\b/, /\brate_limit_exceeded\b/];

export function isQuotaRefusalText(text: string): boolean {
  return REFUSAL_FAMILIES.some((re) => re.test(text));
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseRefusalReset(text: string, now = Date.now()): number | null {
  const m = text.match(/try again (?:at|after|on)\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(?:(\d{1,2}):(\d{2})\s*([AaPp])[Mm])?/);
  if (!m) return null;
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const year = m[3] != null ? Number(m[3]) : new Date(now).getFullYear();
  let hour = m[4] != null ? Number(m[4]) % 12 : 0;
  if (m[6]?.toLowerCase() === "p") hour += 12;
  const t = new Date(year, month, Number(m[2]), hour, m[5] != null ? Number(m[5]) : 0).getTime();
  return Number.isFinite(t) ? t : null;
}

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

function tailJsonLines(file: string, bytes: number): unknown[] {
  const out: unknown[] = [];
  for (const line of readTail(file, bytes).split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JsonTextSchema.safeParse(line);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const TAIL_BYTES = 256 * 1024;
const CLOCK_SLACK_MS = 5_000;

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
  payload: z.looseObject({ id: z.string(), timestamp: z.string(), cwd: z.string() }),
});

const ThreadResolutionSchema = z.union([
  z.object({ kind: z.literal("id"), id: z.string() }),
  z.object({ kind: z.literal("ambiguous"), ids: z.array(z.string()) }),
  z.object({ kind: z.literal("none") }),
]);
export type ThreadResolution = z.infer<typeof ThreadResolutionSchema>;

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
    const parsed = SessionMetaSchema.safeParse(JsonTextSchema.safeParse(first).data);
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

export function resolveClaudeSessionId(input: { cwd: string; since: number; now: number }): ThreadResolution {
  const dir = join(claudeTranscriptFor("x", input.cwd), "..");
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
    let first: string;
    try {
      first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    } catch {
      continue;
    }
    const head = z.looseObject({ timestamp: z.string().optional(), sessionId: z.string().optional() }).safeParse(JsonTextSchema.safeParse(first).data);
    if (!head.success || head.data.timestamp == null) continue;
    const at = Date.parse(head.data.timestamp);
    if (Number.isNaN(at) || at < input.since - CLOCK_SLACK_MS || at > input.now + CLOCK_SLACK_MS) continue;
    ids.push(head.data.sessionId ?? name.replace(/\.jsonl$/, ""));
  }
  if (ids.length === 1) return { kind: "id", id: ids[0]! };
  if (ids.length > 1) return { kind: "ambiguous", ids };
  return { kind: "none" };
}

export function claudeTranscriptRefusal(input: { sessionId: string; cwd: string; since: number; switchModels: string[] }): EnforcedClass | null {
  const file = claudeTranscriptFor(input.sessionId, input.cwd);
  if (!existsSync(file)) return null;
  let found: EnforcedClass | null = null;
  for (const row of readTranscriptTail(file, TAIL_BYTES)) {
    if (row.isApiErrorMessage !== true || row.error !== "rate_limit") continue;
    const at = row.timestamp != null ? Date.parse(row.timestamp) : Number.NaN;
    if (Number.isNaN(at) || at < input.since - CLOCK_SLACK_MS) continue;
    const limit = classifyEnforcedLimit(row, input.switchModels);
    if (limit) found = limit;
  }
  return found;
}

const CODEX_EXEC_VALUE_FLAGS = new Set([
  "-c", "--config", "--enable", "--disable", "-m", "--model", "--local-provider",
  "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "--thread-source",
  "--output-schema", "--color", "-o", "--output-last-message",
]);
const CODEX_EXEC_VARIADIC_FLAGS = new Set(["-i", "--image"]);

const CodexExecLaunchSchema = z.object({
  mode: z.enum(["exec", "resume", "fork"]),
  sessionId: z.string().nullable(),
  flags: z.array(z.string()),
});
export type CodexExecLaunch = z.infer<typeof CodexExecLaunchSchema>;

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
  if (mode !== "exec" && !sawLast && positionals.length > 0) sessionId = positionals[0]!;
  return CodexExecLaunchSchema.parse({ mode, sessionId, flags });
}

export function codexResumeArgs(input: { threadId: string; flags: string[]; prompt: string }): string[] {
  return ["exec", "resume", ...input.flags, input.threadId, input.prompt];
}

export interface HeadlessChild {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

const PlacementSchema = z.union([
  z.object({ kind: z.literal("seat"), account: z.custom<Account>() }),
  z.object({ kind: z.literal("wait"), until: z.number(), account: z.custom<Account>().nullable() }),
  z.object({ kind: z.literal("none") }),
]);
export type Placement = z.infer<typeof PlacementSchema>;

export const RefusalSchema = z.object({ kind: z.enum(["session", "weekly", "model"]), family: z.string().nullable(), resetsAt: z.number().nullable(), text: z.string() });
export type Refusal = z.infer<typeof RefusalSchema>;

export interface HeadlessAdapter {
  backend: HeadlessBackend;
  provider: Provider;
  place(input: { wanted: string | null; now: number }): Promise<Placement>;
  spawn(input: { args: string[]; jobId: string; seat: Account }): Promise<HeadlessChild>;
  afterExit(input: { jobId: string }): void;
  knownSessionId(input: { launchArgs: string[] }): string | null;
  resolveSessionId(input: { launchArgs: string[]; spawnedAt: number; now: number }): ThreadResolution;
  refusal(input: { sessionId: string | null; resolution: ThreadResolution; spawnedAt: number; now: number }): Refusal | null;
  resumeArgs(input: { sessionId: string; originalArgv: string[] }): string[];
}

export async function moveAfterRefusal(input: { p: Provider; seat: Account; refusal: Refusal; now: number }): Promise<Placement> {
  const { p, seat, refusal, now } = input;
  const enforced: EnforcedLimit = { account: seat.id, kind: refusal.kind, family: refusal.family, resetsAt: refusal.resetsAt, blind: false };
  const d = await evaluateAndMaybeSwap(p, now, true, enforced, { seatId: seat.id });
  log("headless.decision", { backend: p.name, reason: d.reason, swapped: d.swapped, account: d.account?.id.slice(0, 8), waitUntil: d.waitUntil });
  if (d.swapped && d.account) return { kind: "seat", account: d.account };
  if (d.waitUntil != null) return { kind: "wait", until: d.waitUntil, account: d.account };
  const cfg = loadConfig();
  const idx = loadAccounts(p.pool);
  const present = p.presence();
  const ctx: PickCtx = { now, thresholds: thresholdBars(cfg), currentId: seat.id, families: p.gatedFamilies(cfg), seats: p.seats === "shared" ? present : null };
  const candidates = idx.accounts.filter((a) => p.seats === "shared" || !present.has(a.id));
  const soonest = pickEarliestReset(candidates, ctx) ?? pickEarliestReset(idx.accounts, ctx);
  if (soonest) return { kind: "wait", until: soonest.availableAt, account: soonest.account };
  return { kind: "none" };
}

export interface HeadlessLoopInput {
  adapter: HeadlessAdapter;
  argv: string[];
  cfg: Config;
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  say?: (line: string) => void;
  move?: typeof moveAfterRefusal;
}

export async function runHeadlessJob(input: HeadlessLoopInput): Promise<number> {
  const { adapter, argv, cfg, cwd } = input;
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = input.now ?? (() => Date.now());
  const say = input.say ?? ((line: string) => process.stderr.write(`\x1b[36mtokenmaxxing: ${line}\x1b[0m\n`));
  const move = input.move ?? moveAfterRefusal;
  const jobId = crypto.randomUUID();
  const policy = cfg.policy;

  let launchArgs = argv;
  let sessionId: string | null = null;
  let respawns = 0;
  let lastSpawnAt: number | null = null;
  let wanted: string | null = null;
  let waitsTaken = 0;
  const record = (over: Partial<JobRecord>): void => {
    writeJobRecord({
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
    });
  };
  const park = (reason: string, waitUntil: number | null, accountId: string | null): number => {
    record({ accountId, state: "parked", reason, waitUntil });
    say(`${reason} - parked (exit ${EX_TEMPFAIL})${sessionId ? `; resume ${adapter.backend} session ${sessionId} later` : ""}`);
    log("headless.parked", { backend: adapter.backend, job: jobId.slice(0, 8), reason, waitUntil });
    return EX_TEMPFAIL;
  };
  const waitOrPark = async (until: number, accountId: string | null, why: string): Promise<number | null> => {
    const wait = until - now();
    if (!(wait <= policy.headlessMaxWaitMs) || waitsTaken >= policy.headlessMaxRespawns) return park(why, until, accountId);
    waitsTaken++;
    record({ accountId, state: "waiting", reason: why, waitUntil: until });
    say(`${why} - waiting ${Math.max(1, Math.ceil(wait / 60_000))}m for the soonest reset`);
    if (wait > 0) await sleep(wait);
    return null;
  };
  pruneStaleJobs(now());

  while (true) {
    sessionId = adapter.knownSessionId({ launchArgs }) ?? sessionId;
    let placement: Placement;
    try {
      placement = await adapter.place({ wanted, now: now() });
    } catch (e) {
      log("headless.place_error", { backend: adapter.backend, job: jobId.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
      record({ state: "failed", reason: "placement failed" });
      say(`could not place the job on a pooled account (${e instanceof Error ? e.message : String(e)})`);
      return 1;
    }
    if (placement.kind === "none") return park("no pooled account can take the job", null, null);
    if (placement.kind === "wait") {
      const parked = await waitOrPark(placement.until, placement.account?.id ?? null, "every account is at its limit");
      if (parked != null) return parked;
      wanted = placement.account?.id ?? null;
      continue;
    }
    wanted = null;
    const seat = placement.account;

    if (lastSpawnAt != null) {
      const gap = policy.headlessMinRespawnGapMs - (now() - lastSpawnAt);
      if (gap > 0) await sleep(gap);
    }
    const spawnedAt = now();
    lastSpawnAt = spawnedAt;
    const child = await adapter.spawn({ args: launchArgs, jobId, seat });
    record({ accountId: seat.id, pid: child.pid, startedAt: pidStartTime(child.pid), state: "running" });
    log("headless.launch", { backend: adapter.backend, job: jobId.slice(0, 8), seat: seat.id.slice(0, 8), respawns, args: launchArgs.join(" ") });

    const onTerm = () => child.kill("SIGTERM");
    process.on("SIGTERM", onTerm);
    await child.exited;
    process.removeListener("SIGTERM", onTerm);
    adapter.afterExit({ jobId });
    const code = child.exitCode ?? (child.signalCode ? 1 : 0);

    if (child.signalCode != null) {
      record({ accountId: seat.id, state: "failed", reason: `signal ${child.signalCode}` });
      log("headless.exit", { backend: adapter.backend, job: jobId.slice(0, 8), signal: child.signalCode });
      return code;
    }
    if (code === 0) {
      record({ accountId: seat.id, state: "done" });
      log("headless.exit", { backend: adapter.backend, job: jobId.slice(0, 8), code });
      return 0;
    }

    let refusal: Refusal | null = null;
    let resolution: ThreadResolution = { kind: "none" };
    try {
      resolution = adapter.resolveSessionId({ launchArgs, spawnedAt, now: now() });
      if (resolution.kind === "id") sessionId = resolution.id;
      refusal = adapter.refusal({ sessionId, resolution, spawnedAt, now: now() });
    } catch (e) {
      log("headless.classify_error", { backend: adapter.backend, job: jobId.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
    }
    if (refusal == null) {
      record({ accountId: seat.id, state: "failed", reason: `exit ${code}` });
      log("headless.exit", { backend: adapter.backend, job: jobId.slice(0, 8), code });
      return code;
    }
    log("headless.refusal", { backend: adapter.backend, job: jobId.slice(0, 8), seat: seat.id.slice(0, 8), kind: refusal.kind, resetsAt: refusal.resetsAt, session: sessionId?.slice(0, 8) ?? null });
    say(`${adapter.backend} refused the turn on a quota limit (${refusal.kind}) - moving the job`);

    let next: Placement;
    try {
      next = await move({ p: adapter.provider, seat, refusal, now: now() });
    } catch (e) {
      log("headless.decision_error", { backend: adapter.backend, job: jobId.slice(0, 8), err: e instanceof Error ? e.message : String(e) });
      record({ accountId: seat.id, state: "failed", reason: "move failed" });
      return code;
    }

    if (resolution.kind !== "id" || sessionId == null) {
      return park(resolution.kind === "ambiguous" ? "cannot resume: ambiguous session id" : "cannot resume: unknown session id", next.kind === "wait" ? next.until : null, seat.id);
    }
    if (respawns >= policy.headlessMaxRespawns) return park(`respawn cap (${policy.headlessMaxRespawns}) reached`, next.kind === "wait" ? next.until : null, seat.id);

    if (next.kind === "none") return park("no pooled account can take the job", null, seat.id);
    if (next.kind === "wait") {
      const parked = await waitOrPark(next.until, next.account?.id ?? null, "every account is at its limit");
      if (parked != null) return parked;
      wanted = next.account?.id ?? null;
    } else {
      say(`moving ${adapter.backend} to ${next.account.label} - resuming ${sessionId}`);
      wanted = next.account.id;
    }
    respawns++;
    launchArgs = adapter.resumeArgs({ sessionId, originalArgv: argv });
  }
}
