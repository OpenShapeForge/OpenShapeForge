// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../connection.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../../auth/organization-roles.js';
import { ACCOUNT_MANAGE } from '../../accounts/account-session.js';

export async function applyMemberAccessStateMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create or replace function app.member_access_state_guard() returns trigger
    language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        if old.access_blocked and not (app.bypass_rls() or ${sql.lit(ACCOUNT_MANAGE)} = any(string_to_array(coalesce(current_setting('app.roles', true), ''), ',')) or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any(
          string_to_array(coalesce(current_setting('app.roles', true), ''), ','))) then
          raise exception 'Organization administrator required to remove blocked membership' using errcode = '42501';
        end if;
        return old;
      end if;
      if (tg_op = 'INSERT' and new.access_blocked) or
         (tg_op = 'UPDATE' and (new.access_blocked is distinct from old.access_blocked or
          (old.access_blocked and (new.identity_id is distinct from old.identity_id or new.tenant_id is distinct from old.tenant_id)))) then
        if not (app.bypass_rls() or ${sql.lit(ACCOUNT_MANAGE)} = any(string_to_array(coalesce(current_setting('app.roles', true), ''), ',')) or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any(
          string_to_array(coalesce(current_setting('app.roles', true), ''), ','))) then
          raise exception 'Organization administrator required to change member access'
            using errcode = '42501';
        end if;
      end if;
      return new;
    end $$;
    drop trigger if exists member_access_state_guard on platform.identity_relations;
    create trigger member_access_state_guard before insert or update or delete on platform.identity_relations
      for each row execute function app.member_access_state_guard();
  `.execute(db);
}
