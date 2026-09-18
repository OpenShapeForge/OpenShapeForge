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
 * @input  Field definition with valueType, osfType, readOnly, and optional render override
 * @output ResolvedFieldRender: { component, props, source }
 */
import type {
  FieldRender,
  FieldValidation,
  OsfTypeDefinition,
} from "@/generated/compiler/field-contract";
import {
  COMPILER_FIELD_COMPONENT_DEFAULTS,
  type CompilerFieldTypeKey,
} from "@/generated/compiler/component-defaults";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";

type RendererAwareField = {
  valueType?: string;
  cardinality?: string | { min?: number; max?: number | "unbounded" };
  osfType?: string;
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
  source: "explicit" | "osfType" | "fieldType" | "fallback";
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

function getOsfTypeKey(field: RendererAwareField) {
  return typeof field.osfType === "string" &&
    field.osfType.trim().length > 0
    ? field.osfType.trim()
    : undefined;
}

export function normalizeFieldComponentName(component?: string) {
  if (!component || component.trim().length === 0) {
    return undefined;
  }

  const normalized = component.trim();
  return COMPONENT_ALIASES[normalized] ?? normalized;
}

export function getCompilerOsfTypeDefinition(
  osfType: string | undefined,
): OsfTypeDefinition | undefined {
  if (!osfType) {
    return undefined;
  }

  return COMPILER_OSF_TYPES[
    osfType as keyof typeof COMPILER_OSF_TYPES
  ];
}

export function getFieldOsfTypeDefinition(field: RendererAwareField) {
  return getCompilerOsfTypeDefinition(getOsfTypeKey(field));
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

  const osfType = getFieldOsfTypeDefinition(field);
  const semanticRender = buildResolvedRender(
    osfType?.render?.input,
    osfType?.props,
    "osfType",
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

  const osfType = getFieldOsfTypeDefinition(field);
  const semanticRender = buildResolvedRender(
    osfType?.render?.display,
    osfType?.props,
    "osfType",
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
  return field.validation ?? getFieldOsfTypeDefinition(field)?.validation;
}
