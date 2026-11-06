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
  connectionTable?: string;
  executionFingerprint?: string;
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

// Only the canonical Operation dispatcher supplies this origin. Request JSON
// cannot choose it, and unrelated nested Operations replace it.
const origin = new AsyncLocalStorage<string>();
export const withConnectionDelegationOrigin = <T>(operation: string, work: () => T): T =>
  withoutConnectionDelegation(() => origin.run(operation, work));
export const connectionDelegationOrigin = (): string | undefined => origin.getStore();

/** Identity projection only. Credential access additionally calls validate. */
export function connectionDelegationIdentity(session: { tenantId?: string | null | undefined; userId?: string | null | undefined }): Identity | undefined {
  const identity = active.getStore()?.identity;
  if (!identity) return undefined;
  if (identity.tenantId !== session.tenantId || identity.actorId !== session.userId) throw refusal();
  return identity;
}
export async function revalidateConnectionDelegation(session: { tenantId?: string | null | undefined; userId?: string | null | undefined }): Promise<Identity | undefined> {
  const identity = connectionDelegationIdentity(session);
  if (identity && !await active.getStore()!.validate()) throw refusal();
  return identity;
}
export function isDelegatedConnection(session: { tenantId?: string | null | undefined; userId?: string | null | undefined }, table: string, row: Record<string, unknown> | undefined): boolean {
  const identity = connectionDelegationIdentity(session);
  return !!identity && identity.connectionTable === table && identity.connectionId === row?.id && identity.ownerRelationId === row?.ownerUserId;
}
