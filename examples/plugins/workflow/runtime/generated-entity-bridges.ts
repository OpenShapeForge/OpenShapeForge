// SPDX-License-Identifier: BUSL-1.1
import manifest from "../../../../apps/api/src/generated/db/manifest.json" with { type: "json" };
import generatedEntityWorkflowNodes from "../../../../apps/api/src/generated/workflow/entity-workflow-nodes.generated.json" with { type: "json" };
import { sql, type RawBuilder } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import { registerWorkflowNodeBridge } from "./node-bridge.js";
import type {
  WorkflowNodeBridgeContext,
  WorkflowNodeBridgeOutput,
} from "./node-bridge.js";

type GeneratedWorkflowEntityAction =
  | "create"
  | "getOne"
  | "list"
  | "update"
  | "delete"
  | "wait"
  | "awaitAction";

type GeneratedEntityWorkflowNodeDefinition = {
  type: `entity.${string}`;
  module: string;
  entity: string;
  entityKey: string;
  action: GeneratedWorkflowEntityAction;
};

type GeneratedCrudColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  generated: string | null;
  sourceField?: string;
};

type GeneratedGraphqlRelationship = {
  name: string;
  target: string;
  type: string;
  resolve: string;
  foreignKey?: string;
};

type GeneratedCrudTable = {
  name: string;
  schema: string;
  table: string;
  tenantScoped: boolean;
  domainInternal: boolean;
  generatedCrud: boolean;
  primaryKey: string | null;
  columns: GeneratedCrudColumn[];
  source?: {
    authoringEntitySlug?: string;
    graphql?: {
      typeName: string;
      defaultSort?: { field: string; direction: "asc" | "desc" };
      relationships?: GeneratedGraphqlRelationship[];
    };
  };
};

type ConditionInput = Record<string, unknown>;

const generatedCrudTables = (manifest.tables as GeneratedCrudTable[]).filter(
  (table) => table.generatedCrud && !table.domainInternal && table.primaryKey,
);

const schemaByWorkflowModule: Record<string, string> = {
  core: "erp",
  vera: "vera",
};

function fieldNameForColumn(column: GeneratedCrudColumn) {
  return column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function outputRow(table: GeneratedCrudTable, row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const column of table.columns) {
    const fieldName = fieldNameForColumn(column);
    if (Object.hasOwn(row, column.name)) {
      result[fieldName] = row[column.name];
    }
  }
  if (table.schema === "erp" && table.table === "agreement_parties") {
    if (Object.hasOwn(row, "address_label")) {
      result.addressLabel = row.address_label;
    }
    if (Object.hasOwn(row, "address_id")) {
      result.addressId = row.address_id;
    }
  }
  return result;
}

function findTable(entry: GeneratedEntityWorkflowNodeDefinition) {
  const expectedSchema = schemaByWorkflowModule[entry.module];
  return generatedCrudTables.find(
    (table) =>
      table.source?.graphql?.typeName === entry.entity &&
      table.source?.authoringEntitySlug === entry.entityKey &&
      (!expectedSchema || table.schema === expectedSchema),
  ) ?? null;
}

function findTableByGraphqlType(typeName: string) {
  return generatedCrudTables.find(
    (table) => table.source?.graphql?.typeName === typeName,
  ) ?? null;
}

function fieldColumnMap(table: GeneratedCrudTable) {
  return new Map(table.columns.map((column) => [fieldNameForColumn(column), column]));
}

function writableColumnMap(table: GeneratedCrudTable) {
  return new Map(
    table.columns
      .filter((column) =>
        !column.primaryKey &&
        column.generated !== "identity" &&
        column.name !== "tenant_id" &&
        column.name !== "created_at" &&
        column.name !== "updated_at",
      )
      .map((column) => [fieldNameForColumn(column), column]),
  );
}

function normalizeLimit(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 25;
  return Math.max(1, Math.min(Math.trunc(numeric), 200));
}

function normalizeSortDirection(value: unknown): "asc" | "desc" {
  return typeof value === "string" && value.toLowerCase() === "desc" ? "desc" : "asc";
}

function normalizeRecordId(value: unknown, fieldName = "recordId") {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`Generated entity workflow node is missing ${fieldName}.`);
}

function normalizeValues(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}


function sqlValueForColumn(
  column: GeneratedCrudColumn,
  value: unknown,
): RawBuilder<unknown> {
  if (value === null || value === undefined) {
    return sql`${value}`;
  }
  if (column.type === "uuid") {
    return sql`cast(${String(value)} as uuid)`;
  }
  if (["integer", "int", "int4", "smallint", "int2", "bigint", "int8"].includes(column.type)) {
    return sql`cast(${String(value)} as ${sql.raw(column.type)})`;
  }
  if (["numeric", "decimal", "real", "float4", "double precision", "float8"].includes(column.type)) {
    return sql`cast(${String(value)} as ${sql.raw(column.type)})`;
  }
  if (column.type === "boolean" || column.type === "bool") {
    return sql`cast(${String(value)} as boolean)`;
  }
  if (column.type === "date") {
    return sql`cast(${String(value)} as date)`;
  }
  if (column.type === "timestamptz" || column.type === "timestamp") {
    return sql`cast(${String(value)} as timestamptz)`;
  }
  if (column.type === "jsonb") {
    return jsonbLiteral(value);
  }
  if (
    column.type === "text" ||
    column.type === "varchar" ||
    column.type === "character varying" ||
    column.type === "citext"
  ) {
    return sql`${String(value)}`;
  }
  return sql`${value}`;
}

function readRightOperandValue(operand: unknown) {
  if (
    operand &&
    typeof operand === "object" &&
    !Array.isArray(operand) &&
    (operand as { kind?: unknown }).kind === "literal"
  ) {
    return (operand as { value?: unknown }).value;
  }
  if (
    operand &&
    typeof operand === "object" &&
    !Array.isArray(operand) &&
    (operand as { kind?: unknown }).kind === "path" &&
    Object.hasOwn(operand, "value")
  ) {
    return (operand as { value?: unknown }).value;
  }
  throw new Error("Generated entity list filters only support literal or resolved path right-hand operands.");
}

function readPath(operand: unknown) {
  if (
    operand &&
    typeof operand === "object" &&
    !Array.isArray(operand) &&
    (operand as { kind?: unknown }).kind === "path" &&
    typeof (operand as { path?: unknown }).path === "string"
  ) {
    const path = (operand as { path: string }).path.trim();
    return path.startsWith("entityData.") ? path.slice("entityData.".length) : path;
  }
  throw new Error("Generated entity list filters only support field-path left-hand operands.");
}

function readPathFilter(operand: unknown) {
  if (
    operand &&
    typeof operand === "object" &&
    !Array.isArray(operand) &&
    (operand as { kind?: unknown }).kind === "path" &&
    (operand as { filter?: unknown }).filter &&
    typeof (operand as { filter?: unknown }).filter === "object" &&
    !Array.isArray((operand as { filter?: unknown }).filter)
  ) {
    return (operand as { filter: Record<string, unknown> }).filter;
  }
  return undefined;
}

function conditionChildren(condition: ConditionInput) {
  const candidates = condition.conditions ?? condition.all ?? condition.any;
  return Array.isArray(candidates) ? candidates : [];
}

function compileColumnComparison(
  column: GeneratedCrudColumn,
  ref: RawBuilder<unknown>,
  record: ConditionInput,
): RawBuilder<unknown> {
  const rightValue = () => readRightOperandValue(record.right);
  const rightSql = () => sqlValueForColumn(column, rightValue());

  switch (record.operator) {
    case "equals":
      return sql`${ref} = ${rightSql()}`;
    case "notEquals":
      return sql`${ref} <> ${rightSql()}`;
    case "greaterThan":
      return sql`${ref} > ${rightSql()}`;
    case "greaterThanOrEquals":
      return sql`${ref} >= ${rightSql()}`;
    case "lessThan":
      return sql`${ref} < ${rightSql()}`;
    case "lessThanOrEquals":
      return sql`${ref} <= ${rightSql()}`;
    case "contains":
      return sql`${ref} ilike ${`%${String(rightValue() ?? "")}%`}`;
    case "notContains":
      return sql`${ref} not ilike ${`%${String(rightValue() ?? "")}%`}`;
    case "startsWith":
      return sql`${ref} ilike ${`${String(rightValue() ?? "")}%`}`;
    case "endsWith":
      return sql`${ref} ilike ${`%${String(rightValue() ?? "")}`}`;
    case "in": {
      const value = rightValue();
      const values = Array.isArray(value) ? value : [value];
      return values.length === 0
        ? sql`false`
        : sql`${ref} in (${sql.join(values.map((entry) => sqlValueForColumn(column, entry)))})`;
    }
    case "notIn": {
      const value = rightValue();
      const values = Array.isArray(value) ? value : [value];
      return values.length === 0
        ? sql`true`
        : sql`${ref} not in (${sql.join(values.map((entry) => sqlValueForColumn(column, entry)))})`;
    }
    case "isEmpty":
      return column.type === "text"
        ? sql`(${ref} is null or ${ref} = '')`
        : sql`${ref} is null`;
    case "isNotEmpty":
      return column.type === "text"
        ? sql`(${ref} is not null and ${ref} <> '')`
        : sql`${ref} is not null`;
    default:
      throw new Error(`Generated entity list filter uses unsupported operator "${String(record.operator)}".`);
  }
}

function hasColumn(table: GeneratedCrudTable, columnName: string) {
  return table.columns.some((column) => column.name === columnName);
}

function tenantCorrelation(
  sourceTable: GeneratedCrudTable,
  targetTable: GeneratedCrudTable,
  targetAlias: string,
) {
  return sourceTable.tenantScoped && targetTable.tenantScoped && hasColumn(sourceTable, "tenant_id") && hasColumn(targetTable, "tenant_id")
    ? sql`and ${sql.id(targetAlias, "tenant_id")} = ${sql.id("row_source", "tenant_id")}`
    : sql``;
}

function aggregateFilterCondition(
  targetTable: GeneratedCrudTable,
  targetAlias: string,
  filter: Record<string, unknown> | undefined,
) {
  if (!filter) return sql`true`;

  const fields = fieldColumnMap(targetTable);
  const parts = Object.entries(filter).flatMap(([field, value]) => {
    if (value === null || value === undefined || value === "") return [];
    const column = fields.get(field);
    if (!column) {
      throw new Error(`Generated entity list aggregate filter uses unknown field "${field}".`);
    }
    const ref = sql.id(targetAlias, column.name);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const op = value as Record<string, unknown>;
      if (Object.hasOwn(op, "equals")) {
        return [sql`${ref} = ${sqlValueForColumn(column, op.equals)}`];
      }
      if (Object.hasOwn(op, "notEquals")) {
        return [sql`${ref} <> ${sqlValueForColumn(column, op.notEquals)}`];
      }
      if (Object.hasOwn(op, "in")) {
        const values = Array.isArray(op.in) ? op.in : [op.in];
        return [
          values.length === 0
            ? sql`false`
            : sql`${ref} in (${sql.join(values.map((entry) => sqlValueForColumn(column, entry)))})`,
        ];
      }
    }
    return [sql`${ref} = ${sqlValueForColumn(column, value)}`];
  });

  return parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;
}

function compileBelongsToCondition(
  sourceTable: GeneratedCrudTable,
  relationship: GeneratedGraphqlRelationship,
  targetField: string,
  record: ConditionInput,
) {
  if (!relationship.foreignKey) {
    throw new Error(`Generated entity list filter relationship "${relationship.name}" has no foreign key.`);
  }
  const targetTable = findTableByGraphqlType(relationship.target);
  if (!targetTable?.primaryKey) {
    throw new Error(`Generated entity list filter relationship "${relationship.name}" target is not generated CRUD.`);
  }
  if (!hasColumn(sourceTable, relationship.foreignKey)) {
    throw new Error(`Generated entity list filter relationship "${relationship.name}" uses missing foreign key "${relationship.foreignKey}".`);
  }
  const targetColumn = fieldColumnMap(targetTable).get(targetField);
  if (!targetColumn) {
    throw new Error(`Generated entity list filter relationship "${relationship.name}" uses unknown target field "${targetField}".`);
  }

  const alias = `rel_${relationship.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const comparison = compileColumnComparison(targetColumn, sql.id(alias, targetColumn.name), record);
  return sql`exists (
    select 1
    from ${sql.id(targetTable.schema, targetTable.table)} as ${sql.id(alias)}
    where ${sql.id(alias, targetTable.primaryKey)} = ${sql.id("row_source", relationship.foreignKey)}
      ${tenantCorrelation(sourceTable, targetTable, alias)}
      and ${comparison}
  )`;
}

function compileAggregateCountCondition(
  sourceTable: GeneratedCrudTable,
  relationship: GeneratedGraphqlRelationship,
  record: ConditionInput,
) {
  if (!sourceTable.primaryKey) {
    throw new Error(`Generated entity list filter aggregate "${relationship.name}" has no source primary key.`);
  }
  if (!relationship.foreignKey) {
    throw new Error(`Generated entity list filter aggregate "${relationship.name}" has no foreign key.`);
  }
  const targetTable = findTableByGraphqlType(relationship.target);
  if (!targetTable) {
    throw new Error(`Generated entity list filter aggregate "${relationship.name}" target is not generated CRUD.`);
  }
  if (!hasColumn(targetTable, relationship.foreignKey)) {
    throw new Error(`Generated entity list filter aggregate "${relationship.name}" uses missing foreign key "${relationship.foreignKey}".`);
  }

  const alias = `agg_${relationship.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const operandFilter = readPathFilter(record.left);
  const countExpression = sql`(
    select count(*)
    from ${sql.id(targetTable.schema, targetTable.table)} as ${sql.id(alias)}
    where ${sql.id(alias, relationship.foreignKey)} = ${sql.id("row_source", sourceTable.primaryKey)}
      ${tenantCorrelation(sourceTable, targetTable, alias)}
      and ${aggregateFilterCondition(targetTable, alias, operandFilter)}
  )`;
  const countColumn: GeneratedCrudColumn = {
    name: "count",
    type: "integer",
    primaryKey: false,
    generated: null,
  };
  return compileColumnComparison(countColumn, countExpression, record);
}

function compileRelationshipCondition(
  table: GeneratedCrudTable,
  path: string,
  record: ConditionInput,
): RawBuilder<unknown> | null {
  const [root, child, ...rest] = path.split(".");
  if (!root || !child || rest.length > 0) return null;

  const relationships = table.source?.graphql?.relationships ?? [];
  const aggregateSuffix = "Aggregate";
  if (root.endsWith(aggregateSuffix) && child === "count") {
    const relationshipName = root.slice(0, -aggregateSuffix.length);
    const relationship = relationships.find((candidate) => candidate.name === relationshipName);
    if (!relationship || relationship.resolve === "belongsTo") return null;
    return compileAggregateCountCondition(table, relationship, record);
  }

  const relationship = relationships.find((candidate) => candidate.name === root);
  if (!relationship || relationship.resolve !== "belongsTo") return null;
  return compileBelongsToCondition(table, relationship, child, record);
}

function compileCondition(
  table: GeneratedCrudTable,
  condition: unknown,
): RawBuilder<unknown> {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return sql`true`;
  }

  const record = condition as ConditionInput;
  const isRule = record.kind === "rule" || ("operator" in record && "left" in record);
  if (!isRule) {
    const children = conditionChildren(record);
    if (children.length === 0) return sql`true`;
    const parts = children.map((child) => compileCondition(table, child));
    const joiner = record.mode === "any" || Array.isArray(record.any)
      ? sql` or `
      : sql` and `;
    return sql`(${sql.join(parts, joiner)})`;
  }

  const path = readPath(record.left);
  const column = fieldColumnMap(table).get(path);
  if (column) {
    return compileColumnComparison(column, sql.id("row_source", column.name), record);
  }

  const relationshipCondition = compileRelationshipCondition(table, path, record);
  if (relationshipCondition) {
    return relationshipCondition;
  }

  throw new Error(`Generated entity list filter uses unknown field "${path}".`);
}

function compileSimpleFilter(
  table: GeneratedCrudTable,
  filter: unknown,
): RawBuilder<unknown> {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    return sql`true`;
  }

  const fields = fieldColumnMap(table);
  const parts = Object.entries(filter as Record<string, unknown>).flatMap(([field, value]) => {
    const column = fields.get(field);
    if (!column) {
      throw new Error(`Generated entity list filter uses unknown field "${field}".`);
    }
    const ref = sql.id("row_source", column.name);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const op = value as Record<string, unknown>;
      if (Object.hasOwn(op, "equals")) {
        return [sql`${ref} = ${sqlValueForColumn(column, op.equals)}`];
      }
      if (Object.hasOwn(op, "notEquals")) {
        return [sql`${ref} <> ${sqlValueForColumn(column, op.notEquals)}`];
      }
      if (Object.hasOwn(op, "in")) {
        const values = Array.isArray(op.in) ? op.in : [op.in];
        return [
          values.length === 0
            ? sql`false`
            : sql`${ref} in (${sql.join(values.map((entry) => sqlValueForColumn(column, entry)))})`,
        ];
      }
    }
    if (value === null || value === undefined || value === "") {
      return [];
    }
    return [sql`${ref} = ${sqlValueForColumn(column, value)}`];
  });

  return parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;
}

function compileListFilter(
  table: GeneratedCrudTable,
  config: Record<string, unknown>,
): RawBuilder<unknown> {
  return config.filterCondition !== undefined
    ? compileCondition(table, config.filterCondition)
    : compileSimpleFilter(table, config.filter);
}

function sortExpression(table: GeneratedCrudTable, value: unknown) {
  const config = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const defaultSort = table.source?.graphql?.defaultSort;
  const requestedField = typeof config.field === "string" && config.field.trim()
    ? config.field.trim()
    : defaultSort?.field;
  const column = requestedField
    ? fieldColumnMap(table).get(requestedField)
    : table.columns.find((item) => item.name === table.primaryKey);
  if (!column) {
    throw new Error(`Generated entity list sort uses unknown field "${requestedField ?? ""}".`);
  }
  const direction = normalizeSortDirection(config.direction ?? defaultSort?.direction);
  return direction === "desc"
    ? sql`${sql.id("row_source", column.name)} desc`
    : sql`${sql.id("row_source", column.name)} asc`;
}

function listOutputHandle(count: number) {
  if (count === 0) return "none";
  if (count === 1) return "one";
  return "many";
}

function listPayloadForHandle(
  outputHandle: string,
  items: Record<string, unknown>[],
  totalCount: number,
) {
  if (outputHandle === "none") {
    return {};
  }
  if (outputHandle === "one") {
    return items[0] ?? {};
  }
  return {
    items,
    count: totalCount,
  };
}

async function executeList(
  db: OpenShapeForgeDatabase,
  table: GeneratedCrudTable,
  context: WorkflowNodeBridgeContext,
): Promise<WorkflowNodeBridgeOutput> {
  const limit = normalizeLimit(context.resolvedConfig.limit);
  const conditions = [
    table.tenantScoped
      ? sql`${sql.id("row_source", "tenant_id")} = cast(${context.tenantId} as uuid)`
      : sql`true`,
    compileListFilter(table, context.resolvedConfig),
  ];
  const where = sql.join(conditions, sql` and `);
  const orderBy = sortExpression(table, context.resolvedConfig.sort);

  const result = table.schema === "erp" && table.table === "agreement_parties"
    ? await sql<{ row: Record<string, unknown> }>`
        select
          to_jsonb(row_source.*) || jsonb_build_object(
            'address_label',
            nullif(
              concat_ws(
                ', ',
                nullif(trim(concat_ws(' ', address.street, address.house_number, address.house_number_addition)), ''),
                nullif(trim(concat_ws(' ', address.postal_code, address.city)), '')
              ),
              ''
            ),
            'address_id',
            assignment.address_id::text
          ) as row
        from ${sql.id(table.schema, table.table)} as row_source
        left join erp.address_assignments assignment
          on assignment.tenant_id = row_source.tenant_id
         and assignment.id = row_source.address_assignment_id
        left join erp.addresses address
          on address.tenant_id = assignment.tenant_id
         and address.id = assignment.address_id
        where ${where}
        order by ${orderBy}
        limit ${limit}
      `.execute(db)
    : await sql<{ row: Record<string, unknown> }>`
        select to_jsonb(row_source.*) as row
        from ${sql.id(table.schema, table.table)} as row_source
        where ${where}
        order by ${orderBy}
        limit ${limit}
      `.execute(db);

  const countResult = await sql<{ total_count: string | number }>`
    select count(*) as total_count
    from ${sql.id(table.schema, table.table)} as row_source
    where ${where}
  `.execute(db);

  const totalCount = Number(countResult.rows[0]?.total_count ?? 0);
  const outputHandle = listOutputHandle(totalCount);
  const items = result.rows.map((row) => outputRow(table, row.row));
  return {
    outputHandle,
    payload: listPayloadForHandle(outputHandle, items, totalCount),
  };
}

async function executeGetOne(
  db: OpenShapeForgeDatabase,
  table: GeneratedCrudTable,
  context: WorkflowNodeBridgeContext,
): Promise<WorkflowNodeBridgeOutput> {
  const recordId = normalizeRecordId(context.resolvedConfig.recordId);
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("row_source", "tenant_id")} = cast(${context.tenantId} as uuid)`
    : sql``;
  const result = await sql<{ row: Record<string, unknown> }>`
    select to_jsonb(row_source.*) as row
    from ${sql.id(table.schema, table.table)} as row_source
    where ${sql.id("row_source", table.primaryKey!)}::text = ${recordId}
      ${tenantWhere}
    limit 1
  `.execute(db);
  const row = result.rows[0]?.row ?? null;
  if (!row) {
    throw new Error(`Generated entity ${table.name} record "${recordId}" was not found.`);
  }
  return { outputHandle: "default", payload: outputRow(table, row) };
}

async function executeCreate(
  db: OpenShapeForgeDatabase,
  table: GeneratedCrudTable,
  context: WorkflowNodeBridgeContext,
): Promise<WorkflowNodeBridgeOutput> {
  const values = normalizeValues(context.resolvedConfig.values);
  const writable = writableColumnMap(table);
  const entries = Object.entries(values)
    .flatMap(([field, value]) => {
      const column = writable.get(field);
      return column && value !== undefined ? [{ column, value }] : [];
    });
  if (table.tenantScoped) {
    const tenantColumn = table.columns.find((column) => column.name === "tenant_id");
    if (tenantColumn) entries.push({ column: tenantColumn, value: context.tenantId });
  }
  if (entries.length === 0) {
    throw new Error(`Generated entity create for ${table.name} has no writable values.`);
  }
  const result = await sql<{ row: Record<string, unknown> }>`
    insert into ${sql.id(table.schema, table.table)}
      (${sql.join(entries.map((entry) => sql.id(entry.column.name)))})
    values
      (${sql.join(entries.map((entry) => sqlValueForColumn(entry.column, entry.value)))})
    returning to_jsonb(${sql.id(table.table)}.*) as row
  `.execute(db);
  const row = result.rows[0]?.row;
  if (!row) throw new Error(`Generated entity create for ${table.name} did not return a row.`);
  return { outputHandle: "default", payload: outputRow(table, row) };
}

async function executeUpdate(
  db: OpenShapeForgeDatabase,
  table: GeneratedCrudTable,
  context: WorkflowNodeBridgeContext,
): Promise<WorkflowNodeBridgeOutput> {
  const recordId = normalizeRecordId(context.resolvedConfig.recordId);
  const values = normalizeValues(context.resolvedConfig.values);
  const writable = writableColumnMap(table);
  const assignments = Object.entries(values)
    .flatMap(([field, value]) => {
      const column = writable.get(field);
      return column && value !== undefined
        ? [sql`${sql.id(column.name)} = ${sqlValueForColumn(column, value)}`]
        : [];
    });
  const updatedAt = table.columns.find((column) => column.name === "updated_at");
  if (updatedAt) assignments.push(sql`${sql.id(updatedAt.name)} = now()`);
  if (assignments.length === 0) {
    return executeGetOne(db, table, context);
  }
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = cast(${context.tenantId} as uuid)`
    : sql``;
  const result = await sql<{ row: Record<string, unknown> }>`
    update ${sql.id(table.schema, table.table)}
    set ${sql.join(assignments)}
    where ${sql.id(table.primaryKey!)}::text = ${recordId}
      ${tenantWhere}
    returning to_jsonb(${sql.id(table.table)}.*) as row
  `.execute(db);
  const row = result.rows[0]?.row;
  if (!row) {
    throw new Error(`Generated entity ${table.name} record "${recordId}" was not found.`);
  }
  return { outputHandle: "default", payload: outputRow(table, row) };
}

async function executeDelete(
  db: OpenShapeForgeDatabase,
  table: GeneratedCrudTable,
  context: WorkflowNodeBridgeContext,
): Promise<WorkflowNodeBridgeOutput> {
  const recordId = normalizeRecordId(context.resolvedConfig.recordId);
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = cast(${context.tenantId} as uuid)`
    : sql``;
  const result = await sql<{ row: Record<string, unknown> }>`
    delete from ${sql.id(table.schema, table.table)}
    where ${sql.id(table.primaryKey!)}::text = ${recordId}
      ${tenantWhere}
    returning to_jsonb(${sql.id(table.table)}.*) as row
  `.execute(db);
  if (!result.rows[0]?.row) {
    throw new Error(`Generated entity ${table.name} record "${recordId}" was not found.`);
  }
  return {
    outputHandle: "default",
    payload: { success: true, deletedId: recordId },
  };
}

function buildHandler(
  entry: GeneratedEntityWorkflowNodeDefinition,
  table: GeneratedCrudTable,
) {
  return async (context: WorkflowNodeBridgeContext): Promise<WorkflowNodeBridgeOutput> => {
    switch (entry.action) {
      case "list":
        return executeList(context.db, table, context);
      case "getOne":
        return executeGetOne(context.db, table, context);
      case "create":
        return executeCreate(context.db, table, context);
      case "update":
        return executeUpdate(context.db, table, context);
      case "delete":
        return executeDelete(context.db, table, context);
      default:
        throw new Error(`Generated entity workflow action "${entry.action}" is not runtime-executable.`);
    }
  };
}

export function registerGeneratedEntityNodeBridges(): void {
  for (const entry of generatedEntityWorkflowNodes as GeneratedEntityWorkflowNodeDefinition[]) {
    if (entry.action === "wait" || entry.action === "awaitAction") {
      continue;
    }
    const table = findTable(entry);
    if (!table) {
      continue;
    }
    registerWorkflowNodeBridge(entry.type, buildHandler(entry, table));
  }
}

export const __generatedEntityBridgeInternals = {
  compileCondition,
  compileSimpleFilter,
  findTable,
  listPayloadForHandle,
  listOutputHandle,
  outputRow,
  sqlValueForColumn,
};
