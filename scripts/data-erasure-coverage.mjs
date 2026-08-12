// SPDX-License-Identifier: BUSL-1.1

const RESTRICTING_CLASSIFICATIONS = new Set(["confidential", "pii", "bsn"]);
export const SUPPORTED_DATA_ERASURE_ROOT = "erp.relations";
const SUPPORTED_DATA_ERASURE_CASCADES = [
  { schema: "erp", table: "contact_details", via: "relation_id" },
  { schema: "erp", table: "payment_details", via: "relation_id" },
];

function tableKey(table) {
  return `${table.schema}.${table.table}`;
}

function erasureMetadata(table) {
  return table.retention?.erasure;
}

function isExplicitRoot(table) {
  const erasure = erasureMetadata(table);
  if (erasure?.subjectScoped !== true || !Array.isArray(erasure.subjectColumns)) {
    return false;
  }
  const primaryKeys = new Set(
    (table.columns ?? []).filter((column) => column.primaryKey === true).map((column) => column.name),
  );
  return erasure.subjectColumns.some((column) => primaryKeys.has(column));
}

/**
 * Return deterministic coverage failures for generated tables whose
 * restricting classifications are not covered by the one fixed erasure
 * procedure or one of its valid cascades. Authoring another root cannot imply
 * runtime support that does not exist.
 */
export function dataErasureCoverageFailures(manifest) {
  if (!Array.isArray(manifest?.tables)) {
    return ["generated database manifest has no tables array"];
  }
  const tables = manifest.tables;
  const tablesByKey = new Map(tables.map((table) => [tableKey(table), table]));
  const covered = new Set();
  const failures = [];
  const root = tablesByKey.get(SUPPORTED_DATA_ERASURE_ROOT);

  if (!root) {
    failures.push(
      `supported data-erasure root ${SUPPORTED_DATA_ERASURE_ROOT} is missing from the generated manifest`,
    );
  } else if (!isExplicitRoot(root)) {
    failures.push(
      `supported data-erasure root ${SUPPORTED_DATA_ERASURE_ROOT} is not configured as an explicit primary-key subject root`,
    );
  } else {
    covered.add(tableKey(root));
    const authoredCascades = erasureMetadata(root)?.cascades ?? [];
    for (const supportedCascade of SUPPORTED_DATA_ERASURE_CASCADES) {
      const targetKey = `${supportedCascade.schema}.${supportedCascade.table}`;
      const cascade = authoredCascades.find(
        (candidate) =>
          candidate.schema === supportedCascade.schema &&
          candidate.table === supportedCascade.table &&
          candidate.via === supportedCascade.via,
      );
      if (!cascade) {
        failures.push(
          `supported ${SUPPORTED_DATA_ERASURE_ROOT} procedure is missing manifest cascade to ${targetKey} via ${supportedCascade.via}`,
        );
        continue;
      }
      const target = tablesByKey.get(targetKey);
      const targetErasure = target && erasureMetadata(target);
      if (
        targetErasure?.subjectScoped === true &&
        Array.isArray(targetErasure.subjectColumns) &&
        targetErasure.subjectColumns.includes(cascade.via)
      ) {
        covered.add(tableKey(target));
      } else {
        failures.push(
          `supported ${SUPPORTED_DATA_ERASURE_ROOT} cascade to ${targetKey} via ${supportedCascade.via} has no matching subject-scoped target metadata`,
        );
      }
    }
  }

  failures.push(
    ...tables.flatMap((table) => {
      const classifiedColumns = (table.columns ?? [])
        .filter((column) => RESTRICTING_CLASSIFICATIONS.has(column.classification))
        .map((column) => `${column.name}:${column.classification}`)
        .sort();
      if (classifiedColumns.length === 0 || covered.has(tableKey(table))) {
        return [];
      }
      return [
        `${tableKey(table)} carries restricting classification (${classifiedColumns.join(", ")}) ` +
          `but is not covered by the supported ${SUPPORTED_DATA_ERASURE_ROOT} procedure or one of its valid cascades`,
      ];
    }),
  );
  return failures.sort();
}
