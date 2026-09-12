// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type {
  RuntimeDelegatedOperationCapability, RuntimeDurableOperationRequest, RuntimeDurableWorkReference,
  RuntimeOperationDefinition, RuntimeOperationExecutionResult, RuntimeResolvedOperationWork,
  RuntimeWorkerOperationBroker,
} from "@openshapeforge/plugin-runtime";
import { resolveSessionContext } from "../auth/identity.js";
import {
  organizationServiceIdentities, serviceIdentityEndpoint, type OrganizationServiceIdentity,
} from "../auth/organization-service-identities.js";

const failure = (code: string, message: string, retryable = false): RuntimeOperationExecutionResult =>
  ({ error: { code, message, retryable } });

export class DurableAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

function fingerprint(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]));
  }
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

/**
 * Stable execution semantics only. Localised presentation can change without
 * changing an already claimed command, while every server control or schema
 * that can change what the command does remains part of the persisted pin.
 */
function operationContractFingerprint(definition: RuntimeOperationDefinition): string {
  return `sha256:${fingerprint({
    version: 1,
    id: definition.id,
    intent: definition.intent,
    target: definition.target,
    input: definition.input,
    output: definition.output,
    effects: definition.effects,
    reliability: definition.reliability,
    prerequisites: definition.prerequisites,
    concurrency: definition.concurrency,
    interaction: definition.interaction,
  })}`;
}

function workFingerprint(work: RuntimeResolvedOperationWork): string {
  return fingerprint({
    tenantId: work.tenantId,
    serviceIdentityId: work.serviceIdentityId,
    operation: work.operation,
  });
}

function hasWriteEffects(definition: RuntimeOperationDefinition): boolean {
  return definition.effects.data !== "read" || definition.effects.external === "write";
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function safeToRepeat(definition: RuntimeOperationDefinition): boolean {
  return definition.reliability.idempotency.mode !== "none" ||
    (definition.effects.data === "read" && definition.effects.external !== "write");
}

export type DurableWorkerBrokerOptions = {
  /** Bound by core to the actual registered module's persisted claim resolver. */
  resolveWork(reference: RuntimeDurableWorkReference): Promise<RuntimeResolvedOperationWork | undefined>;
  /** Bound to the same module; atomically pins under the exact live claim. */
  pinOperationContract(reference: RuntimeDurableWorkReference, fingerprint: string): Promise<void>;
  identities: readonly OrganizationServiceIdentity[];
  apiUrl: string;
  tokenUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests only. Production uses the ordinary pinned bearer verifier. */
  verify?: (token: string) => Promise<{ tenantId: string | null; userId: string | null; serviceIdentityId: string | null }>;
};

export function createDurableWorkerBroker(options: DurableWorkerBrokerOptions): RuntimeWorkerOperationBroker {
  const api = serviceIdentityEndpoint(options.apiUrl, "Canonical Operation API");
  const tokenUrl = serviceIdentityEndpoint(options.tokenUrl, "Service identity token endpoint");
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const verify = options.verify ?? (async (token: string) => {
    const session = await resolveSessionContext(new Headers({ authorization: `Bearer ${token}` }));
    if (!session.userId) return { ...session, serviceIdentityId: null };
    // Decoding is an ADDITIONAL restriction, only after the ordinary verifier
    // has accepted this exact token. Never a substitute for signature checking.
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    return { ...session, serviceIdentityId: claims.preferred_username === `service-account-${claims.azp}` ? claims.azp : null };
  });
  const capabilities = new WeakMap<object, {
    reference: RuntimeDurableWorkReference; workHash: string; requestHash: string;
    contractFingerprint: string; expiresAt: number;
  }>();
  // A second dispatch within the SAME live claim is also an uncertain retry.
  const dispatchedUnsafeClaims = new Set<string>();

  async function resolved(reference: RuntimeDurableWorkReference) {
    if (!reference || typeof reference.workId !== "string" || !reference.workId ||
      typeof reference.workerId !== "string" || !reference.workerId ||
      !Number.isSafeInteger(reference.attempt) || reference.attempt < 1) {
      throw new DurableAuthorityError("DURABLE_CLAIM_REQUIRED", "De automatische stap heeft geen geldige claim.");
    }
    const work = await options.resolveWork(structuredClone(reference));
    if (!work || !work.operation?.id || !work.operation.idempotencyKey) {
      throw new DurableAuthorityError("DURABLE_CLAIM_LOST", "De automatische stap is niet meer aan deze worker toegewezen.");
    }
    const identity = options.identities.find((candidate) => candidate.tenantId === work.tenantId && candidate.clientId === work.serviceIdentityId);
    if (!identity) throw new DurableAuthorityError("SERVICE_IDENTITY_REQUIRED", "Voor deze organisatie is geen passende automatische identiteit ingesteld.");
    return { work: structuredClone(work), identity };
  }

  async function current(identity: OrganizationServiceIdentity, operationId: string, signal?: AbortSignal) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    const response = await request(tokenUrl, {
      method: "POST", redirect: "error", signal: bounded,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: identity.clientId, client_secret: identity.clientSecret }),
    });
    if (!response.ok) throw new DurableAuthorityError("SERVICE_IDENTITY_UNAVAILABLE", "De automatische identiteit kan niet worden aangemeld.", response.status >= 500);
    const tokenBody = await response.json() as { access_token?: unknown };
    if (typeof tokenBody.access_token !== "string") throw new DurableAuthorityError("SERVICE_IDENTITY_UNAVAILABLE", "De automatische identiteit heeft geen geldig toegangsbewijs ontvangen.");
    const session = await verify(tokenBody.access_token);
    if (session.tenantId !== identity.tenantId || !session.userId || session.serviceIdentityId !== identity.clientId) {
      throw new DurableAuthorityError("SERVICE_IDENTITY_MISMATCH", "De automatische identiteit hoort niet bij deze organisatie.");
    }
    const headers = { authorization: `Bearer ${tokenBody.access_token}` };
    const catalog = await request(new URL(`/api/operations/${encodeURIComponent(operationId)}`, api), { headers, redirect: "error", signal: bounded });
    if (!catalog.ok) throw new DurableAuthorityError("OPERATION_UNAVAILABLE", "Deze operatie is niet beschikbaar voor de actuele automatische identiteit.", catalog.status >= 500);
    const definition = await catalog.json() as RuntimeOperationDefinition;
    if (definition.id !== operationId || !definition.intent ||
      !["none", "natural", "keyed"].includes(definition.reliability?.idempotency?.mode) ||
      !["read", "write", "delete"].includes(definition.effects?.data) ||
      !["none", "read", "write"].includes(definition.effects?.external)) {
      throw new DurableAuthorityError("OPERATION_CONTRACT_INVALID", "De automatische stap heeft geen geldig operatiecontract.");
    }
    return { definition, headers };
  }

  return {
    async authorize(reference) {
      try {
        const { work, identity } = await resolved(reference);
        const { definition } = await current(identity, work.operation.id);
        const contractFingerprint = operationContractFingerprint(definition);
        if (work.operationContractFingerprint &&
          work.operationContractFingerprint !== contractFingerprint) {
          throw new DurableAuthorityError(
            "OPERATION_CONTRACT_CHANGED",
            "De betekenis van deze operatie is gewijzigd nadat de workflowstap werd vastgelegd.",
          );
        }
        // A write reclaimed without a persisted pin may already have run under
        // another contract. Even a currently keyed definition cannot prove
        // what the previous attempt actually executed.
        if (!work.operationContractFingerprint && reference.attempt > 1 && hasWriteEffects(definition)) {
          throw new DurableAuthorityError(
            "OPERATION_OUTCOME_UNKNOWN",
            "Deze schrijfactie kan al uitgevoerd zijn. Controleer het resultaat voordat de workflow doorgaat.",
          );
        }

        try {
          await options.pinOperationContract(structuredClone(reference), contractFingerprint);
        } catch {
          // A database reply may be lost after commit. Re-reading the exact
          // claim distinguishes that safe case without trusting exception text.
        }
        const pinned = await resolved(reference);
        if (workFingerprint(pinned.work) !== workFingerprint(work)) {
          throw new DurableAuthorityError(
            "DURABLE_CLAIM_CHANGED",
            "De automatische stap is tijdens autorisatie gewijzigd.",
          );
        }
        if (!pinned.work.operationContractFingerprint) {
          throw new DurableAuthorityError(
            "DURABLE_CONTRACT_PIN_UNAVAILABLE",
            "Het operatiecontract kon niet veilig aan deze workflowstap worden gekoppeld.",
            true,
          );
        }
        if (pinned.work.operationContractFingerprint !== contractFingerprint) {
          throw new DurableAuthorityError(
            "OPERATION_CONTRACT_CHANGED",
            "De betekenis van deze operatie is gewijzigd nadat de workflowstap werd vastgelegd.",
          );
        }
        if (!safeToRepeat(definition) && (reference.attempt > 1 || dispatchedUnsafeClaims.has(fingerprint(reference)))) {
          throw new DurableAuthorityError("OPERATION_OUTCOME_UNKNOWN", "Deze schrijfactie kan al uitgevoerd zijn. Controleer het resultaat voordat de workflow doorgaat.");
        }
        const capability = Object.freeze({}) as RuntimeDelegatedOperationCapability;
        const result: RuntimeDurableOperationRequest = freeze({
          authority: { mode: "serviceIdentity", serviceIdentityId: work.serviceIdentityId }, capability,
          operation: { operation: { id: definition.id, intent: definition.intent },
            ...(work.operation.input ? { input: work.operation.input } : {}), idempotencyKey: work.operation.idempotencyKey },
        });
        capabilities.set(capability, { reference: structuredClone(reference), workHash: workFingerprint(pinned.work),
          requestHash: fingerprint(result), contractFingerprint, expiresAt: now() + 30_000 });
        return result;
      } catch (error) {
        if (error instanceof DurableAuthorityError) throw error;
        throw new DurableAuthorityError("SERVICE_IDENTITY_UNAVAILABLE", "De automatische stap kan nu niet worden geautoriseerd.", true);
      }
    },
    async execute(input, executionOptions) {
      const capability = input?.capability;
      const minted = capability && capabilities.get(capability);
      if (!minted || now() >= minted.expiresAt || minted.requestHash !== fingerprint(input)) {
        return failure("DURABLE_CAPABILITY_REQUIRED", "De automatische stap heeft geen actuele, passende uitvoerbevoegdheid.");
      }
      capabilities.delete(capability);
      let dispatched = false;
      let repeatable = false;
      try {
        const { work, identity } = await resolved(minted.reference);
        if (minted.workHash !== workFingerprint(work)) return failure("DURABLE_CLAIM_CHANGED", "De automatische stap is na autorisatie gewijzigd.");
        if (work.operationContractFingerprint !== minted.contractFingerprint) {
          return failure("OPERATION_CONTRACT_CHANGED", "De betekenis van deze operatie is gewijzigd nadat de workflowstap werd vastgelegd.");
        }
        // Acquire a NEW token here: retained token roles never authorize a later execution.
        const { definition, headers } = await current(identity, work.operation.id, executionOptions?.signal);
        if (definition.intent !== input.operation.operation.intent ||
          operationContractFingerprint(definition) !== minted.contractFingerprint) {
          return failure("OPERATION_CONTRACT_CHANGED", "De betekenis van deze operatie is gewijzigd.");
        }
        // Token exchange/discovery can take time. Recheck cancellation/fencing
        // immediately before dispatch instead of trusting the earlier read.
        const latest = await resolved(minted.reference);
        if (minted.workHash !== workFingerprint(latest.work) ||
          latest.work.operationContractFingerprint !== minted.contractFingerprint ||
          now() >= minted.expiresAt) {
          return failure("DURABLE_CLAIM_CHANGED", "De automatische stap is gewijzigd of de uitvoerbevoegdheid is verlopen.");
        }
        repeatable = safeToRepeat(definition);
        const claimKey = fingerprint(minted.reference);
        if (!repeatable && (minted.reference.attempt > 1 || dispatchedUnsafeClaims.has(claimKey))) {
          return failure("OPERATION_OUTCOME_UNKNOWN", "Deze schrijfactie kan al uitgevoerd zijn. Controleer het resultaat voordat de workflow doorgaat.");
        }
        if (!repeatable) dispatchedUnsafeClaims.add(claimKey);
        executionOptions?.signal?.throwIfAborted();
        dispatched = true;
        const signal = executionOptions?.signal
          ? AbortSignal.any([executionOptions.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
        const response = await request(new URL(`/api/operations/${encodeURIComponent(definition.id)}/execute`, api), {
          method: "POST", redirect: "error", signal,
          headers: { ...headers, "content-type": "application/json", "idempotency-key": work.operation.idempotencyKey },
          body: JSON.stringify({ intent: definition.intent, input: work.operation.input ?? {} }),
        });
        const result = await response.json() as RuntimeOperationExecutionResult;
        if (!result || typeof result !== "object" || !("data" in result || "error" in result)) throw new Error("Invalid canonical response");
        if (!repeatable && response.status >= 500) {
          return failure("OPERATION_OUTCOME_UNKNOWN", "De schrijfactie gaf een serverfout. Controleer het resultaat voordat de workflow doorgaat.");
        }
        return result;
      } catch (error) {
        if (error instanceof DurableAuthorityError) return failure(error.code, error.message, error.retryable);
        return dispatched && !repeatable
          ? failure("OPERATION_OUTCOME_UNKNOWN", "Het resultaat van de schrijfactie is niet bevestigd. Controleer dit voordat de workflow doorgaat.")
          : failure("OPERATION_TEMPORARILY_UNAVAILABLE", "De automatische stap kan nu niet worden uitgevoerd.", true);
      }
    },
  };
}

export function configuredDurableWorkerBroker(
  resolveWork: DurableWorkerBrokerOptions["resolveWork"],
  pinOperationContract: DurableWorkerBrokerOptions["pinOperationContract"],
  env: NodeJS.ProcessEnv = process.env,
): RuntimeWorkerOperationBroker {
  return createDurableWorkerBroker({ resolveWork, pinOperationContract,
    identities: organizationServiceIdentities(env),
    apiUrl: env.OPENSHAPEFORGE_OPERATION_API_URL ?? "",
    tokenUrl: env.OPENSHAPEFORGE_SERVICE_IDENTITY_TOKEN_URL ?? "" });
}
