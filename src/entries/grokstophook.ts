import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { grokPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { grok, grokPickCtx, sampleGrokSeat } from "../lib/grok.ts";
import { isExhausted } from "../lib/picker.ts";
import { loadAccounts } from "../lib/state.ts";
import { GROK_SUPERVISOR_ID_ENV } from "./groksupervisor.ts";
import { GrokRespawnMarkerSchema, GrokStopStdinSchema, JsonTextSchema, type EnforcedLimit } from "../lib/types.ts";
import { log } from "../lib/log.ts";
import { readStdin } from "./statusline.ts";

const SupervisorIdSchema = z.string().min(1).optional().catch(undefined);

export async function handleGrokStop(input: { rawStdin: string }): Promise<void> {
  const parsed = GrokStopStdinSchema.safeParse(JsonTextSchema.safeParse(input.rawStdin).data);
  const stdin = parsed.success ? parsed.data : {};
  const sessionId = stdin.sessionId != null && stdin.sessionId.trim() !== "" ? stdin.sessionId : null;

  try {
    const isFailure = stdin.error != null || stdin.hookEventName?.toLowerCase().includes("failure") === true;
    if (isFailure && stdin.error !== "rate_limit") {
      log("grokstop.failure_skip", { error: stdin.error ?? "?" });
      return;
    }
    if (!isFailure && stdin.reason !== "end_turn") {
      log("grokstop.reason_skip", { reason: stdin.reason ?? "?" });
      return;
    }
    const supervisorId = SupervisorIdSchema.parse(process.env[GROK_SUPERVISOR_ID_ENV]);
    const now = Date.now();
    const seatId = grok.liveId();
    let enforced: EnforcedLimit | null = null;
    if (isFailure) {
      const seat = seatId == null ? undefined : loadAccounts(grok.pool).accounts.find((a) => a.id === seatId);
      if (!seat) {
        log("grokstop.failure_unseated", {});
        return;
      }
      const observed = await sampleGrokSeat(seat, now);
      const walled = observed == null || isExhausted({ ...seat, windows: observed.windows }, grokPickCtx(now, seat.id));
      if (!walled) {
        log("grokstop.failure_transient", { account: seat.id.slice(0, 8) });
        return;
      }
      enforced = { account: seat.id, kind: "weekly", family: null, resetsAt: null, blind: false };
    }
    const decision = await evaluateAndMaybeSwap(grok, now, supervisorId !== undefined, enforced);
    log("grokstop.decision", { reason: decision.reason, swapped: decision.swapped, account: decision.account?.id.slice(0, 8), waitUntil: decision.waitUntil });
    if (supervisorId === undefined || decision.account == null || !(decision.swapped || decision.waitUntil !== undefined)) return;
    mkdirSync(grokPaths.respawnDir, { recursive: true });
    writeFileAtomic(
      join(grokPaths.respawnDir, supervisorId),
      JSON.stringify(GrokRespawnMarkerSchema.parse({ accountId: decision.account.id, sessionId, ts: now, waitUntil: decision.waitUntil ?? null })),
    );
    log("grokstop.marker", { supervisorId: supervisorId.slice(0, 8), account: decision.account.id.slice(0, 8), waitUntil: decision.waitUntil ?? null });
  } catch (e) {
    log("grokstop.error", { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function runGrokStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleGrokStop({ rawStdin: await readStdin() });
  }
  return 0;
}
