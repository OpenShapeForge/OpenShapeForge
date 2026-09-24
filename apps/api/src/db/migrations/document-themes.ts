// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { entityColumnName, entityTableName } from "../manifest-lookup.js";

/**
 * Document-theme invariants the generated unique index cannot keep usable:
 * the first theme of a tenant becomes the default, choosing a new default
 * unsets the previous one, deleting the default promotes another remaining
 * theme, and a new template without a theme receives the tenant default.
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
      if nullif(current_setting('app.document_theme_switching', true), '') is not null then
        return new;
      end if;
      if tg_op = 'UPDATE' and old.${sql.ref(isDefault)} and not new.${sql.ref(isDefault)} then
        raise exception 'VALIDATION: cannot unset the tenant default document theme; choose another theme as default.';
      end if;
      if new.${sql.ref(isDefault)} then
        perform set_config('app.document_theme_switching', '1', true);
        update ${themes} other
          set ${sql.ref(isDefault)} = false
          where other.tenant_id = new.tenant_id
            and other.id is distinct from new.id
            and other.${sql.ref(isDefault)};
        perform set_config('app.document_theme_switching', '', true);
      elsif tg_op = 'INSERT' and not exists (
        select 1 from ${themes} other
        where other.tenant_id = new.tenant_id
          and other.id is distinct from new.id
          and other.${sql.ref(isDefault)}
      ) then
        new.${sql.ref(isDefault)} := true;
      end if;
      return new;
    end;
    $function$;

    drop trigger if exists document_themes_default_guard on ${themes};
    create trigger document_themes_default_guard
      before insert or update on ${themes}
      for each row execute function app.enforce_document_theme_default();

    create or replace function app.promote_document_theme_default()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if old.${sql.ref(isDefault)} then
        update ${themes} other
          set ${sql.ref(isDefault)} = true
          where other.id = (
            select candidate.id from ${themes} candidate
            where candidate.tenant_id = old.tenant_id
            order by candidate.created_at, candidate.id
            limit 1
          );
      end if;
      return old;
    end;
    $function$;

    drop trigger if exists document_themes_default_promote on ${themes};
    create trigger document_themes_default_promote
      after delete on ${themes}
      for each row execute function app.promote_document_theme_default();

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
