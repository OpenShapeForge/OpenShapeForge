// SPDX-License-Identifier: BUSL-1.1
/**
 * Published-snapshot versioning binds its storage into the manifest: the
 * head table's source names the exact schema and table of both sides and the
 * version table's foreign key back to the head. The versioning runtime reads
 * these and derives nothing, which is what lets a plugin entity in its own
 * schema publish. Fixtures: __fixtures__/rowaccess/entities/versioned-note*.yaml
 * (module `notes`, so the tables land in schema `notes`).
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import type { CompiledEntityContract } from "./types/compiled.js";

const fixtureDir = join(import.meta.dir, "__fixtures__", "rowaccess");
const slugs = ["versioned-note", "versioned-note-version", "versioned-note-line"];
const compile = (mutate: (contract: CompiledEntityContract) => void = () => {}, entityAllowlist = slugs) =>
  compileAuthoringBackendManifest(fixtureDir, {
    mode: "promote",
    entityAllowlist,
    generatedCrudAllowlist: entityAllowlist,
    onCandidate: ({ contract }) => mutate(contract),
  });

function compileWithVersionedNoteYaml(transform: (yaml: string) => string) {
  const directory = mkdtempSync(join(tmpdir(), "osf-versioning-guards-"));
  try {
    cpSync(fixtureDir, directory, { recursive: true });
    const path = join(directory, "entities", "versioned-note.yaml");
    writeFileSync(path, transform(readFileSync(path, "utf8")));
    return compileAuthoringBackendManifest(directory, {
      mode: "promote",
      entityAllowlist: slugs,
      generatedCrudAllowlist: slugs,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("published-snapshot storage binding", () => {
  it("binds the head and version tables of a non-core module with the head foreign key", () => {
    const manifest = compile();
    const head = manifest.tables.find((table) => table.source?.authoringEntityName === "VersionedNote")!;
    const version = manifest.tables.find((table) => table.source?.authoringEntityName === "VersionedNoteVersion")!;
    expect([head.schema, head.name]).toEqual(["notes", "versioned_notes"]);
    expect([version.schema, version.name]).toEqual(["notes", "versioned_note_versions"]);
    expect(head.source?.versioning).toEqual({
      strategy: "publishedSnapshot",
      versionEntity: "VersionedNoteVersion",
      versionsField: "versions",
      snapshot: { ownedRelationships: "recursive" },
      publishOperation: "VersionedNote.publish",
      onEdit: { field: "lifecycleStatus", value: "draft" },
      storage: {
        head: { schema: "notes", table: "versioned_notes" },
        version: { schema: "notes", table: "versioned_note_versions", headColumn: "note_id" },
        // The authored ownership tree a snapshot walks: the owned lines, never
        // the version table although its head reference cascades as well.
        owned: [{ schema: "notes", table: "versioned_note_lines", childColumns: ["tenant_id", "note_id"], parentColumns: ["tenant_id", "id"], children: [] }],
      },
    });
    expect(version.source?.versioning).toBeUndefined();
    // The bound column is the owned reference the manifest lowers, in the same schema.
    const column = version.columns.find((column) => column.name === "note_id")!;
    expect(column.references).toMatchObject({ schema: "notes", table: "versioned_notes", column: "id", onDelete: "CASCADE" });
  });

  it("refuses a versionsField that is not the version entity's collection on the head", () => {
    expect(() => compile((contract) => {
      if (contract.entity.name === "VersionedNote") contract.versioning!.versionsField = "revisions";
    })).toThrow("VersionedNote: versioning.versionsField revisions is not an owned collection of VersionedNoteVersion.");
  });

  it("refuses a version entity that is not in the manifest", () => {
    expect(() => compile(() => {}, ["versioned-note", "versioned-note-line"])).toThrow("VersionedNote: versioning.versionEntity VersionedNoteVersion has no storage in this manifest.");
  });

  it("binds an empty ownership tree for a head that owns nothing but its versions", () => {
    const manifest = compile(() => {}, ["versioned-note", "versioned-note-version"]);
    const head = manifest.tables.find((table) => table.source?.authoringEntityName === "VersionedNote")!;
    expect(head.source?.versioning?.storage.owned).toEqual([]);
  });

  it("leaves a referenced (not owned) collection out of the ownership tree", () => {
    const manifest = compile((contract) => {
      if (contract.entity.name === "VersionedNote") {
        const lines = contract.model.relationships.find((relationship) => relationship.key === "lines")!;
        lines.ownership = "reference";
      }
    });
    const head = manifest.tables.find((table) => table.source?.authoringEntityName === "VersionedNote")!;
    expect(head.source?.versioning?.storage.owned).toEqual([]);
  });

  it("refuses an authored Operation that collides with the compiler-owned publish Operation", () => {
    expect(() => compileWithVersionedNoteYaml((yaml) => yaml.replace(
      "operations:\n",
      `operations:\n  publish:\n    name: Publish differently\n    description: An authored Operation must not replace versioning publication.\n    implementation: { type: plugin, plugin: example, handler: publishDifferently }\n    target: { scope: record, inputField: id }\n    input: { schema: { type: object, required: [id], properties: { id: { type: string, format: uuid } } } }\n    output: { schema: { type: object } }\n    errors: []\n    auth: { mode: session, roles: [Organization.All.ReadWrite] }\n    tenancy: { mode: required }\n    effects: { data: write, external: none }\n    reliability: { idempotency: { mode: none } }\n    confirmation: { mode: none }\n`,
    ))).toThrow(
      '[VersionedNote] versioning owns the canonical VersionedNote.publish Operation; authored operation "publish" collides with it.',
    );
  });

  it("refuses an authored field that weakens a compiler-owned versioning field", () => {
    expect(() => compileWithVersionedNoteYaml((yaml) => yaml.replace(
      "fields:\n",
      `fields:\n  - key: publishedVersionId\n    osfType: string\n    label: { en: Published version id, nl: Id van gepubliceerde versie }\n    persisted: { column: published_version_id, storageClass: core }\n`,
    ))).toThrow(
      '[VersionedNote] versioning reserves compiler-managed field "publishedVersionId"; remove the authored field.',
    );
  });

  it("refuses even an exact authored duplicate of a compiler-managed versioning field", () => {
    expect(() => compileWithVersionedNoteYaml((yaml) => yaml.replace(
      "fields:\n",
      `fields:\n  - key: publishedVersionId\n    osfType: string\n    readOnly: true\n    writtenBy: [VersionedNote.publish]\n    validation: { format: uuid }\n    label: { en: Published version id, nl: Id van gepubliceerde versie }\n    persisted: { column: published_version_id, storageClass: core }\n`,
    ))).toThrow(
      '[VersionedNote] versioning reserves compiler-managed field "publishedVersionId"; remove the authored field.',
    );
  });
});
