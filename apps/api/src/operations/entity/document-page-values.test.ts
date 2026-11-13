// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {guardDocumentPageWrite} from './document-page-values.js';
import type {GeneratedCrudTable,GeneratedCrudColumn} from './types.js';
const table=(name:string)=>({source:{authoringEntityName:name}} as GeneratedCrudTable);
const values=(row:Record<string,unknown>)=>new Map(Object.entries(row).map(([name,value])=>[{name} as GeneratedCrudColumn,value]));
test('block create/update refuse a body layout before storing; partial updates retain the other field',()=>{
 expect(()=>guardDocumentPageWrite(table('Block'),values({layout_key:'cover'}))).toThrow('A body block cannot');
 expect(()=>guardDocumentPageWrite(table('Block'),values({region:'body'}),{region:'header',layout_key:'cover'})).toThrow('A body block cannot');
 expect(()=>guardDocumentPageWrite(table('Block'),values({layout_key:null}),{region:'body',layout_key:'cover'})).not.toThrow();
 expect(()=>guardDocumentPageWrite(table('Block'),values({region:'header',layout_key:'cover'}))).not.toThrow();
});
test('theme writes accept exactly the shared stored-page-design parser including empty designs',()=>{
 for(const page_design of [{},null,{page:{width:720,height:913},colors:{},textStyles:{},assets:{}}])expect(()=>guardDocumentPageWrite(table('DocumentTheme'),values({page_design}))).not.toThrow();
 for(const page_design of [{colors:{}},{page:{width:'720',height:913}},{page:{width:720,height:913},colors:{bad:'url(x)'}}])expect(()=>guardDocumentPageWrite(table('DocumentTheme'),values({page_design}))).toThrow('valid page design');
 expect(()=>guardDocumentPageWrite(table('Other'),values({page_design:{colors:{}}}))).not.toThrow();
});

test('template-inclusion placement is refused on create and partial update; ordinary body inclusion remains valid',()=>{
 for(const region of ['header','footer']) {
  expect(()=>guardDocumentPageWrite(table('Block'),values({definition_key:'TemplateBlock',region}))).toThrow('template inclusion must be a body');
  expect(()=>guardDocumentPageWrite(table('Block'),values({region}),{definition_key:'TemplateBlock',region:'body'})).toThrow('template inclusion must be a body');
  expect(()=>guardDocumentPageWrite(table('Block'),values({definition_key:'TemplateBlock'}),{definition_key:'TextBlock',region})).toThrow('template inclusion must be a body');
 }
 expect(()=>guardDocumentPageWrite(table('Block'),values({definition_key:'TemplateBlock',region:'body'}))).not.toThrow();
 expect(()=>guardDocumentPageWrite(table('Block'),values({definition_key:'TextBlock',region:'header'}))).not.toThrow();
});
