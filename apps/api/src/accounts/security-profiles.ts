// SPDX-License-Identifier: BUSL-1.1
import { entityTableName, entityColumnName } from '../db/manifest-lookup.js';
import { operationFailure } from '@openshapeforge/operations';
import { parseSnapshot } from '@openshapeforge/versioning/snapshot';
import { registerPublishFollower } from '@openshapeforge/versioning/followers';
import inventory from '../generated/compiler/authorization-operations.json' with { type: 'json' };
import { validateAuthorizationSafeCondition } from '../generated/compiler/expression-evaluator.js';
import type { CompilerConditionInput } from '../generated/compiler/canonical-condition.js';

export const SECURITY_MANAGE = 'Organization.Security.Manage';
export type SecurityOperation = { id: string; entity: string; defaultRoles: readonly string[]; fields: readonly string[]; fieldTypes?: Readonly<Record<string,string>> };

/** The authored application contract, never tenant profile content, owns the ceiling. */
export function securityOperationCatalog(): SecurityOperation[] {
  return inventory.rows.filter(operation => operation.grantable).map(operation => ({
    id: operation.id, entity: operation.entity, defaultRoles: operation.roles, fields: Object.keys(operation.fields), fieldTypes: Object.fromEntries(Object.entries(operation.fields).map(([key,field]) => [key,field.type])),
  }));
}

function invalid(message: string): never {
  throw operationFailure({ code: 'VALIDATION', message, retryable: false });
}

/** Validate the complete frozen definition, including owned policy rows, before publication commits. */
export function validateAuthorizationProfileSnapshot(value: unknown, operations: readonly SecurityOperation[] = securityOperationCatalog()): void {
  const snapshot = parseSnapshot(value);
  if (snapshot.entity !== 'AuthorizationProfile') invalid('The snapshot is not an authorization profile.');
  const target = snapshot.head.row[entityColumnName('AuthorizationProfile','targetEntity')];
  const policies = Object.values(snapshot.head.children).flat();
  if (!policies.length || policies.length > 100) invalid('A profile needs between one and 100 Operation policies.');
  const seen = new Set<string>();
  for (const policy of policies) {
    if (policy.table !== entityTableName('AuthorizationProfilePolicy').split('.').at(-1)) invalid('The profile contains unsupported owned content.');
    const id = policy.row[entityColumnName('AuthorizationProfilePolicy','operationId')];
    const operation = operations.find(operation => operation.id === id && operation.entity === target);
    if (!operation) invalid('An Operation is unavailable within the application security ceiling.');
    if (seen.has(operation.id)) invalid('An Operation may occur only once in a profile.');
    seen.add(operation.id);
    const condition = policy.row[entityColumnName('AuthorizationProfilePolicy','condition')];
    if (condition === null || condition === undefined) continue;
    const result = validateAuthorizationSafeCondition(condition as CompilerConditionInput);
    if (!result.valid) invalid('The authorization condition is unsupported or invalid.');
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) invalid('The authorization condition is invalid.');
      const record = node as Record<string, unknown>;
      if (record.operator !== undefined) {
        if (!['equals','notEquals','in','notIn','contains','notContains'].includes(String(record.operator))) {
          invalid('The condition operator cannot be enforced at the database boundary.');
        }
        const left = record.left as { kind?: string; path?: string } | undefined;
        const right = record.right as { kind?: string; path?: string; value?:unknown } | undefined;
        if (left?.kind !== 'path' || !left.path?.startsWith('resource.') ||
            (right?.kind === 'path' && !right.path?.startsWith('actorRelation.'))) {
          invalid('A condition must compare a resource field with an actor field or a constant.');
        }
        const type=operation.fieldTypes?.[left!.path!.slice('resource.'.length)];
        if (type) {
          if(right?.kind==='path') {
            const list=['actorRelation.groupIds','actorRelation.roles'].includes(right.path??'');
            if(['in','notIn'].includes(String(record.operator))!==list || ['boolean','integer'].includes(type) || type==='uuid'&&right.path==='actorRelation.roles') invalid('The actor field is not compatible with this resource field and operator.');
          }
          if (['contains','notContains'].includes(String(record.operator)) && type!=='text') invalid('Text matching requires a text field.');
          if (right?.kind==='literal') {
            const values=['in','notIn'].includes(String(record.operator)) ? right.value : [right.value];
            if (!Array.isArray(values) || values.some(value=>type==='boolean' ? typeof value!=='boolean' : type==='integer' ? typeof value!=='number' || !Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647 : typeof value!=='string')) invalid('The condition value does not match the resource field type.');
            if (type==='uuid' && Array.isArray(values) && values.some(value=>typeof value!=='string'|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))) invalid('Use a canonical UUID for this resource field.');
          }
        }

      }
      if (record.kind === 'path') {
        if (typeof record.path !== 'string') invalid('The authorization field is invalid.');
        const [root, field, ...rest] = record.path.split('.');
        if (rest.length || (root === 'resource' && !operation.fields.includes(field!)) ||
            (root === 'actorRelation' && !['userId','relationId','groupIds','roles'].includes(field!))) {
          invalid('The authorization condition names an unavailable field.');
        }
      }
      if (record.kind === 'function' || record.offset !== undefined) invalid('Time-dependent authorization conditions are not supported.');
      for (const key of ['left','right']) if (record[key] !== undefined) visit(record[key]);
      for (const key of ['conditions','all','any']) if (Array.isArray(record[key])) for (const child of record[key]) visit(child);
    };
    visit(condition);
  }
}

let unregister: (() => void) | undefined;
export function registerAuthorizationProfileValidation(): void {
  unregister ??= registerPublishFollower('AuthorizationProfile', async event => {
    validateAuthorizationProfileSnapshot(event.version.snapshot);
  });
}
