// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CompiledEntityInfo } from "../plugins.js";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { compile } from "./compiler/index.js";
import { loadEntity } from "./loader.js";
import { buildWebManifest } from "./web-manifest.js";

const authoringDir = join(import.meta.dir, "../../config/authoring");
const slugs = ["relation", "relation-group", "relation-group-membership"] as const;

function compiled(slug: (typeof slugs)[number]): CompiledEntityInfo {
  return {
    slug,
    path: `entities/core/${slug}.yaml`,
    origin: "core",
    contract: compile(loadEntity(authoringDir, slug)),
  };
}

describe("typed RelationGroups and many-relation memberships", () => {
  test("keeps the legacy single-group column read-only and makes memberships canonical", () => {
    const relation = compiled("relation").contract;
    const legacy = relation.model.fields.find(({ key }) => key === "relationGroupId");
    expect(legacy).toMatchObject({
      key: "relationGroupId",
      semanticType: "RelationGroup",
      readOnly: true,
      immutable: true,
      relationship: {
        kind: "belongsTo",
        target: "RelationGroup",
        foreignKey: "relation_group_id",
        ownership: "reference",
      },
    });
    expect(relation.model.relationships.find(({ key }) => key === "relationGroupId"))
      .toMatchObject({ kind: "belongsTo", target: "RelationGroup" });
    expect(relation.model.relationships.find(({ key }) => key === "groupMemberships"))
      .toMatchObject({
        kind: "hasMany",
        target: "RelationGroupMembership",
        foreignKey: "relation_id",
      });

    const manifest = buildWebManifest(slugs.map(compiled));
    expect(manifest.entities.Relation?.fields.relationGroupId?.supports).toEqual({
      read: true,
      create: false,
      update: false,
    });
    expect(manifest.entities.Relation?.views.record?.layout.tabs).toContainEqual(
      expect.objectContaining({
        id: "group-memberships",
        relationshipId: "groupMemberships",
      }),
    );
  });

  test("authors typed active groups without granting membership-derived access", () => {
    const group = compiled("relation-group").contract;
    expect(group.model.fields.find(({ key }) => key === "groupType")).toMatchObject({
      required: true,
      options: { type: "referentiedata", referentieGroep: "RELATIONGROUPTYPE" },
    });
    expect(group.model.fields.find(({ key }) => key === "status")).toMatchObject({
      required: true,
      defaultValue: "active",
      options: { type: "referentiedata", referentieGroep: "RELATIONGROUPSTATUS" },
    });
    expect(group.authorization.roles).toEqual({
      read: [
        "Relations.All.Read",
        "Relations.All.ReadWrite",
        "Relations.RelationGroups.ReadWrite",
      ],
      create: ["Relations.RelationGroups.ReadWrite"],
      update: ["Relations.RelationGroups.ReadWrite"],
      delete: ["Relations.RelationGroups.ReadWrite"],
    });
    expect(group.model.relationships.find(({ key }) => key === "relationId")).toBeDefined();
    expect(group.model.relationships.find(({ key }) => key === "memberships")).toMatchObject({
      target: "RelationGroupMembership",
      foreignKey: "relation_group_id",
    });
  });

  test("projects generic CRUD interfaces with immutable links and status-only updates", () => {
    const membership = compiled("relation-group-membership").contract;
    expect(membership.authoringVersion).toBe(3);
    expect(membership.entity.name).toBe("RelationGroupMembership");
    expect(membership.authorization.roles).toEqual({
      read: [
        "Relations.All.Read",
        "Relations.All.ReadWrite",
        "Relations.RelationGroups.ReadWrite",
      ],
      create: ["Relations.RelationGroups.ReadWrite"],
      update: ["Relations.RelationGroups.ReadWrite"],
      delete: ["Relations.RelationGroups.ReadWrite"],
    });
    expect(membership.rest?.operations).toEqual({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    });
    expect(membership.graphql.operations).toEqual(membership.rest?.operations);
    expect(membership.mcp?.operations).toEqual(membership.rest?.operations);

    for (const key of ["relationId", "relationGroupId"] as const) {
      expect(membership.model.fields.find((field) => field.key === key)).toMatchObject({
        required: true,
        immutable: true,
      });
    }
    expect(membership.entityOperations.update?.concurrency).toEqual({
      version: { mode: "required", field: "updatedAt" },
      editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
    });
    expect(membership.entityOperations.delete).toMatchObject({
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
      interaction: { confirmation: {
        mode: "challenge",
        challenge: { kind: "type-current-field", field: "relationGroupId" },
      } },
    });

    const projected = buildWebManifest(slugs.map(compiled)).entities.RelationGroupMembership!;
    expect(projected.fields.relationId?.supports).toEqual({
      read: true,
      create: true,
      update: false,
    });
    expect(projected.fields.relationGroupId?.supports).toEqual({
      read: true,
      create: true,
      update: false,
    });
    expect(projected.fields.status?.supports).toEqual({
      read: true,
      create: true,
      update: true,
    });
    expect(projected.relationships.relationId).toMatchObject({
      targetEntityId: "Relation",
      recordField: "relationId",
      foreignKey: "relation_id",
    });
    expect(projected.relationships.relationGroupId).toMatchObject({
      targetEntityId: "RelationGroup",
      recordField: "relationGroupId",
      foreignKey: "relation_group_id",
    });
    expect(projected.relationships.relationId?.collection?.displayField).toBe("displayName");
    expect(projected.relationships.relationGroupId?.collection?.displayField).toBe("name");
  });

  test("emits the tenant-unique membership table and both canonical foreign keys", () => {
    const entityAllowlist = readdirSync(join(authoringDir, "entities/core"))
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.slice(0, -".yaml".length));
    const backend = compileAuthoringBackendManifest(authoringDir, {
      mode: "promote",
      entityAllowlist,
      generatedCrudAllowlist: entityAllowlist,
      schemaByModule: { core: "erp" },
    });
    const table = backend.tables.find(({ schema, name }) =>
      schema === "erp" && name === "relation_group_memberships"
    );
    expect(table).toBeDefined();
    expect(table?.indexes).toEqual(expect.arrayContaining([{
      name: "relation_group_memberships_tenant_relation_group_uidx",
      columns: ["tenant_id", "relation_id", "relation_group_id"],
      unique: true,
    }]));
    expect(table?.columns.find(({ name }) => name === "relation_id")).toMatchObject({
      required: true,
      immutable: true,
      references: { schema: "erp", table: "relations", column: "id" },
    });
    expect(table?.columns.find(({ name }) => name === "relation_group_id")).toMatchObject({
      required: true,
      immutable: true,
      references: { schema: "erp", table: "relation_groups", column: "id" },
    });
    expect(table?.columns.find(({ name }) => name === "status")).toMatchObject({
      required: true,
      default: "'active'",
    });
  });
});
