// SPDX-License-Identifier: BUSL-1.1
/** Core-private, single-invocation authority to use one owner's Connection.
 * An expected Connection is never a grant. Only a verified owner-consent policy
 * may mint this authority, and every credential boundary revalidates it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from '../rest/http-error.js';
import type { TrustedSessionContext } from '../auth/trusted-context.js';

type Identity = Readonly<{
  tenantId: string;
  actorId: string;
  connectionId: string;
  ownerRelationId: string;
  operationId: string;
  consentId: string;
}>;

type Authority = { readonly identity: Identity; readonly validate: () => Promise<boolean> };
const active = new AsyncLocalStorage<Authority | null>();
const refusal = () => new HttpError(403, 'CONNECTION_CONSENT_REQUIRED', 'The calendar permission is unavailable or no longer valid.');

/** Internal only: invoke after the host resolves the registered domain policy.
 * Nested unrelated operations must enter withoutConnectionDelegation.
 */
export async function withVerifiedConnectionDelegation<T>(
  session: TrustedSessionContext,
  identity: Identity,
  validate: () => Promise<boolean>,
  work: () => Promise<T>,
): Promise<T> {
  if (!session.tenantId || !session.userId || identity.tenantId !== session.tenantId || identity.actorId !== session.userId ||
      !identity.connectionId || !identity.ownerRelationId || !identity.operationId || !identity.consentId || active.getStore()) throw refusal();
  if (!await validate()) throw refusal();
  return active.run({ identity: Object.freeze({ ...identity }), validate }, work);
}

export function withoutConnectionDelegation<T>(work: () => T): T {
  return active.run(null, work);
}

/** A permission can be revoked after resolution but before a provider call. */
export async function verifiedConnectionDelegation(
  session: TrustedSessionContext, connectionId: string, operationId: string,
): Promise<Identity | undefined> {
  const authority = active.getStore();
  if (!authority) return undefined;
  const identity = authority.identity;
  if (identity.tenantId !== session.tenantId || identity.actorId !== session.userId ||
      identity.connectionId !== connectionId || identity.operationId !== operationId || !await authority.validate()) throw refusal();
  return identity;
}
