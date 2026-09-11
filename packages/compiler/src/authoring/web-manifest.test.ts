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
      route: "/relations",
      operations: { update: { id: "Relation.update", intent: "update" } },
      fields: {
        id: { access: { read: true, create: false, update: false } },
        displayName: { access: { read: true, create: true, update: true } },
      },
      record: {
        titleTemplate: "{{displayName}}",
        actions: { update: { id: "Relation.update" }, delete: { id: "Relation.delete" } },
      },
      relationships: {
        contactDetails: {
          targetEntityId: "ContactDetail",
          recordField: "relationId",
          collection: { operation: { id: "ContactDetail.list" } },
        },
      },
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

  test("projects the web interface independently of REST exposure", () => {
    const relation = entity("Relation", "relation", [field("displayName")], coreView());
    delete relation.contract.rest;

    const projected = buildWebManifest([relation]).entities.Relation;
    expect(projected).toBeDefined();
    expect(projected!.operations.list).toEqual({ id: "Relation.list", intent: "list" });
    expect(projected!.route).toBe("/relations");
  });
});
