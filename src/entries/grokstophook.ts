// Grok Stop + StopFailure hook (installed as the always-trusted sibling file
// ~/.grok/hooks/tokenmaxxing-grok.json by `init --grok`; both events route to
// this one subcommand and the stdin envelope tells them apart). Fires when a
// turn ends: the transcript is committed and the process is idle, the one
// boundary where a swap is safe. Unlike codex, an UNSUPERVISED session still
// gets the decision: grok hot-reloads a swapped auth.json on its next API
// call, so every default-home session follows the seat with no restart (the
// documented blast radius). The supervisor is needed only for the two respawn
// cases (depleted-pool countdown, rate_limit restart fallback), so those
// markers are written only when the pairing env names one.
//
// Contract with grok (verified against the 1.0.8 hooks reference): stdin is a
// camelCase envelope; a Stop hook that exits 0 with NO output allows the stop.
// This hook must NEVER print a decision and never block - errors are logged,
// not thrown, and nothing is written to stdout.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { grokPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwapGrok } from "../lib/grokdecide.ts";
import { GROK_SUPERVISOR_ID_ENV } from "./groksupervisor.ts";
import { GrokRespawnMarkerSchema, GrokStopStdinSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const SupervisorIdSchema = z.string().min(1).optional().catch(undefined);

/** The testable core: decide, and when the decision needs a restart AND this
 *  session runs under the grok supervisor, drop the respawn marker. Never
 *  throws (a hook failure must not block the stop). */
export async function handleGrokStop(input: { rawStdin: string }): Promise<void> {
  const parsed = GrokStopStdinSchema.safeParse((() => {
    try {
      return JSON.parse(input.rawStdin);
    } catch {
      return {};
    }
  })());
  const stdin = parsed.success ? parsed.data : {};
  const sessionId = stdin.sessionId != null && stdin.sessionId.trim() !== "" ? stdin.sessionId : null;

  try {
    // StopFailure arrives with the classified error type; the hook file's
    // matcher already filters rate_limit, but the envelope is re-checked so a
    // future matcher edit cannot turn every API error into a forced swap.
    const isFailure = stdin.error != null || stdin.hookEventName?.toLowerCase().includes("failure") === true;
    if (isFailure && stdin.error !== "rate_limit") {
      log("grokstop.failure_skip", { error: stdin.error ?? "?" });
      return;
    }
    // A Stop also fires at session end (reason "channel_closed"/"shutdown",
    // its output ignored) - only a genuine end_turn is a decision boundary
    // (grok 1.0.8 docs; the codex text-sniffing lesson says never widen this).
    if (!isFailure && stdin.reason !== "end_turn") {
      log("grokstop.reason_skip", { reason: stdin.reason ?? "?" });
      return;
    }

    const decision = await evaluateAndMaybeSwapGrok({ force: isFailure });
    const supervisorId = SupervisorIdSchema.parse(process.env[GROK_SUPERVISOR_ID_ENV]);
    if (supervisorId === undefined || decision.account == null) return;

    // Two marker cases, both restart-shaped. Depleted-wait: the seat is (or
    // just moved to) the soonest-recovering account and the supervisor counts
    // down to its reset. rate_limit fallback: the server refused this very
    // session's turn, so even a hot-reloadable swap restarts it - the config
    // watcher skips reloads it judges same-key, and a refused session must
    // not gamble on that.
    const waitUntil = decision.reason === "depleted-wait" ? decision.waitUntil : null;
    const needsRespawn = waitUntil != null || (isFailure && decision.swapped);
    if (!needsRespawn) return;
    if (sessionId == null) {
      // a resume without an id would revive whatever session happens to be
      // most recent; leave the seat swapped and let the next spawn ride it.
      log("grokstop.no_session_id", {});
      return;
    }
    mkdirSync(grokPaths.respawnDir, { recursive: true });
    writeFileAtomic(
      join(grokPaths.respawnDir, supervisorId),
      JSON.stringify(GrokRespawnMarkerSchema.parse({ account: decision.account.label, sessionId, ts: Date.now(), waitUntil })),
    );
    log("grokstop.marker", { supervisorId: supervisorId.slice(0, 8), waitUntil });
  } catch (e) {
    log("grokstop.error", { err: e instanceof Error ? e.message : String(e) });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runGrokStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleGrokStop({ rawStdin: await readStdin() });
  }
  // exit 0 with no stdout = allow the stop (grok 1.0.8 docs); never a decision.
  return 0;
}
