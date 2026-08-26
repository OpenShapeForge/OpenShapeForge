// SPDX-License-Identifier: BUSL-1.1
/**
 * One entry point, several roles. `OPENSHAPEFORGE_ROLE` picks which; `api` is
 * the default, so an existing deployment keeps starting the server it always
 * did without setting anything.
 *
 * Any other value is looked up among the worker roles the loaded runtime
 * modules contribute (see `roles/worker.ts`). `apps/api` deliberately names
 * none of them: the workflow plugin contributes `workflow-worker`, and a repo
 * that drops the plugin loses the role with it rather than keeping a dangling
 * import here.
 */
import { bootstrapOpenTelemetry } from "@openshapeforge/observability";

function tracesEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  if (env.OTEL_TRACES_EXPORTER?.trim().toLowerCase() === "none") return undefined;
  const explicit = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (explicit) return explicit;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/traces` : undefined;
}

const otlpTracesEndpoint = tracesEndpoint(process.env);
bootstrapOpenTelemetry({
  serviceName: "openshapeforge-api",
  ...(process.env.OTEL_SERVICE_NAMESPACE?.trim()
    ? { serviceNamespace: process.env.OTEL_SERVICE_NAMESPACE.trim() }
    : {}),
  ...(otlpTracesEndpoint ? { tracesEndpoint: otlpTracesEndpoint } : {}),
});

const role = process.env.OPENSHAPEFORGE_ROLE?.trim() || "api";

if (role === "api") {
  const { startApiRole } = await import("./roles/api.js");
  await startApiRole();
} else {
  const { runWorkerRole } = await import("./roles/worker.js");
  await runWorkerRole(role);
}
