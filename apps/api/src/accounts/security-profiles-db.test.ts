// SPDX-License-Identifier: BUSL-1.1
import { afterAll,beforeAll,expect,test } from 'bun:test';
import { sql } from 'kysely';
import { jsonbLiteral } from '../db/sql-helpers.js';
import { openScratch,closeScratch,privileged } from '../documents/__tests__/document-content-fixture.js';
import { isAuthorizationSafeConditionSatisfied } from '../generated/compiler/expression-evaluator.js';
import { authorizationProfilePredicate } from '../auth/authorization-profile-sql.js';
import type { CompilerConditionInput } from '../generated/compiler/canonical-condition.js';
beforeAll(openScratch,120_000);afterAll(closeScratch);
const rule=(operator:string,right:unknown)=>({kind:'rule',operator,left:{kind:'path',path:'resource.relationType'},right}) as CompilerConditionInput;
const literal=(value:unknown)=>({kind:'literal',value});
test('database predicates and canonical conditions agree for missing, mismatched and matching operands',async()=>{
 const conditions=[rule('equals',literal('customer')),rule('notEquals',literal('customer')),rule('in',literal(['customer','supplier'])),rule('notIn',literal(['customer'])),rule('contains',literal('cust')),rule('notContains',literal('cust')),rule('notEquals',{kind:'path',path:'actorRelation.userId'}),rule('equals',literal(1))];
 for(const relationType of [null,'customer','supplier'])for(const condition of conditions){
  const expected=isAuthorizationSafeConditionSatisfied(condition,{resource:{relationType},actorRelation:{userId:'customer'}});
  const result=await sql<{allowed:boolean}>`select app.authorization_condition_allows(${jsonbLiteral(condition)},${jsonbLiteral({relation_type:relationType})},${jsonbLiteral({userId:'customer'})},'{"relationType":{"column":"relation_type","type":"text"}}'::jsonb) as allowed`.execute(privileged());
  expect(result.rows[0]!.allowed).toBe(expected);
  const lowered=authorizationProfilePredicate({managed:true,grantable:true,fields:{relationType:{column:'relation_type',type:'text'}},rules:[condition]},{userId:'customer'},'resource_row');
  const indexed=await sql<{allowed:boolean}>`select coalesce((${lowered}),false) as allowed from (select ${relationType}::text as relation_type) resource_row`.execute(privileged());
  expect(indexed.rows[0]!.allowed).toBe(expected);

 }
 const group={kind:'group',mode:'any',conditions:[rule('equals',{kind:'path',path:'actorRelation.missing'}),rule('equals',literal('customer'))]};
 const result=await sql<{allowed:boolean}>`select app.authorization_condition_allows(${jsonbLiteral(group)},'{"relation_type":"customer"}'::jsonb,'{}'::jsonb,'{"relationType":{"column":"relation_type"}}'::jsonb) as allowed`.execute(privileged());
 expect(result.rows[0]!.allowed).toBe(true);
},60_000);

test('a tenant assignment stays inside the ceiling and a withdrawn profile stops granting',async()=>{
 const { randomUUID }=await import('node:crypto');
 const { editor,dbInput,restricted,platformFor,tenant,tableName }=await import('../documents/__tests__/document-content-fixture.js');
 const { createGeneratedEntity }=await import('../operations/entity/mutations.js');
 const { withDbSession }=await import('../db/session.js');
 const { withAuditContext }=await import('../platform/audit-context.js');
 const versioning=(await import('@openshapeforge/versioning/runtime')).default;
 const manager={...editor,roles:['Organization.Security.Manage']};
 const identity=randomUUID(),customer=randomUUID(),supplier=randomUUID();
 await sql`insert into platform.tenants(id,slug,name,status) values(${tenant}::uuid,${'security-'+tenant},'Security proof','active')`.execute(privileged());
 await sql`insert into erp.relations(id,tenant_id,display_name,relation_type) values(${customer}::uuid,${tenant}::uuid,'Customer','customer'),(${supplier}::uuid,${tenant}::uuid,'Supplier','supplier')`.execute(privileged());
 await sql`insert into platform.identities(id,issuer,subject,display_name) values(${identity}::uuid,'https://identity.test/realms/openshapeforge',${editor.userId},'Reader')`.execute(privileged());
 await sql`insert into platform.identity_relations(tenant_id,identity_id,status,relation_id,linked_at,linked_by) values(${tenant}::uuid,${identity}::uuid,'linked',${customer}::uuid,now(),'fixture')`.execute(privileged());

 await expect(createGeneratedEntity(restricted(),dbInput(editor),{table:tableName('AuthorizationProfile'),values:{name:'No authority',key:'no-authority',targetEntity:'Relation',active:true}})).rejects.toBeDefined();
 await expect(withDbSession(restricted(),dbInput(editor),trx=>sql`insert into erp.authorization_profiles(tenant_id,name,key,target_entity,active) values(${tenant}::uuid,'No authority','raw-no-authority','Relation',true)`.execute(trx))).rejects.toBeDefined();
 const profile=await createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfile'),values:{name:'Customer access',key:'customer-'+randomUUID(),targetEntity:'Relation',active:true}});
 const {executeCollectionMutation}=await import('../operations/entity/collection-mutations.js');
 const revision=(await sql<{version:string}>`select updated_at::text as version from erp.authorization_profiles where id=${profile.id}::uuid`.execute(privileged())).rows[0]!.version;
 await executeCollectionMutation(restricted(),dbInput(manager),{entityName:'AuthorizationProfile',field:'policies',action:'insert'},{id:String(profile.id),expectedVersion:revision,values:{operationId:'Relation.list',condition:rule('equals',literal('customer'))}});
 const published=await versioning.operationHandlers.publishAuthorizationProfileToAuthorizationProfileVersion!({id:profile.id},platformFor(manager).context);
 const version=(published as {value:{id:string}}).value;
 await createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfileAssignment'),values:{name:'Reader',profileVersion:version.id,subjectKind:'user',subjectKey:identity,active:true}});
 await sql`update platform.authorization_operation_inventory set grantable=true where id='Relation.list'`.execute(privileged());
 await createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationOperationPolicy'),values:{operationId:'Relation.list',entityType:'Relation',managed:true}});
 await sql`update platform.authorization_operation_inventory set grantable=false where id='Relation.list'`.execute(privileged());
 const allows=(type:string)=>withAuditContext('Relation.list','bearer',()=>withDbSession(restricted(),{...dbInput(editor),auditIdentityId:identity,principalKind:'person'},async trx=>(await sql<{allowed:boolean}>`select app.authorization_allows('Relation',${jsonbLiteral({relation_type:type})}) as allowed`.execute(trx)).rows[0]!.allowed));
 expect(await allows('customer')).toBe(false); // no tenant-assignment can raise the application ceiling
 await sql`update platform.authorization_operation_inventory set grantable=true where id='Relation.list'`.execute(privileged()); // synthetic authored host ceiling
 expect(await allows('customer')).toBe(true);
 expect(await allows('supplier')).toBe(false);
 const read=(operation:string)=>withAuditContext(operation,'bearer',()=>withDbSession(restricted(),{...dbInput(editor),auditIdentityId:identity,principalKind:'person'},async trx=>(await sql<{id:string}>`select id from erp.relations order by id`.execute(trx)).rows.map(row=>row.id)));
 expect(await read('Relation.list')).toEqual([customer]);
 expect((await read('Relation.get')).sort()).toEqual([customer,supplier].sort()); // existing Operations preserve defaults
 await sql`update platform.authorization_operation_inventory set grantable=true where id='Relation.get'`.execute(privileged());
 await sql`update erp.authorization_operation_policies set managed=true where operation_id='Relation.get' and tenant_id=${tenant}::uuid`.execute(privileged());
 expect(await read('Relation.get')).toEqual([]);
 const {executeEntityOperation}=await import('../operations/entity/runtime.js');
 const audience={...dbInput(editor),roles:[],auditIdentityId:identity,principalKind:'person' as const};
 const listed=await executeEntityOperation(restricted(),audience,{operation:{id:'Relation.list',intent:'list'},input:{}});
 expect('error' in listed).toBe(false);
 if(!('error' in listed)) {
   const items=(listed.data as {items:{data:Record<string,unknown>}[]}).items;
   expect(items.map(item=>item.data.id)).toEqual([customer]);
   expect(Object.keys(items[0]!.data).sort()).toEqual(['display_name','id']); // initial basic display projection
 }
 const hiddenFilter=await executeEntityOperation(restricted(),{...audience},{operation:{id:'Relation.list',intent:'list'},input:{filter:{relationType:{eq:'customer'}}}});
 expect('error' in hiddenFilter).toBe(true);
 const opened=await executeEntityOperation(restricted(),{...audience},{operation:{id:'Relation.get',intent:'get'},input:{id:customer}});
 expect('error' in opened).toBe(true);
 await expect(createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfileAssignment'),values:{name:'Ambiguous',operationId:'Relation.get',profileVersion:version.id,subjectKind:'user',subjectKey:identity,active:true}})).rejects.toBeDefined();
 await createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfileAssignment'),values:{name:'Scoped profile',operationId:'Relation.list',profileVersion:version.id,subjectKind:'user',subjectKey:identity,active:true}});
 expect(await allows('supplier')).toBe(false); // scoping a profile must not turn it into an unconditional direct grant
 const direct=await createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfileAssignment'),values:{name:'Direct get',operationId:'Relation.get',subjectKind:'user',subjectKey:identity,active:true}});
 const directlyOpened=await executeEntityOperation(restricted(),{...audience},{operation:{id:'Relation.get',intent:'get'},input:{id:supplier}});
 expect('error' in directlyOpened).toBe(false);
 await sql`update erp.authorization_profile_assignments set active=false where id=${direct.id}::uuid`.execute(privileged());

 const group=randomUUID();
 await sql`insert into erp.relation_groups(id,tenant_id,name,status,group_type) values(${group}::uuid,${tenant}::uuid,'Readers','active','team')`.execute(privileged());
 await sql`insert into erp.relation_group_memberships(tenant_id,relation_id,relation_group_id,status) values(${tenant}::uuid,${customer}::uuid,${group}::uuid,'active')`.execute(privileged());
 const addProfile=async(operationId:string,condition:CompilerConditionInput,subjectKind:string,subjectKey:string)=>{
  const profile=await createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfile'),values:{name:operationId,key:'proof-'+randomUUID(),targetEntity:'Relation',active:true}});
  const rev=(await sql<{version:string}>`select updated_at::text as version from erp.authorization_profiles where id=${profile.id}::uuid`.execute(privileged())).rows[0]!.version;
  await executeCollectionMutation(restricted(),dbInput(manager),{entityName:'AuthorizationProfile',field:'policies',action:'insert'},{id:String(profile.id),expectedVersion:rev,values:{operationId,condition}});
  const result=await versioning.operationHandlers.publishAuthorizationProfileToAuthorizationProfileVersion!({id:profile.id},platformFor(manager).context);
  const version=(result as {value:{id:string}}).value;
  return createGeneratedEntity(restricted(),dbInput(manager),{table:tableName('AuthorizationProfileAssignment'),values:{name:operationId,profileVersion:version.id,subjectKind,subjectKey,active:true}});
 };
 const {securitySubjectChoices}=await import('./security-profiles.js');
 const people=await securitySubjectChoices({...platformFor(manager).context,db:restricted()},{kind:'user',search:'Reader',first:25,locale:'en'});
 expect(people.items.some(item=>item.value===identity)).toBe(true);
 const directoryGroups=await securitySubjectChoices({...platformFor(manager).context,db:restricted()},{kind:'group',search:'Readers',first:25,locale:'en'});
 expect(directoryGroups.items.some(item=>item.value===group&&item.label==='Readers')).toBe(true);
 await addProfile('Relation.get',rule('equals',literal('supplier')),'group',group);
 const grouped={...audience,relationGroupIds:[group]};
 const supplierAccess=await executeEntityOperation(restricted(),grouped,{operation:{id:'Relation.get',intent:'get'},input:{id:supplier}});
 expect('error' in supplierAccess).toBe(false);
 expect(!('error' in supplierAccess) && (supplierAccess.data as {id:string})?.id).toBe(supplier);
 // The direct get grant does not add the supplier to the customer's list scope.
 expect(await read('Relation.list')).toEqual([customer]);
 await sql`update erp.relation_groups set status='inactive' where id=${group}::uuid`.execute(privileged());
 const withdrawnGroup=await executeEntityOperation(restricted(),{...grouped},{operation:{id:'Relation.get',intent:'get'},input:{id:supplier}});
 expect('error' in withdrawnGroup || withdrawnGroup.data===null).toBe(true);

 // Representative scoped-list load: 20k records, 8 applicable profiles, 200 actor groups.
 for(let index=0;index<7;index++)await addProfile('Relation.list',rule('equals',literal('customer')),'user',identity);
 await sql`insert into erp.relations(id,tenant_id,display_name,relation_type)
   select gen_random_uuid(),${tenant}::uuid,'Load '||n,case when n%400=0 then 'customer' else 'supplier' end from generate_series(1,20000) n`.execute(privileged());
 await sql`analyze erp.relations`.execute(privileged());
 const timings:number[]=[];
 const groups=Array.from({length:200},()=>randomUUID());
 await sql`insert into erp.relation_groups(id,tenant_id,name,status,group_type)
   select value::uuid,${tenant}::uuid,'Load group','active','team' from jsonb_array_elements_text(${jsonbLiteral(groups)})`.execute(privileged());
 await sql`insert into erp.relation_group_memberships(tenant_id,relation_id,relation_group_id,status)
   select ${tenant}::uuid,${customer}::uuid,value::uuid,'active' from jsonb_array_elements_text(${jsonbLiteral(groups)})`.execute(privileged());

 for(let sample=0;sample<12;sample++){
  const started=performance.now();
  const result=await executeEntityOperation(restricted(),{...audience,relationGroupIds:groups},{operation:{id:'Relation.list',intent:'list'},input:{limit:50}});
  expect('error' in result).toBe(false);
  if(sample>=2)timings.push(performance.now()-started);
 }
 timings.sort((a,b)=>a-b);
 const metrics={records:20002,profiles:8,actorGroups:200,samples:timings.length,p50:timings[Math.floor(timings.length*.5)],p95:timings[Math.ceil(timings.length*.95)-1],scope:'canonical entity Operation including DB session and RLS; excludes HTTP identity resolution'};
 await Bun.write('/tmp/osf460-performance.json',JSON.stringify(metrics,null,2));
 console.info('Authorization list benchmark',JSON.stringify(metrics));
 // Role subjects come from live membership, not a stale flattened session role snapshot.
 await addProfile('Relation.get',rule('equals',literal('supplier')),'role','General.All.Read');
 const setRoles=(roles:string[])=>privileged().transaction().execute(async trx=>{
   await sql`select set_config('app.roles','Organization.All.ReadWrite',true)`.execute(trx);
   await sql`update platform.identity_relations set roles=array(select jsonb_array_elements_text(${jsonbLiteral(roles)})) where tenant_id=${tenant}::uuid and identity_id=${identity}::uuid`.execute(trx);
 });
 await setRoles(['General.All.Read']);
 const liveRole=await executeEntityOperation(restricted(),{...audience},{operation:{id:'Relation.get',intent:'get'},input:{id:supplier}});
 expect('error' in liveRole).toBe(false);
 await setRoles([]);
 const staleRole=await executeEntityOperation(restricted(),{...audience,roles:['General.All.Read']},{operation:{id:'Relation.get',intent:'get'},input:{id:supplier}});
 expect('error' in staleRole).toBe(true);
 // Policy withdrawal serializes with an admitted command, then applies on the next transaction.
 const database=(await sql<{name:string}>`select current_database() as name`.execute(privileged())).rows[0]!.name;
 const url=new URL(process.env.SCRATCH_ADMIN_DATABASE_URL!);url.pathname='/'+database;url.username='openshapeforge_app';url.password='openshapeforge_app';
 const {createDatabaseRuntime}=await import('../db/connection.js');
 const writer=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:1});
 let release!:()=>void,admitted!:()=>void;
 const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{admitted=resolve;});
 const reading=withAuditContext('Relation.list','bearer',()=>withDbSession(restricted(),audience,async trx=>{await sql`select id from erp.relations limit 1`.execute(trx);admitted();await hold;}));
 await ready;
 let committed=false;
 const writing=withAuditContext('AuthorizationProfileAssignment.update','bearer',()=>withDbSession(writer.db,dbInput(manager),async trx=>{
   await sql`update erp.authorization_profile_assignments set active=false where tenant_id=${tenant}::uuid`.execute(trx);
 })).then(()=>{committed=true;});
 await new Promise(resolve=>setTimeout(resolve,20));
 expect(committed).toBe(false);
 release();await reading;await writing;await writer.close();
 expect(committed).toBe(true);
 // Revoke every applicable grant. Managed access must not fall back to defaults.
 await sql`update erp.authorization_profile_assignments set active=false where tenant_id=${tenant}::uuid`.execute(privileged());
 expect(await read('Relation.list')).toEqual([]);


 expect(await read('')).toEqual([]);

 await sql`update erp.authorization_profiles set active=false where tenant_id=${tenant}::uuid and id=${profile.id}::uuid`.execute(privileged());
 expect(await allows('customer')).toBe(false);
 expect(await read('Relation.list')).toEqual([]);
 await expect(sql`update erp.authorization_profile_versions set content_hash='changed' where id=${version.id}::uuid`.execute(privileged())).rejects.toBeDefined();
 await expect(sql`update platform.authorization_operation_inventory set grantable=true`.execute(restricted())).rejects.toBeDefined();
},60_000);
