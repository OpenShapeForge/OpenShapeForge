// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from "fastify";
import type { Registry } from "prom-client";
import {
  publicReadinessBody,
  runReadinessChecks,
  type ReadinessCheck,
} from "./readiness.js";
import { getProcessPrometheusRegistry } from "./registry.js";
import { sanitizeError } from "./redaction.js";

export type OperationalRoutesOptions = {
  readinessChecks: readonly ReadinessCheck[];
  readinessTimeoutMs?: number;
  registry?: Registry;
  metricsPath?: string;
  readinessPath?: string;
  /** Short cache collapses probe bursts; set to zero only in controlled tests. */
  readinessCacheMs?: number;
};

/** Register pull metrics and dependency-aware readiness on the host server. */
export function registerOperationalRoutes(
  app: FastifyInstance,
  options: OperationalRoutesOptions,
): void {
  const registry = options.registry ?? getProcessPrometheusRegistry();
  const cacheMs = options.readinessCacheMs ?? 1_000;
  let cached: { expiresAt: number; result: Awaited<ReturnType<typeof runReadinessChecks>> } | null = null;
  let inFlight: ReturnType<typeof runReadinessChecks> | null = null;

  const probe = async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.result;
    if (inFlight) return inFlight;
    inFlight = runReadinessChecks(options.readinessChecks, options.readinessTimeoutMs);
    try {
      const result = await inFlight;
      for (const check of result.checks) {
        if (check.status === "not_ready") {
          app.log.error(
            sanitizeError(check.error, `readiness.${check.name}`),
            `Readiness check "${check.name}" failed.`,
          );
        }
      }
      cached = { expiresAt: Date.now() + cacheMs, result };
      return result;
    } finally {
      inFlight = null;
    }
  };

  app.get(options.metricsPath ?? "/api/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  app.get(options.readinessPath ?? "/api/ready", async (_request, reply) => {
    const result = await probe();
    if (!result.ready) reply.code(503);
    return publicReadinessBody(result);
  });
}
