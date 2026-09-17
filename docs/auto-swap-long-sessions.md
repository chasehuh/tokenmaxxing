# Auto-swap for long headless sessions - design

Status: **implemented in the fork, 2026-09-17** (§10 records what landed,
the live verifications, and the deviations from §9). Written for the owner's fork
(`chasehuh/tokenmaxxing`, working tree at `e4687ed` + the uncommitted grok
ping work). Verified against the installed CLIs: codex-cli 0.153.4, Claude
Code 2.1.258, grok 1.0.11. All three change monthly; re-verify the marked
facts before implementing.

Companion to `DESIGN.md` (the interactive-session design). This document
covers the case `DESIGN.md` §7 scoped out: **headless, resume-driven jobs
that run for hours and are steered by a main agent**, the shape every Sume
worker has (`agent-human-stream` / `sume-bg-launch`).

---

## 0. The incident, in one paragraph

A Codex worker resumed at 02:05 UTC today onto the live codex seat, worked
for 110 seconds, then died with `You've hit your usage limit ... try again
at Sep 19th`. The live seat was at **100% weekly** (reset in 2d9h). Four
other pooled codex accounts held 30-100% of their weekly quota. The cached
codex usage snapshot was **27 hours stale**. No decision ran: the shim
passed `codex exec` straight through, no Stop hook fired, no timer exists
for the codex pool. The wrapper exited non-zero and the job was lost until a
human re-launched it. This is not a one-off: since 2026-09-06 the Sume live
logs record **14 codex worker deaths on the same message**, 13 of which a
main agent re-launched by hand, 1 lost outright. Claude and grok workers
show **zero** such deaths in the same window.

---

## 1. Current behavior map (what exists, per backend)

Legend: **push** = a feed the CLI writes for free; **pull** = tokenmaxxing
asks; **boundary** = a point where a decision can run.

| | Claude | Codex | Grok |
|---|---|---|---|
| Usage source | statusLine tee (`usage.json`, interactive only) → fallback `claude -p /usage` probe, TTL 90 s | free authed GET, TTL 90 s | free `billing?format=credits` GET |
| Limit *observation* | percent bars (5h 95 / weekly 98 / Fable cap) | percent bars (weekly primary, duration-classified) | weekly percent |
| Limit *signal* (server refusal) | none consumed. `-p` prints `result` with the limit text and exits; interactive shows it inline | none consumed. `exec --json` emits `{"type":"error"}` + `turn.failed`, exits non-zero | `StopFailure` hook with `error: rate_limit` → forced swap + respawn |
| Decision boundaries | Stop hook (fires in `-p` too), SessionStart, **check timer every 180 s** | Stop hook **only** (interactive, supervised, trusted) or manual `xx switch --codex` | Stop(end_turn), StopFailure(rate_limit) |
| Swap mechanics | credential swap under claude's refresh locks; running sessions **hot-adopt** (≤30 s macOS) | rewrite `auth.json`; a running codex **never adopts** (`reload_if_account_id_matches`); restart IS the switch | rewrite `auth.json`; running grok hot-reloads on next call (watcher may skip same-key) |
| Supervisor manages | interactive only. `-p`, `--version`, subcommands, picker-resume, fork-resume = passthrough | interactive only. **`exec` = passthrough** (`NONINTERACTIVE_SUBCMDS`) | interactive **and `-p`** |
| Respawn form | `claude --resume <sid> <persisted flags>` (depleted wait only) | `codex resume <sid>` (every swap) | `grok --resume <sid>` **and nothing else** (original flags dropped) |
| Presence (running-account guard) | none needed (shared seat, hot adopt) | per supervised session (`codex-live/`); **none for `exec`** | per supervised session (`grok-live/`) |
| Cross-session reconcile | n/a | signal + boundary promote (needs a Stop boundary) | n/a |
| Depleted pool | supervised: pause + countdown + `--resume`; unsupervised: nothing | stays put (no pause) | pause + countdown |
| Cooldown | 45 s global after any swap | 45 s global | (grok decide) |

### 1.1 How the Sume wrappers reach the CLIs

- `agent-human-stream --backend codex` runs
  `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-c model_reasoning_effort=…] [resume <id>] "<prompt>"`
  with stdin closed and **stdout redirected to a regular file** (codex's
  `println!` panics with EAGAIN on a backed-up pipe). A python formatter
  follows the file. Exit code = codex's exit code.
- `--backend claude` runs `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions [--resume <sid>] [--name …]`, piped into the formatter.
- `--backend grok` runs `grok -p "<prompt>" --output-format streaming-messages-json --permission-mode bypassPermissions --always-approve --no-auto-update [--resume <sid>]`.
- All three resolve `claude`/`codex`/`grok` from PATH, and PATH puts
  `~/.config/tokenmaxxing/bin` first on the desk and on the remote worker
  host (`sume-bg-remote` prepends it explicitly). The codex path even
  **hard-fails if the shim is not first** (`_codex_supervisor_check`,
  overridable with `TOKENMAXXING_REQUIRE_SUPERVISOR=0`).
- So every Sume worker already enters a tokenmaxxing supervisor. The shim
  then decides "not interactive" and hands the real binary the inherited
  stdio. **A fix at the supervisor layer reaches every wrapper, both hosts,
  and Cursor main agents with zero wrapper changes.**
- Steer/resume is `agent-human-stream --resume <id>` = a fresh process
  (`codex exec resume <id> "<new prompt>"`, `claude -p --resume`, `grok -p
  --resume`). Nothing retries. The registry (`opus-sessions.jsonl`) records
  start/session/end rows without an exit code on the local host.

### 1.2 What the log proves (local `tokenmaxxing.log`, all time)

- `codexstop.*` events: **0**. Not even `codexstop.unsupervised_skip`. With
  hundreds of `codex exec` runs and the Stop hook installed in
  `~/.codex/hooks.json`, the hook either does not fire for `exec` or is
  untrusted. Either way the codex decision has never run from a hook here.
  (0.153.4 carries hook-trust machinery and `codex exec
  --dangerously-bypass-hook-trust`; whether Stop fires in exec at all is
  **unverified**.)
- `codexsupervisor.launch`: 0. No interactive codex session ever ran under
  the shim on this desk; the 8 `codexswap.done` rows are manual `xx switch
  --codex`.
- Claude: 179 swaps, 130 greedy, 7 last-drop, 57 depleted; 378 `usage.probe_failed`
  + 125 `probe_unparsed` + 111 `probe_gave_up`. The probe of the **active**
  account is fail-silent by design (`/usage` prints no percentages when the
  token is busy), so a desk with only headless claude workers is usage-blind
  for the active account whenever no interactive claude is open to tee.
- Grok: 403 supervised launches (headless `-p` is managed), 2 swaps, no
  limit deaths observed.

---

## 2. Failure modes

- **F1 `codex exec` is unsupervised.** `shouldManageCodex` lists `exec` as
  non-interactive. No presence, no marker, no decision, no respawn. The one
  backend that cannot hot-adopt is the one the supervisor ignores for
  headless work.
- **F2 No codex spawn-time gate.** A resume launches onto whatever
  `auth.json` holds, even at 100%. Today's job was re-launched onto a walled
  seat with a fresh usable seat available. The codex usage GET is free; not
  asking before spawn is the single cheapest miss.
- **F3 No codex timer.** `tokenmaxxing check` is Claude-only. The codex
  snapshot rots (27 h today) and nothing reconciles the live seat.
- **F4 Mid-turn refusal loses the job.** Codex: `error` + `turn.failed`,
  non-zero exit, no resume. The rollout on disk is consistent (the
  interrupted turn's tool outputs and `task_complete` are persisted, checked
  on today's thread), so `codex exec resume <id>` would continue cleanly -
  nobody calls it.
- **F5 Exec workers are invisible to presence.** A manual `xx switch
  --codex` (or any future decision) can target an account currently running
  in an exec worker, and the sampler can refresh that account's parked
  token. On codex a refreshed parked copy of a running account kills the
  grant family on reuse. Latent today only because decisions never run.
- **F6 Claude `-p` is unmanaged.** Swaps still land (hooks + timer + hot
  adoption), which is why claude workers survive. But a depleted pool ends a
  `-p` run with an error result, and a request already inside claude's own
  retry loop keeps the old token until it dies. No respawn path exists.
- **F7 Grok respawn drops the launch shape.** `groksupervisor` relaunches
  `["--resume", sid]` only: a `-p --output-format streaming-messages-json`
  worker would come back as an interactive TUI on a non-TTY. Code-read,
  not reproduced live.
- **F8 Greedy churn taxes every live session.** 5-8 greedy claude swaps per
  day on this desk with 40-90 claude worker launches per day. Every swap
  moves the shared seat for **all** live claude sessions: N cold prompt
  prefills plus one turn of adoption lag each (§5).
- **F9 One global 45 s cooldown per pool.** N workers dying together
  serialize correctly on the flock, but a worker that dies 10 s after a
  sibling's swap must not be told "cooldown, stay" while its own seat is the
  walled one.
- **F10 Cross-host pools.** The remote worker host runs the same accounts
  with no cross-host lock (`docs/limitations.mdx`). Out of scope here;
  called out because headless jobs run on both hosts.

---

## 3. Goals and non-goals

Goals, in priority order:

1. A headless job that hits a limit continues **the same logical session**
   on a quota-holding account with no human relaunch.
2. A headless job never *starts* on a walled seat when a usable one exists.
3. All of it lives in tokenmaxxing; wrappers get it by keeping the shim
   first on PATH.
4. No new quota spend: decisions run on free reads and on server refusals.

Non-goals: proxying API traffic; changing the interactive UX; cross-host
locking; per-token accounting; retrying non-quota failures (a crash, a bad
prompt, a killed pipe stay fatal - only classified quota refusals resume).

---

## 4. Proposed design

### 4.1 Headless-managed mode

Each supervisor gains a third classification next to *managed-interactive*
and *passthrough*: **managed-headless**. Selected when the launch is a
session-bearing headless form and `TOKENMAXXING_UNMANAGED` is unset:

- claude: `-p`/`--print` with a prompt (positional, or `-` / stdin);
- codex: `exec …`, `exec resume …`, `exec fork …`;
- grok: `-p …` (already managed; only the respawn shape changes, §4.4).

Passthrough stays for `--version`, `--help`, `login`, `mcp`, `config`, etc.
Headless-managed keeps **inherited stdio by default** so the wrapper's
file-redirect trick and pipe semantics are untouched. It adds:

- a per-job id (`TOKENMAXXING_JOB_ID`, exported to the child as the pairing
  env like the interactive ids are), a presence file pinning the child pid,
  and a job record `jobs/<id>.json` `{backend, cwd, sessionId|null,
  accountId, launchArgs, respawns, state, waitUntil|null}` written on every
  transition (the headless analog of the countdown UI: `xx jobs` and the
  wrapper's `--status` can read it);
- the spawn gate (§4.2), the exit classifier (§4.3), the resume protocol
  (§4.4).

Nested launches inside a job (an agent running `codex exec` from a shell
tool) inherit `TOKENMAXXING_UNMANAGED` from the job's env exactly as the
interactive supervisors already do, so they pass through and never pair a
marker with the outer job.

### 4.2 Spawn gate (all backends, the free win)

Under the pool's flock, before every spawn and every respawn:

1. Resolve the live seat identity (codex `auth.json` id_token; claude
   `oauthAccount`; grok issuer map). Unpooled → passthrough, log, no gate.
2. If the seat's snapshot is older than `usagePollTtlMs`, sample it: codex
   and grok via their free GETs; claude via the tee if alive, else the
   `/usage` probe (fail-silent for a busy active token - accept the miss,
   see §6).
3. Run the existing pool decision (`evaluateAndMaybeSwapCodex` /
   `evaluateAndMaybeSwap` / grok) with a new flag `boundary: "spawn"`.
   At spawn nothing is running for this job, so **for codex this is the
   only free switch point**: no restart cost, no reconcile. The decision's
   greedy margin still applies (1.2x for codex).
4. Spawn on the resulting seat, write presence + job record.

Today's job would have been gated here: seat at 100%, four usable siblings,
swap, spawn. Cost: one GET.

### 4.3 In-flight detection: exit classifier + signal sniff

The supervisor cannot see percentages mid-turn for headless codex/claude
(no statusLine), so the load-bearing signal is the **server's refusal**,
classified at the process boundary. Two sources, both required:

**a. Exit classifier (always available).** On child exit:
- codex: exit ≠ 0 **and** the thread's rollout tail (`$CODEX_HOME/sessions/…/rollout-*-<thread>.jsonl`)
  or the captured stream carries the limit error. Match on the codex
  status vocabulary present in 0.153.4 strings (`usage_limited`,
  `rate_limit_exceeded`) and the wire message `You've hit your usage
  limit`, family-matched not exact (message text drifts).
- claude: `result` event with `is_error` and a limit message. Strings
  present in the 2.1.258 binary: `You've hit your limit`, `out of extra
  usage`; the raw API form `Claude AI usage limit reached|<epoch>` is
  server text and is **not** verified here - match by family, never exact.
- grok: existing StopFailure `rate_limit` path.

**b. Stream sniff (gives the session id and the error class early).** A
fresh `codex exec` only reveals its `thread_id` on stdout
(`thread.started`); a fresh `claude -p` reveals `session_id` in the
`system/init` event. Two options, decide at implementation:

- *Interpose*: spawn with `stdout: "pipe"`, copy bytes to the inherited fd
  in a tight loop, and scan only the first 64 KB of each line for
  `"type":"thread.started"`, `"type":"error"`, `"type":"turn.failed"`,
  `"type":"result"`. Risk: the EAGAIN panic the wrapper worked around.
  Mitigation: the copy loop never parses on the hot path and writes to a
  regular file / blocking pipe; a test with an 8 MB single-line payload is
  mandatory (§7).
- *Side-channel*: keep stdout untouched and learn the id from the CLI's own
  state - codex `session_index.jsonl` / newest rollout under this cwd
  started after our spawn; claude the newest transcript under
  `projects/<cwd-slug>/` (the `-c` lookup already exists). Cheaper and
  zero-risk to the stream, but racy under parallel launches in one cwd
  (common on this desk). Pin by comparing the rollout's recorded cwd + a
  start-time window; refuse to resume on ambiguity.

Recommendation: side-channel for the id, exit classifier for the error;
interpose only if the side-channel proves ambiguous in the parallel-cwd
test. Never sniff assistant *text* for "limit" (the Stop-hook lesson in
`AGENTS.md` "Do not reintroduce").

### 4.4 State machine

```
              ┌───────────── spawn gate (flock) ─────────────┐
              │ sample-if-stale → decide(boundary=spawn) → swap? │
              └──────────────────────┬───────────────────────┘
                                     ▼
 ┌──────────┐   exit 0 / non-quota exit   ┌──────────┐
 │ RUNNING  ├────────────────────────────►│ DONE     │  exit code passed through
 └────┬─────┘                             └──────────┘
      │ classified quota refusal (exit + signal)
      ▼
 ┌──────────┐  flock: re-read live seat identity + re-sample the seat we died on
 │ SWAP     │  ─ seat already moved by a sibling → skip swap (raced-already-swapped)
 │          │  ─ else decide(boundary=refusal, force=true): hard path, no cooldown,
 │          │    walk dead grants, exclude accounts present in OTHER jobs (§4.5)
 └────┬─────┘
      │ target installed            │ no usable target
      ▼                             ▼
 ┌──────────┐                 ┌──────────┐  soonest wall recovery ≤ headlessMaxWaitMs:
 │ RESUME   │                 │ WAIT     │  sleep (no TTY countdown; job record carries
 │          │◄────────────────┤          │  waitUntil; log once); else → PARKED
 └────┬─────┘                 └──────────┘
      │ respawn = resume form (§4.4.1), respawns++
      ▼
   RUNNING  (cap: policy.headless.maxRespawns per job, default 5; exceeded → PARKED)

 PARKED: exit 75 (EX_TEMPFAIL) + job record {state:"parked", waitUntil, resumeCmd}
```

Only a *classified* refusal enters SWAP. A depleted pool with a reset beyond
`headlessMaxWaitMs` (default: reuse `policy.maxWaitMs` = 1 h) parks with a
distinct exit code so the wrapper / main agent can distinguish "resumable
later" from "failed".

#### 4.4.1 Resume forms

| backend | first launch (verbatim argv) | respawn |
|---|---|---|
| codex | `exec [resume\|fork <id>] <flags> "<prompt>"` | `exec resume <thread_id> <persisted -c/-m flags> "<continuation>"` |
| claude | `-p "<prompt>" <flags>` (+ `--session-id <uuid>` injected when absent, as the interactive path does) | `-p "<continuation>" --resume <sid> <persisted flags>` |
| grok | `-p "<prompt>" <flags>` | `-p "<continuation>" --resume <sid> <persisted flags>` (fixes F7) |

Persisted flags reuse `stripPositionals`/`saveSessionFlags` (claude) and
a codex/grok twin; the original positional prompt is never replayed
(`DESIGN.md`'s adversarial-review rule). `fork` respawns as `resume` of
the *new* thread id learned from the stream/side-channel; if the id is
unknown at death, PARK rather than `--last` (the codex hook already refuses
blank ids for the same reason).

The **continuation prompt** is injected only after a classified refusal
(never on a clean exit) and is configurable (`policy.headless.resumePrompt`).
Default:

> The previous turn was interrupted by an account usage limit and the
> account has been switched. Continue from where you left off; do not repeat
> completed work.

Rationale: `codex exec resume` takes a prompt argument and the rollout
already holds the interrupted turn's tool outputs (verified on today's
thread), so the model sees its own partial work.

### 4.5 Account-selection policy (deltas only)

Keep pace-pressure ranking, screening bars, dead-grant walk. Add:

- **Boundary-aware cooldown.** The 45 s cooldown stays for `boundary:
  spawn|stop|timer`. A `boundary: refusal` decision bypasses it (grok's
  `force` precedent): the server just refused this seat; a snapshot cannot
  outrank that. But it still re-reads the live identity first - if a
  sibling already moved the seat, resume without swapping.
- **Presence covers headless jobs.** Every managed-headless job writes
  presence (child pid). Codex keeps "never target a present account, never
  refresh its parked token"; the deciding job's *own* account is the seat
  and is ranked as incumbent as today.
- **Headless siblings on the departed seat.** Codex cannot signal them
  (no Stop boundary in `exec`). They keep running on the old account until
  its wall or token expiry, then die, classify, and resume onto the live
  seat by themselves. This is acceptable: no work is lost, and the
  reconcile machinery stays interactive-only. Document, don't engineer.
- **Job stickiness.** A job's *own* greedy swap only happens at its spawn
  gate. Mid-job the seat moves only on the hard path. For the shared claude
  seat this means: when ≥1 headless claude job is present, the Stop-hook
  and timer decisions take the greedy path only if `policy.headless.greedyWithJobs`
  is true (default false); hard path unchanged. This is the caching lever
  (§5).
- **Respawn budget per job**, not per pool: `maxRespawns` (default 5) and
  `minRespawnGapMs` (default 10 s) protect against an account-selection
  loop (A refuses, B refuses, A "recovered" by a stale snapshot, …).

### 4.6 Codex timer

Add the codex pool to `tokenmaxxing check` (same launchd job, sequential):
it samples the live seat, reconciles cached snapshots, and swaps the seat
**only when no job or interactive session is present on it** (a swap under
a running codex strands it - the existing reconcile handles interactive,
§4.5 handles headless). Cheap, and it fixes F3 for the idle case so the next
spawn gate finds a fresh snapshot.

---

## 5. Caching: what actually pays, and what to change

Measured on this desk's codex worker streams (48 `turn.completed` rows,
168 M input tokens): **97.6 % of input tokens were cache reads**; the largest
single turn was 25 M input tokens at 99 % cached. Both vendors scope the
prompt cache to the **organization / account**: a swap makes the next
request a cold prefill, bounded by the live context (≤ ~1 M tokens for
codex, ≤ the model window for claude). Against turns of 7-25 M input
tokens, one cold prefill per swap is a **≤ 3-10 % surcharge on a single
turn**. Against losing the job, it is nothing. Cache is therefore **not**
a reason to avoid swapping on refusal, and it is not why codex swaps were
"avoided" - they were avoided because nothing could restart `exec`.

Where cache *is* the cost driver:

1. **Greedy churn on the shared claude seat** (F8). Each greedy swap =
   one cold prefill **per live claude session** plus adoption lag, with
   5-8 such swaps per day here. Recommendation: gate greedy swaps on
   headless presence (§4.5 `greedyWithJobs=false`), and raise the greedy
   floor while jobs run. Hard-path swaps (a bar crossed) are unaffected.
2. **Resume latency.** A swap at spawn/refusal should respawn within
   seconds so the *new* seat warms once. Never park a job to "save cache";
   cache on the old account is gone at the moment of refusal anyway.
3. **Steer-launched resumes** are already cold whenever the idle gap exceeds
   the vendor's cache retention; the spawn gate adds no cache cost there.
4. Do not build "cache affinity" (preferring the last account a job ran on)
   beyond stickiness: with weekly caps and pace-pressure ranking, affinity
   only delays the same swap to a worse moment.

---

## 6. Quota-observation races and gaps

- **Stale snapshot vs. real refusal.** Resolved by making the refusal the
  primary trigger (§4.3) and re-sampling the refused seat under the lock.
  A snapshot is only consulted for *choosing the target*, never for
  doubting the refusal.
- **Two jobs draining one seat.** Both die within seconds; both take the
  flock in turn; the first swaps, the second sees the live identity changed
  and resumes without swapping (`raced-already-swapped`). Verified shape:
  the interactive claude hook already does this under the flock.
- **Lock hold time.** A refusal decision holds the pool flock across one
  usage GET and one OAuth refresh (~1-3 s). With N simultaneous deaths the
  last waits N×3 s; acceptable, and far below a wall reset.
- **Codex token-family safety.** Unchanged invariants: never refresh a
  present account's parked token; harvest by true owner at the last moment;
  persist rotations instantly. Headless presence is what makes them hold
  for `exec` (F5).
- **Claude active-account blindness in `-p`.** With no interactive claude
  open, the tee is dead and the active probe is fail-silent. Today the
  timer + Stop hooks still swap because *some* probes succeed. The
  refusal classifier makes the blind spot survivable rather than solving
  observation. Options to solve it later, both needing the owner's call:
  parse the stream-json `result.usage` (no rate limits there today), or
  revisit the rejected direct usage GET for the *parked* accounts only.
- **`usage.json` org guard.** After a swap the tee still names the old org
  for up to 45 s; the spawn gate must read the live identity, not the tee's
  org, to decide whether it is on the seat it thinks it is (the existing
  `usageFresh` rule).
- **Cross-host.** A refusal-driven swap on one host can invalidate the
  other host's parked copy of the same codex account (reuse punishment).
  Unchanged from today; §2 F10.

---

## 7. Test plan

Hermetic (inside `bun test`):

1. **Classifier fixtures** from real lines: today's codex `{"type":"error"}`
   + `turn.failed` pair; a claude `result` with `is_error` and the limit
   text; a grok `StopFailure` envelope; negatives: a turn that merely
   *discusses* limits, a non-quota `turn.failed`, exit 1 with no signal.
2. **Argv classification**: `exec`, `exec resume <id> "<p>"`, `exec fork`,
   `-p` with/without `--resume`, `-p -` (stdin prompt), every passthrough
   form still passes through; `TOKENMAXXING_UNMANAGED` forces passthrough.
3. **Supervisor loop with a mock codex** (extend `supervisor-respawn.test.ts`):
   first spawn emits the limit and exits 1 → supervisor swaps (mock pool) →
   respawns `exec resume <id> "<continuation>"` with the persisted `-c`
   flags → mock exits 0 → exit code 0 propagates. Variants: id unknown →
   PARKED 75; `maxRespawns` exceeded → PARKED; sibling already swapped →
   resume without swap.
4. **Spawn gate**: stale snapshot + walled seat + usable sibling → swap
   before spawn; fresh snapshot under floor → no swap; unpooled live
   credential → passthrough.
5. **Concurrency** (extend the standalone `test/e2e/swap-concurrency.ts`,
   re-run by hand): 4 headless mocks die on the same seat within 100 ms →
   exactly one swap, one refresh, all four resume on the new seat.
6. **Stream safety** (only if interposition is chosen): a mock child writes
   one 8 MB line then 100 K short lines; no EAGAIN, byte-identical output
   file, `thread_id` captured.
7. **Grok respawn shape** (F7): `-p --output-format …` respawns with the
   same flags plus `--resume`.
8. **Side-channel id resolution**: two mock threads started in one cwd 50 ms
   apart → each job resolves its own id; ambiguous → PARKED, never
   `--last`.

Live (each needs the owner's go-ahead; they meter quota or open windows):

9. Reproduce today's death on purpose: the live codex seat is already at
   100 %, so one `codex exec "say ok"` through the new shim should be
   refused, swap, and resume on a sibling with no new spend on the walled
   account. Verify the rollout continues under the same thread id.
10. A claude `-p` worker with the pool forced to one nearly-walled account:
    confirm the classifier fires on the real result text and the resumed
    `-p --resume` continues the transcript.
11. Verify whether codex 0.153.4 fires Stop hooks in `exec` (with and
    without `--dangerously-bypass-hook-trust`); if it does, the hook can
    become a second signal source for headless codex.

---

## 8. Rollout

1. **Land in the fork behind `policy.headless.manage`** (default `true`
   in the fork; the upstream default is the owner's call). `doctor` prints
   the mode.
2. **Wrappers change nothing** to get the recovery: PATH already puts the
   shim first on both hosts, and `_codex_supervisor_check` enforces it.
3. **Optional wrapper upgrades**, once the shim ships:
   - treat exit 75 + `jobs/<id>.json` `state: parked` as "re-enqueue at
     `waitUntil`" instead of "failed" (`sume-bg-launch --status` can show
     the wait);
   - stop advising "run `tokenmaxxing status`, then relaunch" in the desk
     doc's Codex section; the note "a Codex swap applies on the next
     `codex` start" stays true and becomes the spawn gate;
   - remote host: nothing (same shim, same env).
4. **Cursor main agents** get it for free: they launch through the same
   wrappers.
5. Ship as one version bump per `AGENTS.md` "Release and CI"; update
   `docs/codex.mdx` (restart-based) and `docs/limitations.mdx` (headless
   siblings ride the old seat until refusal).

---

## 9. Open questions for the owner

1. **Continuation prompt**: inject a fixed text on refusal-resume (proposed),
   or resume with an empty turn and let the main agent steer? Empty is
   cleaner but codex `exec resume` wants a prompt and the job would idle.
2. **Greedy swaps while headless jobs run**: default off (proposed) or keep
   today's behavior? Off protects cache for N sessions; on keeps the pool
   pace-balanced faster.
3. **Codex target exclusion for accounts present only in headless jobs**:
   keep the conservative "never target a present account", or allow it
   (the departed seat's parked copy is authoritative once the seat moved)?
4. **Park exit code**: 75 (EX_TEMPFAIL) + job record, or block inside the
   supervisor until the reset regardless of `maxWaitMs` for headless jobs?
5. **Stream interposition vs side-channel** for learning a fresh thread id
   (§4.3): accept a small EAGAIN-class risk for a simpler, race-free id, or
   stay off the stream and resolve ids from rollout state?
6. **Claude `-p` active-account observation** (§6): revisit the rejected
   direct usage GET for parked accounts only, or accept the classifier as
   the safety net?
7. **Doc home**: keep this under `docs/` in the fork, or fold the durable
   parts into `DESIGN.md` §7 and the user docs once implemented?

---

## 10. Implementation status (2026-09-17)

Landed on the fork's working branch in one change set; no release cut.

| Design item | Where | State |
|---|---|---|
| Managed-headless classification (§4.1) | `codexsupervisor.isHeadlessCodexLaunch`, `supervisor.analyzeArgs().headless`, grok `-p` (already managed) | shipped; `policy.headlessManage=false` restores passthrough |
| Job records + presence (§4.1, §4.5) | `lib/headless.ts` (`jobs/<id>.json`), codex presence carries `headless: true` | shipped |
| Spawn gate (§4.2) | `HeadlessAdapter.spawnGate` → `evaluateAndMaybeSwapCodex({boundary:"spawn"})`, `evaluateAndMaybeSwap(now,false,{boundary:"spawn"})`, grok `evaluateAndMaybeSwapGrok({})` | shipped |
| Exit classifier + side channels (§4.3) | `isQuotaRefusalText`, `codexRolloutRefusal`, `resolveCodexThreadId`, `claudeTranscriptRefusal`, `resolveClaudeSessionId` | shipped; side-channel only, no stdout interposition |
| State machine (§4.4) | `runHeadlessJob` | shipped: resume / wait ≤ `headlessMaxWaitMs` / park with exit 75 + record |
| Resume forms (§4.4.1) | `codexResumeArgs` → `exec resume <thread> <flags> ""`; claude `<flags> --resume <sid> ""`; `grokRespawnArgs` | shipped (grok deviates, below) |
| Boundary-aware cooldown, refusal hard path, `waitUntil` (§4.5) | `codexdecide` `CodexBoundary`, `decide` `ClaudeBoundary`, `codexUsableAt` | shipped |
| Greedy suppression with jobs (§4.5, §5) | `decide.ts` + `policy.headlessGreedyWithJobs` (default off) | shipped |
| Respawn budget / gap | `policy.headlessMaxRespawns` (5), `policy.headlessMinRespawnGapMs` (10 s) | shipped |
| Codex timer (§4.6) | `cmdCheck` → `evaluateAndMaybeSwapCodex({boundary:"timer"})`, `seat-in-use` when present | shipped |
| Reconcile skips headless presences (§4.5) | `reconcileNonLiveSiblings` | shipped |

Tests: `bun test` 439 pass / 1 skip (was 401); new files `test/headless.test.ts`,
`test/headless-loop.test.ts`, `test/headless-codex.test.ts` (the incident,
end to end through the real shim with a fake codex + mock endpoints), plus
boundary cases in `test/codex.test.ts` and `test/decide.test.ts`. The
standalone `bun test/e2e/swap-concurrency.ts` re-run by hand: ALL PASS.

### 10.1 Live verifications (owner-authorized, 2026-09-17)

- **codex 0.153.4 exit code on a quota refusal: 1.** `codex exec --json` on
  the walled seat printed `thread.started`, then `{"type":"error"}` +
  `turn.failed` with the limit text, exit 1. The rollout ends with an
  `event_msg` `task_complete` whose `error.message` carries the same text -
  the side channel the classifier reads.
- **Stop hook in `exec`: did not fire on the refused turn.** The installed
  `~/.codex/hooks.json` Stop entry produced zero `codexstop.*` log lines
  across two refused `exec` runs. Whether it fires on a *successful* exec
  turn, and whether the hook is trusted, is still unknown (the desk has no
  cheap way to run a successful exec turn on a walled seat); the design does
  not depend on it.
- **`codex exec resume <id>` needs a prompt argument**: no argument exits 1
  locally ("No prompt provided via stdin"); `""` is accepted and reaches the
  server. The resume form uses `""`.
- **claude 2.1.258 `-p ""` passes argument validation** (`-p "" --resume
  <bogus>` failed on the bogus id, not the empty prompt) and **`-p …
  --session-id <uuid>` is honored** (the smoke run's stream `session_id`
  matched the injected id). An end-to-end empty-prompt resume on a real
  refusal is not yet observed.
- **grok 1.0.11 rejects an empty `-p`** ("--single: prompt is empty").
- **Timer swap of the walled codex seat:** four minutes after the code
  landed in the working tree (the live install), `tokenmaxxing check`
  logged `codexdecide.hard_swap` + `codexswap.done` moving the idle walled
  seat onto a sibling with quota - the §4.6 path, on the real pool.
- **Smokes through the new shim:** `claude -p "…" --output-format stream-json`
  and `codex exec --json "…"` each ran one tiny turn: gate logged
  (`under-threshold-or-stale`), job record `done`, exit 0, presence cleared.

### 10.2 Deviations from the §9 decisions

- **Grok cannot resume empty.** Its respawn injects the one-word prompt
  `continue` (`GROK_CONTINUATION_PROMPT`); codex and claude resume with `""`
  as decided.
- Everything else follows §9: greedy suppressed with jobs (default off), park
  = exit 75 + record with no blocking wait beyond the cap, conservative
  codex target exclusion (headless presences bench their account), side
  channel only, no direct usage GET for claude `-p`.

### 10.3 Still needs a live limit event to prove

- The refusal → swap → `exec resume <thread> ""` path on a real codex
  refusal (hermetically proven; the real pool's walled seat was moved by the
  timer before a job could hit it).
- The claude transcript shape of a real refusal (`isApiErrorMessage` +
  text is the assumption; a miss degrades to today's behavior).
- The empty-prompt resume actually continuing the interrupted turn on each
  vendor (CLI acceptance verified; model behavior not).
- Grok's `--resume` with the `continue` prompt after a `StopFailure`
  rate_limit on a `-p` run.
