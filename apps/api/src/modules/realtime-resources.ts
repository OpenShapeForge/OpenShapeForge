// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeModule } from "./contract.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { ModulePlatformRuntime } from "./platform.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";

/** A module hint grants no visibility: the current canonical read does that. */
export function moduleRealtimeAuthorizer(
  modules: readonly RuntimeModule[],
  platform: ModulePlatformRuntime,
) {
  const resources = new Map<
    string,
    { readOperationId: string; idInputField: string }
  >();
  for (const module of modules)
    for (const resource of module.realtimeResources ?? []) {
      if (
        !resource.entity ||
        !resource.readOperationId ||
        !/^[A-Za-z][A-Za-z0-9]*$/.test(resource.idInputField) ||
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
