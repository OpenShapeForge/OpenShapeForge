// SPDX-License-Identifier: BUSL-1.1
import {expect,test} from 'bun:test';
import {filterFieldNames} from './filter-groups.js';
import {assertClassifiedQueryFieldsAllowed} from '../../graphql/generated-authz.js';
import {assertElicitedQueryAllowed} from './catalog.js';
import {assertBoundFieldQueryAllowed} from './field-bindings.js';
import {structuredFilter} from '../../platform/structured-filter.js';
import {Kysely,DummyDriver,PostgresAdapter,PostgresIntrospector,PostgresQueryCompiler,sql} from 'kysely';
const db=new Kysely({dialect:{createAdapter:()=>new PostgresAdapter(),createDriver:()=>new DummyDriver(),createIntrospector:db=>new PostgresIntrospector(db),createQueryCompiler:()=>new PostgresQueryCompiler()}});
test('nested OR never hides a restricted field from the existing policy',()=>{
 const filter={or:[{name:{contains:'needle'}},{and:[{description:{contains:'needle'}}]}]};
 expect(filterFieldNames(filter)).toContain('description');
 const column={name:'description',type:'text',fieldPolicy:{readRoles:['Secret.Read']}} as any;
 expect(()=>assertClassifiedQueryFieldsAllowed([column],{roles:{read:['Read'],create:[],update:[],delete:[]}},{roles:['Read']},'Example',filter)).toThrow('Not authorized');
 expect(()=>assertClassifiedQueryFieldsAllowed([column],{roles:{read:['Read'],create:[],update:[],delete:[]}},{roles:['Read','Secret.Read']},'Example',filter)).not.toThrow();
 expect(()=>assertElicitedQueryAllowed({columns:[{...column,typedBy:{encrypted:true}}]} as any,{filter})).toThrow();
 expect(()=>assertBoundFieldQueryAllowed({columns:[column,{name:'__osf_field_bindings',type:'jsonb',fieldBindings:{fields:[{field:'description',column:'description',variables:'whole'}]}}]} as any,{filter})).toThrow();
});
test('boolean groups are bounded, never silently ignored',()=>{
 for(const filter of [{or:[]},{or:'x'},{and:[null]}])expect(()=>filterFieldNames(filter as any)).toThrow();
 let nested:any={name:'x'};for(let i=0;i<6;i++)nested={or:[nested]};expect(()=>filterFieldNames(nested)).toThrow();
});
test('existing text predicates bind literal input in a real OR SQL expression',()=>{
 const query=structuredFilter({or:[{name:{contains:'100%_'}},{description:{contains:'100%_'}}]},
  {name:{sql:sql.ref('name'),kind:'text'},description:{sql:sql.ref('description'),kind:'text'}}).compile(db);
 expect(query.sql).toContain(' or ');expect(query.sql).toContain('strpos');expect(query.parameters).toEqual(['100%_','100%_']);
});
