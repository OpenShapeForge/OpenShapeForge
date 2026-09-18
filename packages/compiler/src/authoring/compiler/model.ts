// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Model field compiler — resolves YAML field definitions into CompiledField objects.
 *
 * Pipeline position: one of the first sub-compilers called by the main orchestrator.
 * For each field, resolves semantic type defaults (labels, validation, render components),
 * applies explicit overrides, and recursively compiles nested children and array items.
 *
 * Render component resolution follows a three-level priority:
 *   1. Explicit field.render override (highest)
 *   2. Semantic type registry render (input/display variants)
 *   3. Component catalog defaults by value type/cardinality (lowest)
 *
 * Input:  Core entity Field[], ComponentCatalog, OsfTypeDefinition registry.
 * Output: CompiledField[] — enriched field objects with resolved render, validation, etc.
 */
import type {
  Field,
  FieldOptions,
  ComponentCatalog,
  CompiledField,
  CompiledRender,
  OsfTypeDefinition,
} from "../types.js";
import { fieldCardinality } from "./helpers.js";
import { resolveBaseType, osfTypeDefinitionOf } from "../entity-fields.js";

export function resolveModelFields(
  coreFields: Field[],
  componentCatalog: ComponentCatalog,
  osfTypes?: Record<string, OsfTypeDefinition>
): CompiledField[] {
  return coreFields.map((field) => {
    const semType = osfTypeDefinitionOf(field.osfType, osfTypes ?? {});
    const baseType = field.baseType ?? resolveBaseType(field.osfType, osfTypes ?? {});
    if (!baseType) throw new Error(`${field.key}: unknown osfType ${field.osfType}.`);
    const authoredCardinality = field.cardinality ?? semType?.cardinality;
    const cardinality = fieldCardinality({ cardinality: authoredCardinality });

    const compiled: CompiledField = {
      key: field.key,
      baseType,
      cardinality,
      ...(authoredCardinality && typeof authoredCardinality === "object" &&
        cardinality === "collection"
        ? { cardinalityBounds: { ...authoredCardinality } }
        : {}),
      required: field.required ?? false,
      label: field.label ?? semType?.label ?? { en: field.key, nl: field.key },
      render: resolveRender(field, componentCatalog, semType),
      osfType: field.osfType,
    };
    if (field.readOnly) compiled.readOnly = true;
    if (field.immutable) compiled.immutable = true;
    if (field.writtenBy && field.writtenBy.length > 0) compiled.writtenBy = [...field.writtenBy];
    if (field.deriveOnCreate) compiled.deriveOnCreate = { ...field.deriveOnCreate };
    if (field.description) compiled.description = field.description;
    if (field.help) compiled.help = field.help;
    // Validation: field-level overrides semantic type defaults
    compiled.validation = field.validation ?? semType?.validation;
    if (field.permissions) compiled.permissions = field.permissions;
    if (field.authorization) compiled.authorization = field.authorization;
    // Classification, audit, hints: field overrides semantic type
    const classification = field.classification ?? semType?.classification;
    if (classification) compiled.classification = classification;
    const retention = field.retention ?? semType?.retention;
    if (retention) compiled.retention = retention;
    const audit = field.audit ?? semType?.audit;
    if (audit) compiled.audit = audit;
    const hints = field.hints ?? semType?.hints;
    if (hints) compiled.hints = hints;
    // New properties
    if (field.unit) compiled.unit = field.unit;
    if (field.defaultValue !== undefined) compiled.defaultValue = field.defaultValue;
    if (field.variables) compiled.variables = field.variables;
    if (field.sortable) compiled.sortable = field.sortable;
    if (field.entityValue) compiled.entityValue = { ...field.entityValue };
    if (field.allowedDefinitions) compiled.allowedDefinitions = [...field.allowedDefinitions].sort();
    if (field.childAuthorization) compiled.childAuthorization = field.childAuthorization;
    if (field.relationship) compiled.relationship = field.relationship;
    if (field.visibility) compiled.visibility = field.visibility;
    if (field.computed) compiled.computed = field.computed;
    if (field.graphqlType) compiled.graphqlType = field.graphqlType;
    const fieldOptions = resolveFieldOptions(field) ?? semType?.options;
    if (fieldOptions) compiled.options = fieldOptions;
    if (field.layoutFraction) compiled.layoutFraction = field.layoutFraction;
    if (field.localized) compiled.localized = field.localized;
    if (field.suggestions) compiled.suggestions = field.suggestions;
    // Nested fields (object/array types)
    // A reference's target schema belongs to the entity registry, not inline
    // under the UUID field. Expanding it would recurse forever on inverses.
    const childFields = semType?.kind === "entity"
      ? undefined
      : field.shape ?? field.children ?? semType?.shape ?? semType?.children;
    if (childFields) {
      compiled.children = resolveModelFields(childFields, componentCatalog, osfTypes);
    }
    const itemField = field.item ?? semType?.item;
    if (itemField) {
      compiled.item = resolveModelFields([itemField], componentCatalog, osfTypes)[0];
    }
    return compiled;
  });
}

export function resolveFieldOptions(field: Pick<Field, "options" | "reference">): FieldOptions | undefined {
  if (field.options) {
    return field.options;
  }

  if (field.reference?.kind === "referentiedata" && field.reference.group) {
    return {
      type: "referentiedata",
      referentieGroep: field.reference.group,
    };
  }

  return undefined;
}

/**
 * Resolution order:
 * 1. field.render (explicit override — highest priority)
 * 2. field.osfType → semantic type registry render
 * 3. field.baseType/cardinality → component catalog defaults (lowest)
 */
export function resolveRender(
  field: Field,
  catalog: ComponentCatalog,
  semType?: OsfTypeDefinition
): CompiledRender {
  // 1. Explicit field render override
  if (field.render) {
    const componentName = field.render.component;
    return {
      component: componentName,
      ...(field.render.props && Object.keys(field.render.props).length > 0
        ? { props: field.render.props }
        : {}),
    };
  }

  // 2. Semantic type render
  if (semType?.render) {
    const componentName = field.readOnly ? semType.render.display : semType.render.input;
    return {
      component: componentName,
      ...(semType.props ? { props: semType.props } : {}),
    };
  }

  if (semType?.kind === "entityId") {
    return {
      component: field.readOnly ? "EntityReferenceDisplay" : "EntityReferenceSelect",
    };
  }

  // 3. Default for field value shape
  const defaultKey = fieldCardinality(field) === "collection"
    ? field.osfType === "fieldDefinition"
      ? "fieldDefinitionCollection"
      : "collection"
    : field.baseType;
  const defaultEntry = catalog.defaults[defaultKey] ?? catalog.defaults[field.baseType];
  if (defaultEntry) {
    const componentName = defaultEntry.component;
    return {
      component: componentName,
    };
  }

  return { component: "Input" };
}
