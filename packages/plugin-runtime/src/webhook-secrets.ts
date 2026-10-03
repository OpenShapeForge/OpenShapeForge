// SPDX-License-Identifier: BUSL-1.1
import type { StoredSecret } from "./secrets.js";

export type RuntimeWebhookSignatureInput = {
  tenantId: string;
  credentialId: string;
  definitionId: string;
  storedSecret: StoredSecret;
  timestamp: string;
  eventId: string;
  signature: string;
  body: Uint8Array;
};

/** Host-owned encryption and verification; neither the keyring nor plaintext is readable. */
export type RuntimeWebhookSecretServices<Session> = {
  /** A live tenant session may seal a credential for its own tenant. */
  seal(session: Session, input: { credentialId: string; definitionId: string; secret: string }): Promise<StoredSecret>;
  /**
   * The plugin supplies its persisted credential row, never caller-selected tenant
   * authority. AAD binds the ciphertext to tenant+credential; wrong inputs fail
   * closed. Protocol: hex HMAC-SHA256(timestamp + "." + eventId + "." + rawBody),
   * timestamp in Unix seconds, at most 300 seconds from the host clock.
   */
  verify(input: RuntimeWebhookSignatureInput): Promise<boolean>;
  /** Only core mints a live session from encrypted issuer provenance, with no issuer roles. */
  withVerifiedSignature<T>(input: RuntimeWebhookSignatureInput,
    work: (verified: { session: Session; definitionId: string; serviceIdentityId: string }) => Promise<T>,
  ): Promise<T | undefined>;
};
