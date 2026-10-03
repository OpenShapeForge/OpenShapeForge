// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import type { ModuleOperationSuccessResult, RuntimeModule } from '../modules/contract.js';
import type { TrustedSessionContext } from '../auth/trusted-context.js';
import { runtimeStaticOperationRegistrations, type OperationContract } from './runtime.js';

// Explicit catalogs keep this executor boundary independent of optional
// example plugins. The real Account catalog/offers are covered by the DB proof.
const operation: OperationContract = {
  key: 'source.get', plugin: 'source', handler: 'get', title: 'Read source', description: 'Read a source record.',
  auth: { mode: 'public' }, tenancy: { mode: 'none' }, idempotency: { mode: 'none' }, errors: [],
  effects: { data: 'read', external: 'none' },
  target: { entityId: 'Source', entityName: 'Source', scope: 'record', inputField: 'id' },
  resultProjection: { kind: 'entity-record', entityName: 'Source', idField: 'id' },
  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  outputSchema: { type: 'object', additionalProperties: false, required: ['data', 'operations'],
    properties: { data: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, operations: { type: 'array' } } },
  transports: { rest: { method: 'GET', path: '/source/:id', response: { kind: 'json', status: 200 } },
    mcp: { enabled: false }, graphql: { enabled: false }, typescript: { enabled: false } },
};
const session: TrustedSessionContext = { tenantId: null, userId: null, roles: [], groups: [], scope: 'self', credential: 'none' };
async function execute(success: ModuleOperationSuccessResult) {
  const modules: RuntimeModule[] = [{ name: 'source', operationHandlers: { get: async () => success } }];
  const registration = runtimeStaticOperationRegistrations(modules, {}, [operation])[0]!;
  return registration.execute(session, { operation: { id: operation.key, intent: 'invoke' }, input: { id: 'source-1' } }, {});
}

test('core wraps the requested raw source record in the canonical envelope', async () => {
  expect(await execute({ value: { id: 'source-1' } })).toEqual({ data: { id: 'source-1' }, operations: [] });
});

test('source adapters cannot substitute targets, omit IDs, or supply their own envelope', async () => {
  for (const value of [{ id: 'different' }, {}, null, [], { data: { id: 'source-1' }, operations: [] }]) {
    expect(await execute({ value })).toMatchObject({ error: { code: 'HANDLER_CONTRACT_VIOLATION' } });
  }
  expect(await execute({ value: { id: 'source-1' }, resultKind: 'operation-envelope' }))
    .toMatchObject({ error: { code: 'HANDLER_CONTRACT_VIOLATION' } });
});
