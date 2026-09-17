// Read/write grok credential blobs ($GROK_HOME/auth.json and parked copies).
// The live file is a top-level map of `<issuer>::<client_id>` → issuer object
// with ONE slot in practice (two SuperGrok users share the map key), so a swap
// replaces the whole lossless map. Grok DOES flock its own auth.json.lock on
// every mutation (binary-verified 1.0.8), so unlike codex there is a real
// serialization point with the running binary: every live-file mutation runs
// with the CALLER holding withLock(grokPaths.authJsonLock) around its whole
// critical section, plus tokenmaxxing's own grok flock for our actors.
//
// There is deliberately NO self-refresh here (issue #1): grok's OIDC refresh
// goes through the IdP with machinery we must not reimplement, and the real
// binary refreshes an installed credential itself on the next spawn/API call.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { grokPaths } from "./paths.ts";
import { GrokAuthJsonSchema, GrokIssuerSchema, type GrokAuthJson, type GrokIssuer } from "./types.ts";

function isEnoent(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

/** auth.json at an explicit path (the live file, or an onboard dir's), or null
 *  when absent. Throws on a present-but-unparsable file: that is drift to
 *  surface, not to paper over. */
export function readGrokAuthAt(input: { path: string }): GrokAuthJson | null {
  let raw: string;
  try {
    raw = readFileSync(input.path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
  return GrokAuthJsonSchema.parse(JSON.parse(raw));
}

/** The live auth.json, or null when grok has no login here. Plain read: the
 *  callers that mutate re-read under the locks. */
export function readLiveGrokAuth(): GrokAuthJson | null {
  return readGrokAuthAt({ path: grokPaths.authJson });
}

/** Replace the whole live map, atomic 0600. The CALLER holds grok's own
 *  auth.json.lock (one withLock around its whole harvest-install critical
 *  section - flock via a second fd would deadlock a nested acquire) plus
 *  tokenmaxxing's grok flock; a running grok can be mid-refresh, and its
 *  auth.json.lock is the one real serialization point with it. */
export function writeLiveGrokAuth(input: { auth: GrokAuthJson }): void {
  writeFileAtomic(grokPaths.authJson, JSON.stringify(GrokAuthJsonSchema.parse(input.auth), null, 2), 0o600);
}

function parkedPath(input: { credFile: string }): string {
  return join(grokPaths.credsDir, `${input.credFile}.json`);
}

export function readParkedGrokAuth(input: { credFile: string }): GrokAuthJson | null {
  let raw: string;
  try {
    raw = readFileSync(parkedPath(input), "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
  return GrokAuthJsonSchema.parse(JSON.parse(raw));
}

export function writeParkedGrokAuth(input: { credFile: string; auth: GrokAuthJson }): void {
  writeFileAtomic(parkedPath(input), JSON.stringify(GrokAuthJsonSchema.parse(input.auth), null, 2), 0o600);
}

/** `rm --grok` uses this so the path shape (.json suffix) has one owner. */
export function deleteParkedGrokAuth(input: { credFile: string }): void {
  rmSync(parkedPath(input), { force: true });
}

/** The map's single poolable issuer entry: an OIDC/session login carrying
 *  key + refresh_token + user_id. API-key-only or provider-command entries do
 *  not validate against GrokIssuerSchema and are skipped - a map with no
 *  poolable entry returns null (nothing tokenmaxxing can pool, the same
 *  contract as codex's tokens-omitted auth.json). A future multi-issuer blob
 *  pools the first session entry with principal_type User (desk blobs have
 *  exactly one; more than one is a Needs-verification state, issue #1). */
export function poolableGrokIssuer(input: { auth: GrokAuthJson }): { issuerKey: string; issuer: GrokIssuer } | null {
  const candidates: { issuerKey: string; issuer: GrokIssuer }[] = [];
  for (const [issuerKey, value] of Object.entries(input.auth)) {
    const parsed = GrokIssuerSchema.safeParse(value);
    if (parsed.success) candidates.push({ issuerKey, issuer: parsed.data });
  }
  if (candidates.length === 0) return null;
  return candidates.find((entry) => entry.issuer.principal_type === "User") ?? candidates[0]!;
}

const GrokIdentitySchema = z.object({
  accountId: z.string(),
  email: z.string().nullable(),
});
export type GrokIdentity = z.infer<typeof GrokIdentitySchema>;

/**
 * The blob's own identity, from its issuer entry alone (no network): user_id
 * is stable and the token cannot lie; email is a display label only. Parking
 * MUST key on this, never on a stored label. Throws when the map holds no
 * poolable issuer - callers that tolerate that state gate on
 * poolableGrokIssuer first.
 */
export function grokIdentityOf(input: { auth: GrokAuthJson }): GrokIdentity {
  const entry = poolableGrokIssuer(input);
  if (!entry) {
    throw new Error("grok auth.json holds no poolable OIDC session (API-key or provider-command logins cannot be pooled)");
  }
  return GrokIdentitySchema.parse({
    accountId: entry.issuer.user_id,
    email: entry.issuer.email ?? null,
  });
}

/** True when the issuer's access token is within `skewMs` of expires_at (or
 *  expires_at is unreadable). Grok's own proactive refresh margin is 300s
 *  (GROK_AUTH_EARLY_INVALIDATION_SECS default); matching it keeps our "this
 *  parked copy has rotted" reading aligned with the binary's. expires_at is
 *  a string or epoch (seconds or ms - hours-scale TTLs make the scale
 *  unambiguous by magnitude). */
export function isGrokAccessExpiring(input: { issuer: GrokIssuer; skewMs?: number; now?: number }): boolean {
  const { issuer, skewMs = 300_000, now = Date.now() } = input;
  const raw = issuer.expires_at;
  if (raw == null) return true;
  let epochMs: number;
  if (typeof raw === "number") {
    epochMs = raw > 1e12 ? raw : raw * 1000;
  } else {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return true;
    epochMs = parsed;
  }
  return epochMs - now <= skewMs;
}
