// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from 'bun:test';
import { configurationOwnerPatch } from '../configuration-ownership.js';

const admin = { userId: 'admin-subject', relationId: '11111111-1111-4111-8111-111111111111' };
const employee = { userId: 'employee-subject', relationId: '22222222-2222-4222-8222-222222222222' };

describe('manual provider configuration ownership', () => {
  test('personal OAuth registers the shared organisation client, not an admin sign-in', () => {
    expect(configurationOwnerPatch({ profile: 'oauth2AuthorizationCode', connectionScope: 'user' }, admin))
      .toEqual({ ownerUserId: null });
  });

  test('default personal OAuth scope and tenant OAuth both keep client credentials organisation-owned', () => {
    for (const connectionScope of [undefined, 'tenant']) {
      expect(configurationOwnerPatch({ profile: 'oauth2AuthorizationCode', connectionScope }, admin))
        .toEqual({ ownerUserId: null });
    }
  });

  test('caller-supplied ownership cannot turn shared OAuth client credentials into personal credentials', () => {
    const requested = { ownerUserId: 'another-person' };
    expect({ ...requested, ...configurationOwnerPatch({ profile: 'oauth2AuthorizationCode' }, admin) })
      .toEqual({ ownerUserId: null });
  });

  test('personal non-OAuth credentials remain bound to each verified Relation', () => {
    const auth = { scheme: 'bearer', connectionScope: 'user' };
    expect(configurationOwnerPatch(auth, admin)).toEqual({ ownerUserId: '11111111-1111-4111-8111-111111111111' });
    expect(configurationOwnerPatch(auth, employee)).toEqual({ ownerUserId: '22222222-2222-4222-8222-222222222222' });
    expect({ ownerUserId: 'another-person', ...configurationOwnerPatch(auth, employee) })
      .toEqual({ ownerUserId: '22222222-2222-4222-8222-222222222222' });
  });

  test('a subject without a linked Relation cannot own personal credentials', () => {
    expect(() => configurationOwnerPatch({ connectionScope: 'user' }, { relationId: null }))
      .toThrow('not linked to a person');
  });

  test('ordinary organisation configuration preserves its existing contract', () => {
    expect(configurationOwnerPatch({ scheme: 'bearer' }, admin)).toEqual({});
    expect(configurationOwnerPatch(null, admin)).toEqual({});
  });
});
