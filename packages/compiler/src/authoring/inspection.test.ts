import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectAuthoringInspection} from './inspection.js';
import {strategicMerge} from './layers.js';
test('trace follows the real keyed merge including deletion and whole-array replacement',()=>{
 const events:unknown[]=[];
 const value=strategicMerge({fields:[{key:'amount',osfType:'Money',label:'Total'},{key:'old',osfType:'Text'}],columns:['a']},{fields:[{key:'amount',label:'Price'},{key:'old',$delete:true}],columns:['b']},(path,action)=>events.push({path,action}));
 expect(value).toEqual({fields:[{key:'amount',osfType:'Money',label:'Price'}],columns:['b']});
 expect(events).toContainEqual({path:['fields','key=amount','label'],action:'set'});
 expect(events).toContainEqual({path:['fields','key=old'],action:'delete'});
 expect(events).toContainEqual({path:['columns'],action:'set'});
});
test('source spans refer to original YAML, histories distinguish base and patch, secrets excluded',()=>{
 const root=mkdtempSync(join(tmpdir(),'osf-inspection-'));
 try{
 for(const layer of ['base','host'])mkdirSync(join(root,layer,'entities'),{recursive:true});
 writeFileSync(join(root,'base/entities/quote.yaml'),'kind: coreEntity\nentity: Quote\nfields:\n  - key: amount\n    osfType: Money\n    label: Total\n');
 writeFileSync(join(root,'host/entities/quote.yaml'),'kind: entityPatch\nfields:\n  - key: amount\n    label: Price\n');
 writeFileSync(join(root,'base/secret.yaml'),'password: do-not-export\n');
 const trace=collectAuthoringInspection(root,{layers:['base','host']});const doc=trace.documents['entities/quote.yaml']!;
 expect(doc.sources).toHaveLength(2);expect(doc.changes).toContainEqual({path:['fields','key=amount','label'],source:1,action:'set'});
 const src=doc.sources[0]!;const span=src.nodes[JSON.stringify(['fields','key=amount','osfType'])]!;
 expect(src.text.slice(span.start,span.end)).toBe('Money');expect(span.line).toBe(5);
 expect(JSON.stringify(trace)).not.toContain('do-not-export');
 }finally{rmSync(root,{recursive:true,force:true})}
});
