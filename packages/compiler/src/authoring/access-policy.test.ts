// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {buildAccessPolicy} from './access-policy.js';

function fixture(permission='Business.Read') {
  const config:any={realm:{name:'example'},keycloak:{entityRoleClient:'api'},identity:{administratorRole:'Access.Manage'},
    organizationAccess:{permissions:[permission],roles:['reader'],groups:[{key:'readers',name:'Readers',roles:['reader']}]}};
  const realms:any=[{contents:JSON.stringify({realm:'example',roles:{client:{api:[
    {name:'Business.Read'}, {name:'Access.Manage'}, {name:'Platform.Bypass'},
    {name:'reader',composite:true,composites:{client:{api:['Business.Read']}}}
  ]}}})}];
  return {config,realms};
}
test('tenant policy permits declared business leaves only',()=>{
  const {config,realms}=fixture();
  expect(buildAccessPolicy([config],realms)).toEqual(config.organizationAccess);
  for(const permission of ['missing','reader','Access.Manage','Platform.Bypass']) {
    const f=fixture(permission);
    expect(()=>buildAccessPolicy([f.config],f.realms)).toThrow('tenant-assignable');
  }
  config.organizationAccess.groups.push(config.organizationAccess.groups[0]);
  expect(()=>buildAccessPolicy([config],realms)).toThrow('Duplicate starter group');
});
