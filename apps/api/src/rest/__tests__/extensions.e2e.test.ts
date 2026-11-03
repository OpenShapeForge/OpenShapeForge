// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant fields over HTTP (docs/authoring.md, "Extensible entities"): the acceptance entity
 * `ExtensibleAsset` of the test composition through the in-process API, on
 * all three interfaces. A field is defined over REST, records carry it,
 * filters and sorts reach it on REST and GraphQL, the location it points at
 * reports who references it, a deprecated field stays readable but closed,
 * and a delete is confirmed and carried out by the backfill worker. MCP sees
 * the fields through the generic Operations only.
 *
 * The suite works in a tenant of its own, so the fields it defines never
 * reach another suite's records; tenant B of the harness is the other
 * tenant. Needs the extensible test layer (test/fixtures/authoring/
 * test-composition.yaml as authoring.config.local.yaml, then `bun run
 * generate`); the production composition declares no extensible entity and
 * the suite is skipped there.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/rest/__tests__/extensions.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { DEV_WORKER_ROLE_PASSWORD_DEFAULT, WORKER_ROLE } from "../../db/migrations/worker-role.js";
import { composeJobHandlers } from "../../jobs/handlers.js";
import { processJobBatch } from "../../jobs/worker.js";
import { EXTENSION_BACKFILL_KIND, extensionBackfillJobHandler } from "../../operations/entity/extensions/backfill.js";
import { extensionRegistry } from "../../operations/entity/extensions/registry.js";
import {
  admitTransportIdentities, apiApp, describe, expectData, getSeedRuntime, registerSuiteLifecycle, remoteUrl, tenantB, test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";
import { rpc, toolEnvelope } from "../../mcp/__tests__/e2e/mcp-sweep.js";

registerSuiteLifecycle();

const ENTITY = "ExtensibleAsset";
const available = extensionRegistry.entity(ENTITY) !== undefined && !remoteUrl;
const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;
const REST = "/api/rest/v1";
const ASSETS = `${REST}/extensible-assets`;
const LOCATIONS = `${REST}/extensible-asset-locations`;

const tenantId = randomUUID();
const as = (roles: string[]): Identity => ({ tenantId, userId: randomUUID(), roles });
const manager = as(["Test.Fields.Manage", "General.All.ReadWrite", "General.All.Read"]);
const writer = as(["General.All.ReadWrite"]);
const reader = as(["General.All.Read"]);
const label = (text: string) => ({ en: text, nl: text });
const definition = (osfType: string, extra: Record<string, unknown> = {}) =>
  ({ label: label(osfType), classification: { sensitivity: "public" }, osfType, ...extra });

let app: Awaited<ReturnType<typeof apiApp>> | null = null;
let worker: DatabaseRuntime | null = null;
const handlers = composeJobHandlers([{ name: "e2e-extensions", jobHandlers: { [EXTENSION_BACKFILL_KIND]: extensionBackfillJobHandler } }]);
const silent = { info() {}, warn() {}, error() {} };

function workerUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://openshapeforge_app:openshapeforge_app@localhost:5434/openshapeforge_dev");
  url.username = WORKER_ROLE;
  url.password = DEV_WORKER_ROLE_PASSWORD_DEFAULT;
  return url.toString();
}

beforeAll(async () => {
  if (!available) return;
  app = await apiApp();
  worker = createDatabaseRuntime({ databaseUrl: workerUrl(), maxConnections: 2 });
  await admitTransportIdentities([manager, writer, reader]);
});

afterAll(async () => {
  if (!available) return;
  const db = getSeedRuntime().db;
  // The records cascade to their index rows and claims.
  await sql`delete from erp.extensible_assets where tenant_id = ${tenantId}::uuid`.execute(db);
  await sql`delete from erp.extensible_asset_locations where tenant_id = ${tenantId}::uuid`.execute(db);
  for (const table of ["extension_field_backfills", "extension_field_dependencies", "extension_field_definitions", "jobs"]) {
    await sql`delete from ${sql.id("platform", table)} where tenant_id = ${tenantId}::uuid`.execute(db);
  }
  await worker?.close();
});

async function http(identity: Identity, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  const response = await app!.inject({
    method: method as "GET", url, headers: Object.fromEntries(headers.entries()),
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const list = (identity: Identity, query: { filter?: unknown; sortField?: string; sortDirection?: string }) => {
  const params = new URLSearchParams();
  if (query.filter) params.set("filter", JSON.stringify(query.filter));
  if (query.sortField) params.set("sortField", query.sortField);
  if (query.sortDirection) params.set("sortDirection", query.sortDirection);
  return http(identity, "GET", `${ASSETS}?${params}`);
};
const ids = (response: { body: any }) => (response.body.data.items as Array<{ data: { id: string } }>).map((item) => item.data.id);

async function drainBackfills() {
  for (let round = 0; round < 20; round += 1) {
    const { processed } = await processJobBatch(worker!.db, handlers, silent, { kinds: [EXTENSION_BACKFILL_KIND] });
    if (!processed) return;
  }
}

describe("tenant fields over REST, GraphQL and MCP", () => {
  const fields: Record<string, string> = {};
  const records: Record<string, { id: string; updatedAt: string }> = {};
  let location: { id: string; updatedAt: string };
  const tag = `E2E-${randomUUID().slice(0, 8)}`;
  const scope = { name: { startsWith: tag } };

  test.skipIf(!available)("a manager defines fields; a writer may not, a reader lists them", async () => {
    const options = { type: "static", items: [{ value: "batterij", label: label("Batterij") }, { value: "kit", label: label("Kit") }] };
    for (const [key, body] of [
      ["soort", definition("string", { options })],
      ["accu", definition("number")],
      ["plek", definition("ExtensibleAssetLocation", { onDelete: "restrict" })],
    ] as const) {
      const created = await http(manager, "POST", `${ASSETS}/field-definitions/create`, { key, definition: body });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ key, version: 1, kind: "stored", state: "ready" });
      fields[key] = created.body.fieldId;
    }
    expect((await http(writer, "POST", `${ASSETS}/field-definitions/create`, { key: "x", definition: definition("string") })).status).toBe(403);
    const listed = await http(reader, "POST", `${ASSETS}/field-definitions/list`, {});
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { key: string }) => item.key)).toEqual(["soort", "accu", "plek"]);
  });

  test.skipIf(!available)("records carry tenant fields, validated per key, and never the source column", async () => {
    const target = await http(writer, "POST", LOCATIONS, { name: `${tag} hal 7` });
    expect(target.status).toBe(201);
    location = target.body.data;
    for (const [name, extensions] of [
      ["a", { soort: "batterij", accu: 5, plek: location.id }],
      ["b", { soort: "batterij", accu: 20, plek: location.id }],
      ["c", { soort: "kit", accu: 12.5 }],
      ["d", { soort: "kit" }],
    ] as const) {
      const created = await http(writer, "POST", ASSETS, { name: `${tag}-${name}`, extensions });
      expect(created.status).toBe(201);
      expect(created.body.data.extensions).toMatchObject(extensions);
      expect(created.body.data.extensionsMeta.soort).toMatchObject({ applicable: true });
      expect(JSON.stringify(created.body)).not.toMatch(/extension_values|extensionValues/);
      records[name] = created.body.data;
    }
    expect(await http(writer, "POST", ASSETS, { name: "bad", extensions: { nope: 1 } }))
      .toMatchObject({ status: 422, body: { error: { violations: [expect.objectContaining({ field: "extensions.nope", code: "UNKNOWN_FIELD" })] } } });
    expect((await http(writer, "POST", ASSETS, { name: "bad", extensions: { accu: "veel" } })).status).toBe(422);
    const read = await http(reader, "GET", `${ASSETS}/${records.a!.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.extensions).toEqual({ soort: "batterij", accu: 5, plek: location.id });
    // REST offers the record's referencedBy read (the entity is a target of its own fields).
    expect(read.body.operations.map((offer: { operation: { id: string } }) => offer.operation.id)).toContain(`${ENTITY}.referencedBy`);
  });

  test.skipIf(!available)("REST filters and sorts on tenant fields, nulls last; another tenant knows none of them", async () => {
    const filtered = await list(reader, { filter: { ...scope, extensions: { accu: { gte: 10 } } } });
    expect(filtered.status).toBe(200);
    expect(ids(filtered).sort()).toEqual([records.b!.id, records.c!.id].sort());
    expect(ids(await list(reader, { filter: { ...scope, extensions: { plek: { eq: location.id } } } })).sort())
      .toEqual([records.a!.id, records.b!.id].sort());
    expect(ids(await list(reader, { filter: scope, sortField: "extensions.accu", sortDirection: "desc" })))
      .toEqual([records.b!.id, records.c!.id, records.a!.id, records.d!.id]);
    expect(ids(await list(reader, { filter: scope, sortField: "extensions.accu", sortDirection: "asc" })))
      .toEqual([records.a!.id, records.c!.id, records.b!.id, records.d!.id]);
    expect(await list(reader, { filter: { extensions: { nope: { eq: 1 } } } })).toMatchObject({ status: 400, body: { error: { code: "BAD_USER_INPUT" } } });
    expect(await list(tenantB, { filter: { extensions: { soort: { eq: "kit" } } } })).toMatchObject({ status: 400 });
    expect(ids(await list(tenantB, { filter: scope }))).toEqual([]);
  });

  test.skipIf(!available)("GraphQL filters, sorts and reads definitions and references through the same Operations", async () => {
    const data = await expectData(reader, /* GraphQL */ `
      query($filter: ExtensibleAssetFilter, $sort: ExtensibleAssetSort) {
        extensibleAssets(filter: $filter, sort: $sort) { data { items { data { id extensions } } totalCount } }
      }`, { filter: { name: tag, extensions: { soort: { eq: "batterij" } } }, sort: { field: "extensions.accu", direction: "desc" } });
    expect(data.extensibleAssets.data.totalCount).toBe(2);
    expect(data.extensibleAssets.data.items.map((item: { data: { id: string } }) => item.data.id)).toEqual([records.b!.id, records.a!.id]);
    expect(data.extensibleAssets.data.items[0].data.extensions).toMatchObject({ soort: "batterij", accu: 20 });
    const definitions = await expectData(reader, /* GraphQL */ `query($input: JSON!) { extensibleAssetFieldDefinitions(input: $input) }`, { input: {} });
    expect(definitions.extensibleAssetFieldDefinitions.items.map((item: { key: string }) => item.key)).toEqual(["soort", "accu", "plek"]);
    const referenced = await expectData(reader, /* GraphQL */ `query($input: JSON!) { extensibleAssetLocationReferencedBy(input: $input) }`, { input: { id: location.id } });
    expect(referenced.extensibleAssetLocationReferencedBy.items).toEqual([
      { entity: ENTITY, fieldId: fields.plek, fieldKey: "plek", label: label("ExtensibleAssetLocation"), count: 2 },
    ]);
  });

  test.skipIf(!available)("referencedBy counts the referrers, and a restricted reference holds the target", async () => {
    const referenced = await http(reader, "POST", `${LOCATIONS}/${location.id}/referenced-by`, {});
    expect(referenced).toMatchObject({ status: 200, body: { items: [{ entity: ENTITY, fieldKey: "plek", count: 2 }] } });
    const removed = await http(writer, "DELETE", `${LOCATIONS}/${location.id}`, { expectedVersion: location.updatedAt, confirmed: true });
    expect(removed.status).toBeGreaterThanOrEqual(400);
    expect(removed.body.error).toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringContaining("plek") });
    expect((await http(reader, "GET", `${LOCATIONS}/${location.id}`)).status).toBe(200);
  });

  test.skipIf(!available)("MCP reaches tenant fields through the generic Operations, without definition or referencedBy offers", async () => {
    const listed = await rpc(writer, "tools/list");
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name) as string[];
    expect(names).toEqual(expect.arrayContaining(["osf_search_operations", "osf_execute_operation"]));
    expect(names.filter((name) => /field_?def|referenced/i.test(name))).toEqual([]);
    const search = async (operationId: string) =>
      toolEnvelope((await rpc(writer, "tools/call", { name: "osf_search_operations", arguments: { operationId } })).body);
    const create = (await search(`${ENTITY}.create`)).operations[0];
    expect(Object.keys(create.inputSchema.properties.extensions.properties)).toEqual(["soort", "accu", "plek"]);
    expect((await search(`${ENTITY}.fieldDefinitions.create`)).operations ?? []).toEqual([]);
    const executed = await rpc(writer, "tools/call", { name: "osf_execute_operation",
      arguments: { operationId: `${ENTITY}.create`, input: { name: `${tag}-mcp`, extensions: { soort: "kit", accu: 7 } } } });
    expect(executed.body.result.isError).not.toBe(true);
    const envelope = toolEnvelope(executed.body);
    expect(envelope.data.extensions).toMatchObject({ soort: "kit", accu: 7 });
    expect(envelope.operations.map((offer: { operation: { id: string } }) => offer.operation.id)).not.toContain(`${ENTITY}.referencedBy`);
    records.mcp = envelope.data;
  });

  test.skipIf(!available)("a deprecated field stays readable and closes for writes; a delete is confirmed and backfilled", async () => {
    const deprecated = await http(manager, "POST", `${ASSETS}/field-definitions/deprecate`, { fieldId: fields.soort });
    expect(deprecated).toMatchObject({ status: 200, body: { key: "soort", version: 2, state: "deprecated" } });
    const read = await http(reader, "GET", `${ASSETS}/${records.a!.id}`);
    expect(read.body.data.extensions.soort).toBe("batterij");
    expect(read.body.data.extensionsMeta.soort).toMatchObject({ deprecated: true });
    expect(await http(writer, "POST", ASSETS, { name: `${tag}-dep`, extensions: { soort: "kit" } }))
      .toMatchObject({ status: 422, body: { error: { violations: [expect.objectContaining({ code: "DEPRECATED_FIELD" })] } } });

    const affected = await http(manager, "POST", `${ASSETS}/field-definitions/affected-records`, { fieldId: fields.soort });
    expect(affected).toMatchObject({ status: 200, body: { count: 5 } });
    expect(await http(manager, "POST", `${ASSETS}/field-definitions/delete`, { fieldId: fields.soort, confirmAffectedRecords: 4 }))
      .toMatchObject({ status: 400, body: { error: { code: "CONFIRMATION_MISMATCH" } } });
    const deleted = await http(manager, "POST", `${ASSETS}/field-definitions/delete`, { fieldId: fields.soort, confirmAffectedRecords: 5 });
    expect(deleted.status).toBe(200);
    const backfillId = deleted.body.backfillId as string;

    await drainBackfills();
    const backfill = await sql<{ state: string; processed: number; total: number }>`select state, processed, total
      from platform.extension_field_backfills where tenant_id = ${tenantId}::uuid and id = ${backfillId}::uuid`.execute(getSeedRuntime().db);
    expect(backfill.rows).toEqual([{ state: "done", processed: 5, total: 5 }]);
    const remaining = await http(manager, "POST", `${ASSETS}/field-definitions/list`, { includeDeprecated: true });
    expect(remaining.body.items.map((item: { key: string }) => item.key)).toEqual(["accu", "plek"]);
    const after = await http(reader, "GET", `${ASSETS}/${records.a!.id}`);
    expect(after.body.data.extensions).toEqual({ accu: 5, plek: location.id });
    expect((await sql`select 1 from erp.extensible_assets_field_values where tenant_id = ${tenantId}::uuid and field_id = ${fields.soort!}::uuid`
      .execute(getSeedRuntime().db)).rows).toEqual([]);
    // The key is free again.
    expect(await http(manager, "POST", `${ASSETS}/field-definitions/create`, { key: "soort", definition: definition("string") }))
      .toMatchObject({ status: 200, body: { key: "soort", version: 1, state: "ready" } });
  });
});
