// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompiledEntityInfo } from "../plugins.js";
import type { CompiledEntityContract, CompiledField, CompiledViewContext, OperationCatalogDefinition } from "./types.js";
import { collectAuthoredModulePluginOperations } from "../generate-operations.js";
import { buildWebManifest, renderWebManifest } from "./web-manifest.js";
import { buildEntityOperations } from "./compiler/entity-operations.js";

const text = (en: string, nl = en) => ({ en, nl });

function field(
  key: string,
  overrides: Partial<CompiledField> = {},
): CompiledField {
  return {
    key,
    baseType: "string",
    osfType: overrides.baseType ?? "string",
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
  test("preserves entityValue and allowed definitions on fields and collection relationships", () => {
    const definition = entity("Snippet", "snippet", [field("text")], coreView());
    definition.contract.entity.valueDefinition = true;
    definition.contract.entityOperations = {};
    const placement = entity("Placement", "placement", [field("values", {
      baseType: "object", osfType: "entityValue", entityValue: { definitionField: "definitionKey" },
    })], coreView());
    const page = entity("Page", "page", [field("placements", {
      osfType: "Placement", cardinality: "collection", allowedDefinitions: ["Snippet"],
    })], coreView(), [{ key: "placements", fieldKey: "placements", kind: "hasMany", target: "Placement", foreignKey: "page_id", ownership: "owned" }]);
    const output = JSON.parse(renderWebManifest(buildWebManifest([page, placement, definition])));
    expect(output.entities.Placement.fields.values.entityValue).toEqual({ definitionField: "definitionKey" });
    expect(output.entities.Page.fields.placements.allowedDefinitions).toEqual(["Snippet"]);
    expect(output.entities.Page.relationships.placements.allowedDefinitions).toEqual(["Snippet"]);
    expect(output.entities.Snippet).toBeUndefined();
    expect(output.entityValueDefinitions.Snippet).toMatchObject({ entityName: "Snippet", fields: [{ id: "Snippet.text", key: "text", supports: { read: true, create: true, update: true } }] });
    expect(renderWebManifest(buildWebManifest([page, placement, definition]))).toBe(renderWebManifest(buildWebManifest([definition, placement, page])));
  });

  test("schema-3 uses authored relation field keys and exposes via traversals read-only", () => {
    const view = coreView();
    view.form!.variants.create!.groups[0]!.fields = ["displayName", "owner", "related"];
    const definition = entity("Example", "example", [field("displayName"), field("owner"), field("related", { cardinality: "collection" })], view, [
      { key: "owner", fieldKey: "owner", kind: "belongsTo", target: "Target", foreignKey: "owner_id" },
      { key: "related", fieldKey: "related", kind: "hasMany", target: "Target", inverse: "example", via: "owner", through: { field: "owner", column: "owner_id", target: "Target" }, foreignKey: "example_id", ownership: "reference", cardinality: "collection" },
    ]);
    definition.contract.authoringVersion = 3;
    definition.contract.interfaces = { web: { operations: { list: true, get: true, create: true, update: true, delete: true } } };
    definition.contract.storage.columns.push({ field: "owner", column: "owner_id", type: "uuid", nullable: true, storageClass: "core" });
    const target = entity("Target", "target", [field("displayName")], coreView());
    const projected = buildWebManifest([definition, target]).entities.Example!;
    expect(projected.relationships.owner?.recordField).toBe("owner");
    expect(projected.relationships.related).toMatchObject({ fieldKey: "related", kind: "hasMany", via: "owner", through: { field: "owner", column: "owner_id", target: "Target" }, mutationSupport: "unsupported" });
    expect(projected.relationships.related?.operations.create).toBeUndefined();
    expect(projected.fields.related?.supports).toEqual({ read: true, create: false, update: false });
    target.contract.model.relationships.push({ key: "examples", fieldKey: "examples", kind: "hasMany", target: "Example", foreignKey: "owner_id", ownership: "owned" });
    definition.contract.storage.columns.find((column) => column.column === "owner_id")!.nullable = false;
    const blocked = buildWebManifest([definition, target]).entities.Example!;
    expect(blocked.unsupportedOperations?.create?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    expect(blocked.operations.create).toBeUndefined();
    expect(blocked.views.collection.operations.create).toBeUndefined();
    expect(blocked.views.record?.modes).not.toContain("create");
    expect(blocked.views.record?.routes.create).toBeUndefined();
    expect(blocked.fields.displayName?.supports.create).toBe(false);
  });
  test("a derived collection offers create when the child accepts the parent key on create", () => {
    // Child: a single reference to Parent that no create-form group lists,
    // the way a migrated relationships-block key or an unlisted reference is.
    const childOf = (overrides: Partial<CompiledField> = {}) => {
      const child = entity("Child", "child", [
        field("id", { required: true, readOnly: true, osfType: "childId" }),
        field("displayName"),
        field("parentId", { osfType: "Parent", relationship: { kind: "belongsTo", target: "Parent", fieldKey: "parentId", foreignKey: "parent_id" }, ...overrides }),
      ], coreView(), [{ key: "parentId", fieldKey: "parentId", kind: "belongsTo", target: "Parent", foreignKey: "parent_id", ownership: "reference" }]);
      child.contract.authoringVersion = 3;
      child.contract.interfaces = { web: { operations: { list: true, get: true, create: true, update: true, delete: true } } };
      child.contract.storage.columns.find((column) => column.field === "parentId")!.column = "parent_id";
      return child;
    };
    const parentOf = (ownership: "reference" | "owned") => {
      const parent = entity("Parent", "parent", [
        field("id", { required: true, readOnly: true, osfType: "parentId" }),
        field("displayName"),
        field("children", { osfType: "Child", cardinality: "collection" }),
      ], coreView(), [{ key: "children", fieldKey: "children", kind: "hasMany", target: "Child", foreignKey: "parent_id", inverse: "parentId", ownership, cardinality: "collection" }]);
      parent.contract.authoringVersion = 3;
      parent.contract.interfaces = { web: { operations: { list: true, get: true, create: true, update: true, delete: true } } };
      return parent;
    };

    // Writable key: the child form can be pre-filled with the parent, so the
    // collection creates a child from the parent record.
    const open = buildWebManifest([parentOf("reference"), childOf()]);
    expect(open.entities.Child!.fields.parentId?.supports).toEqual({ read: true, create: true, update: false });
    expect(open.entities.Parent!.relationships.children?.operations.create).toMatchObject({ id: "Child.create" });
    expect(open.entities.Parent!.relationships.children?.collection?.operations.create).toMatchObject({ id: "Child.create" });
    // A single reference never creates its target from the picker.
    expect(open.entities.Child!.relationships.parentId?.operations.create).toBeUndefined();

    // Read-only key: nothing can pre-fill it, so no create from the parent.
    const readOnly = buildWebManifest([parentOf("reference"), childOf({ readOnly: true })]);
    expect(readOnly.entities.Child!.fields.parentId?.supports.create).toBe(false);
    expect(readOnly.entities.Parent!.relationships.children?.operations.create).toBeUndefined();
    expect(readOnly.entities.Parent!.relationships.children?.collection?.operations.create).toBeUndefined();

    // Owned key: the owner's atomic insert writes it, so the key is
    // server-owned and the collection keeps no generic create.
    const owned = buildWebManifest([parentOf("owned"), childOf()]);
    expect(owned.entities.Child!.fields.parentId?.supports.create).toBe(false);
    expect(owned.entities.Parent!.relationships.children?.operations.create).toBeUndefined();
    expect(owned.entities.Parent!.relationships.children?.collection?.operations.create).toBeUndefined();
  });
  test("does not invent a context summary by copying the first detail group", () => {
    const example = entity("Example", "example", [field("displayName")], coreView());
    expect(buildWebManifest([example]).entities.Example!.views.record!.layout.context).toEqual({ groups: [], relationships: [] });
  });
  test("projects authored collection context only when its destination tab exists", () => {
    const target = entity("ContactDetail", "contact-detail", [field("displayName")], coreView());
    const example = entity("Example", "example", [field("displayName")], coreView(), [{
      key: "contactDetails", kind: "hasMany", target: "ContactDetail", foreignKey: "relation_id", label: text("Contacts"),
    }]);
    example.contract.interfaces = { web: { operations: { list: true, get: true }, recordContext: { fields: [], relationships: ["contactDetails"] } } };
    expect(buildWebManifest([example, target]).entities.Example!.views.record!.layout.context).toEqual({ groups: [], relationships: ["contactDetails"] });
    example.contract.views.core!.detail!.groups.items = example.contract.views.core!.detail!.groups.items.filter(tab => !tab.relationship);
    expect(() => buildWebManifest([example, target])).toThrow("requires a matching detail tab");
  });
  test("preserves nested canonical labels and option values for read presentation", () => {
    const definition = entity("Example", "example", [field("displayName"), field("settings", {
      baseType: "object", children: [field("state", { label: text("State", "Toestand"), options: { type: "static", items: [{ value: "ready", label: text("Ready", "Gereed") }] } })],
    }), field("entries", { baseType: "object", cardinality: "collection", item: field("item", { baseType: "object", children: [field("name", { label: text("Name", "Naam") })] }) })], coreView());
    const projected = buildWebManifest([definition]).entities.Example!.fields;
    expect(projected.settings!.children![0]!.label.nl).toBe("Toestand");
    expect(projected.settings!.children![0]!.options![0]!.label.nl).toBe("Gereed");
    expect(projected.entries!.item!.children![0]!.label.nl).toBe("Naam");
    expect(projected.entries!.item!.supports.update).toBe(false);
  });
  test("projects a deliberately authored summary independently of the first detail group", () => {
    const example = entity("Example", "example", [field("displayName"), field("status")], coreView());
    example.contract.interfaces = { web: { operations: { list: true, get: true }, recordContext: { fields: ["status"] } } };
    const context = buildWebManifest([example]).entities.Example!.views.record!.layout.context;
    expect(context.groups[0]!.fields).toEqual(["status"]);
    expect(context.relationships).toEqual([]);
    example.contract.interfaces.web!.recordContext!.fields = ["unknown"];
    expect(() => buildWebManifest([example])).toThrow("context field unknown is not readable");
  });

  test("projects authored text length and nested entity choices for editing", () => {
    const definition = entity("Example", "example", [field("displayName", { validation: { maxLength: 4000 } }),
      field("settings", { baseType: "object", children: [field("target", { options: { type: "entity", source: "Example", valueField: "id" }, validation: { maxLength: 200 } })] }),
    ], coreView());
    const projected = buildWebManifest([definition]).entities.Example!.fields;
    expect(projected.displayName!.maxLength).toBe(4000);
    expect(projected.settings!.children![0]!.maxLength).toBe(200);
    expect(projected.settings!.children![0]!.optionSource).toEqual({ type: "entity", source: "Example", valueField: "id" });
  });

  test("projects the numeric value of a localized text-length validation rule", () => {
    const definition = entity("Example", "example", [field("displayName", { validation: { maxLength: { value: 4000, message: text("Too long") } } })], coreView());
    expect(buildWebManifest([definition]).entities.Example!.fields.displayName!.maxLength).toBe(4000);
  });

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

  test("never invents a Web field for a belongsTo: the authored field is the input", () => {
    const group = entity("RelationGroup", "relation-group", [
      field("id", { required: true, readOnly: true, osfType: "relationGroupId" }),
      field("name"),
    ], coreView());
    const relation = entity("Relation", "relation", [
      field("id", { required: true, readOnly: true }),
      field("displayName"),
    ], coreView(), [{
      key: "relationGroup",
      fieldKey: "relationGroupId",
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
    expect(projected.fields.relationGroupId).toBeUndefined();
    expect(Object.keys(projected.fields)).toEqual(["id", "displayName"]);
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
      field("id", { required: true, readOnly: true, osfType: "relationGroupId" }),
      field("name"),
    ], coreView());
    const relation = entity("Relation", "relation", [
      field("displayName"),
      field("relationGroupId", {
        label: text("Protected owner"),
        osfType: "protectedRelationId",
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
      osfType: "protectedRelationId",
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
    expect(projected!.operations.list).toEqual({
      id: "Relation.list",
      intent: "list",
      input: {
        kind: "collection-query",
        filterFields: ["displayName"],
        sortFields: ["displayName"],
        pagination: { kind: "cursor", defaultLimit: 50, maxLimit: 200 },
      },
    });
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
      field("configurationValues", { baseType: "object" }),
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
      field("updatedAt", { baseType: "datetime", readOnly: true }),
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
      field("labels", { baseType: "object", osfType: "labelSet", readOnly: true }),
    ], coreView());

    expect(buildWebManifest([relation]).entities.Relation?.fields.labels).toMatchObject({
      baseType: "object",
      osfType: "labelSet",
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
        baseType: "object",
        osfType: "condition",
        variables: "template",
        suggestions: { sourceKey: "entityFields" },
      }),
      field("descriptionTemplate", {
        osfType: "variableTemplate",
        variables: "template",
        suggestions: { sourceKey: "entityFields" },
      }),
    ], view);

    const projected = buildWebManifest([labelRule]).entities.LabelRule!;
    expect(projected.fields.expression).toMatchObject({
      osfType: "condition",
      variables: "template",
      suggestions: { sourceKey: "entityFields" },
    });
    expect(projected.fields.descriptionTemplate).toMatchObject({
      osfType: "variableTemplate",
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

test("strict UI coverage rejects original field metadata before fallback duplicates it", () => {
  const source = entity("Relation", "relation", [field("displayName", { label: { nl: "Naam" } })], coreView());
  expect(() => buildWebManifest([source], { requireTranslations: true }))
    .toThrow("Relation.model.fields[0].label.en");
  source.contract.model.fields[0]!.label = { en: "Name", nl: "Naam" };
  expect(() => buildWebManifest([source], { requireTranslations: true })).not.toThrow();
});

test("blueprint operations satisfy a host that requires complete UI translations", () => {
  const definition = entity("Example", "example", [field("name")], coreView());
  definition.contract.blueprint = { fields: ["name"], labelField: "name", operations: {
    list: "osf-blueprints.Example.list", status: "osf-blueprints.Example.status", reset: "osf-blueprints.Example.reset", publish: "osf-blueprints.Example.publish",
  } };
  definition.contract.entityOperations.update = { ...definition.contract.entityOperations.update, concurrency: { editLease: true } } as never;
  expect(() => buildWebManifest([definition], { requireTranslations: true })).not.toThrow();
});

test("blueprint metadata resolves to canonical executable web operations", () => {
  const definition = entity("Example", "example", [field("name")], coreView());
  definition.contract.blueprint = { fields: ["name"], labelField: "name", operations: {
    list: "osf-blueprints.Example.list", status: "osf-blueprints.Example.status", reset: "osf-blueprints.Example.reset", publish: "osf-blueprints.Example.publish",
  } };
  const projected = buildWebManifest([definition]).entities.Example!;
  expect(projected.blueprint).toEqual(definition.contract.blueprint);
  expect(projected.operations[projected.blueprint!.operations.reset]).toMatchObject({
    id: "osf-blueprints.Example.reset", intent: "invoke", confirmation: { mode: "acknowledgement" },
    input: { kind: "json-schema", schema: { required: ["id", "expectedVersion", "blueprintVersion", "confirmed"] } },
    rest: { method: "POST", path: "/api/blueprints/example/reset" },
  });
});

const operationContext = { repoRoot: "/repo", authoringDir: "/repo/authoring", webPresent: true };

/** A slice of the platform's own administration catalog, as authored. */
const controlCatalog: OperationCatalogDefinition = {
  schemaVersion: 1,
  kind: "operationCatalog",
  plugin: "osf-control",
  operations: {
    listTenants: {
      id: "control.list-tenants",
      name: text("Tenants"),
      description: text("Every tenant of the deployment.", "Alle tenants van deze omgeving."),
      implementation: { type: "plugin", plugin: "osf-control", handler: "listTenants" },
      input: { schema: { type: "object", additionalProperties: false } },
      output: { schema: { type: "object", additionalProperties: true } },
      errors: [],
      auth: { mode: "control", roles: ["platform_admin", "platform-operator"] },
      tenancy: { mode: "none" },
      effects: { data: "read", external: "none" },
      reliability: { idempotency: { mode: "natural" } },
      confirmation: { mode: "none" },
    },
    getTenant: {
      id: "control.get-tenant",
      name: text("Get tenant", "Tenant opvragen"),
      description: text("One tenant by slug.", "Eén tenant op slug."),
      implementation: { type: "plugin", plugin: "osf-control", handler: "getTenant" },
      input: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["slug"],
          properties: { slug: { type: "string", "x-osf-i18n": { title: text("Slug") } } },
        },
      },
      output: { schema: { type: "object", additionalProperties: true } },
      errors: [],
      auth: { mode: "control", roles: ["platform_admin", "platform-operator"] },
      tenancy: { mode: "none" },
      effects: { data: "read", external: "none" },
      reliability: { idempotency: { mode: "natural" } },
      confirmation: { mode: "none" },
    },
    updateTenant: {
      id: "control.update-tenant",
      name: text("Update tenant", "Tenant wijzigen"),
      description: text("Renames one tenant.", "Hernoemt één tenant."),
      implementation: { type: "plugin", plugin: "osf-control", handler: "updateTenant" },
      input: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["slug"],
          properties: {
            slug: { type: "string", "x-osf-i18n": { title: text("Slug") } },
            name: { type: "string", "x-osf-i18n": { title: text("Name", "Naam") } },
          },
        },
      },
      output: { schema: { type: "object", additionalProperties: true } },
      errors: [],
      auth: { mode: "control", roles: ["platform-operator"] },
      tenancy: { mode: "none" },
      effects: { data: "write", external: "write" },
      reliability: { idempotency: { mode: "natural" } },
      confirmation: { mode: "acknowledgement" },
    },
  },
  interfaces: {
    rest: {
      operations: {
        listTenants: { method: "GET", path: "/api/control/v1/tenants", response: { status: 200, kind: "json" } },
        getTenant: { method: "GET", path: "/api/control/v1/tenants/:slug", response: { status: 200, kind: "json" } },
        updateTenant: { method: "PATCH", path: "/api/control/v1/tenants/:slug", response: { status: 200, kind: "json" } },
      },
    },
    mcp: { operations: { listTenants: { name: "list_tenants" } } },
    web: {
      pages: {
        tenants: {
          title: text("Tenants"),
          description: text("Tenants of this deployment.", "Tenants van deze omgeving."),
          icon: "buildings",
          order: 1,
        },
      },
      operations: {
        listTenants: { page: "tenants", order: 0, landing: true },
        getTenant: { page: "tenants", order: 1 },
        updateTenant: { page: "tenants", order: 2 },
      },
    },
  },
};

const standalone = (catalog: OperationCatalogDefinition) => ({
  catalogs: [catalog],
  operations: collectAuthoredModulePluginOperations([catalog], operationContext),
});

describe("standalone Operation pages", () => {
  test("projects provider-backed administration as normal list and detail entities", () => {
    const operationEntities: OperationCatalogDefinition = {
      ...controlCatalog,
      operations: {
        ...controlCatalog.operations,
        listTenants: {
          ...controlCatalog.operations.listTenants!,
          input: { schema: { type: "object", additionalProperties: false, properties: {
            name: { type: "string" }, slug: { type: "string" }, status: { type: "string" },
            sortField: { type: "string", enum: ["name", "slug", "status"], default: "slug" },
            sortDirection: { type: "string", enum: ["asc", "desc"], default: "asc" },
            first: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            after: { type: "string" },
          } } },
          output: { schema: { type: "object", additionalProperties: false, properties: {
            tenants: { type: "array", items: { type: "object", additionalProperties: false, properties: {
              slug: { type: "string", "x-osf-i18n": { title: text("Slug") } },
              name: { type: "string", "x-osf-i18n": { title: text("Name", "Naam") } },
              status: {
                type: "string",
                "x-osf-i18n": {
                  title: text("Status"),
                  enum: { PENDING: text("Pending", "In afwachting"), EXPIRED: text("Expired", "Verlopen") },
                },
              },
              sentAt: { type: "string", format: "date-time", "x-osf-i18n": { title: text("Sent at", "Verzonden op") } },
              canUpdate: { type: "boolean", "x-osf-i18n": { title: text("Can update") } },
            }, required: ["slug", "name", "status", "sentAt", "canUpdate"] }, "x-osf-i18n": { title: text("Tenants") } },
            totalCount: { type: "integer" },
            nextCursor: { type: ["string", "null"] },
          }, required: ["tenants", "totalCount", "nextCursor"] } },
        },
      },
      interfaces: { ...controlCatalog.interfaces, web: {
        pages: {}, operations: {}, entities: {
          Tenant: {
            title: text("Tenants"), route: "/tenants", recordRoute: "/tenants/:slug",
            idField: "slug", displayField: "name", fields: ["slug", "name", "status", "sentAt"], columns: ["name", "slug", "status", "sentAt"],
            operations: {
              list: { operation: "listTenants", resultField: "tenants" },
              get: { operation: "getTenant" },
              // Projection only: the same Operation placed on both views proves
              // each placement gets its own target, like a plugin action would.
              collectionActions: ["updateTenant"],
              recordActions: [{
                operation: "updateTenant",
                visibleWhen: { conditions: [{ field: "canUpdate", operator: "eq", value: true }] },
              }],
            },
          },
        },
      } },
    };
    const manifest = buildWebManifest([], {}, standalone(operationEntities));
    expect(manifest.entities.Tenant).toMatchObject({
      entityId: "Tenant",
      operationSource: { idField: "slug", collection: { resultField: "tenants", query: {
        input: { kind: "collection-query", filterFields: ["slug", "name", "status"], sortFields: ["name", "slug", "status"],
          pagination: { kind: "cursor", defaultLimit: 50, maxLimit: 100 } },
        nextCursorField: "nextCursor", totalCountField: "totalCount",
      } }, record: {} },
      views: {
        collection: { renderer: "operation.entity.collection", route: "/tenants", defaultSort: { key: "slug", direction: "asc" },
          operations: { read: { id: "control.list-tenants" }, actions: [{
            id: "control.update-tenant",
            target: { entityId: "Tenant", entityName: "Tenant", scope: "collection" },
          }] } },
        record: { renderer: "operation.entity.record", routes: { read: "/tenants/:slug" }, operations: {
          read: { id: "control.get-tenant" }, actions: [{
            id: "control.update-tenant",
            target: { entityId: "Tenant", entityName: "Tenant", scope: "record", inputField: "slug" },
            visibleWhen: { conditions: [{ field: "canUpdate", operator: "eq", value: true }] },
          }],
        } },
      },
    });
    expect(manifest.entities.Tenant?.fields.name?.label).toEqual(text("Name", "Naam"));
    expect(manifest.entities.Tenant?.fields.status?.options).toEqual([
      { value: "PENDING", label: text("Pending", "In afwachting") },
      { value: "EXPIRED", label: text("Expired", "Verlopen") },
    ]);
    expect(manifest.entities.Tenant?.fields.sentAt?.baseType).toBe("datetime");

    const canonicalTenant = entity("Tenant", "tenant", [field("name")], coreView());
    const composed = buildWebManifest([canonicalTenant], {}, standalone(operationEntities));
    expect(composed.entities.Tenant?.operationSource).toBeUndefined();
    expect(composed.entities.Tenant?.entityId).toBe("Tenant");
  });

  test("projects catalog pages and their Operations next to the entities", () => {
    const manifest = buildWebManifest([], {}, standalone(controlCatalog));
    expect(Object.keys(manifest.operations!)).toEqual([
      "control.get-tenant",
      "control.list-tenants",
      "control.update-tenant",
    ]);
    expect(manifest.operations!["control.get-tenant"]).toEqual({
      id: "control.get-tenant",
      intent: "invoke",
      key: "getTenant",
      name: text("Get tenant", "Tenant opvragen"),
      description: text("One tenant by slug.", "Eén tenant op slug."),
      input: { kind: "json-schema", schema: controlCatalog.operations.getTenant!.input!.schema },
      output: { kind: "json-schema", schema: { type: "object", additionalProperties: true } },
      effects: { data: "read", external: "none" },
      reliability: { idempotency: { mode: "natural" } },
      confirmation: { mode: "none" },
      rest: { method: "GET", path: "/api/control/v1/tenants/:slug", response: { status: 200, kind: "json" } },
      auth: { mode: "control", roles: ["platform_admin", "platform-operator"] },
      page: "tenants",
      order: 1,
    });
    expect(manifest.operations!["control.list-tenants"]).toMatchObject({ landing: true, order: 0 });
    expect(manifest.pages).toEqual({
      tenants: {
        id: "tenants",
        title: text("Tenants"),
        description: text("Tenants of this deployment.", "Tenants van deze omgeving."),
        icon: "buildings",
        order: 1,
        route: "/tenants",
        operations: ["control.list-tenants", "control.get-tenant", "control.update-tenant"],
      },
    });
    // The rendering is byte-stable across builds, as check:generated requires.
    expect(renderWebManifest(manifest)).toBe(renderWebManifest(buildWebManifest([], {}, standalone(controlCatalog))));
  });

  test("puts the landing Operation first whatever its authored order", () => {
    const reordered: OperationCatalogDefinition = {
      ...controlCatalog,
      interfaces: {
        ...controlCatalog.interfaces,
        web: {
          pages: controlCatalog.interfaces.web!.pages,
          operations: {
            listTenants: { page: "tenants", order: 9, landing: true },
            getTenant: { page: "tenants" },
            updateTenant: { page: "tenants", order: 0 },
          },
        },
      },
    };
    expect(buildWebManifest([], {}, standalone(reordered)).pages!.tenants!.operations)
      .toEqual(["control.list-tenants", "control.update-tenant", "control.get-tenant"]);
  });

  test("omits the sections when no catalog projects to the web", () => {
    expect(buildWebManifest([])).not.toHaveProperty("operations");
    expect(buildWebManifest([])).not.toHaveProperty("pages");
    const headless: OperationCatalogDefinition = {
      ...controlCatalog,
      interfaces: { rest: controlCatalog.interfaces.rest!, mcp: controlCatalog.interfaces.mcp! },
    };
    expect(buildWebManifest([], {}, standalone(headless))).not.toHaveProperty("pages");
  });

  test("refuses a placement whose contract was not compiled", () => {
    expect(() => buildWebManifest([], {}, { catalogs: [controlCatalog], operations: [] }))
      .toThrow(/"control.get-tenant" has a web placement but no compiled contract/);
  });

  test("requires both languages for page copy and Operation names under strict translations", () => {
    expect(() => buildWebManifest([], { requireTranslations: true }, standalone(controlCatalog))).not.toThrow();
    const untitled: OperationCatalogDefinition = {
      ...controlCatalog,
      interfaces: {
        ...controlCatalog.interfaces,
        web: { ...controlCatalog.interfaces.web!, pages: { tenants: { title: { en: "Tenants" } } } },
      },
    };
    expect(() => buildWebManifest([], { requireTranslations: true }, standalone(untitled)))
      .toThrow(/osf-control\.pages\.tenants\.title\.nl/);
    const unnamed: OperationCatalogDefinition = {
      ...controlCatalog,
      operations: {
        ...controlCatalog.operations,
        listTenants: { ...controlCatalog.operations.listTenants!, name: { en: "Tenants" } },
      },
    };
    expect(() => buildWebManifest([], { requireTranslations: true }, standalone(unnamed)))
      .toThrow(/control\.list-tenants\.name\.nl/);
    // Strict hosts label every visible input, standalone forms included.
    const unlabeled: OperationCatalogDefinition = {
      ...controlCatalog,
      operations: {
        ...controlCatalog.operations,
        getTenant: {
          ...controlCatalog.operations.getTenant!,
          input: { schema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } } },
        },
      },
    };
    expect(() => buildWebManifest([], { requireTranslations: true }, standalone(unlabeled)))
      .toThrow(/control\.get-tenant\.input\.properties\.slug\.x-osf-i18n\.title/);
  });
});
