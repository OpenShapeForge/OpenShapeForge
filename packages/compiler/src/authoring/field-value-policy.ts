// SPDX-License-Identifier: BUSL-1.1
import { FIELD_ITEM_ID, type FieldValuePolicy } from "@openshapeforge/operations";
import type { CompiledField } from "./types/compiled.js";
import { normalizeKeycloakRoleName } from "./role-names.js";

const restricting = new Set(["confidential", "pii", "bsn"]);
const roles = (values: readonly string[]) =>
  [...new Set([...values, ...values.map(normalizeKeycloakRoleName)])].sort();

export function compileFieldValuePolicy(field: CompiledField): FieldValuePolicy | undefined {
  const children = Object.fromEntries((field.children ?? []).flatMap((child) => {
    const policy = compileFieldValuePolicy(child);
    return policy ? [[child.key, policy]] : [];
  }));
  const item = field.item ? compileFieldValuePolicy(field.item) : undefined;
  const protectedItems = Object.keys(children).length > 0 || item !== undefined;
  const objectItems = field.cardinality === "collection" && (field.item
    ? field.item.baseType === "object" && field.item.cardinality === "single"
    : field.baseType === "object");
  const sensitivity = field.classification?.sensitivity;
  const policy: FieldValuePolicy = {
    ...(sensitivity && restricting.has(sensitivity)
      ? { classification: sensitivity as NonNullable<FieldValuePolicy["classification"]> } : {}),
    ...(field.immutable ? { immutable: true as const } : {}),
    ...(field.writtenBy?.length ? { writtenBy: [...field.writtenBy] } : {}),
    ...(field.authorization ? {
      readRoles: roles(field.authorization.roles.read ?? []),
      writeRoles: roles(field.authorization.roles.write ?? []),
    } : {}),
    ...(Object.keys(children).length ? { children } : {}),
    ...(item ? { item } : {}),
    ...(objectItems && protectedItems ? { itemKey: FIELD_ITEM_ID } : {}),
  };
  return Object.keys(policy).length ? policy : undefined;
}

/** Add the runtime-owned item identity without making authored objects open. */
export function fieldValuePolicySchema(schema: Record<string, unknown>, policy: FieldValuePolicy,
  options: { partial?: boolean } = {}): Record<string, unknown> {
  const result = structuredClone(schema);
  const addItemKey = (node: Record<string, unknown>, key: string): void => {
    const properties = node.properties as Record<string, unknown> | undefined;
    if (properties && Object.hasOwn(properties, key)) {
      throw new Error(`Collection item property "${key}" is compiler-managed and cannot be authored.`);
    }
    node.properties = { ...properties, [key]: { type: "string", format: "uuid" } };
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[keyword])) for (const branch of node[keyword]) {
        if (branch && typeof branch === "object" && !Array.isArray(branch)) addItemKey(branch, key);
      }
    }
  };
  const visit = (node: Record<string, unknown>, protection: FieldValuePolicy): void => {
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[keyword])) for (const branch of node[keyword]) {
        if (branch && typeof branch === "object" && !Array.isArray(branch)) visit(branch, protection);
      }
    }
    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties && protection.children) {
      if (options.partial) delete node.required;
      for (const [key, child] of Object.entries(protection.children)) {
        if (properties[key]) visit(properties[key], child);
      }
    }
    const item = protection.item ?? (protection.children ? { children: protection.children } : undefined);
    if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
      const itemSchema = node.items as Record<string, unknown>;
      if (protection.itemKey) addItemKey(itemSchema, protection.itemKey);
      if (item) visit(itemSchema, item);
      // A caller may reorder an unreadable item using its retained identity.
      // Keep the normal item requirements for actual values and for storage.
      if (options.partial && protection.itemKey && item && !item.children) {
        node.items = { anyOf: [itemSchema, {
          type: "object",
          properties: { [protection.itemKey]: { type: "string", format: "uuid" } },
          required: [protection.itemKey],
          additionalProperties: false,
        }] };
      }
    }
  };
  visit(result, policy);
  return result;
}

/** Only policy-bearing object nodes have member-patch semantics. */
export function partialFieldPolicySchema(schema: Record<string, unknown>, policy: FieldValuePolicy): Record<string, unknown> {
  return fieldValuePolicySchema(schema, policy, { partial: true });
}
