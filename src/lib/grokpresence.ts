// Which grok accounts are RUNNING right now, under a tokenmaxxing supervisor.
// Grok hot-reloads auth.json, so unlike codex a swap carries every default-home
// session along with it (the documented blast radius) - presence here does NOT
// bench an account from being the swap TARGET's departure point. What it does
// guard: `init --grok` / `add --grok` must not harvest-park a snapshot of an
// account whose live session is rotating tokens under it, and samplers must
// not act on a parked blob the running session supersedes. Staleness is
// checked by process IDENTITY (pid + ps lstart), not bare pid-aliveness,
// mirroring codexpresence.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { grokPaths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { pidExists, pidStartTime } from "./proc.ts";

const PresenceSchema = z.object({
  accountId: z.string(),
  pid: z.number(),
  startedAt: z.string(),
});

/** `pid` should be the GROK CHILD's pid when known (the supervisor passes
 *  it): the session IS the child, and pinning the supervisor's own pid would
 *  let a SIGKILLed supervisor prune the presence while its orphaned grok kept
 *  running (the codex closing-review catch, inherited). */
export function writeGrokPresence(input: { supervisorId: string; accountId: string; pid?: number }): void {
  const pid = input.pid ?? process.pid;
  const startedAt = pidStartTime(pid);
  if (startedAt == null) throw new Error(`could not read pid ${pid}'s start time (ps lstart) - refusing to write an unverifiable presence file`);
  mkdirSync(grokPaths.presenceDir, { recursive: true });
  writeFileAtomic(
    join(grokPaths.presenceDir, input.supervisorId),
    JSON.stringify(PresenceSchema.parse({ accountId: input.accountId, pid, startedAt })),
  );
}

export function clearGrokPresence(input: { supervisorId: string }): void {
  rmSync(join(grokPaths.presenceDir, input.supervisorId), { force: true });
}

/** Account ids with a LIVING supervised session. Dead or recycled-pid
 *  presences are removed. A file that exists but fails to parse THROWS: a
 *  presence file is what keeps a RUNNING session's account from being
 *  harvested mid-rotation, so damaged state must fail loudly, never silently
 *  drop the protection (codexpresence contract). */
export function presentGrokAccountIds(): Set<string> {
  const present = new Set<string>();
  if (!existsSync(grokPaths.presenceDir)) return present;
  for (const name of readdirSync(grokPaths.presenceDir)) {
    const file = join(grokPaths.presenceDir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      // a supervisor exiting between readdir and read clears its own file
      const errno = z.object({ code: z.string() }).safeParse(e);
      if (errno.success && errno.data.code === "ENOENT") continue;
      throw e;
    }
    const parsed = PresenceSchema.safeParse((() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })());
    if (!parsed.success) {
      throw new Error(`${file} is not a readable presence record - it may belong to a RUNNING grok session, refusing to treat it as absent; remove the file (or respawn that session) to proceed`);
    }
    const observed = pidStartTime(parsed.data.pid);
    if (observed !== parsed.data.startedAt) {
      // Only a confirmed-dead pid - or a live pid with a DIFFERENT start
      // time, a recycle - may clear the file; a ps failure on a live pid must
      // not silently unbench a running session's account.
      if (observed == null && pidExists(parsed.data.pid)) {
        throw new Error(`ps could not read the start time of live pid ${parsed.data.pid} (${file}) - refusing to clear a presence file that may guard a RUNNING grok session`);
      }
      rmSync(file, { force: true });
      continue;
    }
    present.add(parsed.data.accountId);
  }
  return present;
}
