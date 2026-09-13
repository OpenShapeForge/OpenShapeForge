// SPDX-License-Identifier: BUSL-1.1
/**
 * Real PostgreSQL evidence for the logical-only Document command boundary.
 *
 * The test connects through the same restricted app role as production. Its
 * role-less DbSession fixture stands in for a canonical Operation that was
 * already authorized and schema-validated; this file deliberately does not
 * claim to prove that application-level policy. It proves only the private DB
 * seam: privilege isolation, tenant/actor binding and atomic persistence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../migrations/app-role.js";
import { DEV_WORKER_ROLE_PASSWORD_DEFAULT, WORKER_ROLE } from "../migrations/worker-role.js";
import { type DbSessionInput, withDbSession } from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const scratchName = `document_logical_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const sessionA: DbSessionInput = {
  tenantId: tenantA,
  userId: userA,
  roles: [],
  scope: "tenant",
};
const sessionB: DbSessionInput = {
  tenantId: tenantB,
  userId: userB,
  roles: [],
  scope: "tenant",
};

let admin: SQL;
let privileged: DatabaseRuntime;
let restricted: DatabaseRuntime;
let worker: DatabaseRuntime;
let foreignAccountId: string;
let foreignRelationId: string;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") {
    throw new Error("admin URL must not point at an application database");
  }
  if (role) {
    url.username = role.username;
    url.password = role.password;
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

function sqlState(error: unknown): string | undefined {
  const postgres = error as { errno?: string; code?: string } | null;
  return postgres?.errno ?? postgres?.code;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to be rejected.");
}

async function createLogicalDocument(
  session: DbSessionInput,
  document: Record<string, unknown>,
  version: Record<string, unknown>,
): Promise<{ documentId: string; documentVersionId: string }> {
  return withDbSession(restricted.db, session, async (trx) => {
    const created = await sql<{ document_id: string; document_version_id: string }>`
      select document_id, document_version_id
      from document_internal.create_with_first_version(
        ${JSON.stringify(document)}::text::jsonb,
        ${JSON.stringify(version)}::text::jsonb
      )
    `.execute(trx);
    const row = created.rows[0];
    if (!row) throw new Error("logical Document command returned no row");
    return {
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
    };
  });
}

async function appendLogicalVersion(
  session: DbSessionInput,
  documentId: string,
  version: Record<string, unknown>,
): Promise<string> {
  return withDbSession(restricted.db, session, async (trx) => {
    const created = await sql<{ document_version_id: string }>`
      select document_internal.append_version(
        ${documentId}::uuid,
        ${JSON.stringify(version)}::text::jsonb
      ) as document_version_id
    `.execute(trx);
    const id = created.rows[0]?.document_version_id;
    if (!id) throw new Error("logical append command returned no id");
    return id;
  });
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName)) {
    throw new Error(`unsafe scratch database name: ${scratchName}`);
  }
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 4 });
  await privileged.db.connection().execute((conn) => runMigrationChain(conn));
  restricted = createDatabaseRuntime({
    databaseUrl: scratchUrl({
      username: APP_ROLE,
      password: process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT,
    }),
    maxConnections: 4,
  });
  worker = createDatabaseRuntime({
    databaseUrl: scratchUrl({
      username: WORKER_ROLE,
      password: process.env.OPENSHAPEFORGE_WORKER_PASSWORD ?? DEV_WORKER_ROLE_PASSWORD_DEFAULT,
    }),
    maxConnections: 1,
  });

  await sql`
    insert into platform.tenants (id, slug, name, status)
    values
      (${tenantA}::uuid, ${`document-a-${tenantA.slice(0, 8)}`}, 'Document tenant A', 'active'),
      (${tenantB}::uuid, ${`document-b-${tenantB.slice(0, 8)}`}, 'Document tenant B', 'active')
  `.execute(privileged.db);
  foreignAccountId = randomUUID();
  foreignRelationId = randomUUID();
  await sql`
    insert into erp.accounts (id, tenant_id, username, email, status)
    values (
      ${foreignAccountId}::uuid,
      ${tenantB}::uuid,
      ${`document-account-${foreignAccountId}`},
      ${`${foreignAccountId}@example.test`},
      'active'
    )
  `.execute(privileged.db);
  await sql`
    insert into erp.relations (id, tenant_id, display_name, relation_type)
    values (
      ${foreignRelationId}::uuid,
      ${tenantB}::uuid,
      'Foreign document relation',
      'organization'
    )
  `.execute(privileged.db);
}, TEST_TIMEOUT);

afterAll(async () => {
  await worker?.close();
  await restricted?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("logical Document database commands", () => {
  test("grant boundary admits only the app role, not PUBLIC or the worker", async () => {
    const privileges = await sql<{
      app_usage: boolean;
      app_create: boolean;
      app_append: boolean;
      worker_usage: boolean;
      worker_create: boolean;
      worker_append: boolean;
      public_grants: string;
      legacy_create: string | null;
      legacy_append: string | null;
    }>`
      select
        has_schema_privilege(${APP_ROLE}, 'document_internal', 'USAGE') as app_usage,
        has_function_privilege(
          ${APP_ROLE},
          'document_internal.create_with_first_version(jsonb,jsonb)',
          'EXECUTE'
        ) as app_create,
        has_function_privilege(
          ${APP_ROLE},
          'document_internal.append_version(uuid,jsonb)',
          'EXECUTE'
        ) as app_append,
        has_schema_privilege(${WORKER_ROLE}, 'document_internal', 'USAGE') as worker_usage,
        has_function_privilege(
          ${WORKER_ROLE},
          'document_internal.create_with_first_version(jsonb,jsonb)',
          'EXECUTE'
        ) as worker_create,
        has_function_privilege(
          ${WORKER_ROLE},
          'document_internal.append_version(uuid,jsonb)',
          'EXECUTE'
        ) as worker_append,
        (
          select count(*)::text
          from information_schema.routine_privileges
          where routine_schema = 'document_internal' and grantee = 'PUBLIC'
        ) as public_grants,
        to_regprocedure('app.create_document_with_first_version(jsonb,jsonb)')::text
          as legacy_create,
        to_regprocedure('app.append_document_version(uuid,jsonb)')::text
          as legacy_append
    `.execute(privileged.db);
    expect(privileges.rows[0]).toEqual({
      app_usage: true,
      app_create: true,
      app_append: true,
      worker_usage: false,
      worker_create: false,
      worker_append: false,
      public_grants: "0",
      legacy_create: null,
      legacy_append: null,
    });

    const denied = await rejection(
      sql`
        select document_internal.create_with_first_version(
          '{}'::jsonb,
          '{}'::jsonb
        )
      `.execute(worker.db),
    );
    expect(sqlState(denied)).toBe("42501");

    // applyWorkerRoleGrants() deliberately grants EXECUTE on every surviving
    // app.* helper. Removing the old functions, rather than merely revoking
    // them once, is what prevents that sweep from restoring this bypass.
    const retired = await rejection(
      sql`
        select app.create_document_with_first_version(
          '{}'::jsonb,
          '{}'::jsonb
        )
      `.execute(worker.db),
    );
    expect(sqlState(retired)).toBe("42883");
  });

  test("creates the container, first logical version and pointer atomically", async () => {
    const created = await createLogicalDocument(
      sessionA,
      {
        title: "Logical offer A",
        documentType: "quote",
        status: "draft",
      },
      {
        versionLabel: "1.0",
        status: "draft",
      },
    );

    const state = await sql<{
      document_id: string;
      current_version_id: string;
      version_id: string;
      version_document_id: string;
      created_by: string;
      is_external: boolean;
      is_major_version: boolean;
      file_name: string | null;
      mime_type: string | null;
      checksum: string | null;
      storage_location: string | null;
    }>`
      select
        document.id as document_id,
        document.current_version_id,
        version.id as version_id,
        version.document_id as version_document_id,
        version.created_by,
        document.is_external,
        version.is_major_version,
        version.file_name,
        version.mime_type,
        version.checksum,
        version.storage_location
      from erp.documents document
      join erp.document_versions version
        on version.tenant_id = document.tenant_id
       and version.document_id = document.id
       and version.id = document.current_version_id
      where document.id = ${created.documentId}::uuid
    `.execute(privileged.db);
    expect(state.rows[0]).toEqual({
      document_id: created.documentId,
      current_version_id: created.documentVersionId,
      version_id: created.documentVersionId,
      version_document_id: created.documentId,
      created_by: userA,
      is_external: false,
      is_major_version: false,
      file_name: null,
      mime_type: null,
      checksum: null,
      storage_location: null,
    });
  });

  test("appends a logical version and advances only its tenant-bound parent", async () => {
    const first = await createLogicalDocument(
      sessionA,
      { title: "Append target", documentType: "quote", status: "draft" },
      { versionLabel: "1.0", status: "draft" },
    );
    const nextId = await appendLogicalVersion(sessionA, first.documentId, {
      versionLabel: "1.1",
      status: "review",
      isMajorVersion: true,
      changeSummary: "Review candidate",
    });

    const state = await sql<{
      current_version_id: string;
      version_count: string;
      is_major_version: boolean;
    }>`
      select
        document.current_version_id,
        count(version.id)::text as version_count,
        bool_or(version.id = ${nextId}::uuid and version.is_major_version) as is_major_version
      from erp.documents document
      join erp.document_versions version
        on version.tenant_id = document.tenant_id
       and version.document_id = document.id
      where document.id = ${first.documentId}::uuid
      group by document.current_version_id
    `.execute(privileged.db);
    expect(state.rows[0]).toEqual({
      current_version_id: nextId,
      version_count: "2",
      is_major_version: true,
    });

    const denied = await rejection(
      appendLogicalVersion(sessionB, first.documentId, {
        versionLabel: "foreign",
        status: "draft",
      }),
    );
    expect((denied as Error).message).toContain("Document not found");
    const unchanged = await sql<{ current_version_id: string; version_count: string }>`
      select document.current_version_id, count(version.id)::text as version_count
      from erp.documents document
      join erp.document_versions version
        on version.tenant_id = document.tenant_id
       and version.document_id = document.id
      where document.id = ${first.documentId}::uuid
      group by document.current_version_id
    `.execute(privileged.db);
    expect(unchanged.rows[0]).toEqual({
      current_version_id: nextId,
      version_count: "2",
    });
  });

  test("rejects every caller-supplied binary field without leaving rows", async () => {
    const binaryFields = [
      "fileName",
      "mimeType",
      "checksum",
      "storageLocation",
      "artifactId",
    ] as const;
    for (const field of binaryFields) {
      const title = `Forbidden binary ${field} ${randomUUID()}`;
      const failed = await rejection(
        createLogicalDocument(
          sessionA,
          { title, documentType: "quote", status: "draft" },
          { versionLabel: "1.0", status: "draft", [field]: "caller-owned" },
        ),
      );
      expect((failed as Error).message).toContain(
        `DocumentVersion binary field ${field} is storage-managed`,
      );
      const count = await sql<{ count: string }>`
        select count(*)::text as count from erp.documents where title = ${title}
      `.execute(privileged.db);
      expect(count.rows[0]?.count).toBe("0");
    }

    const target = await createLogicalDocument(
      sessionA,
      { title: "Forbidden append target", documentType: "quote", status: "draft" },
      { versionLabel: "1.0", status: "draft" },
    );
    for (const field of binaryFields) {
      const failed = await rejection(
        appendLogicalVersion(sessionA, target.documentId, {
          versionLabel: `forbidden-${field}`,
          status: "draft",
          [field]: "caller-owned",
        }),
      );
      expect((failed as Error).message).toContain(
        `DocumentVersion binary field ${field} is storage-managed`,
      );
    }
    const state = await sql<{ current_version_id: string; version_count: string }>`
      select document.current_version_id, count(version.id)::text as version_count
      from erp.documents document
      join erp.document_versions version on version.document_id = document.id
      where document.id = ${target.documentId}::uuid
      group by document.current_version_id
    `.execute(privileged.db);
    expect(state.rows[0]).toEqual({
      current_version_id: target.documentVersionId,
      version_count: "1",
    });
  });

  test("inherits tenant-reference guards for logical document and version links", async () => {
    const relationFailure = await rejection(
      createLogicalDocument(
        sessionA,
        {
          title: "Foreign relation",
          documentType: "quote",
          status: "draft",
          relationId: foreignRelationId,
        },
        { versionLabel: "1.0", status: "draft" },
      ),
    );
    expect(sqlState(relationFailure)).toBe("23503");

    const accountFailure = await rejection(
      createLogicalDocument(
        sessionA,
        { title: "Foreign account", documentType: "quote", status: "draft" },
        { versionLabel: "1.0", status: "draft", accountId: foreignAccountId },
      ),
    );
    expect(sqlState(accountFailure)).toBe("23503");
  });

  test("a caller rollback removes both logical rows and their pointer", async () => {
    const title = `Forced rollback ${randomUUID()}`;
    const failure = await rejection(
      withDbSession(restricted.db, sessionA, async (trx) => {
        await sql`
          select *
          from document_internal.create_with_first_version(
            ${JSON.stringify({ title, documentType: "quote", status: "draft" })}::text::jsonb,
            ${JSON.stringify({ versionLabel: "1.0", status: "draft" })}::text::jsonb
          )
        `.execute(trx);
        throw new Error("force caller rollback");
      }),
    );
    expect((failure as Error).message).toContain("force caller rollback");

    const count = await sql<{ documents: string; versions: string }>`
      select
        count(distinct document.id)::text as documents,
        count(version.id)::text as versions
      from erp.documents document
      left join erp.document_versions version on version.document_id = document.id
      where document.title = ${title}
    `.execute(privileged.db);
    expect(count.rows[0]).toEqual({ documents: "0", versions: "0" });
  });
});
