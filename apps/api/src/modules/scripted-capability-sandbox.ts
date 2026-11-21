// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeScriptedCapabilitySandbox } from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { parseJson, serializeJson, DEFAULT_LIMITS } from "../script-sandbox/protocol.js";
import { ScriptExecutionError } from "../script-sandbox/run-script.js";
import { createSandboxRunner } from "../script-sandbox/socket-channel.js";

const TENANT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function createScriptedCapabilitySandbox(
  acceptsSession: (session: TrustedSessionContext) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeScriptedCapabilitySandbox<TrustedSessionContext> | undefined {
  const socket = env.OPENSHAPEFORGE_SCRIPT_SANDBOX_SOCKET?.trim();
  const configuredTenants = env.OPENSHAPEFORGE_SCRIPT_SANDBOX_PILOT_TENANTS?.trim();
  if (!socket && !configuredTenants) return undefined;
  const tenantIds = configuredTenants?.split(",").map((id) => id.trim().toLowerCase()) ?? [];
  if (!socket || tenantIds.length !== 1 || tenantIds.some((id) => !TENANT_ID.test(id))) {
    throw new Error("Script sandbox pilot requires a private socket and one explicit pilot tenant UUID.");
  }
  const enabledTenants = new Set(tenantIds);
  const evaluate = createSandboxRunner(socket);
  return {
    async evaluateFixture(session, { source, input }, options) {
      if (!session.tenantId || !session.userId || !enabledTenants.has(session.tenantId.toLowerCase()) || !acceptsSession(session)) {
        return { ok: false, code: "sandbox_unavailable" };
      }
      const text = serializeJson(input, DEFAULT_LIMITS.maxInputBytes);
      const fixture = text === null ? null : parseJson(text, DEFAULT_LIMITS.maxInputBytes);
      if (!fixture?.ok || fixture.value === null || typeof fixture.value !== "object" || Array.isArray(fixture.value)) {
        return { ok: false, code: "invalid_input" };
      }
      try {
        const value = await evaluate({ source, input: fixture.value, ...(options?.signal ? { signal: options.signal } : {}) });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: error instanceof ScriptExecutionError ? error.code : "worker_failed" };
      }
    },
  };
}
