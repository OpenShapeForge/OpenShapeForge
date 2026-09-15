// SPDX-License-Identifier: BUSL-1.1
import type { SemanticTypeDefinition } from "./authoring/types.js";
import type {
  FieldAuthoringProfile,
} from "./authoring/loader.js";
import type {
  CoreReferentiedataCatalog,
  CoreReferentiedataCatalogGroup,
} from "./core-referentiedata-artifacts.js";

export const FIELD_AUTHORING_REGISTRY_PATH =
  "apps/api/src/generated/compiler/field-authoring-registry.json";

/**
 * Build-time renderer/editor registries from canonical authoring catalogs.
 *
 * Values deliberately stay unnormalized. A host may inject this JSON into a
 * shared editor, but must not maintain a second YAML reader or derive another
 * field model from it.
 */
export type FieldAuthoringRegistry = {
  version: 1;
  fieldAuthoringProfiles: Record<string, FieldAuthoringProfile>;
  semanticTypes: Record<string, SemanticTypeDefinition>;
  referentiedata: Record<string, CoreReferentiedataCatalogGroup>;
};

export function buildFieldAuthoringRegistry(input: {
  fieldAuthoringProfiles: Record<string, FieldAuthoringProfile>;
  semanticTypes: Record<string, SemanticTypeDefinition>;
  referentiedataCatalog: CoreReferentiedataCatalog;
}): FieldAuthoringRegistry {
  return {
    version: 1,
    fieldAuthoringProfiles: input.fieldAuthoringProfiles,
    semanticTypes: input.semanticTypes,
    referentiedata: input.referentiedataCatalog.groepen ?? {},
  };
}

export function renderFieldAuthoringRegistry(
  registry: FieldAuthoringRegistry,
): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
