// SPDX-License-Identifier: BUSL-1.1
export type WebRestParameter = { name: string; in: "path" | "query"; required?: boolean };
export type WebRestOperation = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  parameters: WebRestParameter[];
};

type OpenApiOperation = { "x-osf-operation-id"?: string; parameters?: WebRestParameter[] };
type OpenApiPath = Partial<Record<"get" | "post" | "patch" | "delete", OpenApiOperation>> & {
  parameters?: WebRestParameter[];
};
export type WebOperationOpenApi = { paths: Record<string, OpenApiPath> };

/** Compile the transport bindings from the canonical OpenAPI projection. */
export function buildWebRestOperationMap(document: WebOperationOpenApi, operationIds?: readonly string[]): Record<string, WebRestOperation> {
  const selected = operationIds ? new Set(operationIds) : undefined;
  const operations: Record<string, WebRestOperation> = {};
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "patch", "delete"] as const) {
      const operation = item[method];
      const id = operation?.["x-osf-operation-id"];
      if (!id || (selected && !selected.has(id))) continue;
      // Operation-level parameters override path-level parameters by name/location.
      const parameters = new Map<string, WebRestParameter>();
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        if (parameter.in !== "path" && parameter.in !== "query") continue;
        parameters.set(`${parameter.in}:${parameter.name}`, {
          name: parameter.name,
          in: parameter.in,
          ...(parameter.required === undefined ? {} : { required: parameter.required }),
        });
      }
      operations[id] = { method: method.toUpperCase() as WebRestOperation["method"], path, parameters: [...parameters.values()] };
    }
  }
  return operations;
}
