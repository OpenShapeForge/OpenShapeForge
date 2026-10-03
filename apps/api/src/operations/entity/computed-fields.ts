// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import { evaluateExpression } from "../../generated/compiler/expression-evaluator.js";
import type { CompilerExpressionInput } from "../../generated/compiler/canonical-condition.js";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionContext } from "../../db/session.js";
import { fieldNameForColumn } from "./columns.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

export type LabelRuleRow = {
  id: string;
  key: string;
  label: string;
  variant: string;
  output_type: "boolean" | "number" | "string";
  expression: unknown;
  description_template: string | null;
  priority: number;
};

export type ComputedLabel = {
  id: string;
  key: string;
  label: string;
  variant: string;
  value: boolean | number | string;
  description: string | null;
};

export type ComputedLabelSet = {
  asMap: Record<string, boolean | number | string>;
  items: ComputedLabel[];
};

function expressionPayload(table: GeneratedCrudTable, row: GeneratedEntityRow) {
  const payload = { ...row };
  for (const column of table.columns) {
    if (!(column.name in row)) continue;
    payload[fieldNameForColumn(column)] = row[column.name];
  }
  return payload;
}

function interpolate(template: string | null, payload: GeneratedEntityRow) {
  if (!template) return null;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    let value: unknown = payload;
    for (const part of path.trim().split(".")) {
      value = value && typeof value === "object"
        ? (value as Record<string, unknown>)[part]
        : undefined;
    }
    return value == null ? "" : String(value);
  });
}

function normalizeValue(value: unknown, outputType: LabelRuleRow["output_type"]): boolean | number | string {
  if (outputType === "boolean") return value === true;
  if (outputType === "number") return typeof value === "number" && Number.isFinite(value) ? value : 0;
  return value == null ? "" : String(value);
}

function isVisible(value: boolean | number | string) {
  return typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : value.length > 0;
}

export function evaluateLabelRules(
  table: GeneratedCrudTable,
  rules: readonly LabelRuleRow[],
  row: GeneratedEntityRow,
): ComputedLabelSet {
  const payload = expressionPayload(table, row);
  const asMap: ComputedLabelSet["asMap"] = {};
  const items: ComputedLabel[] = [];
  for (const rule of rules) {
    const value = normalizeValue(
      evaluateExpression(rule.expression as CompilerExpressionInput, payload),
      rule.output_type,
    );
    asMap[rule.key] = value;
    if (!isVisible(value)) continue;
    items.push({
      id: rule.id,
      key: rule.key,
      label: rule.label,
      variant: rule.variant,
      value,
      description: interpolate(rule.description_template, payload),
    });
  }
  return { asMap, items };
}

async function activeLabelRules(
  trx: Transaction<DB>,
  session: DbSessionContext,
  entityType: string,
) {
  const result = await sql<LabelRuleRow>`
    select id::text, key, label, variant, output_type, expression,
      description_template, priority
    from ${sql.id("erp", "label_rules")}
    where tenant_id = ${session.tenantId}::uuid
      and entity_type = ${entityType}
      and active = true
      and (start_date is null or start_date <= current_date)
      and (end_date is null or end_date >= current_date)
    order by priority desc, key asc, id asc
  `.execute(trx);
  return result.rows;
}

export async function resolveComputedEntityRows(
  trx: Transaction<DB>,
  session: DbSessionContext,
  table: GeneratedCrudTable,
  rows: GeneratedEntityRow[],
): Promise<GeneratedEntityRow[]> {
  const labelFields = table.source?.computedFields
    ?.filter(({ resolver }) => resolver === "labelRules") ?? [];
  if (labelFields.length === 0 || rows.length === 0) return rows;
  const entityType = table.source?.authoringEntityName;
  if (!entityType) return rows;
  const rules = await activeLabelRules(trx, session, entityType);
  return rows.map((row) => {
    const labels = evaluateLabelRules(table, rules, row);
    return labelFields.reduce<GeneratedEntityRow>(
      (resolved, field) => ({ ...resolved, [field.field]: labels }),
      row,
    );
  });
}
