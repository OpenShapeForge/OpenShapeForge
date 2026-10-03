// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "./load-manifest.js";
import { generateArtifacts } from "./generate.js";

test("registered same-schema deferred references still require a real merged target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "registered-reference-"));
  const path = join(dir, "schema.yaml");
  const schema = `version: 1
tables:
  - schema: erp
    name: historical_rows
    tenantScoped: true
    domainInternal: true
    generatedCrudEligible: false
    columns:
      - { name: id, type: uuid, primaryKey: true }
      - { name: tenant_id, type: uuid, required: true }
      - { name: relation_id, type: uuid, references: { schema: erp, table: relations, column: id, localColumns: [tenant_id, relation_id], targetColumns: [tenant_id, id] } }
`;
  try {
    await writeFile(path, schema);
    await expect(loadManifest(path)).rejects.toThrow("references unknown table erp.relations");
    await writeFile(path, `${schema}relationshipRegister:
  - from: { schema: erp, table: historical_rows, column: relation_id }
    to: { schema: erp, table: relations, column: id }
`);
    const base = await loadManifest(path);
    expect(() => generateArtifacts(base)).toThrow(/erp\.relations/);
    expect(() => generateArtifacts({ ...base, tables: [...base.tables, {
      schema: "erp", name: "relations", tenantScoped: true,
      columns: [{ name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "uuid", required: true }],
      indexes: [{ name: "relations_tenant_identity_uidx", columns: ["tenant_id", "id"], unique: true }],
    }] })).not.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
