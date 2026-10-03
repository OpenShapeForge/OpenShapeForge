import { sql } from 'kysely';
import { withDbSession } from '../db/session.js';
import { HttpError } from '../rest/http-error.js';
import { inviteEmployee, revokeInvitation } from '../auth/employee-invitations.js';
import { relationsWithEmail } from '../auth/identity-link-store.js';
import { accessSession } from './custom-roles.js';
import { memberId, directory } from './member-directory.js';
import { memberGuard, provider, providerMember, memberAudit } from './member-provider.js';
import type { ModuleOperationContext, ModuleOperationHandler } from '../modules/contract.js';

export const inviteMember=memberGuard(async(input,c)=>{
  const p=await provider(c);
  if(typeof input.email!=='string')throw new HttpError(400,'VALIDATION','Enter an email address.');
  if(input.role !== undefined && (typeof input.role !== 'string' || !input.role.trim()))
    throw new HttpError(400,'VALIDATION','Choose a role from this organization.');
  for(const field of ['firstName','lastName'])if(typeof input[field]!=='string' || !(input[field] as string).trim() || (input[field] as string).length>120)
    throw new HttpError(400,'VALIDATION','Enter a name of 1 to 120 characters.');
  // Adding a member is not a role-edit operation for an already linked account.
  const existing=(await directory(c)).find(row=>!['invited','revoked'].includes(row.status) && row.email.toLowerCase()===String(input.email).trim().toLowerCase());
  if(existing)throw new HttpError(409,'ALREADY_MEMBER','This account is already a member. Open that member to manage access.');
  const relationId=input.relationId===undefined?undefined:memberId(input.relationId);
  if(!relationId){
    const matches=await withDbSession(c.db!,p.s,trx=>relationsWithEmail(trx,p.s.tenantId,(input.email as string).trim()));
    if(matches.length)throw new HttpError(409,'CONFLICT','This email belongs to an existing relation. Select the invitation relation explicitly.');
  }
  const invitation=await inviteEmployee(c.db!,p.s,p.client,{email:input.email,firstName:input.firstName as string|undefined,
    lastName:input.lastName as string|undefined,role:input.role === undefined ? 'org_employee' : input.role as string,...(relationId?{relationId}:{})});
  await memberAudit(c,invitation.id,'member.invited');
  return {value:{id:invitation.id,email:invitation.email,status:invitation.status,delivery:invitation.delivery}};
});

function recovery(kind:'password'|'passkey'):ModuleOperationHandler{return memberGuard(async(input,c)=>{
  const p=await providerMember(c,input.id);
  if(kind==='password') {
    if(!p.client.sendPasswordRecovery)throw new HttpError(503,'OPERATION_UNAVAILABLE','Password recovery is not configured.');
    await p.client.sendPasswordRecovery(p.member.memberId);
  } else await p.client.sendPasskeyRecovery(p.member.memberId);
  await memberAudit(c,p.id,`member.${kind}RecoverySent`);
  return {value:{updated:true,message:'Recovery instructions were sent to the account email address and expire after 15 minutes.'}};
});}
export const requestMemberPasswordReset=recovery('password');
export const requestMemberPasskeyRecovery=recovery('passkey');

async function pendingInvitation(c:ModuleOperationContext,value:unknown) {
  const id=memberId(value),p=await provider(c);
  const row=await withDbSession(c.db!,p.s,async tx=>(await sql<{email:string}>`
    select email from platform.employee_invitations where tenant_id=${p.s.tenantId}::uuid and id=${id}::uuid and status='pending'`.execute(tx)).rows[0]);
  if(!row)throw new HttpError(404,'NOT_FOUND','Pending invitation not found in this organization.');
  return {...p,id,email:row.email};
}
export const revokeMemberInvitation=memberGuard(async(input,c)=>{
  const p=await pendingInvitation(c,input.id);
  await revokeInvitation(c.db!,p.s,p.client,{email:p.email});
  await memberAudit(c,p.id,'member.invitationRevoked');
  return {value:{updated:true,message:'The invitation was withdrawn.'}};
});
export const resendMemberInvitation=memberGuard(async(input,c)=>{
  const p=await pendingInvitation(c,input.id);
  const remote=await p.client.findPendingInvitationByEmail(p.organizationId,p.email);
  if(!remote)throw new HttpError(409,'NO_PENDING_EMAIL','There is no outstanding invitation email. This account may already exist; ask the member to sign in.');
  if(!p.client.resendInvitation)throw new HttpError(503,'OPERATION_UNAVAILABLE','Invitation resend is unavailable.');
  await p.client.resendInvitation(p.organizationId,remote.id);
  await memberAudit(c,p.id,'member.invitationResent');
  return {value:{updated:true,message:'The invitation email was sent again.'}};
});
export const listMemberAudit=memberGuard(async(input,c)=>{
  const s=accessSession(c),id=memberId(input.id);
  const member=(await directory(c)).find(row=>row.id===id);
  if(!member)throw new HttpError(404,'NOT_FOUND','Member not found in this organization.');
  const rows=await withDbSession(c.db!,s,async tx=>(await sql<{id:string;occurredAt:Date;action:string;actor:string;details:string}>`
    select id,occurred_at as "occurredAt",coalesce(payload->>'action',event_type) as action,
      coalesce(payload->>'actor','') as actor,
      coalesce(payload->>'role',payload->>'permission','') as details
    from platform.entity_events where tenant_id=${s.tenantId}::uuid and
      ((aggregate_type='Account' and aggregate_id=${id}) or
       (aggregate_type='UserAccount' and (aggregate_id=${id} or aggregate_id in (
        select p.id::text from platform.employee_invitations p where p.tenant_id=${s.tenantId}::uuid
          and lower(p.email)=lower(${member.email})))) or
       (aggregate_type='RelationGroup' and payload->>'relationId'=${member.relationId}))
    order by occurred_at desc,id desc limit 100`.execute(tx)).rows);
  return {value:{events:rows.map(row=>({...row,occurredAt:row.occurredAt.toISOString()}))}};
});
