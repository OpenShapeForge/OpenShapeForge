// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { validateAuthorizationProfileSnapshot, securityOperationCatalog } from './security-profiles.js';
const operations = [{id:'Relation.list',entity:'Relation',defaultRoles:['Relations.All.Read'],fields:['relationType']}];
const path=(path:string)=>({kind:'path',path});
const rule={kind:'rule',operator:'equals',left:path('resource.relationType'),right:{kind:'literal',value:'customer'}};
function snapshot(condition: unknown = rule, operation='Relation.list', target='Relation') {
 return {schemaVersion:1,entity:'AuthorizationProfile',head:{table:'authorization_profiles',row:{target_entity:target},children:{authorization_profile_policies:[{table:'authorization_profile_policies',row:{operation_id:operation,condition},children:{}}]}}};
}
test('publication accepts an eligible Operation and rejects an ungrantable Operation or a different target',()=>{
 expect(()=>validateAuthorizationProfileSnapshot(snapshot(),operations)).not.toThrow();
 expect(()=>validateAuthorizationProfileSnapshot(snapshot(rule,'Relation.get'),operations)).toThrow();
 expect(()=>validateAuthorizationProfileSnapshot(snapshot(rule,'Relation.list','KnowledgeItem'),operations)).toThrow();
});
test('publication rejects arbitrary fields and caller-defined actor roots',()=>{
 expect(()=>validateAuthorizationProfileSnapshot(snapshot({...rule,left:path('resource.secret')}),operations)).toThrow();
 expect(()=>validateAuthorizationProfileSnapshot(snapshot({...rule,right:path('actorRelation.claimedAdmin')}),operations)).toThrow();
 expect(()=>validateAuthorizationProfileSnapshot(snapshot({...rule,right:path('input.userId')}),operations)).toThrow();
});
test('a profile cannot create security-management authority through its own policy',()=>{
 expect(securityOperationCatalog().some(op=>op.entity.startsWith('Authorization'))).toBe(false);
 expect(()=>validateAuthorizationProfileSnapshot(snapshot(rule,'AuthorizationProfile.update'),operations)).toThrow();
});
test('duplicate Operations cannot disguise alternative policy interpretations',()=>{
 const value=snapshot();value.head.children.authorization_profile_policies.push(value.head.children.authorization_profile_policies[0]!);
 expect(()=>validateAuthorizationProfileSnapshot(value,operations)).toThrow();
});
