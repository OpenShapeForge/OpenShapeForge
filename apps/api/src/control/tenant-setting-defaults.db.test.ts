// SPDX-License-Identifier: BUSL-1.1
/** Opt-in local PostgreSQL proof. All fixture rows roll back; no reset or external identity calls. */
import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabaseRuntime } from '../db/connection.js';
import { withSystemSession, SYSTEM_BYPASS_ROLE } from '../db/session.js';
import { encryptSecret, keyringFromEnv } from '@openshapeforge/plugin-runtime/secrets';
import { ensureTenantSettingDefaults, tenantSettingDefaultsOf } from './tenant-setting-defaults.js';

const url = process.env.TENANT_SETTING_DEFAULTS_TEST_URL;
const rollback = new Error('ROLLBACK_DEFAULTS_FIXTURE');
(url ? test : test.skip)('new tenant defaults are isolated and replay preserves saved ciphertext, choices and versions', async () => {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url!).hostname)) throw new Error('Local database required.');
  const runtime = createDatabaseRuntime({ databaseUrl: url!, maxConnections: 1 });
  const ids = [randomUUID(), randomUUID()];
  const defaults = tenantSettingDefaultsOf([{ tenantSettingDefaults: [
    { namespace: 'example.provider', key: 'api-key', definition: { key: 'value', osfType: 'string', classification: { sensitivity: 'confidential' } } },
    { namespace: 'example.chat', key: 'configuration', definition: { key: 'value', osfType: 'object', children: [{ key: 'model', osfType: 'string' }] } },
  ] }]);
  let checked = false;
  try {
    await withSystemSession(runtime.db, { actorSubject: 'tenant-defaults-transaction-test', roles: [SYSTEM_BYPASS_ROLE], reason: 'Test missing tenant-variable defaults with rolled-back fixtures' }, async trx => {
      for (const id of ids) {
        const slug = `defaults-proof-${id}`;
        await sql`insert into platform.tenants(id,slug,name,status) values(${id}::uuid,${slug},'Defaults test','active')`.execute(trx);
        await sql`insert into erp.tenants(id,tenant_id,slug,name) values(${id}::uuid,${id}::uuid,${slug},'Defaults test')`.execute(trx);
        expect(await ensureTenantSettingDefaults(trx, id, defaults)).toBe(3);
      }
      const [first, second] = await Promise.all(ids.map(id => sql<{id:string;definition:Record<string,unknown>;value:unknown;updated_at:unknown;namespace:string;key:string}>`select id,definition,value,updated_at,namespace,key from erp.tenant_settings where tenant_id=${id}::uuid order by namespace,key`.execute(trx)));
      expect(first.rows).toHaveLength(3); expect(second.rows).toHaveLength(3);
      expect([...first.rows,...second.rows].every(row => row.definition?.key === "value")).toBe(true);
      expect(first.rows.find(row => row.namespace === "appearance")!.value).toEqual({colors: []});
      expect(first.rows.map(row => row.id).some(id => second.rows.some(row => row.id === id))).toBe(false);
      const key = first.rows.find(row => row.key === 'api-key')!;
      const encrypted = encryptSecret(keyringFromEnv(`test:${Buffer.alloc(32,11).toString('base64')}`)!, `${ids[0]}:erp.tenant_settings:${key.id}`, 'value', 'synthetic-only');
      await sql`update erp.tenant_settings set value=${JSON.stringify(encrypted)}::text::jsonb where id=${key.id}::uuid`.execute(trx);
      await sql`update erp.tenant_settings set value='{"model":"saved-test-model"}'::jsonb where tenant_id=${ids[0]}::uuid and namespace='example.chat'`.execute(trx);
      expect((await sql<{value:unknown}>`select value from erp.tenant_settings where id=${key.id}::uuid`.execute(trx)).rows[0]!.value).toEqual(encrypted);
      const before = (await sql`select * from erp.tenant_settings where tenant_id=${ids[0]}::uuid order by namespace,key`.execute(trx)).rows;
      expect(await ensureTenantSettingDefaults(trx, ids[0]!, defaults)).toBe(0);
      expect((await sql`select * from erp.tenant_settings where tenant_id=${ids[0]}::uuid order by namespace,key`.execute(trx)).rows).toEqual(before);
      expect((await sql<{value:unknown}>`select value from erp.tenant_settings where tenant_id=${ids[1]}::uuid and namespace='example.provider'`.execute(trx)).rows[0]!.value).toBeNull();
      checked = true;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  finally { await runtime.close(); }
  expect(checked).toBe(true);
}, 30000);
