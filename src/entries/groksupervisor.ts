// The `grok` supervisor. Invoked in place of grok (via ~/.config/tokenmaxxing/
// bin/grok on PATH). Unlike codex, a running grok HOT-RELOADS a swapped
// auth.json on its next API call ("Auth token hot-reloaded from config
// watcher", binary-verified 1.0.8), so a plain swap needs no respawn - the
// supervisor exists for the PATH seat, the credential-env scrub, wrap-loop
// containment, presence, and the two respawn cases that DO need a restart:
// the depleted-pool countdown (marker carries waitUntil) and the StopFailure
// rate_limit fallback (the config watcher can skip a reload when it judges
// the token key identical - "auth.json changed but token key is identical,
// skipping" - so a session the server just refused restarts onto the fresh
// credential via `grok --resume <session-id>` rather than trusting the
// reload happened).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { grokPaths, paths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { resolveRealGrok } from "../lib/grokbin.ts";
import { clearGrokPresence, writeGrokPresence } from "../lib/grokpresence.ts";
import { liveGrokAccountId } from "../lib/groksample.ts";
import { evaluateAndMaybeSwapGrok } from "../lib/grokdecide.ts";
import { loadConfig } from "../lib/state.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { GrokRespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

export const GROK_SUPERVISOR_ID_ENV = "TOKENMAXXING_GROK_SUPERVISOR_ID";

/** Subcommands that never host a session worth managing (grok --help 1.0.8).
 *  `dashboard` is a TUI session view and stays managed. */
const NONINTERACTIVE_SUBCMDS = new Set([
  "agent", "clone", "completions", "doctor", "du", "disk-usage", "export", "help",
  "inspect", "leader", "login", "logout", "mcp", "memory", "models", "plugin",
  "sessions", "setup", "trace", "update", "version", "v", "worktree", "wrap",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-v", "--help", "-h"]);

/** Root options that consume the NEXT token as their value (verified against
 *  `grok --help` 1.0.8): without skipping them, `grok -m grok-4 export` would
 *  read "grok-4" as the subcommand test's positional. `-r/--resume` and
 *  `-w/--worktree` take OPTIONAL values and are deliberately NOT here: their
 *  value read as a positional still classifies the run as managed, which is
 *  the right outcome for a resume/worktree session (a value that happens to
 *  spell a noninteractive subcommand name, e.g. `-w update "…"`, would wrongly
 *  pass through - an accepted gap). */
const VALUE_TAKING_ROOT_FLAGS = new Set([
  "--agent", "--agents", "--allow", "--allowedTools", "--cwd", "--debug-file",
  "--deny", "--disallowedTools", "--disallowed-tools", "--json-schema",
  "--leader-socket", "-m", "--model", "--max-turns", "--output-format",
  "-p", "--single", "--permission-mode", "--prompt-file", "--prompt-json",
  "--reasoning-effort", "--effort", "--rules", "-s", "--session-id",
  "--sandbox", "--system-prompt-override", "--system-prompt", "--tools",
  "--worktree-ref", "--ref",
]);

/** Managed = anything that runs a session, headless `-p` included: it exits
 *  when the run finishes, but it still needs the scrub, presence, and the
 *  wrap-loop guards (issue #1). */
export function shouldManageGrok(input: { argv: string[] }): boolean {
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

/** grok rejects an empty `-p` prompt ("--single: prompt is empty", verified
 *  1.0.11 on 2026-09-17), so a headless respawn cannot resume with no text
 *  the way codex/claude do; this one-word turn is the smallest deviation from
 *  the owner's empty-resume rule (recorded in docs/auto-swap-long-sessions.md). */
export const GROK_CONTINUATION_PROMPT = "continue";

/** The respawn form: the ORIGINAL launch shape (flags with their values,
 *  `-p` kept for a headless run) minus any session selector and minus the
 *  one-shot positional prompt, plus `--resume <sid>`. Before this the
 *  supervisor relaunched `["--resume", sid]` alone, which turned a headless
 *  `-p --output-format …` worker into an interactive TUI on a non-TTY
 *  (docs/auto-swap-long-sessions.md F7). A null sid falls back to bare
 *  `--resume` (grok's own picker), as before. */
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
    if (VALUE_TAKING_ROOT_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < argv.length) out.push(argv[++i]!);
      continue;
    }
    if (!a.startsWith("-")) continue; // the one-shot prompt is never replayed
    out.push(a);
  }
  out.push("--resume");
  if (input.sessionId != null) out.push(input.sessionId);
  return out;
}

function isHeadlessGrokLaunch(argv: string[]): boolean {
  return argv.some((a) => a === "-p" || a === "--single");
}

/** OIDC/SuperGrok session only (issue #1): an ambient API key or external
 *  auth provider would OUTRANK or replace the pooled session credential in
 *  grok's auth precedence, silently billing another surface (or clobbering
 *  auth.json with provider output). Deleting covers the empty-string
 *  variants too. Applied to the UNMANAGED passthrough as well, deliberately:
 *  `grok agent stdio` runs real sessions on the live auth.json, and a
 *  provider-command login through the shim would replace the pooled seat -
 *  API-key / external-provider use belongs outside the shim entirely. */
export function scrubGrokAuthEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const scrubbed = { ...env };
  delete scrubbed.XAI_API_KEY;
  delete scrubbed.GROK_AUTH_PROVIDER_COMMAND;
  return scrubbed;
}

/** Read + validate a grok respawn marker. An unparseable one (version-skew
 *  hook, corruption) is dropped loudly and reported as absent: the watcher
 *  checks validity BEFORE the SIGTERM, so garbage never kills the session. */
function consumableGrokMarker(marker: string): z.infer<typeof GrokRespawnMarkerSchema> | null {
  try {
    return GrokRespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    rmSync(marker, { force: true });
    log("groksupervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Interruptible countdown until `until` (grok is dead between respawns, so
 *  the terminal is ours). Ctrl-C resumes immediately - mirrors the claude
 *  supervisor's countdownWait. */
async function countdownWait(acct: string, until: number): Promise<void> {
  let aborted = false;
  const onInt = () => { aborted = true; };
  process.on("SIGINT", onInt);
  process.stdout.write(`\n\x1b[36m⏳ tokenmaxxing: every grok account is at its weekly limit. Resuming on ${acct} when it resets (Ctrl-C to resume now).\x1b[0m\n`);
  while (!aborted && Date.now() < until) {
    const left = until - Date.now();
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    process.stdout.write(`\r\x1b[36m   resuming in ${m}m ${String(s).padStart(2, "0")}s \x1b[0m`);
    await Bun.sleep(1000);
  }
  process.removeListener("SIGINT", onInt);
}

/** Entry point: `grok ...args` through the on-PATH shim. */
export async function runGrokSupervisor(input: { argv: string[] }): Promise<number> {
  const { argv } = input;
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - grokBin in ${paths.configJson} does not launch the real grok binary. Fix grokBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("groksupervisor.loop_abort", { depth });
    return 1;
  }
  if (wrapperEntryRateTripped(Date.now())) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (over ${WRAP_RATE_MAX} wrapper entries in ${WRAP_RATE_WINDOW_MS / 1000}s) - grokBin in ${paths.configJson} does not launch the real grok binary. Fix grokBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("groksupervisor.rate_abort", { max: WRAP_RATE_MAX });
    return 1;
  }

  const real = resolveRealGrok();
  const childEnv = scrubGrokAuthEnv({ ...process.env, [WRAP_DEPTH_ENV]: String(depth + 1) });

  if (!shouldManageGrok({ argv }) || process.env[UNMANAGED_ENV]) {
    // STRIP the supervisor pairing env from unmanaged spawns (the codex
    // closing-review catch): a nested grok launched from inside a supervised
    // session would otherwise inherit the OUTER session's id, and its global
    // Stop hook could write a marker that restarts the outer session onto the
    // nested transcript.
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv[GROK_SUPERVISOR_ID_ENV];
    const p = Bun.spawn([real, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: passthroughEnv });
    await p.exited;
    return p.exitCode ?? (p.signalCode ? 1 : 0);
  }

  const supervisorId = crypto.randomUUID();
  mkdirSync(grokPaths.respawnDir, { recursive: true });
  const marker = join(grokPaths.respawnDir, supervisorId);
  const savedTermios = saveTermios();

  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  // Spawn gate for a headless run (docs/auto-swap-long-sessions.md §4.2):
  // one free credits read, and a swap before anything is running. Never
  // fatal - a missed read launches on whatever seat is live. TUIs keep the
  // hook-driven path alone (their first Stop boundary is minutes away).
  if (isHeadlessGrokLaunch(argv) && loadConfig().policy.headlessManage) {
    try {
      const gate = await evaluateAndMaybeSwapGrok({});
      log("groksupervisor.gate", { supervisorId: supervisorId.slice(0, 8), swapped: gate.swapped, reason: gate.reason });
    } catch (e) {
      log("groksupervisor.gate_error", { err: e instanceof Error ? e.message : String(e) });
    }
  }

  let launchArgs = argv;
  let respawns = 0;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    log("groksupervisor.launch", { supervisorId: supervisorId.slice(0, 8), respawns, args: launchArgs.join(" ") });

    // Presence read + write + spawn under the grok FLOCK, pinning the CHILD's
    // pid (both codex closing-review catches inherited): unlocked, a swap
    // could land between the identity read and the child's auth.json read;
    // a supervisor-pid presence would die with a SIGKILLed supervisor while
    // its orphaned grok kept rotating the account's token.
    const child = await withLock(grokPaths.lockFile, async () => {
      const spawnAccountId = liveGrokAccountId();
      const spawned = Bun.spawn([real, ...launchArgs], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...childEnv, [GROK_SUPERVISOR_ID_ENV]: supervisorId },
      });
      // FAIL CLOSED on final failure: a session running without presence is
      // exactly the unprotected state presence exists to prevent. Brief
      // retries cover ps visibility lag on a just-spawned pid.
      if (spawnAccountId) {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            writeGrokPresence({ supervisorId, accountId: spawnAccountId, pid: spawned.pid });
            break;
          } catch (e) {
            if (spawned.exitCode !== null || spawned.signalCode !== null) break;
            if (attempt === 9) {
              log("groksupervisor.presence_failed", { err: e instanceof Error ? e.message : String(e) });
              spawned.kill();
              await spawned.exited;
              restoreTermios(savedTermios);
              throw new Error("could not write the grok presence file - refusing to run an unprotected session (its parked credential would look refreshable)");
            }
            await Bun.sleep(100);
          }
        }
      }
      return spawned;
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker) && consumableGrokMarker(marker) != null) return true;
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
      child.kill(); // SIGTERM at the committed turn boundary the hook chose
    }
    await child.exited;
    done = true;
    await markerWatch.catch(() => false);
    restoreTermios(savedTermios);

    const payload = existsSync(marker) ? consumableGrokMarker(marker) : null;
    if (payload) {
      rmSync(marker, { force: true });
      respawns++;
      if (payload.waitUntil != null && payload.waitUntil > Date.now()) {
        await countdownWait(payload.account, payload.waitUntil);
      }
      process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched grok to ${payload.account} - resuming...\x1b[0m\n`);
      launchArgs = grokRespawnArgs({ argv, sessionId: payload.sessionId });
      continue;
    }
    clearGrokPresence({ supervisorId });
    log("groksupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
