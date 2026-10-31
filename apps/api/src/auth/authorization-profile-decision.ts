// SPDX-License-Identifier: BUSL-1.1
/** Server-only proof: neither request JSON nor signed client context supplies profile decisions. */
export type AuthorizationProfileAccess = {
  managedEntities: readonly string[];
  operations: Readonly<Record<string, boolean | null>>;
  listFields?: Readonly<Record<string, readonly string[]>>;
};
const resolved = new WeakMap<object, AuthorizationProfileAccess>();
const sources = new WeakMap<object,()=>object|undefined>();
/** Reuse the session's existing request-fresh authority instead of pinning transport decisions. */
export function bindAuthorizationProfileSource(target:object,current:()=>object|undefined):void { sources.set(target,current); }
function currentSession(session:object):object|undefined {
 let current:object|undefined=session;const seen=new Set<object>();
 while(current&&sources.has(current)){if(seen.has(current)||seen.size>=16)return undefined;seen.add(current);current=sources.get(current)!();}
 return current;
}
function accessFor(session:object):AuthorizationProfileAccess|undefined { const current=currentSession(session);return current?resolved.get(current):undefined; }
export function bindAuthorizationProfileAccess(session: object, access: AuthorizationProfileAccess): void {
  const current=currentSession(session);if(!current)return;
  resolved.set(current, Object.freeze({ managedEntities: Object.freeze([...access.managedEntities]), operations: Object.freeze({...access.operations}), listFields: Object.freeze(Object.fromEntries(Object.entries(access.listFields ?? {}).map(([entity, fields]) => [entity, Object.freeze([...fields])]))) }));
}
export function inheritAuthorizationProfileAccess(source: object, target: object): void {
  if(source!==target)bindAuthorizationProfileSource(target,()=>source);
}
export function hasAuthorizationProfileAccess(session: object): boolean { return !!accessFor(session); }
/** Undefined preserves the authored defaults. False is an explicit closed policy. */
export function authorizationProfileDecision(session: object | undefined, operation: string, entity: string | undefined): boolean | undefined {
  if(!session||!entity)return undefined;
  const access=accessFor(session);if(!access)return undefined;
  if(Object.hasOwn(access.operations,operation))return access.operations[operation] ?? undefined;
  return access.managedEntities.includes(entity) ? false : undefined;
}

/** Pinned projection: newly authored fields do not silently join a managed list. */
export function authorizationListFields(session: object, entity: string | undefined): readonly string[] | undefined {
  return entity ? accessFor(session)?.listFields?.[entity] : undefined;
}
