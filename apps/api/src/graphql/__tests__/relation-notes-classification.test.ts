// SPDX-License-Identifier: BUSL-1.1
/**
 * `Relation.notes` is the first shipped entity field to carry field-level
 * `classification` (relation.yaml: `classification: { sensitivity:
 * confidential }`). This locks two things against the REAL compiled manifest,
 * not a synthetic fixture:
 *
 *   - the manifest actually carries the classification on `notes` and NOT on
 *     the new `businessContext` field (businessContext is meant to be
 *     broadly readable, unlike notes);
 *   - `redactRow`, the shared engine every transport (GraphQL/REST/MCP)
 *     calls through generated-crud.ts, actually redacts `notes` for a
 *     read-only Relations session and leaves `businessContext` intact for
 *     the same reader.
 */
import { describe, expect, it } from "bun:test";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import { redactRow, canReadClassifiedColumns } from "../generated-authz.js";
import type { GeneratedCrudAuthorization } from "../generated-crud.js";

type ManifestColumn = {
  name: string;
  sourceField?: string;
  classification?: "confidential" | "pii" | "bsn";
};

type ManifestTable = { schema: string; table: string; columns: ManifestColumn[] };

function relationsTable(): ManifestTable {
  const table = (manifest as { tables: ManifestTable[] }).tables.find(
    (candidate) => candidate.schema === "erp" && candidate.table === "relations",
  );
  if (!table) throw new Error("erp.relations is missing from the compiled manifest.");
  return table;
}

const authorization: GeneratedCrudAuthorization = {
  roles: {
    read: ["Relations.All.Read", "Relations.All.ReadWrite"],
    create: ["Relations.All.ReadWrite"],
    update: ["Relations.All.ReadWrite"],
    delete: ["Relations.All.ReadWrite"],
  },
};
const readOnly = { roles: ["Relations.All.Read"] };
const readWrite = { roles: ["Relations.All.ReadWrite"] };

describe("Relation.notes classification (compiled manifest)", () => {
  it("notes carries classification: confidential", () => {
    const notes = relationsTable().columns.find((column) => column.name === "notes");
    expect(notes?.classification).toBe("confidential");
  });

  it("businessContext carries no classification", () => {
    const businessContext = relationsTable().columns.find(
      (column) => column.name === "business_context",
    );
    expect(businessContext).toBeDefined();
    expect(businessContext?.classification).toBeUndefined();
  });

  it("redacts notes to null for a read-only Relations session, keeps businessContext", () => {
    const columns = relationsTable().columns;
    const row = {
      id: "r1",
      display_name: "Acme BV",
      notes: "Internal staff note: chased for payment twice.",
      business_context: "Acme sells industrial fasteners.",
    };
    const redacted = redactRow(row, columns, authorization, readOnly);
    expect(redacted.notes).toBeNull();
    expect(redacted.business_context).toBe("Acme sells industrial fasteners.");
    expect(redacted.display_name).toBe("Acme BV");
    // No mutation of the original row.
    expect(row.notes).toBe("Internal staff note: chased for payment twice.");
  });

  it("leaves notes visible for a Relations.All.ReadWrite session", () => {
    const columns = relationsTable().columns;
    const row = { id: "r1", notes: "Internal staff note.", business_context: null };
    expect(canReadClassifiedColumns(authorization, readWrite)).toBe(true);
    const kept = redactRow(row, columns, authorization, readWrite);
    expect(kept.notes).toBe("Internal staff note.");
  });
});
