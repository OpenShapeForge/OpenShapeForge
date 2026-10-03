// SPDX-License-Identifier: BUSL-1.1
/**
 * The job-kind registry the worker dispatches on, composed from every active
 * module's `jobHandlers` — the core `osf-jobs` module included, which is where
 * `mail.deliver` comes from.
 *
 * Composition fails closed on a kind two modules both register, exactly as a
 * GraphQL root field or a worker role claimed twice does: picking either
 * handler would run one plugin's job through another plugin's code, and the
 * worker would report success while doing so. Refusing at boot is the only
 * honest outcome.
 */
import type { ModuleJobHandler, RuntimeModule } from "../modules/contract.js";
import { JOB_KIND } from "./store.js";

export type RegisteredJobHandler = { module: string; handler: ModuleJobHandler };

export type JobHandlerRegistry = ReadonlyMap<string, RegisteredJobHandler>;

export function composeJobHandlers(
  modules: readonly Pick<RuntimeModule, "name" | "jobHandlers">[],
): JobHandlerRegistry {
  const registry = new Map<string, RegisteredJobHandler>();
  for (const module of modules) {
    for (const [kind, handler] of Object.entries(module.jobHandlers ?? {})) {
      if (!JOB_KIND.test(kind)) {
        throw new Error(
          `Runtime module "${module.name}" registers job kind "${kind}"; kinds are namespaced lowercase, like "mail.deliver".`,
        );
      }
      if (typeof handler !== "function") {
        throw new Error(`Runtime module "${module.name}" registers job kind "${kind}" without a handler function.`);
      }
      const existing = registry.get(kind);
      if (existing) {
        throw new Error(
          `Job kind "${kind}" is registered by both "${existing.module}" and "${module.name}". Kinds must be unique across modules.`,
        );
      }
      registry.set(kind, { module: module.name, handler });
    }
  }
  return registry;
}
