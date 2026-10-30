// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from 'kysely';
import type { CompilerConditionInput } from '../generated/compiler/canonical-condition.js';

export type AuthorizationRuleState = {
  managed: boolean; grantable: boolean;
  fields: Record<string,{column:string;type:string}>;
  rules: CompilerConditionInput[];
};
/** Indexable query admission for the canonical matcher. RLS remains the authoritative backstop. */
export function authorizationProfilePredicate(state:AuthorizationRuleState|undefined, actor:Record<string,unknown>, alias:string):RawBuilder<unknown> {
  if(!state?.managed)return sql`true`;
  if(!state.grantable||!Array.isArray(state.rules)||!state.rules.length)return sql`false`;
  const operand=(value:unknown):unknown=>{
    if(!value||typeof value!=='object')return undefined;
    const node=value as Record<string,unknown>;
    if(node.kind==='literal')return node.value;
    if(node.kind==='path'&&typeof node.path==='string'){
      const [root,key,...rest]=node.path.split('.');
      if(root==='actorRelation'&&key&&!rest.length&&Object.hasOwn(actor,key))return actor[key];
    }
    return undefined;
  };
  const visit=(value:unknown,depth=0):RawBuilder<unknown>=>{
    if(value===null)return sql`true`;
    if(!value||typeof value!=='object'||depth>16)return sql`false`;
    const node=value as Record<string,unknown>;
    const children=node.conditions??node.all??node.any;
    if(children!==undefined){
      if(!Array.isArray(children)||!children.length||children.length>200)return sql`false`;
      const mode=node.mode??(node.any?'any':'all');
      if(mode!=='all'&&mode!=='any')return sql`false`;
      return sql`(${sql.join(children.map(child=>visit(child,depth+1)),mode==='all'?sql` and `:sql` or `)})`;
    }
    const left=node.left as {kind?:string;path?:string}|undefined;
    const path=left?.path?.split('.');
    if(left?.kind!=='path'||path?.length!==2||path[0]!=='resource')return sql`false`;
    const field=state.fields[path[1]!];
    if(!field)return sql`false`;
    const right=operand(node.right);
    const column=sql.id(alias,field.column);
    const typed=(value:unknown):RawBuilder<unknown>|undefined=>{
      if(field.type==='text'&&typeof value==='string')return sql`${value}::text`;
      if(field.type==='uuid'&&typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return sql`${value}::uuid`;
      if(field.type==='boolean'&&typeof value==='boolean')return sql`${value}::boolean`;
      if(field.type==='integer'&&typeof value==='number'&&Number.isInteger(value)&&value>=-2147483648&&value<=2147483647)return sql`${value}::integer`;
      return undefined;
    };
    if(node.operator==='in'||node.operator==='notIn'){
      if(!Array.isArray(right)||!right.length||right.length>100)return sql`false`;
      const values=right.map(typed);
      if(values.some(value=>!value))return sql`false`;
      return node.operator==='in'?sql`${column} in (${sql.join(values as RawBuilder<unknown>[])})`:sql`${column} not in (${sql.join(values as RawBuilder<unknown>[])})`;
    }
    const parameter=typed(right);
    if(!parameter)return sql`false`;
    if(node.operator==='equals')return sql`${column}=${parameter}`;
    if(node.operator==='notEquals')return sql`${column}<>${parameter}`;
    if(field.type==='text'&&node.operator==='contains')return sql`strpos(${column},${parameter})>0`;
    if(field.type==='text'&&node.operator==='notContains')return sql`strpos(${column},${parameter})=0`;
    return sql`false`;
  };
  return sql`(${sql.join(state.rules.map(rule=>visit(rule)),sql` or `)})`;
}
