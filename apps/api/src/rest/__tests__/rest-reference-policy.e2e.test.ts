// SPDX-License-Identifier: BUSL-1.1
/**
 * The reference-policy half of the REST sweep: for every REST entity, each
 * reference column an Operation writes (`writtenBy`) is absent from the
 * OpenAPI create (entity-backed) and update bodies, a POST or PATCH naming
 * it is refused as BAD_USER_INPUT naming the field and every writer, and a
 * list filter on it finds the row that carries the value and never another
 * tenant's. Which columns those are comes from the manifest through the
 * shared reference policy, the same source the MCP and GraphQL sweeps read.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/rest/__tests__/rest-reference-policy.e2e.test.ts 2>&1
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { REST_MOUNT_PATH, REST_OPENAPI_PATH } from "../generated-rest-routes.js";
import { tablesByName } from "../../graphql/__tests__/e2e/entity-factory.js";
import { isEntityBackedCreate } from "../../graphql/__tests__/e2e/operations.js";
import { expectCreateWriteRefusal, expectWriterRefusal, operationWrittenReferences, plantReference } from "../../graphql/__tests__/e2e/reference-policy.js";
import { describe, registerSuiteLifecycle, tenantA, tenantB, test, type Identity } from "../../graphql/__tests__/e2e/harness.js";
import {
  acquireLease, buildCreateBody, createForeignKeyTarget, createRestRow, listPayload, recordPayload, rest, restCreateTables,
} from "./e2e/rest-sweep.js";

registerSuiteLifecycle();

describe("REST transport: operation-written references", () => {
  for (const table of restCreateTables) {
    const base = `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`;
    const listedIds = async (identity: Identity, field: string, value: string) =>
      listPayload(table, await rest(identity, "GET", `${base}?${field}=${value}`)).items.map((item: any) => item.id);

    for (const reference of operationWrittenReferences(table, tablesByName)) {
      const { field, writers, column } = reference;

      test(`${table.source!.rest!.basePath}: ${field} is written by ${writers.join(", ")} only — a filter, never POST or PATCH input`, async () => {
        const spec = await rest(null, "GET", REST_OPENAPI_PATH);
        expect(spec.status).toBe(200);
        const bodySchema = (operation: "post" | "patch", path: string) => {
          const ref = spec.body.paths[path][operation].requestBody.content["application/json"].schema.$ref as string;
          return spec.body.components.schemas[ref.replace("#/components/schemas/", "")];
        };
        expect(Object.keys(bodySchema("patch", `${base}/{id}`).properties)).not.toContain(field);
        if (isEntityBackedCreate(table)) expect(Object.keys(bodySchema("post", base).properties)).not.toContain(field);

        const body = await buildCreateBody(table, tenantA);
        const refusedCreate = await rest(tenantA, "POST", base, { ...body, [field]: randomUUID() });
        expect([400, 422]).toContain(refusedCreate.status);
        expectCreateWriteRefusal(table, refusedCreate.body.error, field, writers);

        const id = await createRestRow(table, tenantA, body);
        expect(recordPayload(table, await rest(tenantA, "GET", `${base}/${id}`))[field] ?? null).toBeNull();

        const controls = await acquireLease(table, tenantA, id, "update");
        const refusedUpdate = await rest(tenantA, "PATCH", `${base}/${id}`, { [field]: randomUUID(), ...controls });
        expect(refusedUpdate.status).toBe(400);
        expectWriterRefusal(refusedUpdate.body.error, field, writers);
        expect(recordPayload(table, await rest(tenantA, "GET", `${base}/${id}`))[field] ?? null).toBeNull();
      });

      test(`${table.source!.rest!.basePath}: a filter on ${field} finds the row that carries it and never another tenant's rows`, async () => {
        const foreignTargetId = await createForeignKeyTarget(reference.targetTable, tenantB);
        const foreignId = await createRestRow(table, tenantB);
        await plantReference(table, foreignId, column, foreignTargetId);
        expect(await listedIds(tenantB, field, foreignTargetId)).toEqual([foreignId]);
        expect(await listedIds(tenantA, field, foreignTargetId)).toEqual([]);

        const targetId = await createForeignKeyTarget(reference.targetTable, tenantA);
        const id = await createRestRow(table, tenantA);
        await plantReference(table, id, column, targetId);
        expect(await listedIds(tenantA, field, targetId)).toEqual([id]);
        expect(await listedIds(tenantA, field, randomUUID())).toEqual([]);
      });
    }
  }
});
