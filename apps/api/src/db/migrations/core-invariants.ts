// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { applyArtifactBinding } from "./core-invariants-artifacts.js";
import { applyDocumentAuthority, applyDocumentCommands } from "./core-invariants-documents.js";
import { applyDocumentThemeInvariants } from "./document-themes.js";

/**
 * The core's own database invariants on manifest tables: functions,
 * triggers, foreign keys wider than a tenant pair and partial indexes the
 * manifest cannot express. Applied after the generated step on every migrate, idempotently —
 * `create or replace`, `if not exists`, and a pg_constraint guard for each
 * constraint — with no ledger and no version. A database is built from the
 * manifest plus this file; there is no history to replay.
 *
 * Four blocks, each guarding one authored entity's contract. Block 1 lives
 * here; blocks 2 and 3 in core-invariants-documents.ts and block 4 in
 * core-invariants-artifacts.ts, applied in that order below. Tables and
 * authored columns are looked up in the generated manifest by entity and
 * field key (db/manifest-lookup.ts); no block names a physical name itself.
 *
 *   1. ORG-UNIT CLOSURE. platform.org_unit_closure is the transitive closure
 *      of platform.org_unit that group-predicated RLS resolves a session's
 *      groups through. The trigger keeps it exact on every insert, reparent
 *      and delete, refuses a parent from another tenant a second time (the
 *      generated (tenant_id, parent_id) key already makes one unexpressible;
 *      the trigger names the case rather than leaving a phantom root should
 *      the key ever be relaxed) and refuses a reparent into the node's own
 *      subtree (a cycle would otherwise surface as an opaque unique-key
 *      violation). SECURITY DEFINER so the closure DML is not
 *      blocked by RLS on the closure table; tenant_id always comes from
 *      NEW/OLD, never from the session.
 *
 *   2. DOCUMENT AUTHORITY. Document is the stable container and
 *      DocumentVersion the sole artifact truth. The current-version pointer
 *      is a three-column key (tenant, document, version) that the generated
 *      (tenant_id, current_version_id) pair under the same name cannot say —
 *      a document may only point at one of its own versions; a
 *      Document's type is a managed DocumentType of the same tenant; and the
 *      runtime role cannot write a DocumentVersion directly, create a
 *      Document without its first version, or move the current-version
 *      pointer — a trigger denies it even if a later broad grant restores
 *      the DML privilege.
 *
 *   3. LOGICAL DOCUMENT COMMANDS. document_internal.create_with_first_version
 *      and append_version are the only write path, SECURITY DEFINER, taking
 *      tenant and actor from the authenticated session. They are not an
 *      HTTP authorization boundary and deliberately do not repeat authored
 *      roles, statuses or field limits: the canonical Operation runtime has
 *      already authenticated, authorized and schema-validated the request.
 *      The separate schema is load-bearing — the worker role receives broad
 *      EXECUTE on app.*, so document_internal is granted to the API's
 *      restricted role only. Binary artifact metadata is storage-owned and
 *      cannot enter through either command.
 *
 *   4. ARTIFACT BINDING. The artifact id and expected version are only a
 *      provisional association in the creating transaction; a deferred
 *      constraint trigger makes that transaction uncommittable until the
 *      trusted descriptor returned by artifact storage has finalized the
 *      row. Provider object keys never enter the Document schema.
 */
export async function applyCoreInvariants(db: OpenShapeForgeDatabase): Promise<void> {
  await applyOrgUnitClosure(db);
  await applyDocumentAuthority(db);
  await applyDocumentCommands(db);
  await applyArtifactBinding(db);
  await applyDocumentThemeInvariants(db);
}


async function applyOrgUnitClosure(db: OpenShapeForgeDatabase): Promise<void> {
  // INSERT: self-row (NEW.id, NEW.id, 0) + copy parent's ancestor paths +1.
  // UPDATE of parent_id: standard closure reparent — delete edges that link
  //   the moved subtree to its OLD ancestors (crossing the moved node), then
  //   reinsert the cross-product of the NEW parent's ancestor paths × the
  //   moved subtree. Assert the tenant never changes.
  // DELETE: remove every closure edge that touches the deleted node. The
  //   parent_id FK (ON DELETE RESTRICT) blocks deleting a unit that still has
  //   children, so a deleted node is always a leaf w.r.t. org_unit rows.
  await sql`
    create or replace function platform.org_unit_closure_maintain()
    returns trigger
    language plpgsql
    security definer
    set search_path = platform, pg_temp
    as $fn$
    begin
      if tg_op = 'INSERT' then
        -- A non-null parent must reference a same-tenant org_unit. Its
        -- closure self-row (parent_id, parent_id, 0) exists iff such a row
        -- exists in this tenant; its absence means the FK was satisfied by a
        -- foreign-tenant (or otherwise unreachable) id. Fail loudly rather
        -- than silently writing a phantom root.
        if new.parent_id is not null and not exists (
          select 1 from platform.org_unit_closure c
          where c.tenant_id = new.tenant_id
            and c.ancestor_id = new.parent_id
            and c.descendant_id = new.parent_id
            and c.depth = 0
        ) then
          raise exception
            'org_unit.parent_id % is not a valid parent in tenant % (cross-tenant or nonexistent parent)',
            new.parent_id, new.tenant_id;
        end if;
        -- Self-row at depth 0.
        insert into platform.org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
        values (new.tenant_id, new.id, new.id, 0);
        -- Inherit the parent's ancestors, one level deeper.
        if new.parent_id is not null then
          insert into platform.org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
          select c.tenant_id, c.ancestor_id, new.id, c.depth + 1
          from platform.org_unit_closure c
          where c.tenant_id = new.tenant_id
            and c.descendant_id = new.parent_id;
        end if;
        return new;

      elsif tg_op = 'UPDATE' then
        if new.tenant_id <> old.tenant_id then
          raise exception 'org_unit.tenant_id is immutable (% -> %)', old.tenant_id, new.tenant_id;
        end if;
        if new.parent_id is distinct from old.parent_id then
          -- Same same-tenant-parent guard as on INSERT: a reparent onto a
          -- cross-tenant or nonexistent parent must abort, not silently
          -- detach the subtree into a phantom root.
          if new.parent_id is not null and not exists (
            select 1 from platform.org_unit_closure c
            where c.tenant_id = new.tenant_id
              and c.ancestor_id = new.parent_id
              and c.descendant_id = new.parent_id
              and c.depth = 0
          ) then
            raise exception
              'org_unit.parent_id % is not a valid parent in tenant % (cross-tenant or nonexistent parent)',
              new.parent_id, new.tenant_id;
          end if;
          -- Reparent cycle guard: the new parent must not lie within the
          -- moved subtree. If new.parent_id is a descendant of new.id, the
          -- move would make the node its own ancestor. Fail loudly rather
          -- than aborting later with an opaque unique-constraint violation.
          if new.parent_id is not null and exists (
            select 1 from platform.org_unit_closure c
            where c.tenant_id = new.tenant_id
              and c.ancestor_id = new.id
              and c.descendant_id = new.parent_id
          ) then
            raise exception
              'org_unit reparent would create a cycle: parent % is within the subtree of %',
              new.parent_id, new.id;
          end if;
          -- The subtree rooted at the moved node (its self + all descendants).
          -- Delete edges linking that subtree to any ancestor OUTSIDE the
          -- subtree (i.e. the old cross-boundary paths).
          delete from platform.org_unit_closure
          where tenant_id = new.tenant_id
            and descendant_id in (
              select descendant_id from platform.org_unit_closure
              where tenant_id = new.tenant_id and ancestor_id = new.id
            )
            and ancestor_id not in (
              select descendant_id from platform.org_unit_closure
              where tenant_id = new.tenant_id and ancestor_id = new.id
            );
          -- Reinsert the cross-product: NEW parent's ancestor paths ×
          -- the moved subtree, summing depths across the new join point.
          if new.parent_id is not null then
            insert into platform.org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
            select super.tenant_id, super.ancestor_id, sub.descendant_id, super.depth + sub.depth + 1
            from platform.org_unit_closure super
            cross join platform.org_unit_closure sub
            where super.tenant_id = new.tenant_id
              and super.descendant_id = new.parent_id
              and sub.tenant_id = new.tenant_id
              and sub.ancestor_id = new.id;
          end if;
        end if;
        return new;

      elsif tg_op = 'DELETE' then
        -- Tear down every edge that references the deleted node. The FK
        -- RESTRICT guarantees it has no child org_unit rows.
        delete from platform.org_unit_closure
        where tenant_id = old.tenant_id
          and (ancestor_id = old.id or descendant_id = old.id);
        return old;
      end if;
      return null;
    end;
    $fn$;

    -- Row-level, after the write so NEW.id exists.
    drop trigger if exists org_unit_closure_maintain_trg on platform.org_unit;
    create trigger org_unit_closure_maintain_trg
      after insert or update or delete on platform.org_unit
      for each row execute function platform.org_unit_closure_maintain();
  `.execute(db);
}
