// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeModule } from "./contract.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModulePlatformRuntime } from "./platform.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";

export type ModuleRealtimeResource = {
  readOperationId: string;
  idInputField: string;
  labelFields?: Readonly<Record<"en" | "nl", readonly string[]>>;
};

/** Validate and index the private resources contributed by loaded modules. */
export function moduleRealtimeResources(
  modules: readonly RuntimeModule[],
): ReadonlyMap<string, ModuleRealtimeResource> {
  const resources = new Map<string, ModuleRealtimeResource>();
  for (const module of modules)
    for (const resource of module.realtimeResources ?? []) {
      const labelFields = Object.values(resource.labelFields ?? {}).flat();
      if (
        !resource.entity ||
        !resource.readOperationId ||
        !/^[A-Za-z][A-Za-z0-9]*$/.test(resource.idInputField) ||
        labelFields.some((field) =>
          !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(field)
        ) ||
        resources.has(resource.entity) ||
        getGeneratedCrudTables().some(
          (table) => table.source?.authoringEntityName === resource.entity,
        )
      )
        throw new Error(
          "Realtime resource registration conflicts with an existing resource.",
        );
      resources.set(resource.entity, resource);
    }
  return resources;
}

/** A module hint grants no visibility: the current canonical read does that. */
export function moduleRealtimeAuthorizer(
  modules: readonly RuntimeModule[],
  platform: ModulePlatformRuntime,
) {
  const resources = moduleRealtimeResources(modules);
  return async (
    session: TrustedSessionContext,
    entity: string,
    id: string,
  ): Promise<boolean> => {
    const resource = resources.get(entity);
    if (!resource) return false;
    return platform.withActiveOperationSession(session, async (live) => {
      const operation = await platform.services.operations.get(
        live,
        resource.readOperationId,
      );
      if (
        !operation ||
        operation.effects.data !== "read" ||
        operation.effects.external !== "none"
      )
        return false;
      const result = await platform.services.operations.execute(live, {
        operation,
        input: { [resource.idInputField]: id },
      });
      return (
        !("error" in result) &&
        result.data !== null &&
        result.data !== undefined
      );
    });
  };
}
