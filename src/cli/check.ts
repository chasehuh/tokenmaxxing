// `tokenmaxxing check` - one auto-switch evaluation, the same decision the
// Stop/SessionStart hooks make (flocked, idempotent). Installed as a periodic
// launchd/systemd job so a limit crossed mid-turn, or with no session running,
// still switches within minutes; the hooks only ever see turn boundaries.
// Running claude sessions adopt the swapped credential in place (<=30s).

import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { evaluateAndMaybeSwapCodex } from "../lib/codexdecide.ts";
import { log } from "../lib/log.ts";
import { c, fmtReset } from "./render.ts";

export async function cmdCheck(): Promise<number> {
  let rc = 0;
  let d;
  try {
    d = await evaluateAndMaybeSwap();
  } catch (e) {
    // unattended under the timer: the log is the only place anyone will look.
    const detail = e instanceof Error ? e.message : String(e);
    log("check.error", { err: detail });
    console.error(c.red(`check failed: ${detail}`));
    rc = 1;
  }
  if (d) {
    if (d.swapped && d.account) {
      console.log(`${c.green("↻")} switched to ${c.bold(d.account.label)}`);
    } else if (d.waitUntil !== undefined && d.account) {
      console.log(c.yellow(`all accounts at limit - staying on ${c.bold(d.account.label)} (${fmtReset(d.waitUntil)})`));
    } else {
      console.log(c.dim(`no switch (${d.reason})`));
    }
  }
  // The codex pool rides the same timer (docs/auto-swap-long-sessions.md
  // §4.6): a stale snapshot once hid a 100% seat for 27 hours. The timer
  // boundary refreshes the live seat's sample and swaps only an IDLE seat -
  // one with a session on it is left to that session's own boundary.
  try {
    const dc = await evaluateAndMaybeSwapCodex({ boundary: "timer" });
    if (dc.reason !== "no-pool") {
      if (dc.swapped && dc.account) console.log(`${c.green("↻")} codex: switched to ${c.bold(dc.account.label)}`);
      else console.log(c.dim(`codex: no switch (${dc.reason})`));
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log("check.codex_error", { err: detail });
    console.error(c.red(`codex check failed: ${detail}`));
    rc = 1;
  }
  return rc;
}
