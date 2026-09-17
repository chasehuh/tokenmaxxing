// Resolve the REAL grok binary (never our shim on PATH). Same guarantees as
// claudebin/codexbin: a configured-but-missing pin fails fast instead of
// degrading to a scan, and anything that realpath-resolves into our binDir is
// refused (spawning it as grok would recurse through the grok supervisor).
// One grok-specific layer: the desk PATH `grok` is the installer's launcher
// at ~/.grok/bin/grok, which `grok update` clobbers - `init --grok` therefore
// prefers the newest versioned Mach-O/ELF under ~/.grok/downloads/ as the pin
// (issue #1), falling back to the PATH scan when no download exists.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, pointsBackAtUs } from "./claudebin.ts";
import { loadConfig } from "./state.ts";
import { grokPaths, paths } from "./paths.ts";

/** First PATH entry with a `grok` that is not us. null when PATH has none. */
export function scanPathForGrok(): string | null {
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const cand = join(d, "grok");
    try {
      if (existsSync(cand) && statSync(cand).isFile() && !pointsBackAtUs(cand)) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

/** Newest grok-* binary under $GROK_HOME/downloads (mtime order), or null. */
export function newestDownloadedGrok(): string | null {
  if (!existsSync(grokPaths.downloadsDir)) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(grokPaths.downloadsDir)) {
    if (!name.startsWith("grok")) continue;
    const cand = join(grokPaths.downloadsDir, name);
    try {
      const st = statSync(cand);
      if (!st.isFile()) continue;
      if (best == null || st.mtimeMs > best.mtimeMs) best = { path: cand, mtimeMs: st.mtimeMs };
    } catch {
      continue;
    }
  }
  return best?.path ?? null;
}

export function resolveRealGrok(): string {
  const cfg = loadConfig();
  if (cfg.grokBin) {
    if (!existsSync(cfg.grokBin)) {
      throw new Error(`configured grokBin does not exist: ${cfg.grokBin} - fix config.json`);
    }
    if (pointsBackAtUs(cfg.grokBin)) {
      throw new Error(
        `configured grokBin (${cfg.grokBin}) is tokenmaxxing's own wrapper - spawning it recurses. Point grokBin at the real grok binary in ${paths.configJson}`,
      );
    }
    return cfg.grokBin;
  }
  const scanned = scanPathForGrok();
  if (scanned) return scanned;
  throw new Error("could not locate the real `grok` binary (set grokBin in config.json)");
}

/** Behavioral check used by `init --grok` before pinning: the binary must
 *  answer `--version` identifying itself as grok ("grok 1.0.8 (…)"), without
 *  re-entering our wrapper (depth preset to the cap kills a poisoned pin on
 *  first entry). Returns null when the binary passes, else the failure detail. */
export function verifyRealGrok(input: { bin: string }): string | null {
  const env = { ...process.env, [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH), TOKENMAXXING_PROBE: "1" };
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync([input.bin, "--version"], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const outText = (p.stdout?.toString() ?? "").trim();
  const err = (p.stderr?.toString() ?? "").trim();
  if (p.exitCode === 0) {
    if (outText.toLowerCase().includes("grok")) return null;
    return `--version output does not identify grok: "${outText.slice(0, 80)}"`;
  }
  if (err.includes(LOOP_DIAGNOSIS)) return "it leads back into the tokenmaxxing wrapper (recursion)";
  return `--version exited ${p.exitCode ?? "on signal/timeout"}: ${(err || outText).slice(0, 160)}`;
}
