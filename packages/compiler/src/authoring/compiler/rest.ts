// SPDX-License-Identifier: BUSL-1.1
/**
 * REST exposure compiler — normalizes the authored opt-in `rest:` block into
 * a RestSection (base path + per-operation flags).
 *
 * Pipeline position: called by the main compiler alongside buildGraphQL. The
 * section is carried on the compiled contract and bridged into
 * TableDefinition.source.rest by the backend manifest, which is where the
 * fail-closed interaction with generatedCrud is enforced.
 *
 * Input:  Core entity definition (authored `rest` block).
 * Output: RestSection | undefined — undefined means "no REST exposure".
 */
import type { RestConfig, RestOperationKey, RestSection } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import { deriveTableName } from "./helpers.js";

export const REST_OPERATION_KEYS: readonly RestOperationKey[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

// Same fail-closed pattern the loader enforces; re-checked here so the
// invariant holds even for callers that bypass the YAML loader (tests,
// programmatic authoring).
const REST_BASE_PATH_PATTERN = /^[a-z][a-z0-9-]*$/;

export function buildRest(
  coreEntity: LoadedArtifacts["coreEntity"],
): RestSection | undefined {
  const authored = coreEntity.rest;
  if (authored === undefined || authored === false) return undefined;

  const config: RestConfig = authored === true ? {} : authored;
  if (config.enabled === false) return undefined;

  const basePath =
    config.basePath ?? deriveTableName(coreEntity.entity).replace(/_/g, "-");
  if (!REST_BASE_PATH_PATTERN.test(basePath)) {
    throw new Error(
      `Unsafe rest basePath ${JSON.stringify(basePath)} on entity "${coreEntity.entity}" ` +
        `— must match ${REST_BASE_PATH_PATTERN}. The base path is emitted verbatim ` +
        `into route strings and OpenAPI paths.`,
    );
  }

  const operations = Object.fromEntries(
    REST_OPERATION_KEYS.map((key) => [key, config.operations?.[key] !== false]),
  ) as Record<RestOperationKey, boolean>;

  return { basePath, operations };
}
