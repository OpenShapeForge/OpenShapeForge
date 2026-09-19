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
});
