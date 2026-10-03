// SPDX-License-Identifier: BUSL-1.1
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RuntimeWebhookSecretServices, RuntimeWebhookSignatureInput } from "@openshapeforge/plugin-runtime";
import { decryptSecret, encryptSecret, keyringFromEnv, type SecretKeyring } from "../platform/secrets.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const WEBHOOK_SIGNATURE_WINDOW_SECONDS = 300;
const FIELD = "webhook-signing-secret";
type Provenance = { secret: string; startedBy: string; definitionId: string; serviceIdentityId: string };

/** The same at-rest keyring as elicited Connection secrets; it stays in core. */
export function createWebhookSecretServices(options: {
  acceptsSession(session: TrustedSessionContext): boolean;
  keyring?: SecretKeyring;
  clock?: () => Date;
  serviceIdentity(tenantId: string): string | undefined;
  runVerified<T>(session: TrustedSessionContext, work: (session: TrustedSessionContext) => Promise<T>): Promise<T>;
}): RuntimeWebhookSecretServices<TrustedSessionContext> {
  const keyring = () => options.keyring ?? keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
  const verify = async (input: RuntimeWebhookSignatureInput): Promise<Provenance | undefined> => {
    if (!UUID.test(input.tenantId) || !UUID.test(input.credentialId) || !UUID.test(input.definitionId)
      || !/^[0-9]{10}$/.test(input.timestamp) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.eventId)
      || !/^[a-fA-F0-9]{64}$/.test(input.signature)
      || !(input.body instanceof Uint8Array) || input.body.byteLength > WEBHOOK_MAX_BODY_BYTES) return undefined;
    const now = (options.clock?.() ?? new Date()).getTime() / 1000;
    if (Math.abs(now - Number(input.timestamp)) > WEBHOOK_SIGNATURE_WINDOW_SECONDS) return undefined;
    try {
      const keys = keyring();
      if (!keys) return undefined;
      const provenance = JSON.parse(decryptSecret(keys, `${input.tenantId}:${input.credentialId}`, FIELD, input.storedSecret)) as Provenance;
      if (provenance.definitionId !== input.definitionId || !UUID.test(provenance.startedBy)
        || typeof provenance.secret !== "string" || !provenance.serviceIdentityId
        || options.serviceIdentity(input.tenantId) !== provenance.serviceIdentityId) return undefined;
      const expected = createHmac("sha256", provenance.secret).update(`${input.timestamp}.${input.eventId}.`).update(input.body).digest();
      return timingSafeEqual(expected, Buffer.from(input.signature, "hex")) ? provenance : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    seal: async (session, input) => {
      if (!options.acceptsSession(session) || !session.tenantId || !session.userId || session.credential === "grant") {
        throw new Error("Webhook credential configuration requires a live verified tenant session.");
      }
      if (!UUID.test(input.credentialId) || !UUID.test(input.definitionId) || typeof input.secret !== "string"
        || Buffer.byteLength(input.secret, "utf8") < 32 || Buffer.byteLength(input.secret, "utf8") > 4096) {
        throw new Error("Webhook credentials require an id and a secret between 32 and 4096 bytes.");
      }
      const keys = keyring();
      if (!keys) throw new Error("Webhook secret encryption is not configured.");
      const serviceIdentityId = options.serviceIdentity(session.tenantId);
      if (!serviceIdentityId) throw new Error("Webhook admission requires a configured organization service identity.");
      return encryptSecret(keys, `${session.tenantId}:${input.credentialId}`, FIELD, JSON.stringify({
        secret: input.secret, startedBy: session.userId, definitionId: input.definitionId, serviceIdentityId,
      } satisfies Provenance));
    },
    verify: async (input) => (await verify(input)) !== undefined,
    withVerifiedSignature: async (input, work) => {
      const verified = await verify(input);
      if (!verified) return undefined;
      return options.runVerified({
        tenantId: input.tenantId, userId: verified.startedBy, roles: [], groups: [], relationGroupIds: [],
        scope: "self", credential: "trusted-context",
      }, (session) => work({ session, definitionId: verified.definitionId, serviceIdentityId: verified.serviceIdentityId }));
    },
  };
}
