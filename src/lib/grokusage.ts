// The free grok usage read (issue #1, live-verified 2026-08-25): the same
// credits GET the grok CLI's billing extension makes (GetGrokCreditsConfig,
// upstream xai-org/grok-build billing.rs). One authed GET returns the weekly
// SuperGrok bar. No inference runs, no session window starts (grok has none),
// and nothing is metered.
//
// `?format=credits` is MANDATORY: the bare /billing returns legacy monthly
// zeros (monthlyLimit/used = 0), the wrong source of truth for the weekly
// bar - a mapper fed that body must fail, never render an empty week.
// Auth is `Authorization: Bearer <issuer.key>` (live-ablated: sufficient
// alone) plus `X-XAI-Token-Auth: xai-grok-cli`, the header the CLI itself
// sends (a codex-cli value 401s - never send another client's).

import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { GrokUsageSchema, type GrokIssuer, type GrokUsage } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);

/** The full billing URL with format=credits pinned: the override (tests) and
 *  the GROK_CLI_CHAT_PROXY_BASE_URL-shaped default both pass through here, so
 *  no caller can lose the query. */
function billingUrl(): string {
  const base =
    EnvOverrideSchema.parse(process.env.TOKENMAXXING_GROK_BILLING_URL) ??
    `${EnvOverrideSchema.parse(process.env.GROK_CLI_CHAT_PROXY_BASE_URL) ?? "https://cli-chat-proxy.grok.com/v1"}/billing`;
  const url = new URL(base);
  url.searchParams.set("format", "credits");
  return url.toString();
}

/** The usage read could not complete (endpoint unreachable, HTTP failure,
 *  drifted body): an operational miss to fall back on cached figures for,
 *  NOT a bug to swallow. */
export class GrokUsageReadError extends Error {
  constructor(detail: string) {
    super(`grok usage read failed: ${detail}`);
    this.name = "GrokUsageReadError";
  }
}

/** The token was refused outright (401/403): the parked access token has
 *  rotted past its hours-scale TTL, or the session was revoked. The caller
 *  decides whether that means needs-reauth (parked, nothing will refresh it)
 *  or a transient miss (live, the next grok spawn refreshes it). */
export class GrokAuthRejectedError extends Error {
  constructor(detail: string) {
    super(`grok rejected the credential: ${detail}`);
    this.name = "GrokAuthRejectedError";
  }
}

const WireCreditsSchema = z.looseObject({
  config: z
    .looseObject({
      creditUsagePercent: z.number().nullish(),
      currentPeriod: z.looseObject({ type: z.string().nullish(), end: z.string().nullish() }).nullish(),
    })
    .nullish(),
  productUsage: z.array(z.looseObject({ product: z.string().nullish(), usagePercent: z.number().nullish() })).nullish(),
});

/** Map a credits body to the weekly window. Exported for the fixture tests:
 *  the legacy monthly body (someone lost `format=credits`) has no
 *  creditUsagePercent and no GrokBuild row, and MUST throw here rather than
 *  become a 0%-used weekly bar (unmeasured must never look safe). */
export function mapGrokCredits(input: { body: unknown }): GrokUsage {
  const parsed = WireCreditsSchema.safeParse(input.body);
  if (!parsed.success) throw new GrokUsageReadError("endpoint returned an unexpected body shape (withheld)");
  const wire = parsed.data;
  // Primary: config.creditUsagePercent. Fallback: the GrokBuild product row
  // (live they matched at 86; divergence is a Needs-verification state,
  // issue #1). Both missing = the legacy monthly body or drift: throw.
  const used =
    wire.config?.creditUsagePercent ??
    wire.productUsage?.find((row) => row.product === "GrokBuild")?.usagePercent ??
    null;
  if (used == null) {
    throw new GrokUsageReadError("body carries no creditUsagePercent and no GrokBuild row (legacy monthly response? format=credits is mandatory)");
  }
  const end = wire.config?.currentPeriod?.end;
  const resetsAt = end != null && !Number.isNaN(Date.parse(end)) ? Date.parse(end) : null;
  return GrokUsageSchema.parse({ weekly: { usedPercentage: used, resetsAt } });
}

/**
 * One free billing read for the credential in `issuer`. Throws
 * GrokAuthRejectedError on 401/403 and GrokUsageReadError on everything else
 * operational; error text carries only a response-body snippet, never request
 * headers (a ky error would carry the Authorization header - this client
 * never lets one escape).
 */
export async function fetchGrokUsage(input: { issuer: GrokIssuer }): Promise<GrokUsage> {
  let res: Response;
  try {
    res = await http.get(billingUrl(), {
      headers: {
        Authorization: `Bearer ${input.issuer.key}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new GrokUsageReadError(`endpoint unreachable: ${message}`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new GrokAuthRejectedError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  }
  if (!res.ok) {
    throw new GrokUsageReadError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  }
  return mapGrokCredits({
    body: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  });
}
