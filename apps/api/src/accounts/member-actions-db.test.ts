import { IDENTITY_LINK_ADMIN_ROLE } from '../auth/organization-roles.js';
// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createDatabaseRuntime } from '../db/connection.js';
import { getMember, listMembers } from './member-directory.js';
import { inviteMember, listMemberAudit, requestMemberPasswordReset, requestMemberPasskeyRecovery,
  resendMemberInvitation, revokeMemberInvitation } from './member-actions.js';
import { listInvitationRelations } from './invitation-relations.js';
import { blockOrganizationAccount } from './account-management.js';

const url=process.env.HUBBLE_ACCESS_TEST_DATABASE_URL;
if(!url || !new URL(url).pathname.startsWith('/hubble_sandbox_'))
  throw new Error('HUBBLE_ACCESS_TEST_DATABASE_URL must name an isolated hubble_sandbox_ database.');

test('member directory and recovery isolate tenants and address only the registered identity',async()=>{
  const admin=new SQL(url!,{max:1});
  const appUrl=new URL(url!);appUrl.username=appUrl.password='openshapeforge_app';
  const runtime=createDatabaseRuntime({databaseUrl:appUrl.toString(),maxConnections:2});
  const tenant=crypto.randomUUID(),other=crypto.randomUUID(),actor=crypto.randomUUID();
  const target=crypto.randomUUID(),foreign=crypto.randomUUID(),external=crypto.randomUUID(),pending=crypto.randomUUID();
  const relation=crypto.randomUUID(),subject=crypto.randomUUID();
  const issuer=process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER ?? 'https://identity.example.test/realms/openshapeforge';
  const realm=new URL(issuer).pathname.split('/').at(-1)!,email='member@example.test';
  const sent:{kind:string;id:string}[]=[],lookups:{organization:string;id:string}[]=[];
  let providerEmail=email;
  const client:any={
    getMember:async(organization:string,id:string)=>{
      lookups.push({organization,id});
      return {memberId:subject,email:providerEmail,enabled:true};
    },
    listCredentials:async()=>[{credentialId:'public-id',type:'webauthn-passwordless',label:'Device'}],
    sendPasswordRecovery:async(id:string)=>{sent.push({kind:'password',id});},
    sendPasskeyRecovery:async(id:string)=>{sent.push({kind:'passkey',id});},
    findPendingInvitationByEmail:async()=>({id:'remote-invitation'}),
    resendInvitation:async(organization:string,id:string)=>{sent.push({kind:'resend:'+organization,id});},
  };
  const session:any={tenantId:tenant,userId:actor,issuer,roles:[IDENTITY_LINK_ADMIN_ROLE,'Organization.Access.Manage'],groups:[],scope:'tenant',credential:'bearer'};
  const context:any={session,db:runtime.db,control:{clients:{identityMembers:client},config:{ok:true,config:{keycloak:{baseUrl:new URL(issuer).origin,tenantRealm:realm}}}}};
  try{
    for(const id of [tenant,other])await admin`insert into platform.tenants(id,slug,name,status,keycloak_organization_id,keycloak_realm)
      values(${id},${'member-actions-'+id},'Member test','active',${'org-'+id},${realm})`;
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status)
      values(${relation},${tenant},'Synthetic member','person','active')`;
    for(const row of [{id:target,tenant,issuer,subject,email,relation},{id:foreign,tenant:other,issuer,subject:foreign,email:'foreign@example.test',relation:null},
      {id:external,tenant,issuer:'https://foreign.example.test/realms/demo',subject:external,email:'external@example.test',relation:null}]){
      await admin`insert into platform.identities(id,issuer,subject,email,display_name)
        values(${row.id},${row.issuer},${row.subject},${row.email},'Synthetic member')`;
      await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,linked_at,linked_by)
        values(${row.id},${row.tenant},${row.relation},${row.relation?'linked':'pending_confirmation'},${row.relation?new Date():null},${row.relation?'test':null})`;
    }
    await admin`insert into platform.employee_invitations(id,tenant_id,email,role,first_name,last_name,invited_by)
      values(${pending},${tenant},'pending@example.test','org_employee','Pending','Member',${actor})`;
    const outsider={...context,session:{...session,roles:[]}};
    expect(await listInvitationRelations({},outsider)).toMatchObject({status:403});
    const choices:any=await listInvitationRelations({},context);
    expect(choices.value.relations).toEqual([{id:relation,label:'Synthetic member'}]);
    const unlinked=crypto.randomUUID();
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status)
      values(${unlinked},${tenant},'Existing invite target','person','active')`;
    await admin`insert into erp.contact_details(id,tenant_id,relation_id,type,value,status)
      values(${crypto.randomUUID()},${tenant},${unlinked},'email','invite-target@example.test','active')`;
    expect(await inviteMember({email:' invite-target@example.test ',firstName:'Target',lastName:'Person',role:'org_employee'},context))
      .toMatchObject({status:409,code:'CONFLICT'});
    expect(sent).toEqual([]);

    expect(await listMembers({},outsider)).toMatchObject({status:403});
    expect(await requestMemberPasswordReset({id:target,confirmed:true},outsider)).toMatchObject({status:403});
    const result:any=await listMembers({},context);
    expect(result.value.members.map((r:any)=>r.id).sort()).toEqual([target,external,pending].sort());
    expect(result.value.members.find((r:any)=>r.id===pending)).toMatchObject({status:'invited',relationId:null,email:'pending@example.test'});
    expect(await getMember({id:foreign},context)).toMatchObject({status:404});
    expect(await requestMemberPasswordReset({id:foreign,confirmed:true},context)).toMatchObject({status:404});
    expect(await requestMemberPasswordReset({id:pending,confirmed:true},context)).toMatchObject({status:404});
    expect(await requestMemberPasswordReset({id:external,confirmed:true},context)).toMatchObject({code:'EXTERNAL_IDENTITY'});
    expect(sent).toEqual([]);expect(lookups).toEqual([]);
    providerEmail='changed@example.test';
    expect(await requestMemberPasswordReset({id:target,confirmed:true},context)).toMatchObject({code:'MEMBER_UNAVAILABLE'});
    expect(sent).toEqual([]);providerEmail=email;
    expect(await requestMemberPasswordReset({id:target,confirmed:true},context)).toMatchObject({value:{updated:true}});
    expect(await requestMemberPasskeyRecovery({id:target,confirmed:true},context)).toMatchObject({value:{updated:true}});
    expect(sent).toEqual([{kind:'password',id:subject},{kind:'passkey',id:subject}]);
    expect(lookups.every(row=>row.organization==='org-'+tenant && row.id===subject)).toBe(true);
    expect(await getMember({id:target},context)).toMatchObject({value:{id:target,email,credentialTypes:'webauthn-passwordless'}});
    expect(await inviteMember({email,firstName:'Existing',lastName:'Member'},context)).toMatchObject({code:'ALREADY_MEMBER'});
    expect(await resendMemberInvitation({id:target,confirmed:true},context)).toMatchObject({status:404});
    expect(await revokeMemberInvitation({id:target,confirmed:true},context)).toMatchObject({status:404});
    expect(await resendMemberInvitation({id:pending,confirmed:true},context)).toMatchObject({value:{updated:true}});
    expect(sent.at(-1)).toEqual({kind:'resend:org-'+tenant,id:'remote-invitation'});
    const actorIdentity = crypto.randomUUID(), actorRelation = crypto.randomUUID();
    await admin`select set_config('app.roles',${[IDENTITY_LINK_ADMIN_ROLE,'Organization.Access.Manage'].join(',')},false)`;
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status)
      values(${actorRelation},${tenant},'Administrator','person','active')`;
    await admin`insert into platform.identities(id,issuer,subject,display_name)
      values(${actorIdentity},${issuer},${actor},'Administrator')`;
    await admin`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,roles,linked_at,linked_by)
      values(${actorIdentity},${tenant},${actorRelation},'linked',ARRAY[${IDENTITY_LINK_ADMIN_ROLE},'Organization.Access.Manage'],now(),'test')`;
    session.roles.push('Organization.Accounts.Manage');
    await admin`update platform.identity_relations set roles=ARRAY[${IDENTITY_LINK_ADMIN_ROLE},'Organization.Access.Manage','Organization.Accounts.Manage']
      where identity_id=${actorIdentity} and tenant_id=${tenant}`;
    const revision = (await admin`select md5(extract(epoch from updated_at)::text || ':' || status || ':' || access_blocked::text || ':' || array_to_string(roles, ',')) as revision
      from platform.identity_relations where identity_id=${target} and tenant_id=${tenant}`)[0].revision;
    expect(await blockOrganizationAccount({id:target,revision},context)).toMatchObject({value:{updated:true}});
    const audit:any=await listMemberAudit({id:target},context);
    expect(audit.value.events.map((e:any)=>e.action).sort()).toEqual(['block','member.passkeyRecoverySent','member.passwordRecoverySent']);
    expect(await listMemberAudit({id:foreign},context)).toMatchObject({status:404});
    const foreignRelation=crypto.randomUUID();
    await admin`insert into erp.relations(id,tenant_id,display_name,relation_type,status)
      values(${foreignRelation},${other},'Other tenant person','person','active')`;
    const ownChoices:any=await listInvitationRelations({},context);
    expect(ownChoices.value.relations.some((r:any)=>r.id===foreignRelation)).toBe(false);
    client.hasMemberByEmail=async()=>false;
    client.inviteUser=async(organization:string,input:any)=>{sent.push({kind:'invite:'+organization,id:input.email});};
    const before=sent.length;
    expect(await inviteMember({email:'cross-tenant@example.test',firstName:'Cross',lastName:'Tenant',role:'org_employee',relationId:foreignRelation},context))
      .toMatchObject({status:404,code:'NOT_FOUND'});
    expect(sent).toHaveLength(before);
    const invited:any=await inviteMember({email:'invite-target@example.test',firstName:'Target',lastName:'Person',role:'org_employee',relationId:unlinked},context);
    expect(invited).toMatchObject({value:{status:'pending',delivery:'sent'}});
    expect((await admin`select relation_id from platform.employee_invitations where id=${invited.value.id}`)[0].relation_id).toBe(unlinked);
    expect(sent).toHaveLength(before+1);

  }finally{await runtime.close();await admin.close();}
},30_000);
