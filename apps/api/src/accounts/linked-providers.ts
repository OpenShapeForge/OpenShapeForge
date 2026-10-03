// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import { withDbSession } from '../db/session.js';
import { IDENTITY_CONTRACT } from '../auth/identity-contract.js';
import { HttpError } from '../rest/http-error.js';
import { KeycloakAdminError } from '../control/keycloak-organization-admin.js';
import type { ModuleOperationContext } from '../modules/contract.js';
import { accountSession } from './account-session.js';
import { providerMember } from './member-provider.js';

type PublicProvider = NonNullable<typeof IDENTITY_CONTRACT.publicProviders>[number];
export function projectLinkedProviders(aliases: readonly { alias: string }[], definitions: readonly PublicProvider[], realm: string, organizationAlias: string) {
  const configured = definitions.filter(item => item.organizationAlias === organizationAlias);
  const allowed = configured.filter(item => item.realm === realm);
  const linked = [...new Set(aliases.map(item => item.alias))];
  const providers = linked.flatMap(alias => {
    const definition = allowed.find(item => item.alias === alias);
    return definition ? [{ key: definition.alias, label: definition.label, type: definition.type }] : [];
  });
  return { providers, state: linked.length > 0 && configured.length === 0 ? 'not_configured'
    : providers.length === linked.length ? 'available' : 'unsupported' };
}

/** Provider failures never erase the independently readable local Account. */
export async function linkedProviders(context: ModuleOperationContext, id: string) {
  const session = accountSession(context);
  const checkedAt = new Date().toISOString();
  try {
    const p = await providerMember(context, id, 'read');
    if (!p.client.listFederatedIdentities) return { providers: null, providerState: 'unsupported', providersCheckedAt: checkedAt };
    const tenant = await withDbSession(context.db!, session, async tx =>
      (await sql<{ slug: string }>`select slug from platform.tenants where id=${session.tenantId}::uuid`.execute(tx)).rows[0]);
    if (!tenant) throw new HttpError(404, 'NOT_FOUND', 'Organization not found.');
    const aliases = await p.client.listFederatedIdentities(p.organizationId, p.member.memberId);
    const projection = projectLinkedProviders(aliases, IDENTITY_CONTRACT.publicProviders ?? [], context.control!.config!.ok
      ? context.control!.config!.config.keycloak.tenantRealm : '', tenant.slug);
    return { providers: projection.providers, providerState: projection.state, providersCheckedAt: checkedAt };
  } catch (error) {
    if (error instanceof KeycloakAdminError || (error instanceof HttpError && [404, 409, 503].includes(error.status))) {
      const state = error instanceof HttpError && error.code === 'EXTERNAL_IDENTITY' ? 'external_identity'
        : error instanceof HttpError && error.code === 'MEMBER_UNAVAILABLE' ? 'unsupported' : 'unavailable';
      return { providers: null, providerState: state, providersCheckedAt: checkedAt };
    }
    throw error; // Never hide failed Account permission checks or unexpected bugs.
  }
}
