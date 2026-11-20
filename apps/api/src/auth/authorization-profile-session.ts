// SPDX-License-Identifier: BUSL-1.1
import type { AuthorizationRuleState } from './authorization-profile-sql.js';
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../db/connection.js';
import { withDbSession, type DbSessionInput } from '../db/session.js';
import { bindAuthorizationProfileAccess, hasAuthorizationProfileAccess } from './authorization-profile-decision.js';
export type AuthorizationProfileRules={actor:Record<string,unknown>;managedEntities:string[];states:Record<string,AuthorizationRuleState & {entity:string;listFields?:string[];integrationRead?:boolean}>};
export async function resolveAuthorizationProfileAccess<T extends DbSessionInput>(session:T, db:OpenShapeForgeDatabase|undefined):Promise<T>{
 if(!db||!session.tenantId||!session.userId||hasAuthorizationProfileAccess(session))return session;
 const rules=await withDbSession(db,session,async trx=>(await sql<{rules:AuthorizationProfileRules}>`select nullif(current_setting('app.authorization_rules',true),'')::jsonb as rules`.execute(trx)).rows[0]?.rules);
 bindAuthorizationProfileRules(session,rules);
 return session;
}

export function bindAuthorizationProfileRules(session:object,rules:AuthorizationProfileRules|undefined):void {
  if (!rules) return;
  const states = Object.entries(rules.states);
  bindAuthorizationProfileAccess(session, {
    managedEntities: rules.managedEntities,
    listFields: Object.fromEntries(states
      .filter(([id, state]) => state.managed && !state.integrationRead && id === `${state.entity}.list`)
      .map(([, state]) => [state.entity, Array.isArray(state.listFields) ? state.listFields : []])),
    operations: Object.fromEntries(states.map(([id, state]) => [
      id,
      state.managed ? state.grantable && Array.isArray(state.rules) && state.rules.length > 0 : null,
    ])),
  });
}
