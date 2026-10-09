// SPDX-License-Identifier: BUSL-1.1
/** A published graph contains only compiler-approved content and declared references. */
export type BlueprintGraphRecord = {
 entity: string;
 sourceId: string;
 values: Record<string, unknown>;
 references: Record<string, {entity: string; sourceId: string} | null>;
};
export type BlueprintBindings = Record<string, Record<string, string>>;
export type BlueprintGraphAdapter = {
 /** Must enforce entity-create authorization, validation and tenant isolation. */
 create(entity: string, values: Record<string, unknown>): Promise<string>;
};
const identity = (entity: string, id: string) => JSON.stringify([entity,id]);
/** Validate dependency order and external bindings before any mutation starts. */
export function planBlueprintGraph(records: readonly BlueprintGraphRecord[], bindings: BlueprintBindings = {}): BlueprintGraphRecord[] {
 if (!records.length || records.length > 1000) throw new Error('Blueprint graph must contain between 1 and 1000 records.');
 const all = new Map<string, BlueprintGraphRecord>();
 for (const record of records) {
  if (!record.entity || !record.sourceId) throw new Error('Blueprint graph identity is missing.');
  const key = identity(record.entity, record.sourceId);
  if (all.has(key)) throw new Error('Blueprint graph contains duplicate source identities.');
  all.set(key,record);
  for(const field of Object.keys(record.references))if(Object.hasOwn(record.values,field))throw new Error('Blueprint reference must not also be a scalar value.');
 }
 const ordered: BlueprintGraphRecord[] = [], done = new Set<string>();
 const remaining = new Map(all);
 while (remaining.size) {
  let progressed = false;
  for (const [key, record] of remaining) {
   let ready = true;
   for (const reference of Object.values(record.references)) {
    if (!reference) continue;
    const target = identity(reference.entity,reference.sourceId);
    if (all.has(target)) { if (!done.has(target)) ready = false; }
    else {
     const bound = bindings[reference.entity]?.[reference.sourceId];
     if (typeof bound !== 'string' || !bound.trim()) throw new Error('Blueprint external reference requires a destination binding.');
    }
   }
   if (!ready) continue;
   ordered.push(record);done.add(key);remaining.delete(key);progressed=true;
  }
  if (!progressed) throw new Error('Blueprint graph contains circular required references.');
 }
 return ordered;
}
/** The runtime must run this entire call inside one destination-tenant transaction. */
export async function copyBlueprintGraph(records: readonly BlueprintGraphRecord[], bindings: BlueprintBindings, adapter: BlueprintGraphAdapter): Promise<Map<string,string>> {
 const ordered = planBlueprintGraph(records,bindings);
 const copied = new Map<string,string>();
 for (const record of ordered) {
  const values = {...record.values};
  for (const [field,reference] of Object.entries(record.references)) {
   values[field] = reference ? copied.get(identity(reference.entity,reference.sourceId)) ?? bindings[reference.entity]![reference.sourceId] : null;
  }
  const id = await adapter.create(record.entity,values);
  if (typeof id !== 'string' || !id) throw new Error('Blueprint create returned no destination identity.');
  copied.set(identity(record.entity,record.sourceId),id);
 }
 return copied;
}
