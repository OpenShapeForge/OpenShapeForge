// SPDX-License-Identifier: BUSL-1.1
/**
 * Entity subtypes (`kind: entitySubtype`): a Team and a ProjectGroup composed
 * over one synthetic Group base, through the loader, the compiler, the
 * backend manifest and the Web and MCP projections — and the refusals that
 * keep the composition safe: no new fields, no widened rights, no leaked
 * hidden fields, no duplicate identities, no unsupported bases.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { compile } from "./compiler/index.js";
import { resolveAuthoringLayers } from "./layers.js";
import { loadEntity } from "./loader.js";
import { buildWebManifest } from "./web-manifest.js";
import { buildMcpCatalog } from "../generate-mcp.js";
import { generateArtifacts } from "../generate.js";
import { tableRegistryName } from "../schema.js";
import type { PlatformSchemaManifest } from "../schema.js";

type Doc = Record<string, unknown>;

const operation = (action: string, extra: Doc = {}): Doc => ({
  name: { en: `${action} group` },
  description: { en: `${action} a group.` },
  implementation: { type: "entity", action },
  effects: { data: action === "list" || action === "get" ? "read" : action === "delete" ? "delete" : "write", external: "none" },
  reliability: { idempotency: { mode: action === "create" || action === "update" ? "none" : "natural" } },
  confirmation: { mode: "none" },
  ...extra,
});

/** The base every subtype below extends: a typed group with a sibling-only secret. */
function group(): Doc {
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: "Group", title: "Group", language: "en",
    description: { en: "A group of persons." },
    displayTemplate: "{{name}}", filterField: "name",
    labels: { en: "Group", nl: "Groep" }, pluralLabels: { en: "Groups", nl: "Groepen" },
    authorization: {
      roles: { read: ["Groups.Read", "Groups.Manage"], create: ["Groups.Manage"], update: ["Groups.Manage"], delete: ["Groups.Manage"] },
      rowAccess: { enabled: true, empty: "public" },
    },
    retention: { mode: "inline", duration: "P1Y", startsFrom: { strategy: "createdAt" }, disposition: { action: "archive" } },
    fields: [
      { key: "name", osfType: "string", required: true, label: { en: "Name", nl: "Naam" }, validation: { minLength: 1, maxLength: 100 },
        persisted: { column: "name", storageClass: "core" } },
      { key: "groupType", osfType: "string", required: true, label: { en: "Group type", nl: "Groepstype" },
        options: { type: "static", items: [{ value: "team", label: { en: "Team" } }, { value: "project", label: { en: "Project" } }, { value: "other", label: { en: "Other" } }] },
        persisted: { column: "group_type", storageClass: "core" } },
      { key: "status", osfType: "string", required: true, defaultValue: "active", label: { en: "Status", nl: "Status" },
        permissions: { write: ["Groups.Manage"] },
        persisted: { column: "status", storageClass: "core" } },
      { key: "secretNote", osfType: "string", label: { en: "Secret note", nl: "Geheime notitie" }, validation: { maxLength: 500 },
        persisted: { column: "secret_note", storageClass: "core" } },
      { key: "leadId", osfType: "Person", label: { en: "Lead", nl: "Leider" }, persisted: { column: "lead_id", storageClass: "core" },
        relationship: { ownership: "reference", inverse: { key: "ledGroups" } } },
    ],
    operations: {
      list: operation("list"), get: operation("get"), create: operation("create"),
      update: operation("update", { concurrency: { version: { mode: "required", field: "updatedAt" }, editLease: { mode: "required", expiresAfterInactivity: "PT15M" } } }),
      delete: operation("delete"),
      // The native collection Operations a host plugin patches onto the base
      // (insert/update a member through the group), as the employee plugin
      // does for memberships: authored before any subtype derives from it.
      insertMember: {
        name: { en: "Add member" }, description: { en: "Adds a person to the group." },
        implementation: { type: "collection", field: "members", action: "insert" },
        effects: { data: "write", external: "none" }, reliability: { idempotency: { mode: "none" } }, confirmation: { mode: "none" },
        concurrency: { version: { mode: "required", field: "updatedAt" } },
      },
      updateMember: {
        name: { en: "Change member" }, description: { en: "Changes a member of the group." },
        implementation: { type: "collection", field: "members", action: "update" },
        effects: { data: "write", external: "none" }, reliability: { idempotency: { mode: "none" } }, confirmation: { mode: "none" },
        concurrency: { version: { mode: "required", field: "updatedAt" } },
      },
    },
    interfaces: {
      rest: {}, graphql: {}, mcp: { resource: { uri: "app://groups", name: "Groups" } },
      web: {
        views: {
          collection: { route: { en: "/groups", nl: "/groepen" }, title: { en: "Groups" },
            columns: [{ key: "name", sortable: true }, { key: "groupType" }, { key: "status" }], defaultSort: { key: "name", direction: "asc" } },
          record: {
            routes: { read: { en: "/groups/:id", nl: "/groepen/:id" }, create: { en: "/groups/new", nl: "/groepen/nieuw" } },
            title: "{{name}}", actions: ["update", "delete"],
            layout: {
              context: { fields: ["groupType", "status"], relationships: ["leadId"] },
              tabs: [
                { id: "overview", label: { en: "Overview" }, groups: [
                  { title: { en: "General" }, fields: ["name", "groupType", "status"] },
                  { title: { en: "Private" }, fields: ["secretNote"] },
                ] },
                { id: "members", label: { en: "Members" }, relationship: "members" },
              ],
            },
            modes: {
              create: { title: { en: "Create group" }, groups: [{ title: { en: "General" }, fields: ["name", "groupType", "status", "secretNote"] }] },
              update: { title: { en: "Update group" } },
            },
          },
        },
      },
    },
  };
}

function person(): Doc {
  return {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: "Person", title: "Person", language: "en",
    displayTemplate: "{{name}}", filterField: "name", labels: { en: "Person" },
    authorization: { roles: { read: ["Groups.Read"], create: ["Groups.Manage"], update: ["Groups.Manage"], delete: ["Groups.Manage"] }, rowAccess: { enabled: true, empty: "public" } },
    fields: [
      { key: "name", osfType: "string", required: true, persisted: { column: "name", storageClass: "core" } },
      { key: "groupId", osfType: "Group", persisted: { column: "group_id", storageClass: "core" }, relationship: { ownership: "reference", inverse: { key: "members" } } },
    ],
    operations: { list: operation("list"), get: operation("get"), create: operation("create"),
      update: operation("update", { concurrency: { version: { mode: "required", field: "updatedAt" } } }), delete: operation("delete") },
    interfaces: { rest: {}, graphql: {}, mcp: {}, web: { views: {
      collection: { route: "/persons", columns: [{ key: "name" }] },
      record: { routes: { read: "/persons/:id" }, title: "{{name}}", layout: { tabs: [{ id: "main", label: { en: "Main" }, groups: [{ title: { en: "Main" }, fields: ["name"] }] }] } },
    } } },
  };
}

function team(): Doc {
  return {
    schemaVersion: 3, kind: "entitySubtype", entity: "Team", extends: "Group", scope: { groupType: "team" },
    title: "Team", labels: { en: "Team", nl: "Team" }, pluralLabels: { en: "Teams", nl: "Teams" },
    description: { en: "A team of persons." },
    fields: [
      { key: "groupType", hidden: true },
      { key: "secretNote", hidden: true },
      { key: "name", label: { en: "Team name", nl: "Teamnaam" }, validation: { maxLength: 60 } },
    ],
    authorization: { roles: { read: ["Groups.Manage"] } },
    operations: { list: { description: { en: "Lists teams only." }, guidance: { assistant: { en: "Find a team before changing it." } } } },
    interfaces: {
      rest: { basePath: "teams" },
      mcp: { resource: { uri: "app://teams", name: "Teams" } },
      web: { views: {
        collection: { route: { en: "/teams", nl: "/teams" }, title: { en: "Teams" } },
        record: { routes: { read: { en: "/teams/:id", nl: "/teams/:id" }, create: { en: "/teams/new", nl: "/teams/nieuw" } } },
      } },
    },
  };
}

function projectGroup(): Doc {
  return {
    schemaVersion: 3, kind: "entitySubtype", entity: "ProjectGroup", extends: "Group", scope: { groupType: "project" },
    title: "Project group", labels: { en: "Project group", nl: "Projectgroep" }, pluralLabels: { en: "Project groups", nl: "Projectgroepen" },
    description: { en: "The persons assigned to one project." },
    fields: [{ key: "groupType", hidden: true }],
    operations: { list: { description: { en: "Lists project groups only." } } },
    interfaces: {
      rest: { basePath: "project-groups" },
      mcp: { resource: { uri: "app://project-groups", name: "Project groups" } },
      web: { views: {
        collection: { route: { en: "/project-groups", nl: "/projectgroepen" }, title: { en: "Project groups" } },
        record: { routes: { read: { en: "/project-groups/:id", nl: "/projectgroepen/:id" }, create: { en: "/project-groups/new", nl: "/projectgroepen/nieuw" } } },
      } },
    },
  };
}

const temporary: string[] = [];

function authoringDir(documents: Record<string, Doc>): string {
  const dir = mkdtempSync(join(tmpdir(), "entity-subtype-"));
  temporary.push(dir);
  mkdirSync(join(dir, "entities"));
  // The real component and type catalogs: the view compiler needs the view
  // defaults, and the fixture entities only use base types.
  cpSync(join(import.meta.dir, "__fixtures__", "rowaccess", "catalogs"), join(dir, "catalogs"), { recursive: true });
  const write = (path: string, value: unknown) => writeFileSync(join(dir, path), JSON.stringify(value));
  write("entities/_base.yaml", { schemaVersion: 1, kind: "baseEntity", entity: "Base", fields: [
    { key: "id", osfType: "string", required: true, readOnly: true, validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" } },
    { key: "createdAt", osfType: "datetime", readOnly: true, persisted: { column: "created_at", storageClass: "core" } },
    { key: "updatedAt", osfType: "datetime", readOnly: true, persisted: { column: "updated_at", storageClass: "core" } },
  ] });
  for (const [slug, document] of Object.entries(documents)) write(`entities/${slug}.yaml`, document);
  return dir;
}

const corpus = (extra: Record<string, Doc> = {}) => ({ group: group(), person: person(), team: team(), "project-group": projectGroup(), ...extra });
const slugs = (documents: Record<string, Doc>) => Object.keys(documents).sort();

function manifestOf(documents: Record<string, Doc>, onCandidate?: Parameters<typeof compileAuthoringBackendManifest>[1]["onCandidate"]): PlatformSchemaManifest {
  return compileAuthoringBackendManifest(authoringDir(documents), {
    mode: "promote", entityAllowlist: slugs(documents), generatedCrudAllowlist: slugs(documents),
    schemaByModule: { core: "erp" }, sourcePathPrefix: "fixtures/subtypes",
    ...(onCandidate ? { onCandidate } : {}),
  });
}

afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

describe("composing a subtype over its base", () => {
  const dir = authoringDir(corpus());
  const teamContract = compile(loadEntity(dir, "team"));
  const projectContract = compile(loadEntity(dir, "project-group"));
  const groupContract = compile(loadEntity(dir, "group"));

  test("keeps the base's table and record identity, under its own entity identity", () => {
    expect(teamContract.entity).toMatchObject({ id: "core.Team", name: "Team", labels: { en: "Team", nl: "Team" } });
    expect(teamContract.storage.table).toBe("groups");
    expect(projectContract.storage.table).toBe("groups");
    expect(teamContract.subtype).toEqual({
      base: { name: "Group", id: "core.Group", slug: "group" },
      scope: [{ field: "groupType", column: "group_type", value: "team" }],
      hiddenFields: ["groupType", "secretNote"],
      hiddenColumns: [{ field: "groupType", column: "group_type" }, { field: "secretNote", column: "secret_note" }],
    });
    expect(projectContract.subtype?.scope).toEqual([{ field: "groupType", column: "group_type", value: "project" }]);
    expect(teamContract.model.fields.find((field) => field.key === "id")?.osfType).toBe("groupId");
  });

  test("inherits every base field, relationship and Operation, and adds none", () => {
    const baseKeys = groupContract.model.fields.map((field) => field.key);
    const projectKeys = projectContract.model.fields.map((field) => field.key);
    expect(projectKeys).toEqual(baseKeys.filter((key) => key !== "groupType"));
    expect(projectContract.model.relationships.map((relationship) => relationship.key)).toEqual(
      groupContract.model.relationships.map((relationship) => relationship.key));
    expect(projectContract.model.relationships.find((relationship) => relationship.key === "members")).toMatchObject({ kind: "hasMany", target: "Person", foreignKey: "group_id" });
    expect(Object.keys(teamContract.entityOperations)).toEqual(["list", "get", "create", "update", "delete"]);
    expect(teamContract.entityOperations.update?.concurrency?.editLease?.mode).toBe("required");
    expect(teamContract.entityOperations.list?.id).toBe("Team.list");
    expect(teamContract.entityOperations.list?.entityId).toBe("core.Team");
    expect(teamContract.blueprint).toBeUndefined();
  });

  test("inherits the base's native collection Operations under its own identity", () => {
    expect(teamContract.pluginOperations?.map((operation) => operation.id)).toEqual(["Team.insertMember", "Team.updateMember"]);
    expect(teamContract.pluginOperations?.[0]).toMatchObject({
      key: "insertMember", entityId: "core.Team", entityName: "Team",
      definition: { implementation: { type: "collection", field: "members", action: "insert" } },
    });
    expect(groupContract.pluginOperations?.map((operation) => operation.id)).toEqual(["Group.insertMember", "Group.updateMember"]);
    // An arbitrary plugin handler is still refused: nothing holds it to the scope.
    const plugged = corpus();
    (plugged.group!.operations as Doc).archive = {
      name: { en: "Archive" }, description: { en: "Archives." }, implementation: { type: "plugin", plugin: "groups", handler: "archive" },
      target: { scope: "record", inputField: "id" }, input: { schema: { type: "object" } }, output: { schema: { type: "object" } },
      auth: { mode: "session", roles: ["Groups.Manage"] }, tenancy: { mode: "required" },
      effects: { data: "write", external: "none" }, reliability: { idempotency: { mode: "none" } }, confirmation: { mode: "none" },
    };
    expect(() => compile(loadEntity(authoringDir(plugged), "team"))).toThrow(/Operation archive is plugin-implemented/);
  });

  test("hides a derived inverse collection together with its collection Operations", () => {
    const hiddenMembers = corpus({ squad: {
      ...team(), entity: "Squad", fields: [{ key: "groupType", hidden: true }, { key: "members", hidden: true }],
      interfaces: { rest: { basePath: "squads" }, mcp: { resource: { uri: "app://squads", name: "Squads" } },
        web: { views: { collection: { route: "/squads" }, record: { routes: { read: "/squads/:id", create: "/squads/new" } } } } },
    } });
    const squad = compile(loadEntity(authoringDir(hiddenMembers), "squad"));
    expect(squad.subtype?.hiddenFields).toEqual(["groupType", "members"]);
    expect(squad.model.fields.map((field) => field.key)).not.toContain("members");
    expect(squad.model.relationships.map((relationship) => relationship.key)).toEqual(["leadId"]);
    expect(squad.graphql.relationships.map((relationship) => relationship.name)).toEqual(["leadId"]);
    expect(squad.pluginOperations).toEqual([]);
    expect(squad.views.core?.detail?.groups.items.map((tab) => tab.id)).toEqual(["overview"]);
    // The base keeps the collection and its Operations.
    expect(groupContract.pluginOperations?.length).toBe(2);
    // A relationship the base does not have is still refused.
    const unknown = corpus({ squad: { ...team(), entity: "Squad", fields: [{ key: "memberships", hidden: true }], interfaces: {} } });
    expect(() => compile(loadEntity(authoringDir(unknown), "squad"))).toThrow(/fields.memberships does not exist on Group/);
  });

  test("hides fields from every public section and keeps the discriminator server-owned", () => {
    const keys = teamContract.model.fields.map((field) => field.key);
    expect(keys).not.toContain("groupType");
    expect(keys).not.toContain("secretNote");
    expect(teamContract.storage.columns.map((column) => column.column)).not.toContain("secret_note");
    expect(teamContract.graphql.fields.map((field) => field.name)).not.toContain("secretNote");
    // The ProjectGroup keeps secretNote but still never writes its discriminator.
    const discriminator = projectContract.model.fields.find((field) => field.key === "groupType");
    expect(discriminator).toBeUndefined();
    const visibleScope = compile(loadEntity(authoringDir(corpus({ shown: { ...projectGroup(), entity: "Shown", fields: [], interfaces: { rest: { basePath: "shown" }, mcp: { resource: { uri: "app://shown", name: "Shown" } }, web: { views: { collection: { route: "/shown" }, record: { routes: { read: "/shown/:id", create: "/shown/new" } } } } } } })), "shown"));
    expect(visibleScope.model.fields.find((field) => field.key === "groupType")).toMatchObject({ readOnly: true, writtenBy: ["Shown.create"] });
  });

  test("restates text and narrows rights and validation without touching the base", () => {
    expect(teamContract.authorization.roles.read).toEqual(["Groups.Manage"]);
    expect(groupContract.authorization.roles.read).toEqual(["Groups.Read", "Groups.Manage"]);
    expect(teamContract.authorization.roles.update).toEqual(["Groups.Manage"]);
    expect(teamContract.model.fields.find((field) => field.key === "name")).toMatchObject({ label: { en: "Team name", nl: "Teamnaam" }, validation: { minLength: 1, maxLength: 60 } });
    expect(teamContract.entityOperations.list?.description).toEqual({ en: "Lists teams only." });
    expect(teamContract.entityOperations.list?.guidance).toEqual({ assistant: { en: "Find a team before changing it." } });
    expect(teamContract.entityOperations.get?.description).toEqual(groupContract.entityOperations.get?.description);
  });

  test("prunes hidden fields from inherited presentation and keeps the subtype's routes", () => {
    const view = teamContract.views.core!;
    expect(view.routes.list).toEqual({ en: "/teams", nl: "/teams" });
    expect(view.routes.detail).toEqual({ en: "/teams/:id", nl: "/teams/:id" });
    expect(view.list?.columns.map((column) => column.key)).toEqual(["name", "status"]);
    const groups = view.detail?.groups.items.flatMap((tab) => tab.groups ?? []) ?? [];
    expect(groups.map((group) => group.fields)).toEqual([["name", "status"]]);
    expect(teamContract.interfaces?.web?.recordContext?.fields).toEqual(["status"]);
    expect(view.form?.variants.create?.groups?.[0]?.fields).toEqual(["name", "status"]);
  });

  test("drops an inherited board whose grouping field is hidden by the subtype", () => {
    const docs = corpus();
    const collection = ((((docs.group!.interfaces as Doc).web as Doc).views as Doc).collection as Doc);
    collection.board = { groupBy: "groupType", card: { title: "name", body: ["status"] } };
    const compiled = compile(loadEntity(authoringDir(docs), "team"));
    expect(compiled.interfaces?.web?.collectionBoard).toBeUndefined();
  });
});

describe("the backend manifest and generated artifacts", () => {
  const candidates = new Map<string, Parameters<NonNullable<Parameters<typeof compileAuthoringBackendManifest>[1]["onCandidate"]>>[0]>();
  const manifest = manifestOf(corpus(), (candidate) => candidates.set(candidate.slug, candidate));

  test("emits no table for a subtype and binds it to the base table instead", () => {
    expect(manifest.tables.map((table) => table.name).sort()).toEqual(["groups", "persons"]);
    expect(manifest.entitySubtypes?.map((table) => table.source?.authoringEntityName)).toEqual(["ProjectGroup", "Team"]);
    const teamTable = manifest.entitySubtypes!.find((table) => table.source?.authoringEntityName === "Team")!;
    expect(teamTable).toMatchObject({ schema: "erp", name: "groups", tenantScoped: true, generatedCrudEligible: true });
    expect(teamTable.subtype).toEqual({
      base: { entityName: "Group", entityId: "core.Group", slug: "group", table: "erp.groups" },
      scope: [{ field: "groupType", column: "group_type", value: "team" }],
      hiddenColumns: [{ field: "groupType", column: "group_type" }, { field: "secretNote", column: "secret_note" }],
    });
    expect(teamTable.columns.map((column) => column.name)).toEqual(
      manifest.tables.find((table) => table.name === "groups")!.columns.map((column) => column.name).filter((name) => name !== "group_type" && name !== "secret_note"));
    expect(teamTable.indexes).toBeUndefined();
    expect(teamTable.rowScope).toBeUndefined();
    // The base's retention guard travels with the projection: the delete
    // path reads minimum periods and holds from the table it serves.
    expect(teamTable.retention).toEqual(manifest.tables.find((table) => table.name === "groups")!.retention);
    expect(teamTable.retention?.clock.column).toBe("created_at");
    expect(teamTable.source?.authorization?.roles.read).toEqual(["Groups.Manage"]);
    expect(teamTable.source?.graphql?.relationships.map((relationship) => relationship.name)).toEqual(["leadId", "members"]);
    expect(teamTable.source?.rest?.basePath).toBe("teams");
    expect(tableRegistryName(teamTable)).toBe("erp.groups@Team");
  });

  test("renders DDL for the base only and the subtypes under entitySubtypes", () => {
    const artifacts = generateArtifacts(manifest, { operations: [] });
    const sql = artifacts.find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
    expect(sql.match(/CREATE TABLE IF NOT EXISTS "erp"\."groups"/g)).toHaveLength(1);
    const json = JSON.parse(artifacts.find((artifact) => artifact.path.endsWith("manifest.json"))!.contents);
    expect(json.tables.map((table: { name: string }) => table.name).sort()).toEqual(["erp.groups", "erp.persons"]);
    expect(json.entitySubtypes.map((table: { name: string }) => table.name)).toEqual(["erp.groups@ProjectGroup", "erp.groups@Team"]);
    expect(json.entitySubtypes[1].realtime).toBeUndefined();
    expect(json.entitySubtypes[1].columns.map((column: { name: string }) => column.name)).not.toContain("group_type");
    expect(json.capabilities.generatedEntities.map((entity: { slug: string }) => entity.slug)).toEqual(["group", "person"]);
    const withoutSubtypes = { ...manifest };
    delete withoutSubtypes.entitySubtypes;
    const baseline = JSON.parse(generateArtifacts(withoutSubtypes, { operations: [] }).find((artifact) => artifact.path.endsWith("manifest.json"))!.contents);
    expect(json.checksum).toBe(baseline.checksum);
    // Without the compiled contracts no entity route is documented, the
    // subtypes' included; only the platform transports remain.
    const openapi = JSON.parse(artifacts.find((artifact) => artifact.path.endsWith("openapi.json"))!.contents);
    expect(Object.keys(openapi.paths).filter((path) => path.startsWith("/api/rest/v1/"))).toEqual([]);
  });

  test("projects distinct REST resources from the subtype contracts", () => {
    const entities = [...candidates.values()].map((candidate) => ({ slug: candidate.slug, path: candidate.path, origin: candidate.origin, contract: candidate.contract }));
    const openapi = JSON.parse(generateArtifacts(manifest, { operations: [], openApi: { entities } })
      .find((artifact) => artifact.path.endsWith("openapi.json"))!.contents);
    expect(Object.keys(openapi.paths).filter((path) => path.includes("teams") || path.includes("project-groups")).sort())
      .toEqual(["/api/rest/v1/project-groups", "/api/rest/v1/project-groups/{id}", "/api/rest/v1/teams", "/api/rest/v1/teams/{id}"]);
    expect(Object.keys(openapi.components.schemas.Team.properties)).not.toContain("secretNote");
    expect(Object.keys(openapi.components.schemas.Team.properties)).not.toContain("groupType");
    expect(Object.keys(openapi.components.schemas.TeamInput.properties)).not.toContain("groupType");
    expect(Object.keys(openapi.components.schemas.ProjectGroupInput.properties)).toContain("secretNote");
    expect(Object.keys(openapi.components.schemas.ProjectGroupInput.properties)).not.toContain("groupType");
  });

  test("projects distinct Web and MCP contracts", () => {
    const entities = [...candidates.values()].map((candidate) => ({ slug: candidate.slug, contract: candidate.contract }));
    const web = buildWebManifest(entities);
    expect(web.entities.Team?.entitySlug).toBe("team");
    expect(web.entities.Team?.views.collection.route).toBe("/teams");
    expect(web.entities.Team?.views.record?.routes).toEqual({ read: "/teams/:id", create: "/teams/new" });
    expect(web.entities.ProjectGroup?.views.collection.route).toBe("/project-groups");
    expect(web.entities.Group?.views.collection.route).toBe("/groups");
    expect(Object.keys(web.entities.Team!.fields)).not.toContain("secretNote");
    expect(Object.keys(web.entities.Team!.fields)).not.toContain("groupType");
    expect(web.entities.ProjectGroup?.fields.secretNote?.supports).toEqual({ read: true, create: true, update: true });
    expect(web.entities.Team?.views.collection.columns.map((column) => column.key)).toEqual(["name", "status"]);
    expect(web.entities.Team?.relationships.members).toMatchObject({ kind: "hasMany", targetEntityId: "Person", targetRoute: "/persons" });
    expect(web.entities.Team?.operations.list?.id).toBe("Team.list");
    // The inherited native collection Operations are the subtype's own
    // addressable Operations, materialized over its own relationship.
    expect(web.entities.Team?.relationships.members?.operations.insert?.id).toBe("Team.insertMember");
    expect(web.entities.Team?.relationships.members?.operations.update?.id).toBe("Team.updateMember");
    expect(web.entities.Team?.relationships.members?.mutationSupport).toBe("atomic");
    expect(web.entities.Group?.relationships.members?.operations.insert?.id).toBe("Group.insertMember");

    const mcp = buildMcpCatalog(entities.map((entity) => ({
      slug: entity.slug, contract: entity.contract,
      table: entity.contract.subtype ? `erp.groups@${entity.contract.entity.name}` : `erp.${entity.contract.storage.table}`,
    })), "fixtures/subtypes");
    const tool = (entity: string, operation: string) => mcp.tools.find((candidate) => candidate.entity === entity && candidate.operation === operation)!;
    expect(tool("Team", "list").name).toBe("team_list");
    expect(tool("Team", "list").table).toBe("erp.groups@Team");
    expect(tool("Team", "list").description).toContain("Lists teams only.");
    expect(tool("Team", "list").description).toContain("Find a team before changing it.");
    expect(tool("ProjectGroup", "list").description).toContain("Lists project groups only.");
    expect(tool("Group", "list").description).not.toContain("teams only");
    expect(Object.keys(tool("Team", "create").inputSchema.properties as object)).not.toContain("groupType");
    expect(Object.keys(tool("Team", "create").inputSchema.properties as object)).not.toContain("secretNote");
    expect(tool("Team", "create").description).not.toContain("groupType");
    expect(mcp.entities.find((entity) => entity.entity === "Team")?.fields.map((field) => field.key)).not.toContain("groupType");
    expect(mcp.resources.map((resource) => resource.uri).sort()).toEqual(["app://groups", "app://project-groups", "app://teams"]);
  });
});

describe("a subtype inherits the layered base", () => {
  test("sees an entityPatch applied to its base in a later layer", () => {
    const base = authoringDir(corpus());
    const overlay = mkdtempSync(join(tmpdir(), "entity-subtype-overlay-"));
    temporary.push(overlay);
    mkdirSync(join(overlay, "entities"));
    writeFileSync(join(overlay, "entities", "group.yaml"), JSON.stringify({ kind: "entityPatch", fields: [
      { key: "budget", osfType: "integer", label: { en: "Budget" }, persisted: { column: "budget", storageClass: "core" } },
      { key: "name", validation: { maxLength: 80 } },
    ] }));
    const repoRoot = mkdtempSync(join(tmpdir(), "entity-subtype-repo-"));
    temporary.push(repoRoot);
    const resolved = resolveAuthoringLayers(repoRoot, { layers: [base, overlay] });
    const contract = compile(loadEntity(resolved, "team"));
    expect(contract.model.fields.find((field) => field.key === "budget")).toMatchObject({ baseType: "integer" });
    expect(contract.storage.columns.map((column) => column.column)).toContain("budget");
    expect(contract.model.fields.find((field) => field.key === "name")?.validation).toEqual({ minLength: 1, maxLength: 60 });
  });
});

describe("refusals", () => {
  const refuse = (documents: Record<string, Doc>, slug: string, pattern: RegExp) => {
    expect(() => compile(loadEntity(authoringDir(documents), slug))).toThrow(pattern);
  };
  const variant = (mutate: (subtype: Doc) => void): Record<string, Doc> => {
    const documents = corpus();
    mutate(documents.team!);
    return documents;
  };

  test("unknown keys, new fields and new Operations", () => {
    refuse(variant((subtype) => { subtype.module = "core"; }), "team", /additionalProperty="module"/);
    refuse(variant((subtype) => { (subtype.fields as Doc[]).push({ key: "budget", osfType: "integer" }); }), "team", /additionalProperty="osfType"/);
    refuse(variant((subtype) => { (subtype.fields as Doc[]).push({ key: "budget", label: { en: "Budget" } }); }), "team", /fields.budget does not exist on Group/);
    refuse(variant((subtype) => { (subtype.operations as Doc).archive = { name: { en: "Archive" } }; }), "team", /operations.archive does not exist/);
    refuse(variant((subtype) => { (subtype.fields as Doc[]).push({ key: "status", required: false }); }), "team", /required: must be equal to constant/);
    refuse(variant((subtype) => { (subtype.fields as Doc[]).push({ key: "status", hidden: false }); }), "team", /hidden: must be equal to constant/);
  });

  test("missing, chained and unsupported bases", () => {
    refuse(variant((subtype) => { subtype.extends = "Committee"; }), "team", /no authored coreEntity declares that entity/);
    refuse(corpus({ squad: { ...team(), entity: "Squad", extends: "Team", interfaces: {} } }), "squad", /itself a subtype/);
    refuse(variant((subtype) => { subtype.extends = "Team"; }), "team", /itself a subtype|cannot extend itself/);
    const versioned = corpus();
    versioned.group!.versioning = { strategy: "publishedSnapshot", versionEntity: "Person", versionsField: "members" };
    refuse(versioned, "team", /declares versioning/);
  });

  test("scope must be a stored scalar the subtype's value fits", () => {
    refuse(variant((subtype) => { subtype.scope = { leadId: "x" }; }), "team", /scope.leadId must be a single scalar field/);
    refuse(variant((subtype) => { subtype.scope = { groupType: 7 }; }), "team", /does not fit the string field/);
    refuse(variant((subtype) => { subtype.scope = { groupType: "committee" }; }), "team", /not one of the field's static options/);
    // A derived collection is a base field, but no discriminator.
    refuse(variant((subtype) => { subtype.scope = { members: "x" }; }), "team", /scope.members must be a persisted field/);
    refuse(variant((subtype) => { subtype.scope = { id: "x" }; }), "team", /intrinsic identity field/);
    refuse(variant((subtype) => { subtype.scope = {}; }), "team", /scope: must NOT have fewer than 1 properties/);
  });

  test("hidden fields need a server-owned value and may not be referenced", () => {
    // `name` carries the display template; a subtype that restates it still
    // cannot hide a required field the server has no value for.
    refuse(variant((subtype) => { (subtype.fields as Doc[])[2] = { key: "name", hidden: true }; subtype.displayTemplate = "{{status}}"; subtype.filterField = "status"; ((subtype.interfaces as Doc).web as Doc).views = { ...(((subtype.interfaces as Doc).web as Doc).views as Doc), record: { ...((((subtype.interfaces as Doc).web as Doc).views as Doc).record as Doc), title: "{{status}}" } }; }), "team", /hides required field name, which has no server-owned value/);
    refuse(variant((subtype) => {
      ((subtype.interfaces as Doc).web as Doc).views = { collection: { route: "/teams", columns: [{ key: "secretNote" }] } };
    }), "team", /referenced by the subtype's own configuration at interfaces.web.views.collection.columns \(secretNote\)/);
    refuse(variant((subtype) => { subtype.displayTemplate = "{{secretNote}}"; }), "team", /\{\{secretNote\}\}/);
    refuse(variant((subtype) => { subtype.filterField = "secretNote"; }), "team", /filterField \(secretNote\)/);
    const hiddenTitle = corpus();
    (((hiddenTitle.group!.interfaces as Doc).web as Doc).views as Doc).record = {
      ...((((hiddenTitle.group!.interfaces as Doc).web as Doc).views as Doc).record as Doc), title: "{{secretNote}}",
    };
    refuse(hiddenTitle, "team", /interfaces.web.views.record.title of Group refers to it/);
    // Hidden with a default stays possible; hidden with a value the scope fixes too.
    const hiddenStatus = variant((subtype) => { (subtype.fields as Doc[]).push({ key: "status", hidden: true }); });
    expect(compile(loadEntity(authoringDir(hiddenStatus), "team")).subtype?.hiddenFields).toEqual(["groupType", "secretNote", "status"]);
  });

  test("the row policy is inherited exactly; only roles and field rights narrow", () => {
    refuse(variant((subtype) => { subtype.authorization = { roles: { read: ["Groups.Manage"] }, rowAccess: { enabled: true, empty: "public", owner: { field: "leadId" } } }; }), "team", /rowAccess/);
    refuse(variant((subtype) => { subtype.authorization = { roles: { read: ["Groups.Manage"] }, rowAccess: { enabled: true, empty: "public" } }; }), "team", /rowAccess/);
  });

  test("a scope value must satisfy the base field's whole value contract", () => {
    const patterned = corpus();
    (patterned.group!.fields as Doc[])[1] = { ...((patterned.group!.fields as Doc[])[1] as Doc), validation: { pattern: "^t" } };
    expect(() => manifestOf(patterned)).toThrow(/scope.groupType value "project" does not satisfy Group.groupType's value contract/);
    const fits = corpus();
    (fits.group!.fields as Doc[])[1] = { ...((fits.group!.fields as Doc[])[1] as Doc), validation: { pattern: "^(t|p)" } };
    expect(manifestOf(fits).entitySubtypes?.length).toBe(2);
  });

  test("rights and validation may narrow, never widen", () => {
    refuse(variant((subtype) => { subtype.authorization = { roles: { read: ["Groups.Read", "Groups.Manage", "Everyone"] } }; }), "team", /widens authorization.roles.read/);
    refuse(variant((subtype) => { subtype.authorization = { roles: { read: ["Groups.Manage"], create: ["Groups.Read"] } }; }), "team", /widens authorization.roles.create/);
    refuse(variant((subtype) => { subtype.authorization = { roles: { read: ["Groups.Manage"] }, rowAccess: { enabled: false } }; }), "team", /rowAccess/);
    refuse(variant((subtype) => { (subtype.fields as Doc[]).push({ key: "status", permissions: { write: ["Groups.Manage", "Groups.Read"] } }); }), "team", /widens fields.status.permissions.write/);
    // Narrowing field rights is the point: a tighter write list compiles.
    const tighter = variant((subtype) => { (subtype.fields as Doc[]).push({ key: "status", permissions: { write: [] } }); });
    expect(compile(loadEntity(authoringDir(tighter), "team")).model.fields.find((field) => field.key === "status")?.permissions).toEqual({ write: [] });
    const widerName = variant((subtype) => { (subtype.fields as Doc[])[2] = { key: "name", validation: { maxLength: 200 } }; });
    refuse(widerName, "team", /fields.name.validation.maxLength widens/);
    refuse(variant((subtype) => { (subtype.fields as Doc[])[2] = { key: "name", validation: { minLength: 0 } }; }), "team", /fields.name.validation.minLength widens/);
    refuse(variant((subtype) => { (subtype.operations as Doc).update = { description: { en: "x" } }; ((subtype.interfaces as Doc).rest as Doc).operations = { delete: false }; subtype.authorization = { roles: { read: ["Groups.Manage"], delete: ["Groups.Manage", "Guests"] } }; }), "team", /widens authorization.roles.delete/);
  });

  test("duplicate identities across the manifest", () => {
    const sameRoute = corpus();
    (((sameRoute["project-group"]!.interfaces as Doc).web as Doc).views as Doc).collection = { route: { en: "/teams", nl: "/projectgroepen" } };
    expect(() => manifestOf(sameRoute)).toThrow(/web collection route "en \/teams" is produced by multiple candidates/);
    const mixedRoute = corpus();
    (((mixedRoute["project-group"]!.interfaces as Doc).web as Doc).views as Doc).collection = { route: "/teams" };
    expect(() => manifestOf(mixedRoute)).toThrow(/web collection route "en \/teams" is produced by multiple candidates/);
    const sameRest = corpus();
    ((sameRest["project-group"]!.interfaces as Doc).rest as Doc).basePath = "teams";
    expect(() => manifestOf(sameRest)).toThrow(/REST base path "teams"/);
    const sameResource = corpus();
    ((sameResource["project-group"]!.interfaces as Doc).mcp as Doc).resource = { uri: "app://teams", name: "x" };
    expect(() => manifestOf(sameResource)).toThrow(/MCP resource URI "app:\/\/teams"/);
    const sameName = corpus({ "team-copy": { ...team(), interfaces: { rest: { basePath: "team-copies" }, mcp: { resource: { uri: "app://team-copies", name: "x" } }, web: { views: { collection: { route: "/team-copies" }, record: { routes: { read: "/team-copies/:id", create: "/team-copies/new" } } } } } } });
    expect(() => manifestOf(sameName)).toThrow(/GraphQL type name "Team"/);
  });

  test("the subtype marker cannot be authored on a coreEntity", () => {
    const forged = corpus();
    forged.group!.subtype = { base: "Person", baseSlug: "person", scope: {}, hidden: [] };
    refuse(forged, "group", /cannot be authored on a coreEntity/);
  });
});

describe("the shipped Team subtype of RelationGroup", () => {
  const authoring = join(import.meta.dir, "../../config/authoring");
  let teamContract: ReturnType<typeof compile>;
  let groupContract: ReturnType<typeof compile>;
  beforeAll(() => {
    teamContract = compile(loadEntity(authoring, "team"));
    groupContract = compile(loadEntity(authoring, "relation-group"));
  });

  test("shares the relation group table under its own identity, routes and text", () => {
    expect(teamContract.storage.table).toBe("relation_groups");
    expect(teamContract.subtype).toMatchObject({
      base: { name: "RelationGroup", slug: "relation-group" },
      scope: [{ field: "groupType", column: "group_type", value: "team" }],
      hiddenFields: ["groupType"],
      hiddenColumns: [{ field: "groupType", column: "group_type" }],
    });
    expect(teamContract.model.fields.map((field) => field.key)).toEqual(
      groupContract.model.fields.map((field) => field.key).filter((key) => key !== "groupType"));
    expect(teamContract.storage.columns.map((column) => column.column)).toContain("external_code");
    expect(teamContract.model.relationships.map((relationship) => relationship.key)).toEqual(
      groupContract.model.relationships.map((relationship) => relationship.key));
    expect(teamContract.views.core?.routes.list).toEqual({ en: "/teams", nl: "/teams" });
    expect(teamContract.rest?.basePath).toBe("teams");
    expect(teamContract.mcp?.toolPrefix).toBe("team");
    expect(teamContract.mcp?.resource?.uri).toBe("app://teams");
    expect(teamContract.entityOperations.list?.description).not.toEqual(groupContract.entityOperations.list?.description);
    expect(teamContract.entityOperations.update?.concurrency).toEqual(groupContract.entityOperations.update?.concurrency);
    expect(teamContract.entityOperations.delete?.interaction.confirmation).toEqual(groupContract.entityOperations.delete?.interaction.confirmation);
    expect(teamContract.authorization.roles).toEqual(groupContract.authorization.roles);
    expect(teamContract.views.core?.list?.columns.map((column) => column.key)).toEqual(["name", "status"]);
  });
});
