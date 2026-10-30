// SPDX-License-Identifier: BUSL-1.1
/** Server-only proof: neither request JSON nor signed client context supplies profile decisions. */
export type AuthorizationProfileAccess = {
  managedEntities: readonly string[];
  operations: Readonly<Record<string, boolean | null>>;
  listFields?: Readonly<Record<string, readonly string[]>>;
};
const resolved = new WeakMap<object, AuthorizationProfileAccess>();
export function bindAuthorizationProfileAccess(session: object, access: AuthorizationProfileAccess): void {
  resolved.set(session, Object.freeze({ managedEntities: Object.freeze([...access.managedEntities]), operations: Object.freeze({...access.operations}), listFields: Object.freeze(Object.fromEntries(Object.entries(access.listFields ?? {}).map(([entity, fields]) => [entity, Object.freeze([...fields])]))) }));
}
export function inheritAuthorizationProfileAccess(source: object, target: object): void {
  const access=resolved.get(source);if(access)resolved.set(target,access);
}
export function hasAuthorizationProfileAccess(session: object): boolean { return resolved.has(session); }
/** Undefined preserves the authored defaults. False is an explicit closed policy. */
export function authorizationProfileDecision(session: object | undefined, operation: string, entity: string | undefined): boolean | undefined {
  if(!session||!entity)return undefined;
  const access=resolved.get(session);if(!access)return undefined;
  if(Object.hasOwn(access.operations,operation))return access.operations[operation] ?? undefined;
  return access.managedEntities.includes(entity) ? false : undefined;
}

/** Pinned projection: newly authored fields do not silently join a managed list. */
export function authorizationListFields(session: object, entity: string | undefined): readonly string[] | undefined {
  return entity ? resolved.get(session)?.listFields?.[entity] : undefined;
}
