// Per-account grok usage sampling for status/ls. Every account samples via
// the free credits GET (nothing metered, no window started): the live account
// through the live auth.json, parked accounts through their parked blobs.
// There is NO self-refresh (grokauth.ts header): a parked access token past
// its hours-scale TTL is an EXPECTED rot state, reported as an honest miss -
// never probed (the 401 would be noise) and never marked needs-reauth (the
// real grok heals it on the next swap-in). Only a rejection of a token that
// should still be valid marks a dead grant.
//
// Caller holds the grok flock: index writes must not interleave with a swap.

import { grokIdentityOf, isGrokAccessExpiring, poolableGrokIssuer, readLiveGrokAuth, readParkedGrokAuth } from "./grokauth.ts";
import { GrokAuthRejectedError, GrokUsageReadError, fetchGrokUsage } from "./grokusage.ts";
import { presentGrokAccountIds } from "./grokpresence.ts";
import type { GrokAccount, GrokUsage } from "./types.ts";
import { z } from "zod";

const GrokSampleOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), usage: z.custom<GrokUsage>() }),
  z.object({ ok: z.literal(false), reason: z.string(), deadGrant: z.boolean() }),
]);
export type GrokSampleOutcome = z.infer<typeof GrokSampleOutcomeSchema>;

/** The live credential's own account id, or null when absent/unpoolable. */
export function liveGrokAccountId(): string | null {
  const live = readLiveGrokAuth();
  if (!live) return null;
  const entry = poolableGrokIssuer({ auth: live });
  if (!entry) return null;
  return grokIdentityOf({ auth: live }).accountId;
}

export async function sampleGrokAccount(input: { account: GrokAccount; liveAccountId: string | null; now?: number }): Promise<GrokSampleOutcome> {
  const { account, liveAccountId, now = Date.now() } = input;
  const isLive = liveAccountId != null && account.accountId === liveAccountId;
  try {
    const auth = isLive ? readLiveGrokAuth() : readParkedGrokAuth({ credFile: account.credFile });
    const entry = auth ? poolableGrokIssuer({ auth }) : null;
    if (!entry) return { ok: false, reason: isLive ? "live auth.json vanished" : "no parked credential", deadGrant: false };
    if (!isLive) {
      // A parked blob whose account RUNS in a supervised session is
      // superseded by that session's live rotations: its key may already be
      // rotated out, so a 401 there proves nothing about the grant.
      if (presentGrokAccountIds().has(account.accountId)) {
        return { ok: false, reason: "running in a live grok session (parked snapshot superseded)", deadGrant: false };
      }
      if (isGrokAccessExpiring({ issuer: entry.issuer, now })) {
        return { ok: false, reason: "parked access token expired (grok refreshes it on the next swap-in)", deadGrant: false };
      }
    }
    const usage = await fetchGrokUsage({ issuer: entry.issuer });
    return { ok: true, usage };
  } catch (e) {
    // Only the EXPECTED operational failures become a sample miss; parse and
    // filesystem errors keep propagating (they are drift or bugs to surface).
    if (e instanceof GrokAuthRejectedError) {
      // A LIVE token can sit expired between sessions (nothing refreshes it
      // until the next spawn): a rejection there is transient, not a dead
      // grant. A PARKED token inside its TTL being refused IS one.
      return { ok: false, reason: e.message, deadGrant: !isLive };
    }
    if (e instanceof GrokUsageReadError) {
      return { ok: false, reason: e.message, deadGrant: false };
    }
    throw e;
  }
}
