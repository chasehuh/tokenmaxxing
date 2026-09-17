# Managed-headless jobs on the per-account-store engine

Status: **implemented on the fork's `managed-headless-v150` branch (2026-09-17)**, rebuilt on
upstream v1.50.0 (`fe5eb38`). This supersedes the 1.8-lineage design of the same name; the
incident analysis and the behaviour map of the old engine are in the git history of that branch
(`grok-build-pool`). Verified CLIs: codex-cli 0.153.4, Claude Code 2.1.258, grok 1.0.11.

## 1. Why

A Sume desk runs its workers headless: `codex exec --json`, `claude -p --output-format
stream-json`, `grok -p`. Upstream's engine places and moves **interactive** sessions (a seat
per session through `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CODEX_HOME`, a move by respawn from
the session's own hook) but passes every headless launch straight through: no seat, no
presence, no move. On 2026-09-17 a `codex exec` worker died on `You've hit your usage limit`
with four pooled accounts holding quota; the desk logs held fourteen such deaths in eleven
days. This branch makes a headless launch a **job**: placed on a seat before it starts,
classified at exit, moved and resumed on a refusal, parked with a resumable record when the
whole pool is walled.

## 2. What the engine already gave us, and what was added

| Need | Upstream 1.50.0 | Added here |
|---|---|---|
| Seat per session, presence, placement ranking | `pickSeat` / `pickCodexSeat`, `presence.ts`, `picker.ts` | `placeSeat` (claude) and `placeCodexSeat` (codex, with a seat-sharing fallback) return **seat / wait / none** so a job never launches onto a walled account |
| Move on a refusal | StopFailure hook stamps `enforcedUntil` and moves an interactive session | the same engine call from the job supervisor with a caller-named seat (`evaluateAndMaybeSwap(..., { seatId })`), because a supervisor process has no seat variable of its own |
| Refusal signal | transcript row `isApiErrorMessage` + `quotaLimits` (claude); none for `codex exec` | claude: the same structured rows, read after exit (`claudeTranscriptRefusal`); codex: the thread's rollout `task_complete.error.message` (`codexRolloutRefusal`), with the reset clock parsed from the message |
| Session identity for a fresh headless launch | none | claude: `--session-id` injected; codex: the rollout stamped under this cwd after spawn (`resolveCodexThreadId`), **ambiguous = park, never `--last`** |
| Headless management | `-p` and `exec` pass through | `runHeadlessJob` (`src/lib/headless.ts`) with a per-backend adapter in each supervisor |
| Job records | none | `jobs/<id>.json`: state, seat, session id, `waitUntil`, respawn count; exit **75** (`EX_TEMPFAIL`) = parked |
| Codex on the check tick | Claude accounts only | idle (non-present) codex and grok accounts sampled per tick, oldest first, three per tick |
| Grok | status-only pool | a real provider: usage GET, per-account store homes, supervisor, Stop + StopFailure hooks, placement and moves |

Dropped from the 1.8 design, with reasons:

- **Greedy suppression while jobs run.** Upstream deleted the greedy path (one bar, "under the bar the seat holds"), so there is nothing to suppress.
- **Post-swap cooldown handling.** Per-session seats need no swap clock; nothing another session reads is invalidated by a move.
- **Cross-session codex reconcile.** Gone upstream with the shared live `auth.json`; a headless job on a departed seat rides it to the refusal and moves itself.

## 3. Behaviour per backend

### 3.1 Codex (`codex exec …`)

1. **Place.** Under the pool lock: the wanted account (after a move) if still usable, else
   the best usable account with no live session, else (`policy.headlessShareCodexSeats`,
   default on) the least-loaded usable account, else wait for the soonest reset, else none.
   Sharing is a Sume-desk deviation from upstream's "two sessions never share a codex login":
   the desk runs more concurrent codex workers than pooled accounts, and it ran every worker
   on one shared login for weeks under the old engine. Set the policy to `false` to park
   instead.
2. **Spawn** with `CODEX_HOME` = the seat's store (`ensureCodexStoreHome`), presence keyed by
   the job id, `TOKENMAXXING_UNMANAGED=1` for the subtree, `TOKENMAXXING_JOB_ID` for the hooks.
3. **Exit.** `0` = done. A signal = failed. Non-zero: resolve the thread (argv for `resume`,
   rollout side channel for a fresh `exec` or `fork`), read the rollout tail for a
   `task_complete.error.message` in the refusal families, stamped after the spawn.
4. **Refusal.** `evaluateAndMaybeSwap(codex, now, true, { account: seat, kind: "weekly",
   resetsAt: <parsed> }, { seatId: seat })` walls the seat (`enforcedUntil`) and picks the
   target; a target means respawn `codex exec resume <thread> <original flags> ""`. No target:
   wait in place for the soonest recovery when it lands within `policy.headlessMaxWaitMs`,
   else park.

Verified live on 2026-09-17: a refused `exec` turn exits 1, prints `error` + `turn.failed`,
persists the message in the rollout, and does **not** fire the Stop hook. `exec resume <id>`
requires a prompt argument; `""` reaches the server.

### 3.2 Claude (`claude -p …`)

Same loop. Placement is upstream's ranking with the wait outcome added. The seat is the
store variable, presence is keyed by the job id, and `--session-id` is injected for a fresh
launch so the respawn can name the transcript. The refusal classifier reuses upstream's
StopFailure row parsing (`findEnforcedRow` semantics, `classifyEnforcedLimit`) on the
transcript tail after exit: only rows Claude Code marked `isApiErrorMessage` with
`error: "rate_limit"` classify, transient errors and quoted prose never do. The StopFailure
hook inside the job still stamps the seat first (it runs under the seat's store); the
supervisor's classifier is the move path. The unsupervised hint the hook prints is suppressed
inside a job.

Respawn: `<persisted flags> --resume <sid> <policy.headlessResumePrompt>`; the prompt is empty
by default (owner decision 2026-09-17: the main agent steers). `-p ""` passes Claude Code's
argument validation (verified); an end-to-end empty-prompt resume on a real refusal is not yet
observed.

### 3.3 Grok (`grok`, `grok -p …`)

The status-only upstream provider became a full one:

- **Usage** from the free `billing?format=credits` GET with the store's `key` as bearer, one
  weekly window; a 401 on an in-TTL key of an idle account stamps `needsReauth`, an expired
  key is an honest miss (grok refreshes it on the next session).
- **Store homes**: `grok-stores/<uuid8>/` holds `auth.json`; everything else in `~/.grok`
  (hooks, sessions, skills, config, downloads, …) is a symlink, so `--resume` and the global
  hooks work across stores, and `auth.json.lock` stays per store. The supervisor sets
  `GROK_HOME` to the store at spawn.
- **Seats** are `shared` (grok hot-reloads its own store file; several sessions may share an
  account), `waitsWhenDepleted` (countdown to the soonest weekly reset).
- **Hooks**: one always-trusted sibling file `~/.grok/hooks/tokenmaxxing-grok.json` with Stop
  (`end_turn` only) and StopFailure (`rate_limit`). A StopFailure first re-samples the seat:
  a seat the server still reads under the bar is a transient error (capacity 503/529 also
  classify as `rate_limit`) and moves nothing; a walled seat gets `enforcedUntil` and a move.
- **Respawn** keeps the launch shape (`grokRespawnArgs`): flags with values, `-p` kept, the
  one-shot prompt dropped, `--resume <sid>` added. grok rejects an empty `-p`
  (`--single: prompt is empty`, verified 1.0.11), so a `-p` respawn carries the one-word
  prompt `continue` — the one deviation from the empty-resume rule.
- `grok -p` is managed in the marker loop (hook-driven), not the exit-classifier loop: grok's
  StopFailure is the refusal signal and there is no on-disk side channel to read after exit.

## 4. Records, exit codes, budgets

- `jobs/<jobId>.json`: `backend, cwd, sessionId, accountId, launchArgs, respawns, state
  (running|waiting|done|failed|parked), waitUntil, pid, startedAt, reason`. Pruned after 30
  days. `livingHeadlessJobs()` checks process identity (pid + `ps lstart`).
- Exit code: the CLI's own on done/failed; **75** on park. A wrapper that sees 75 has a
  resumable session in the record.
- `policy.headlessMaxRespawns` (5) caps refusal-driven respawns and in-place waits per job;
  `policy.headlessMinRespawnGapMs` (10 s) spaces spawns; `policy.headlessMaxWaitMs` (1 h) caps
  an in-place wait; `policy.headlessManage=false` restores passthrough.

## 5. Init / migration on the desk hosts (owner step)

Per-account stores are new state. Nothing migrates the 1.8 pool (`accounts.json` version 1,
the `tokenmaxxing-cred-*` keychain items, `codex-creds/`, `grok-creds/`): credential copies
between stores are forbidden upstream and this branch changes no credential. Every `init` /
`add` is an interactive browser or device login, so the owner runs them; everything else was
prepared on 2026-09-17:

| | Laptop | Mini |
|---|---|---|
| Ported tree | `~/.local/src/tokenmaxxing-v150` at `d0fdd1b`, deps installed, `bun test` 36/36, typecheck clean | same path, same SHA, same results |
| Current install | source checkout of the 1.8 lineage (`grok-build-pool`, owner's uncommitted grok work inside - left untouched) | bun global `tokenmaxxing@1.10.0` (upstream npm) plus a post-exec script that mirrors the live keychain credential to `~/.claude/.credentials.json` |
| Old state | v1 pools: 6 Claude, 5 Codex, 3 grok | v1 pools: 6 Claude, 5 Codex; no grok pool |
| Config | bins only (compatible) | ladder-style `thresholds.session: [75,85,95]` - rejected by the v1.50 schema, must be rewritten (below) |
| Keychain from the worker launch context | GUI shell: works | SSH session (`sume-bg-remote`): `security` read **and** write fail with error 36 ("User interaction is not allowed") even with the GUI session logged in |

The new install is taken from the ported clone, so the old checkout keeps the owner's
uncommitted work and the old install stays runnable until the cutover.

### 5.1 Laptop

```sh
# 0. quiet moment: running workers keep their old code; only new launches are affected
cd ~/.local/src/tokenmaxxing-v150 && git pull --ff-only && bun install --frozen-lockfile && bun run typecheck && bun test

# 1. list the accounts to sign in with (labels only, from the v1 index)
python3 -c 'import json;[print(p, [a["label"] for a in json.load(open(f"/Users/$USER/.config/tokenmaxxing/{p}"))["accounts"]]) for p in ("accounts.json","codex-accounts.json","grok-accounts.json")]'

# 2. retire the v1 state (index + parked copies; the keychain items stay until you delete them)
cd ~/.config/tokenmaxxing && mkdir -p retired-v1 && mv accounts.json codex-accounts.json grok-accounts.json lastswap.json codex-lastswap.json grok-lastswap.json usage.json model-usage.json spawnrate.json codex-creds grok-creds sample respawn grok-respawn codex-live grok-live retired-v1/ 2>/dev/null; ls

# 3. Claude, first account: an isolated claude opens - run /login as that account; it closes itself
cd ~/.local/src/tokenmaxxing-v150 && bun run src/main.ts init
#    success: "imported current account", "installed claude supervisor + statusLine/Stop/StopFailure/SessionStart hooks",
#    "periodic check timer active"; `cat ~/.config/tokenmaxxing/bin/tokenmaxxing` names .../tokenmaxxing-v150/src/main.ts
# 4. Claude, each further account (repeat per label from step 1)
tokenmaxxing add
# 5. Codex, first account: device auth (open the URL, enter the code, sign in as that account)
tokenmaxxing init --codex
# 6. Codex, each further account
tokenmaxxing add --codex
# 7. grok: pools the live ~/.grok login without a browser, installs the grok shim + hook file
tokenmaxxing init --grok
# 8. grok, each further account (browser login in the isolated home)
tokenmaxxing add --grok
# 9. verify
tokenmaxxing doctor && tokenmaxxing status && which claude codex grok && ~/.cstack/src/install.sh | grep -A2 "tokenmaxxing (local"
```

`doctor` will warn that the codex Stop hook is untrusted per seat; `exec` jobs do not use
it. The old `tokenmaxxing-cred-*` keychain items and `retired-v1/` are the owner's to delete
once `status` shows every account sampling.

### 5.2 Mini

Codex and grok stores are plain files under `~/.config/tokenmaxxing/`, so those pools work
from SSH-launched workers unchanged. **The Claude pool does not, as ported**: the per-account
store is a keychain item, and the Mini's SSH context cannot read one (verified 2026-09-17:
`security find-generic-password -w` and `add-generic-password` both exit 36). Today's
install survives only because the post-exec script copies the one live credential into
`~/.claude/.credentials.json`, the file Claude Code falls back to; v1.50's `init` rewrites
the shim without that line. Pick one before onboarding Claude there:

- **A.** Launch Mini workers from the GUI security session instead of the SSH session
  (a `launchctl`-submitted agent or `launchctl asuser` dispatch in `sume-bg-remote`), so the
  keychain is readable and no credential is ever copied. Cleanest; a cstack change.
- **B.** Keep the mirror hack, per store: after each GUI-context refresh, copy every
  `stores/<uuid8>` keychain item to `stores/<uuid8>/.credentials.json`. Credential copies,
  same grant in two places - the failure mode upstream documents.
- **C.** Onboard Codex and grok now, leave the Mini Claude pool on the old install until A
  lands.

The non-interactive part, whichever option:

```sh
ssh <mini>            # then in a login shell
cd ~/.local/src/tokenmaxxing-v150 && git pull --ff-only && bun install --frozen-lockfile && bun run typecheck && bun test
# retire the v1 state and the ladder config (the old global stays installed but unreferenced once init rewrites the shim)
cd ~/.config/tokenmaxxing && mkdir -p retired-v1 && cp config.json retired-v1/config.json && mv accounts.json codex-accounts.json lastswap.json codex-lastswap.json usage.json model-usage.json codex-creds sample respawn retired-v1/ 2>/dev/null; true
cat > ~/.config/tokenmaxxing/config.json <<'EOF'
{
  "claudeBin": "/Users/chasehuh/.bun/bin/claude",
  "codexBin": "/Users/chasehuh/.local/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
  "thresholds": { "session": 90, "weekly": 98 }
}
EOF
# Codex first (file stores, SSH-safe): device auth per account
cd ~/.local/src/tokenmaxxing-v150 && bun run src/main.ts init --codex && tokenmaxxing add --codex   # repeat add per account
# grok, if the Mini's grok login should be pooled
tokenmaxxing init --grok
# Claude: only after A/B/C is decided; then `bun run src/main.ts init` + `tokenmaxxing add` per account IN THE GUI SESSION (Screen Sharing), never over ssh
# after the Claude init the shim no longer runs the mirror script; re-add it only under option B
tokenmaxxing doctor && tokenmaxxing status && bun remove -g tokenmaxxing
```

Note `init --codex` on a host without a Claude pool installs no check timer (upstream:
only the Claude `init` installs it); the Mini's existing `com.tokenmaxxing.check` agent keeps
pointing at the old global until the Claude `init` rewrites it.

## 6. Tests

`bun test` (added back on the fork; upstream carries no tests): `test/headless.test.ts`
(classifier, reset clock, side channels, argv, job records, placement), `test/headless-loop.test.ts`
(state machine with a scripted adapter and an injected move), `test/headless-codex.test.ts`
(the incident end to end through the real `codex` shim with a fake codex, per-account stores,
no network), `test/grok.test.ts` (credits mapper, store home symlinks, respawn args, placement,
Stop/StopFailure hook against a mock billing endpoint). `tsc --noEmit` clean.

Not covered hermetically: the Claude job loop end to end (the store is a macOS keychain item;
the pieces are unit-tested), and a live refusal on any backend.

## 7. Open items

- Codex `exec` hook trust: whether a trusted Stop hook fires on a successful `exec` turn is
  unverified; the design does not depend on it.
- The empty-prompt resume continuing the interrupted turn (claude, codex) is CLI-verified only.
- Seat sharing for codex is a desk policy, not an upstream one; `headlessShareCodexSeats=false`
  restores the strict rule and parks when every usable account is busy.
- Placement and spawn take the pool lock separately; two jobs launching in the same instant can
  land on one free account. Sharing makes that harmless; with sharing off it is a benign race.
