import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type {
  PlatformSchemaManifest,
  RetentionAction,
  RetentionDefinition,
  RetentionDuration,
  RelationshipRegisterEntry,
  RowScopePolicy,
  ScalarType,
} from "./schema.js";

const scalarTypes = new Set<ScalarType>([
  "uuid",
  "text",
  "boolean",
  "integer",
  "bigint",
  "numeric",
  "date",
  "timestamptz",
  "jsonb",
]);

const retentionActions = new Set<RetentionAction>([
  "retain",
  "archive",
  "redact",
  "delete",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a lower_snake_case identifier.`);
  }
}

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function columnKey(schema: string, table: string, column: string) {
  return `${tableKey(schema, table)}.${column}`;
}

function referenceKey(input: {
  from: { schema: string; table: string; column: string };
  to: { schema: string; table: string; column: string };
}) {
  return `${columnKey(input.from.schema, input.from.table, input.from.column)}->${columnKey(
    input.to.schema,
    input.to.table,
    input.to.column,
  )}`;
}

function loadRelationshipRegister(value: unknown): RelationshipRegisterEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("relationshipRegister must be an array.");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.from) || !isRecord(entry.to)) {
      throw new Error(`relationshipRegister[${index}] must declare from and to objects.`);
    }
    assertIdentifier(entry.from.schema, `relationshipRegister[${index}].from.schema`);
    assertIdentifier(entry.from.table, `relationshipRegister[${index}].from.table`);
    assertIdentifier(entry.from.column, `relationshipRegister[${index}].from.column`);
    assertIdentifier(entry.to.schema, `relationshipRegister[${index}].to.schema`);
    assertIdentifier(entry.to.table, `relationshipRegister[${index}].to.table`);
    assertIdentifier(entry.to.column, `relationshipRegister[${index}].to.column`);
    return {
      from: entry.from,
      to: entry.to,
    } as RelationshipRegisterEntry;
  });
}

function loadRetentionDuration(value: unknown, label: string): RetentionDuration {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const duration: RetentionDuration = {};
  for (const key of ["years", "months", "days"] as const) {
    if (value[key] === undefined) {
      continue;
    }
    if (!Number.isInteger(value[key]) || Number(value[key]) <= 0) {
      throw new Error(`${label}.${key} must be a positive integer.`);
    }
    duration[key] = value[key] as number;
  }

  if (duration.years === undefined && duration.months === undefined && duration.days === undefined) {
    throw new Error(`${label} must include years, months, or days.`);
  }

  return duration;
}

function loadRetention(
  value: unknown,
  label: string,
  columnsByName: Map<string, ScalarType>,
): RetentionDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (!isRecord(value.clock)) {
    throw new Error(`${label}.clock must be an object.`);
  }
  assertIdentifier(value.clock.column, `${label}.clock.column`);
  if (!columnsByName.has(value.clock.column)) {
    throw new Error(`${label}.clock.column references unknown column ${value.clock.column}.`);
  }
  if (columnsByName.get(value.clock.column) !== "timestamptz") {
    throw new Error(`${label}.clock.column must reference a timestamptz column.`);
  }

  const fallbackColumns =
    value.clock.fallbackColumns === undefined ? [] : value.clock.fallbackColumns;
  if (!Array.isArray(fallbackColumns)) {
    throw new Error(`${label}.clock.fallbackColumns must be an array.`);
  }
  for (const [index, column] of fallbackColumns.entries()) {
    assertIdentifier(column, `${label}.clock.fallbackColumns[${index}]`);
    if (!columnsByName.has(column)) {
      throw new Error(`${label}.clock.fallbackColumns[${index}] references unknown column ${column}.`);
    }
    if (columnsByName.get(column) !== "timestamptz") {
      throw new Error(`${label}.clock.fallbackColumns[${index}] must reference a timestamptz column.`);
    }
  }

  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    throw new Error(`${label}.rules must be a non-empty array.`);
  }
  const ruleIds = new Set<string>();
  const rules = value.rules.map((rule, index) => {
    if (!isRecord(rule)) {
      throw new Error(`${label}.rules[${index}] must be an object.`);
    }
    assertIdentifier(rule.id, `${label}.rules[${index}].id`);
    if (ruleIds.has(rule.id)) {
      throw new Error(`Duplicate retention rule ${label}.${rule.id}.`);
    }
    ruleIds.add(rule.id);
    if (typeof rule.action !== "string" || !retentionActions.has(rule.action as RetentionAction)) {
      throw new Error(
        `${label}.rules[${index}].action must be retain, archive, redact, or delete.`,
      );
    }
    if (rule.reason !== undefined && typeof rule.reason !== "string") {
      throw new Error(`${label}.rules[${index}].reason must be text.`);
    }
    return {
      id: rule.id,
      after: loadRetentionDuration(rule.after, `${label}.rules[${index}].after`),
      action: rule.action as RetentionAction,
      ...(rule.reason === undefined ? {} : { reason: rule.reason }),
    };
  });

  if (value.source !== undefined && typeof value.source !== "string") {
    throw new Error(`${label}.source must be text.`);
  }

  return {
    clock: {
      column: value.clock.column,
      ...(fallbackColumns.length === 0 ? {} : { fallbackColumns }),
    },
    rules,
    ...(value.source === undefined ? {} : { source: value.source }),
  };
}

const groupExpansionModes = new Set(["descendants", "ancestors", "exact"]);

function loadRowScope(
  value: unknown,
  label: string,
  columnNames: Set<string>,
): RowScopePolicy {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const policy: RowScopePolicy = {};

  if (value.group !== undefined) {
    if (!isRecord(value.group)) {
      throw new Error(`${label}.group must be an object.`);
    }
    assertIdentifier(value.group.column, `${label}.group.column`);
    if (!columnNames.has(value.group.column)) {
      throw new Error(
        `${label}.group.column references unknown column ${value.group.column}.`,
      );
    }
    const expand = value.group.expand;
    if (expand !== undefined && (typeof expand !== "string" || !groupExpansionModes.has(expand))) {
      throw new Error(
        `${label}.group.expand must be one of descendants, ancestors, exact.`,
      );
    }
    policy.group = {
      column: value.group.column,
      ...(expand === undefined ? {} : { expand: expand as "descendants" | "ancestors" | "exact" }),
    };
  }

  if (value.userColumns !== undefined) {
    if (!Array.isArray(value.userColumns) || value.userColumns.length === 0) {
      throw new Error(`${label}.userColumns must be a non-empty array.`);
    }
    for (const [index, column] of value.userColumns.entries()) {
      assertIdentifier(column, `${label}.userColumns[${index}]`);
      if (!columnNames.has(column)) {
        throw new Error(
          `${label}.userColumns[${index}] references unknown column ${column}.`,
        );
      }
    }
    policy.userColumns = [...value.userColumns];
  }

  if (value.bypassRoles !== undefined) {
    if (!Array.isArray(value.bypassRoles)) {
      throw new Error(`${label}.bypassRoles must be an array.`);
    }
    for (const [index, role] of value.bypassRoles.entries()) {
      if (typeof role !== "string" || role.trim().length === 0) {
        throw new Error(`${label}.bypassRoles[${index}] must be a non-empty string.`);
      }
    }
    policy.bypassRoles = [...value.bypassRoles];
  }

  if (!policy.group && !policy.userColumns) {
    throw new Error(
      `${label} must declare at least one of group or userColumns; declaring rowScope without any axis is meaningless.`,
    );
  }

  return policy;
}

export async function loadManifest(path: string): Promise<PlatformSchemaManifest> {
  const raw = await readFile(path, "utf8");
  const parsed = YAML.parse(raw) as unknown;

  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tables)) {
    throw new Error("Compiler manifest must declare version: 1 and a tables array.");
  }

  const relationshipRegister = loadRelationshipRegister(parsed.relationshipRegister);
  const relationshipRegisterKeys = new Set(relationshipRegister.map(referenceKey));
  const tableKeys = new Set<string>();
  const tableColumns = new Map<string, Set<string>>();
  for (const [tableIndex, table] of parsed.tables.entries()) {
    if (!isRecord(table)) {
      throw new Error(`tables[${tableIndex}] must be an object.`);
    }
    assertIdentifier(table.schema, `tables[${tableIndex}].schema`);
    assertIdentifier(table.name, `tables[${tableIndex}].name`);
    const currentTableKey = tableKey(table.schema, table.name);
    if (typeof table.tenantScoped !== "boolean") {
      throw new Error(`tables[${tableIndex}].tenantScoped must be boolean.`);
    }
    if (
      table.domainInternal !== undefined &&
      typeof table.domainInternal !== "boolean"
    ) {
      throw new Error(`tables[${tableIndex}].domainInternal must be boolean.`);
    }
    if (
      table.generatedCrud !== undefined &&
      typeof table.generatedCrud !== "boolean"
    ) {
      throw new Error(`tables[${tableIndex}].generatedCrud must be boolean.`);
    }
    if (table.domainInternal === true && table.generatedCrud === true) {
      throw new Error(
        `Domain-internal table ${currentTableKey} cannot enable generatedCrud.`,
      );
    }
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      throw new Error(`tables[${tableIndex}].columns must be a non-empty array.`);
    }

    if (tableKeys.has(currentTableKey)) {
      throw new Error(`Duplicate table ${currentTableKey}.`);
    }
    tableKeys.add(currentTableKey);

    const columnNames = new Set<string>();
    const columnsByName = new Map<string, ScalarType>();
    let hasTenantId = !table.tenantScoped;
    let primaryKeys = 0;
    for (const [columnIndex, column] of table.columns.entries()) {
      if (!isRecord(column)) {
          throw new Error(`${currentTableKey}.columns[${columnIndex}] must be an object.`);
      }
      assertIdentifier(column.name, `${currentTableKey}.columns[${columnIndex}].name`);
      if (columnNames.has(column.name)) {
        throw new Error(`Duplicate column ${currentTableKey}.${column.name}.`);
      }
      columnNames.add(column.name);
      if (column.name === "tenant_id") {
        hasTenantId = true;
      }
      if (typeof column.type !== "string" || !scalarTypes.has(column.type as ScalarType)) {
        throw new Error(`${currentTableKey}.${column.name} has unsupported type.`);
      }
      columnsByName.set(column.name, column.type as ScalarType);
      if (column.primaryKey === true) {
        primaryKeys += 1;
      }
      if (column.generated !== undefined && column.generated !== "identity") {
        throw new Error(`${currentTableKey}.${column.name} has unsupported generated mode.`);
      }
      if (column.references !== undefined) {
        if (!isRecord(column.references)) {
          throw new Error(`${currentTableKey}.${column.name}.references must be an object.`);
        }
        assertIdentifier(column.references.schema, `${currentTableKey}.${column.name}.references.schema`);
        assertIdentifier(column.references.table, `${currentTableKey}.${column.name}.references.table`);
        assertIdentifier(column.references.column, `${currentTableKey}.${column.name}.references.column`);
      }
    }
    tableColumns.set(currentTableKey, columnNames);
    if (!hasTenantId) {
      throw new Error(`Tenant-scoped table ${currentTableKey} must include tenant_id.`);
    }
    if (primaryKeys === 0) {
      throw new Error(`Table ${currentTableKey} must declare a primary key.`);
    }
    if (table.indexes !== undefined) {
      if (!Array.isArray(table.indexes)) {
        throw new Error(`${currentTableKey}.indexes must be an array.`);
      }
      const indexNames = new Set<string>();
      for (const [indexIndex, index] of table.indexes.entries()) {
        if (!isRecord(index)) {
          throw new Error(`${currentTableKey}.indexes[${indexIndex}] must be an object.`);
        }
        assertIdentifier(index.name, `${currentTableKey}.indexes[${indexIndex}].name`);
        if (indexNames.has(index.name)) {
          throw new Error(`Duplicate index ${currentTableKey}.${index.name}.`);
        }
        indexNames.add(index.name);
        if (!Array.isArray(index.columns) || index.columns.length === 0) {
          throw new Error(`${currentTableKey}.indexes[${indexIndex}].columns must be a non-empty array.`);
        }
        for (const [indexColumnIndex, column] of index.columns.entries()) {
          assertIdentifier(
            column,
            `${currentTableKey}.indexes[${indexIndex}].columns[${indexColumnIndex}]`,
          );
          if (!columnNames.has(column)) {
            throw new Error(`${currentTableKey}.indexes[${indexIndex}] references unknown column ${column}.`);
          }
        }
        if (index.unique !== undefined && typeof index.unique !== "boolean") {
          throw new Error(
            `${currentTableKey}.indexes[${indexIndex}].unique must be a boolean.`,
          );
        }
      }
    }
    table.retention = loadRetention(
      table.retention,
      `${currentTableKey}.retention`,
      columnsByName,
    );

    if (table.rowScope !== undefined) {
      if (!table.tenantScoped) {
        throw new Error(
          `${currentTableKey}.rowScope requires tenantScoped: true.`,
        );
      }
      table.rowScope = loadRowScope(
        table.rowScope,
        `${currentTableKey}.rowScope`,
        columnNames,
      );
    }
  }

  for (const [index, entry] of relationshipRegister.entries()) {
    const fromTableKey = tableKey(entry.from.schema, entry.from.table);
    const toTableKey = tableKey(entry.to.schema, entry.to.table);
    const fromColumns = tableColumns.get(fromTableKey);
    const toColumns = tableColumns.get(toTableKey);
    if (!fromColumns?.has(entry.from.column)) {
      throw new Error(
        `relationshipRegister[${index}].from references unknown column ${columnKey(
          entry.from.schema,
          entry.from.table,
          entry.from.column,
        )}.`,
      );
    }
    if (!toColumns?.has(entry.to.column)) {
      throw new Error(
        `relationshipRegister[${index}].to references unknown column ${columnKey(
          entry.to.schema,
          entry.to.table,
          entry.to.column,
        )}.`,
      );
    }
  }

  for (const table of parsed.tables) {
    if (!isRecord(table)) {
      continue;
    }
    assertIdentifier(table.schema, "table.schema");
    assertIdentifier(table.name, "table.name");
    if (!Array.isArray(table.columns)) {
      continue;
    }
    const sourceTableKey = tableKey(table.schema, table.name);
    for (const column of table.columns) {
      if (!isRecord(column) || !isRecord(column.references)) {
        continue;
      }
      assertIdentifier(column.name, `${sourceTableKey}.column.name`);
      assertIdentifier(column.references.schema, `${sourceTableKey}.${column.name}.references.schema`);
      assertIdentifier(column.references.table, `${sourceTableKey}.${column.name}.references.table`);
      assertIdentifier(column.references.column, `${sourceTableKey}.${column.name}.references.column`);

      const targetTableKey = tableKey(column.references.schema, column.references.table);
      const targetColumns = tableColumns.get(targetTableKey);
      if (!targetColumns) {
        throw new Error(`${sourceTableKey}.${column.name} references unknown table ${targetTableKey}.`);
      }
      if (!targetColumns.has(column.references.column)) {
        throw new Error(
          `${sourceTableKey}.${column.name} references unknown column ${targetTableKey}.${column.references.column}.`,
        );
      }

      if (table.schema !== column.references.schema) {
        const key = referenceKey({
          from: {
            schema: table.schema,
            table: table.name,
            column: column.name,
          },
          to: {
            schema: column.references.schema,
            table: column.references.table,
            column: column.references.column,
          },
        });
        if (!relationshipRegisterKeys.has(key)) {
          throw new Error(
            `${sourceTableKey}.${column.name} crosses module boundary to ${targetTableKey}.${column.references.column} but is not listed in relationshipRegister.`,
          );
        }
      }
    }
  }

  return {
    ...(parsed as PlatformSchemaManifest),
    relationshipRegister,
  };
}
