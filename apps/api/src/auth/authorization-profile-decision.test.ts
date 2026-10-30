// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {authorizationProfileDecision,bindAuthorizationProfileAccess} from './authorization-profile-decision.js';
import {createStatefulMcpSessionContext,withFreshRelationGroupMemberships} from '../mcp/stateful-session-authorization.js';
import {createModuleSessionCapability,ModulePlatformRuntime} from '../modules/platform.js';
import type {TrustedSessionContext} from './trusted-context.js';
import type {OpenShapeForgeDatabase} from '../db/connection.js';
const session=():TrustedSessionContext=>({tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',roles:[],groups:[],scope:'tenant',credential:'bearer'});
test('MCP and module capabilities follow concurrent request grants and withdrawals',async()=>{
 const initial=session(),allowed=session(),denied=session();
 bindAuthorizationProfileAccess(initial,{managedEntities:['Relation'],operations:{'Relation.list':false}});
 bindAuthorizationProfileAccess(allowed,{managedEntities:['Relation'],operations:{'Relation.list':true}});
 bindAuthorizationProfileAccess(denied,{managedEntities:['Relation'],operations:{'Relation.list':false}});
 const stateful=createStatefulMcpSessionContext(initial),capability=createModuleSessionCapability(stateful);
 await Promise.all([withFreshRelationGroupMemberships(allowed,async()=>{
  await Promise.resolve();expect(authorizationProfileDecision(capability,'Relation.list','Relation')).toBe(true);
 }),withFreshRelationGroupMemberships(denied,async()=>{
  await Promise.resolve();expect(authorizationProfileDecision(capability,'Relation.list','Relation')).toBe(false);
 })]);
 await withFreshRelationGroupMemberships(denied,async()=>expect(authorizationProfileDecision(capability,'Relation.list','Relation')).toBe(false));
});
test('exact Operation lookup admits a profile-only audience and closes on withdrawal',async()=>{
 const runtime=new ModulePlatformRuntime({} as OpenShapeForgeDatabase),who=session();
 bindAuthorizationProfileAccess(who,{managedEntities:['Relation'],operations:{'Relation.list':true,'Relation.get':false}});
 await runtime.withActiveOperationSession(who,async active=>{
  expect((await runtime.services.operations.get(active,'Relation.list'))?.id).toBe('Relation.list');
  expect(await runtime.services.operations.get(active,'Relation.get')).toBeUndefined();
  bindAuthorizationProfileAccess(who,{managedEntities:['Relation'],operations:{'Relation.list':false,'Relation.get':true}});
  expect(await runtime.services.operations.get(active,'Relation.list')).toBeUndefined();
  expect((await runtime.services.operations.get(active,'Relation.get'))?.id).toBe('Relation.get');
 });
});
