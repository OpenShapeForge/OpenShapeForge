// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";

type AuditContext = { operationId: string; correlationId: string; actorKind: "person" | "system" | "integration" };
const contexts = new AsyncLocalStorage<AuditContext>();
export function auditContext(): AuditContext | undefined { return contexts.getStore(); }
export function withAuditContext<T>(operationId: string, credential: string | undefined, work: () => T, principalKind?: "person" | "service"): T {
  const parent = contexts.getStore();
  return contexts.run({ operationId, correlationId: parent?.correlationId ?? crypto.randomUUID(),
    actorKind: principalKind === "service" || credential === "api-key" ? "integration" : !credential || credential === "system" ? parent?.actorKind ?? "system" : "person" }, work);
}
