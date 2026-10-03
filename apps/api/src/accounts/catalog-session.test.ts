// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { accessSession } from './custom-roles.js';
import { ACCOUNT_MANAGE, ACCOUNT_READ } from './account-session.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../auth/organization-roles.js';

const context = (roles: string[]) => ({ db: {}, session: {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: 'account-manager', roles, groups: [], scope: 'tenant',
} }) as any;

test('an Account manager can inspect the role catalog but cannot manage role definitions', () => {
  expect(accessSession(context([ACCOUNT_MANAGE]), 'catalog').roles).toEqual([ACCOUNT_MANAGE]);
  expect(() => accessSession(context([ACCOUNT_MANAGE]))).toThrow('Organization administrator required.');
});

test('Account readers and business-domain readers do not inherit catalog or definition management', () => {
  for (const roles of [[ACCOUNT_READ], ['Relations.All.ReadWrite'], []]) {
    expect(() => accessSession(context(roles), 'catalog')).toThrow('Organization administrator required.');
    expect(() => accessSession(context(roles))).toThrow('Organization administrator required.');
  }
});

test('existing organization access administrators retain both capabilities', () => {
  expect(accessSession(context([IDENTITY_LINK_ADMIN_ROLE]), 'catalog').roles).toEqual([IDENTITY_LINK_ADMIN_ROLE]);
  expect(accessSession(context([IDENTITY_LINK_ADMIN_ROLE])).roles).toEqual([IDENTITY_LINK_ADMIN_ROLE]);
});

test('catalog access fails closed without authenticated tenant context or a database', () => {
  expect(() => accessSession({ db: {} } as any, 'catalog')).toThrow('Sign in first.');
  const missingTenant = context([ACCOUNT_MANAGE]); missingTenant.session.tenantId = null;
  expect(() => accessSession(missingTenant, 'catalog')).toThrow('Sign in first.');
  const missingDb = context([ACCOUNT_MANAGE]); missingDb.db = null;
  expect(() => accessSession(missingDb, 'catalog')).toThrow('Database unavailable.');
});
