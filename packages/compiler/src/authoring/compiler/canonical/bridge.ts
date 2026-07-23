// @ts-nocheck
/**
 * Entity-to-canonical bridge — transforms compiled entity contracts into
 * canonical compiler kernels. Converts compiled fields, profile types,
 * and form variants into the standardized canonical format.
 */
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledFormVariant,
  CompiledViewGroup,
  GraphQLProfileType,
} from "../../types.js";
import { parseCanonicalPath } from "./path.js";
import {
  normalizeCanonicalField,
  normalizeCanonicalPresentation,
  normalizeLegacyVisibilityConfig,
} from "./normalization.js";
import type {
  CanonicalCompilerContext,
  CanonicalCompilerKernel,
  CanonicalField,
  CanonicalFormPresentation,
  CanonicalPath,
  CanonicalPathRoot,
} from "./types.js";

export function buildCanonicalCompilerKernel(
  contract: Pick<CompiledEntityContract, "model" | "graphql" | "views">,
): CanonicalCompilerKernel {
  const contexts: Record<string, CanonicalCompilerContext> = {};

  for (const [context, viewContext] of Object.entries(contract.views)) {
    const fields = buildCanonicalContextFields(contract, context);
    const presentations: Record<string, CanonicalFormPresentation> = {};

    if (viewContext.form) {
      for (const [variantName, variant] of Object.entries(viewContext.form.variants)) {
        const presentationId = `form:${variantName}`;
        presentations[presentationId] = buildCanonicalFormPresentation(contract, context, presentationId, variantName, variant, viewContext.form.variants.create);
      }
    }

    contexts[context] = {
      fields,
      presentations,
    };
  }

  return { contexts };
}

function buildCanonicalContextFields(
  contract: Pick<CompiledEntityContract, "model" | "graphql">,
  context: string,
): Partial<Record<CanonicalPathRoot, CanonicalField[]>> {
  const businessFields = contract.model.fields.map((field) => compiledFieldToCanonicalField(field, "", "core"));
  const profileType = context !== "core" ? contract.graphql.profileTypes[context] : undefined;

  if (profileType && profileType.fields.length > 0) {
    businessFields.push({
      id: profileType.fieldName,
      key: profileType.fieldName,
      type: "object",
      label: { en: profileType.fieldName, nl: profileType.fieldName },
      required: false,
      source: "synthetic",
      children: profileType.fields.map((field) => compiledProfileFieldToCanonicalField(field, profileType.fieldName)),
    });
  }

  return {
    business: businessFields,
  };
}

function buildCanonicalFormPresentation(
  contract: Pick<CompiledEntityContract, "model" | "graphql">,
  context: string,
  presentationId: string,
  variantName: string,
  variant: CompiledFormVariant,
  createVariant: CompiledFormVariant | undefined,
): CanonicalFormPresentation {
  const groups = resolveFormGroups(variant, createVariant);
  const sections = flattenFormGroups(groups);

  return normalizeCanonicalPresentation({
    id: presentationId,
    kind: "form",
    mode: "edit",
    title: variant.title,
    sections: sections.map((section, sectionIndex) => ({
      id: `${presentationId}.section.${sectionIndex + 1}`,
      title: section.title,
      fields: section.fields.map((field) => {
        const entry = typeof field === "string" ? { key: field } : field;
        const path = resolveBusinessFieldPath(contract, context, entry.key);
        const modelField = resolveCompiledField(contract.model.fields, path);

        return {
          path,
          visibleWhen: modelField?.visibility
            ? normalizeLegacyVisibilityConfig(
                modelField.visibility,
                (candidate) => resolveBusinessFieldPath(contract, context, candidate),
                `${presentationId}.section.${sectionIndex + 1}.${entry.key}`,
              )
            : undefined,
          presentation: entry.renderOverride
            ? { renderer: entry.renderOverride.component }
            : undefined,
        };
      }),
    })),
    actions: [
      {
        id: `${variantName}-submit`,
        intent: "submit",
        label: variant.submit.label,
        primary: true,
        completion: {
          closesPresentation: true,
          requiresValid: "all",
        },
      },
    ],
  }) as CanonicalFormPresentation;
}

function compiledFieldToCanonicalField(
  field: CompiledField,
  parentId: string,
  source: CanonicalField["source"],
): CanonicalField {
  const id = [parentId, field.key].filter(Boolean).join(".");
  return normalizeCanonicalField({
    id,
    key: field.key,
    type: field.cardinality === "collection" ? "array" : field.valueType,
    label: field.label,
    description: field.description,
    required: field.required,
    readOnly: field.readOnly,
    semanticType: field.semanticType,
    defaultValue: field.defaultValue,
    validation: field.validation,
    render: field.render,
    options: (field as CompiledField & { options?: CanonicalField["options"] }).options,
    source,
    children: field.children?.map((child) => compiledFieldToCanonicalField(child, id, source)),
    item: field.item ? compiledFieldToCanonicalField(field.item, `${id}[]`, source) : undefined,
  });
}

function compiledProfileFieldToCanonicalField(
  field: GraphQLProfileType["fields"][number],
  parentId: string,
): CanonicalField {
  const key = field.name;
  const id = `${parentId}.${key}`;

  return normalizeCanonicalField({
    id,
    key,
    type: graphQlFieldTypeToCanonicalType(field.type),
    label: field.label ?? { en: key, nl: key },
    required: field.type.endsWith("!"),
    validation: field.validation,
    render: field.render ?? field.displayRender,
    options: undefined,
    semanticType: field.semanticType,
    source: "profile",
  });
}

function resolveBusinessFieldPath(
  contract: Pick<CompiledEntityContract, "model" | "graphql">,
  context: string,
  rawFieldKey: string,
): CanonicalPath {
  const trimmed = rawFieldKey.trim();
  if (!trimmed) {
    throw new Error("Field references require a non-empty key");
  }

  if (trimmed.startsWith("business.") || trimmed.startsWith("input.") || trimmed.startsWith("nodes.") || trimmed.startsWith("taskResult.")) {
    return parseCanonicalPath(trimmed);
  }

  const profileType = context !== "core" ? contract.graphql.profileTypes[context] : undefined;
  const coreKeys = new Set(contract.model.fields.map((field) => field.key));
  const profileFieldKeys = new Set(profileType?.fields.map((field) => field.name) ?? []);
  const parts = trimmed.split(".").filter(Boolean);

  if (parts.length === 0) {
    throw new Error(`Cannot resolve empty field key '${rawFieldKey}'`);
  }

  if (parts.length === 1) {
    if (coreKeys.has(parts[0])) {
      return parseCanonicalPath(`business.${parts[0]}`);
    }
    if (profileType && profileFieldKeys.has(parts[0])) {
      return parseCanonicalPath(`business.${profileType.fieldName}.${parts[0]}`);
    }
    return parseCanonicalPath(`business.${trimmed}`);
  }

  if (profileType && parts[0] === profileType.fieldName) {
    return parseCanonicalPath(`business.${parts.join(".")}`);
  }

  if (coreKeys.has(parts[0])) {
    return parseCanonicalPath(`business.${parts.join(".")}`);
  }

  if (profileType && profileFieldKeys.has(parts[0])) {
    return parseCanonicalPath(`business.${profileType.fieldName}.${parts.join(".")}`);
  }

  return parseCanonicalPath(`business.${trimmed}`);
}

function resolveCompiledField(fields: CompiledField[], path: CanonicalPath): CompiledField | undefined {
  if (path.root !== "business" || path.segments.length === 0) return undefined;

  let currentFields = fields;
  let currentField: CompiledField | undefined;

  for (const segment of path.segments) {
    if (segment.kind === "arrayItem") {
      currentFields = currentField?.item ? [currentField.item] : [];
      currentField = currentField?.item;
      continue;
    }

    currentField = currentFields.find((field) => field.key === segment.key);
    if (!currentField) return undefined;
    currentFields = currentField.children ?? [];
  }

  return currentField;
}

function resolveFormGroups(
  variant: Pick<CompiledFormVariant, "groups" | "extends">,
  createVariant: Pick<CompiledFormVariant, "groups"> | undefined,
): CompiledViewGroup[] {
  if (variant.groups.length > 0) {
    return variant.groups;
  }

  if (variant.extends === "create" && createVariant?.groups) {
    return createVariant.groups;
  }

  return createVariant?.groups ?? [];
}

function flattenFormGroups(groups: CompiledViewGroup[]): Array<{
  title?: { en?: string; nl?: string };
  fields: (string | { key: string; renderOverride?: { component: string } })[];
}> {
  const sections: Array<{
    title?: { en?: string; nl?: string };
    fields: (string | { key: string; renderOverride?: { component: string } })[];
  }> = [];

  function visit(group: CompiledViewGroup) {
    if ((group.fields?.length ?? 0) > 0) {
      sections.push({
        title: group.title ?? group.label,
        fields: group.fields ?? [],
      });
    }

    for (const child of group.groups ?? []) {
      visit(child);
    }
  }

  for (const group of groups) {
    visit(group);
  }

  return sections;
}

function graphQlFieldTypeToCanonicalType(type: string): string {
  const normalized = type.replace(/!/g, "");
  switch (normalized) {
    case "ID":
      return "uuid";
    case "String":
      return "string";
    case "Int":
      return "integer";
    case "Float":
      return "number";
    case "Boolean":
      return "boolean";
    default:
      return "string";
  }
}
