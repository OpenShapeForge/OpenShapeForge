// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import runtime from "./runtime.js";

const KWH = "11111111-1111-4111-8111-111111111111";
const BSN = "22222222-2222-4222-8222-222222222222";
const HEAD = "44444444-4444-4444-8444-444444444444";
const CHILD = "66666666-6666-4666-8666-666666666666";

/** What the host's extension snapshot service answers (apps/api extensions/snapshot.ts). */
const frozen = {
  extensions: { [KWH]: 13.5 },
  extensionDefinitions: { [KWH]: { version: 3, key: "capaciteit", label: { nl: "Capaciteit" }, osfType: "number", unit: "kWh" } },
};

/** Answers the publish handler's queries; records what it stored and what the service was asked. */
function platform(source: Record<string, unknown>, options: { service?: boolean; child?: Record<string, unknown> } = {}) {
  const stored: Array<{ canonical: string; hash: string }> = [];
  const asked: Array<{ entityName: string; row: Record<string, unknown> }> = [];
  const executor = {
    async executeQuery(query: { sql: string; parameters: readonly unknown[] }) {
      if (query.sql.includes("from \"catalog\".\"products\" source_row")) return { rows: [{ row: source }] };
      if (query.sql.includes("from \"catalog\".\"product_pricings\" child_row")) return { rows: options.child ? [{ row: options.child }] : [] };
      if (query.sql.includes("insert into")) {
        stored.push({ canonical: String(query.parameters[1]), hash: String(query.parameters[2]) });
        return { rows: [{ row: { id: "v", version_number: 1 } }] };
      }
      return { rows: [] };
    },
  };
  const owned = options.child
    ? [{ schema: "catalog", table: "product_pricings", childColumns: ["product_id"], parentColumns: ["id"], children: [] }]
    : [];
  return {
    stored,
    asked,
    context: {
      session: { tenantId: "t", userId: "55555555-5555-4555-8555-555555555555" },
      platform: {
        db: { withSession: (_session: unknown, work: (trx: unknown) => Promise<unknown>) => work(executor) },
        schemas: {
          versioning: { get: () => ({ sourceEntity: "Product", versionEntity: "ProductVersion",
            head: { schema: "catalog", table: "products" }, version: { schema: "catalog", table: "product_versions", headColumn: "product_id" }, owned }) },
          ...(options.service === false ? {} : {
            extensions: { snapshot: async (_trx: unknown, _session: unknown, entityName: string, row: Record<string, unknown>) => {
              asked.push({ entityName, row });
              return frozen;
            } },
          }),
        },
      },
    },
  };
}

const publish = (runtime.operationHandlers as Record<string, (input: unknown, context: unknown) => Promise<unknown>>).publishProductToProductVersion!;

describe("tenant fields in a published snapshot", () => {
  test("freezes what the host's extension snapshot returns, never the raw source, with a deterministic hash", async () => {
    const first = platform({ id: HEAD, tenant_id: "t", title: "Accu", extension_values: { [KWH]: 13.5, [BSN]: "123456782" } });
    const second = platform({ extension_values: { [BSN]: "123456782", [KWH]: 13.5 }, title: "Accu", tenant_id: "t", id: HEAD });
    await publish({ id: HEAD }, first.context);
    await publish({ id: HEAD }, second.context);
    expect(first.asked).toHaveLength(1);
    expect(first.asked[0]!.entityName).toBe("Product");
    expect(first.stored[0]!.hash).toBe(second.stored[0]!.hash);
    const snapshot = JSON.parse(first.stored[0]!.canonical);
    expect(snapshot.head.extensions).toEqual(frozen.extensions);
    expect(snapshot.head.extensionDefinitions).toEqual(frozen.extensionDefinitions);
    expect(snapshot.head.row.extension_values).toBeUndefined();
    expect(first.stored[0]!.canonical).not.toContain("123456782");
  });

  test("an extensible head on a host without the snapshot service is refused, not published raw", async () => {
    const host = platform({ id: HEAD, tenant_id: "t", title: "Accu", extension_values: { [KWH]: 1 } }, { service: false });
    await expect(publish({ id: HEAD }, host.context)).rejects.toThrow("cannot snapshot");
    expect(host.stored).toEqual([]);
  });

  test("the raw source is stripped from every snapshot row, an owned child's included", async () => {
    const host = platform({ id: HEAD, tenant_id: "t", title: "Accu" }, {
      child: { id: CHILD, tenant_id: "t", product_id: HEAD, amount: 10, extension_values: { [BSN]: "123456782" } },
    });
    await publish({ id: HEAD }, host.context);
    const snapshot = JSON.parse(host.stored[0]!.canonical);
    const child = snapshot.head.children.product_pricings[0];
    expect(child.row).toMatchObject({ id: CHILD, amount: 10 });
    expect(child.row.extension_values).toBeUndefined();
    expect(host.stored[0]!.canonical).not.toContain("123456782");
    // A head without the source column needs no service at all.
    expect(host.asked).toEqual([]);
  });
});
