// @ts-nocheck
import type { CoreEntity, Field, SemanticTypeDefinition } from "../../../../../packages/compiler/src/authoring/types.js";
import type { WorkflowActionConfig, WorkflowActionEntry } from "./types.js";
import { ACTION_ORDER } from "./types.js";
import { resolveEntityIdSemanticTypeKey } from "./catalog.js";
import { cloneWorkflowField, filterWorkflowHiddenFields, isCollectionCardinality, isWorkflowHiddenField, resolveLocalizedLabel } from "./utils.js";

export function resolveFieldSubset(
  fields: Field[],
  keys: string[] | undefined,
  fallback: Field[],
) {
  if (!keys || keys.length === 0) {
    return filterWorkflowHiddenFields(fallback).map(cloneWorkflowField);
  }

  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  return keys
    .map((key) => fieldMap.get(key))
    .filter((field): field is Field => Boolean(field))
    .filter((field) => !isWorkflowHiddenField(field))
    .map(cloneWorkflowField);
}

/**
 * Synthesizes virtual `<relKey>Id` fields for every `belongsTo` relationship,
 * so the workflow designer exposes a picker for each foreign key without
 * authors having to hand-author them. The semantic type is read from the
 * target entity's `id` field — there is no name-based derivation.
 *
 * Throws if a target entity is missing from the registry, or if its `id`
 * field has no `semanticType`. Both conditions are caught upstream by the
 * validator and the JSON schema; this is defense in depth.
 */
export function buildSyntheticBelongsToIdFields(
  entity: CoreEntity,
  entityRegistry: Map<string, CoreEntity>,
  semanticTypes: Record<string, SemanticTypeDefinition>,
): Field[] {
  const existingFieldKeys = new Set(entity.fields.map((field) => field.key));
  const relationships = entity.relationships ?? [];
  const syntheticFields: Field[] = [];

  for (const relationship of relationships) {
    if (relationship.kind !== "belongsTo" || !relationship.foreignKey) {
      continue;
    }

    const key = `${relationship.key}Id`;
    if (existingFieldKeys.has(key)) {
      continue;
    }

    const targetEntity = entityRegistry.get(relationship.target);
    if (!targetEntity) {
      // The authored entity catalog may be partial, so a belongsTo can target
      // an entity that is not present in this repo
      // (e.g. ContactDetail → RelationRole). The core backend compiler
      // tolerates that (skippedReferences); do the same here instead of
      // failing the whole workflow generation — no synthetic <key>Id picker
      // field is emitted for the missing target.
      // (buildRelationshipOutputFields already skips missing targets.)
      continue;
    }
    const targetIdField = targetEntity.fields.find((field) => field.key === "id");
    const semanticType = resolveEntityIdSemanticTypeKey(
      relationship.target,
      targetIdField,
    );
    const remoteUrl = semanticTypes[semanticType]?.listUrl;
    if (!remoteUrl) {
      throw new Error(
        `Entity '${entity.entity}' belongsTo '${relationship.key}' → ` +
          `'${relationship.target}': semanticType '${semanticType}' has no listUrl ` +
          `in the catalog. Ensure the entry has 'kind: entityId' and 'listUrl' set.`,
      );
    }

    const relationshipLabel = resolveLocalizedLabel(
      relationship.label,
      relationship.target,
    );

    // Every belongsTo FK is an entity ID — in the workflow designer we always
    // want to let the user either pick from the target entity's records or
    // bind a variable. The `OptionVariablePicker` does both when given a
    // remote source.
    syntheticFields.push({
      key,
      valueType: "string",
      validation: { format: "uuid" },
      required: false,
      label: relationshipLabel,
      description: {
        en: `Choose the ${relationshipLabel.en.toLowerCase()} to associate.`,
        nl: `Kies de ${relationshipLabel.nl.toLowerCase()} om te koppelen.`,
      },
      semanticType,
      persisted: {
        column: relationship.foreignKey,
        storageClass: "core",
      },
      options: {
        type: "remote" as const,
        remoteUrl,
      },
      render: {
        component: "OptionVariablePicker",
        props: {
          valueMode: "insertText",
        },
      },
    });
  }

  return syntheticFields;
}

/**
 * Builds relationship output fields for workflow nodes:
 * - belongsTo → nested object with target entity's scalar fields (one level deep)
 * - hasMany/manyToMany → aggregate object with count field
 *
 * These fields are opt-in via the output parameters panel, same as any other field.
 */
export function buildRelationshipOutputFields(
  entity: CoreEntity,
  entityMap: Map<string, CoreEntity>,
): Field[] {
  const relationships = entity.relationships ?? [];
  const existingFieldKeys = new Set(entity.fields.map((field) => field.key));
  const relationshipFields: Field[] = [];

  for (const relationship of relationships) {
    const relationshipLabel = resolveLocalizedLabel(
      relationship.label,
      relationship.target,
    );

    if (relationship.kind === "belongsTo") {
      // Skip if there's already a field with this key
      if (existingFieldKeys.has(relationship.key)) continue;

      const targetEntity = entityMap.get(relationship.target);
      if (!targetEntity) continue;

      // Build nested object with target entity's scalar fields (one level deep)
      const targetScalarFields = targetEntity.fields
        .filter((field) =>
          !isCollectionCardinality(field.cardinality)
          && field.valueType !== "object"
          && !isWorkflowHiddenField(field),
        )
        .map((field) => cloneWorkflowField({ ...field, readOnly: true }));

      if (targetScalarFields.length === 0) continue;

      relationshipFields.push({
        key: relationship.key,
        valueType: "object",
        readOnly: true,
        label: relationshipLabel,
        description: {
          en: `Fields from the related ${relationshipLabel.en.toLowerCase()}.`,
          nl: `Velden van de gerelateerde ${relationshipLabel.nl.toLowerCase()}.`,
        },
        children: targetScalarFields,
      });
    } else {
      // hasMany / manyToMany → aggregate object
      const aggregateKey = `${relationship.key}Aggregate`;
      if (existingFieldKeys.has(aggregateKey)) continue;

      relationshipFields.push({
        key: aggregateKey,
        valueType: "object",
        readOnly: true,
        label: {
          en: `${relationshipLabel.en} (aggregate)`,
          nl: `${relationshipLabel.nl} (aggregaat)`,
        },
        description: {
          en: `Aggregate values for related ${relationshipLabel.en.toLowerCase()} records.`,
          nl: `Geaggregeerde waarden van gerelateerde ${relationshipLabel.nl.toLowerCase()}-records.`,
        },
        hints: {
          sourceHint: `aggregate:${relationship.target}:${relationship.key}`,
        },
        children: [
          {
            key: "count",
            valueType: "integer",
            readOnly: true,
            label: { en: "Count", nl: "Aantal" },
            description: {
              en: `Number of related ${relationshipLabel.en.toLowerCase()} records.`,
              nl: `Aantal gerelateerde ${relationshipLabel.nl.toLowerCase()}-records.`,
            },
          },
        ],
      });
    }
  }

  return relationshipFields;
}

export function normalizeActionConfig(
  config: WorkflowActionConfig | undefined,
): Exclude<WorkflowActionConfig, boolean> | null {
  if (config == null || config === false) {
    return null;
  }

  if (config === true) {
    return { enabled: true };
  }

  if (config.enabled === false) {
    return null;
  }

  return {
    enabled: config.enabled ?? true,
    readableFields: config.readableFields,
    writableFields: config.writableFields,
    defaultSort: config.defaultSort,
  };
}

export function getEntityActionConfigs(entity: CoreEntity) {
  const actionConfigMap = entity.workflow?.nodes?.actions;
  if (!actionConfigMap) {
    return [];
  }

  const enabledActions: WorkflowActionEntry[] = ACTION_ORDER.flatMap((action) => {
    const config = normalizeActionConfig(actionConfigMap[action]);
    if (!config?.enabled) {
      return [];
    }

    return [{ action, config }];
  });

  const waitConfig = normalizeActionConfig(actionConfigMap.wait);
  if (waitConfig?.enabled) {
    enabledActions.push({
      action: "wait",
      config: waitConfig,
    });
  }

  const awaitActionConfig = normalizeActionConfig(actionConfigMap.awaitAction);
  if (awaitActionConfig?.enabled) {
    enabledActions.push({
      action: "awaitAction",
      config: awaitActionConfig,
    });
  }

  return enabledActions;
}
