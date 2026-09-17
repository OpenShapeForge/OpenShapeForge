// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { generateArtifacts } from "../generate.js";
import type { PlatformSchemaManifest } from "../schema.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";

const fixtureDir = join(import.meta.dir, "__fixtures__", "rowaccess");
const sourceName = "RowAccessOwner";
const targetName = "RowAccessOwnerTarget";

// Exercise the normalized-contract → storage boundary independently of YAML normalization.
function compileRelations(
  mutate: (contract: CompiledEntityContract) => void = () => {},
  includeTarget = true,
): PlatformSchemaManifest {
  return compileAuthoringBackendManifest(fixtureDir, {
    mode: "promote",
    entityAllowlist: ["rowaccess-owner", ...(includeTarget ? ["rowaccess-owner-target"] : [])],
    onCandidate: ({ contract }) => {
      Object.assign(contract, { authoringVersion: 3 });
      if (contract.authorization) delete contract.authorization.rowAccess;
      if (contract.entity.name === sourceName) {
        contract.model.relationships = [{
          ...contract.model.relationships[0]!,
          ...{ fieldKey: "owner", ownership: "reference" },
        }];
      }
      mutate(contract);
    },
  });
}

function source(manifest: PlatformSchemaManifest) {
  return manifest.tables.find((table) => table.source?.authoringEntityName === sourceName)!;
}
function target(manifest: PlatformSchemaManifest) {
  return manifest.tables.find((table) => table.source?.authoringEntityName === targetName)!;
}
function sql(manifest: PlatformSchemaManifest) {
  return generateArtifacts(manifest).find((artifact) => artifact.path.endsWith("schema.sql"))!.contents;
}
describe("schema-3 field relationship storage", () => {
  it("retains a nullable authoritative tenant column as a single FK and refuses uniqueness", () => {
    const bindTenant = (contract: CompiledEntityContract) => {
      // The derived inverse collection on the target follows the renamed key.
      if (contract.entity.name === targetName) contract.model.relationships.find((relationship) => relationship.key === "rowAccessOwners")!.foreignKey = "tenant_id";
      if (contract.entity.name !== sourceName) return;
      const column = contract.storage.columns.find(column => column.column === "owner_id")!;
      Object.assign(column, { field: "scopeIdentity", column: "tenant_id", nullable: true });
      Object.assign(contract.model.relationships[0]!, { foreignKey: "tenant_id", fieldKey: "scopeIdentity" });
    };
    const manifest = compileRelations(bindTenant);
    const column = source(manifest).columns.find(column => column.name === "tenant_id")!;
    expect(column.required).not.toBe(true);
    expect(column.references).toEqual({ schema: "erp", table: target(manifest).name, column: "id" });
    expect(sql(manifest)).toContain('FOREIGN KEY ("tenant_id")');
    expect(sql(manifest)).not.toContain('FOREIGN KEY ("tenant_id", "tenant_id")');
    expect(() => compileRelations(contract => {
      bindTenant(contract);
      if (contract.entity.name === sourceName) contract.model.relationships[0]!.unique = true;
    })).toThrow("cannot be owned or unique");
  });
  it("emits tenant-safe FKs, target uniqueness and a tenant-leading source index", () => {
    const manifest = compileRelations();
    const owner = source(manifest);
    const referenced = target(manifest);
    expect(owner.source?.authoringVersion).toBe(3);
    expect(owner.columns.find((column) => column.name === "owner_id")).toMatchObject({
      type: "uuid",
      references: {
        localColumns: ["tenant_id", "owner_id"], targetColumns: ["tenant_id", "id"],
        schema: "erp", table: referenced.name, column: "id",
      },
    });
    expect(owner.indexes).toContainEqual({ name: `${owner.name}_tenant_id_owner_id_idx`, columns: ["tenant_id", "owner_id"] });
    expect(referenced.indexes).toContainEqual({ name: `${referenced.name}_tenant_id_id_key`, columns: ["tenant_id", "id"], unique: true });
    const ddl = sql(manifest);
    expect(ddl).toContain('FOREIGN KEY ("tenant_id", "owner_id")');
    expect(ddl).toContain(`REFERENCES "erp"."${referenced.name}"("tenant_id", "id")`);
    expect(ddl.indexOf('FOREIGN KEY ("tenant_id", "owner_id")')).toBeGreaterThan(ddl.lastIndexOf("CREATE TABLE"));
    expect(ddl.indexOf('FOREIGN KEY ("tenant_id", "owner_id")')).toBeGreaterThan(ddl.indexOf("CREATE UNIQUE INDEX"));
  });

  it("emits canonical cross-module FKs without a separately authored register", () => {
    const manifest = compileRelations((contract) => {
      if (contract.entity.name === targetName) contract.entity.module = "directory";
    });
    expect(manifest.relationshipRegister).toContainEqual({
      from: { schema: "erp", table: source(manifest).name, column: "owner_id" },
      to: { schema: "directory", table: target(manifest).name, column: "id" },
    });
    expect(source(manifest).source?.relationshipStatus?.skippedReferences).toEqual([]);
    expect(sql(manifest)).toContain(`REFERENCES "directory"."${target(manifest).name}"`);
  });

  it("fails closed for an absent target or absent foreign-key column", () => {
    expect(() => compileRelations(undefined, false)).toThrow("targets missing entity");
    expect(() => compileRelations((contract) => {
      if (contract.entity.name === sourceName) contract.model.relationships[0]!.foreignKey = "missing";
    })).toThrow("no persisted foreign-key column");
  });

  it("does not duplicate an authored field-key column or require an Id field", () => {
    const manifest = compileRelations((contract) => {
      if (contract.entity.name === targetName) contract.model.relationships.find((relationship) => relationship.key === "rowAccessOwners")!.foreignKey = "owner";
      if (contract.entity.name !== sourceName) return;
      const column = contract.storage.columns.find((column) => column.column === "owner_id")!;
      Object.assign(column, { column: "owner", field: "owner", type: "jsonb" });
      contract.model.relationships[0]!.foreignKey = "owner";
    });
    expect(source(manifest).columns.filter((column) => column.name === "owner")).toHaveLength(1);
    expect(source(manifest).columns.find((column) => column.name === "owner")?.type).toBe("uuid");
    expect(source(manifest).columns.some((column) => column.name === "owner_id")).toBe(false);
  });

  it("uses unique tenant-leading indexes for one-to-one references", () => {
    const manifest = compileRelations((contract) => {
      if (contract.entity.name === sourceName) Object.assign(contract.model.relationships[0]!, { unique: true });
    });
    expect(source(manifest).indexes).toContainEqual({
      name: `${source(manifest).name}_tenant_id_owner_id_key`, columns: ["tenant_id", "owner_id"], unique: true,
    });
  });

  it("rejects global → tenant references but allows tenant → global references", () => {
    expect(() => compileRelations((contract) => {
      if (contract.entity.name === sourceName) Reflect.deleteProperty(contract, "authorization");
    })).toThrow("cannot reference tenant-scoped");
    const manifest = compileRelations((contract) => {
      if (contract.entity.name === targetName) Reflect.deleteProperty(contract, "authorization");
    });
    expect(source(manifest).columns.find((column) => column.name === "owner_id")?.references?.localColumns).toBeUndefined();
    expect(sql(manifest)).toContain('FOREIGN KEY ("owner_id")');
    expect(source(manifest).indexes?.[0]?.columns).toEqual(["tenant_id", "owner_id"]);
  });

  it("rejects non-UUID target keys instead of advertising invalid FK integrity", () => {
    expect(() => compileRelations((contract) => {
      if (contract.entity.name === targetName) contract.storage.columns.find((column) => column.column === "id")!.type = "text";
    })).toThrow("requires a UUID id primary key");
  });

  const ownedChildren = (contract: CompiledEntityContract) => {
    if (contract.entity.name === sourceName) {
      contract.model.relationships = [{
        key: "children", kind: "hasMany", target: targetName, foreignKey: "parent",
        ...{ fieldKey: "children", inverse: "parent", ownership: "owned", sortable: true },
      }];
    } else {
      contract.storage.columns.push({ field: "parent", column: "parent", type: "uuid", nullable: false, storageClass: "core" });
    }
  };

  it("stores sortable owned inverse collections on the child with parent-delete cascading", () => {
    const manifest = compileRelations((contract) => {
      if (contract.entity.name === sourceName) {
        contract.model.relationships = [{
          key: "children", kind: "hasMany", target: targetName, foreignKey: "parent",
          ...{ fieldKey: "children", inverse: "parent", ownership: "owned", sortable: true },
        }];
      } else {
        contract.storage.columns.push({ field: "parent", column: "parent", type: "uuid", nullable: false, storageClass: "core" });
      }
    });
    expect(target(manifest).columns.find((column) => column.name === "parent")?.references).toMatchObject({
      table: source(manifest).name, onDelete: "CASCADE", localColumns: ["tenant_id", "parent"],
    });
    expect(target(manifest).columns.find((column) => column.name === "parent_position")?.type).toBe("integer");
    expect(sql(manifest)).toContain(`REFERENCES "erp"."${source(manifest).name}"("tenant_id", "id") ON DELETE CASCADE`);
    expect(manifest.tables.some((table) => table.relationStorage)).toBe(false);
  });

  it("rejects missing inverse storage and authored position collisions", () => {
    const inverse = (contract: CompiledEntityContract) => {
      if (contract.entity.name === sourceName) contract.model.relationships = [{
        key: "children", kind: "hasMany", target: targetName, foreignKey: "parent", ...{ sortable: true },
      }];
    };
    expect(() => compileRelations(inverse)).toThrow("no inverse foreign-key column");
    expect(() => compileRelations((contract) => {
      inverse(contract);
      if (contract.entity.name === targetName) contract.storage.columns.push(
        { field: "parent", column: "parent", type: "uuid", nullable: false, storageClass: "core" },
        { field: "parentPosition", column: "parent_position", type: "integer", nullable: false, storageClass: "core" },
      );
    })).toThrow("Sortable relationship storage collides");
  });

  it("generates byte-identical outputs for the same canonical relations", () => {
    const compile = () => compileRelations(ownedChildren);
    expect(generateArtifacts(compile())).toEqual(generateArtifacts(compile()));
  });

  it("reuses equivalent authored indexes and rejects generated index name collisions", () => {
    const manifest = compileRelations((contract) => {
      if (contract.entity.name === targetName) contract.entity.indexes = [{ name: "existing_tenant_key", fields: ["tenantId", "id"], unique: true }];
    });
    expect(target(manifest).indexes?.filter((index) => index.columns.join() === "tenant_id,id")).toEqual([
      { name: "existing_tenant_key", columns: ["tenant_id", "id"], unique: true },
    ]);
    expect(() => compileRelations((contract) => {
      if (contract.entity.name === targetName) contract.entity.indexes = [{ name: `${contract.storage.table}_tenant_id_id_key`, fields: ["name"] }];
    })).toThrow("index collides");
  });

  it("emits cyclic composite references after both tables and target indexes", () => {
    const manifest = compileRelations((contract) => {
      if (contract.entity.name !== targetName) return;
      contract.storage.columns.push({ field: "parent", column: "parent", type: "uuid", nullable: true, storageClass: "core" });
      contract.model.relationships = [{ key: "parent", kind: "belongsTo", target: sourceName, foreignKey: "parent", ...{ fieldKey: "parent" } }];
    });
    const ddl = sql(manifest);
    expect(ddl.match(/ADD CONSTRAINT .* FOREIGN KEY/g)).toHaveLength(2);
    expect(ddl.indexOf("ADD CONSTRAINT")).toBeGreaterThan(ddl.lastIndexOf("CREATE UNIQUE INDEX"));
  });

  it("refuses malformed composite reference metadata and missing unique targets", () => {
    const missingColumns = compileRelations();
    source(missingColumns).columns.find((column) => column.name === "owner_id")!.references!.localColumns = ["missing", "owner_id"];
    expect(() => sql(missingColumns)).toThrow("Invalid composite foreign key target");
    const missingUnique = compileRelations();
    target(missingUnique).indexes = [];
    expect(() => sql(missingUnique)).toThrow("requires a matching unique index");
    const unpaired = compileRelations();
    delete source(unpaired).columns.find((column) => column.name === "owner_id")!.references!.targetColumns;
    expect(() => sql(unpaired)).toThrow("Invalid composite foreign key");
  });

  it("migrated fixtures cannot retain the legacy missing-target fallback", () => {
    expect(() => compileAuthoringBackendManifest(fixtureDir, { mode: "promote", entityAllowlist: ["rowaccess-owner"] }))
      .toThrow("targets missing entity RowAccessOwnerTarget");
  });
});
