// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { ReactNode } from "react";
import type { Field } from "@/generated/compiler/field-contract";
import { isFieldObjectCollection } from "@/lib/field-contract/field-v2";
import {
  SemanticCollectionField,
  type SemanticCollectionFieldProps,
} from "./semantic-collection-field";

export type SemanticCollectionAdapter = {
  semanticType: string;
  framework: "semanticCollectionField";
  defaultExpandedItems?: SemanticCollectionFieldProps["defaultExpandedItems"];
  createItem?: () => unknown;
};

function createActionDefinitionItem() {
  return {
    key: "",
    label: { nl: "", en: "" },
    description: { nl: "", en: "" },
    tone: "default",
    policyIds: [],
    formFields: [],
  };
}

const semanticCollectionAdapters: Record<string, SemanticCollectionAdapter> = {
  actionDefinition: {
    semanticType: "actionDefinition",
    framework: "semanticCollectionField",
    createItem: createActionDefinitionItem,
  },
};

export function resolveSemanticCollectionAdapter(
  field: Field,
): SemanticCollectionAdapter | null {
  if (!isFieldObjectCollection(field)) return null;
  if (!field.semanticType) return null;

  // fieldDefinition remains on FieldSchemaField until its variable-source rows
  // can converge without changing field-schema behavior.
  return semanticCollectionAdapters[field.semanticType] ?? null;
}

export function renderSemanticCollectionField(
  props: SemanticCollectionFieldProps,
): ReactNode | undefined {
  const adapter = resolveSemanticCollectionAdapter(props.field);
  if (!adapter) return undefined;

  return (
    <SemanticCollectionField
      {...props}
      defaultExpandedItems={
        props.defaultExpandedItems ?? adapter.defaultExpandedItems
      }
      createItem={props.createItem ?? adapter.createItem}
    />
  );
}
