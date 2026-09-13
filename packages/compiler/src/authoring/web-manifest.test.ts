// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompiledEntityInfo } from "../plugins.js";
import type { CompiledEntityContract, CompiledField, CompiledViewContext } from "./types.js";
import { buildWebManifest, renderWebManifest } from "./web-manifest.js";
import { buildEntityOperations } from "./compiler/entity-operations.js";

const text = (en: string, nl = en) => ({ en, nl });

function field(
  key: string,
  overrides: Partial<CompiledField> = {},
): CompiledField {
  return {
    key,
    valueType: "string",
    cardinality: "single",
    required: false,
    label: text(key),
    render: { component: "Input" },
    ...overrides,
  };
}

function coreView(): CompiledViewContext {
  const list = {
    name: "list",
    kind: "page" as const,
    type: "list" as const,
    render: { component: "DataTable" },
    search: { render: { component: "SearchInput" }, placeholder: text("Search...", "Zoeken...") },
    title: text("Relations", "Relaties"),
    columns: [{ key: "displayName", sortable: true }],
  };
  const detail = {
    name: "detail",
    kind: "page" as const,
    type: "detail" as const,
    header: { render: { component: "PageHeader" }, title: "{{displayName}}" },
    actions: [
      { key: "edit", route: "edit" },
      { key: "delete", mutation: "delete" },
    ],
    groups: {
      render: { component: "TabBar" },
      items: [{
        id: "overview",
        label: text("Overview", "Overzicht"),
        fields: ["displayName"],
        groups: [{ id: "basics", title: text("Basics", "Basis"), fields: ["displayName", "id"] }],
      }, {
        id: "contacts",
        label: text("Contact details", "Contactgegevens"),
        relationship: { render: { component: "RelationshipPanel" }, name: "contactDetails" },
      }],
    },
  };
  const form = {
    name: "form",
    kind: "page" as const,
    type: "form" as const,
    variants: {
      create: {
        title: text("Create relation", "Relatie aanmaken"),
        groups: [{ id: "basics", title: text("Basics", "Basis"), fields: ["displayName"] }],
        submit: { render: { component: "SubmitButton" }, label: text("Create", "Aanmaken") },
      },
      edit: {
        title: text("Edit relation", "Relatie bewerken"),
        extends: "create",
        groups: [],
        submit: { render: { component: "SubmitButton" }, label: text("Save", "Opslaan") },
      },
    },
  };
  return {
    page: { component: "PageShell" },
    routes: { list: { en: "/relations", nl: "/relaties" } },
    presentations: { list, detail, form },
    list,
    detail,
    form,
  };
}

function entity(
  name: string,
  slug: string,
  fields: CompiledField[],
  view: CompiledViewContext,
  relationships: CompiledEntityContract["model"]["relationships"] = [],
): CompiledEntityInfo {
  const storage = { table: slug, columns: fields.map((entry) => ({
    field: entry.key,
    column: entry.key,
    type: "text",
    nullable: !entry.required,
    storageClass: "core" as const,
  })) };
  const authorization = {
    entitySlug: slug,
    roles: {
      read: ["entity:read"],
      create: ["entity:write"],
      update: ["entity:write"],
      delete: ["entity:write"],
    },
    compositeRoles: [],
    fieldAuthorizations: [],
    profileAuthorizations: {},
  };
  const crud = {
    operations: { list: true, get: true, create: true, update: true, delete: true },
  };
  const identity = { id: `core.${name}`, name };
  return {
    slug,
    path: `authoring/entities/${slug}.yaml`,
    origin: "core",
    contract: {
      authoringVersion: 1,
      contractVersion: 2,
      kind: "compiledEntityContract",
      entity: {
        ...identity,
        module: "core",
        title: name,
        labels: text(`${name}s`, `${name}s`),
        domains: [],
        ...(fields.find(({ key }) => key !== "id")?.key
          ? { filterField: fields.find(({ key }) => key !== "id")!.key }
          : {}),
      },
      storage,
      model: { fields, relationships },
      crud,
      entityOperations: buildEntityOperations({
        entity: identity,
        crud,
        authorization,
      }),
      rest: { basePath: `${slug}s`, operations: { list: true, get: true, create: true, update: true, delete: true } },
      graphql: {} as CompiledEntityContract["graphql"],
      authorization,
      views: { core: view },
      canonical: { contexts: {} },
      profiles: {},
    },
  };
}

describe("web manifest projection", () => {
  test("preserves authored defaults including false, zero, null and structured values", () => {
    const defaults = [true, false, 0, "active", null, { mode: "manual" }, []];
    const definition = entity("Sample", "sample", [field("unset"),
      ...defaults.map((value, index) => field(`field${index}`, { defaultValue: value })),
    ], coreView());
    const projected = buildWebManifest([definition]).entities.Sample!.fields;
    expect(projected.unset).not.toHaveProperty("defaultValue");
    for (const [index, value] of defaults.entries()) expect(projected[`field${index}`]!.defaultValue).toEqual(value);
  });
  test("projects views, supported modes and direct relationships without REST paths", () => {
    const contactView = coreView();
    contactView.list = { ...contactView.list!, title: text("Contact details", "Contactgegevens") };
    contactView.presentations.list = contactView.list;
    const contact = entity("ContactDetail", "contact-detail", [
      field("id", { required: true, readOnly: true }),
      field("value"),
    ], contactView);
    const relation = entity("Relation", "relation", [
      field("id", { required: true, readOnly: true }),
      field("displayName"),
    ], coreView(), [{
      key: "contactDetails",
      kind: "hasMany",
      target: "ContactDetail",
      foreignKey: "relation_id",
      label: text("Contact details", "Contactgegevens"),
    }]);

    const manifest = buildWebManifest([contact, relation], { locale: "nl", routeLocale: "en" });
    expect(manifest).toMatchObject({ contract: "openshapeforge.web-manifest", version: 1, locale: "nl" });
    expect(Object.keys(manifest.entities)).toEqual(["ContactDetail", "Relation"]);
    expect(manifest.entities.Relation).toMatchObject({
      operations: { update: { id: "Relation.update", intent: "update" } },
      fields: {
        id: { supports: { read: true, create: false, update: false } },
        displayName: { supports: { read: true, create: true, update: true } },
      },
      views: {
        collection: {
          renderer: "entity.collection",
          modes: ["read"],
          route: "/relations",
          operations: {
            read: { id: "Relation.list" },
            create: { id: "Relation.create" },
          },
        },
        record: {
          renderer: "entity.record",
          modes: ["read", "create", "update"],
          routes: { read: "/relations/:id", create: "/relations/new" },
          operations: {
            read: { id: "Relation.get" },
            create: { id: "Relation.create" },
            update: { id: "Relation.update" },
            delete: { id: "Relation.delete" },
          },
          titleTemplate: "{{displayName}}",
        },
      },
      relationships: {
        contactDetails: {
          targetEntityId: "ContactDetail",
          recordField: "relationId",
          collection: { operations: { read: { id: "ContactDetail.list" } } },
        },
      },
    });
    expect(manifest.entities.Relation?.views.record?.layout.tabs[0]).toMatchObject({
      id: "overview",
      groups: [
        { id: "overview", fields: ["displayName"] },
        { id: "basics", fields: ["displayName", "id"] },
      ],
    });
    expect(JSON.stringify(manifest)).not.toContain("api/rest");
  });

  test("renders stable JSON independent of input order", () => {
    const view = coreView();
    const alpha = entity("Alpha", "alpha", [field("name")], view);
    const beta = entity("Beta", "beta", [field("name")], view);
    expect(renderWebManifest(buildWebManifest([beta, alpha])))
      .toBe(renderWebManifest(buildWebManifest([alpha, beta])));
  });

  test("projects implicit belongsTo inputs as writable Web fields", () => {
    const group = entity("RelationGroup", "relation-group", [
      field("id", { required: true, readOnly: true, semanticType: "relationGroupId" }),
      field("name"),
    ], coreView());
    const relation = entity("Relation", "relation", [
      field("id", { required: true, readOnly: true }),
      field("displayName"),
    ], coreView(), [{
      key: "relationGroup",
      kind: "belongsTo",
      target: "RelationGroup",
      foreignKey: "relation_group_id",
      label: text("Relation group", "Relatiegroep"),
    }]);
    relation.contract.storage.columns.push({
      field: "relationGroupId",
      column: "relation_group_id",
      type: "uuid",
      nullable: true,
      storageClass: "core",
    });

    const projected = buildWebManifest([relation, group]).entities.Relation!;
    expect(projected.fields.relationGroupId).toEqual({
      id: "Relation.relationGroupId",
      key: "relationGroupId",
      label: text("Relation group", "Relatiegroep"),
      description: text("Relation group", "Relatiegroep"),
      valueType: "string",
      semanticType: "relationGroupId",
      cardinality: "one",
      required: false,
      supports: { read: true, create: true, update: true },
    });
    expect(projected.relationships.relationGroup).toMatchObject({
      targetEntityId: "RelationGroup",
      foreignKey: "relation_group_id",
      recordField: "relationGroupId",
    });
  });

  test("never widens an explicit protected field that owns a belongsTo key", () => {
    const view = coreView();
    view.form!.variants.create!.groups[0]!.fields!.push("relationGroupId");
    const group = entity("RelationGroup", "relation-group", [
      field("id", { required: true, readOnly: true, semanticType: "relationGroupId" }),
      field("name"),
    ], coreView());
    const relation = entity("Relation", "relation", [
      field("displayName"),
      field("relationGroupId", {
        label: text("Protected owner"),
        semanticType: "protectedRelationId",
        readOnly: true,
        immutable: true,
      }),
    ], view, [{
      key: "relationGroup",
      kind: "belongsTo",
      target: "RelationGroup",
      foreignKey: "relation_group_id",
      label: text("Relation group", "Relatiegroep"),
    }]);
    relation.contract.storage.columns.find(({ field }) => field === "relationGroupId")!.column =
      "relation_group_id";

    const projected = buildWebManifest([relation, group]).entities.Relation!;
    expect(projected.fields.relationGroupId).toMatchObject({
      label: text("Protected owner"),
      semanticType: "protectedRelationId",
      supports: { read: true, create: false, update: false },
    });
    expect(Object.keys(projected.fields).filter((key) => key === "relationGroupId"))
      .toHaveLength(1);
  });

  test("projects the web interface independently of REST exposure", () => {
    const relation = entity("Relation", "relation", [field("displayName")], coreView());
    relation.contract.authoringVersion = 2;
    relation.contract.interfaces = {
      web: { operations: { list: true, get: true, create: true, update: true, delete: true } },
    };
    delete relation.contract.rest;

    const projected = buildWebManifest([relation]).entities.Relation;
    expect(projected).toBeDefined();
    expect(projected!.operations.list).toEqual({ id: "Relation.list", intent: "list" });
    expect(projected!.views.collection.route).toBe("/relations");
  });

  test("projects a canonical create prerequisite without Web-owned policy", () => {
    const adapter = entity("Adapter", "adapter", [field("name")], coreView());
    adapter.contract.authoringVersion = 2;
    adapter.contract.interfaces = {
      web: { operations: { list: true, get: true, create: true, update: true, delete: true } },
    };
    adapter.contract.entityOperations.create!.prerequisites = [{
      operation: "osf-integration.provider.setup-guide",
      receipt: { binding: "loginSession" },
    }];

    const projected = buildWebManifest([adapter]).entities.Adapter!;
    const create = projected.operations.create;
    if (!create || create.intent !== "create") throw new Error("Expected entity create Operation");
    expect(create.prerequisites).toEqual([{
      operation: "osf-integration.provider.setup-guide",
      receipt: { binding: "loginSession" },
    }]);
    expect(projected.views.collection.operations.create?.prerequisites).toEqual(
      create.prerequisites,
    );
  });

  test("projects a plugin-backed entity delete without turning it into an invoke action", () => {
    const relation = entity("Relation", "relation", [
      field("id", { required: true, readOnly: true }),
      field("displayName"),
    ], coreView());
    relation.contract.authoringVersion = 2;
    relation.contract.interfaces = {
      web: { operations: { list: true, get: true, delete: true } },
    };
    relation.contract.entityOperations.delete = {
      key: "remove",
      id: "Relation.remove",
      entityId: "core.Relation",
      entityName: "Relation",
      name: text("Delete relation", "Relatie verwijderen"),
      description: text("Delete this relation", "Verwijder deze relatie"),
      intent: "delete",
      implementation: { type: "plugin", plugin: "example", handler: "deleteRelation" },
      target: {
        entityId: "core.Relation",
        entityName: "Relation",
        scope: "record",
        inputField: "relationId",
      },
      input: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: { relationId: { type: "string", format: "uuid" } },
          required: ["relationId"],
          additionalProperties: false,
        },
      },
      output: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: { deleted: { type: "boolean" } },
          required: ["deleted"],
          additionalProperties: false,
        },
      },
      authorization: { action: "delete", roles: ["entity:write"] },
      effects: { data: "delete", external: "none" },
      reliability: { idempotency: { mode: "natural" } },
      interaction: { confirmation: { mode: "acknowledgement" } },
      interfaces: {
        rest: {
          method: "DELETE",
          path: "/api/example/relations/:relationId",
          response: { kind: "json" },
        },
        web: {},
      },
    };

    const projected = buildWebManifest([relation]).entities.Relation!;
    expect(projected.operations.delete).toMatchObject({
      id: "Relation.remove",
      key: "remove",
      intent: "delete",
      implementation: { type: "plugin", plugin: "example", handler: "deleteRelation" },
      target: { scope: "record", inputField: "relationId" },
      output: { kind: "json-schema", schema: { required: ["deleted"] } },
      effects: { data: "delete", external: "none" },
      confirmation: { mode: "acknowledgement" },
      rest: { method: "DELETE", path: "/api/example/relations/:relationId" },
    });
    expect(projected.views.record?.operations.delete?.intent).toBe("delete");
  });

  test("keeps canonical secure-input targets server-owned in Web forms", () => {
    const view = coreView();
    const createGroup = view.form!.variants.create!.groups[0]!;
    createGroup.fields!.push("configurationValues");
    const connection = entity("Connection", "connection", [
      field("adapterId"),
      field("configurationValues", { valueType: "object" }),
    ], view);
    connection.contract.authoringVersion = 2;
    connection.contract.interfaces = {
      web: {
        operations: {
          list: true,
          get: true,
          create: true,
          update: true,
          delete: true,
        },
      },
    };
    connection.contract.entityOperations.create!.interaction.secureInput = {
      type: "secureInput",
      sourceField: "adapterId",
      sourceEntity: "Adapter",
      definitionsField: "configurationFields",
      into: "configurationValues",
    };

    const projected = buildWebManifest([connection]).entities.Connection!;
    expect(projected.fields.configurationValues?.supports).toEqual({
      read: true,
      create: false,
      update: false,
    });
    expect(JSON.stringify(projected.views.record?.layout)).not.toContain(
      "configurationValues",
    );
  });

  test("projects YAML-owned record and collection Operations as localized Web actions", () => {
    const view = coreView();
    view.detail!.actions = [{ key: "recalculate", route: "recalculate" }];
    const deal = entity("Deal", "deal", [
      field("id", { required: true, readOnly: true }),
      field("updatedAt", { valueType: "datetime", readOnly: true }),
    ], view);
    deal.contract.authoringVersion = 2;
    deal.contract.interfaces = {
      web: {
        operations: { list: true, get: true },
        collectionActions: ["compose"],
      },
    };
    deal.contract.pluginOperations = [{
      key: "recalculate",
      id: "example.deal.recalculate",
      entityId: "example.Deal",
      entityName: "Deal",
      definition: {
        id: "example.deal.recalculate",
        name: text("Recalculate", "Herberekenen"),
        description: text("Recalculate this deal", "Bereken deze deal opnieuw"),
        implementation: { type: "plugin", plugin: "example", handler: "recalculateDeal" },
        target: { scope: "record", inputField: "dealId" },
        input: {
          schema: {
            type: "object",
            required: ["dealId"],
            properties: { dealId: { type: "string" } },
            additionalProperties: false,
          },
        },
        output: { schema: { type: "object" } },
        errors: [{ status: 409, code: "CONFLICT", description: "The deal changed." }],
        auth: { mode: "session", roles: ["Deals.Calculate"] },
        tenancy: { mode: "required" },
        effects: { data: "write", external: "none" },
        reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
        concurrency: {
          version: { mode: "required", field: "updatedAt" },
          editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
        },
        confirmation: { mode: "acknowledgement" },
      },
      interfaces: {
        rest: {
          method: "POST",
          path: "/api/example/deals/:dealId/recalculate",
          response: { kind: "json" },
        },
        graphql: { kind: "mutation", field: "recalculateDeal" },
        mcp: { name: "recalculate_deal" },
        web: {},
      },
    }, {
      key: "compose",
      id: "example.deal.compose",
      entityId: "example.Deal",
      entityName: "Deal",
      definition: {
        name: text("Compose deal", "Deal samenstellen"),
        description: text("Compose a new deal", "Stel een nieuwe deal samen"),
        implementation: { type: "plugin", plugin: "example", handler: "composeDeal" },
        target: { scope: "collection" },
        input: { schema: { type: "object", additionalProperties: false } },
        output: { schema: { type: "object" } },
        auth: { mode: "session", roles: ["Deals.Compose"] },
        tenancy: { mode: "required" },
        effects: { data: "write", external: "none" },
        reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
        confirmation: { mode: "none" },
      },
      interfaces: { web: {} },
    }];

    const projected = buildWebManifest([deal]).entities.Deal!;
    expect(projected.operations.recalculate).toMatchObject({
      id: "example.deal.recalculate",
      intent: "invoke",
      name: text("Recalculate", "Herberekenen"),
      description: text("Recalculate this deal", "Bereken deze deal opnieuw"),
      target: { entityId: "example.Deal", scope: "record", inputField: "dealId" },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      confirmation: { mode: "acknowledgement" },
      rest: {
        path: "/api/example/deals/:dealId/recalculate",
        response: { kind: "json" },
      },
    });
    expect(projected.views.record?.operations.actions).toEqual([
      expect.objectContaining({ id: "example.deal.recalculate", intent: "invoke" }),
    ]);
    expect(projected.views.collection.operations.actions).toEqual([
      expect.objectContaining({ id: "example.deal.compose", intent: "invoke" }),
    ]);
  });

  test("does not widen the legacy v1 WebManifest beyond REST exposure", () => {
    const relation = entity("Relation", "relation", [field("displayName")], coreView());
    delete relation.contract.rest;

    expect(buildWebManifest([relation]).entities.Relation).toBeUndefined();
  });

  test("preserves authored record routes instead of reconstructing them", () => {
    const view = coreView();
    view.routes.detail = { en: "/people/:id", nl: "/personen/:id" };
    view.routes.create = { en: "/people/new-person", nl: "/personen/nieuw" };
    const relation = entity("Relation", "relation", [field("displayName")], view);

    expect(buildWebManifest([relation]).entities.Relation?.views.record?.routes).toEqual({
      read: "/people/:id",
      create: "/people/new-person",
    });
  });

  test("uses the exposed REST collection path when no authored route exists", () => {
    const view = coreView();
    view.routes = {} as CompiledViewContext["routes"];
    const service = entity("Service", "service", [field("name")], view);
    service.contract.rest!.basePath = "services";
    expect(buildWebManifest([service]).entities.Service?.views.collection.route).toBe("/services");
  });

  test("projects semantic label sets without choosing a field renderer", () => {
    const relation = entity("Relation", "relation", [
      field("displayName"),
      field("labels", { valueType: "object", semanticType: "labelSet", readOnly: true }),
    ], coreView());

    expect(buildWebManifest([relation]).entities.Relation?.fields.labels).toMatchObject({
      valueType: "object",
      semanticType: "labelSet",
      cardinality: "one",
    });
    const serialized = JSON.stringify(buildWebManifest([relation]));
    expect(serialized).not.toContain("\"renderers\"");
    expect(serialized).not.toContain("\"rendererProps\"");
  });

  test("preserves an interface-neutral reference-data option source", () => {
    const relation = entity("Relation", "relation", [
      field("relationType", {
        options: { type: "referentiedata", referentieGroep: "RELATIONTYPE" },
      }),
    ], coreView());
    expect(buildWebManifest([relation]).entities.Relation?.fields.relationType)
      .toMatchObject({
        optionSource: { type: "referentiedata", group: "RELATIONTYPE" },
      });
  });

  test("preserves condition semantics and declarative variable sources", () => {
    const view = coreView();
    view.detail!.groups.items[0]!.fields = [
      "entityType",
      "status",
      "expression",
      "descriptionTemplate",
    ];
    view.form!.variants.create!.groups = [{
      id: "rule",
      title: text("Rule"),
      fields: ["entityType", "status", "expression", "descriptionTemplate"],
    }];
    view.form!.variableSources = [
      { key: "entityFields", resolver: "entityFields", params: { sourceField: "entityType" } },
      { key: "chips", resolver: "chips" },
    ];
    const labelRule = entity("LabelRule", "label-rule", [
      field("entityType"),
      field("status", {
        options: { type: "static", items: [{ value: "active", label: text("Active", "Actief") }] },
      }),
      field("expression", {
        valueType: "object",
        semanticType: "condition",
        variables: "template",
        suggestions: { sourceKey: "entityFields" },
      }),
      field("descriptionTemplate", {
        semanticType: "variableTemplate",
        variables: "template",
        suggestions: { sourceKey: "entityFields" },
      }),
    ], view);

    const projected = buildWebManifest([labelRule]).entities.LabelRule!;
    expect(projected.fields.expression).toMatchObject({
      semanticType: "condition",
      variables: "template",
      suggestions: { sourceKey: "entityFields" },
    });
    expect(projected.fields.descriptionTemplate).toMatchObject({
      semanticType: "variableTemplate",
      variables: "template",
    });
    expect(projected.fields.status?.options).toEqual([
      { value: "active", label: text("Active", "Actief") },
    ]);
    expect(projected.views.record?.variableSources).toEqual(view.form!.variableSources);
    expect(projected.views.record?.modes).toEqual(["read", "create", "update"]);
    expect(projected.views.record?.layout.tabs[0]?.groups.flatMap(({ fields }) => fields))
      .toContain("expression");
    expect(JSON.stringify(projected.fields)).not.toContain("\"renderers\"");
  });
});
