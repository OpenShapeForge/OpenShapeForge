// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { tenantSettingDefaultsOf } from './tenant-setting-defaults.js';

const secret = { namespace: 'example.provider', key: 'api-key', definition: {
  key: 'value', osfType: 'string', classification: { sensitivity: 'confidential' as const },
} };
test('default variables share canonical typed definitions; secrets begin unset', () => {
  const defaults = tenantSettingDefaultsOf([{ tenantSettingDefaults: [secret, {
    namespace: 'example.notifications', key: 'enabled', definition: { key: 'value', osfType: 'boolean' }, value: false,
  }] }]);
  expect(defaults.map(row => [row.namespace, row.key])).toEqual([
    ['appearance', 'colors'], ['example.provider', 'api-key'], ['example.notifications', 'enabled'],
  ]);
  expect(defaults[1]!.value).toBeUndefined(); expect(defaults[2]!.value).toBe(false);
});
test('ambiguous slots, plaintext secrets and invalid typed defaults fail before persistence', () => {
  expect(() => tenantSettingDefaultsOf([{ tenantSettingDefaults: [secret, secret] }])).toThrow('Duplicate');
  expect(() => tenantSettingDefaultsOf([{ tenantSettingDefaults: [{ ...secret, value: 'do-not-store' }] }])).toThrow('must be unset');
  expect(() => tenantSettingDefaultsOf([{ tenantSettingDefaults: [{ ...secret, definition: { key: 'value', osfType: 'object', children: [{ ...secret.definition, key: 'nested' }] }, value: { nested: 'do-not-store' } }] }])).toThrow('must be unset');
  expect(() => tenantSettingDefaultsOf([{ tenantSettingDefaults: [{ namespace: 'example', key: 'flag', definition: { key: 'value', osfType: 'boolean' }, value: 'yes' }] }])).toThrow('Invalid typed');
  expect(() => tenantSettingDefaultsOf([{ tenantSettingDefaults: [{ ...secret, definition: { key: 'wrong', osfType: 'string' } }] }])).toThrow('Invalid typed');
});
