// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import type { VersionedMigration } from "../versioned-runner.js";

/**
 * Align already-installed relation FKs with the subject-erasure procedure.
 * Fresh installations receive the same clauses from generated schema.sql;
 * existing installations need this additive forward transformation because
 * generated roll-forward deliberately does not rewrite constraints.
 */
const migration: VersionedMigration = {
  version: "0007_privacy-erasure-foreign-keys",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    await sql`
      do $openshapeforge_privacy_erasure$
      begin
        if to_regclass('erp.contact_details') is not null then
          alter table erp.contact_details
            drop constraint if exists contact_details_relation_id_fkey;
          alter table erp.contact_details
            add constraint contact_details_relation_id_fkey
            foreign key (relation_id) references erp.relations(id) on delete restrict;
        end if;
        if to_regclass('erp.payment_details') is not null then
          alter table erp.payment_details
            drop constraint if exists payment_details_relation_id_fkey;
          alter table erp.payment_details
            add constraint payment_details_relation_id_fkey
            foreign key (relation_id) references erp.relations(id) on delete restrict;
        end if;
      end
      $openshapeforge_privacy_erasure$;
    `.execute(db);
  },
};

export default migration;
