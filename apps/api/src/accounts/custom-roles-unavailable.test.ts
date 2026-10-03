// SPDX-License-Identifier: BUSL-1.1
/**
 * #943: a custom role that stored a permission the realm no longer offers
 * (CpqCatalog.All.ReadWrite, split by #917) used to lose it silently: the
 * view and the session both filtered it away. The session still ignores it —
 * it grants nothing — but the administrator now sees it.
 */
import { expect, mock, test } from 'bun:test';

const assignable = 'CpqCatalog.Deals.ReadWrite';
const removed = 'CpqCatalog.All.ReadWrite';
// The realm's assignable vocabulary after #917, independent of which artifacts were generated here.
const policy = { permissions: [assignable, 'Finance.Quotes.ReadWrite'], roles: [], groups: [] };
mock.module('../generated/compiler/access-policy.json', () => ({ default: policy }));
const { accessPolicy } = await import('./access-policy.js');
const { roleView, unavailablePermissions } = await import('./custom-roles.js');

test('a stored permission that is no longer assignable is shown, not silently dropped', () => {
  expect(accessPolicy.permissions).not.toContain(removed);
  expect(unavailablePermissions([assignable, removed, removed])).toEqual([removed]);
  const view = roleView({ id: '00000000-0000-4000-8000-000000000001', label: 'Oud', permissions: [assignable, removed], version: 3 });
  expect(view.permissions).toBe(assignable);
  expect(view.unavailablePermissions).toBe(removed);
});

test('a role with only assignable permissions carries no unavailable list', () => {
  const view = roleView({ id: '00000000-0000-4000-8000-000000000002', label: 'Nieuw', permissions: [assignable], version: 1 });
  expect('unavailablePermissions' in view).toBe(false);
});
