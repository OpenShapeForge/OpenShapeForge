// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionCredential } from "../auth/trusted-context.js";
type ActorKind = "person" | "system" | "integration" | "unknown";
export type AuditContext = { operationId: string; correlationId: string; actorKind: ActorKind };
const credentialActors = { none: "system", bearer: "unknown", "api-key": "integration", "trusted-context": "unknown", "control-bearer": "person", grant: "integration" } satisfies Record<SessionCredential, ActorKind>;
const contexts = new AsyncLocalStorage<AuditContext>();
export function auditContext(): AuditContext | undefined { return contexts.getStore(); }
export function runWithAuditContext<T>(context: AuditContext, work: () => T): T { return contexts.run(context, work); }
export function withAuditContext<T>(operationId: string, credential: SessionCredential | undefined, work: () => T, principalKind?: "person" | "service"): T {
  const parent = contexts.getStore();
  return contexts.run({ operationId, correlationId: parent?.correlationId ?? crypto.randomUUID(),
    actorKind: principalKind === "service" ? "integration" : principalKind === "person" ? "person" : parent?.actorKind ?? (credential ? credentialActors[credential] : "system") }, work);
}
