// SPDX-License-Identifier: BUSL-1.1
import type { Field, FieldOptions, FieldValidation } from "@/generated/compiler/field-contract";
import type {
  RendererFormDefinition,
  RendererFormGroup,
  RendererFieldConfig,
  FormGroupInterpretation,
} from "@/features/renderer/form-definition";
import type {
  GeneratedFormConfig,
  GeneratedFormFieldConfig,
  GeneratedFormGroupConfig,
  GeneratedFieldOptions,
} from "@/lib/generated-form-runtime-core";

type GeneratedFormInteropOptions = {
  id?: string;
  metadata?: Record<string, unknown>;
  surface?: NonNullable<RendererFormDefinition["presentation"]>["surface"];
  layoutColumns?: 1 | 2 | 3 | 4;
  groupInterpretation?: readonly FormGroupInterpretation[];
  chrome?: NonNullable<RendererFormDefinition["presentation"]>["chrome"];
};

function normalizeValueType(valueType: string | undefined): Field["valueType"] {
  switch (valueType) {
    case "string":
    case "integer":
    case "number":
    case "boolean":
    case "date":
    case "datetime":
    case "object":
      return valueType;
    default:
      return "string";
  }
}

function mapFieldOptions(options: GeneratedFieldOptions | undefined): FieldOptions | undefined {
  if (!options) {
    return undefined;
  }

  let type = options.type as FieldOptions["type"] | undefined;
  // Defensive fallback: if the compiler omitted the discriminator but emitted
  // static items, treat it as static so dropdowns don't render as empty
  // "Geen referentiedata gevonden" inputs. The compiler itself was fixed to
  // emit `type: "static"` (see resolve-referentiedata-options.ts), but older
  // generated artifacts may still lack it.
  if (!type && Array.isArray(options.items) && options.items.length > 0) {
    type = "static";
  }
  if (!type) {
    return undefined;
  }

  return {
    type,
    items: options.items as FieldOptions["items"],
    referentieGroep: options.referentieGroep,
  };
}

function mapField(field: GeneratedFormFieldConfig): Field {
  return {
    key: field.key,
    valueType: normalizeValueType(field.valueType),
    cardinality: field.cardinality ?? "single",
    variables: field.variables,
    searchable: field.searchable,
    filterable: field.filterable,
    sortable: field.sortable,
    required: field.required,
    readOnly: field.readOnly,
    defaultValue: field.defaultValue,
    label: field.label,
    description: field.description,
    help: field.help,
    semanticType: field.semanticType,
    layoutFraction: field.layoutFraction,
    validation: field.validation as FieldValidation | undefined,
    visibility: field.visibility as Field["visibility"],
    options: mapFieldOptions(field.options),
    suggestions: field.suggestions,
    children: field.children?.map(mapField),
    item: field.item ? mapField(field.item) : undefined,
    render: field.render?.component
      ? {
          component: field.render.component,
          ...(field.render.props ? { props: field.render.props } : {}),
        }
      : undefined,
  };
}

function mapGroup(group: GeneratedFormGroupConfig): RendererFormGroup {
  return {
    id: group.id,
    title: group.label ?? group.title,
    label: group.label,
    fields: group.fields ?? [],
    groups: group.groups?.map(mapGroup) ?? [],
    relationships: group.relationships as RendererFormGroup["relationships"],
    relationship: group.relationship as RendererFormGroup["relationship"],
    render: group.render,
  };
}

function buildGroups(config: GeneratedFormConfig): RendererFormGroup[] {
  if (config.groups && config.groups.length > 0) {
    return config.groups.map(mapGroup);
  }

  if (config.sections && config.sections.length > 0) {
    return config.sections.map((section, index) => ({
      id: `section-${index + 1}`,
      title: section.title,
      fields: section.fields,
      groups: [],
    }));
  }

  return [
    {
      id: "main",
      fields: config.fields.map((field) => field.key),
      groups: [],
    },
  ];
}

function buildFieldConfig(fields: GeneratedFormFieldConfig[]): Record<string, RendererFieldConfig> {
  return Object.fromEntries(
    fields.map((field) => [
      field.key,
      {
        dataPath: field.dataPath ?? field.key,
      } satisfies RendererFieldConfig,
    ]),
  );
}

function buildActions(
  config: GeneratedFormConfig,
): RendererFormDefinition["actions"] {
  type ActionItem = NonNullable<RendererFormDefinition["actions"]>[number];

  const actionItems: ActionItem[] =
    config.actions?.map((action, index) => ({
      id: String(action.key ?? `action-${index + 1}`),
      kind: (
        action.key === "cancel"
          ? "cancel"
          : action.key === "reset"
            ? "reset"
            : action.mutation === "create" || action.mutation === "update"
              ? "submit"
              : "custom"
      ) as ActionItem["kind"],
      label: action.label as ActionItem["label"],
    })) ?? [];

  if (actionItems.some((action) => action.kind === "submit")) {
    return actionItems;
  }

  return [
    ...actionItems,
    {
      id: "submit",
      kind: "submit",
      label: config.submitLabel,
    },
  ];
}

export function generatedFormConfigToRendererDefinition(
  config: GeneratedFormConfig,
  options: GeneratedFormInteropOptions = {},
): RendererFormDefinition {
  const fields = config.fields.map(mapField);

  return {
    schemaVersion: 1,
    id: options.id ?? "generated-form",
    kind: "form",
    mode: config.mode,
    title: config.title,
    submitLabel: config.submitLabel,
    successRoute: config.successRoute,
    routes: config.routes,
    metadata: options.metadata,
    presentation: {
      surface: options.surface ?? "page",
      density: "default",
      layout: {
        columns: options.layoutColumns ?? 2,
      },
      groupInterpretation: options.groupInterpretation ?? ["group", "card", "group"],
      chrome: {
        showTitle: true,
        showDescription: true,
        showGroupTitles: true,
        showGroupDescriptions: true,
        showActionBar: true,
        ...(options.chrome ?? {}),
      },
    },
    submission: {
      successRoute: config.successRoute,
      successBehavior: "redirect",
    },
    groups: buildGroups(config),
    fields,
    fieldConfig: buildFieldConfig(config.fields),
    actions: buildActions(config),
    variableSources: config.variableSources as RendererFormDefinition["variableSources"],
  };
}
