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

/** Directory choices share the existing collection-options capability and tenant fences. */
export async function securitySubjectChoices(context:Pick<import('../modules/contract.js').ModuleOperationContext,'db'|'session'>,input:{kind:string;search:string;first:number;after?:string;locale:'en'|'nl'}) {
  if(!context.db||!context.session?.tenantId||!context.session.roles.includes(SECURITY_MANAGE)) invalid('Security management permission required.');
  const {sql}=await import('kysely');
  const {withDbSession}=await import('../db/session.js');
  const session=context.session!;
  if(input.kind==='user')return withDbSession(context.db!,session,async trx=>{
    const rows=(await sql<{value:string;label:string}>`select i.id::text as value,coalesce(i.display_name,'Account') as label
      from platform.identities i join platform.identity_relations ir on ir.identity_id=i.id
      where ir.tenant_id=${session.tenantId}::uuid and ir.status='linked' and not ir.access_blocked
        and (${input.search}='' or i.display_name ilike ${'%'+input.search+'%'} or i.id::text=${input.search})
        and i.id::text>${input.after??''} order by i.id::text limit ${input.first+1}`.execute(trx)).rows;
    const items=rows.slice(0,input.first);return {items,nextCursor:rows.length>input.first?items.at(-1)!.value:null};
  });
  if(input.kind==='role'){
    const {roleCatalog}=await import('./roles.js');
    const {accessPolicy}=await import('./access-policy.js');
    const stored=await withDbSession(context.db!,session,async trx=>(await sql<{value:string;label:string}>`select 'custom:'||id::text as value,label from platform.organization_access_roles where tenant_id=${session.tenantId}::uuid`.execute(trx)).rows);
    const entries=[...inventory.rows.flatMap(operation=>operation.roles),...accessPolicy.permissions].filter(key=>!key.startsWith('Platform.')).map(value=>({value,label:value}));
    entries.push(...roleCatalog(input.locale).map(role=>({value:role.key,label:role.label})),...stored);
    const sorted=[...new Map(entries.map(item=>[item.value,item])).values()].filter(item=>`${item.value} ${item.label}`.toLowerCase().includes(input.search.toLowerCase())).sort((a,b)=>a.value.localeCompare(b.value));
    const after=input.after?sorted.findIndex(item=>item.value===input.after)+1:0,items=sorted.slice(after,after+input.first);
    return {items,nextCursor:sorted.length>after+input.first?items.at(-1)!.value:null};
  }
  if(input.kind==='group'){
    const {getGeneratedCrudTables}=await import('../operations/entity/catalog.js');
    const {listGeneratedEntitiesForTable}=await import('../operations/entity/queries.js');
    const {withAuditContext}=await import('../platform/audit-context.js');
    const table=getGeneratedCrudTables().find(table=>table.source?.authoringEntityName==='RelationGroup');
    if(!table)invalid('The group directory is unavailable.');
    const page=await withAuditContext('RelationGroup.list',session.credential,()=>listGeneratedEntitiesForTable(context.db!,session,table,{limit:input.first,...(input.after?{cursor:input.after}:{}),fixedWhere:[{column:entityColumnName('RelationGroup','status'),value:'active'}],...(input.search?{filter:{name:{contains:input.search}}}:{})}));
    return {items:page.rows.map(row=>({value:String(row[table.primaryKey!]),label:String(row[entityColumnName('RelationGroup','name')]??row[table.primaryKey!])})),nextCursor:page.nextCursor};
  }
  invalid('Choose a user, group or role.');
}
