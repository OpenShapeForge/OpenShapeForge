// SPDX-License-Identifier: BUSL-1.1
import "server-only";
import { buildGatewayUrl, getGatewayGraphqlPath } from "@/lib/server/gateway";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { executeGraphqlTransport } from "@/lib/server/persisted-operation";

export type CheckName = "keycloak" | "graphql";
export type CheckResult = {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
};
export type HealthBody = {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<CheckName, CheckResult>;
};

function getKeycloakIssuer(): string {
  const fromEnv =
    process.env.AUTH_KEYCLOAK_ISSUER_INTERNAL ??
    process.env.AUTH_KEYCLOAK_ISSUER ??
    // Default matches docker-compose.local.yml, which publishes Keycloak on 8181.
    // Override with AUTH_KEYCLOAK_ISSUER if your Keycloak listens elsewhere.
    "http://localhost:8181/realms/openshapeforge";
  return fromEnv.endsWith("/") ? fromEnv.slice(0, -1) : fromEnv;
}

async function probe(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  isOk: (status: number) => boolean = (s) => s >= 200 && s < 300,
): Promise<CheckResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - start);
    if (!isOk(res.status)) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: null, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeKeycloak(): Promise<CheckResult> {
  return probe(
    `${getKeycloakIssuer()}/.well-known/openid-configuration`,
    { method: "GET" },
    2_000,
  );
}

function getGraphqlProbeTimeoutMs(): number {
  return process.env.NODE_ENV === "development" ? 15_000 : 3_000;
}

export async function probeGraphql(): Promise<CheckResult> {
  // Probe health through the public GraphQL endpoint so local APISIX only needs
  // to route /api/graphql for both app data and backend state checks.
  //
  // The API's health field is intentionally unauthenticated; protected product
  // fields still require the signed trusted-context headers used elsewhere.
  //
  // Failure modes we want to flag:
  //   - fetch throws → apisix unreachable / DNS / TLS
  //   - 404          → apisix up but the GraphQL route didn't load
  //   - 502/503/504  → apisix routed but the gateway pod is down
  //   - any non-2xx  → gateway up but reporting unhealthy
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), getGraphqlProbeTimeoutMs());
  const start = performance.now();
  try {
    const rawEndpoint = buildGatewayUrl(getGatewayGraphqlPath());
    const endpoint = new URL(rawEndpoint);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/persisted`;
    const query = "query HealthProbe { health { status role } }";
    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(
      headers,
      {
        tenantId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        roles: [],
        groups: [],
      },
      { secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET },
    );
    const attempt = await executeGraphqlTransport({
      profile: "persisted",
      persistedEndpoint: endpoint.toString(),
      rawEndpoint: rawEndpoint.toString(),
      headers,
      query,
      operationName: "HealthProbe",
      requestCache: "no-store",
      fetcher: (url, init) => fetch(url, { ...init, signal: ctl.signal }),
    });
    const res = attempt.response;
    const latencyMs = Math.round(performance.now() - start);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    const payload = attempt.payload as {
      data?: { health?: { status?: unknown; role?: unknown } };
    } | null;
    if (payload?.data?.health?.status !== "ok") {
      return {
        ok: false,
        latencyMs,
        error: "GraphQL health check did not return ok",
      };
    }

    return { ok: true, latencyMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: null, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export function rollUp(
  checks: Record<CheckName, CheckResult>,
): HealthBody["status"] {
  if (!checks.keycloak.ok && !checks.graphql.ok) return "unhealthy";
  if (!checks.keycloak.ok || !checks.graphql.ok) return "degraded";
  return "healthy";
}

const CACHE_TTL_MS = 5_000;
let cached: { at: number; body: HealthBody } | null = null;

export async function getHealth(): Promise<HealthBody> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.body;
  }
  const [keycloak, graphql] = await Promise.all([
    probeKeycloak(),
    probeGraphql(),
  ]);
  const checks: Record<CheckName, CheckResult> = { keycloak, graphql };
  const body: HealthBody = { status: rollUp(checks), checks };
  cached = { at: Date.now(), body };
  return body;
}
