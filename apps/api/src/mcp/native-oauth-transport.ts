// SPDX-License-Identifier: BUSL-1.1
import { publicAddresses, resolveAddresses, untilAborted } from "../modules/connection-http-egress.js";
import { boundedAbortSignal, createModuleEgressInvocation, fetchValidatedOutbound, hostAllowed } from "../modules/egress.js";
import type { RuntimeModule } from "../modules/contract.js";
import { readBoundedResponse } from "../modules/outbound-response.js";
import { HttpError } from "../rest/http-error.js";
import { MAX_METADATA_BYTES, type MetadataFetch } from "./native-oauth-discovery.js";
import type { RegistrationFetch } from "./native-oauth-registration.js";

type OAuthEgressInput = {
  owner: RuntimeModule["egress"] | undefined;
  allowlist: readonly string[];
  tenantId: string;
  actorId: string;
  provider: string;
  signal?: AbortSignal;
  /** Test seam; production resolves through Node's DNS. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
};

/** Anonymous setup uses the Adapter's hosts and the same pinned DNS policy as Connection calls. */
function createOAuthSetupFetch(input: OAuthEgressInput) {
  return async ({ url, maxResponseBytes, body }: { url: string; maxResponseBytes: number; body?: string }) => {
    if (input.owner?.pinsResolvedAddresses !== true) {
      throw new HttpError(503, "EGRESS_OWNER_REQUIRED", "OAuth discovery requires a DNS-pinning egress owner.");
    }
    let target: URL;
    try { target = new URL(url); } catch { throw new HttpError(403, "EGRESS_DENIED", "Invalid OAuth discovery target."); }
    if (target.protocol !== "https:" || target.username || target.password || target.hash) {
      throw new HttpError(403, "EGRESS_DENIED", "Invalid OAuth discovery target.");
    }
    if (!hostAllowed(target.hostname, input.allowlist)) {
      throw new HttpError(403, "EGRESS_DENIED", "OAuth discovery target is outside the Adapter's allowed hosts.");
    }
    const signal = boundedAbortSignal(input.signal, 8_000);
    const invocation = createModuleEgressInvocation({ owner: input.owner, purpose: "discovery", scope: {
      tenantId: input.tenantId, actorId: input.actorId, provider: input.provider,
      operation: body === undefined ? "mcp.oauth.metadata" : "mcp.oauth.registration",
      kind: body === undefined ? "query" : "mutation",
    } });
    try {
      const resolvedAddresses = await publicAddresses(target, input.resolve ?? resolveAddresses, signal);
      if (body !== undefined && Buffer.byteLength(body, "utf8") > 16 * 1024) throw new HttpError(400, "VALIDATION", "OAuth registration request is too large.");
      const response = await untilAborted(fetchValidatedOutbound({
        target, init: { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }), redirect: "manual", signal },
        allowlist: input.allowlist, resolvedAddresses, dispatch: invocation.dispatch,
        fallback: () => { throw new Error("A pinned egress owner is required."); },
        denied: () => new HttpError(403, "EGRESS_DENIED", "OAuth discovery target is outside the Adapter's allowed hosts."),
      }), signal, late => void late.body?.cancel().catch(() => {}));
      if (response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new HttpError(403, "EGRESS_DENIED", "OAuth discovery redirected unexpectedly.");
      }
      const responseBody = await readBoundedResponse(response, Math.min(maxResponseBytes, MAX_METADATA_BYTES), signal);
      return { status: response.status, contentType: response.headers.get("content-type"), body: responseBody };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (signal.aborted) throw new HttpError(504, "PROVIDER_TIMEOUT", "OAuth discovery timed out.");
      throw new HttpError(502, "PROVIDER_ERROR", "OAuth discovery could not reach the provider.");
    }
  };
}

export function createOAuthMetadataFetch(input: OAuthEgressInput): MetadataFetch {
  return createOAuthSetupFetch(input);
}

export function createOAuthRegistrationFetch(input: OAuthEgressInput): RegistrationFetch {
  return createOAuthSetupFetch(input);
}
