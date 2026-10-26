// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import { auditTableConfigs } from "../migrations/audit-history.js";
import type { GeneratedCrudTable } from "../../operations/entity/types.js";

test("entity-value physical references cannot enter realtime visibility or audit row snapshots", () => {
  const carrier = manifest.entityValues.carriers[0]!;
  const reference = Object.values(carrier.definitions).flatMap(value => value.references)[0]!;
  const table = structuredClone(manifest.tables.find(table => table.schema === carrier.schema && table.table === carrier.table)) as unknown as GeneratedCrudTable;
  table.realtime = { readPredicate: "true", visibilityColumns: ["tenant_id", reference.column] };
  const config = auditTableConfigs([table], {})[0]!;
  expect(config.visibility).toEqual(["tenant_id"]);
  expect(Object.keys(config.fields)).not.toContain(reference.column);
});
