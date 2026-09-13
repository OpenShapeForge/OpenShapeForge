// SPDX-License-Identifier: BUSL-1.1
/**
 * Compatibility evidence for the two historical Document command URLs.
 *
 * The routes retain their old request and success envelopes, but execution is
 * the same generated Entity Operation used by REST, GraphQL, MCP and Web. The
 * tests therefore boot the real module registry and restricted app role.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { SQL } from "bun";
import { sql } from "kysely";
import { loadRuntimeModules } from "../../modules/registry.js";
import { createApiApp } from "../../roles/api.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE, DEV_APP_ROLE_PASSWORD_DEFAULT } from "../migrations/app-role.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const scratchName = `document_routes_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const tenantId = randomUUID();
const userId = randomUUID();
const roles = ["CaseFile.All.ReadWrite"];

let admin: SQL;
let privileged: DatabaseRuntime;
let api: ReturnType<typeof createApiApp>;

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

function requestHeaders(
  activeRoles: readonly string[],
  idempotencyKey?: string,
): Record<string, string> {
  const secret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  if (!secret) throw new Error("OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is required by this test.");
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
  applyTrustedContextHeaders(headers, { tenantId, userId, roles: [...activeRoles] }, { secret });
  return Object.fromEntries(headers.entries());
}

function documentBody(title: string, versionLabel = "1.0") {
  return {
    document: {
      title,
      documentType: "incoming_mail",
      status: "draft",
    },
    version: { versionLabel, status: "draft" },
  };
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratchName)) {
    throw new Error(`unsafe scratch database name: ${scratchName}`);
  }
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  privileged = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 2 });

  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);
  const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);
  await privileged.db
    .connection()
    .execute((connection) => runMigrationChain(connection, { moduleSeeds }));
  await sql`
    insert into platform.tenants (id, slug, name, status)
    values (${tenantId}::uuid, ${`document-routes-${tenantId.slice(0, 8)}`}, 'Document routes', 'active')
  `.execute(privileged.db);

  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ??= "openshapeforge-local-dev-context-secret";
  api = createApiApp({
    cors: false,
    databaseUrl: scratchUrl({
      username: APP_ROLE,
      password: process.env.OPENSHAPEFORGE_APP_PASSWORD ?? DEV_APP_ROLE_PASSWORD_DEFAULT,
    }),
    modules,
  });
  await api.ready();
}, TEST_TIMEOUT);

afterAll(async () => {
  await api?.close();
  await privileged?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

describe("legacy Document command URL adapters", () => {
  test("requires authentication and a caller-supplied idempotency key", async () => {
    const unauthenticated = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(documentBody("Unauthenticated")),
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("UNAUTHENTICATED");

    const missingKey = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles),
      payload: JSON.stringify(documentBody("Missing key")),
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const bodyKey = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles, "header-key"),
      payload: JSON.stringify({
        ...documentBody("Body key"),
        idempotencyKey: "body-key",
      }),
    });
    expect(bodyKey.statusCode).toBe(400);
    expect(bodyKey.json().error.code).toBe("BAD_USER_INPUT");
  });

  test("checks canonical authorization before nested input validation", async () => {
    const response = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders([], `unauthorized-${randomUUID()}`),
      payload: JSON.stringify({
        document: { title: 42 },
        version: { fileName: "must-not-reveal-schema.pdf" },
      }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  test("replays the canonical create while retaining the legacy success envelope", async () => {
    const title = `Canonical legacy URL ${randomUUID()}`;
    const key = `create-${randomUUID()}`;
    const payload = JSON.stringify(documentBody(title));
    const first = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles, key),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstIds = first.json() as {
      documentId: string;
      documentVersionId: string;
    };
    expect(UUID_PATTERN.test(firstIds.documentId)).toBe(true);
    expect(UUID_PATTERN.test(firstIds.documentVersionId)).toBe(true);

    const replay = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles, key),
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json() as typeof firstIds).toEqual(firstIds);

    const changed = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles, key),
      payload: JSON.stringify(documentBody(`${title} changed`)),
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const persisted = await sql<{ documents: string; versions: string }>`
      select
        count(distinct document.id)::text as documents,
        count(version.id)::text as versions
      from erp.documents document
      join erp.document_versions version on version.document_id = document.id
      where document.id = ${firstIds.documentId}::uuid
    `.execute(privileged.db);
    expect(persisted.rows[0]).toEqual({ documents: "1", versions: "1" });
  });

  test("lets only the canonical schema decide enums and binary-field ownership", async () => {
    const invalidEnum = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles, `enum-${randomUUID()}`),
      payload: JSON.stringify({
        ...documentBody(`Invalid enum ${randomUUID()}`),
        document: {
          title: "Invalid enum",
          documentType: "legacy-free-text-type",
          status: "draft",
        },
      }),
    });
    expect(invalidEnum.statusCode).toBe(400);
    expect(invalidEnum.json().error.code).toBe("BAD_USER_INPUT");

    for (const [field, value] of Object.entries({
      fileName: "caller.pdf",
      mimeType: "application/pdf",
      storageLocation: "caller/controlled/path.pdf",
      checksum: "sha256:caller-controlled",
    })) {
      const title = `Binary refusal ${field} ${randomUUID()}`;
      const binary = await api.inject({
        method: "POST",
        url: "/api/documents",
        headers: requestHeaders(roles, `binary-${randomUUID()}`),
        payload: JSON.stringify({
          ...documentBody(title),
          version: {
            versionLabel: "1.0",
            status: "draft",
            [field]: value,
          },
        }),
      });
      expect(binary.statusCode).toBe(400);
      expect(binary.json().error.code).toBe("BAD_USER_INPUT");
      const count = await sql<{ count: string }>`
        select count(*)::text as count from erp.documents where title = ${title}
      `.execute(privileged.db);
      expect(count.rows[0]?.count).toBe("0");
    }
  });

  test("replays a canonical version append without duplicating the version", async () => {
    const createKey = `append-parent-${randomUUID()}`;
    const created = await api.inject({
      method: "POST",
      url: "/api/documents",
      headers: requestHeaders(roles, createKey),
      payload: JSON.stringify(documentBody(`Append parent ${randomUUID()}`)),
    });
    expect(created.statusCode).toBe(201);
    const parent = created.json() as { documentId: string; documentVersionId: string };

    const appendKey = `append-${randomUUID()}`;
    const appendPayload = JSON.stringify({
      version: { versionLabel: "1.1", status: "final", changeSummary: "Final version" },
    });
    const first = await api.inject({
      method: "POST",
      url: `/api/documents/${parent.documentId}/versions`,
      headers: requestHeaders(roles, appendKey),
      payload: appendPayload,
    });
    expect(first.statusCode).toBe(201);
    const firstIds = first.json() as { documentId: string; documentVersionId: string };
    expect(firstIds.documentId).toBe(parent.documentId);
    expect(UUID_PATTERN.test(firstIds.documentVersionId)).toBe(true);

    const replay = await api.inject({
      method: "POST",
      url: `/api/documents/${parent.documentId}/versions`,
      headers: requestHeaders(roles, appendKey),
      payload: appendPayload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json() as typeof firstIds).toEqual(firstIds);

    const changed = await api.inject({
      method: "POST",
      url: `/api/documents/${parent.documentId}/versions`,
      headers: requestHeaders(roles, appendKey),
      payload: JSON.stringify({ version: { versionLabel: "1.2", status: "final" } }),
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const state = await sql<{ current_version_id: string; version_count: string }>`
      select document.current_version_id, count(version.id)::text as version_count
      from erp.documents document
      join erp.document_versions version on version.document_id = document.id
      where document.id = ${parent.documentId}::uuid
      group by document.current_version_id
    `.execute(privileged.db);
    expect(state.rows[0]).toEqual({
      current_version_id: firstIds.documentVersionId,
      version_count: "2",
    });
  });
});
