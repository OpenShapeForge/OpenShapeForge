// SPDX-License-Identifier: BUSL-1.1
/** Canonical protocol/allowlist gate and optional runtime-module egress owner. */
import type {
  ModuleEgressInvocationSource,
  RuntimeModule,
} from "./contract.js";

export type ModuleEgressDispatch = {
  owner?: RuntimeModule["egress"] | undefined;
  purpose: "provider" | "oauth" | "discovery" | "probe";
  scope: {
    tenantId: string | null;
    actorId: string | null;
    provider: string;
    operation: string;
    kind: "query" | "mutation";
  };
  source?: ModuleEgressInvocationSource | undefined;
};

/** Exact, single-label and arbitrary-depth host grants. */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const candidate = host.toLowerCase();
  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("**.")) {
      const suffix = pattern.slice(2);
      return candidate.endsWith(suffix) && candidate.length > suffix.length;
    }
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (!candidate.endsWith(suffix)) return false;
      const prefix = candidate.slice(0, -suffix.length);
      return prefix.length > 0 && !prefix.includes(".");
    }
    return candidate === pattern;
  });
}

export async function fetchValidatedOutbound(input: {
  target: string | URL | Request;
  init: RequestInit;
  allowlist: readonly string[];
  fallback: (target: string | URL | Request, init: RequestInit) => Promise<Response>;
  dispatch?: ModuleEgressDispatch | undefined;
  denied(url: URL, reason: "protocol" | "host"): Error;
}): Promise<Response> {
  const url = new URL(
    typeof input.target === "string"
      ? input.target
      : input.target instanceof URL
        ? input.target.href
        : input.target.url,
  );
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw input.denied(url, "protocol");
  }
  if (!hostAllowed(url.hostname, input.allowlist)) {
    throw input.denied(url, "host");
  }
  if (!input.dispatch?.owner) {
    return input.fallback(input.target, input.init);
  }

  const allowlist = Object.freeze([...input.allowlist]);
  const scope = Object.freeze({ ...input.dispatch.scope });
  const source = input.dispatch.purpose === "provider" && input.dispatch.source
    ? Object.freeze({ ...input.dispatch.source })
    : undefined;
  const inherited =
    input.target instanceof Request
      ? new Request(input.target, input.init)
      : undefined;
  const hookInit: RequestInit & { duplex?: "half" } = inherited
    ? {
        method: inherited.method,
        headers: inherited.headers,
        ...(inherited.body ? { body: inherited.body, duplex: "half" } : {}),
        cache: inherited.cache,
        credentials: inherited.credentials,
        integrity: inherited.integrity,
        keepalive: inherited.keepalive,
        mode: inherited.mode,
        redirect: inherited.redirect,
        referrer: inherited.referrer,
        referrerPolicy: inherited.referrerPolicy,
        signal: inherited.signal,
      }
    : { ...input.init };
  const init = Object.freeze(hookInit);
  return input.dispatch.owner.fetch({
    url: new URL(url),
    init,
    allowlist,
    purpose: input.dispatch.purpose,
    scope,
    ...(source ? { source } : {}),
    ...(hookInit.signal ? { signal: hookInit.signal } : {}),
  });
}
