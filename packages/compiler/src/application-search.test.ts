// SPDX-License-Identifier: BUSL-1.1
import { join } from "node:path";
import { expect, test } from "bun:test";
import { catalogApplicationSearchSources } from "./application-search.js";
import { loadOperationCatalogs } from "./authoring/operation-catalog.js";
import type { OperationCatalogDefinition } from "./authoring/types.js";

const read = { data: "read", external: "none" } as const;

/** One catalog operation with only the fields these sources read. */
const operation = (
  description: Record<string, string>,
  auth: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  name: { en: "List", nl: "Lijst" },
  description,
  implementation: { type: "plugin", plugin: "unused", handler: "list" },
  auth,
  tenancy: { mode: "required" },
  effects: read,
  ...overrides,
});

const collection = (route: string, title: Record<string, string>, list: string) => ({
  title,
  route,
  idField: "id",
  displayField: "label",
  fields: ["id", "label"],
  columns: ["label"],
  operations: { list: { operation: list, resultField: "items" } },
});

const catalog = (
  plugin: string,
  operations: Record<string, unknown>,
  entities: Record<string, unknown>,
): OperationCatalogDefinition =>
  ({ schemaVersion: 1, kind: "operationCatalog", plugin, operations, interfaces: { web: { entities } } }) as unknown as OperationCatalogDefinition;

test("two catalogs each offer their tenant collection as a page, with the roles that list it", () => {
  const alpha = catalog(
    "alpha",
    { listThings: operation({ en: "Every thing on file", nl: "Alle zaken in het dossier" }, { mode: "session", roles: ["Alpha.Read"] }, { id: "alpha.list-things" }) },
    { AlphaThing: collection("/alpha-things", { en: "Things", nl: "Zaken" }, "listThings") },
  );
  const beta = catalog(
    "beta",
    { listBeta: operation({ en: "Published runs", nl: "Gepubliceerde uitvoeringen" }, { mode: "session", roleGroups: [["Beta.Read"], ["Beta.Extra"]] }) },
    { BetaThing: collection("/beta-runs", { en: "Runs", nl: "Uitvoeringen" }, "listBeta") },
  );

  // Sorted by name: these reach a generated artifact.
  expect(catalogApplicationSearchSources([beta, alpha])).toEqual({
    sources: [
      {
        entity: "AlphaThing",
        labels: { en: "Things", nl: "Zaken" },
        description: { en: "Every thing on file", nl: "Alle zaken in het dossier" },
        // The pinned canonical id, not `<plugin>.<key>`.
        list: "alpha.list-things",
      },
      {
        entity: "BetaThing",
        labels: { en: "Runs", nl: "Uitvoeringen" },
        description: { en: "Published runs", nl: "Gepubliceerde uitvoeringen" },
        list: "beta.listBeta",
      },
    ],
    roles: ["Alpha.Read", "Beta.Extra", "Beta.Read"],
  });
});

test("a page source carries no record read", () => {
  const { sources } = catalogApplicationSearchSources([catalog(
    "alpha",
    { listThings: operation({ en: "Things" }, { mode: "session", roles: ["Alpha.Read"] }) },
    {
      AlphaThing: {
        ...collection("/alpha-things", { en: "Things", nl: "Zaken" }, "listThings"),
        recordRoute: "/alpha-things/:id",
        operations: { list: { operation: "listThings", resultField: "items" }, get: { operation: "listThings" } },
      },
    },
  )]);
  // No `field`, no `get`, no `descriptionField`: the handler reads a record
  // only for a source that names all of them, and a catalog list Operation
  // states its own query shape rather than accepting an assumed filter.
  expect(sources).toEqual([{
    entity: "AlphaThing",
    labels: { en: "Things", nl: "Zaken" },
    description: { en: "Things" },
    list: "alpha.listThings",
  }]);
});

test("a collection a tenant search cannot honestly offer is not a page", () => {
  const refused = catalog(
    "edge",
    {
      listPlatform: operation({ en: "Tenants" }, { mode: "control", roles: ["Platform.Operate"] }, { tenancy: { mode: "none" } }),
      listUntenanted: operation({ en: "Anything" }, { mode: "session", roles: ["Edge.Read"] }, { tenancy: { mode: "derived" } }),
      listByWriting: operation({ en: "Written" }, { mode: "session", roles: ["Edge.Read"] }, { effects: { data: "write", external: "none" } }),
      listChildren: operation({ en: "Children" }, { mode: "session", roles: ["Edge.Read"] }),
      listPublic: operation({ en: "Public" }, { mode: "public" }),
      listCoreNamed: operation({ en: "Core" }, { mode: "session", roles: ["Edge.Read"] }),
      listUnknown: operation({ en: "Unknown" }, { mode: "session", roles: ["Edge.Read"] }),
    },
    {
      PlatformTenant: collection("/tenants", { en: "Tenants" }, "listPlatform"),
      Untenanted: collection("/untenanted", { en: "Anything" }, "listUntenanted"),
      Written: collection("/written", { en: "Written" }, "listByWriting"),
      // The parameter belongs to the record page this collection hangs under.
      Child: collection("/parents/:parentId/children", { en: "Children" }, "listChildren"),
      Public: collection("/public", { en: "Public" }, "listPublic"),
      Invoice: collection("/catalog-invoices", { en: "Invoices" }, "listCoreNamed"),
      Absent: collection("/absent", { en: "Absent" }, "listMissingOperation"),
    },
  );
  // "Invoice" is a core entity here: it owns the name in the web manifest too.
  expect(catalogApplicationSearchSources([refused], new Set(["Invoice"])))
    .toEqual({ sources: [], roles: [] });
});

test("a collection open to every authenticated session is a page that widens no role", () => {
  expect(catalogApplicationSearchSources([catalog(
    "open",
    { listOpen: operation({ en: "Open" }, { mode: "session", anyAuthenticatedSession: true }) },
    { OpenThing: collection("/open-things", { en: "Open", nl: "Open" }, "listOpen") },
  )])).toEqual({
    sources: [{ entity: "OpenThing", labels: { en: "Open", nl: "Open" }, description: { en: "Open" }, list: "open.listOpen" }],
    roles: [],
  });
});

test("this repository's own catalogs offer their tenant collections and withhold the rest", () => {
  const catalogs = loadOperationCatalogs(join(import.meta.dir, "../config/authoring"))
    .map(({ document }) => document);
  const { sources, roles } = catalogApplicationSearchSources(catalogs);
  const offered = sources.map((source) => source.entity);

  expect(offered).toEqual([
    "AccessInvitationRelation", "AccessMember", "AccessPermission", "AccessRole", "ApiKeyIntegration",
  ]);
  expect(sources.every((source) => !("field" in source) && !("get" in source))).toBe(true);
  expect(sources.find((source) => source.entity === "AccessRole")?.labels)
    .toEqual({ en: "Roles", nl: "Rollen" });
  // A platform operator's tenant list is read in the control realm, and the
  // rest hang under a record page that parameterizes them.
  for (const withheld of ["PlatformTenant", "GroupRoleAssignment", "RecordActionAssignment", "AccessMemberAudit"]) {
    expect(offered).not.toContain(withheld);
  }
  expect(roles).toContain("Organization.Access.Manage");
});
