// SPDX-License-Identifier: BUSL-1.1

import { sql } from "../../apps/api/src/db/sql-helpers.js";
import type {
  ModuleOperationHandler,
  ModuleOperationSuccessResult,
  RuntimeModule,
} from "../../apps/api/src/modules/contract.js";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
});

type SessionOperationContext = Parameters<ModuleOperationHandler>[1];
type AvatarHandle = { artifactId: string; documentVersionId: string };
type SidebarIdentity = { name: string; description?: string; avatar?: AvatarHandle };
export type SessionProfile = { user: SidebarIdentity; organisation: SidebarIdentity };
export type SessionProfileResolver = (
  context: SessionOperationContext,
  tenantId: string,
  userId: string,
) => Promise<SessionProfile | undefined>;

function success(value: unknown): ModuleOperationSuccessResult {
  return { value, status: 200, headers: SECURITY_HEADERS };
}

function avatar(artifactId: string | null, documentVersionId: string | null): AvatarHandle | undefined {
  return artifactId && documentVersionId ? { artifactId, documentVersionId } : undefined;
}

/**
 * Resolve presentation-neutral identity data from the verified OSF session.
 * Avatar bytes stay behind the authenticated artifact transport; this contract
 * only returns the immutable handle the host needs to load them.
 */
async function resolveSessionProfile(
  context: SessionOperationContext,
  tenantId: string,
  userId: string,
): Promise<SessionProfile | undefined> {
  if (!context.platform || !context.session) return undefined;
  const profile = await context.platform.db.withSession(context.session, async (transaction) => sql<{
    tenant_name: string;
    user_name: string | null;
    user_email: string | null;
    user_artifact_id: string | null;
    user_document_version_id: string | null;
    organisation_artifact_id: string | null;
    organisation_document_version_id: string | null;
  }>`
    select tenant.name as tenant_name,
      coalesce(person.display_name, identity.display_name) as user_name,
      identity.email as user_email,
      user_version.artifact_id as user_artifact_id,
      user_version.id as user_document_version_id,
      organisation_version.artifact_id as organisation_artifact_id,
      organisation_version.id as organisation_document_version_id
    from platform.tenants tenant
    join platform.identities identity on identity.subject = ${userId}
    left join platform.identity_relations identity_relation
      on identity_relation.identity_id = identity.id
      and identity_relation.tenant_id = tenant.id
      and identity_relation.status = 'linked'
    left join erp.relations person
      on person.id = identity_relation.relation_id and person.tenant_id = tenant.id
    left join lateral (
      select version.id, version.artifact_id
      from erp.documents document
      join erp.document_versions version
        on version.id = document.current_version_id and version.tenant_id = tenant.id
      where document.tenant_id = tenant.id
        and document.relation_id = person.id
        and document.document_type = 'avatar'
        and document.status = 'published'
        and version.status = 'final'
        and version.artifact_id is not null
      order by document.updated_at desc, document.id
      limit 1
    ) user_version on true
    left join lateral (
      select version.id, version.artifact_id
      from erp.documents document
      join erp.document_versions version
        on version.id = document.current_version_id and version.tenant_id = tenant.id
      where document.tenant_id = tenant.id
        and document.relation_id = tenant.relation_id
        and document.document_type = 'avatar'
        and document.status = 'published'
        and version.status = 'final'
        and version.artifact_id is not null
      order by document.updated_at desc, document.id
      limit 1
    ) organisation_version on true
    where tenant.id = ${tenantId}::uuid
    limit 1
  `.execute(transaction));
  const row = profile.rows[0];
  if (!row) return undefined;
  const userAvatar = avatar(row.user_artifact_id, row.user_document_version_id);
  const organisationAvatar = avatar(
    row.organisation_artifact_id,
    row.organisation_document_version_id,
  );
  return {
    user: {
      name: row.user_name?.trim() || row.user_email?.trim() || "Gebruiker",
      ...(row.user_email ? { description: row.user_email } : {}),
      ...(userAvatar ? { avatar: userAvatar } : {}),
    },
    organisation: {
      name: row.tenant_name,
      ...(organisationAvatar ? { avatar: organisationAvatar } : {}),
    },
  };
}

export function createSessionOperationHandlers(
  profileResolver: SessionProfileResolver = resolveSessionProfile,
): Record<string, ModuleOperationHandler> {
  return {
    getSession: async (_input, context) => {
      const tenantId = context.session?.tenantId;
      const userId = context.session?.userId;
      if (!tenantId || !userId) {
        return {
          ok: false,
          status: 401,
          code: "UNAUTHENTICATED",
          body: { error: "unauthorized" },
          headers: SECURITY_HEADERS,
        };
      }
      const profile = await profileResolver(context, tenantId, userId);
      if (!profile) {
        return {
          ok: false,
          status: 503,
          code: "AUTHENTICATION_UNAVAILABLE",
          body: { error: "authentication_unavailable" },
          headers: SECURITY_HEADERS,
        };
      }
      return success({
        tenantId,
        userId,
        roles: [...context.session!.roles],
        ...profile,
      });
    },
  };
}

export function createSessionRuntimeModule(): RuntimeModule {
  return {
    name: "session",
    operationHandlers: createSessionOperationHandlers(),
  };
}

export default createSessionRuntimeModule();
