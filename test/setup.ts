import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = join(tmpdir(), `tm-test-${process.pid}`);
rmSync(base, { recursive: true, force: true });
for (const d of ["home", "claudedir", "codexhome", "grokhome", "LaunchAgents", "systemd-user"]) mkdirSync(join(base, d), { recursive: true });

const mockPort = 20000 + ((process.pid * 3) % 30000);
export const MOCK_OAUTH_PORT = mockPort;
export const MOCK_CODEX_PORT = mockPort + 1;
export const MOCK_GROK_PORT = mockPort + 2;

process.env.TOKENMAXXING_HOME = join(base, "home");
process.env.CLAUDE_CONFIG_DIR = join(base, "claudedir");
process.env.TOKENMAXXING_CLAUDE_SETTINGS = join(base, "settings.json");
process.env.TOKENMAXXING_CODEX_HOME = join(base, "codexhome");
process.env.TOKENMAXXING_GROK_HOME = join(base, "grokhome");
process.env.TOKENMAXXING_OAUTH_PROFILE_URL = `http://127.0.0.1:${MOCK_OAUTH_PORT}/profile`;
process.env.TOKENMAXXING_OAUTH_USAGE_URL = `http://127.0.0.1:${MOCK_OAUTH_PORT}/usage`;
process.env.TOKENMAXXING_CODEX_TOKEN_URL = `http://127.0.0.1:${MOCK_CODEX_PORT}/codex-token`;
process.env.TOKENMAXXING_CODEX_USAGE_URL = `http://127.0.0.1:${MOCK_CODEX_PORT}/codex-usage`;
process.env.TOKENMAXXING_GROK_BILLING_URL = `http://127.0.0.1:${MOCK_GROK_PORT}/grok-billing`;
process.env.TOKENMAXXING_KEYCHAIN_ACCOUNT = `tokenmaxxing-test-${process.pid}`;
process.env.TOKENMAXXING_SHELL_RC = join(base, "shellrc");
process.env.TOKENMAXXING_SKIP_TIMER = "1";
process.env.TOKENMAXXING_LAUNCHD_DIR = join(base, "LaunchAgents");
process.env.TOKENMAXXING_SYSTEMD_USER_DIR = join(base, "systemd-user");
process.env.NO_COLOR = "1";
delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;
delete process.env.TOKENMAXXING_SUPERVISED;
delete process.env.TOKENMAXXING_SESSION_ID;
delete process.env.TOKENMAXXING_JOB_ID;
delete process.env.TOKENMAXXING_UNMANAGED;

declare global {
  var __TM_TEST_BASE__: string | undefined;
}
globalThis.__TM_TEST_BASE__ = base;
