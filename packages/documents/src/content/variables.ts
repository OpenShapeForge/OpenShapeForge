// SPDX-License-Identifier: BUSL-1.1
/**
 * The content engine's binding to the one typed-variable contract
 * (`@openshapeforge/operations`, field-variables.ts). Nothing here decides
 * compatibility; it translates between the engine's resolved shapes and that
 * contract, and turns its refusals into template-content failures.
 *
 * The two namespaces a template may name:
 *
 * - `chips.<key>`: the tenant-wide Chip catalogue. A Chip's value is plain
 *   text by its own authored contract (`entities/core/chip.yaml`: a required
 *   `multilineText`), so that is the shape every global offers. A text global
 *   is therefore refused where a typed value is wanted — it is not widened to
 *   a number because the destination would like one.
 * - `local.<key>`: the parameters of the template version being materialized.
 *   Those are canonical FieldDefinitions, so each one offers its own authored
 *   type, cardinality, domain and reference target.
 */

import {
  parseVariableReference,
  variableOffer,
  VariableError,
  type VariableCatalogue,
  type VariableOffer,
  type VariableReference,
  type VariableSlot,
  type VariableValueShape,
} from "@openshapeforge/operations";
import { contentError } from "./errors.js";
import { contentCardinality } from "./validation.js";
import type { ContentValueShape, TemplateParameter } from "./types.js";

/**
 * What a tenant-wide global offers. Fixed by the Chip contract rather than by
 * the adapter that reads chips, so no resolver can claim a richer type for a
 * value that is stored and validated as text.
 */
export const GLOBAL_VARIABLE_SHAPE: VariableValueShape = Object.freeze({
  osfType: "multilineText",
  baseType: "string",
  cardinality: "single",
  nullable: false,
} as const);

/**
 * A value shape that may name a referenced entity: a block field, a template
 * parameter, or a declared child of either.
 */
export type ContentReferencingShape = ContentValueShape & {
  readonly relationship?: { readonly target: string };
};

/** A resolved content shape in the terms the shared contract compares. */
export function contentVariableShape(shape: ContentReferencingShape): VariableValueShape {
  return {
    // The type axis of a reference is the entity it names, which a structural
    // projection carries as its relationship target rather than as a type key.
    osfType: shape.osfType ?? shape.relationship?.target ?? shape.baseType,
    baseType: shape.baseType,
    cardinality: contentCardinality(shape).collection ? "collection" : "single",
    nullable: shape.nullable === true,
    ...(shape.enum ? { enum: shape.enum as readonly (string | number | boolean)[] } : {}),
    ...(shape.relationship?.target ? { target: shape.relationship.target } : {}),
  };
}

/**
 * The destination contract of one block value. A field the compiled
 * definition does not declare accepts no variable at all: its `{{…}}` text is
 * literal, and the unknown key itself is refused when the values are
 * validated.
 */
export function contentVariableSlot(path: string, shape: ContentReferencingShape | undefined): VariableSlot {
  if (!shape) return { path, mode: "none", osfType: "string", baseType: "string", cardinality: "single" };
  return { ...contentVariableShape(shape), path, mode: shape.variables ?? "none" };
}

/** One item of a collection-valued shape: the same value type, one at a time. */
export function contentItemShape(shape: ContentValueShape): ContentValueShape {
  return { ...shape, cardinality: "single", required: false };
}

/**
 * The variables one materialization may name: this version's typed parameters
 * as the local namespace, and the Chip catalogue as the global one. The
 * catalogue is built per template version, so a nested template never sees
 * the parameters of the template that included it.
 */
export function contentVariableCatalogue(
  parameters: Readonly<Record<string, TemplateParameter>>,
): VariableCatalogue {
  const offers: Record<string, VariableValueShape> = Object.create(null);
  for (const [key, parameter] of Object.entries(parameters)) offers[key] = contentVariableShape(parameter);
  return Object.freeze({
    chips: { kind: "uniform", offer: GLOBAL_VARIABLE_SHAPE },
    local: { kind: "map", offers },
  });
}

export function contentVariableReference(expression: string): VariableReference {
  try {
    return parseVariableReference(expression);
  } catch (error) {
    contentVariableFailure(error);
  }
}

export function contentVariableOffer(catalogue: VariableCatalogue, reference: VariableReference): VariableOffer {
  try {
    return variableOffer(catalogue, reference);
  } catch (error) {
    contentVariableFailure(error);
  }
}

/**
 * A variable refusal as the engine's own failure. The shared codes map onto
 * the content vocabulary: what the caller must supply is a missing variable,
 * what a source got wrong or which record a binding would reach is a
 * dependency failure, and everything else is an invalid value. The message is
 * carried through unchanged — it names types, keys and namespaces, never a
 * resolved value.
 */
export function contentVariableFailure(error: unknown): never {
  if (!(error instanceof VariableError)) throw error;
  switch (error.code) {
    case "UNKNOWN_VARIABLE":
    case "MISSING_VALUE":
      return contentError("MISSING_VARIABLE", error.message);
    case "INCOMPATIBLE_REFERENCE":
    case "SOURCE_CONTRACT_VIOLATED":
      return contentError("DEPENDENCY_INVALID", error.message);
    default:
      return contentError("INVALID_VALUE", error.message);
  }
}
