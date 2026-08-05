// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type {
  PlatformSchemaManifest,
  RetentionAction,
  RetentionDefinition,
  RetentionDisposition,
  RetentionDuration,
  RetentionErasure,
  RetentionLegalHold,
  RetentionReviewGate,
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

const onDeleteActions = new Set(["CASCADE", "RESTRICT", "SET NULL"]);

/**
 * `column.default` and `index.where` are the only two manifest fields that
 * reach raw SQL DDL as expressions rather than quoted literals/identifiers
 * (see generate.ts renderColumnSql / renderIndexSql). The base manifest and
 * the authoring compiler only ever emit a small, known set of safe forms
 * (`now()`, `gen_random_uuid()`, quoted literals, `IS NOT NULL` predicates).
 * Reject anything carrying a statement terminator or comment introducer so a
 * malformed value fails the build instead of silently injecting DDL/DML into
 * the generated schema.sql that later runs against a privileged role.
 */
function assertSqlExpression(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (/;|--|\/\*|\*\//.test(value)) {
    throw new Error(
      `${label} must not contain a statement terminator or comment; got ${JSON.stringify(value)}.`,
    );
  }
}

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

function loadRetentionReview(
  value: unknown,
  label: string,
): RetentionReviewGate | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (typeof value.required !== "boolean") {
    throw new Error(`${label}.required must be a boolean.`);
  }
  if (value.queue !== undefined && typeof value.queue !== "string") {
    throw new Error(`${label}.queue must be text.`);
  }
  return {
    required: value.required,
    ...(value.queue === undefined ? {} : { queue: value.queue }),
  };
}

function loadRetentionCryptoDelete(
  value: unknown,
  label: string,
): { keyReference?: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (value.keyReference !== undefined && typeof value.keyReference !== "string") {
    throw new Error(`${label}.keyReference must be text.`);
  }
  return value.keyReference === undefined ? {} : { keyReference: value.keyReference };
}

function loadRetentionLegalHold(
  value: unknown,
  label: string,
): RetentionLegalHold | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (typeof value.suspendDestruction !== "boolean") {
    throw new Error(`${label}.suspendDestruction must be a boolean.`);
  }
  return { suspendDestruction: value.suspendDestruction };
}

function loadRetentionErasure(
  value: unknown,
  label: string,
): RetentionErasure | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const erasure: RetentionErasure = {};
  if (value.subjectScoped !== undefined) {
    if (typeof value.subjectScoped !== "boolean") {
      throw new Error(`${label}.subjectScoped must be a boolean.`);
    }
    erasure.subjectScoped = value.subjectScoped;
  }
  if (value.subjectColumns !== undefined) {
    if (!Array.isArray(value.subjectColumns)) {
      throw new Error(`${label}.subjectColumns must be an array.`);
    }
    value.subjectColumns.forEach((column, index) =>
      assertIdentifier(column, `${label}.subjectColumns[${index}]`),
    );
    erasure.subjectColumns = value.subjectColumns as string[];
  }
  if (value.cascades !== undefined) {
    if (!Array.isArray(value.cascades)) {
      throw new Error(`${label}.cascades must be an array.`);
    }
    erasure.cascades = value.cascades.map((cascade, index) => {
      if (!isRecord(cascade)) {
        throw new Error(`${label}.cascades[${index}] must be an object.`);
      }
      assertIdentifier(cascade.schema, `${label}.cascades[${index}].schema`);
      assertIdentifier(cascade.table, `${label}.cascades[${index}].table`);
      assertIdentifier(cascade.via, `${label}.cascades[${index}].via`);
      return { schema: cascade.schema, table: cascade.table, via: cascade.via };
    });
  }
  return erasure;
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
  const clockType = columnsByName.get(value.clock.column);
  // A retention clock anchors on a point in time — either a system timestamp
  // (timestamptz) or a business date (date). Business-date anchors are common
  // for statutory retention keyed on e.g. a contract-end date (#97).
  if (clockType !== "timestamptz" && clockType !== "date") {
    throw new Error(`${label}.clock.column must reference a timestamptz or date column.`);
  }
  if (value.clock.type !== undefined && value.clock.type !== clockType) {
    throw new Error(
      `${label}.clock.type "${String(value.clock.type)}" does not match column ${value.clock.column} (${clockType}).`,
    );
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
    const fallbackType = columnsByName.get(column);
    if (fallbackType !== "timestamptz" && fallbackType !== "date") {
      throw new Error(
        `${label}.clock.fallbackColumns[${index}] must reference a timestamptz or date column.`,
      );
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
    const review = loadRetentionReview(rule.review, `${label}.rules[${index}].review`);
    const cryptoDelete = loadRetentionCryptoDelete(
      rule.cryptoDelete,
      `${label}.rules[${index}].cryptoDelete`,
    );
    if (rule.disposition !== undefined && typeof rule.disposition !== "string") {
      throw new Error(`${label}.rules[${index}].disposition must be text.`);
    }
    return {
      id: rule.id,
      after: loadRetentionDuration(rule.after, `${label}.rules[${index}].after`),
      action: rule.action as RetentionAction,
      ...(rule.disposition === undefined
        ? {}
        : { disposition: rule.disposition as RetentionDisposition }),
      ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      ...(review === undefined ? {} : { review }),
      ...(cryptoDelete === undefined ? {} : { cryptoDelete }),
    };
  });

  if (value.source !== undefined && typeof value.source !== "string") {
    throw new Error(`${label}.source must be text.`);
  }

  const legalHold = loadRetentionLegalHold(value.legalHold, `${label}.legalHold`);
  const erasure = loadRetentionErasure(value.erasure, `${label}.erasure`);

  return {
    clock: {
      column: value.clock.column,
      type: clockType as "timestamptz" | "date",
      ...(fallbackColumns.length === 0 ? {} : { fallbackColumns }),
    },
    rules,
    ...(legalHold === undefined ? {} : { legalHold }),
    ...(erasure === undefined ? {} : { erasure }),
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
      if (column.default !== undefined) {
        assertSqlExpression(column.default, `${currentTableKey}.${column.name}.default`);
      }
      if (column.references !== undefined) {
        if (!isRecord(column.references)) {
          throw new Error(`${currentTableKey}.${column.name}.references must be an object.`);
        }
        assertIdentifier(column.references.schema, `${currentTableKey}.${column.name}.references.schema`);
        assertIdentifier(column.references.table, `${currentTableKey}.${column.name}.references.table`);
        assertIdentifier(column.references.column, `${currentTableKey}.${column.name}.references.column`);
        if (
          column.references.onDelete !== undefined &&
          (typeof column.references.onDelete !== "string" ||
            !onDeleteActions.has(column.references.onDelete))
        ) {
          throw new Error(
            `${currentTableKey}.${column.name}.references.onDelete must be one of CASCADE, RESTRICT, SET NULL.`,
          );
        }
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
        if (index.where !== undefined) {
          assertSqlExpression(index.where, `${currentTableKey}.indexes[${indexIndex}].where`);
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

    // workerAccess names the worker role permitted to read this table ACROSS
    // tenants. Rejected on a global table for the same reason rowScope is:
    // there is no tenant predicate to widen, so the declaration would read as a
    // grant while granting nothing. The emitter repeats both checks, because a
    // plugin's contributePlatformTables never passes through this loader.
    if (table.workerAccess !== undefined) {
      if (typeof table.workerAccess !== "string" || table.workerAccess.trim().length === 0) {
        throw new Error(`${currentTableKey}.workerAccess must be a non-empty string.`);
      }
      if (!table.tenantScoped) {
        throw new Error(
          `${currentTableKey}.workerAccess requires tenantScoped: true.`,
        );
      }
    }

    // workerDml says a worker needs DML on this table inside a tenant-scoped
    // session. It widens no policy, so it is legal on a global table — a
    // worker's node catalog is one, and a grant is the only gate a global table
    // has. A boolean, not a role name: the grant is made to the one worker
    // LOGIN role, and `workerAccess` is where a worker is named.
    if (table.workerDml !== undefined && typeof table.workerDml !== "boolean") {
      throw new Error(`${currentTableKey}.workerDml must be a boolean.`);
    }

    // tenantIdentityColumn names the uuid column that IS a tenant id on a
    // GLOBAL table registering tenants. Rejected on a tenant-scoped table
    // because the tenant predicate already exists there, and two answers to
    // "which tenant owns this row" is one too many. The emitter repeats both
    // checks for the same reason workerAccess does: a plugin's
    // contributePlatformTables never passes through this loader.
    if (table.tenantIdentityColumn !== undefined) {
      assertIdentifier(
        table.tenantIdentityColumn,
        `${currentTableKey}.tenantIdentityColumn`,
      );
      if (table.tenantScoped) {
        throw new Error(
          `${currentTableKey}.tenantIdentityColumn requires tenantScoped: false.`,
        );
      }
      const identityType = columnsByName.get(table.tenantIdentityColumn);
      if (identityType === undefined) {
        throw new Error(
          `${currentTableKey}.tenantIdentityColumn references unknown column ${table.tenantIdentityColumn}.`,
        );
      }
      if (identityType !== "uuid") {
        throw new Error(
          `${currentTableKey}.tenantIdentityColumn "${table.tenantIdentityColumn}" must be uuid; app.current_tenant() returns uuid.`,
        );
      }
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
