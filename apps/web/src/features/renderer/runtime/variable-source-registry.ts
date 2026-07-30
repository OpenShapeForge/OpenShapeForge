// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — Static registry of variable suggestion resolvers.
 *
 * All resolvers are imported statically so the bundle stays predictable and
 * there are no tree-shaking surprises. New resolvers are added here and to the
 * `VariableSourceResolverId` union in `variable-sources.ts`.
 *
 * Design doc section 3.
 */
import { entityFieldsResolver } from "@/features/renderer/runtime/resolvers/entity-fields-resolver";
import { chipsResolver } from "@/features/renderer/runtime/resolvers/chips-resolver";
import { templateParametersResolver } from "@/features/renderer/runtime/resolvers/template-parameters-resolver";
import { workflowGraphVariablesResolver } from "@/features/renderer/runtime/resolvers/workflow-graph-variables-resolver";
import type {
  VariableSourceResolverId,
  VariableSuggestionResolver,
} from "@/features/renderer/runtime/variable-sources";

export const VARIABLE_SOURCE_REGISTRY: Record<
  VariableSourceResolverId,
  VariableSuggestionResolver
> = {
  chips: chipsResolver,
  entityFields: entityFieldsResolver,
  templateParameters: templateParametersResolver,
  workflowGraphVariables: workflowGraphVariablesResolver,
};
