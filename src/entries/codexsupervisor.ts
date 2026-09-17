// The `codex` supervisor. Invoked in place of codex (via ~/.config/tokenmaxxing/
// bin/codex on PATH). Codex REQUIRES a restart to change accounts: a running
// process refuses an auth.json swap to a different account (verified
// rust-v0.144.5 reload_if_account_id_matches), so unlike the claude supervisor
// (whose child hot-adopts swaps) this respawn IS the switch mechanism, not just
// UX. The codex Stop hook performs the swap at an idle turn boundary and drops
// a marker keyed by THIS supervisor's id (passed down via env, so N concurrent
// sessions pair correctly); the supervisor then SIGTERMs its child and
// relaunches `codex resume <session-id>` on the freshly-installed account.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths, paths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { resolveRealCodex } from "../lib/codexbin.ts";
import { clearCodexPresence, writeCodexPresence } from "../lib/codexpresence.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { evaluateAndMaybeSwapCodex } from "../lib/codexdecide.ts";
import { isCodexExhausted } from "../lib/codexpick.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { loadConfig } from "../lib/state.ts";
import { effectiveBars } from "../lib/picker.ts";
import {
  HEADLESS_JOB_ID_ENV,
  codexResumeArgs,
  codexRolloutRefusal,
  parseCodexExecLaunch,
  resolveCodexThreadId,
  runHeadlessJob,
  type CodexExecLaunch,
  type HeadlessAdapter,
} from "../lib/headless.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { CodexRespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

export const CODEX_SUPERVISOR_ID_ENV = "TOKENMAXXING_CODEX_SUPERVISOR_ID";

/** Subcommands that never host an interactive session worth managing. */
const NONINTERACTIVE_SUBCMDS = new Set([
  "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

/** Read + validate a codex respawn marker. An unparseable one (version-skew
 *  hook, corruption) is dropped loudly and reported as absent: the watcher
 *  checks validity BEFORE the SIGTERM, so garbage never kills the session, and
 *  the post-exit consume never throws after the child is already dead (PR #36
 *  review catch, mirroring the claude supervisor). */
function consumableCodexMarker(marker: string): z.infer<typeof CodexRespawnMarkerSchema> | null {
  try {
    return CodexRespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    rmSync(marker, { force: true });
    log("codexsupervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Root options that consume the NEXT token as their value (verified against
 *  `codex --help` 0.144.4): without skipping them, `codex -m gpt exec ...`
 *  would read "gpt" as the subcommand and wrongly supervise an exec run. */
const VALUE_TAKING_ROOT_FLAGS = new Set([
  "-c", "--config", "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--enable",
]);

/** A managed-headless launch: `codex exec [resume|fork] ...` (never help /
 *  version / `exec review`). Passthrough and interactive classification are
 *  unchanged; this is the third class docs/auto-swap-long-sessions.md §4.1 adds. */
export function isHeadlessCodexLaunch(input: { argv: string[] }): boolean {
  if (process.env.TOKENMAXXING_PROBE) return false;
  return parseCodexExecLaunch(input.argv) != null;
}

export function shouldManageCodex(input: { argv: string[] }): boolean {
  if (process.env.TOKENMAXXING_PROBE) return false;
  let firstPositional: string | null = null;
  for (let i = 0; i < input.argv.length; i++) {
    const arg = input.argv[i]!;
    if (PASSTHROUGH_FLAGS.has(arg)) return false;
    if (VALUE_TAKING_ROOT_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-") && firstPositional === null) firstPositional = arg;
  }
  return firstPositional === null || !NONINTERACTIVE_SUBCMDS.has(firstPositional);
}

/** Spawn the real codex on the live seat and declare that seat RUNNING.
 *  Read + presence-write + spawn run under the codex FLOCK (closing-review
 *  catch): unlocked, a swap could land between the read and the child's
 *  auth.json read, seating the child on the NEW account while presence named
 *  the old one for the session's whole life - un-benching the running account
 *  for samplers and the picker. Under the flock no swap can interleave until
 *  after the spawn; the residual window (child startup vs a swap acquiring the
 *  lock immediately after) is sub-ms in practice against a swap's
 *  network-bound critical section.
 *
 *  Presence pins the CHILD's pid, written after the spawn (still inside the
 *  flock): the session IS the codex process, and pinning the supervisor's pid
 *  let a SIGKILLed supervisor prune the presence while its orphaned codex
 *  kept rotating the account's token (closing-review catch). Brief retries
 *  cover ps visibility lag on a just-spawned pid. FAIL CLOSED on final
 *  failure (PR #36 review catch): a session running without presence is
 *  exactly the unprotected state presence exists to prevent - its account
 *  would look swappable and samplable - so kill the just-spawned child
 *  (nothing is in flight yet) and surface the error instead of running
 *  unprotected. Shared by the TUI loop and the managed-headless loop
 *  (`headless` marks the presence so the reconcile sweep skips it). */
async function spawnCodexSeated(input: {
  real: string;
  args: string[];
  env: Record<string, string | undefined>;
  supervisorId: string;
  savedTermios: string | null;
  headless?: boolean;
}): Promise<{ child: ReturnType<typeof Bun.spawn>; accountId: string | null }> {
  return withLock(codexPaths.lockFile, async () => {
    const spawnAccountId = liveCodexAccountId();
    const spawned = Bun.spawn([input.real, ...input.args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: input.env,
    });
    if (spawnAccountId) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          writeCodexPresence({ supervisorId: input.supervisorId, accountId: spawnAccountId, pid: spawned.pid, headless: input.headless });
          break;
        } catch (e) {
          // a child that already exited needs no presence (its absence is
          // correct) and must keep its own exit result - the normal exit
          // path handles it (PR #36 second-round catch)
          if (spawned.exitCode !== null || spawned.signalCode !== null) break;
          if (attempt === 9) {
            log("codexsupervisor.presence_failed", { err: e instanceof Error ? e.message : String(e) });
            spawned.kill();
            // the child may have entered raw mode during the retries: await
            // its death and restore the terminal before surfacing (PR #36
            // second-round catch)
            await spawned.exited;
            restoreTermios(input.savedTermios);
            throw new Error("could not write the codex presence file - refusing to run an unprotected session (its account would look like a swap target)");
          }
          await Bun.sleep(100);
        }
      }
    }
    return { child: spawned, accountId: spawnAccountId };
  });
}

/** The managed-headless adapter for `codex exec` (docs/auto-swap-long-sessions.md
 *  §4). Codex cannot hot-adopt, so the spawn gate is the free switch point and
 *  a refusal is answered by `exec resume <thread> "" ` on the fresh seat. */
function codexHeadlessAdapter(input: { real: string; childEnv: Record<string, string | undefined>; launch: CodexExecLaunch; cwd: string }): HeadlessAdapter {
  const { real, childEnv, launch, cwd } = input;
  return {
    backend: "codex",
    liveAccountId: () => liveCodexAccountId(),
    spawnGate: async () => {
      const d = await evaluateAndMaybeSwapCodex({ boundary: "spawn" });
      return { swapped: d.swapped, reason: d.reason };
    },
    spawn: async ({ args, jobId }) => {
      // UNMANAGED for the whole subtree: an agent inside the job running
      // `codex exec` (or claude/grok) reaches the real binary as a plain
      // child instead of nesting a second job around the outer one.
      const { child, accountId } = await spawnCodexSeated({
        real,
        args,
        env: { ...childEnv, [UNMANAGED_ENV]: "1", [HEADLESS_JOB_ID_ENV]: jobId },
        supervisorId: jobId,
        savedTermios: null,
        headless: true,
      });
      return { child, accountId };
    },
    afterExit: ({ jobId }) => clearCodexPresence({ supervisorId: jobId }),
    knownSessionId: ({ launchArgs }) => {
      const parsed = parseCodexExecLaunch(launchArgs);
      return parsed?.mode === "resume" ? parsed.sessionId : null;
    },
    resolveSessionId: ({ launchArgs, spawnedAt, now }) => {
      // `exec resume <id>` names its thread; a fresh exec (or a fork, which
      // mints a NEW id) is learned from the rollout codex wrote for this cwd.
      const parsed = parseCodexExecLaunch(launchArgs);
      if (parsed?.mode === "resume" && parsed.sessionId != null) return { kind: "id", id: parsed.sessionId };
      return resolveCodexThreadId({ cwd, since: spawnedAt, now });
    },
    refusalEvidence: ({ sessionId, resolution, spawnedAt }) => {
      // an ambiguous fresh thread still swaps the seat when ANY candidate
      // rollout shows the refusal (the loop then parks rather than resuming
      // a sibling's transcript).
      const ids = sessionId != null ? [sessionId] : resolution.kind === "ambiguous" ? resolution.ids : [];
      for (const id of ids) {
        const found = codexRolloutRefusal({ threadId: id, since: spawnedAt });
        if (found != null) return found;
      }
      return null;
    },
    refusalDecision: async ({ refusedAccountId }) => {
      // a sibling may already have moved the seat: resume on it without a
      // second swap (the codex analog of decide.ts's raced-already-swapped).
      const live = liveCodexAccountId();
      if (live != null && refusedAccountId != null && live !== refusedAccountId) {
        const seat = loadCodexAccounts().accounts.find((account) => account.accountId === live);
        if (seat && seat.needsReauth !== true && !isCodexExhausted({ account: seat, thresholds: effectiveBars(loadConfig()), now: Date.now() })) {
          return { swapped: false, account: seat.label, waitUntil: null, reason: "seat-moved" };
        }
      }
      const d = await evaluateAndMaybeSwapCodex({ boundary: "refusal" });
      return { swapped: d.swapped, account: d.account?.label ?? null, waitUntil: d.waitUntil ?? null, reason: d.reason };
    },
    resumeArgs: ({ sessionId }) => codexResumeArgs({ threadId: sessionId, flags: launch.flags }),
  };
}

/** Entry point: `codex ...args` through the on-PATH shim. */
export async function runCodexSupervisor(input: { argv: string[] }): Promise<number> {
  const { argv } = input;
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - codexBin in ${paths.configJson} does not launch the real codex binary. Fix codexBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("codexsupervisor.loop_abort", { depth });
    return 1;
  }
  if (wrapperEntryRateTripped(Date.now())) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (over ${WRAP_RATE_MAX} wrapper entries in ${WRAP_RATE_WINDOW_MS / 1000}s) - codexBin in ${paths.configJson} does not launch the real codex binary. Fix codexBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("codexsupervisor.rate_abort", { max: WRAP_RATE_MAX });
    return 1;
  }

  const real = resolveRealCodex();
  const childEnv = { ...process.env, [WRAP_DEPTH_ENV]: String(depth + 1) };

  // Managed-headless: `codex exec` under a spawn gate + refusal classifier
  // (docs/auto-swap-long-sessions.md). Checked before the passthrough arm so
  // the unmanaged sentinel still wins (a nested exec inside a job or an SDK
  // turn is a plain child).
  if (!process.env[UNMANAGED_ENV] && isHeadlessCodexLaunch({ argv })) {
    const cfg = loadConfig();
    const launch = parseCodexExecLaunch(argv);
    if (cfg.policy.headlessManage && launch) {
      return runHeadlessJob({ adapter: codexHeadlessAdapter({ real, childEnv, launch, cwd: process.cwd() }), argv, cfg, cwd: process.cwd() });
    }
  }

  // The unmanaged-zone sentinel forces passthrough regardless of argv, exactly
  // like the claude shim: a serve turn's agent running `codex exec` must reach
  // the real codex instead of dying at the shared depth cap.
  if (!shouldManageCodex({ argv }) || process.env[UNMANAGED_ENV]) {
    // STRIP the supervisor pairing env from unmanaged spawns: a nested codex
    // launched from inside a supervised session (e.g. its agent running
    // `codex exec ...`) would otherwise inherit the OUTER session's id, and
    // its global Stop hook could then write a respawn marker that SIGTERMs
    // the outer session MID-TURN and resumes it onto the nested transcript
    // (closing-review catch). A managed nested launch is already safe - it
    // exports its own fresh id below; only a shim-bypassed absolute-path
    // nested launch keeps the inherited env, the same accepted gap as
    // claude's bg-daemon bypass.
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv[CODEX_SUPERVISOR_ID_ENV];
    const p = Bun.spawn([real, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: passthroughEnv });
    await p.exited;
    return p.exitCode ?? (p.signalCode ? 1 : 0);
  }

  const supervisorId = crypto.randomUUID();
  mkdirSync(codexPaths.respawnDir, { recursive: true });
  const marker = join(codexPaths.respawnDir, supervisorId);
  const savedTermios = saveTermios();

  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  // On respawn the ONLY reliable relaunch is `codex resume <session-id>`:
  // codex generates its own session ids (there is no flag to pin one at
  // launch), so original launch args are used verbatim only for the first
  // spawn. Model/sandbox preferences persist in config.toml either way.
  let launchArgs = argv;
  let respawns = 0;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    log("codexsupervisor.launch", { supervisorId: supervisorId.slice(0, 8), respawns, args: launchArgs.join(" ") });

    // Declare which account THIS session runs on (the live identity at spawn):
    // the picker must never target it and the sampler must never rotate its
    // parked token while the session lives. Rewritten every respawn (the swap
    // changed the live identity); cleared on exit; PID-validated by readers.
    // Read + presence-write + spawn run under the codex FLOCK (closing-review
    // catch): unlocked, a swap could land between the read and the child's
    // auth.json read, seating the child on the NEW account while presence
    // named the old one for the session's whole life - un-benching the
    // running account for samplers and the picker. Under the flock no swap
    // can interleave until after the spawn; the residual window (child
    // startup vs a swap acquiring the lock immediately after) is sub-ms in
    // practice against a swap's network-bound critical section.
    const { child } = await spawnCodexSeated({
      real,
      args: launchArgs,
      env: { ...childEnv, [CODEX_SUPERVISOR_ID_ENV]: supervisorId },
      supervisorId,
      savedTermios,
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker) && consumableCodexMarker(marker) != null) return true;
        await Bun.sleep(150);
      }
      return false;
    })();
    const exited = child.exited.then(() => {
      done = true;
      return "exit";
    });
    const winner = await Promise.race([exited, markerWatch.then((found) => (found ? "marker" : "exit"))]);

    if (winner === "marker") {
      child.kill(); // SIGTERM at the committed turn boundary the Stop hook chose
    }
    await child.exited;
    done = true;
    await markerWatch.catch(() => false);
    restoreTermios(savedTermios);

    const payload = existsSync(marker) ? consumableCodexMarker(marker) : null;
    if (payload) {
      rmSync(marker, { force: true });
      respawns++;
      process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched codex to ${payload.account} - resuming...\x1b[0m\n`);
      launchArgs = payload.sessionId ? ["resume", payload.sessionId] : ["resume", "--last"];
      continue;
    }
    clearCodexPresence({ supervisorId });
    // a reconcile signal addressed to this now-gone session is moot; the
    // deciding actor's sweep would gc it eventually, this is just prompt.
    rmSync(join(codexPaths.reconcileDir, supervisorId), { force: true });
    log("codexsupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
