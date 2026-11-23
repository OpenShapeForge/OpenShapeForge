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
  ComponentDefinition,
  FigmaFieldProp,
  CompiledField,
  CompiledRender,
  OsfTypeDefinition,
} from "../types.js";
import { fieldCardinality } from "./helpers.js";
import { resolveBaseType, osfTypeDefinitionOf } from "../entity-fields.js";
import { cardinalityOf, resolveOptions } from "@openshapeforge/operations";

export function resolveModelFields(
  coreFields: Field[],
  componentCatalog: ComponentCatalog,
  osfTypes?: Record<string, OsfTypeDefinition>,
  nested = false,
): CompiledField[] {
  return coreFields.map((field) => {
    const semType = osfTypeDefinitionOf(field.osfType, osfTypes ?? {});
    const baseType = field.baseType ?? resolveBaseType(field.osfType, osfTypes ?? {});
    if (!baseType) throw new Error(`${field.key}: unknown osfType ${field.osfType}.`);
    const { cardinality, bounds, required } = cardinalityOf(field.cardinality ?? semType?.cardinality, field.key);

    const compiled: CompiledField = {
      key: field.key,
      baseType,
      cardinality,
      ...(bounds ? { cardinalityBounds: bounds } : {}),
      required: field.required === true || required,
      label: field.label ?? semType?.label ?? { en: field.key, nl: field.key },
      render: resolveRender(required && !field.required ? { ...field, required: true } : field, componentCatalog, semType),
      osfType: field.osfType,
    };
    if (field.authoring) compiled.authoring = structuredClone(field.authoring);
    if (field.document) compiled.document = structuredClone(field.document);
    if (field.transform) compiled.transform = field.transform.map(step => ({ ...step }));
    if (field.readOnly) compiled.readOnly = true;
    if (field.writeSource) compiled.writeSource = field.writeSource;
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
    if (field.defaultTemplate !== undefined) compiled.defaultTemplate = field.defaultTemplate;
    if (field.variables) compiled.variables = field.variables;
    if (field.sortable) compiled.sortable = field.sortable;
    if (field.entityValue) compiled.entityValue = { ...field.entityValue };
    if (field.valueFieldsFrom) compiled.valueFieldsFrom = { ...field.valueFieldsFrom };
    if (field.typedBy) compiled.typedBy = { ...field.typedBy };
    if (field.allowedDefinitions) compiled.allowedDefinitions = [...field.allowedDefinitions].sort();
    if (field.childAuthorization) compiled.childAuthorization = field.childAuthorization;
    if (field.childLock) compiled.childLock = field.childLock;
    if (field.relationship) compiled.relationship = field.relationship;
    if (field.visibility) compiled.visibility = field.visibility;
    if (field.computed) compiled.computed = field.computed;
    if (field.graphqlType) compiled.graphqlType = field.graphqlType;
    // A top-level identity alias is the entity's own primary key (the
    // normalizer admits it nowhere else): not a choice, so the alias's
    // optionSource applies only to an inline identifier value.
    const identity = !nested && semType?.kind === "entityId";
    const fieldOptions = resolveFieldOptions(field, identity ? { ...semType, optionSource: undefined } : semType);
    if (fieldOptions) compiled.options = fieldOptions;
    if (semType?.schema) compiled.schema = semType.schema;
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
      compiled.children = resolveModelFields(childFields, componentCatalog, osfTypes, true);
    }
    const itemField = field.item ?? semType?.item;
    if (itemField) {
      compiled.item = resolveModelFields([itemField], componentCatalog, osfTypes, true)[0];
    }
    return compiled;
  });
}

/**
 * A field's choices, resolved once through the shared resolver (`options`,
 * `reference`, the catalog type's `options`, then its `optionSource`). The
 * web presentation's `render.props.referentieGroep` is the same group spelled
 * for the select component: it is normalized into `options` here, and may
 * not name a different group than the field's own options.
 */
export function resolveFieldOptions(
  field: Pick<Field, "key" | "options" | "render"> & { reference?: { kind?: string; group?: string } },
  semType?: OsfTypeDefinition,
): FieldOptions | undefined {
  const resolved = resolveOptions(field, semType) as FieldOptions | undefined;
  const renderGroep = field.render?.props?.referentieGroep;
  if (typeof renderGroep !== "string" || renderGroep.length === 0) return resolved;
  if (!resolved) return { type: "referentiedata", referentieGroep: renderGroep };
  if (resolved.type === "referentiedata" && resolved.referentieGroep !== renderGroep) {
    throw new Error(`${field.key}: render.props.referentieGroep ${renderGroep} contradicts options.referentieGroep ${resolved.referentieGroep}.`);
  }
  return resolved;
}

/**
 * Resolution order:
 * Components use the first match; props merge defaults < semantic type < explicit field.
 * 1. field.render (component override — highest priority)
 * 2. field.osfType → semantic type registry render
 * 3. field.baseType/cardinality → component catalog defaults (lowest)
 */
export function resolveRender(
  field: Field,
  catalog: ComponentCatalog,
  semType?: OsfTypeDefinition
): CompiledRender {
  const defaultKey = fieldCardinality(field) === "collection" ? "collection" : field.baseType;
  const typeDefault = catalog.defaults[defaultKey] ?? catalog.defaults[field.baseType] ?? catalog.defaults.string;
  // A type whose value may be absent names the component for a value that must be there.
  const defaultEntry = field.required && typeDefault?.required ? typeDefault.required : typeDefault;
  const component = field.render?.component
    ?? (field.options?.type === "static" && field.options.presentation === "tiles" ? "ChoiceTiles" : undefined)
    ?? (field.readOnly ? semType?.render?.display : semType?.render?.input)
    ?? (semType?.kind === "entityId" ? (field.readOnly ? "EntityReferenceDisplay" : "EntityReferenceSelect") : undefined)
    ?? defaultEntry?.component
    // A catalog without defaults (a unit test's) gives the design system's text field.
    ?? "FieldSingleLine";
  const declared = assertDeclaredComponent(catalog, component, field.key);
  // Currency also carries canonical numeric value context; changing the renderer must not erase it.
  const contextProp = (key: string, value: unknown) => key === "currency" && (field.baseType === "number" || field.baseType === "integer") && typeof value === "string";
  const authorable = (key: string, value: unknown) => !declared || declaredProp(declared, key) || contextProp(key, value);
  // What a default or the field's type sets applies where the chosen component takes it.
  const layer = (props: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(props ?? {}).filter(([key, value]) => authorable(key, value)));
  const props = {
    ...layer(defaultEntry?.props),
    ...layer(semType?.props),
    ...field.render?.props,
  };
  if (declared && (declared.kind === "field" || declared.kind === "extension")) assertPresentationProps(catalog, declared, component, props, field.key, contextProp);
  return { component, ...(Object.keys(props).length ? {props: structuredClone(props)} : {}) };

}

const declaredProp = (declared: ComponentDefinition, key: string) => declared.props.includes(key) || Boolean(declared.texts?.includes(key));

/**
 * Every presentation component YAML names is in the catalog: a design-system
 * field under its Figma name, a hand-written component or a plugin's declared
 * extension. A catalog without components (a unit test's) checks nothing.
 */
export function assertDeclaredComponent(catalog: ComponentCatalog, component: string, owner: string): ComponentDefinition | undefined {
  const declared = catalog.components[component];
  if (!declared && Object.keys(catalog.components).length) throw new Error(`${owner}: unknown presentation component ${component}.`);
  return declared;
}

/** The layout and label width every field frame takes, as Figma declares them on its fields. */
function frameProps(catalog: ComponentCatalog): Record<string, FigmaFieldProp> {
  for (const definition of Object.values(catalog.components)) {
    const props = definition.figma?.props;
    if (props?.layout && props.labelWidth) return { layout: props.layout, labelWidth: props.labelWidth };
  }
  return {};
}

function assertPresentationProps(
  catalog: ComponentCatalog,
  declared: ComponentDefinition,
  component: string,
  props: Record<string, unknown>,
  owner: string,
  contextProp: (key: string, value: unknown) => boolean,
): void {
  if ("state" in props && declared.figma?.props.state) throw new Error(`${owner}: ${component} takes no state; the renderer derives Figma's state at run time.`);
  const unsupported = Object.keys(props).filter(key => !declaredProp(declared, key) && !contextProp(key, props[key]));
  if (unsupported.length) throw new Error(`${owner}: ${component} does not declare presentation props ${unsupported.join(", ")}.`);
  const figma = { ...frameProps(catalog), ...declared.figma?.props };
  for (const [key, value] of Object.entries(props)) {
    const prop = figma[key];
    if (!prop || !declared.props.includes(key)) continue;
    if (prop.type === "VARIANT" && prop.options && !(typeof value === "string" && prop.options.includes(value))) {
      throw new Error(`${owner}: ${component} ${key} is one of ${prop.options.map(option => JSON.stringify(option)).join(", ")}, not ${JSON.stringify(value)}.`);
    }
    if (prop.type === "BOOLEAN" && typeof value !== "boolean") throw new Error(`${owner}: ${component} ${key} is true or false, not ${JSON.stringify(value)}.`);
  }
}
