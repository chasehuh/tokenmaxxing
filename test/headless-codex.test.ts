import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EX_TEMPFAIL } from "../src/lib/headless.ts";

const repo = join(import.meta.dir, "..");
const scratch = join(tmpdir(), `tm-headless-codex-${process.pid}`);
const THREAD = "01a0ad51-919e-7ec2-885b-ee1e23d088d9";
const LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 9:44 PM.";
const WEEK = 7 * 24 * 3600;
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;

function authBlob(id: string) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({ email: `${id.slice(0, 8)}@example.com`, "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "pro" } }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: `rt-${id.slice(0, 8)}`,
      account_id: id,
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
  };
}

function account(id: string, used: number) {
  return {
    id,
    label: id.slice(0, 8),
    email: `${id.slice(0, 8)}@example.com`,
    tier: "pro",
    addedAt: "2026-09-01T00:00:00.000Z",
    windows: [{ name: null, usedPercentage: used, resetsAt: Date.now() + WEEK * 1000, windowSeconds: WEEK, sampledAt: Date.now() }],
    lastUsageAt: Date.now(),
  };
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function buildInstall(name: string, input: { accounts: string[]; firstExit: number; refuse: boolean; config?: Record<string, unknown> }) {
  const root = join(scratch, name);
  const tmHome = join(root, "tmhome");
  const codexHome = join(root, "codexhome");
  const cwd = join(root, "work");
  const binDir = join(tmHome, "bin");
  for (const d of [binDir, join(codexHome, "sessions"), join(codexHome, "skills"), cwd]) mkdirSync(d, { recursive: true });
  const argsLog = join(root, "args.log");
  const counter = join(root, "count");
  const fake = join(root, "fake-codex");
  writeExecutable(join(binDir, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(join(repo, "src", "main.ts"))} __supervise-codex "$@"\n`);
  writeExecutable(
    fake,
    `#!/bin/sh
printf 'home=%s|' "$CODEX_HOME" >> ${JSON.stringify(argsLog)}; printf '%s|' "$@" >> ${JSON.stringify(argsLog)}; echo >> ${JSON.stringify(argsLog)}
n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)
echo $((n+1)) > ${JSON.stringify(counter)}
if [ "$n" -eq 0 ]; then
  d="$CODEX_HOME/sessions/2026/09/17"; mkdir -p "$d"
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  f="$d/rollout-$ts-${THREAD}.jsonl"
  printf '{"timestamp":"%s","ordinal":0,"type":"session_meta","payload":{"id":"${THREAD}","timestamp":"%s","cwd":"%s","source":"exec"}}\\n' "$ts" "$ts" "$(pwd -P)" > "$f"
  if [ "${input.refuse ? 1 : 0}" -eq 1 ]; then
    printf '{"timestamp":"%s","ordinal":9,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","last_agent_message":null,"error":{"message":"%s"}}}\\n' "$ts" "$TM_TEST_LIMIT" >> "$f"
  fi
  exit ${input.firstExit}
fi
exit 0
`,
  );
  writeFileSync(join(tmHome, "config.json"), JSON.stringify({ codexBin: fake, policy: { headlessMinRespawnGapMs: 0, ...(input.config ?? {}) } }));
  for (const id of input.accounts) {
    mkdirSync(join(tmHome, "codex-stores", id.slice(0, 8)), { recursive: true });
    writeFileSync(join(tmHome, "codex-stores", id.slice(0, 8), "auth.json"), JSON.stringify(authBlob(id)));
  }
  writeFileSync(join(tmHome, "codex-accounts.json"), JSON.stringify({ version: 2, activeId: null, accounts: input.accounts.map((id) => account(id, id === A ? 5 : 50)) }, null, 2));
  return { tmHome, codexHome, cwd, binDir, argsLog };
}

function runShim(setup: ReturnType<typeof buildInstall>, argv: string[]) {
  return Bun.spawnSync([join(setup.binDir, "codex"), ...argv], {
    cwd: setup.cwd,
    env: {
      PATH: `${setup.binDir}:/usr/bin:/bin:${dirname(process.execPath)}`,
      TOKENMAXXING_HOME: setup.tmHome,
      TOKENMAXXING_CODEX_HOME: setup.codexHome,
      TOKENMAXXING_CODEX_TOKEN_URL: "http://127.0.0.1:9/codex-token",
      TOKENMAXXING_CODEX_USAGE_URL: "http://127.0.0.1:9/codex-usage",
      TOKENMAXXING_CLAUDE_SETTINGS: join(setup.tmHome, "settings.json"),
      TOKENMAXXING_SKIP_TIMER: "1",
      TM_TEST_LIMIT: LIMIT,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
}

const argsOf = (setup: ReturnType<typeof buildInstall>) => readFileSync(setup.argsLog, "utf8").trim().split("\n");
const jobRecords = (setup: ReturnType<typeof buildInstall>) => {
  const dir = join(setup.tmHome, "jobs");
  return existsSync(dir) ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
};
const accountsOf = (setup: ReturnType<typeof buildInstall>) => JSON.parse(readFileSync(join(setup.tmHome, "codex-accounts.json"), "utf8")).accounts as { id: string; enforcedUntil?: number }[];

const LAUNCH = ["exec", "--json", "--skip-git-repo-check", "-c", 'model_reasoning_effort="high"', "say ok"];

describe("codex exec through the shim (per-account stores)", () => {
  test(
    "a refused first turn walls the seat, moves the job to the sibling's store, and resumes as `exec resume <thread> <flags> \"\"`",
    () => {
      const setup = buildInstall("swap", { accounts: [A, B], firstExit: 1, refuse: true });
      const p = runShim(setup, LAUNCH);
      expect(p.stderr.toString()).toContain("moving the job");
      expect(p.exitCode).toBe(0);
      const storeA = join(setup.tmHome, "codex-stores", A.slice(0, 8));
      const storeB = join(setup.tmHome, "codex-stores", B.slice(0, 8));
      expect(argsOf(setup)).toEqual([
        `home=${storeA}|exec|--json|--skip-git-repo-check|-c|model_reasoning_effort="high"|say ok|`,
        `home=${storeB}|exec|resume|--json|--skip-git-repo-check|-c|model_reasoning_effort="high"|${THREAD}||`,
      ]);
      const walled = accountsOf(setup).find((a) => a.id === A)!;
      expect(walled.enforcedUntil).toBeGreaterThan(Date.now());
      expect(readdirSync(storeA)).toContain("sessions");
      const [rec] = jobRecords(setup);
      expect(rec).toMatchObject({ state: "done", sessionId: THREAD, respawns: 1, accountId: B });
      expect(realpathSync(rec.cwd)).toBe(realpathSync(setup.cwd));
      expect(existsSync(join(setup.tmHome, "codex-live")) ? readdirSync(join(setup.tmHome, "codex-live")) : []).toEqual([]);
    },
    60_000,
  );

  test(
    "with no sibling the job parks with EX_TEMPFAIL and the record names the thread to resume",
    () => {
      const setup = buildInstall("park", { accounts: [A], firstExit: 1, refuse: true });
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(EX_TEMPFAIL);
      expect(argsOf(setup).length).toBe(1);
      expect(jobRecords(setup)[0]).toMatchObject({ state: "parked", sessionId: THREAD });
      expect(p.stderr.toString()).toContain("parked");
    },
    60_000,
  );

  test(
    "a non-quota failure passes its exit code through with no move and no respawn",
    () => {
      const setup = buildInstall("crash", { accounts: [A, B], firstExit: 2, refuse: false });
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(2);
      expect(argsOf(setup).length).toBe(1);
      expect(accountsOf(setup).find((a) => a.id === A)!.enforcedUntil).toBeUndefined();
      expect(jobRecords(setup)[0].state).toBe("failed");
    },
    60_000,
  );

  test(
    "headlessManage=false falls back to plain passthrough (no seat, no record)",
    () => {
      const setup = buildInstall("off", { accounts: [A, B], firstExit: 1, refuse: true, config: { headlessManage: false } });
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(1);
      expect(argsOf(setup)).toEqual([`home=|exec|--json|--skip-git-repo-check|-c|model_reasoning_effort="high"|say ok|`]);
      expect(jobRecords(setup)).toEqual([]);
    },
    60_000,
  );
});
