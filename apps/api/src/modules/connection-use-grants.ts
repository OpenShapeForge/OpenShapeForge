// SPDX-License-Identifier: BUSL-1.1
/** Owner-issued, resource-bounded use of an existing personal Connection. */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { RuntimeConnectionUseGrantServices, RuntimeDeclarativeServiceDefinition, RuntimeDeclarativeServiceRequest } from '@openshapeforge/plugin-runtime';
import type { TrustedSessionContext } from '../auth/trusted-context.js';
import type { OpenShapeForgeDatabase } from '../db/connection.js';
import type { DB } from '../generated/db/types.js';
import { resolvePrincipalClass, withDbSession } from '../db/session.js';
import { actingRelationId } from '../db/acting-relation.js';
import { getGeneratedCrudTables } from '../operations/entity/catalog.js';
import { catalogDerivedTools, type GeneratedTable } from '../mcp/catalog.js';
import { runtimeRowByFilter, runtimeRowsByFilter } from '../mcp/session-connections.js';
import { fieldNameForColumn, serializeRow } from '../mcp/catalog-rows.js';
import { loadOrderedBindings } from '../mcp/execution-bindings.js';
import { runtimeJsonSchemas } from './field-schemas.js';
import { HttpError } from '../rest/http-error.js';
import { connectionDelegationOrigin, revalidateConnectionDelegation, withVerifiedConnectionDelegation } from '../mcp/connection-delegation.js';

const refused = () => new HttpError(403, 'CONNECTION_CONSENT_REQUIRED', 'The connection permission is unavailable or no longer valid.');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const connectionGrantFingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const tables = () => new Map(getGeneratedCrudTables().map(table => [table.name, table]));

/** Capture execution metadata, never connection token values. Delegated calls
 * intentionally admit one HTTP binding, with no native/nested effects. */
async function definitionSnapshot(db: OpenShapeForgeDatabase, session: TrustedSessionContext, definition: RuntimeDeclarativeServiceDefinition) {
  const entry = catalogDerivedTools.find(entry => entry.entity === definition.entity);
  const execution = entry?.execution;
  if (!entry || !execution) throw refused();
  const manifest = tables();
  const read = (table: string, filter: Record<string, unknown>) => runtimeRowsByFilter(db, session, manifest, table, filter);
  const service = await runtimeRowByFilter(db, session, manifest, entry.table, { id: definition.id });
  if (!service || service[entry.keyField] !== definition.key || !entry.versionField || String(service[entry.versionField]) !== String(definition.version)) throw refused();
  const bindings = await loadOrderedBindings(execution, service, read);
  if (bindings.length !== 1) throw refused();
  const binding = bindings[0]!;
  const capability = await runtimeRowByFilter(db, session, manifest, execution.operationTable, { id: binding[execution.operationRef] });
  if (!capability) throw refused();
  const adapter = await runtimeRowByFilter(db, session, manifest, execution.providerTable, { id: capability[execution.providerRef] });
  if (!adapter || adapter.transport !== 'rest') throw refused();
  const connectionTable = manifest.get(execution.connectionTable);
  const valuesColumn = connectionTable?.columns.find(column => fieldNameForColumn(column) === execution.connectionValuesField);
  if (!connectionTable || !valuesColumn) throw refused();
  return { fingerprint: connectionGrantFingerprint({ execution, service, binding, capability, adapter }), execution, connectionTable, valuesColumn, providerId: capability[execution.providerRef] };
}

type Grant = { id: string; connection_table: string; values_column: string; connection_id: string; owner_relation_id: string; consumer_operation: string; service_definition: RuntimeDeclarativeServiceDefinition; definition_fingerprint: string; input_schema: Record<string, unknown> };
async function readGrant(db: OpenShapeForgeDatabase, session: TrustedSessionContext, id: string): Promise<Grant | undefined> {
  return withDbSession(db, session, async trx => (await sql<Grant>`select * from platform.connection_use_grants
    where id=${id}::uuid and tenant_id=${session.tenantId}::uuid and revoked_at is null
      and (expires_at is null or expires_at>clock_timestamp())`.execute(trx)).rows[0]);
}
export function createConnectionUseGrantServices(db: OpenShapeForgeDatabase, accepts: (session: TrustedSessionContext) => boolean): RuntimeConnectionUseGrantServices<TrustedSessionContext> {
  const live = (session: TrustedSessionContext) => { if (!accepts(session) || !session.tenantId) throw refused(); };
  const owner = (session: TrustedSessionContext) => {
    live(session);
    const relation = actingRelationId(session);
    if (resolvePrincipalClass(session) !== 'person' || !relation || session.credential !== 'bearer') throw refused();
    return relation;
  };
  return {
    async issue(session, input) {
      const relation = owner(session);
      if (!input.consumerOperation || !input.subject.entity || !input.subject.id || input.inputSchema.type !== 'object' || input.inputSchema.additionalProperties !== false) throw refused();
      // Compiles synchronously, disallowing unknown/remote references. An empty
      // value can be invalid; only a malformed definition is refused here.
      const schemaCheck = runtimeJsonSchemas.validate(input.inputSchema, {});
      if (!schemaCheck.valid && schemaCheck.error.code !== 'VALIDATION_FAILED') throw refused();
      const snapshot = await definitionSnapshot(db, session, input.definition);
      const connection = await runtimeRowByFilter(db, session, tables(), snapshot.execution.connectionTable, { id: input.connectionId });
      if (!connection || connection.ownerUserId !== relation || connection[snapshot.execution.connectionProviderRef] !== snapshot.providerId) throw refused();
      return withDbSession(db, session, async trx => {
        const id = randomUUID();
        await sql`insert into platform.connection_use_grants
          (id,tenant_id,connection_table,values_column,connection_id,owner_relation_id,consumer_operation,subject_entity,subject_id,service_definition,definition_fingerprint,input_schema,issued_by)
          values (${id}::uuid,${session.tenantId}::uuid,${snapshot.execution.connectionTable},${snapshot.valuesColumn.name},${input.connectionId}::uuid,${relation}::uuid,
            ${input.consumerOperation},${input.subject.entity},${input.subject.id}::uuid,${JSON.stringify(input.definition)}::text::jsonb,${snapshot.fingerprint},${JSON.stringify(input.inputSchema)}::text::jsonb,${session.userId}::uuid)`.execute(trx);
        return { id };
      });
    },
    async revoke(session, subject) {
      const relation = owner(session);
      await withDbSession(db, session, async trx => { await sql`update platform.connection_use_grants set revoked_at=clock_timestamp()
        where tenant_id=${session.tenantId}::uuid and subject_entity=${subject.entity} and subject_id=${subject.id}::uuid
          and owner_relation_id=${relation}::uuid and revoked_at is null`.execute(trx); });
    },
    async list(session, subject) {
      live(session);
      return withDbSession(db, session, async trx => (await sql<Grant>`select id, connection_id,consumer_operation,service_definition from platform.connection_use_grants
        where tenant_id=${session.tenantId}::uuid and subject_entity=${subject.entity} and subject_id=${subject.id}::uuid
          and revoked_at is null and (expires_at is null or expires_at>clock_timestamp()) order by issued_at,id`.execute(trx)).rows.map(row => ({ id: row.id, connectionId: row.connection_id, consumerOperation: row.consumer_operation, definition: row.service_definition })));
    },
  };
}

export async function withStoredConnectionGrant<T>(db: OpenShapeForgeDatabase, session: TrustedSessionContext, request: RuntimeDeclarativeServiceRequest, work: () => Promise<T>): Promise<T> {
  if (!request.connectionGrantId) return work();
  const operation = connectionDelegationOrigin();
  if (!operation) throw refused();
  const grant = await readGrant(db, session, request.connectionGrantId);
  if (!grant || grant.consumer_operation !== operation || canonical(grant.service_definition) !== canonical(request.definition) ||
      !runtimeJsonSchemas.validate(grant.input_schema, request.input ?? {}).valid ||
      !request.expectedConnection || !('connectionId' in request.expectedConnection) || request.expectedConnection.connectionId !== grant.connection_id) throw refused();
  const validate = async () => {
    const current = await readGrant(db, session, grant.id);
    if (!current || current.consumer_operation !== operation) return false;
    const snapshot = await definitionSnapshot(db, session, request.definition);
    return snapshot.fingerprint === grant.definition_fingerprint && snapshot.execution.connectionTable === grant.connection_table && snapshot.valuesColumn.name === grant.values_column;
  };
  return withVerifiedConnectionDelegation(session, { tenantId: session.tenantId!, actorId: session.userId!,
    connectionId: grant.connection_id, ownerRelationId: grant.owner_relation_id, operationId: operation, consentId: grant.id, connectionTable: grant.connection_table, executionFingerprint: grant.definition_fingerprint }, validate, work);
}

/** The sole credential-row exception: exact grant, table, owner and tenant.
 * SQL restores the RLS setting before returning, including on exceptions. */
export async function delegatedConnectionRow(trx: Transaction<DB>, session: TrustedSessionContext, table: GeneratedTable, lock = false): Promise<Record<string, unknown> | undefined> {
  const authority = await revalidateConnectionDelegation(session);
  if (!authority) return undefined;
  if (authority.connectionTable !== table.name) throw refused();
  const result = await sql<{ row: Record<string, unknown> | null }>`select app.delegated_connection_row(${authority.consentId}::uuid,${authority.operationId},${lock}) as row`.execute(trx);
  const row = result.rows[0]?.row;
  if (!row) throw refused();
  return serializeRow(table, row);
}
