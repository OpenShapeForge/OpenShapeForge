// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OwnedDeletePlan } from "@openshapeforge/operations";
import operationCatalog from "../../../generated/operations/catalog.json" with { type: "json" };
import { ownedDeleteForeignKeyIdentity, readOwnedDeleteForeignKeys } from "../../owned-delete-foreign-keys.js";
import type { VersionedMigration } from "../versioned-runner.js";

const migration: VersionedMigration = {
  version: "0030_owned-delete-foreign-keys",
  fileUrl: import.meta.url,
  async up(db) {
    const operations = operationCatalog.operations as Array<{ implementation?: { type: string; plan?: OwnedDeletePlan } }>;
    const plans = operations.flatMap(operation =>
      operation.implementation?.type === "ownedDelete" && operation.implementation.plan ? [operation.implementation.plan] : []);
    if (!plans.length) return;
    const targets = [...new Set(plans.flatMap(plan => plan.discover.map(step => step.table)))].sort();
    const expected = new Set(plans.flatMap(plan => plan.foreignKeys.map(ownedDeleteForeignKeyIdentity)));
    for (const edge of await readOwnedDeleteForeignKeys(db, targets)) {
      if (!expected.has(ownedDeleteForeignKeyIdentity(edge)) || edge.action === "a") continue;
      const table = sql.id(...edge.source.split("."));
      const name = sql.id(edge.constraint);
      const definition = edge.definition.replace(/\sON DELETE (CASCADE|RESTRICT|SET NULL(?: \([^()]+\))?|SET DEFAULT)(?=\s|$)/i, "");
      if (definition === edge.definition) throw Error("Could not normalize the owned delete foreign key.");
      // The original definition comes from the PostgreSQL catalog. Preserve
      // match semantics, update action and deferral while changing only delete.
      await sql`alter table ${table} drop constraint ${name}, add constraint ${name} ${sql.raw(definition)}`.execute(db);
    }
  },
};

export default migration;
