// End-to-end through the real on-PATH codex shim: a fake codex that refuses
// its first turn the way 0.153.4 does (rollout `task_complete` with the limit
// message, exit 1) must be swapped onto the parked sibling and relaunched as
// `codex exec resume <thread> <flags> ""` - the incident of 2026-09-17, fixed
// (docs/auto-swap-long-sessions.md). Hermetic: own TOKENMAXXING_HOME +
// CODEX_HOME under tmp, mock OAuth refresh + usage endpoints on a free port.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EX_TEMPFAIL } from "../src/lib/headless.ts";

const repo = join(import.meta.dir, "..");
const scratch = join(tmpdir(), `tm-headless-codex-${process.pid}`);
const THREAD = "01a0ad51-919e-7ec2-885b-ee1e23d088d9";
const LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 9:44 PM.";
const week = 7 * 24 * 3600;

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

function authBlob(id: string) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({ email: `${id}@example.com`, "https://api.openai.com/auth": { chatgpt_account_id: `acct-${id}`, chatgpt_plan_type: "pro" } }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, acct: id }),
      refresh_token: `rt-${id}`,
      account_id: `acct-${id}`,
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
  };
}

function account(id: string, used: number) {
  return {
    accountId: `acct-${id}`,
    email: `${id}@example.com`,
    label: id,
    planType: "pro",
    credFile: `tokenmaxxing-codex-acct-${id}`,
    addedAt: "2026-09-01T00:00:00.000Z",
    needsReauth: false,
    lastUsage: { aggregate: [{ usedPercentage: used, resetsAt: Date.now() + week * 1000, windowSeconds: week }], perLimit: {} },
    lastUsageAt: Date.now(),
  };
}

// ---- mock endpoints ----------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
const usageCalls: Record<string, number> = {};
let refreshCalls = 0;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/codex-token") {
        const body = z.looseObject({ refresh_token: z.string() }).parse(await req.json());
        refreshCalls++;
        const id = body.refresh_token.replace(/^rt-/, "").split("-")[0]!;
        return Response.json({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, acct: id }), refresh_token: `${body.refresh_token}-rot` });
      }
      if (url.pathname === "/codex-usage") {
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const id = String(claims(bearer).acct);
        usageCalls[id] = (usageCalls[id] ?? 0) + 1;
        // the live seat reads healthy at the spawn gate and WALLED once the
        // refusal re-samples it; every sibling reads nearly empty.
        const used = id === "A" ? (usageCalls[id]! > 1 ? 100 : 10) : 5;
        return Response.json({
          account_id: `acct-${id}`,
          email: `${id}@example.com`,
          plan_type: "pro",
          rate_limit: { primary_window: { used_percent: used, limit_window_seconds: week, reset_at: Math.floor(Date.now() / 1000) + 2 * 86_400 } },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

// ---- hermetic install -----------------------------------------------------------

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** An on-PATH codex shim + a fake codexBin that, on its first run, writes a
 *  0.153.4-shaped rollout for THREAD under this cwd ending in the refusal and
 *  exits `firstExit`; later runs exit 0. Every argv is logged `|`-joined. */
function buildInstall(name: string, input: { accounts: string[]; firstExit: number; refuse: boolean }) {
  const root = join(scratch, name);
  const tmHome = join(root, "tmhome");
  const codexHome = join(root, "codexhome");
  const cwd = join(root, "work");
  const binDir = join(tmHome, "bin");
  for (const d of [binDir, codexHome, cwd, join(tmHome, "codex-creds")]) mkdirSync(d, { recursive: true });
  const argsLog = join(root, "args.log");
  const counter = join(root, "count");
  const fake = join(root, "fake-codex");
  writeExecutable(join(binDir, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(join(repo, "src", "main.ts"))} __supervise-codex "$@"\n`);
  writeExecutable(
    fake,
    `#!/bin/sh
printf '%s|' "$@" >> ${JSON.stringify(argsLog)}; echo >> ${JSON.stringify(argsLog)}
n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)
echo $((n+1)) > ${JSON.stringify(counter)}
if [ "$n" -eq 0 ]; then
  d="$TOKENMAXXING_CODEX_HOME/sessions/2026/09/17"; mkdir -p "$d"
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  f="$d/rollout-$ts-${THREAD}.jsonl"
  printf '{"timestamp":"%s","ordinal":0,"type":"session_meta","payload":{"id":"${THREAD}","timestamp":"%s","cwd":"%s","originator":"codex_exec","source":"exec"}}\\n' "$ts" "$ts" "$(pwd -P)" > "$f"
  if [ "${input.refuse ? 1 : 0}" -eq 1 ]; then
    printf '{"timestamp":"%s","ordinal":9,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","last_agent_message":null,"error":{"message":"%s"}}}\\n' "$ts" "$TM_TEST_LIMIT" >> "$f"
  fi
  exit ${input.firstExit}
fi
exit 0
`,
  );
  writeFileSync(join(tmHome, "config.json"), JSON.stringify({ codexBin: fake, policy: { headlessMinRespawnGapMs: 0 } }));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify(authBlob("A")));
  for (const id of input.accounts) {
    if (id !== "A") writeFileSync(join(tmHome, "codex-creds", `tokenmaxxing-codex-acct-${id}.json`), JSON.stringify(authBlob(id)));
  }
  writeFileSync(
    join(tmHome, "codex-accounts.json"),
    JSON.stringify({ version: 1, activeAccountId: "acct-A", accounts: input.accounts.map((id) => account(id, id === "A" ? 10 : 5)) }, null, 2),
  );
  return { tmHome, codexHome, cwd, binDir, argsLog };
}

function runShim(setup: ReturnType<typeof buildInstall>, argv: string[]) {
  return Bun.spawnSync([join(setup.binDir, "codex"), ...argv], {
    cwd: setup.cwd,
    env: {
      PATH: `${setup.binDir}:/usr/bin:/bin:${dirname(process.execPath)}`,
      TOKENMAXXING_HOME: setup.tmHome,
      TOKENMAXXING_CODEX_HOME: setup.codexHome,
      TOKENMAXXING_CODEX_TOKEN_URL: `http://127.0.0.1:${server.port}/codex-token`,
      TOKENMAXXING_CODEX_USAGE_URL: `http://127.0.0.1:${server.port}/codex-usage`,
      TOKENMAXXING_CLAUDE_JSON: join(setup.tmHome, "claude.json"),
      TOKENMAXXING_CLAUDE_SETTINGS: join(setup.tmHome, "settings.json"),
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
const activeId = (setup: ReturnType<typeof buildInstall>) => JSON.parse(readFileSync(join(setup.tmHome, "codex-accounts.json"), "utf8")).activeAccountId;
const liveId = (setup: ReturnType<typeof buildInstall>) => JSON.parse(readFileSync(join(setup.codexHome, "auth.json"), "utf8")).tokens.account_id;

beforeEach(() => {
  for (const k of Object.keys(usageCalls)) delete usageCalls[k];
  refreshCalls = 0;
});

const LAUNCH = ["exec", "--json", "--skip-git-repo-check", "-c", 'model_reasoning_effort="high"', "say ok"];

describe("codex exec through the shim", () => {
  test(
    "a refused first turn is swapped onto the parked sibling and resumed as `exec resume <thread> <flags> \"\"`",
    () => {
      const setup = buildInstall("swap", { accounts: ["A", "B"], firstExit: 1, refuse: true });
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(0);
      expect(argsOf(setup)).toEqual([
        'exec|--json|--skip-git-repo-check|-c|model_reasoning_effort="high"|say ok|',
        `exec|resume|--json|--skip-git-repo-check|-c|model_reasoning_effort="high"|${THREAD}||`,
      ]);
      expect(activeId(setup)).toBe("acct-B");
      expect(liveId(setup)).toBe("acct-B");
      expect(refreshCalls).toBe(1);
      const [rec] = jobRecords(setup);
      expect(rec.state).toBe("done");
      expect(rec.sessionId).toBe(THREAD);
      expect(rec.respawns).toBe(1);
      expect(rec.accountId).toBe("acct-B");
      expect(realpathSync(rec.cwd)).toBe(realpathSync(setup.cwd));
      // presence guarded the running seat and was cleared on exit
      expect(existsSync(join(setup.tmHome, "codex-live")) ? readdirSync(join(setup.tmHome, "codex-live")) : []).toEqual([]);
      expect(p.stderr.toString()).toContain("switching accounts");
    },
    60_000,
  );

  test(
    "with no usable sibling the seat stays, the job parks with EX_TEMPFAIL, and the record names the thread to resume",
    () => {
      const setup = buildInstall("park", { accounts: ["A"], firstExit: 1, refuse: true });
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(EX_TEMPFAIL);
      expect(argsOf(setup).length).toBe(1);
      expect(activeId(setup)).toBe("acct-A");
      const [rec] = jobRecords(setup);
      expect(rec.state).toBe("parked");
      expect(rec.sessionId).toBe(THREAD);
      expect(p.stderr.toString()).toContain("parked");
    },
    60_000,
  );

  test(
    "a non-quota failure passes its exit code through with no swap and no respawn",
    () => {
      const setup = buildInstall("crash", { accounts: ["A", "B"], firstExit: 2, refuse: false });
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(2);
      expect(argsOf(setup).length).toBe(1);
      expect(activeId(setup)).toBe("acct-A");
      expect(refreshCalls).toBe(0);
      expect(jobRecords(setup)[0].state).toBe("failed");
    },
    60_000,
  );

  test(
    "the unmanaged sentinel and headlessManage=false both fall back to plain passthrough",
    () => {
      const setup = buildInstall("off", { accounts: ["A", "B"], firstExit: 1, refuse: true });
      writeFileSync(join(setup.tmHome, "config.json"), JSON.stringify({ codexBin: join(scratch, "off", "fake-codex"), policy: { headlessManage: false } }));
      const p = runShim(setup, LAUNCH);
      expect(p.exitCode).toBe(1);
      expect(argsOf(setup).length).toBe(1);
      expect(jobRecords(setup)).toEqual([]);
      expect(activeId(setup)).toBe("acct-A");
    },
    60_000,
  );
});
