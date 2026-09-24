// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { entityColumnName, entityTableName } from "../manifest-lookup.js";

/**
 * Document-theme invariants the generated unique index cannot keep usable:
 * the first theme of a tenant becomes the default, the explicit setDefault
 * Operation changes it under a tenant lock, a default cannot be deleted, and
 * a new template without a theme receives the tenant default.
 * None of these statements write a DocumentVersion, so stored PDF bytes stay
 * the bytes that were generated.
 */
export async function applyDocumentThemeInvariants(db: OpenShapeForgeDatabase): Promise<void> {
  const themes = sql.table(entityTableName("DocumentTheme"));
  const templates = sql.table(entityTableName("Template"));
  const isDefault = entityColumnName("DocumentTheme", "isDefault");
  const themeId = entityColumnName("Template", "documentThemeId");

  await sql`
    create or replace function app.enforce_document_theme_default()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if tg_op = 'INSERT' then
        perform pg_advisory_xact_lock(683165, hashtext(new.tenant_id::text));
        new.${sql.ref(isDefault)} := not exists (
          select 1 from ${themes} other
          where other.tenant_id = new.tenant_id and other.${sql.ref(isDefault)}
        );
      elsif new.${sql.ref(isDefault)} is distinct from old.${sql.ref(isDefault)}
        and current_setting('app.document_theme_switching', true) is distinct from '1' then
        raise exception 'VALIDATION: use DocumentTheme.setDefault to change the tenant default.';
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists document_themes_default_guard on ${themes};
    create trigger document_themes_default_guard
      before insert or update on ${themes}
      for each row execute function app.enforce_document_theme_default();

    create or replace function app.protect_document_theme_default()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if old.${sql.ref(isDefault)} then
        raise exception 'VALIDATION: choose another default before deleting this document theme.';
      end if;
      return old;
    end;
    $function$;

    drop trigger if exists document_themes_default_promote on ${themes};
    drop trigger if exists document_themes_default_guard_delete on ${themes};
    create trigger document_themes_default_guard_delete
      before delete on ${themes}
      for each row execute function app.protect_document_theme_default();

    create or replace function app.fill_template_document_theme()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if new.${sql.ref(themeId)} is not null then
        return new;
      end if;
      select other.id into new.${sql.ref(themeId)}
        from ${themes} other
        where other.tenant_id = new.tenant_id and other.${sql.ref(isDefault)}
        limit 1;
      return new;
    end;
    $function$;

    drop trigger if exists templates_document_theme_default on ${templates};
    create trigger templates_document_theme_default
      before insert on ${templates}
      for each row execute function app.fill_template_document_theme();
  `.execute(db);
}
