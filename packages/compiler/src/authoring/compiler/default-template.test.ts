import {test,expect} from 'bun:test';
import {validateDefaultTemplates} from './default-template.js';
import type {TableDefinition} from '../../schema.js';
const table=(name:string,fields:Record<string,string>,relationships:unknown[]=[])=>({name,schema:'demo',columns:Object.entries(fields).map(([sourceField,type])=>({name:sourceField,sourceField,type})),source:{graphql:{typeName:name,relationships}}}) as TableDefinition;
test('Budget and document names share the validated default vocabulary',()=>{
 const year=table('Year',{code:'text'});
 const budget=table('Budget',{name:'text',fiscalYearId:'uuid'},[{name:'fiscalYearId',target:'Year',resolve:'belongsTo',foreignKey:'fiscalYearId'}]);
 budget.columns[0]!.defaultTemplate='{{fiscalYear.code}}';
 const document=table('Document',{title:'text',customerName:'text'});document.columns[0]!.defaultTemplate='Proposal for {{customerName}}';
 expect(()=>validateDefaultTemplates([budget,year,document])).not.toThrow();
 budget.columns[0]!.defaultTemplate='{{fiscalYear.missing}}';expect(()=>validateDefaultTemplates([budget,year])).toThrow();
 budget.columns[0]!.defaultTemplate='{{name}}';expect(()=>validateDefaultTemplates([budget,year])).toThrow();
});

test('creation templates do not change physical schema fingerprints', async()=>{
 const {generateArtifacts}=await import('../../generate.js');
 const fixture={version:1,tables:[{schema:'demo',name:'documents',columns:[{name:'id',type:'uuid',primaryKey:true,required:true,default:'gen_random_uuid()'},{name:'name',sourceField:'name',type:'text',required:true}]}]};
 const before=generateArtifacts(fixture as never);
 Object.assign(fixture.tables[0]!.columns[1]!, {defaultTemplate:'Document {{id}}'});
 const after=generateArtifacts(fixture as never);
 const checksum=(artifacts:typeof before)=>JSON.parse(artifacts.find(a=>a.path.endsWith('manifest.json'))!.contents).checksum;
 expect(checksum(after)).toBe(checksum(before));
 expect(after.find(a=>a.path.endsWith('schema.sql'))!.contents).toBe(before.find(a=>a.path.endsWith('schema.sql'))!.contents);
});
