// SPDX-License-Identifier: BUSL-1.1
import { expect, mock, test } from "bun:test";
let version = 1;
const inserted: string[] = [];
const definitions = [
 {id:"Document.create",entityName:"Document",intent:"create"},
 {id:"Document.get",entityName:"Document",intent:"get"},
 {id:"Document.insertVariant",intent:"invoke"},
 {id:"DocumentVariant.get",entityName:"DocumentVariant",intent:"get"},
 {id:"DocumentVariant.insertBlock",intent:"invoke"},
];
const services = {operations:{
 list:async()=>definitions,
 execute:async(_session:unknown,request:{operation:{id:string};input:Record<string,unknown>})=>{
  const {id}=request.operation;
  if(id==="Document.create"||id==="Document.get")return {data:{id:"destination-document",updatedAt:String(version)},operations:[]};
  if(id==="Document.insertVariant"){
   expect(request.input.expectedVersion).toBe(String(version));version++;
   const locale=String((request.input.values as Record<string,unknown>).locale);inserted.push(locale);
   return {data:{childId:`variant-${locale}`},operations:[]};
  }
  if(id==="DocumentVariant.get")return {data:{id:request.input.id,updatedAt:"1"},operations:[]};
  if(id==="DocumentVariant.insertBlock"){version++;return {data:{},operations:[]};}
  throw Error("Unexpected canonical Operation");
 }
}};
mock.module("../../modules/platform.js",()=>({withBlueprintDocumentServices:async(_db:unknown,_session:unknown,work:(services:unknown,session:unknown)=>unknown)=>work(services,{})}));
const {copyBlueprintDocuments}=await import("./blueprint-documents.js");
test("each copied locale uses the fresh Document version after preceding content writes",async()=>{
 const copied=await copyBlueprintDocuments({} as never,{}, {context:{document:{title:"Context"},variants:["nl","en"].map(locale=>({channel:"document",locale,blocks:[{definitionKey:"TextBlock",values:{markdown:locale}}]}))}},{});
 expect(copied).toEqual({context:"destination-document"});expect(inserted).toEqual(["nl","en"]);
});
