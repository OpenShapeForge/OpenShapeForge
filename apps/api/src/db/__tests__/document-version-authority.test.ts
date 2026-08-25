// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { sql } from "kysely";
import type { DB } from "../../generated/db/types.js";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { withDbSession, type DbSessionInput } from "../session.js";
import {
  appendDocumentVersion,
  createDocumentWithFirstVersion,
} from "../../documents/service.js";
import { createApiApp } from "../../roles/api.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const scratchName = `document_version_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function scratchUrl(role?: { username: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  if (role) {
    url.username = role.username;
    url.password = role.password;
  }
  url.pathname = `/${scratchName}`;
  return url.toString();
}

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const sessionA: DbSessionInput = {
  tenantId: tenantA,
  userId: userA,
  roles: ["CaseFile.All.ReadWrite"],
  scope: "tenant",
};
const sessionB: DbSessionInput = {
  tenantId: tenantB,
  userId: userB,
  roles: ["CaseFile.All.ReadWrite"],
  scope: "tenant",
};

let admin: SQL;
let privileged: DatabaseRuntime;
let restricted: DatabaseRuntime;
let api: ReturnType<typeof createApiApp>;
let first: { documentId: string; documentVersionId: string };

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

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error("unsafe scratch database name");
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 4 });
  await privileged.db.connection().execute((conn) => runMigrationChain(conn));
  restricted = createDatabaseRuntime({
    databaseUrl: scratchUrl({ username: APP_ROLE, password: "openshapeforge_app" }),
    maxConnections: 4,
  });
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??=
    "openshapeforge-local-dev-context-secret";
  api = createApiApp({
    databaseUrl: scratchUrl({ username: APP_ROLE, password: "openshapeforge_app" }),
  });
  await api.ready();
}, TEST_TIMEOUT);

afterAll(async () => {
  await api?.close();
  await restricted?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("DocumentVersion authority", () => {
  test("fresh schema has one artifact truth and read-only app-role grants", async () => {
    const columns = await sql<{ table_name: string; column_name: string; is_nullable: string }>`
      select table_name, column_name, is_nullable
      from information_schema.columns
      where table_schema = 'erp'
        and table_name in ('documents', 'document_versions')
    `.execute(privileged.db);
    const documentColumns = columns.rows
      .filter((row) => row.table_name === "documents")
      .map((row) => row.column_name);
    for (const removed of ["file_name", "mime_type", "storage_location", "version_label", "checksum"]) {
      expect(documentColumns).not.toContain(removed);
    }
    expect(
      columns.rows.find(
        (row) => row.table_name === "document_versions" && row.column_name === "document_id",
      )?.is_nullable,
    ).toBe("NO");

    const grants = await sql<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>`
      select
        has_table_privilege(${APP_ROLE}, 'erp.document_versions', 'select') as can_select,
        has_table_privilege(${APP_ROLE}, 'erp.document_versions', 'insert') as can_insert,
        has_table_privilege(${APP_ROLE}, 'erp.document_versions', 'update') as can_update,
        has_table_privilege(${APP_ROLE}, 'erp.document_versions', 'delete') as can_delete
    `.execute(privileged.db);
    expect(grants.rows[0]).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    });

    const documentGrant = await sql<{ can_insert: boolean }>`
      select has_table_privilege(${APP_ROLE}, 'erp.documents', 'insert') as can_insert
    `.execute(privileged.db);
    expect(documentGrant.rows[0]).toEqual({ can_insert: false });
  });

  test("creates Document, first version and current pointer atomically", async () => {
    first = await createDocumentWithFirstVersion(restricted.db, sessionA, {
      document: { title: "Offer A", documentType: "quote", status: "draft" },
      version: {
        versionLabel: "1.0",
        status: "published",
        fileName: "offer-a.pdf",
        mimeType: "application/pdf",
        storageLocation: "documents/offer-a-v1.pdf",
        checksum: "sha256:first",
      },
    });

    const rows = await sql<{
      document_id: string;
      current_version_id: string;
      version_document_id: string;
      checksum: string;
    }>`
      select document.id as document_id,
             document.current_version_id,
             version.document_id as version_document_id,
             version.checksum
      from erp.documents document
      join erp.document_versions version on version.id = document.current_version_id
      where document.id = ${first.documentId}::uuid
    `.execute(privileged.db);
    expect(rows.rows[0]).toEqual({
      document_id: first.documentId,
      current_version_id: first.documentVersionId,
      version_document_id: first.documentId,
      checksum: "sha256:first",
    });
  });

  test("database commands fail closed when the required role is absent", async () => {
    const error = await rejection(
      restricted.db.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenantA}, true)`.execute(trx);
        await sql`select set_config('app.user_id', ${userA}, true)`.execute(trx);
        const roleSetting = await sql<{ roles: string | null }>`
          select current_setting('app.roles', true) as roles
        `.execute(trx);
        expect(roleSetting.rows[0]?.roles ?? null).toBeNull();
        return sql`
          select app.create_document_with_first_version(
            ${JSON.stringify({ title: "Unauthorized", documentType: "quote", status: "draft" })}::text::jsonb,
            ${JSON.stringify({ versionLabel: "1.0", status: "draft" })}::text::jsonb
          )
        `.execute(trx);
      }),
    );
    expect((error as Error).message).toContain("Not authorized to create Document");
  });

  test("database commands reject JSON types that bypass REST parsing", async () => {
    const invalidInputs = [
      {
        document: { title: { nested: "not a string" }, documentType: "quote", status: "draft" },
        version: { versionLabel: "1.0", status: "draft" },
        expected: "Document input field title has an invalid JSON type",
      },
      {
        document: { title: "Typed offer", documentType: "quote", status: "draft" },
        version: { versionLabel: "1.0", status: "draft", isMajorVersion: "yes" },
        expected: "DocumentVersion input field isMajorVersion has an invalid JSON type",
      },
    ];
    for (const input of invalidInputs) {
      const error = await rejection(
        withDbSession(restricted.db, sessionA, (trx) =>
          sql`
            select app.create_document_with_first_version(
              ${JSON.stringify(input.document)}::text::jsonb,
              ${JSON.stringify(input.version)}::text::jsonb
            )
          `.execute(trx),
        ),
      );
      expect((error as Error).message).toContain(input.expected);
    }
  });

  test("exposes the atomic commands as authenticated HTTP APIs", async () => {
    const unauthenticated = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(unauthenticated.statusCode).toBe(401);

    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(headers, {
      tenantId: tenantA,
      userId: userA,
      roles: ["CaseFile.All.ReadWrite"],
    }, {
      secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET!,
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: Object.fromEntries(headers.entries()),
      payload: JSON.stringify({
        document: { title: "HTTP offer", documentType: "quote", status: "draft" },
        version: { versionLabel: "1.0", status: "draft", checksum: "sha256:http-1" },
      }),
    });
    expect(created.statusCode).toBe(201);
    const ids = created.json() as { documentId: string; documentVersionId: string };
    expect(UUID_PATTERN.test(ids.documentId)).toBe(true);
    expect(UUID_PATTERN.test(ids.documentVersionId)).toBe(true);

    const appended = await api.inject({
      method: "POST",
      url: `/api/documents/${ids.documentId}/versions`,
      headers: Object.fromEntries(headers.entries()),
      payload: JSON.stringify({
        version: { versionLabel: "1.1", status: "published", checksum: "sha256:http-2" },
      }),
    });
    expect(appended.statusCode).toBe(201);
    expect(appended.json().documentId).toBe(ids.documentId);
  });

  test("generated transports and the database reject direct current-pointer changes", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(headers, {
      tenantId: tenantA,
      userId: userA,
      roles: ["CaseFile.All.ReadWrite"],
    }, {
      secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET!,
    });
    const response = await api.inject({
      method: "POST",
      url: "/api/graphql",
      headers: Object.fromEntries(headers.entries()),
      payload: JSON.stringify({
        query: `mutation($input: UpdateDocumentInput!) {
          updateDocument(input: $input) { id }
        }`,
        variables: {
          input: {
            id: first.documentId,
            currentVersionId: first.documentVersionId,
          },
        },
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors?.[0]?.message).toContain("currentVersionId");

    const direct = await rejection(
      withDbSession(restricted.db, sessionA, (trx) =>
        sql`
          update erp.documents
          set current_version_id = null
          where id = ${first.documentId}::uuid
        `.execute(trx),
      ),
    );
    expect((direct as Error).message).toContain("currentVersionId is server-managed");
    const pointer = await sql<{ current_version_id: string }>`
      select current_version_id from erp.documents where id = ${first.documentId}::uuid
    `.execute(privileged.db);
    expect(pointer.rows[0]?.current_version_id).toBe(first.documentVersionId);
  });

  test("serializes concurrent appends and preserves one consistent current pointer", async () => {
    const created = await Promise.all([
      appendDocumentVersion(restricted.db, sessionA, first.documentId, {
        versionLabel: "1.1",
        status: "draft",
        checksum: "sha256:second",
      }),
      appendDocumentVersion(restricted.db, sessionA, first.documentId, {
        versionLabel: "1.2",
        status: "published",
        checksum: "sha256:third",
      }),
    ]);
    const state = await sql<{ current_version_id: string; count: string }>`
      select document.current_version_id, count(version.id)::text as count
      from erp.documents document
      join erp.document_versions version
        on version.tenant_id = document.tenant_id
       and version.document_id = document.id
      where document.id = ${first.documentId}::uuid
      group by document.current_version_id
    `.execute(privileged.db);
    expect(state.rows[0]?.count).toBe("3");
    const currentVersionId = state.rows[0]?.current_version_id;
    expect(currentVersionId).toBeDefined();
    expect(created.map((item) => item.documentVersionId)).toContain(currentVersionId!);

    const duplicate = await rejection(
      appendDocumentVersion(restricted.db, sessionA, first.documentId, {
        versionLabel: "1.2",
        status: "draft",
      }),
    );
    expect(sqlState(duplicate)).toBe("23505");
  });

  test("the database guard blocks every direct app-role write", async () => {
    const deniedDocumentInsert = await rejection(
      withDbSession(restricted.db, sessionA, (trx) =>
        sql`
          insert into erp.documents (tenant_id, title, document_type, status)
          values (${tenantA}::uuid, 'Direct document', 'quote', 'draft')
        `.execute(trx),
      ),
    );
    expect(sqlState(deniedDocumentInsert)).toBe("42501");

    await sql`grant insert on erp.documents to ${sql.ref(APP_ROLE)}`.execute(privileged.db);
    await sql`grant insert, update, delete on erp.document_versions to ${sql.ref(APP_ROLE)}`.execute(
      privileged.db,
    );
    try {
      const guardedDocumentInsert = await rejection(
        withDbSession(restricted.db, sessionA, (trx) =>
          sql`
            insert into erp.documents (tenant_id, title, document_type, status)
            values (${tenantA}::uuid, 'Direct document', 'quote', 'draft')
          `.execute(trx),
        ),
      );
      expect((guardedDocumentInsert as Error).message).toContain("created atomically");

      const attempts = [
        () => withDbSession(restricted.db, sessionA, (trx) =>
          sql`
            insert into erp.document_versions
              (tenant_id, version_label, status, document_id)
            values (${tenantA}::uuid, 'direct', 'draft', ${first.documentId}::uuid)
          `.execute(trx),
        ),
        () => withDbSession(restricted.db, sessionA, (trx) =>
          sql`update erp.document_versions set status = 'changed' where id = ${first.documentVersionId}::uuid`.execute(trx),
        ),
        () => withDbSession(restricted.db, sessionA, (trx) =>
          sql`delete from erp.document_versions where id = ${first.documentVersionId}::uuid`.execute(trx),
        ),
      ];
      for (const attempt of attempts) {
        const error = await rejection(attempt());
        expect((error as Error).message).toContain("DocumentVersion is immutable");
      }
    } finally {
      await sql`revoke insert on erp.documents from ${sql.ref(APP_ROLE)}`.execute(privileged.db);
      await sql`revoke insert, update, delete on erp.document_versions from ${sql.ref(APP_ROLE)}`.execute(
        privileged.db,
      );
    }
  });

  test("composite foreign keys reject cross-tenant and cross-document pointers", async () => {
    const secondA = await createDocumentWithFirstVersion(restricted.db, sessionA, {
      document: { title: "Offer A2", documentType: "quote", status: "draft" },
      version: { versionLabel: "1.0", status: "draft" },
    });
    const firstB = await createDocumentWithFirstVersion(restricted.db, sessionB, {
      document: { title: "Offer B", documentType: "quote", status: "draft" },
      version: { versionLabel: "1.0", status: "draft" },
    });

    const crossDocument = await rejection(
      sql`
        update erp.documents
        set current_version_id = ${secondA.documentVersionId}::uuid
        where id = ${first.documentId}::uuid
      `.execute(privileged.db),
    );
    expect(sqlState(crossDocument)).toBe("23503");

    const crossTenantPointer = await rejection(
      sql`
        update erp.documents
        set current_version_id = ${firstB.documentVersionId}::uuid
        where id = ${first.documentId}::uuid
      `.execute(privileged.db),
    );
    expect(sqlState(crossTenantPointer)).toBe("23503");

    const crossTenantOwner = await rejection(
      sql`
        insert into erp.document_versions
          (tenant_id, version_label, status, document_id)
        values (${tenantB}::uuid, 'foreign-owner', 'draft', ${first.documentId}::uuid)
      `.execute(privileged.db),
    );
    expect(sqlState(crossTenantOwner)).toBe("23503");
  });

  test("document commands reject every cross-tenant optional reference", async () => {
    const accountB = randomUUID();
    const relationB = randomUUID();
    const caseB = randomUUID();
    const caseFileB = randomUUID();
    await sql`
      insert into erp.accounts (id, tenant_id, username, email, status)
      values (${accountB}::uuid, ${tenantB}::uuid, ${`account-${accountB}`}, ${`${accountB}@example.test`}, 'active')
    `.execute(privileged.db);
    await sql`
      insert into erp.relations (id, tenant_id, display_name, relation_type)
      values (${relationB}::uuid, ${tenantB}::uuid, 'Tenant B relation', 'organization')
    `.execute(privileged.db);
    await sql`
      insert into erp.cases (
        id, tenant_id, code, title, case_type, status, registered_at, portal_visible
      ) values (
        ${caseB}::uuid, ${tenantB}::uuid, ${`case-${caseB}`}, 'Tenant B case',
        'request', 'open', now(), true
      )
    `.execute(privileged.db);
    await sql`
      insert into erp.case_files (id, tenant_id, code, title, case_file_type, status)
      values (
        ${caseFileB}::uuid, ${tenantB}::uuid, ${`file-${caseFileB}`},
        'Tenant B case file', 'case', 'open'
      )
    `.execute(privileged.db);

    const documentReferences = [
      { caseFileId: caseFileB },
      { caseId: caseB },
      { relationId: relationB },
    ];
    for (const reference of documentReferences) {
      const error = await rejection(
        createDocumentWithFirstVersion(restricted.db, sessionA, {
          document: {
            title: "Cross-tenant offer",
            documentType: "quote",
            status: "draft",
            ...reference,
          },
          version: { versionLabel: "1.0", status: "draft" },
        }),
      );
      expect(sqlState(error)).toBe("23503");
    }

    const accountError = await rejection(
      createDocumentWithFirstVersion(restricted.db, sessionA, {
        document: { title: "Cross-tenant account", documentType: "quote", status: "draft" },
        version: { versionLabel: "1.0", status: "draft", accountId: accountB },
      }),
    );
    expect(sqlState(accountError)).toBe("23503");
  });

  test("a failed first-version insert rolls the container back", async () => {
    const title = `Rollback ${randomUUID()}`;
    const failed = await rejection(
      createDocumentWithFirstVersion(restricted.db, sessionA, {
        document: { title, documentType: "quote", status: "draft" },
        version: {
          versionLabel: "1.0",
          status: "draft",
          accountId: randomUUID(),
        },
      }),
    );
    expect(sqlState(failed)).toBe("23503");
    const count = await sql<{ count: string }>`
      select count(*)::text as count from erp.documents where title = ${title}
    `.execute(privileged.db);
    expect(count.rows[0]?.count).toBe("0");
  });
});
