import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { grokPaths, grokPool, paths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { ensureGrokStoreHome, grokRespawnArgs, grokValueTakingRootFlags, pickGrokSeat, resolveRealGrok, scrubGrokAuthEnv } from "../lib/grok.ts";
import { clearPresence, writePresence } from "../lib/presence.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { loadAccounts } from "../lib/state.ts";
import { GrokRespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

export const GROK_SUPERVISOR_ID_ENV = "TOKENMAXXING_GROK_SUPERVISOR_ID";

const NONINTERACTIVE_SUBCMDS = new Set([
  "agent", "clone", "completions", "doctor", "du", "disk-usage", "export", "help",
  "inspect", "leader", "login", "logout", "mcp", "memory", "models", "plugin",
  "sessions", "setup", "trace", "update", "version", "v", "worktree", "wrap",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-v", "--help", "-h"]);

export function shouldManageGrok(input: { argv: string[] }): boolean {
  if (process.env.TOKENMAXXING_PROBE) return false;
  const valueFlags = grokValueTakingRootFlags();
  let firstPositional: string | null = null;
  for (let i = 0; i < input.argv.length; i++) {
    const arg = input.argv[i]!;
    if (PASSTHROUGH_FLAGS.has(arg)) return false;
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-") && firstPositional === null) firstPositional = arg;
  }
  return firstPositional === null || !NONINTERACTIVE_SUBCMDS.has(firstPositional);
}

function readGrokMarker(marker: string): z.infer<typeof GrokRespawnMarkerSchema> {
  try {
    return GrokRespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    log("groksupervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    throw new Error(`${marker} is corrupt (unparsable JSON or off-schema) - the grok session was stopped instead of resumed on a stale target; inspect and remove the marker, then run \`grok --resume\``);
  }
}

async function countdownWait(acct: string, until: number): Promise<void> {
  let aborted = false;
  const onInt = () => { aborted = true; };
  process.on("SIGINT", onInt);
  process.stderr.write(`\n\x1b[36m⏳ tokenmaxxing: every grok account is at its weekly limit. Resuming on ${acct} when it resets (Ctrl-C to resume now).\x1b[0m\n`);
  while (!aborted && Date.now() < until) {
    const left = until - Date.now();
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    process.stderr.write(`\r\x1b[36m   resuming in ${m}m ${String(s).padStart(2, "0")}s \x1b[0m`);
    await Bun.sleep(1000);
  }
  process.removeListener("SIGINT", onInt);
}

async function recordGrokPresence(child: { pid: number; exitCode: number | null; signalCode: string | null; kill: () => void; exited: Promise<unknown> }, supervisorId: string, seat: { id: string }, savedTermios: string | null): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      writePresence({ dir: grokPaths.presenceDir, id: supervisorId, accountId: seat.id, pid: child.pid });
      return;
    } catch (e) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (attempt >= 9) {
        log("groksupervisor.presence_failed", { err: e instanceof Error ? e.message : String(e) });
        child.kill();
        await child.exited;
        restoreTermios(savedTermios);
        throw new Error("could not write the grok presence file - refusing to run a session whose seat placement cannot see");
      }
      await Bun.sleep(100);
    }
  }
}

export async function runGrokSupervisor(input: { argv: string[] }): Promise<number> {
  const { argv } = input;
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(`tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - grokBin in ${paths.configJson} does not launch the real grok binary. Fix grokBin, then run \`tokenmaxxing doctor\`.`);
    log("groksupervisor.loop_abort", { depth });
    return 1;
  }
  if (wrapperEntryRateTripped(Date.now())) {
    console.error(`tokenmaxxing: ${LOOP_DIAGNOSIS} (over ${WRAP_RATE_MAX} wrapper entries in ${WRAP_RATE_WINDOW_MS / 1000}s) - grokBin in ${paths.configJson} does not launch the real grok binary. Fix grokBin, then run \`tokenmaxxing doctor\`.`);
    log("groksupervisor.rate_abort", { max: WRAP_RATE_MAX });
    return 1;
  }

  const real = resolveRealGrok();
  const childEnv = scrubGrokAuthEnv({ ...process.env, [WRAP_DEPTH_ENV]: String(depth + 1) });

  if (!shouldManageGrok({ argv }) || process.env[UNMANAGED_ENV]) {
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

  let launchArgs = argv;
  let respawns = 0;
  let wanted: string | null = null;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });

    const launchedAt = Date.now();
    const { child } = await withLock(grokPool.lockFile, async () => {
      const picked = pickGrokSeat(launchedAt, wanted);
      log("groksupervisor.launch", { supervisorId: supervisorId.slice(0, 8), respawns, seat: picked?.id.slice(0, 8) ?? null, args: launchArgs.join(" ") });
      const store = picked ? ensureGrokStoreHome(picked.id) : undefined;
      const spawned = Bun.spawn([real, ...launchArgs], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...childEnv, [GROK_SUPERVISOR_ID_ENV]: supervisorId, ...(store ? { GROK_HOME: store } : {}) },
      });
      if (picked) await recordGrokPresence(spawned, supervisorId, picked, savedTermios);
      return { child: spawned, seat: picked };
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker)) {
          readGrokMarker(marker);
          return true;
        }
        await Bun.sleep(150);
      }
      return false;
    })();
    const exited = child.exited.then(() => {
      done = true;
      return "exit";
    });
    try {
      const winner = await Promise.race([exited, markerWatch.then((found) => (found ? "marker" : "exit"))]);
      if (winner === "marker") child.kill();
    } catch (e) {
      child.kill();
      throw e;
    } finally {
      await child.exited;
      done = true;
      await markerWatch.catch(() => false);
      restoreTermios(savedTermios);
    }

    const payload = existsSync(marker) ? readGrokMarker(marker) : null;
    if (payload) {
      rmSync(marker, { force: true });
      respawns++;
      const label = loadAccounts(grokPool).accounts.find((a) => a.id === payload.accountId)?.label ?? payload.accountId.slice(0, 8);
      if (payload.waitUntil != null && payload.waitUntil > Date.now()) await countdownWait(label, payload.waitUntil);
      process.stderr.write(`\n\x1b[36m↻ tokenmaxxing: moving grok to ${label} - resuming...\x1b[0m\n`);
      wanted = payload.accountId;
      launchArgs = grokRespawnArgs({ argv, sessionId: payload.sessionId });
      continue;
    }
    clearPresence({ dir: grokPaths.presenceDir, id: supervisorId });
    log("groksupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
