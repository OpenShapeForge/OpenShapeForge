import { expect, test } from 'bun:test';
import type { TrustedSessionContext } from '../auth/trusted-context.js';
import { withVerifiedConnectionDelegation, withoutConnectionDelegation, verifiedConnectionDelegation, withConnectionDelegationOrigin, connectionDelegationOrigin, isDelegatedConnection } from './connection-delegation.js';
const session = { tenantId: 'tenant', userId: 'service' } as TrustedSessionContext;
const identity = { tenantId: 'tenant', actorId: 'service', connectionId: 'connection', ownerRelationId: 'owner', operationId: 'availability', consentId: 'consent' };
test('revocation is checked at the credential boundary, not only admission', async () => {
  let allowed = true;
  await withVerifiedConnectionDelegation(session, identity, async () => allowed, async () => {
    expect(await verifiedConnectionDelegation(session, 'connection', 'availability')).toEqual(identity);
    allowed = false;
    await expect(verifiedConnectionDelegation(session, 'connection', 'availability')).rejects.toThrow();
  });
  expect(await verifiedConnectionDelegation(session, 'connection', 'availability')).toBeUndefined();
});
test('authority cannot cross tenant, actor, operation or connection', async () => {
  await withVerifiedConnectionDelegation(session, identity, async () => true, async () => {
    for (const [subject, connection, operation] of [
      [{ ...session, tenantId: 'other' }, 'connection', 'availability'],
      [{ ...session, userId: 'other' }, 'connection', 'availability'],
      [session, 'other', 'availability'], [session, 'connection', 'mail'],
    ] as const) await expect(verifiedConnectionDelegation(subject, connection, operation)).rejects.toThrow();
    expect(await withoutConnectionDelegation(() => verifiedConnectionDelegation(session, 'connection', 'availability'))).toBeUndefined();
  });
});
test('nested authority cannot widen an existing delegation', async () => {
  await withVerifiedConnectionDelegation(session, identity, async () => true, async () => {
    await expect(withVerifiedConnectionDelegation(session, identity, async () => true, async () => undefined)).rejects.toThrow();
  });
});

test('canonical origin replaces unrelated nested authority and is isolated between concurrent invocations', async()=>{
  const jobs=['availability','booking'].map(operation=>withConnectionDelegationOrigin(operation,async()=>{
    await Promise.resolve();
    expect(connectionDelegationOrigin()).toBe(operation);
    await withVerifiedConnectionDelegation(session,{...identity,operationId:operation,connectionTable:'integration.connections'},async()=>true,async()=>{
      expect(isDelegatedConnection(session,'integration.connections',{id:'connection',ownerUserId:'owner'})).toBe(true);
      expect(isDelegatedConnection(session,'integration.connections',{id:'other',ownerUserId:'owner'})).toBe(false);
      expect(isDelegatedConnection(session,'other.connections',{id:'connection',ownerUserId:'owner'})).toBe(false);
      await withConnectionDelegationOrigin('unrelated',async()=>{
        expect(connectionDelegationOrigin()).toBe('unrelated');
        expect(await verifiedConnectionDelegation(session,'connection',operation)).toBeUndefined();
      });
      expect(await verifiedConnectionDelegation(session,'connection',operation)).toBeDefined();
    });
  }));
  await Promise.all(jobs);
  expect(connectionDelegationOrigin()).toBeUndefined();
});
