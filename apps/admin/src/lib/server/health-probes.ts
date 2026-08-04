// SPDX-License-Identifier: BUSL-1.1
import "server-only";

export type CheckResult = { ok: boolean; latencyMs: number | null; error?: string };

/**
 * Pre-flight probe of the CONTROL realm's OIDC discovery document.
 *
 * Ported from `apps/web/src/lib/server/health-probes.ts`, minus the GraphQL
 * probe and the roll-up — there is no control-plane API to probe yet (#289) and
 * inventing a "degraded" status over a surface that does not exist would be a
 * lie the login page repeats to the operator.
 *
 * The reason for probing at all is the same as in apps/web: without it, a
 * sign-in click against a Keycloak that is down bounces the browser straight
 * into ERR_CONNECTION_REFUSED with nothing to explain it.
 */
function getKeycloakIssuer(): string {
  const fromEnv =
    process.env.AUTH_KEYCLOAK_ISSUER_INTERNAL ??
    process.env.AUTH_KEYCLOAK_ISSUER ??
    // Matches docker-compose.local.yml, which publishes Keycloak on 8181.
    "http://localhost:8181/realms/openshapeforge-control";
  return fromEnv.endsWith("/") ? fromEnv.slice(0, -1) : fromEnv;
}

export async function probeKeycloak(): Promise<CheckResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2_000);
  const start = performance.now();
  try {
    const res = await fetch(`${getKeycloakIssuer()}/.well-known/openid-configuration`, {
      method: "GET",
      signal: ctl.signal,
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - start);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: null, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}
