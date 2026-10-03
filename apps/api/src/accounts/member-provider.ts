// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import { withDbSession } from '../db/session.js';
import { HttpError } from '../rest/http-error.js';
import { KeycloakAdminError } from '../control/keycloak-organization-admin.js';
import { appendScopedEntityEventInTransaction } from '../platform/entity-events.js';
import { accessSession, guarded } from './custom-roles.js';
import { memberId } from './member-directory.js';
import { accountSession } from './account-session.js';
import type { ModuleOperationContext, ModuleOperationHandler } from '../modules/contract.js';

export function memberGuard(handler: ModuleOperationHandler): ModuleOperationHandler {
  return guarded(async(input,c)=>{
    try{return await handler(input,c);}catch(error){
      if(error instanceof KeycloakAdminError || (error instanceof HttpError && error.code.startsWith('KEYCLOAK_ADMIN_')))
        throw new HttpError(503,'IDENTITY_PROVIDER_UNAVAILABLE','The identity provider could not complete this action. Check its status before retrying.');
      throw error;
    }
  });
}
export async function provider(c: ModuleOperationContext, intent: 'read' | 'manage' = 'manage') {
  const s=intent === 'read' ? accountSession(c) : accessSession(c), client=c.control?.clients?.identityMembers;
  if(!client)throw new HttpError(503,'OPERATION_UNAVAILABLE','Account administration is not configured.');
  const tenant=await withDbSession(c.db!,s,async tx=>(await sql<{organizationId:string|null}>`
    select keycloak_organization_id as "organizationId" from platform.tenants where id=${s.tenantId}::uuid`.execute(tx)).rows[0]);
  if(!tenant?.organizationId)throw new HttpError(503,'OPERATION_UNAVAILABLE','This organization has no identity provider membership.');
  return {s,client,organizationId:tenant.organizationId};
}
export async function providerMember(c: ModuleOperationContext, value:unknown, intent: 'read' | 'manage' = 'manage') {
  const id=memberId(value), p=await provider(c, intent);
  const identity=await withDbSession(c.db!,p.s,async tx=>(await sql<{subject:string;issuer:string;email:string|null}>`
    select i.subject,i.issuer,i.email from platform.identity_relations ir join platform.identities i on i.id=ir.identity_id
    where ir.tenant_id=${p.s.tenantId}::uuid and ir.identity_id=${id}::uuid`.execute(tx)).rows[0]);
  if(!identity)throw new HttpError(404,'NOT_FOUND','Account not found in this organization.');
  const config=c.control?.config;
  if(!config?.ok)throw new HttpError(503,'OPERATION_UNAVAILABLE','Identity provider configuration is unavailable.');
  const kc=config.config.keycloak;
  // The admin client may use a private backchannel; identities carry the verified public issuer.
  const issuer=(process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER ?? `${kc.baseUrl.replace(/\/$/,'')}/realms/${kc.tenantRealm}`).replace(/\/$/,'');
  if(identity.issuer.replace(/\/$/,'')!==issuer)throw new HttpError(409,'EXTERNAL_IDENTITY','Manage this account at its own identity provider.');
  const member=await p.client.getMember(p.organizationId,identity.subject);
  if(!member || !member.enabled || !member.email || member.email.toLowerCase()!==identity.email?.toLowerCase())
    throw new HttpError(409,'MEMBER_UNAVAILABLE','The account is not an enabled member with a matching email address.');
  return {...p,id,member};
}
export async function memberAudit(c:ModuleOperationContext,id:string,action:string) {
  const s=accessSession(c);
  await withDbSession(c.db!,s,tx=>appendScopedEntityEventInTransaction(tx,{aggregateType:'UserAccount',aggregateId:id,eventType:'updated',payload:{action,actor:s.userId}}));
}
