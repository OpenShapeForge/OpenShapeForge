// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from "bun:test";
import {assertPublicTypedValueArguments} from "../typed-value-write-guard.js";
import {SECRET_SET_SENTINEL} from "../../connectors/secrets.js";
import type {GeneratedCrudTable,GeneratedCrudColumn} from "../../operations/entity/types.js";
const column=(name:string,extra:Partial<GeneratedCrudColumn>={}):GeneratedCrudColumn=>({name,sourceField:name,type:"jsonb",required:false,primaryKey:false,generated:null,...extra});
const table={columns:[
  column("definition"),
  column("value",{typedBy:{definitionField:"definition",definitionColumn:"definition",encrypted:true}}),
]} as GeneratedCrudTable;
const confidential={key:"value",osfType:"string",classification:{sensitivity:"confidential"}};
const plain={key:"value",osfType:"string"};
test("MCP create/update cannot submit a confidential typed value as model arguments",()=>{
  expect(()=>assertPublicTypedValueArguments(table,{definition:confidential,value:"synthetic-secret"})).toThrow("private configuration form");
  expect(()=>assertPublicTypedValueArguments(table,{value:"synthetic-secret"},{definition:confidential,value:SECRET_SET_SENTINEL})).toThrow("private configuration form");
  expect(()=>assertPublicTypedValueArguments(table,{value:"unclassified"})).toThrow("valid FieldDefinition");
  expect(()=>assertPublicTypedValueArguments(table,{definition:confidential,value:"synthetic-secret"},{definition:plain})).toThrow("private configuration form");
  expect(()=>assertPublicTypedValueArguments(table,{definition:plain,value:"synthetic-secret"},{definition:confidential})).toThrow("private configuration form");
  expect(()=>assertPublicTypedValueArguments(table,{definition:plain,value:"plain repair"},{definition:"invalid"})).not.toThrow();
});
test("plain configuration, metadata repair, private-elicited fields, clearing and an existing sentinel remain supported",()=>{
  expect(()=>assertPublicTypedValueArguments(table,{definition:{key:"value",osfType:"object"},value:{sources:[],identities:[]}})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{key:"retired-invalid-definition"},{definition:confidential})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{}, {definition:confidential})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{value:null},{definition:confidential})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{value:SECRET_SET_SENTINEL},{definition:confidential})).not.toThrow();
});
