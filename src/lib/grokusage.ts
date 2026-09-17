import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { env } from "./paths.ts";
import { JsonTextSchema, type GrokIssuer, type Window } from "./types.ts";

const WEEK_S = 7 * 24 * 3600;

function billingUrl(): string {
  const base = env("TOKENMAXXING_GROK_BILLING_URL", `${env("GROK_CLI_CHAT_PROXY_BASE_URL", "https://cli-chat-proxy.grok.com/v1")}/billing`);
  const url = new URL(base);
  url.searchParams.set("format", "credits");
  return url.toString();
}

export class GrokUsageReadError extends Error {
  constructor(detail: string) {
    super(`grok usage read failed: ${detail}`);
    this.name = "GrokUsageReadError";
  }
}

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

export function mapGrokCredits(input: { body: unknown; at: number }): Window[] {
  const parsed = WireCreditsSchema.safeParse(input.body);
  if (!parsed.success) throw new GrokUsageReadError("endpoint returned an unexpected body shape (withheld)");
  const wire = parsed.data;
  const period = wire.config?.currentPeriod;
  const fromConfig = wire.config?.creditUsagePercent;
  const used = fromConfig ?? wire.productUsage?.find((row) => row.product === "GrokBuild")?.usagePercent ?? (period != null ? 0 : null);
  if (used == null) {
    throw new GrokUsageReadError("body carries no creditUsagePercent and no GrokBuild row (legacy monthly response? format=credits is mandatory)");
  }
  const end = period?.end;
  const resetsAt = end != null && !Number.isNaN(Date.parse(end)) ? Date.parse(end) : null;
  return [{ name: null, usedPercentage: used, resetsAt, windowSeconds: WEEK_S, sampledAt: input.at }];
}

export async function fetchGrokUsage(input: { issuer: GrokIssuer; at: number }): Promise<Window[]> {
  let res: Response;
  try {
    res = await http.get(billingUrl(), {
      headers: { Authorization: `Bearer ${input.issuer.key}`, "X-XAI-Token-Auth": "xai-grok-cli" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new GrokUsageReadError(`endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new GrokAuthRejectedError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  if (!res.ok) throw new GrokUsageReadError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  return mapGrokCredits({ body: JsonTextSchema.safeParse(text).data ?? null, at: input.at });
}

export function isGrokAccessExpiring(input: { issuer: GrokIssuer; skewMs?: number; now?: number }): boolean {
  const { issuer, skewMs = 300_000, now = Date.now() } = input;
  const raw = issuer.expires_at;
  if (raw == null) return true;
  let epochMs: number;
  if (typeof raw === "number") epochMs = raw > 1e12 ? raw : raw * 1000;
  else {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return true;
    epochMs = parsed;
  }
  return epochMs - now <= skewMs;
}
