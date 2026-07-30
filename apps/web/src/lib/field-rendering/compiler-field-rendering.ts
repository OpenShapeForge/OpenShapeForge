// SPDX-License-Identifier: BUSL-1.1
/**
 * Field component resolution — determines which React component to render for
 * a given field based on a three-tier priority:
 *
 * 1. Explicit override (`field.render.component`)
 * 2. Semantic type mapping (e.g. "bsn" -> BsnDisplay, "email" -> Input)
 * 3. Base field value/cardinality default (e.g. "string" -> Input, "boolean" -> Switch)
 *
 * Resolves both input components (for edit mode) and display components
 * (for read-only mode). Also resolves field-level validation rules from
 * semantic type definitions.
 *
 * @input  Field definition with valueType, semanticType, readOnly, and optional render override
 * @output ResolvedFieldRender: { component, props, source }
 */
import type {
  FieldRender,
  FieldValidation,
  SemanticTypeDefinition,
} from "@/generated/compiler/field-contract";
import {
  COMPILER_FIELD_COMPONENT_DEFAULTS,
  type CompilerFieldTypeKey,
} from "@/generated/compiler/component-defaults";
import { COMPILER_SEMANTIC_TYPES } from "@/generated/compiler/semantic-types";

type RendererAwareField = {
  valueType?: string;
  cardinality?: string | { min?: number; max?: number | "unbounded" };
  semanticType?: string;
  readOnly?: boolean;
  render?: Partial<FieldRender> | null;
  validation?: FieldValidation;
};

function isRendererCollectionField(field: RendererAwareField): boolean {
  if (field.cardinality === "collection") return true;
  if (!field.cardinality || typeof field.cardinality !== "object") return false;
  return (
    field.cardinality.max === "unbounded" ||
    (typeof field.cardinality.max === "number" && field.cardinality.max > 1)
  );
}

export type ResolvedFieldRender = {
  component: string;
  props?: Record<string, unknown>;
  source: "explicit" | "semanticType" | "fieldType" | "fallback";
};

const COMPONENT_ALIASES: Record<string, string> = {
  // Compatibility-only names accepted from older YAML, seeds, and external
  // integrations. Source-authored renderer fields should use the canonical
  // component names on the right-hand side.
  TextArea: "InputMultiline",
  Textarea: "InputMultiline",
  TextInput: "Input",
  Toggle: "Switch",
  MoneyInput: "NumberInput",
};

function getSemanticTypeKey(field: RendererAwareField) {
  return typeof field.semanticType === "string" &&
    field.semanticType.trim().length > 0
    ? field.semanticType.trim()
    : undefined;
}

export function normalizeFieldComponentName(component?: string) {
  if (!component || component.trim().length === 0) {
    return undefined;
  }

  const normalized = component.trim();
  return COMPONENT_ALIASES[normalized] ?? normalized;
}

export function getCompilerSemanticTypeDefinition(
  semanticType: string | undefined,
): SemanticTypeDefinition | undefined {
  if (!semanticType) {
    return undefined;
  }

  return COMPILER_SEMANTIC_TYPES[
    semanticType as keyof typeof COMPILER_SEMANTIC_TYPES
  ];
}

export function getFieldSemanticTypeDefinition(field: RendererAwareField) {
  return getCompilerSemanticTypeDefinition(getSemanticTypeKey(field));
}

function getDefaultFieldTypeRender(field: RendererAwareField) {
  const key = isRendererCollectionField(field) ? "collection" : field.valueType;

  if (!key) {
    return undefined;
  }

  return COMPILER_FIELD_COMPONENT_DEFAULTS[
    key as CompilerFieldTypeKey
  ];
}

function buildResolvedRender(
  component: string | undefined,
  props: Record<string, unknown> | undefined,
  source: ResolvedFieldRender["source"],
): ResolvedFieldRender | undefined {
  const normalizedComponent = normalizeFieldComponentName(component);
  if (!normalizedComponent) {
    return undefined;
  }

  return {
    component: normalizedComponent,
    props:
      props && Object.keys(props).length > 0
        ? props
        : undefined,
    source,
  };
}

export function resolveFieldInputRender(field: RendererAwareField): ResolvedFieldRender {
  const explicitRender = buildResolvedRender(
    field.render?.component,
    field.render?.props,
    "explicit",
  );
  if (explicitRender) {
    return explicitRender;
  }

  const semanticType = getFieldSemanticTypeDefinition(field);
  const semanticRender = buildResolvedRender(
    semanticType?.render?.input,
    semanticType?.props,
    "semanticType",
  );
  if (semanticRender) {
    return semanticRender;
  }

  const fieldTypeRender = buildResolvedRender(
    getDefaultFieldTypeRender(field)?.component,
    undefined,
    "fieldType",
  );
  if (fieldTypeRender) {
    return fieldTypeRender;
  }

  return { component: "Input", source: "fallback" };
}

export function resolveFieldDisplayRender(field: RendererAwareField): ResolvedFieldRender {
  const explicitRender = buildResolvedRender(
    field.render?.component,
    field.render?.props,
    "explicit",
  );
  if (explicitRender) {
    return explicitRender;
  }

  const semanticType = getFieldSemanticTypeDefinition(field);
  const semanticRender = buildResolvedRender(
    semanticType?.render?.display,
    semanticType?.props,
    "semanticType",
  );
  if (semanticRender) {
    return semanticRender;
  }

  const fieldTypeDefault = getDefaultFieldTypeRender(field);
  const isReadOnlyFieldType =
    fieldTypeDefault &&
    typeof fieldTypeDefault === "object" &&
    "readOnly" in fieldTypeDefault &&
    fieldTypeDefault.readOnly === true;
  const fieldTypeRender = buildResolvedRender(
    isReadOnlyFieldType ? fieldTypeDefault.component : "TextDisplay",
    undefined,
    "fieldType",
  );
  if (fieldTypeRender) {
    return fieldTypeRender;
  }

  return { component: "TextDisplay", source: "fallback" };
}

export function resolveFieldValidation(field: RendererAwareField) {
  return field.validation ?? getFieldSemanticTypeDefinition(field)?.validation;
}
