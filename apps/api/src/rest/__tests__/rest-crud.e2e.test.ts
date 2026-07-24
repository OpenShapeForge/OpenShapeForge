// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated REST API e2e suite — the REST counterpart of the manifest-driven
 * GraphQL entity-crud suite. Drives the full Fastify app (createApiApp) via
 * inject(), or E2E_API_URL over HTTP when set, for every entity that opted in
 * with a `rest:` block. Row setup/cleanup reuses the shared GraphQL harness so
 * both APIs are exercised against the same data and RLS session plumbing.
 */
import { afterAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createApiApp } from "../../roles/api.js";
import { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "../generated-rest-routes.js";
import {
  createdRows,
  describe,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  remoteUrl,
  seed,
  tenantA,
  tenantB,
  test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";
import {
  createRow,
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  sampleValue,
  tables,
  tablesByName,
  textColumnFor,
  untrackRow,
} from "../../graphql/__tests__/e2e/entity-factory.js";

registerSuiteLifecycle();

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

const restTables = tables.filter((table) => table.source?.rest);

let app: ReturnType<typeof createApiApp> | null = null;
function getApp() {
  app ??= createApiApp(
    process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {},
  );
  return app;
}

afterAll(async () => {
  await app?.close();
  app = null;
});

type RestResponse = { status: number; body: any };

async function rest(
  identity: Identity | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  options: { rawPayload?: string } = {},
): Promise<RestResponse> {
  const headers = new Headers();
  if (identity) {
    applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  }
  const body =
    options.rawPayload ?? (payload === undefined ? undefined : JSON.stringify(payload));
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${url}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const response = await getApp().inject({
    method,
    url,
    headers: Object.fromEntries(headers.entries()),
    ...(body === undefined ? {} : { payload: body }),
  });
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}

/**
 * Builds a valid REST create body: sample values for required non-FK columns,
 * recursively created (GraphQL-tracked) rows for required foreign keys —
 * the same assembly rules as entity-factory's createRow.
 */
async function buildCreateBody(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const fkTargets = foreignKeyTargets(table);
  const body: Record<string, unknown> = { ...overrides };
  for (const column of table.columns) {
    if (!isMutableColumn(column)) continue;
    const field = fieldName(column);
    if (field in body) continue;
    const fkTarget = fkTargets.get(column.name);
    if (fkTarget) {
      if (column.required) {
        const targetTable = tablesByName.get(fkTarget);
        if (!targetTable) {
          throw new Error(`Required FK ${table.name}.${column.name} targets unknown table ${fkTarget}`);
        }
        body[field] = await createRow(targetTable, identity);
      }
      continue;
    }
    if (column.required) {
      body[field] = sampleValue(column, `rest-${seed}`);
    }
  }
  return body;
}

function trackRestRow(table: (typeof restTables)[number], id: string, identity: Identity) {
  createdRows.push({ table, id, identity });
}

describe("REST transport", () => {
  test("manifest exposes at least one rest-enabled entity", () => {
    expect(restTables.length).toBeGreaterThan(0);
  });

  test("openapi.json is served without authentication", async () => {
    const response = await rest(null, "GET", REST_OPENAPI_PATH);
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.1.0");
    for (const table of restTables) {
      expect(response.body.paths).toHaveProperty(
        `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`,
      );
    }
  });

  test("requests without credentials fail closed with 401", async () => {
    const base = `${REST_MOUNT_PATH}/${restTables[0]!.source!.rest!.basePath}`;
    const response = await rest(null, "GET", base);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("malformed JSON bodies are rejected with 400", async () => {
    const base = `${REST_MOUNT_PATH}/${restTables[0]!.source!.rest!.basePath}`;
    const response = await rest(tenantA, "POST", base, undefined, {
      rawPayload: "{not json",
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("BAD_USER_INPUT");
  });
});

describe("REST entity role enforcement", () => {
  const table = restTables[0]!;
  const base = `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`;

  test("a session without roles gets 403 FORBIDDEN on every operation", async () => {
    const id = await createRow(table, tenantA);
    for (const attempt of [
      () => rest(noRoles, "GET", base),
      () => rest(noRoles, "GET", `${base}/${id}`),
      () => rest(noRoles, "POST", base, {}),
      () => rest(noRoles, "PATCH", `${base}/${id}`, {}),
      () => rest(noRoles, "DELETE", `${base}/${id}`),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  test("a read-only session can GET but not mutate (empty PATCH included)", async () => {
    const id = await createRow(table, tenantA);

    const list = await rest(readOnly, "GET", `${base}?id=${id}`);
    expect(list.status).toBe(200);
    expect(list.body.totalCount).toBe(1);

    const single = await rest(readOnly, "GET", `${base}/${id}`);
    expect(single.status).toBe(200);

    for (const attempt of [
      () => rest(readOnly, "POST", base, {}),
      () => rest(readOnly, "PATCH", `${base}/${id}`, {}),
      () => rest(readOnly, "DELETE", `${base}/${id}`),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });
});

for (const table of restTables) {
  const rest_ = table.source!.rest!;
  const base = `${REST_MOUNT_PATH}/${rest_.basePath}`;

  describe(`${rest_.basePath} (${table.name})`, () => {
    test("POST creates (201) and GET /:id fetches with camelCase fields", async () => {
      const body = await buildCreateBody(table, tenantA);
      const created = await rest(tenantA, "POST", base, body);
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect(id).toBeTruthy();
      trackRestRow(table, id, tenantA);
      expect(created.body.createdAt).toBeTruthy();
      expect(Object.keys(created.body).some((key) => key.includes("_"))).toBe(false);

      const fetched = await rest(tenantA, "GET", `${base}/${id}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.id).toBe(id);
    });

    test("POST with an unknown body field is rejected with 400", async () => {
      const body = await buildCreateBody(table, tenantA, { nopeField: "x" });
      const response = await rest(tenantA, "POST", base, body);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain("nopeField");
    });

    test("GET list filters by query params (eq and repeated → In)", async () => {
      const id = await createRow(table, tenantA);
      const eq = await rest(tenantA, "GET", `${base}?id=${id}`);
      expect(eq.status).toBe(200);
      expect(eq.body.totalCount).toBe(1);
      expect(eq.body.items[0].id).toBe(id);

      const inFilter = await rest(
        tenantA,
        "GET",
        `${base}?id=${id}&id=${randomUUID()}`,
      );
      expect(inFilter.status).toBe(200);
      expect(inFilter.body.totalCount).toBe(1);

      // Explicit `<field>In` naming (the GraphQL filter convention) must
      // behave identically — single value included, which previously would
      // have been silently dropped by the CRUD layer's array check.
      const inSingle = await rest(tenantA, "GET", `${base}?idIn=${id}`);
      expect(inSingle.status).toBe(200);
      expect(inSingle.body.totalCount).toBe(1);

      const inRepeated = await rest(
        tenantA,
        "GET",
        `${base}?idIn=${id}&idIn=${randomUUID()}`,
      );
      expect(inRepeated.status).toBe(200);
      expect(inRepeated.body.totalCount).toBe(1);
    });

    test("GET list paginates with first/after without overlap", async () => {
      const ids = [
        await createRow(table, tenantA),
        await createRow(table, tenantA),
        await createRow(table, tenantA),
      ];
      const idParams = ids.map((id) => `id=${id}`).join("&");
      const page1 = await rest(tenantA, "GET", `${base}?${idParams}&first=2`);
      expect(page1.status).toBe(200);
      expect(page1.body.totalCount).toBe(3);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toBeTruthy();

      const page2 = await rest(
        tenantA,
        "GET",
        `${base}?${idParams}&first=2&after=${encodeURIComponent(page1.body.nextCursor)}`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      const seen = [...page1.body.items, ...page2.body.items].map((item: any) => item.id);
      expect(new Set(seen).size).toBe(3);
    });

    test("GET list rejects an unknown filter field with 400", async () => {
      const response = await rest(tenantA, "GET", `${base}?definitelyNotAField=x`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("BAD_USER_INPUT");
    });

    const sortColumn = textColumnFor(table);
    if (sortColumn) {
      const field = fieldName(sortColumn);
      test(`GET list sorts by ${field} asc/desc`, async () => {
        const low = await createRow(table, tenantA, { [field]: `aaa-rest-${seed}` });
        const high = await createRow(table, tenantA, { [field]: `zzz-rest-${seed}` });
        for (const [direction, expectedFirst] of [
          ["asc", low],
          ["desc", high],
        ] as const) {
          const response = await rest(
            tenantA,
            "GET",
            `${base}?id=${low}&id=${high}&sortField=${field}&sortDirection=${direction}&first=2`,
          );
          expect(response.status).toBe(200);
          expect(response.body.items[0].id).toBe(expectedFirst);
        }
      });

      test(`PATCH updates ${field}`, async () => {
        const id = await createRow(table, tenantA);
        const updated = `rest-updated-${seed}`;
        const response = await rest(tenantA, "PATCH", `${base}/${id}`, {
          [field]: updated,
        });
        expect(response.status).toBe(200);
        expect(response.body[field]).toBe(updated);
      });
    }

    test("PATCH of a nonexistent row returns 404", async () => {
      const response = await rest(tenantA, "PATCH", `${base}/${randomUUID()}`, {});
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    test("DELETE removes the row (204) and subsequent GET is 404", async () => {
      const id = await createRow(table, tenantA);
      const deleted = await rest(tenantA, "DELETE", `${base}/${id}`);
      expect(deleted.status).toBe(204);
      untrackRow(id);

      const after = await rest(tenantA, "GET", `${base}/${id}`);
      expect(after.status).toBe(404);

      const again = await rest(tenantA, "DELETE", `${base}/${id}`);
      expect(again.status).toBe(404);
    });

    test("cross-tenant isolation: tenant B cannot read tenant A's row", async () => {
      const id = await createRow(table, tenantA);
      const response = await rest(tenantB, "GET", `${base}/${id}`);
      expect(response.status).toBe(404);
    });
  });
}
