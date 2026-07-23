// @ts-nocheck
/**
 * BaseEntity loader and merger.
 *
 * Loads `entities/_base.yaml` (kind: baseEntity) and merges its meta-field set
 * into every core entity and context-full entity at load time. Implements the
 * strict-replace policy: an author-declared field with the same key as a base
 * field raises a clear compile error (caller must remove the duplicate or set
 * `baseEntity: false` to opt out).
 *
 * Auto-derives the `id` field's `semanticType` per entity using the convention
 * `<entityCamelCase>Id` (e.g. entity `Assignment` -> `assignmentId`). This
 * means individual entities never declare their own `id` field just to attach
 * a semantic type catalog entry.
 *
 * Tenant-scope: `tenant_id` is intentionally NOT in the base set. The backend
 * manifest still injects `tenant_id` only when an entity is tenant-scoped
 * (i.e. declares an `authorization` block). Adding it here would create
 * unwanted tenant_id columns on non-tenant tables.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CoreEntity, Field } from "./types.js";

export const BASE_ENTITY_FILENAME = "_base.yaml";

export interface BaseEntityDefinition {
  schemaVersion: number;
  kind: "baseEntity";
  entity: string;
  title?: string;
  description?: string;
  language?: string;
  fields: Field[];
}

const baseEntityCache = new Map<string, BaseEntityDefinition | null>();

/**
 * Load the BaseEntity definition from `<authoringDir>/entities/_base.yaml`.
 * Returns `null` if the file is absent (allows tests to opt out by using an
 * authoring dir without `_base.yaml`). Cached per `authoringDir` so the file
 * is parsed once per process.
 */
export function loadBaseEntity(authoringDir: string): BaseEntityDefinition | null {
  if (baseEntityCache.has(authoringDir)) {
    return baseEntityCache.get(authoringDir) ?? null;
  }
  const path = join(authoringDir, "entities", BASE_ENTITY_FILENAME);
  if (!existsSync(path)) {
    baseEntityCache.set(authoringDir, null);
    return null;
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as BaseEntityDefinition;
  if (parsed.kind !== "baseEntity") {
    throw new Error(
      `Expected ${path} to declare \`kind: baseEntity\`, found \`${parsed.kind}\``,
    );
  }
  if (!Array.isArray(parsed.fields) || parsed.fields.length === 0) {
    throw new Error(`BaseEntity at ${path} must declare at least one field`);
  }
  baseEntityCache.set(authoringDir, parsed);
  return parsed;
}

/**
 * Convert an entity name (PascalCase, e.g. `Assignment`, `BankReconciliation`)
 * to the camelCase id semantic type key (e.g. `assignmentId`,
 * `bankReconciliationId`).
 */
export function entityIdSemanticType(entityName: string): string {
  if (!entityName) return "id";
  const camel = entityName[0].toLowerCase() + entityName.slice(1);
  return `${camel}Id`;
}

/**
 * Merge BaseEntity fields into a coreEntity's `fields` array.
 *
 * Behavior:
 * - Base fields are prepended to `entity.fields` in declaration order.
 * - If the entity has `baseEntity: false`, no merging happens (full opt-out).
 * - If the entity already declares a field with a key matching a base field,
 *   throws a clear error (strict-replace policy).
 * - For the `id` field, auto-derives `semanticType` from the entity's name
 *   using `entityIdSemanticType`.
 *
 * Returns a new CoreEntity object; does not mutate the input.
 */
export function applyBaseEntityToCore(
  coreEntity: CoreEntity,
  base: BaseEntityDefinition | null,
  source: { kind: "core" | "contextFull"; path: string },
): CoreEntity {
  if (base === null) return coreEntity;
  if ((coreEntity as { baseEntity?: boolean }).baseEntity === false) {
    return coreEntity;
  }

  const entityFields = coreEntity.fields ?? [];
  const declaredKeys = new Set(entityFields.map((field) => field.key));
  const conflicts: string[] = [];
  for (const baseField of base.fields) {
    if (declaredKeys.has(baseField.key)) {
      conflicts.push(baseField.key);
    }
  }
  if (conflicts.length > 0) {
    const list = conflicts.map((key) => `\`${key}\``).join(", ");
    throw new Error(
      `${source.kind === "core" ? "Core entity" : "Context-full entity"} at ${source.path} ` +
        `declares field(s) ${list} that are provided by BaseEntity. ` +
        `Remove them from the entity YAML (strict-replace policy) or set ` +
        `\`baseEntity: false\` at the top level to opt out of base merging.`,
    );
  }

  const idSemanticType = entityIdSemanticType(coreEntity.entity);
  const baseFieldsWithSemantics = base.fields.map((baseField) => {
    if (baseField.key !== "id") return baseField;
    return { ...baseField, semanticType: idSemanticType };
  });

  return {
    ...coreEntity,
    fields: [...baseFieldsWithSemantics, ...entityFields],
  };
}

/**
 * Test-only helper to clear the loadBaseEntity cache between tests that swap
 * authoring directories. Production callers should not need this.
 */
export function clearBaseEntityCache(): void {
  baseEntityCache.clear();
}
