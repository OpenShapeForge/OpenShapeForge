// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildConnector } from "./authoring/compiler/connector.js";
import { buildConnectorCatalog, renderConnectorCatalog } from "./generate-connectors.js";
import type { ConnectorDefinition } from "./authoring/types/connector.js";
import type { PlatformSchemaManifest, TableDefinition } from "./schema.js";

function connector(
  name: string,
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    schemaVersion: 1,
    kind: "connector",
    connector: name,
    title: name,
    capabilities: ["operations"],
    implementation: {
      package: `@scope/connector-${name.toLowerCase()}`,
      contractVersion: 1,
      provenance: "firstParty",
      license: { spdx: "LicenseRef-BatterAI-Commercial" },
    },
    operations: [
      {
        key: "listThings",
        kind: "query",
        authorization: { roles: { invoke: ["Connectors.All.Read"] } },
        output: { cardinality: "many", fields: [] },
      },
    ],
    ...overrides,
  } as ConnectorDefinition;
}

/** A manifest carrying one generated-CRUD entity with GraphQL and MCP surfaces. */
function manifestWith(
  source: NonNullable<TableDefinition["source"]>,
): PlatformSchemaManifest {
  return {
    version: 1,
    tables: [
      {
        schema: "erp",
        name: "relations",
        tenantScoped: true,
        generatedCrud: true,
        columns: [{ name: "id", type: "uuid", primaryKey: true }],
        source,
      },
    ],
  };
}

const EMPTY_MANIFEST: PlatformSchemaManifest = { version: 1, tables: [] };

const relationGraphql = {
  typeName: "Relation",
  singleQueryName: "relation",
  listQueryName: "relations",
  createMutationName: "createRelation",
  updateMutationName: "updateRelation",
  deleteMutationName: "deleteRelation",
  relationships: [],
};

describe("connector catalog", () => {
  it("emits an empty, stable catalog when nothing is authored", () => {
    const rendered = renderConnectorCatalog([], EMPTY_MANIFEST);
    expect(JSON.parse(rendered).connectors).toEqual([]);
    expect(rendered).toBe(renderConnectorCatalog([], EMPTY_MANIFEST));
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("sorts connectors by slug regardless of input order", () => {
    const zulu = buildConnector(connector("Zulu"), "zulu", "z.yaml");
    const alpha = buildConnector(connector("Alpha"), "alpha", "a.yaml");

    const catalog = buildConnectorCatalog([zulu, alpha], EMPTY_MANIFEST);
    expect(catalog.connectors.map((entry) => entry.slug)).toEqual(["alpha", "zulu"]);
    // Same set, different order in → identical checksum.
    expect(buildConnectorCatalog([alpha, zulu], EMPTY_MANIFEST).checksum).toBe(
      catalog.checksum,
    );
  });
});

describe("catalog collision audits", () => {
  it("rejects a connector namespace that an entity query already uses", () => {
    const manifest = manifestWith({ graphql: { ...relationGraphql } });
    const clashing = buildConnector(connector("Relations"), "relations", "r.yaml");

    expect(() => buildConnectorCatalog([clashing], manifest)).toThrow(
      /claims the GraphQL root field "relations"/,
    );
  });

  it("rejects a generated type name that an entity type already uses", () => {
    const manifest = manifestWith({
      graphql: { ...relationGraphql, typeName: "SyncListThingsResult" },
    });
    const clashing = buildConnector(connector("Sync"), "sync", "s.yaml");

    expect(() => buildConnectorCatalog([clashing], manifest)).toThrow(
      /generates the GraphQL type "SyncListThingsResult"/,
    );
  });

  it("rejects two connectors claiming the same REST base path", () => {
    const first = buildConnector(
      connector("Alpha", { exposure: { rest: { basePath: "shared" } } }),
      "alpha",
      "a.yaml",
    );
    const second = buildConnector(
      connector("Bravo", { exposure: { rest: { basePath: "shared" } } }),
      "bravo",
      "b.yaml",
    );

    expect(() => buildConnectorCatalog([first, second], EMPTY_MANIFEST)).toThrow(
      /both claim the REST base path "shared"/,
    );
  });

  it("rejects an MCP tool prefix an entity already uses", () => {
    const manifest = manifestWith({
      graphql: { ...relationGraphql },
      mcp: {
        toolPrefix: "sync",
        tools: "dedicated",
        operations: { list: true, get: true, create: false, update: false, delete: false },
      },
    });
    const clashing = buildConnector(
      connector("Sync", { exposure: { mcp: true } }),
      "sync",
      "s.yaml",
    );

    expect(() => buildConnectorCatalog([clashing], manifest)).toThrow(
      /claims the MCP tool prefix "sync"/,
    );
  });
});

describe("shared MCP tool budget", () => {
  it("counts connector tools against the entity tool budget", () => {
    // 58 dedicated entity tools, leaving room for two more.
    const tables: TableDefinition[] = Array.from({ length: 29 }, (_, index) => ({
      schema: "erp",
      name: `t${index}`,
      tenantScoped: true,
      generatedCrud: true,
      columns: [{ name: "id", type: "uuid" as const, primaryKey: true }],
      source: {
        mcp: {
          toolPrefix: `t${index}`,
          tools: "dedicated" as const,
          operations: {
            list: true,
            get: true,
            create: false,
            update: false,
            delete: false,
          },
        },
      },
    }));
    const manifest: PlatformSchemaManifest = { version: 1, tables };

    const twoOperations = connector("Sync", {
      exposure: { mcp: true },
      operations: [
        {
          key: "listThings",
          kind: "query",
          authorization: { roles: { invoke: ["R"] } },
          output: { cardinality: "many", fields: [] },
        },
        {
          key: "getThing",
          kind: "query",
          authorization: { roles: { invoke: ["R"] } },
          output: { cardinality: "one", fields: [] },
        },
      ],
    } as Partial<ConnectorDefinition>);

    // 58 + 2 == the limit: allowed.
    expect(() =>
      buildConnectorCatalog([buildConnector(twoOperations, "sync", "s.yaml")], manifest),
    ).not.toThrow();

    // One more tool tips the shared catalog over the limit.
    const threeOperations = connector("Sync", {
      exposure: { mcp: true },
      operations: [
        ...(twoOperations.operations ?? []),
        {
          key: "putThing",
          kind: "mutation",
          authorization: { roles: { invoke: ["W"] } },
          output: { cardinality: "one", fields: [] },
        },
      ],
    } as Partial<ConnectorDefinition>);

    expect(() =>
      buildConnectorCatalog([buildConnector(threeOperations, "sync", "s.yaml")], manifest),
    ).toThrow(/would advertise 61 dedicated tools/);
  });

  it("does not count connector operations that are not exposed to MCP", () => {
    const compiled = buildConnector(connector("Sync"), "sync", "s.yaml");
    expect(() => buildConnectorCatalog([compiled], EMPTY_MANIFEST)).not.toThrow();
    expect(compiled.operations[0]?.mcp).toBeUndefined();
  });
});
