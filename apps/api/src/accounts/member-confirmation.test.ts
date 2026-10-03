// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import rawCatalog from '../generated/operations/catalog.json' with { type: 'json' };
import { bindOperationHandlers, invokeOperation, type OperationContract } from '../operations/runtime.js';

test('member access Operations enforce acknowledgement before stripping it from handler input', async () => {
  for (const key of ['accounts.request-member-password-reset',
    'accounts.request-member-passkey-recovery', 'accounts.resend-member-invitation', 'accounts.revoke-member-invitation']) {
    const operation = rawCatalog.operations.find(row => row.key === key) as OperationContract;
    expect(operation.confirmation?.mode).toBe('acknowledgement');
    const calls: unknown[] = [];
    const bound = bindOperationHandlers([{ name: 'accounts', operationHandlers: {
      [operation.handler]: async input => { calls.push(input); return { value: { updated: true } }; },
    } }], [operation]).get(key)!;
    const context: any = { transport: 'rest', session: { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(),
      credential: 'bearer', roles: ['Organization.Access.Manage'], groups: [], scope: 'tenant' } };
    const id = crypto.randomUUID();
    await expect(invokeOperation(bound, { id }, context)).rejects.toMatchObject({ operationError: { code: 'CONFIRMATION_REQUIRED' } });
    expect(calls).toEqual([]);
    await expect(invokeOperation(bound, { id, confirmed: true }, context)).resolves.toMatchObject({ value: { updated: true } });
    expect(calls).toEqual([{ id }]);
  }
});
