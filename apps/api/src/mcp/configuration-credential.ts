// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";

/** Kept server-side, inside the encrypted handoff. Never projected to a tool result. */
export type ConfigurationCredential = {
  authorization: string;
  path: string;
  alias?: string;
  hostname: string;
  protocol: string;
};
const current = new AsyncLocalStorage<{ active: boolean; credential?: ConfigurationCredential | undefined }>();

export async function withConfigurationCredential<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
  const authorization = request.headers.authorization;
  const alias = (request.params as { alias?: unknown } | undefined)?.alias;
  const scope = { active: true, credential: typeof authorization === "string" && /^Bearer /i.test(authorization)
    ? { authorization, path: request.url.split("?")[0]!, hostname: request.hostname, protocol: request.protocol,
      ...(typeof alias === "string" ? { alias } : {}) } : undefined };
  return current.run(scope, async () => { try { return await work(); } finally { scope.active = false; } });
}

export function configurationCredential(): ConfigurationCredential | undefined {
  const scope = current.getStore();
  return scope?.active && scope.credential ? { ...scope.credential } : undefined;
}

/** Re-run ordinary admission on the issuing credential, not serialized roles. */
export function configurationCredentialRequest(credential: ConfigurationCredential): FastifyRequest {
  return { method: "POST", url: credential.path, hostname: credential.hostname, protocol: credential.protocol,
    params: credential.alias ? { alias: credential.alias } : {},
    headers: { authorization: credential.authorization, "content-type": "application/json", host: credential.hostname },
  } as FastifyRequest;
}

/** This can only shorten the handoff; admission still verifies the JWT. */
export function configurationCredentialExpiry(credential: ConfigurationCredential | undefined, maximum: number): number {
  try {
    const payload = credential?.authorization.slice(7).split(".")[1];
    if (!payload) return maximum;
    const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? Math.min(maximum, exp * 1000) : maximum;
  } catch { return maximum; }
}
