// SPDX-License-Identifier: BUSL-1.1
import {test,expect,beforeEach,afterEach} from 'bun:test';
import {__resetSessionResolverForTests} from '../../auth/identity.js';
const keys=['OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI','OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER'];
const saved=new Map(keys.map(key=>[key,process.env[key]]));
beforeEach(()=>{for(const key of keys)delete process.env[key];__resetSessionResolverForTests();});
afterEach(()=>{for(const key of keys){const value=saved.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}__resetSessionResolverForTests();});
import type {FastifyRequest} from 'fastify';
import {createMcpSessionAdmission} from '../session-admission.js';
const admit=createMcpSessionAdmission({});
const request=(headers:Record<string,string>)=>({method:'POST',url:'/api/entity-configuration/pending/test',params:{},headers}) as FastifyRequest;
test('secure form transport still rejects a cookie without a bearer credential',async()=>{
 await expect(admit(request({'content-type':'application/x-www-form-urlencoded',cookie:'session=fake'}),'configuration-form')).rejects.toMatchObject({status:401});
});
test('only the explicit secure form transport accepts its media type and still verifies identity',async()=>{
 const form=request({'content-type':'application/x-www-form-urlencoded',authorization:'Bearer invalid'});
 await expect(admit(form)).rejects.toMatchObject({status:415});
 await expect(admit(form,'configuration-form')).rejects.toMatchObject({name:'SessionAuthenticationUnavailableError'});
 await expect(admit(request({'content-type':'application/json',authorization:'Bearer invalid'}),'configuration-form')).rejects.toMatchObject({status:415});
});
