// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { createKeycloakOrganizationMembersClient } from '../keycloak-organization-members.js';

test('password recovery sends only the fixed reset action to the registered user with a 15-minute lifetime', async () => {
  const calls: {url:string;init:RequestInit}[]=[];
  const fetch=(async(input:unknown,init:RequestInit={})=>{
    const url=String(input);calls.push({url,init});
    return url.includes('/protocol/openid-connect/token')
      ? Response.json({access_token:'test-token',expires_in:900})
      : new Response(null,{status:204});
  }) as typeof globalThis.fetch;
  const client=createKeycloakOrganizationMembersClient({
    baseUrl:'https://identity.example.test',tenantRealm:'demo',clientId:'test-client',clientSecret:'local-test-secret',
  },{fetch});
  await client.sendPasswordRecovery!('member/1');
  expect(calls).toHaveLength(2);
  expect(calls[1]!.url).toBe('https://identity.example.test/admin/realms/demo/users/member%2F1/execute-actions-email?lifespan=900');
  expect(calls[1]!.init.method).toBe('PUT');
  expect(calls[1]!.init.body).toBe('["UPDATE_PASSWORD"]');
});
