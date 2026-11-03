// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import runtime, { extensionSnapshot, type SnapshotExtensionDefinition } from "./runtime.js";

const KWH = "11111111-1111-4111-8111-111111111111";
const BSN = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const HEAD = "44444444-4444-4444-8444-444444444444";
const definitions: SnapshotExtensionDefinition[] = [
  { field_id: KWH, key: "capaciteit", version: 3, state: "ready", definition: { osfType: "number", unit: "kWh", label: { nl: "Capaciteit" }, classification: { sensitivity: "public" } } },
  { field_id: BSN, key: "bsn", version: 1, state: "ready", definition: { osfType: "string", classification: { sensitivity: "bsn" } } },
  { field_id: GONE, key: "oud", version: 2, state: "deleted", definition: { osfType: "string", classification: { sensitivity: "public" } } },
];

/** Answers the publish handler's queries; records what it stored. */
function platform(source: Record<string, unknown>, rows: SnapshotExtensionDefinition[]) {
  const stored: Array<{ canonical: string; hash: string }> = [];
  const executor = {
    async executeQuery(query: { sql: string; parameters: readonly unknown[] }) {
      if (query.sql.includes("from \"cpq\".\"products\" source_row")) return { rows: [{ row: source }] };
      if (query.sql.includes("platform.extension_field_definitions")) return { rows };
      if (query.sql.includes("insert into")) {
        stored.push({ canonical: String(query.parameters[1]), hash: String(query.parameters[2]) });
        return { rows: [{ row: { id: "v", version_number: 1 } }] };
      }
      return { rows: [] };
    },
  };
  return {
    stored,
    context: {
      session: { tenantId: "t", userId: "55555555-5555-4555-8555-555555555555" },
      platform: {
        db: { withSession: (_session: unknown, work: (trx: unknown) => Promise<unknown>) => work(executor) },
        schemas: { versioning: { get: () => ({ sourceEntity: "Product", versionEntity: "ProductVersion",
          head: { schema: "cpq", table: "products" }, version: { schema: "cpq", table: "product_versions", headColumn: "product_id" }, owned: [] }) } },
      },
    },
  };
}

describe("tenant fields in a published snapshot", () => {
  test("freezes unclassified values with their definition versions, never the raw source", () => {
    const frozen = extensionSnapshot({ extension_values: { [KWH]: 13.5, [BSN]: "123456782", [GONE]: "x" } }, definitions);
    expect(frozen).toEqual({
      extensions: { [KWH]: 13.5 },
      extensionDefinitions: { [KWH]: { version: 3, key: "capaciteit", label: { nl: "Capaciteit" }, osfType: "number", unit: "kWh" } },
    });
  });

  test("the published content hash is deterministic and holds no classified value", async () => {
    const handler = (runtime.operationHandlers as Record<string, (input: unknown, context: unknown) => Promise<unknown>>).publishProductToProductVersion!;
    const first = platform({ id: HEAD, tenant_id: "t", title: "Accu", extension_values: { [KWH]: 13.5, [BSN]: "123456782" } }, definitions);
    const second = platform({ extension_values: { [BSN]: "123456782", [KWH]: 13.5 }, title: "Accu", tenant_id: "t", id: HEAD }, [...definitions].reverse());
    await handler({ id: HEAD }, first.context);
    await handler({ id: HEAD }, second.context);
    expect(first.stored[0]!.hash).toBe(second.stored[0]!.hash);
    const snapshot = JSON.parse(first.stored[0]!.canonical);
    expect(snapshot.head.extensions).toEqual({ [KWH]: 13.5 });
    expect(snapshot.head.row.extension_values).toBeUndefined();
    expect(first.stored[0]!.canonical).not.toContain("123456782");
    const relabelled = platform({ id: HEAD, tenant_id: "t", title: "Accu", extension_values: { [KWH]: 13.5 } },
      [{ ...definitions[0]!, version: 4, definition: { ...definitions[0]!.definition, label: { nl: "Opslag" } } }]);
    await handler({ id: HEAD }, relabelled.context);
    expect(relabelled.stored[0]!.hash).not.toBe(first.stored[0]!.hash);
  });
});
