// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { entityColumnName, entityTableName } from "../manifest-lookup.js";

/**
 * A template version reads as "Voorstel · v7": its display template names the
 * template beside the number. The name is the one the frozen content carries
 * (`snapshot.head.row.name`), so it is as immutable as the version itself and
 * a later rename of the template never rewrites what an older version says.
 * The generic snapshot publish (packages/versioning) inserts without it; this
 * trigger fills it on insert, and the backfill gives versions published
 * before the column existed the same name. Both are idempotent.
 */
export async function applyTemplateVersionNames(db: OpenShapeForgeDatabase): Promise<void> {
  const versions = sql.table(entityTableName("TemplateVersion"));
  const name = entityColumnName("TemplateVersion", "templateName");
  const snapshot = entityColumnName("TemplateVersion", "snapshot");

  await sql`
    create or replace function app.template_version_name()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      new.${sql.ref(name)} := nullif(btrim(new.${sql.ref(snapshot)} #>> '{head,row,name}'), '');
      return new;
    end;
    $function$;

    drop trigger if exists template_versions_name on ${versions};
    create trigger template_versions_name
      before insert on ${versions}
      for each row execute function app.template_version_name();
  `.execute(db);

  await sql`
    update ${versions}
       set ${sql.ref(name)} = nullif(btrim(${sql.ref(snapshot)} #>> '{head,row,name}'), '')
     where ${sql.ref(name)} is null
       and nullif(btrim(${sql.ref(snapshot)} #>> '{head,row,name}'), '') is not null
  `.execute(db);
}
