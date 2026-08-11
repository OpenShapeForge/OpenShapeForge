// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant-scoped data-subject erasure for the currently authored Relation
 * aggregate. The compiled manifest is the allow-list: callers supply only an
 * id, never schema, table or column names.
 */
import { GraphQLError } from "graphql";
import manifest from "../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { sql } from "kysely";

export const PRIVACY_DATA_ERASURE_ROLE = "Privacy.DataErasure";

type ErasureMetadata = {
  subjectScoped?: boolean;
  subjectColumns?: string[];
  cascades?: Array<{ schema: string; table: string; via: string }>;
  anonymizeColumns?: string[];
};

type ManifestTable = {
  schema: string;
  table: string;
  columns: Array<{ name: string; type: string; required?: boolean }>;
  retention?: { erasure?: ErasureMetadata };
};

type ErasurePlan = {
  root: ManifestTable;
  contactDetails: { table: ManifestTable; via: string };
  paymentDetails: { table: ManifestTable; via: string; anonymizeColumns: string[] };
};

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function forbidden(message: string) {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN", status: 403 } });
}

export function requirePrivacyDataErasure(session: DbSessionInput): void {
  if (!session.roles?.includes(PRIVACY_DATA_ERASURE_ROLE)) {
    throw forbidden("Not authorized to erase a data subject.");
  }
}

function configurationError(message: string): never {
  throw new Error(`Invalid data-subject erasure manifest: ${message}`);
}

function qualifiedName(table: ManifestTable): string {
  if (!IDENTIFIER.test(table.schema) || !IDENTIFIER.test(table.table)) {
    return configurationError("unsafe table identifier");
  }
  return `${table.schema}.${table.table}`;
}

function column(table: ManifestTable, name: string) {
  const result = table.columns.find((candidate) => candidate.name === name);
  if (!result || !IDENTIFIER.test(name)) {
    return configurationError(`unknown or unsafe column ${table.schema}.${table.table}.${name}`);
  }
  return result;
}

function tableByName(tables: ManifestTable[], schema: string, table: string): ManifestTable {
  const result = tables.find((candidate) => candidate.schema === schema && candidate.table === table);
  if (!result) configurationError(`missing ${schema}.${table}`);
  return result;
}

/** Resolve only the authored relation plan; no caller-controlled SQL surface. */
function resolveErasurePlan(): ErasurePlan {
  const tables = manifest.tables as ManifestTable[];
  const root = tableByName(tables, "erp", "relations");
  const rootErasure = root.retention?.erasure;
  if (rootErasure?.subjectScoped !== true || !rootErasure.subjectColumns?.includes("id")) {
    configurationError("erp.relations must be an id-scoped erasure root");
  }
  const cascades = rootErasure.cascades ?? [];
  const cascadeFor = (schema: string, table: string) => {
    const cascade = cascades.find((entry) => entry.schema === schema && entry.table === table);
    if (!cascade || !IDENTIFIER.test(cascade.via)) {
      configurationError(`erp.relations is missing a safe cascade to ${schema}.${table}`);
    }
    return cascade;
  };

  const contactDetails = tableByName(tables, "erp", "contact_details");
  const contactCascade = cascadeFor("erp", "contact_details");
  const paymentDetails = tableByName(tables, "erp", "payment_details");
  const paymentCascade = cascadeFor("erp", "payment_details");
  const paymentErasure = paymentDetails.retention?.erasure;
  const anonymizeColumns = paymentErasure?.anonymizeColumns ?? [];

  for (const [table, via] of [[contactDetails, contactCascade.via], [paymentDetails, paymentCascade.via]] as const) {
    if (table.retention?.erasure?.subjectScoped !== true || !table.retention.erasure.subjectColumns?.includes(via)) {
      configurationError(`${qualifiedName(table)} must be scoped through ${via}`);
    }
    if (column(table, via).type !== "uuid") configurationError(`${qualifiedName(table)}.${via} must be uuid`);
  }
  if (anonymizeColumns.length === 0) configurationError("erp.payment_details has no statutory anonymize columns");
  for (const name of anonymizeColumns) {
    if (column(paymentDetails, name).type !== "text") {
      configurationError(`erp.payment_details.${name} must be text`);
    }
  }
  if (column(paymentDetails, paymentCascade.via).required === true) {
    configurationError("retained payment details need a nullable relation reference");
  }

  return {
    root,
    contactDetails: { table: contactDetails, via: contactCascade.via },
    paymentDetails: { table: paymentDetails, via: paymentCascade.via, anonymizeColumns },
  };
}

/** Test-only proof that generated authoring metadata is sufficient to run safely. */
export const __resolveErasurePlanForTests = resolveErasurePlan;

export type DataSubjectErasureResult = {
  contactDetailsDeleted: number;
  paymentDetailsAnonymized: number;
  relationsDeleted: number;
};

export async function eraseRelationDataSubject(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  relationId: string,
): Promise<DataSubjectErasureResult> {
  requirePrivacyDataErasure(session);
  const plan = resolveErasurePlan();

  return withDbSession(db, session, async (trx) => {
    const contactResult = await sql<{ id: string }>`
      delete from ${sql.table(qualifiedName(plan.contactDetails.table))}
      where ${sql.ref(plan.contactDetails.via)} = ${relationId}::uuid
      returning id
    `.execute(trx);

    const assignments = sql.join(
      [
        ...plan.paymentDetails.anonymizeColumns.map((name) => sql`${sql.ref(name)} = null`),
        sql`${sql.ref(plan.paymentDetails.via)} = null`,
      ],
      sql`, `,
    );
    const paymentResult = await sql<{ id: string }>`
      update ${sql.table(qualifiedName(plan.paymentDetails.table))}
      set ${assignments}
      where ${sql.ref(plan.paymentDetails.via)} = ${relationId}::uuid
      returning id
    `.execute(trx);

    const rootResult = await sql<{ id: string }>`
      delete from ${sql.table(qualifiedName(plan.root))}
      where id = ${relationId}::uuid
      returning id
    `.execute(trx);
    if (rootResult.rows.length !== 1) {
      throw new GraphQLError("Data subject was not found.", {
        extensions: { code: "NOT_FOUND", status: 404 },
      });
    }

    const result: DataSubjectErasureResult = {
      contactDetailsDeleted: contactResult.rows.length,
      paymentDetailsAnonymized: paymentResult.rows.length,
      relationsDeleted: rootResult.rows.length,
    };
    await sql`
      insert into platform.data_subject_erasure_audit
        (tenant_id, contact_details_deleted, payment_details_anonymized, relations_deleted)
      values (${session.tenantId}::uuid, ${result.contactDetailsDeleted}, ${result.paymentDetailsAnonymized}, ${result.relationsDeleted})
    `.execute(trx);
    return result;
  });
}
