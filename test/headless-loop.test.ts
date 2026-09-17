// The managed-headless job loop's state machine, driven through a scripted
// adapter (docs/auto-swap-long-sessions.md §4.4): clean exit passes the code
// through, a non-quota failure never resumes, a classified refusal swaps and
// resumes the SAME session with the backend's resume form, a moved seat
// resumes without a second swap, a short wait sleeps in place, a long wait or
// an exhausted respawn budget parks with EX_TEMPFAIL, an ambiguous id parks
// after the seat was moved, and a killed child is never a refusal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EX_TEMPFAIL, runHeadlessJob, type HeadlessAdapter, type RefusalDecision, type ThreadResolution } from "../src/lib/headless.ts";
import { loadConfig } from "../src/lib/state.ts";
import { paths } from "../src/lib/paths.ts";
import type { Config } from "../src/lib/types.ts";

const SID = "55555555-5555-4555-8555-555555555555";

type Step = { exit: number | "kill"; refusal?: string | null; resolution?: ThreadResolution };

/** A scripted backend: `steps[i]` describes the i-th spawn (exit code or a
 *  SIGTERM death, and what the side channel reports afterwards). */
function scripted(input: {
  steps: Step[];
  decisions?: RefusalDecision[];
  live?: string;
  gate?: { swapped: boolean; reason: string };
}) {
  const spawns: string[][] = [];
  const decisionsAsked: (string | null)[] = [];
  let i = 0;
  const adapter: HeadlessAdapter = {
    backend: "codex",
    liveAccountId: () => input.live ?? "acct-A",
    spawnGate: async () => input.gate ?? { swapped: false, reason: "under-threshold-or-stale" },
    spawn: async ({ args }) => {
      const step = input.steps[i++] ?? { exit: 0 };
      spawns.push(args);
      const cmd = step.exit === "kill" ? "kill -TERM $$" : `exit ${step.exit}`;
      const child = Bun.spawn(["/bin/sh", "-c", cmd], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return { child, accountId: "acct-A" };
    },
    afterExit: () => {},
    knownSessionId: ({ launchArgs }) => (launchArgs.includes("resume") ? SID : null),
    resolveSessionId: () => input.steps[i - 1]?.resolution ?? { kind: "id", id: SID },
    refusalEvidence: () => input.steps[i - 1]?.refusal ?? null,
    refusalDecision: async ({ refusedAccountId }) => {
      decisionsAsked.push(refusedAccountId);
      return input.decisions?.[decisionsAsked.length - 1] ?? { swapped: true, account: "B", waitUntil: null, reason: "swapped" };
    },
    resumeArgs: ({ sessionId, originalArgv }) => ["exec", "resume", ...originalArgv.slice(1), sessionId, ""],
  };
  return { adapter, spawns, decisionsAsked };
}

let cfg: Config;
const sleeps: number[] = [];
const said: string[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};
const say = (line: string) => {
  said.push(line);
};

function records() {
  return readdirSync(paths.jobsDir).map((f) => JSON.parse(readFileSync(join(paths.jobsDir, f), "utf8")));
}

beforeEach(() => {
  rmSync(paths.jobsDir, { recursive: true, force: true });
  rmSync(paths.configJson, { force: true });
  cfg = loadConfig();
  cfg = { ...cfg, policy: { ...cfg.policy, headlessMinRespawnGapMs: 0 } };
  sleeps.length = 0;
  said.length = 0;
});
afterEach(() => rmSync(paths.jobsDir, { recursive: true, force: true }));

const argv = ["exec", "--json", "hello"];
const run = (adapter: HeadlessAdapter, over: Partial<Config["policy"]> = {}) =>
  runHeadlessJob({ adapter, argv, cfg: { ...cfg, policy: { ...cfg.policy, ...over } }, cwd: "/w", sleep, say });

describe("headless job loop", () => {
  test("a clean exit passes 0 through and records the job done", async () => {
    const s = scripted({ steps: [{ exit: 0 }] });
    expect(await run(s.adapter)).toBe(0);
    expect(s.spawns).toEqual([argv]);
    expect(s.decisionsAsked).toEqual([]);
    const [rec] = records();
    expect(rec.state).toBe("done");
    expect(rec.launchArgs).toEqual(argv);
  });

  test("a non-quota failure keeps the CLI's exit code and never resumes", async () => {
    const s = scripted({ steps: [{ exit: 3, refusal: null }] });
    expect(await run(s.adapter)).toBe(3);
    expect(s.spawns.length).toBe(1);
    expect(s.decisionsAsked).toEqual([]);
    expect(records()[0].state).toBe("failed");
  });

  test("a classified refusal swaps, then resumes the SAME session with the resume form and an empty prompt", async () => {
    const s = scripted({ steps: [{ exit: 1, refusal: "You've hit your usage limit." }, { exit: 0 }] });
    expect(await run(s.adapter, { headlessMinRespawnGapMs: 10_000 })).toBe(0);
    expect(s.spawns).toEqual([argv, ["exec", "resume", "--json", "hello", SID, ""]]);
    expect(s.decisionsAsked).toEqual(["acct-A"]);
    // the respawn honored the minimum gap (the scripted clock makes the gap the full floor)
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(9_000);
    const [rec] = records();
    expect(rec.state).toBe("done");
    expect(rec.respawns).toBe(1);
    expect(rec.sessionId).toBe(SID);
    expect(said.some((l) => l.includes("switched codex to B"))).toBe(true);
  });

  test("a seat a sibling already moved is resumed onto without a second swap", async () => {
    const s = scripted({
      steps: [{ exit: 1, refusal: "hit your usage limit" }, { exit: 0 }],
      decisions: [{ swapped: false, account: "B", waitUntil: null, reason: "seat-moved" }],
    });
    expect(await run(s.adapter)).toBe(0);
    expect(s.spawns.length).toBe(2);
    expect(said.some((l) => l.includes("already moved"))).toBe(true);
  });

  test("nothing usable but a reset inside the wait cap: sleep in place, then respawn", async () => {
    const soon = Date.now() + 90_000;
    const s = scripted({
      steps: [{ exit: 1, refusal: "hit your usage limit" }, { exit: 0 }],
      decisions: [{ swapped: false, account: null, waitUntil: soon, reason: "all-depleted" }],
    });
    expect(await run(s.adapter)).toBe(0);
    expect(s.spawns.length).toBe(2);
    expect(sleeps.some((ms) => ms > 80_000 && ms <= 90_000)).toBe(true);
    expect(said.some((l) => l.includes("waiting"))).toBe(true);
  });

  test("nothing usable beyond the wait cap parks with EX_TEMPFAIL and a resumable record", async () => {
    const far = Date.now() + 5 * 3_600_000;
    const s = scripted({
      steps: [{ exit: 1, refusal: "hit your usage limit" }],
      decisions: [{ swapped: false, account: null, waitUntil: far, reason: "all-depleted" }],
    });
    expect(await run(s.adapter)).toBe(EX_TEMPFAIL);
    expect(s.spawns.length).toBe(1);
    const [rec] = records();
    expect(rec.state).toBe("parked");
    expect(rec.waitUntil).toBe(far);
    expect(rec.sessionId).toBe(SID);
    // no recovery time at all (every sibling needs reauth) parks the same way
    const s2 = scripted({
      steps: [{ exit: 1, refusal: "hit your usage limit" }],
      decisions: [{ swapped: false, account: null, waitUntil: null, reason: "all-depleted" }],
    });
    expect(await run(s2.adapter)).toBe(EX_TEMPFAIL);
  });

  test("the respawn budget is per job: past headlessMaxRespawns a refusal parks even with a target", async () => {
    const s = scripted({
      steps: [{ exit: 1, refusal: "hit your usage limit" }, { exit: 1, refusal: "hit your usage limit" }, { exit: 0 }],
    });
    expect(await run(s.adapter, { headlessMaxRespawns: 1 })).toBe(EX_TEMPFAIL);
    expect(s.spawns.length).toBe(2);
    expect(s.decisionsAsked.length).toBe(2); // the seat still moved on the second refusal
    expect(records()[0].reason).toBe("respawn cap");
  });

  test("an ambiguous fresh thread still moves the seat, then parks instead of guessing a transcript", async () => {
    const s = scripted({
      steps: [{ exit: 1, refusal: "hit your usage limit", resolution: { kind: "ambiguous", ids: ["t-1", "t-2"] } }],
    });
    expect(await run(s.adapter)).toBe(EX_TEMPFAIL);
    expect(s.decisionsAsked).toEqual(["acct-A"]);
    expect(records()[0].reason).toBe("ambiguous session id");
    expect(records()[0].sessionId).toBeNull();
  });

  test("a child killed by a signal is a failure, never a refusal", async () => {
    const s = scripted({ steps: [{ exit: "kill", refusal: "hit your usage limit" }] });
    expect(await run(s.adapter)).toBe(1);
    expect(s.decisionsAsked).toEqual([]);
    expect(records()[0].state).toBe("failed");
    expect(records()[0].reason).toContain("SIGTERM");
  });

  test("a spawn-gate failure is logged and the job still launches", async () => {
    const s = scripted({ steps: [{ exit: 0 }] });
    s.adapter.spawnGate = async () => {
      throw new Error("usage endpoint down");
    };
    expect(await run(s.adapter)).toBe(0);
    expect(s.spawns.length).toBe(1);
  });
});
