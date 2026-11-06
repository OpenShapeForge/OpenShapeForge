// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {connectionGrantFingerprint} from './connection-grant-fingerprint.js';
const snapshot={execution:{parentRef:'serviceId',operationRef:'capabilityId',providerRef:'adapterId',connectionTable:'integration.connections'},service:{id:'service',key:'availability',version:1,status:'published',name:'Availability'},binding:{order:1,inputMapping:[{from:'from',to:'timeMin'}]},capability:{id:'operation',operation:{method:'POST',pathTemplate:'/freeBusy'},requiredScopes:['calendar.read']},adapter:{id:'adapter',transport:'rest',baseUrlTemplate:'https://calendar.example.test',auth:{profile:'oauth2AuthorizationCode',tokenUrl:'https://login.example.test/token'}}};
test('catalogue labels and reconciliation timestamps do not invalidate owner consent',()=>{
 expect(connectionGrantFingerprint({...snapshot,service:{...snapshot.service,name:'Beschikbaarheid',updatedAt:'tomorrow'},adapter:{...snapshot.adapter,name:'Google',updatedAt:'tomorrow'}})).toBe(connectionGrantFingerprint(snapshot));
});
test('method, destination, authentication endpoint, mappings and scope changes require new consent',()=>{
 const changed=[{...snapshot,capability:{...snapshot.capability,operation:{method:'DELETE',pathTemplate:'/freeBusy'}}},{...snapshot,adapter:{...snapshot.adapter,baseUrlTemplate:'https://other.example.test'}},{...snapshot,adapter:{...snapshot.adapter,auth:{...snapshot.adapter.auth,tokenUrl:'https://other.example.test/token'}}},{...snapshot,binding:{...snapshot.binding,inputMapping:[{from:'secret',to:'body'}]}},{...snapshot,capability:{...snapshot.capability,requiredScopes:['calendar.write']}}];
 for(const item of changed)expect(connectionGrantFingerprint(item)).not.toBe(connectionGrantFingerprint(snapshot));
});
