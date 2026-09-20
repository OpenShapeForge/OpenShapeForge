// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated REST API e2e suite — the REST counterpart of the manifest-driven
 * GraphQL entity-crud suite. Drives the harness's in-process API app via
 * inject(), or E2E_API_URL over HTTP when set, for every entity that opted in
 * with a `rest:` block. Row setup/cleanup reuses the shared GraphQL harness so
 * both APIs are exercised against the same data and RLS session plumbing.
 *
 * Contract-driven: which controls a mutation needs (version, lease,
 * confirmation challenge) and whether a create is entity-backed or
 * plugin-backed are read from the Operation catalog through
 * e2e/operations.ts, never assumed per entity.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "../generated-rest-routes.js";
import {
  apiApp,
  createdRows,
  describe,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  getRuntime,
  remoteUrl,
  seed,
  tenantA,
  tenantB,
  test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";
import {
  eligibleTables,
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  nextMarker,
  pluginCreateInput,
  redactableColumnFor,
  contractSample,
  tables,
  tablesByName,
  textColumnFor,
  untrackRow,
  withClassifiedColumn,
} from "../../graphql/__tests__/e2e/entity-factory.js";
import {
  acknowledgementRequired,
  challengeAnswerFor,
  isEntityBackedCreate,
  leaseRequired,
  operationContractFor,
  operationIdFor,
  versionRequired,
} from "../../graphql/__tests__/e2e/operations.js";
import { updateGeneratedEntity } from "../../operations/entity/index.js";
import {
  issueEntityConfirmationChallenge,
  type ChallengeProtectedOperation,
} from "../../operations/entity/confirmation-challenges.js";
import type { LeaseProtectedOperation } from "../../operations/entity/edit-leases.js";

registerSuiteLifecycle();

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

const restTables = tables.filter((table) => table.source?.rest);
const restCreateTables = eligibleTables.filter(
  (table) => table.source?.rest?.operations.create,
);

type RestResponse = { status: number; body: any };

function recordPayload(response: RestResponse): any {
  return response.body.data;
}

function listPayload(response: RestResponse): any {
  const data = response.body.data;
  return { ...data, items: data.items.map((item: any) => item.data) };
}

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

  const response = await (await apiApp()).inject({
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

/** The lease request itself, for tests that assert on its refusal. */
function requestLease(
  table: (typeof restTables)[number],
  identity: Identity,
  id: string,
  intent: "update" | "delete",
): Promise<RestResponse> {
  return rest(identity, "POST", "/api/operation-leases", {
    operationId: operationIdFor(table, intent),
    targetId: id,
  });
}

/** Version + lease controls when the Operation demands them, `{}` otherwise. */
async function acquireLease(
  table: (typeof restTables)[number],
  identity: Identity,
  id: string,
  intent: "update" | "delete",
): Promise<Record<string, string>> {
  if (!leaseRequired(table, intent)) {
    if (!versionRequired(table, intent)) return {};
    const base = `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`;
    const current = await rest(identity, "GET", `${base}/${id}`);
    expect(current.status).toBe(200);
    const expectedVersion = recordPayload(current)?.updatedAt;
    expect(expectedVersion).toBeString();
    return { expectedVersion };
  }
  const acquired = await requestLease(table, identity, id, intent);
  expect(acquired.status).toBe(201);
  return {
    expectedVersion: acquired.body.data.targetVersion,
    leaseToken: acquired.body.data.leaseToken,
  };
}

/**
 * Deletes through REST the way a client must: lease, then delete, then answer
 * the confirmation challenge if one is issued. Returns the final response.
 */
async function restDelete(
  table: (typeof restTables)[number],
  identity: Identity,
  id: string,
): Promise<RestResponse> {
  const base = `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`;
  const lease = await acquireLease(table, identity, id, "delete");
  const first = await rest(identity, "DELETE", `${base}/${id}`, {
    ...lease,
    ...(acknowledgementRequired(table, "delete") ? { confirmed: true } : {}),
  });
  if (first.status !== 428) return first;
  expect(first.body.error.code).toBe("CONFIRMATION_REQUIRED");
  expect(first.body.error.retryAt).toBeUndefined();
  expect(first.body.error.data.confirmation.expiresAt).toBeString();
  const row = recordPayload(await rest(identity, "GET", `${base}/${id}`));
  return rest(identity, "DELETE", `${base}/${id}`, {
    ...lease,
    confirmationToken: first.body.error.data.confirmation.challengeToken,
    confirmationAnswer: challengeAnswerFor(table, "delete", row),
  });
}

/**
 * Builds a valid REST create body: sample values for required non-FK columns,
 * recursively created (GraphQL-tracked) rows for required foreign keys —
 * the same assembly rules as entity-factory's createRow. A plugin-backed
 * create takes its authored input contract instead.
 */
async function buildCreateBody(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  if (!isEntityBackedCreate(table)) return pluginCreateInput(table, identity, overrides, depth);
  return buildColumnBody(table, identity, overrides, depth);
}

async function buildColumnBody(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  if (depth > 5) throw new Error(`REST FK dependency chain too deep while creating ${table.name}`);
  const fkTargets = foreignKeyTargets(table);
  const body: Record<string, unknown> = { ...overrides };
  for (const column of table.columns) {
    if (!isMutableColumn(column)) continue;
    const field = fieldName(column);
    if (field in body) continue;
    const fkTarget = fkTargets.get(column.name);
    if (fkTarget) {
      if (column.required) {
        body[field] = await createForeignKeyTarget(fkTarget, identity, depth + 1);
      }
      continue;
    }
    if (column.required) {
      body[field] = contractSample(table, column, nextMarker());
    }
  }
  return body;
}

async function createForeignKeyTarget(
  target: string,
  identity: Identity,
  depth = 0,
): Promise<string> {
  const fullCrudTarget = tablesByName.get(target);
  if (fullCrudTarget) return createRestRow(fullCrudTarget, identity, {}, depth);

  const restTarget = restCreateTables.find((table) => table.name === target);
  if (!restTarget) throw new Error(`REST FK target ${target} has no create operation`);
  const response = await rest(
    identity,
    "POST",
    `${REST_MOUNT_PATH}/${restTarget.source!.rest!.basePath}`,
    await buildCreateBody(restTarget, identity, {}, depth + 1),
  );
  expect(response.status).toBe(201);
  const id = recordPayload(response).id as string;
  createdRows.push({ table: restTarget, id, identity });
  return id;
}

function trackRestRow(table: (typeof restTables)[number], id: string, identity: Identity) {
  createdRows.push({ table, id, identity });
}

async function createRestRow(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<string> {
  const response = await rest(
    identity,
    "POST",
    `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`,
    await buildCreateBody(table, identity, overrides, depth),
  );
  expect(response.status).toBe(201);
  const id = recordPayload(response).id as string;
  trackRestRow(table, id, identity);
  return id;
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
    const id = await createRestRow(table, tenantA);
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
    const id = await createRestRow(table, tenantA);

    const list = await rest(readOnly, "GET", `${base}?id=${id}`);
    expect(list.status).toBe(200);
    expect(listPayload(list).totalCount).toBe(1);
    expect(list.body.operations.map((offer: any) => offer.operation.intent)).toEqual([
      "list",
    ]);

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
      const createdRecord = recordPayload(created);
      const id = createdRecord.id as string;
      expect(id).toBeTruthy();
      trackRestRow(table, id, tenantA);
      expect(createdRecord.createdAt).toBeTruthy();
      expect(Object.keys(createdRecord).some((key) => key.includes("_"))).toBe(false);
      expect(created.body.operations.every((offer: any) => offer.available)).toBe(true);

      const fetched = await rest(tenantA, "GET", `${base}/${id}`);
      expect(fetched.status).toBe(200);
      expect(recordPayload(fetched).id).toBe(id);
    });

    if (isEntityBackedCreate(table)) {
      test("POST with an unknown body field is rejected with 400", async () => {
        const body = await buildCreateBody(table, tenantA, { nopeField: "x" });
        const response = await rest(tenantA, "POST", base, body);
        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain("nopeField");
      });
    }

    test("GET list filters by query params (eq and repeated → In)", async () => {
      const id = await createRestRow(table, tenantA);
      const eq = await rest(tenantA, "GET", `${base}?id=${id}`);
      expect(eq.status).toBe(200);
      const eqData = listPayload(eq);
      expect(eqData.totalCount).toBe(1);
      expect(eqData.items[0].id).toBe(id);
      expect(
        eq.body.data.items[0].operations.map((offer: any) => offer.operation.intent),
      ).toContain("get");

      const inFilter = await rest(
        tenantA,
        "GET",
        `${base}?id=${id}&id=${randomUUID()}`,
      );
      expect(inFilter.status).toBe(200);
      expect(listPayload(inFilter).totalCount).toBe(1);

      // Explicit `<field>In` naming (the GraphQL filter convention) must
      // behave identically — single value included, which previously would
      // have been silently dropped by the CRUD layer's array check.
      const inSingle = await rest(tenantA, "GET", `${base}?idIn=${id}`);
      expect(inSingle.status).toBe(200);
      expect(listPayload(inSingle).totalCount).toBe(1);

      const inRepeated = await rest(
        tenantA,
        "GET",
        `${base}?idIn=${id}&idIn=${randomUUID()}`,
      );
      expect(inRepeated.status).toBe(200);
      expect(listPayload(inRepeated).totalCount).toBe(1);
    });

    test("GET list paginates with first/after without overlap", async () => {
      const ids = [
        await createRestRow(table, tenantA),
        await createRestRow(table, tenantA),
        await createRestRow(table, tenantA),
      ];
      const idParams = ids.map((id) => `id=${id}`).join("&");
      const page1 = await rest(tenantA, "GET", `${base}?${idParams}&first=2`);
      expect(page1.status).toBe(200);
      const firstPage = listPayload(page1);
      expect(firstPage.totalCount).toBe(3);
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).toBeTruthy();

      const page2 = await rest(
        tenantA,
        "GET",
        `${base}?${idParams}&first=2&after=${encodeURIComponent(firstPage.nextCursor)}`,
      );
      expect(page2.status).toBe(200);
      const secondPage = listPayload(page2);
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();

      const seen = [...firstPage.items, ...secondPage.items].map((item: any) => item.id);
      expect(new Set(seen).size).toBe(3);
    });

    test("GET list rejects an unknown filter field with 400", async () => {
      const response = await rest(tenantA, "GET", `${base}?definitelyNotAField=x`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("BAD_USER_INPUT");
    });

    test("GET list rejects an invalid UUID filter with 400 before querying Postgres", async () => {
      const response = await rest(tenantA, "GET", `${base}?id=not-a-uuid`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("BAD_USER_INPUT");
      expect(response.body.error.message).toContain("expects a UUID");
    });

    test("GET list rejects an invalid RFC 3339 date-time filter with 400", async () => {
      const response = await rest(
        tenantA,
        "GET",
        `${base}?createdAt=2020-02-30T25%3A00%3A00Z`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("BAD_USER_INPUT");
      expect(response.body.error.message).toContain("expects an RFC 3339 date-time");
    });

    const dateColumn = table.columns.find((column) => column.type === "date");
    if (dateColumn) {
      const field = fieldName(dateColumn);
      test(`GET list rejects an invalid ${field} date filter with 400`, async () => {
        const response = await rest(tenantA, "GET", `${base}?${field}=2020-02-30`);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("BAD_USER_INPUT");
        expect(response.body.error.message).toContain("expects a date in YYYY-MM-DD format");
      });
    }

    const sortColumn = textColumnFor(table);
    if (sortColumn) {
      const field = fieldName(sortColumn);
      test(`GET list sorts by ${field} asc/desc`, async () => {
        const low = await createRestRow(table, tenantA, { [field]: `aaa-rest-${seed}` });
        const high = await createRestRow(table, tenantA, { [field]: `zzz-rest-${seed}` });
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
          expect(listPayload(response).items[0].id).toBe(expectedFirst);
        }
      });

      test(`PATCH updates ${field}`, async () => {
        const id = await createRestRow(table, tenantA);
        const updated = `rest-updated-${seed}`;
        const controls = await acquireLease(table, tenantA, id, "update");
        const response = await rest(tenantA, "PATCH", `${base}/${id}`, {
          [field]: updated,
          ...controls,
        });
        expect(response.status).toBe(200);
        expect(recordPayload(response)[field]).toBe(updated);
      });
    }

    test("PATCH of a nonexistent row returns 404", async () => {
      const missingId = randomUUID();
      // A lease-protected update cannot begin on a missing row: the lease
      // service is where NOT_FOUND surfaces.
      const response = leaseRequired(table, "update")
        ? await requestLease(table, tenantA, missingId, "update")
        : await rest(tenantA, "PATCH", `${base}/${missingId}`, {
            ...(versionRequired(table, "update")
              ? { expectedVersion: "2026-01-01T00:00:00.000Z" }
              : {}),
          });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    if (isEntityBackedCreate(table)) {
      test("DELETE answers 200 with the result envelope", async () => {
        const id = await createRestRow(table, tenantA);
        const deleted = await restDelete(table, tenantA, id);
        expect(deleted.status).toBe(200);
        expect(deleted.body.data).toEqual({ deleted: true });
        expect(Array.isArray(deleted.body.operations)).toBe(true);
        untrackRow(id);

        const after = await rest(tenantA, "GET", `${base}/${id}`);
        expect(after.status).toBe(404);

        const again = leaseRequired(table, "delete")
          ? await requestLease(table, tenantA, id, "delete")
          : await rest(tenantA, "DELETE", `${base}/${id}`, {
              ...(versionRequired(table, "delete")
                ? { expectedVersion: "2026-01-01T00:00:00.000Z" }
                : {}),
            });
        expect(again.status).toBe(404);
      });
    } else {
      // A plugin-backed create makes companion records the entity delete is
      // authored to refuse while they exist (a document and its first
      // version); removing them is the plugin's own contract.
      test("DELETE is refused while the create's companion records exist", async () => {
        const id = await createRestRow(table, tenantA);
        const refused = await restDelete(table, tenantA, id);
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe("REFERENCE_IN_USE");
        expect((await rest(tenantA, "GET", `${base}/${id}`)).status).toBe(200);
      });
    }

    if (leaseRequired(table, "update") && leaseRequired(table, "delete")) {
      test("the central record lease blocks a second writer across update and delete", async () => {
        const id = await createRestRow(table, tenantA);
        const acquired = await requestLease(table, tenantA, id, "update");
        expect(acquired.status).toBe(201);

        const otherWriter: Identity = {
          tenantId: tenantA.tenantId,
          userId: randomUUID(),
          roles: [...tenantA.roles],
        };
        const blocked = await requestLease(table, otherWriter, id, "delete");
        expect(blocked.status).toBe(423);
        expect(blocked.body.error).toMatchObject({
          code: "LOCKED",
          retryable: true,
        });
        expect(blocked.body.error.retryAt).toBeString();

        const released = await rest(
          tenantA,
          "POST",
          "/api/operation-leases/release",
          { leaseToken: acquired.body.data.leaseToken },
        );
        expect(released.status).toBe(200);
        expect(released.body.data.released).toBe(true);
      });
    }

    if (leaseRequired(table, "update")) {
      test("role revocation blocks lease renewal but not release", async () => {
        const id = await createRestRow(table, tenantA);
        const acquired = await requestLease(table, tenantA, id, "update");
        expect(acquired.status).toBe(201);
        const revoked: Identity = { ...tenantA, roles: [] };

        const renewal = await rest(
          revoked,
          "POST",
          "/api/operation-leases/renew",
          { leaseToken: acquired.body.data.leaseToken },
        );
        expect(renewal.status).toBe(409);
        expect(renewal.body.error.code).toBe("LEASE_EXPIRED");

        const release = await rest(
          revoked,
          "POST",
          "/api/operation-leases/release",
          { leaseToken: acquired.body.data.leaseToken },
        );
        expect(release.status).toBe(200);
        expect(release.body.data.released).toBe(true);
      });
    }

    test("REST lease acquire refuses operations outside its lease projection", async () => {
      // A read never carries a lease, whatever the entity's mutations do.
      const refused = await rest(tenantA, "POST", "/api/operation-leases", {
        operationId: operationIdFor(table, "get"),
        targetId: randomUUID(),
      });
      expect(refused.status).toBe(404);
      expect(refused.body.error).toMatchObject({
        code: "NOT_FOUND",
        retryable: false,
      });
    });

    if (versionRequired(table, "update")) {
      test("invalid expectedVersion is a field validation error, not a server error", async () => {
        const refused = await rest(
          tenantA,
          "PATCH",
          `${base}/${randomUUID()}`,
          {
            expectedVersion: "2026-02-30T12:00:00.000Z",
            leaseToken: "not-used-because-version-validation-runs-first",
          },
        );
        expect(refused.status).toBe(422);
        expect(refused.body.error).toMatchObject({
          code: "VALIDATION",
          retryable: false,
          violations: [
            {
              field: "expectedVersion",
              code: "INVALID_DATETIME",
            },
          ],
        });
      });
    }

    test("invalid mutation control types are canonical validation errors", async () => {
      const refused = await rest(
        tenantA,
        "DELETE",
        `${base}/${randomUUID()}`,
        {
          expectedVersion: new Date().toISOString(),
          leaseToken: "not-used-because-control-validation-runs-first",
          confirmationToken: false,
        },
      );
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatchObject({
        code: "VALIDATION",
        retryable: false,
        violations: [
          {
            field: "confirmationToken",
            code: "INVALID_TYPE",
          },
        ],
      });
    });

    const versionedColumn = textColumnFor(table);
    if (leaseRequired(table, "update") && versionedColumn) {
      const versionedField = fieldName(versionedColumn);

      test("a valid lease still refuses an older expectedVersion", async () => {
        const id = await createRestRow(table, tenantA);
        const firstLease = await acquireLease(table, tenantA, id, "update");
        const updated = await rest(tenantA, "PATCH", `${base}/${id}`, {
          [versionedField]: `versioned-${seed}`,
          ...firstLease,
        });
        expect(updated.status).toBe(200);

        const currentLease = await requestLease(table, tenantA, id, "update");
        expect(currentLease.status).toBe(201);
        const stale = await rest(tenantA, "PATCH", `${base}/${id}`, {
          [versionedField]: `must-not-write-${seed}`,
          expectedVersion: firstLease.expectedVersion,
          leaseToken: currentLease.body.data.leaseToken,
        });
        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe("VERSION_CONFLICT");

        await rest(tenantA, "POST", "/api/operation-leases/release", {
          leaseToken: currentLease.body.data.leaseToken,
        });
      });

      test("a server challenge canonicalizes a visible datetime and protects update atomically", async () => {
        const id = await createRestRow(table, tenantA);
        const current = await rest(tenantA, "GET", `${base}/${id}`);
        const row = recordPayload(current);
        const lease = await acquireLease(table, tenantA, id, "update");
        // The entity's own update contract, re-authored with a challenge on a
        // datetime field: what is under test is the core's canonicalization of
        // the typed answer, not any one entity's authored confirmation.
        const authored = operationContractFor(table, "update")!;
        const challengedOperation = {
          ...authored,
          intent: "update" as const,
          interaction: {
            confirmation: {
              mode: "challenge" as const,
              challenge: {
                kind: "type-current-field" as const,
                field: "createdAt",
                issuedBy: "server" as const,
                bindTo: [
                  "subject",
                  "tenant",
                  "operation",
                  "target.id",
                  "target.version",
                ] as const,
                expiresAfter: "PT5M",
                singleUse: true as const,
              },
            },
          },
        } satisfies ChallengeProtectedOperation & LeaseProtectedOperation;
        const required = await issueEntityConfirmationChallenge(
          getRuntime().db,
          tenantA,
          {
            operation: challengedOperation,
            table,
            targetId: id,
            expectedVersion: lease.expectedVersion!,
            leaseToken: lease.leaseToken!,
          },
        );
        expect(required.code).toBe("CONFIRMATION_REQUIRED");
        const confirmation = required.data!.confirmation as {
          challengeToken: string;
        };
        const value = `challenged-update-${seed}`;
        const updated = await updateGeneratedEntity(getRuntime().db, tenantA, {
          table: table.name,
          id,
          values: { [versionedField]: value },
          guard: {
            operation: challengedOperation,
            expectedVersion: lease.expectedVersion!,
            leaseToken: lease.leaseToken!,
            confirmationToken: confirmation.challengeToken,
            confirmationAnswer: row.createdAt,
          },
        });
        expect(updated?.[versionedColumn.name]).toBe(value);
      });
    }

    test("cross-tenant isolation: tenant B cannot read tenant A's row", async () => {
      const id = await createRestRow(table, tenantA);
      const response = await rest(tenantB, "GET", `${base}/${id}`);
      expect(response.status).toBe(404);
    });
  });
}

/**
 * Field-level data protection over REST (#164). The controls live in the
 * shared CRUD core, so REST must behave exactly like GraphQL: a caller holding
 * only a read grant gets classified columns nulled, and is refused when it
 * tries to recover them by filtering or sorting on the column.
 *
 * Skipped against a remote server: withClassifiedColumn arms the in-process
 * manifest, which a server behind E2E_API_URL does not share.
 */
for (const table of restTables) {
  const rest_ = table.source!.rest!;
  const base = `${REST_MOUNT_PATH}/${rest_.basePath}`;
  const classified = redactableColumnFor(table);
  if (!classified) continue;
  const field = fieldName(classified);

  describe(`${rest_.basePath} field-level classification`, () => {
    test.skipIf(remoteUrl)(
      `a read-only caller gets ${field} nulled on list and get; a writer still sees it`,
      async () => {
        const value = `rest-redaction-${seed}`;
        const id = await createRestRow(table, tenantA, { [field]: value });

        // Control: unclassified, the column is served to a read-only caller.
        const control = await rest(readOnly, "GET", `${base}/${id}`);
        expect(control.status).toBe(200);
        expect(recordPayload(control)[field]).toBe(value);

        await withClassifiedColumn(classified, "pii", async () => {
          const single = await rest(readOnly, "GET", `${base}/${id}`);
          expect(single.status).toBe(200);
          expect(recordPayload(single)[field]).toBeNull();
          // Unclassified columns are untouched.
          expect(recordPayload(single).id).toBe(id);
          expect(recordPayload(single).createdAt).toBeTruthy();

          const list = await rest(readOnly, "GET", `${base}?id=${id}`);
          expect(list.status).toBe(200);
          expect(listPayload(list).totalCount).toBe(1);
          expect(listPayload(list).items[0][field]).toBeNull();

          // A write grant reads the real value on both paths — redaction is
          // scoped to the grant, not a blanket null.
          const writerSingle = await rest(tenantA, "GET", `${base}/${id}`);
          expect(recordPayload(writerSingle)[field]).toBe(value);
          const writerList = await rest(tenantA, "GET", `${base}?id=${id}`);
          expect(listPayload(writerList).items[0][field]).toBe(value);
        });
      },
    );

    test.skipIf(remoteUrl)(
      `a read-only caller cannot filter or sort by ${field}`,
      async () => {
        const value = `rest-oracle-${seed}`;
        const id = await createRestRow(table, tenantA, { [field]: value });
        const probe = encodeURIComponent(value);

        await withClassifiedColumn(classified, "pii", async () => {
          for (const query of [
            `${field}=${probe}`,
            `${field}In=${probe}`,
            `sortField=${field}`,
            `sortField=${field}&sortDirection=desc`,
          ]) {
            const response = await rest(readOnly, "GET", `${base}?${query}`);
            expect(response.status).toBe(403);
            expect(response.body.error.code).toBe("FORBIDDEN");
            // The refusal must not answer the question it refused.
            expect(response.body.data).toBeUndefined();
          }

          // The same query stays available to a write grant.
          const allowed = await rest(
            tenantA,
            "GET",
            `${base}?${field}=${probe}&sortField=${field}`,
          );
          expect(allowed.status).toBe(200);
          expect(listPayload(allowed).totalCount).toBe(1);
          expect(listPayload(allowed).items[0].id).toBe(id);
        });
      },
    );
  });
}

/**
 * Authored `immutable` over REST (#177). The flag reaches the runtime on the
 * manifest column, so REST refuses the field on PATCH exactly the way it
 * refuses any other non-writable key — while still accepting it on POST, which
 * is the one moment the caller owns the value.
 *
 * Manifest-driven: a table with no immutable column contributes no test, which
 * is also the "unaffected entity" case (every other table keeps the create and
 * update surface it had).
 */
for (const table of restTables) {
  const rest_ = table.source!.rest!;
  const base = `${REST_MOUNT_PATH}/${rest_.basePath}`;
  const immutable = table.columns.find((column) => column.immutable);
  if (!immutable) continue;
  const field = fieldName(immutable);
  const fkTarget = foreignKeyTargets(table).get(immutable.name);

  /** A value the column will accept: a real parent row for an FK, else a sample. */
  const valueFor = async (identity: Identity) => {
    if (!fkTarget) return contractSample(table, immutable, nextMarker());
    return createForeignKeyTarget(fkTarget, identity);
  };
  // Only an entity-backed create offers the column as input; a plugin create
  // owns the value (a document's current version). PATCH refuses it either
  // way, and the schema says so.
  const offeredOnCreate = isEntityBackedCreate(table);

  describe(`${rest_.basePath} immutable fields`, () => {
    test(`${offeredOnCreate ? `POST accepts ${field}; ` : ""}PATCH rejects ${field} with 400 and the value stands`, async () => {
      const body = offeredOnCreate
        ? await buildCreateBody(table, tenantA, { [field]: await valueFor(tenantA) })
        : await buildCreateBody(table, tenantA);
      const created = await rest(tenantA, "POST", base, body);
      expect(created.status).toBe(201);
      const id = recordPayload(created).id as string;
      trackRestRow(table, id, tenantA);
      const value = recordPayload(await rest(tenantA, "GET", `${base}/${id}`))[field];
      if (offeredOnCreate) expect(value).toBe(body[field]);

      // Re-pointing the record at a different parent is the integrity gap.
      const repointed = await valueFor(tenantA);
      const patched = await rest(tenantA, "PATCH", `${base}/${id}`, { [field]: repointed });
      expect(patched.status).toBe(400);
      expect(patched.body.error.code).toBe("BAD_USER_INPUT");
      expect(patched.body.error.message).toContain(field);

      const after = await rest(tenantA, "GET", `${base}/${id}`);
      expect(after.status).toBe(200);
      expect(recordPayload(after)[field]).toBe(value);
    });

    test(`openapi.json advertises ${field} on ${offeredOnCreate ? "POST only" : "neither POST nor PATCH"}`, async () => {
      const spec = await rest(null, "GET", REST_OPENAPI_PATH);
      expect(spec.status).toBe(200);
      const schemaFor = (operation: "post" | "patch", path: string) => {
        const ref = spec.body.paths[path][operation].requestBody.content["application/json"]
          .schema.$ref as string;
        return spec.body.components.schemas[ref.replace("#/components/schemas/", "")];
      };
      const create = schemaFor("post", `${REST_MOUNT_PATH}/${rest_.basePath}`);
      const update = schemaFor("patch", `${REST_MOUNT_PATH}/${rest_.basePath}/{id}`);

      if (offeredOnCreate) expect(Object.keys(create.properties)).toContain(field);
      else expect(Object.keys(create.properties)).not.toContain(field);
      expect(Object.keys(update.properties)).not.toContain(field);
    });
  });
}
