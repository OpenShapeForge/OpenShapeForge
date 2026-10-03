// SPDX-License-Identifier: BUSL-1.1
/**
 * #943: the remove paths of a custom role, with the database replaced by one
 * locked row: a stored permission the realm no longer offers can be removed
 * (and is audited as revoked), an unknown one not on the role is refused, it
 * can never be granted, and clearing drops every unavailable one at once.
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const assignable = 'CpqCatalog.Deals.ReadWrite';
const removed = 'CpqCatalog.All.ReadWrite';
const roleId = '00000000-0000-4000-8000-0000000000aa';
type Row = { id: string; label: string; permissions: string[]; version: number };
let row: Row;
let writes: string[][];
let events: Record<string, unknown>[];

// A tagged template that answers the two statements the handlers run against one role row.
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.join('?');
  return { text, values, execute: async () => {
    if (text.startsWith('select')) return { rows: [row] };
    if (text.startsWith('update')) {
      const permissions = (values[0] as { values: string[] }).values;
      writes.push(permissions);
      row = { ...row, permissions, version: row.version + 1 };
      return { rows: [row] };
    }
    throw new Error(`unexpected statement ${text}`);
  } };
}
fakeSql.join = (parts: { values: unknown[] }[]) => ({ values: parts.map(part => part.values[0]) });
mock.module('kysely', () => ({ sql: fakeSql }));
mock.module('../db/session.js', () => ({ withDbSession: async (_db: unknown, _s: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
mock.module('../platform/entity-events.js', () => ({ appendScopedEntityEventInTransaction: async (_tx: unknown, event: Record<string, unknown>) => { events.push(event); } }));
mock.module('../generated/compiler/access-policy.json', () => ({ default: { permissions: [assignable, 'Finance.Quotes.ReadWrite'], roles: [], groups: [] } }));
const { addRolePermission, removeRolePermission, clearUnavailablePermissions } = await import('./custom-roles.js');
const { IDENTITY_LINK_ADMIN_ROLE } = await import('../auth/organization-roles.js');

const context = { db: {}, session: { tenantId: '00000000-0000-4000-8000-000000000001', userId: 'admin', roles: [IDENTITY_LINK_ADMIN_ROLE] } } as never;
const key = `custom:${roleId}`;
beforeEach(() => { row = { id: roleId, label: 'Oud', permissions: [assignable, removed], version: 4 }; writes = []; events = []; });

test('removing a stored permission the realm no longer offers succeeds and is audited as revoked', async () => {
  const result = await removeRolePermission({ key, version: 4, permission: removed }, context) as { value: Record<string, unknown> };
  expect(writes).toEqual([[assignable]]);
  expect(result.value).toMatchObject({ permissions: assignable, version: 5 });
  expect('unavailablePermissions' in result.value).toBe(false);
  expect(events.map(event => event.payload)).toEqual([{ action: 'permission.revoked', permission: removed, actor: 'admin' }]);
});

test('an unknown permission that is not on the role is refused, and nothing is written', async () => {
  const result = await removeRolePermission({ key, version: 4, permission: 'Never.Existed' }, context) as { ok: boolean; status: number };
  expect([result.ok, result.status]).toEqual([false, 400]);
  expect(writes).toEqual([]);
});

test('a permission the realm no longer offers can never be granted', async () => {
  row = { ...row, permissions: [assignable] };
  const result = await addRolePermission({ key, version: 4, permission: removed }, context) as { ok: boolean; status: number };
  expect([result.ok, result.status]).toEqual([false, 400]);
  expect(writes).toEqual([]);
});

test('clearing drops every unavailable permission at once and keeps the assignable ones', async () => {
  row = { ...row, permissions: [assignable, removed, 'Old.Gone.Read'] };
  const result = await clearUnavailablePermissions({ key, version: 4 }, context) as { value: Record<string, unknown> };
  expect(writes).toEqual([[assignable]]);
  expect(result.value).toMatchObject({ permissions: assignable, version: 5 });
  expect(events.map(event => (event.payload as { permission: string }).permission).sort()).toEqual([removed, 'Old.Gone.Read'].sort());
  // Nothing left to clear: answered without a write.
  await clearUnavailablePermissions({ key, version: 5 }, context);
  expect(writes).toHaveLength(1);
});
