// SPDX-License-Identifier: BUSL-1.1
/**
 * Per-subject rate-limit keys (#886).
 *
 * The limiter keyed every request without a signed trusted context on the
 * client IP. Behind a proxy on one host — the web app forwarding for every
 * signed-in person, the workflow worker reading its catalog — that is ONE
 * address, so all people and the worker shared a single 600/min budget, and
 * the long-lived /api/events stream was refused 429 every run.
 *
 * The limiter still runs before authentication. What it may now prove locally
 * is a bearer token's signature and issuer (cached JWKS, no database): a
 * verified token is counted against its own subject, and an organization's
 * service identity against its own, separately sized budget. Anything that
 * does not verify — no token, a forged or expired one, an unreachable JWKS —
 * stays on the anonymous per-IP budget, so the protection in front of the
 * authentication path is unchanged. The event stream keeps its own bucket per
 * key: it rotates once a minute and is further bounded per person by
 * rest/entity-change-stream.ts, so it neither starves nor is starved by the
 * same person's ordinary requests.
 */
import type { FastifyRequest } from "fastify";
import { organizationServiceIdentities } from "../auth/organization-service-identities.js";
import { classifyRequest, type RateLimitTier } from "./rate-limit.js";

type Claims = Record<string, unknown>;
export type LimitSubjectVerifier = (token: string) => Promise<{ claims: Claims }>;

/**
 * What a verified token must also satisfy to earn its own bucket.
 *
 * The verifier checks signature and issuer only, so any client of the realm
 * could otherwise mint per-account budgets. A token counts per subject only
 * when its `aud` names this API (the configured bearer audience) or one of
 * the deployment's organization resources (URLs under the public origin or
 * the MCP resource origins). The service tier is reserved for the configured
 * organization service identities.
 */
export type LimitPolicy = {
  verifier: () => LimitSubjectVerifier | null;
  acceptsAudience: (aud: unknown) => boolean;
  serviceClients: ReadonlySet<string>;
};

const list = (value: string | undefined) => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);

export function limitPolicyFromEnv(verifier: () => LimitSubjectVerifier | null, env: NodeJS.ProcessEnv = process.env): LimitPolicy {
  const apiAudience = env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE?.trim();
  const origins = [env.OPENSHAPEFORGE_PUBLIC_ORIGIN, ...list(env.OPENSHAPEFORGE_MCP_RESOURCE_ORIGINS)]
    .map(origin => origin?.trim().replace(/\/+$/, "")).filter((origin): origin is string => Boolean(origin));
  let serviceClients = new Set<string>();
  try { serviceClients = new Set(organizationServiceIdentities(env).map(identity => identity.clientId)); } catch { /* none */ }
  return {
    verifier,
    serviceClients,
    acceptsAudience: (aud) => {
      // Unpinned deployments (local dev) accept any audience, as the verifier does.
      if (!apiAudience && origins.length === 0) return true;
      const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((item): item is string => typeof item === "string") : [];
      return audiences.some(item => item === apiAudience || origins.some(origin => item.startsWith(`${origin}/`)));
    },
  };
}

const TIER_OF_PREFIX: Record<string, RateLimitTier> = { ip: "anonymous", svc: "trusted", sub: "subject", sa: "service" };
const EVENTS_PREFIX = "events:";
/** Longest a key may wait for bearer verification before it falls back to the IP. */
export const VERIFY_BUDGET_MS = 250;

/** The long-lived entity stream: `/api/events`, or under one organization alias. */
export function isEventStream(url: string): boolean {
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return /^\/(?:[a-z0-9][a-z0-9-]*\/)?api\/events$/.test(path);
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)$/i.exec(value?.trim() ?? "");
  return match?.[1];
}

/** Who a verified token speaks for; undefined when it names no subject. */
function subjectKey(claims: Claims, policy: LimitPolicy): { tier: RateLimitTier; key: string } | undefined {
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const party = typeof claims.azp === "string" ? claims.azp : "";
  if (!issuer || !subject || !policy.acceptsAudience(claims.aud)) return undefined;
  // A configured organization service identity (the durable workflow worker)
  // presenting its client-credentials token — same shape test as durable-worker.ts.
  if (party && policy.serviceClients.has(party) && claims.preferred_username === `service-account-${party}`) {
    return { tier: "service", key: `sa:${issuer}:${party}` };
  }
  return { tier: "subject", key: `sub:${issuer}:${subject}` };
}

/**
 * The key a request is counted against. Trusted context first (unchanged),
 * then a locally verified bearer token, else the client IP.
 */
export async function limitKey(
  request: FastifyRequest,
  secret: string | undefined,
  policy: LimitPolicy,
): Promise<string> {
  let classified: { tier: RateLimitTier; key: string } = classifyRequest(request, secret);
  const token = classified.tier === "anonymous" ? bearerToken(request.headers.authorization) : undefined;
  const verify = token ? policy.verifier() : null;
  if (token && verify) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded: a JWKS that is cold or slow must not add its latency in
      // front of every request. Too slow counts as not verified.
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("slow")), VERIFY_BUDGET_MS); });
      classified = subjectKey((await Promise.race([verify(token), deadline])).claims, policy) ?? classified;
    } catch {
      // Not verifiable: counted per IP, exactly as before.
    } finally {
      clearTimeout(timer);
    }
  }
  return isEventStream(request.url) ? `${EVENTS_PREFIX}${classified.key}` : classified.key;
}

/** The tier a key was issued under, so the budget follows the proof and not a second verification. */
export function tierOfKey(key: string): RateLimitTier {
  const bare = key.startsWith(EVENTS_PREFIX) ? key.slice(EVENTS_PREFIX.length) : key;
  return TIER_OF_PREFIX[bare.slice(0, bare.indexOf(":"))] ?? "anonymous";
}
