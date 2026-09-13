// SPDX-License-Identifier: BUSL-1.1
/**
 * Real PostgreSQL evidence for the DocumentVersion/artifact association seam.
 *
 * Storage's own registry is deliberately outside this public package. These
 * tests prove the public half of the shared transaction: a provisional opaque
 * id is visible to the storage authorizer, but neither it nor the advanced
 * Document pointer can commit until trusted descriptor facts finalize the
 * exact expected artifact version.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../migrations/app-role.js";
import artifactBindingMigration from "../migrations/versioned/0014_document-artifact-binding.js";
import { DEV_WORKER_ROLE_PASSWORD_DEFAULT, WORKER_ROLE } from "../migrations/worker-role.js";
import { type DbSessionInput, withDbSession } from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const scratchName = `document_artifact_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tenantId = randomUUID();
const userId = randomUUID();
const session: DbSessionInput = { tenantId, userId, roles: [], scope: "tenant" };
const sha256 = "b".repeat(64);

let admin: SQL;
let privileged: DatabaseRuntime;
let restricted: DatabaseRuntime;
let worker: DatabaseRuntime;

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

async function createWithArtifact(
  trx: Transaction<DB>,
  title: string,
  artifactId: string,
  expectedVersion = 2,
): Promise<{ documentId: string; documentVersionId: string }> {
  const result = await sql<{ document_id: string; document_version_id: string }>`
    select document_id, document_version_id
    from document_internal.create_with_first_version_and_artifact(
      ${JSON.stringify({ title, documentType: "memo", status: "draft" })}::text::jsonb,
      ${JSON.stringify({ versionLabel: "1", status: "draft" })}::text::jsonb,
      ${artifactId}::uuid,
      ${expectedVersion}::bigint
    )
  `.execute(trx);
  const row = result.rows[0];
  if (!row) throw new Error("artifact Document command returned no row");
  return { documentId: row.document_id, documentVersionId: row.document_version_id };
}

async function finalize(
  trx: Transaction<DB>,
  documentVersionId: string,
  artifactId: string,
  expectedVersion = 2,
): Promise<void> {
  await sql`
    select document_internal.finalize_artifact_binding(
      ${documentVersionId}::uuid,
      ${artifactId}::uuid,
      ${expectedVersion}::bigint,
      ${expectedVersion + 1}::bigint,
      'inspected.docx'::text,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'::text,
      ${sha256}::text,
      8192::bigint
    )
  `.execute(trx);
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName)) {
    throw new Error(`unsafe scratch database name: ${scratchName}`);
  }
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 4 });
  await privileged.db.connection().execute((conn) => runMigrationChain(conn));
  await artifactBindingMigration.up(privileged.db);
  await artifactBindingMigration.up(privileged.db);
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
    values (
      ${tenantId}::uuid,
      ${`document-artifact-${tenantId.slice(0, 8)}`},
      'Document artifact tenant',
      'active'
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

describe("Document artifact binding migration", () => {
  test("exposes only the three narrow commands to the app role", async () => {
    const privileges = await sql<{
      app_create: boolean;
      app_append: boolean;
      app_finalize: boolean;
      worker_create: boolean;
      worker_append: boolean;
      worker_finalize: boolean;
      public_grants: string;
    }>`
      select
        has_function_privilege(
          ${APP_ROLE},
          'document_internal.create_with_first_version_and_artifact(jsonb,jsonb,uuid,bigint)',
          'EXECUTE'
        ) as app_create,
        has_function_privilege(
          ${APP_ROLE},
          'document_internal.append_version_with_artifact(uuid,jsonb,uuid,bigint)',
          'EXECUTE'
        ) as app_append,
        has_function_privilege(
          ${APP_ROLE},
          'document_internal.finalize_artifact_binding(uuid,uuid,bigint,bigint,text,text,text,bigint)',
          'EXECUTE'
        ) as app_finalize,
        has_function_privilege(
          ${WORKER_ROLE},
          'document_internal.create_with_first_version_and_artifact(jsonb,jsonb,uuid,bigint)',
          'EXECUTE'
        ) as worker_create,
        has_function_privilege(
          ${WORKER_ROLE},
          'document_internal.append_version_with_artifact(uuid,jsonb,uuid,bigint)',
          'EXECUTE'
        ) as worker_append,
        has_function_privilege(
          ${WORKER_ROLE},
          'document_internal.finalize_artifact_binding(uuid,uuid,bigint,bigint,text,text,text,bigint)',
          'EXECUTE'
        ) as worker_finalize,
        (
          select count(*)::text
          from information_schema.routine_privileges
          where routine_schema = 'document_internal' and grantee = 'PUBLIC'
        ) as public_grants
    `.execute(privileged.db);
    expect(privileges.rows[0]).toEqual({
      app_create: true,
      app_append: true,
      app_finalize: true,
      worker_create: false,
      worker_append: false,
      worker_finalize: false,
      public_grants: "0",
    });

    const denied = await rejection(
      sql`
        select document_internal.finalize_artifact_binding(
          ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, 2,
          'x.pdf', 'application/pdf', ${sha256}, 1
        )
      `.execute(worker.db),
    );
    expect(sqlState(denied)).toBe("42501");
  });

  test("keeps the metadata-only command usable without an artifact provider", async () => {
    const created = await withDbSession(restricted.db, session, async (trx) => {
      const result = await sql<{ document_id: string; document_version_id: string }>`
        select document_id, document_version_id
        from document_internal.create_with_first_version(
          ${JSON.stringify({ title: "Metadata only", documentType: "memo", status: "draft" })}::text::jsonb,
          ${JSON.stringify({ versionLabel: "1", status: "draft" })}::text::jsonb
        )
      `.execute(trx);
      return result.rows[0];
    });
    const row = await sql<{
      artifact_id: string | null;
      artifact_version: string | null;
      byte_size: string | null;
    }>`
      select artifact_id, artifact_version::text, byte_size::text
      from erp.document_versions
      where id = ${created?.document_version_id}::uuid
    `.execute(privileged.db);
    expect(row.rows[0]).toEqual({ artifact_id: null, artifact_version: null, byte_size: null });
  });

  test("persists only finalized trusted facts and advances the matching head", async () => {
    const artifactId = randomUUID();
    const created = await withDbSession(restricted.db, session, async (trx) => {
      const ids = await createWithArtifact(trx, "Bound document", artifactId);
      const provisional = await sql<{
        artifact_id: string;
        artifact_version: string;
        byte_size: string | null;
      }>`
        select artifact_id, artifact_version::text, byte_size::text
        from erp.document_versions
        where tenant_id = app.current_tenant() and id = ${ids.documentVersionId}::uuid
      `.execute(trx);
      expect(provisional.rows[0]).toEqual({
        artifact_id: artifactId,
        artifact_version: "2",
        byte_size: null,
      });
      await finalize(trx, ids.documentVersionId, artifactId);
      return ids;
    });

    const stored = await sql<{
      document_id: string;
      current_version_id: string;
      version_id: string;
      artifact_id: string;
      artifact_version: string;
      byte_size: string;
      file_name: string;
      mime_type: string;
      checksum: string;
      storage_location: string | null;
    }>`
      select document.id as document_id, document.current_version_id,
        version.id as version_id, version.artifact_id, version.artifact_version::text,
        version.byte_size::text, version.file_name, version.mime_type,
        version.checksum, version.storage_location
      from erp.documents document
      join erp.document_versions version
        on version.tenant_id = document.tenant_id
       and version.id = document.current_version_id
      where document.id = ${created.documentId}::uuid
    `.execute(privileged.db);
    expect(stored.rows[0]).toEqual({
      document_id: created.documentId,
      current_version_id: created.documentVersionId,
      version_id: created.documentVersionId,
      artifact_id: artifactId,
      artifact_version: "3",
      byte_size: "8192",
      file_name: "inspected.docx",
      mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      checksum: sha256,
      storage_location: null,
    });
  });

  test("rejects an unfinished bind at commit and rolls back its head and pointer", async () => {
    const artifactId = randomUUID();
    const title = `Unfinished ${randomUUID()}`;
    const failed = await rejection(
      withDbSession(restricted.db, session, (trx) =>
        createWithArtifact(trx, title, artifactId),
      ),
    );
    expect((failed as Error).message).toContain("artifact binding is incomplete");

    const count = await sql<{ documents: string; versions: string }>`
      select count(distinct document.id)::text as documents, count(version.id)::text as versions
      from erp.documents document
      left join erp.document_versions version on version.document_id = document.id
      where document.title = ${title}
    `.execute(privileged.db);
    expect(count.rows[0]).toEqual({ documents: "0", versions: "0" });
  });

  test("still rejects an unfinished bind if the transaction tenant GUC is changed", async () => {
    const artifactId = randomUUID();
    const title = `Changed tenant ${randomUUID()}`;
    const failed = await rejection(
      withDbSession(restricted.db, session, async (trx) => {
        await createWithArtifact(trx, title, artifactId);
        await sql`select set_config('app.tenant_id', ${randomUUID()}, true)`.execute(trx);
      }),
    );
    expect((failed as Error).message).toContain("artifact binding is incomplete");

    const count = await sql<{ documents: string; versions: string }>`
      select count(distinct document.id)::text as documents, count(version.id)::text as versions
      from erp.documents document
      left join erp.document_versions version on version.document_id = document.id
      where document.title = ${title}
    `.execute(privileged.db);
    expect(count.rows[0]).toEqual({ documents: "0", versions: "0" });
  });

  test("a stale artifact CAS rolls back both the version and head advance", async () => {
    const artifactId = randomUUID();
    const title = `Stale ${randomUUID()}`;
    const failed = await rejection(
      withDbSession(restricted.db, session, async (trx) => {
        const created = await createWithArtifact(trx, title, artifactId, 2);
        await finalize(trx, created.documentVersionId, artifactId, 1);
      }),
    );
    expect((failed as Error).message).toContain("could not be finalized");

    const count = await sql<{ documents: string; versions: string }>`
      select count(distinct document.id)::text as documents, count(version.id)::text as versions
      from erp.documents document
      left join erp.document_versions version on version.document_id = document.id
      where document.title = ${title}
    `.execute(privileged.db);
    expect(count.rows[0]).toEqual({ documents: "0", versions: "0" });
  });

  test("keeps artifact ownership unique and finalized facts immutable to the app role", async () => {
    const artifactId = randomUUID();
    const first = await withDbSession(restricted.db, session, async (trx) => {
      const ids = await createWithArtifact(trx, "Unique artifact owner", artifactId);
      await finalize(trx, ids.documentVersionId, artifactId);
      return ids;
    });

    const duplicate = await rejection(
      withDbSession(restricted.db, session, async (trx) => {
        await createWithArtifact(trx, "Duplicate artifact owner", artifactId);
      }),
    );
    expect(sqlState(duplicate)).toBe("23505");

    const mutation = await rejection(
      withDbSession(restricted.db, session, (trx) =>
        sql`
          update erp.document_versions set byte_size = 1
          where tenant_id = app.current_tenant() and id = ${first.documentVersionId}::uuid
        `.execute(trx),
      ),
    );
    expect(sqlState(mutation)).toBe("42501");
  });
});
