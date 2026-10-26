// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from "bun:test";
import {assertPublicTypedValueArguments} from "../typed-value-write-guard.js";
import {SECRET_SET_SENTINEL} from "../../connectors/secrets.js";
import type {GeneratedCrudTable} from "../../operations/entity/types.js";
const table={columns:[
  {name:"definition",fieldName:"definition",type:"jsonb"},
  {name:"value",fieldName:"value",type:"jsonb",typedBy:{definitionField:"definition",definitionColumn:"definition",encrypted:true}},
]} as unknown as GeneratedCrudTable;
const confidential={key:"value",osfType:"string",classification:{sensitivity:"confidential"}};
test("MCP create/update cannot submit a confidential typed value as model arguments",()=>{
  expect(()=>assertPublicTypedValueArguments(table,{definition:confidential,value:"synthetic-secret"})).toThrow("private configuration form");
  expect(()=>assertPublicTypedValueArguments(table,{value:"synthetic-secret"},{definition:confidential,value:SECRET_SET_SENTINEL})).toThrow("private configuration form");
  expect(()=>assertPublicTypedValueArguments(table,{value:"unclassified"})).toThrow("private configuration form");
});
test("plain configuration, metadata repair, private-elicited fields, clearing and an existing sentinel remain supported",()=>{
  expect(()=>assertPublicTypedValueArguments(table,{definition:{key:"value",osfType:"object"},value:{sources:[],identities:[]}})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{key:"retired-invalid-definition"},{definition:confidential})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{}, {definition:confidential})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{value:null},{definition:confidential})).not.toThrow();
  expect(()=>assertPublicTypedValueArguments(table,{value:SECRET_SET_SENTINEL},{definition:confidential})).not.toThrow();
});
