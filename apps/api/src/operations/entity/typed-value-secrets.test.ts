// SPDX-License-Identifier: BUSL-1.1
import { afterAll, describe, expect, test } from "bun:test";
import { decryptSecret, keyringFromEnv, type StoredSecret } from "@openshapeforge/plugin-runtime/secrets";
import { assertTypedDefinitionSupported, prepareTypedValueWrite, projectTypedValues } from "./typed-values.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";
import type { Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
const before=process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=`test:${Buffer.alloc(32,7).toString('base64')}`;
afterAll(()=>{if(before===undefined)delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=before;});
const column=(name:string,type:string,extra:Record<string,unknown>={}):GeneratedCrudColumn=>({name,type,sourceField:name,required:false,primaryKey:false,generated:null,...extra}) as GeneratedCrudColumn;
const id=column('id','uuid');
const definition=column('definition','jsonb');
const value=column('value','jsonb',{typedBy:{definitionField:'definition',definitionColumn:'definition',encrypted:true}});
const table={schema:'test',table:'settings',primaryKey:'id',tenantScoped:true,columns:[id,definition,value]} as GeneratedCrudTable;
const type={key:'value',osfType:'string',classification:{sensitivity:'confidential',category:'credentials'},validation:{minLength:1,maxLength:4096}};
const session={tenantId:'11111111-1111-4111-8111-111111111111'};
const trx={} as Transaction<DB>;

describe('opt-in encrypted typed values',()=>{
 test('public JSON keeps envelope-shaped values and nested ciphertext keys intact',async()=>{
  const definitionValue={key:'value',osfType:'object'};
  const publicValue={ciphertext:'ordinary data',nested:{keyId:'example',algorithm:'example'}};
  const row={definition:definitionValue,value:publicValue};
  expect(projectTypedValues(table,row).value).toEqual(publicValue);
  expect((await prepareTypedValueWrite(trx,session,table,new Map<GeneratedCrudColumn,unknown>([[value,publicValue]]),row)).get(value)).toEqual(publicValue);
 });
 test('plaintext is sealed before storage and every projection returns only the set marker',async()=>{
  const result=await prepareTypedValueWrite(trx,session,table,new Map<GeneratedCrudColumn,unknown>([[definition,type],[value,'synthetic-only']]));
  const stored=result.get(value) as StoredSecret;
  expect(stored.algorithm).toBe('aes-256-gcm');expect(JSON.stringify(stored)).not.toContain('synthetic-only');
  const row=Object.fromEntries([...result].map(([c,v])=>[c.name,v]));
  expect(projectTypedValues(table,row).value).toBe('__set__');
  const keys=keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS)!;
  expect(decryptSecret(keys,`${session.tenantId}:test.settings:${row.id}`,'value',stored)).toBe('synthetic-only');
  expect(()=>decryptSecret(keys,`22222222-2222-4222-8222-222222222222:test.settings:${row.id}`,'value',stored)).toThrow();
  expect(()=>decryptSecret(keys,`${session.tenantId}:test.settings:another-row`,'value',stored)).toThrow();
  const unchanged=await prepareTypedValueWrite(trx,session,table,new Map<GeneratedCrudColumn,unknown>([[value,'__set__']]),row);
  expect(unchanged.get(value)).toEqual(stored);
 });
 test('a set marker cannot create a missing key and ciphertext cannot be submitted as plaintext',async()=>{
  await expect(prepareTypedValueWrite(trx,session,table,new Map<GeneratedCrudColumn,unknown>([[definition,type],[value,'__set__']]))).rejects.toThrow();
  await expect(prepareTypedValueWrite(trx,session,table,new Map<GeneratedCrudColumn,unknown>([[definition,type],[value,{ciphertext:'forged',keyId:'test',algorithm:'aes-256-gcm'}]]))).rejects.toThrow();
 });
 test('generic typed values remain fail-closed; nested classified values are not silently admitted',()=>{
  expect(()=>assertTypedDefinitionSupported(type,'definition','submitted')).toThrow();
  expect(()=>assertTypedDefinitionSupported({...type,osfType:'object',children:[type]},'definition','submitted',value.typedBy)).toThrow();
 });
 test('a corrupted scalar definition refuses an envelope rather than disclosing it',()=>{
  expect(()=>projectTypedValues(table,{definition:{key:'value',osfType:'string'},value:{ciphertext:'invalid'}})).toThrow();
 });
});
