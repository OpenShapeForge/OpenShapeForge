// SPDX-License-Identifier: BUSL-1.1
import { sql, type QueryExecutorProvider, type RawBuilder } from "kysely";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_REVIEW_QUEUE = "retention-review";
const RETENTION_LOCK_KEY = 1_186_118;

export type RetentionDuration = {
  years?: number;
  months?: number;
  days?: number;
};

type RetentionColumn = {
  name: string;
  type: string;
  required: boolean;
  primaryKey?: boolean;
  classification?: "confidential" | "pii" | "bsn";
};

type RetentionRule = {
  id: string;
  after: RetentionDuration;
  action: "retain" | "archive" | "redact" | "delete";
  disposition?: "keep" | "archive" | "delete" | "anonymize" | "mask" | "cryptoDelete" | "review";
  review?: { required: boolean; queue?: string };
  cryptoDelete?: { keyReference?: string };
};

type RetentionTable = {
  schema: string;
  table: string;
  primaryKey: string | null;
  columns: RetentionColumn[];
  retention?: {
    clock: {
      column: string;
      type?: "timestamptz" | "date";
      fallbackColumns?: string[];
    };
    rules: RetentionRule[];
    legalHold?: { suspendDestruction: boolean };
  };
};

export type RetentionManifest = {
  tables: RetentionTable[];
};

export type RetentionPlanRule = {
  id: string;
  after: RetentionDuration;
  disposition: NonNullable<RetentionRule["disposition"]>;
  destructive: boolean;
  suspended: boolean;
  reviewQueue?: string;
  cryptoDeleteKey?: string;
};

export type RetentionPlan = {
  schema: string;
  table: string;
  primaryKey: string;
  clock: Array<{ name: string; type: "timestamptz" | "date" }>;
  redactionColumns: Array<Pick<RetentionColumn, "name" | "type" | "required">>;
  rules: RetentionPlanRule[];
};

export type RetentionRunResult = {
  locked: boolean;
  scannedRules: number;
  suspendedRules: number;
  reviewed: number;
  retained: number;
  archived: number;
  redacted: number;
  deleted: number;
  cryptoDeleteQueued: number;
};

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Retention manifest contains unsafe ${label} identifier ${JSON.stringify(value)}.`);
  }
}

function dispositionFor(rule: RetentionRule): NonNullable<RetentionRule["disposition"]> {
  if (rule.disposition) return rule.disposition;
  switch (rule.action) {
    case "retain":
      return "keep";
    case "archive":
      return "archive";
    case "delete":
      return "delete";
    case "redact":
      return "anonymize";
  }
}

function isDestructive(disposition: NonNullable<RetentionRule["disposition"]>): boolean {
  return disposition === "archive" || disposition === "delete" ||
    disposition === "anonymize" || disposition === "mask" ||
    disposition === "cryptoDelete";
}

export function buildRetentionPlans(manifest: RetentionManifest): RetentionPlan[] {
  return manifest.tables.flatMap((table) => {
    if (!table.retention) return [];
    assertIdentifier(table.schema, "schema");
    assertIdentifier(table.table, "table");
    if (!table.primaryKey) {
      throw new Error(`Retention table ${table.schema}.${table.table} has no primary key.`);
    }
    assertIdentifier(table.primaryKey, "primary-key column");

    const columns = new Map(table.columns.map((column) => [column.name, column]));
    const clockNames = [
      table.retention.clock.column,
      ...(table.retention.clock.fallbackColumns ?? []),
    ];
    const clock = clockNames.map((name, index) => {
      assertIdentifier(name, "clock column");
      const column = columns.get(name);
      if (!column) {
        throw new Error(
          `Retention table ${table.schema}.${table.table} references unknown clock column ${name}.`,
        );
      }
      const candidateType = index === 0
        ? (table.retention!.clock.type ?? column.type)
        : column.type;
      if (candidateType !== "date" && candidateType !== "timestamptz") {
        throw new Error(
          `Retention clock ${table.schema}.${table.table}.${name} must be date or timestamptz, got ${candidateType}.`,
        );
      }
      const type: "date" | "timestamptz" = candidateType;
      return { name, type };
    });

    const redactionColumns = table.columns
      .filter((column) => column.classification && !column.primaryKey)
      .map(({ name, type, required }) => ({ name, type, required }));
    const held = table.retention.legalHold?.suspendDestruction === true;
    const rules = table.retention.rules.map((rule) => {
      assertIdentifier(rule.id, "rule");
      const disposition = dispositionFor(rule);
      const destructive = isDestructive(disposition);
      const reviewRequired = rule.review?.required === true || disposition === "review";
      if (disposition === "cryptoDelete" && !rule.cryptoDelete?.keyReference) {
        throw new Error(`Retention rule ${rule.id} requires cryptoDelete.keyReference.`);
      }
      return {
        id: rule.id,
        after: rule.after,
        disposition,
        destructive,
        suspended: held && destructive,
        ...(reviewRequired
          ? { reviewQueue: rule.review?.queue ?? DEFAULT_REVIEW_QUEUE }
          : {}),
        ...(rule.cryptoDelete?.keyReference
          ? { cryptoDeleteKey: rule.cryptoDelete.keyReference }
          : {}),
      };
    });

    return [{
      schema: table.schema,
      table: table.table,
      primaryKey: table.primaryKey,
      clock,
      redactionColumns,
      rules,
    }];
  });
}

export function durationToPostgresInterval(duration: RetentionDuration): string {
  const parts: string[] = [];
  for (const [unit, value] of [
    ["years", duration.years],
    ["months", duration.months],
    ["days", duration.days],
  ] as const) {
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Retention duration ${unit} must be a non-negative integer.`);
      }
      parts.push(`${value} ${unit}`);
    }
  }
  if (parts.length === 0) {
    throw new Error("Retention duration must contain years, months, or days.");
  }
  return parts.join(" ");
}

function clockExpression(plan: RetentionPlan): RawBuilder<Date | null> {
  const values = plan.clock.map((clock) =>
    clock.type === "date"
      ? sql<Date | null>`${sql.ref(`source.${clock.name}`)}::date::timestamp at time zone 'UTC'`
      : sql<Date | null>`${sql.ref(`source.${clock.name}`)}::timestamptz`
  );
  return sql<Date | null>`coalesce(${sql.join(values)})`;
}

function expiredSelection(plan: RetentionPlan, rule: RetentionPlanRule, batchSize: number) {
  const table = sql.table(`${plan.schema}.${plan.table}`);
  const primaryKey = sql.ref(`source.${plan.primaryKey}`);
  return sql`
    select ${primaryKey}::text as record_id, to_jsonb(source) as payload
    from ${table} as source
    where ${clockExpression(plan)} + ${durationToPostgresInterval(rule.after)}::interval <= now()
      and not exists (
        select 1 from platform.retention_actions completed
        where completed.source_schema = ${plan.schema}
          and completed.source_table = ${plan.table}
          and completed.rule_id = ${rule.id}
          and completed.record_id = ${primaryKey}::text
      )
      and not exists (
        select 1 from platform.retention_review_queue review
        where review.source_schema = ${plan.schema}
          and review.source_table = ${plan.table}
          and review.rule_id = ${rule.id}
          and review.record_id = ${primaryKey}::text
      )
      and not exists (
        select 1 from platform.retention_crypto_delete_queue queued_key
        where queued_key.source_schema = ${plan.schema}
          and queued_key.source_table = ${plan.table}
          and queued_key.rule_id = ${rule.id}
          and queued_key.record_id = ${primaryKey}::text
      )
    order by ${clockExpression(plan)}, ${primaryKey}
    limit ${batchSize}
    for update skip locked
  `;
}

function redactedValue(column: RetentionPlan["redactionColumns"][number]): RawBuilder<unknown> {
  if (!column.required) return sql`null`;
  switch (column.type) {
    case "uuid":
      return sql`'00000000-0000-0000-0000-000000000000'::uuid`;
    case "integer":
    case "bigint":
    case "numeric":
      return sql`0`;
    case "boolean":
      return sql`false`;
    case "date":
      return sql`date '1970-01-01'`;
    case "timestamptz":
      return sql`timestamptz '1970-01-01 00:00:00+00'`;
    case "json":
    case "jsonb":
      return sql`'{}'::jsonb`;
    default:
      return sql`'[redacted]'`;
  }
}

async function executeRule(
  db: QueryExecutorProvider,
  plan: RetentionPlan,
  rule: RetentionPlanRule,
  batchSize: number,
): Promise<{ disposition: RetentionPlanRule["disposition"]; count: number }> {
  const selection = expiredSelection(plan, rule, batchSize);
  const table = sql.table(`${plan.schema}.${plan.table}`);
  const primaryKey = sql.ref(plan.primaryKey);
  let result;

  if (rule.reviewQueue) {
    result = await sql`
      with expired as (${selection})
      insert into platform.retention_review_queue
        (queue, source_schema, source_table, rule_id, record_id, payload)
      select ${rule.reviewQueue}, ${plan.schema}, ${plan.table}, ${rule.id}, record_id, payload
      from expired
      on conflict (source_schema, source_table, rule_id, record_id) do nothing
      returning id
    `.execute(db);
  } else if (rule.disposition === "keep") {
    result = await sql`
      with expired as (${selection})
      insert into platform.retention_actions
        (source_schema, source_table, rule_id, record_id, disposition)
      select ${plan.schema}, ${plan.table}, ${rule.id}, record_id, 'keep'
      from expired
      on conflict (source_schema, source_table, rule_id, record_id) do nothing
      returning id
    `.execute(db);
  } else if (rule.disposition === "archive") {
    result = await sql`
      with expired as (${selection}), archived as (
        insert into platform.retention_archive
          (source_schema, source_table, rule_id, record_id, payload)
        select ${plan.schema}, ${plan.table}, ${rule.id}, record_id, payload from expired
        on conflict (source_schema, source_table, rule_id, record_id) do nothing
        returning record_id
      )
      delete from ${table}
      where ${primaryKey}::text in (select record_id from archived)
      returning ${primaryKey}
    `.execute(db);
  } else if (rule.disposition === "cryptoDelete") {
    result = await sql`
      with expired as (${selection}), queued as (
        insert into platform.retention_crypto_delete_queue
          (key_reference, source_schema, source_table, rule_id, record_id)
        select ${rule.cryptoDeleteKey!}, ${plan.schema}, ${plan.table}, ${rule.id}, record_id
        from expired
        on conflict (source_schema, source_table, rule_id, record_id) do nothing
        returning record_id
      )
      insert into platform.retention_actions
        (source_schema, source_table, rule_id, record_id, disposition)
      select ${plan.schema}, ${plan.table}, ${rule.id}, record_id, 'cryptoDelete' from queued
      on conflict (source_schema, source_table, rule_id, record_id) do nothing
      returning id
    `.execute(db);
  } else if (rule.disposition === "delete") {
    result = await sql`
      with expired as (${selection})
      delete from ${table}
      where ${primaryKey}::text in (select record_id from expired)
      returning ${primaryKey}
    `.execute(db);
  } else {
    if (plan.redactionColumns.length === 0) {
      throw new Error(
        `Retention rule ${rule.id} cannot ${rule.disposition} ${plan.schema}.${plan.table}: no classified columns.`,
      );
    }
    const assignments = plan.redactionColumns.map((column) =>
      sql`${sql.ref(column.name)} = ${redactedValue(column)}`
    );
    result = await sql`
      with expired as (${selection}), redacted as (
        update ${table}
        set ${sql.join(assignments)}
        where ${primaryKey}::text in (select record_id from expired)
        returning ${primaryKey}::text as record_id
      )
      insert into platform.retention_actions
        (source_schema, source_table, rule_id, record_id, disposition)
      select ${plan.schema}, ${plan.table}, ${rule.id}, record_id, ${rule.disposition}
      from redacted
      on conflict (source_schema, source_table, rule_id, record_id) do nothing
      returning id
    `.execute(db);
  }

  return { disposition: rule.reviewQueue ? "review" : rule.disposition, count: result.rows.length };
}

export async function enforceRetention(
  db: QueryExecutorProvider,
  manifest: RetentionManifest,
  options: { batchSize?: number } = {},
): Promise<RetentionRunResult> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("Retention batchSize must be an integer between 1 and 10000.");
  }
  const result: RetentionRunResult = {
    locked: false,
    scannedRules: 0,
    suspendedRules: 0,
    reviewed: 0,
    retained: 0,
    archived: 0,
    redacted: 0,
    deleted: 0,
    cryptoDeleteQueued: 0,
  };

  const lock = await sql<{ acquired: boolean }>`
    select pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) as acquired
  `.execute(db);
  if (!lock.rows[0]?.acquired) return result;
  result.locked = true;

  for (const plan of buildRetentionPlans(manifest)) {
    for (const rule of plan.rules) {
      result.scannedRules += 1;
      if (rule.suspended) {
        result.suspendedRules += 1;
        continue;
      }
      const executed = await executeRule(db, plan, rule, batchSize);
      if (executed.disposition === "review") result.reviewed += executed.count;
      else if (executed.disposition === "keep") result.retained += executed.count;
      else if (executed.disposition === "archive") result.archived += executed.count;
      else if (executed.disposition === "delete") result.deleted += executed.count;
      else if (executed.disposition === "cryptoDelete") result.cryptoDeleteQueued += executed.count;
      else result.redacted += executed.count;
    }
  }
  return result;
}
