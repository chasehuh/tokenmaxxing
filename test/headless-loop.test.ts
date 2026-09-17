import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EX_TEMPFAIL, runHeadlessJob, type HeadlessAdapter, type Placement, type Refusal, type ThreadResolution } from "../src/lib/headless.ts";
import { codex } from "../src/lib/codex.ts";
import { loadConfig } from "../src/lib/state.ts";
import { paths } from "../src/lib/paths.ts";
import type { Account, Config } from "../src/lib/types.ts";

const SID = "55555555-5555-4555-8555-555555555555";
const acct = (id: string): Account => ({ id, label: id, email: null, tier: null, addedAt: "2026-09-01T00:00:00.000Z", windows: [] });

type Step = { exit: number | "kill"; refusal?: Refusal | null; resolution?: ThreadResolution };

function scripted(input: { steps: Step[]; placements?: Placement[]; moves?: Placement[] }) {
  const spawns: { args: string[]; seat: string }[] = [];
  const placed: (string | null)[] = [];
  let i = 0;
  let placeCalls = 0;
  const adapter: HeadlessAdapter = {
    backend: "codex",
    provider: codex,
    place: async ({ wanted }) => {
      placed.push(wanted);
      return input.placements?.[placeCalls++] ?? { kind: "seat", account: acct(wanted ?? "A") };
    },
    spawn: async ({ args, seat }) => {
      const step = input.steps[i++] ?? { exit: 0 };
      spawns.push({ args, seat: seat.id });
      const cmd = step.exit === "kill" ? "kill -TERM $$" : `exit ${step.exit}`;
      return Bun.spawn(["/bin/sh", "-c", cmd], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    },
    afterExit: () => {},
    knownSessionId: ({ launchArgs }) => (launchArgs.includes("resume") ? SID : null),
    resolveSessionId: () => input.steps[i - 1]?.resolution ?? { kind: "id", id: SID },
    refusal: () => input.steps[i - 1]?.refusal ?? null,
    resumeArgs: ({ sessionId, originalArgv }) => ["exec", "resume", ...originalArgv.slice(1), sessionId, ""],
  };
  return { adapter, spawns, placed };
}

const REFUSED: Refusal = { kind: "weekly", family: null, resetsAt: null, text: "You've hit your usage limit." };

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

async function run(s: ReturnType<typeof scripted>, over: Partial<Config["policy"]> = {}, nextMoves: Placement[] = [{ kind: "seat", account: acct("B") }]) {
  const queue = [...nextMoves];
  return runHeadlessJob({ adapter: s.adapter, argv, cfg: { ...cfg, policy: { ...cfg.policy, ...over } }, cwd: "/w", sleep, say, move: async () => queue.shift() ?? { kind: "none" } });
}

describe("headless job loop", () => {
  test("a clean exit passes 0 through and records the job done", async () => {
    const s = scripted({ steps: [{ exit: 0 }] });
    expect(await run(s)).toBe(0);
    expect(s.spawns).toEqual([{ args: argv, seat: "A" }]);
    expect(records()[0]).toMatchObject({ state: "done", launchArgs: argv, accountId: "A" });
  });

  test("a non-quota failure keeps the CLI's exit code and never resumes", async () => {
    const s = scripted({ steps: [{ exit: 3, refusal: null }] });
    expect(await run(s)).toBe(3);
    expect(s.spawns.length).toBe(1);
    expect(records()[0].state).toBe("failed");
  });

  test("a classified refusal moves the seat, then resumes the SAME session under the new account with the resume form", async () => {
    const s = scripted({ steps: [{ exit: 1, refusal: REFUSED }, { exit: 0 }] });
    expect(await run(s, { headlessMinRespawnGapMs: 10_000 })).toBe(0);
    expect(s.spawns).toEqual([
      { args: argv, seat: "A" },
      { args: ["exec", "resume", "--json", "hello", SID, ""], seat: "B" },
    ]);
    expect(s.placed).toEqual([null, "B"]);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(9_000);
    expect(records()[0]).toMatchObject({ state: "done", respawns: 1, sessionId: SID, accountId: "B" });
    expect(said.some((l) => l.includes("moving codex to B"))).toBe(true);
  });

  test("nothing usable but a reset inside the wait cap: sleep in place, then respawn on the recovering account", async () => {
    const soon = Date.now() + 90_000;
    const s = scripted({ steps: [{ exit: 1, refusal: REFUSED }, { exit: 0 }] });
    expect(await run(s, {}, [{ kind: "wait", until: soon, account: acct("C") }])).toBe(0);
    expect(s.spawns.length).toBe(2);
    expect(s.placed).toEqual([null, "C"]);
    expect(sleeps.some((ms) => ms > 80_000 && ms <= 90_000)).toBe(true);
    expect(said.some((l) => l.includes("waiting"))).toBe(true);
  });

  test("nothing usable beyond the wait cap parks with EX_TEMPFAIL and a resumable record", async () => {
    const far = Date.now() + 5 * 3_600_000;
    const s = scripted({ steps: [{ exit: 1, refusal: REFUSED }] });
    expect(await run(s, {}, [{ kind: "wait", until: far, account: acct("C") }])).toBe(EX_TEMPFAIL);
    expect(s.spawns.length).toBe(1);
    expect(records()[0]).toMatchObject({ state: "parked", waitUntil: far, sessionId: SID });
    const s2 = scripted({ steps: [{ exit: 1, refusal: REFUSED }] });
    expect(await run(s2, {}, [{ kind: "none" }])).toBe(EX_TEMPFAIL);
  });

  test("a walled pool at launch waits or parks before anything is spawned", async () => {
    const soon = Date.now() + 60_000;
    const s = scripted({ steps: [{ exit: 0 }], placements: [{ kind: "wait", until: soon, account: acct("A") }, { kind: "seat", account: acct("A") }] });
    expect(await run(s)).toBe(0);
    expect(sleeps.some((ms) => ms > 50_000 && ms <= 60_000)).toBe(true);
    expect(s.spawns.length).toBe(1);
    const s2 = scripted({ steps: [], placements: [{ kind: "wait", until: Date.now() + 5 * 3_600_000, account: null }] });
    expect(await run(s2)).toBe(EX_TEMPFAIL);
    expect(s2.spawns.length).toBe(0);
    expect(records().some((r) => r.state === "parked" && r.launchArgs.length === 3)).toBe(true);
  });

  test("the respawn budget is per job: past headlessMaxRespawns a refusal parks even with a target", async () => {
    const s = scripted({ steps: [{ exit: 1, refusal: REFUSED }, { exit: 1, refusal: REFUSED }, { exit: 0 }] });
    expect(await run(s, { headlessMaxRespawns: 1 }, [{ kind: "seat", account: acct("B") }, { kind: "seat", account: acct("C") }])).toBe(EX_TEMPFAIL);
    expect(s.spawns.length).toBe(2);
    expect(records()[0].reason).toContain("respawn cap");
  });

  test("an ambiguous fresh thread parks instead of guessing a transcript", async () => {
    const s = scripted({ steps: [{ exit: 1, refusal: REFUSED, resolution: { kind: "ambiguous", ids: ["t-1", "t-2"] } }] });
    expect(await run(s)).toBe(EX_TEMPFAIL);
    expect(records()[0]).toMatchObject({ reason: "cannot resume: ambiguous session id", sessionId: null });
  });

  test("a child killed by a signal is a failure, never a refusal", async () => {
    const s = scripted({ steps: [{ exit: "kill", refusal: REFUSED }] });
    expect(await run(s)).toBe(1);
    expect(records()[0]).toMatchObject({ state: "failed" });
    expect(records()[0].reason).toContain("SIGTERM");
  });
});
