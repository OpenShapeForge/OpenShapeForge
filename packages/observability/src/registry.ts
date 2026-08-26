// SPDX-License-Identifier: BUSL-1.1
import { Registry } from "prom-client";
export { Registry } from "prom-client";

const REGISTRY_KEY = Symbol.for("openshapeforge.observability.prometheus-registry");

type RegistryGlobal = typeof globalThis & {
  [REGISTRY_KEY]?: Registry;
};

/**
 * Resolve the one Prometheus registry owned by this process.
 *
 * A global symbol survives watch-mode module reloads without using prom-client's
 * implicit default register. Tests that need isolation may inject a Registry
 * into the adapters instead of clearing this process register underneath a
 * running server.
 */
export function getProcessPrometheusRegistry(): Registry {
  const target = globalThis as RegistryGlobal;
  return (target[REGISTRY_KEY] ??= new Registry());
}
