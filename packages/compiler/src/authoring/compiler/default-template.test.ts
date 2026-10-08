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
