// SPDX-License-Identifier: BUSL-1.1
/**
 * CORS for browser API keys on the REST surface.
 *
 * A browser cannot present the key on the preflight (`OPTIONS` carries no
 * `Authorization`), so the preflight cannot know which integration is asking.
 * It is therefore answered generically for any origin, and the decision moves
 * to the actual request, where it belongs:
 *
 *   - the session resolver refuses a browser key whose `Origin` is not one of
 *     the integration's allowed origins or whose request is not one of its
 *     allowed endpoints, and refuses every server key and personal key that
 *     arrives with an `Origin` at all (auth/api-key/restrictions.ts);
 *   - only a response to a request carrying an integration key gets
 *     `Access-Control-Allow-Origin`, so a page can read nothing that was not
 *     made with a key that admitted its origin. Any other request (a bearer
 *     token, a personal key, no credential) is answered without it and stays
 *     unreadable cross-origin, exactly as before.
 *
 * Never `Access-Control-Allow-Credentials`: cookies are not part of this
 * contract, so a preflight that admits an origin admits only requests that
 * carry their credential explicitly. GraphQL keeps its own deployment policy
 * (config/graphql-cors.ts) and is not touched; nor are MCP, the control
 * plane, or a route that answers its own `OPTIONS`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { API_KEY_PREFIX } from "../auth/api-key/format.js";

const PREFLIGHT_METHODS = ["GET", "POST"] as const;
const ALLOWED_HEADERS = "authorization, content-type";
const MAX_AGE_SECONDS = "600";

/** Path prefixes with their own CORS story, or none on purpose. */
const EXCLUDED_PREFIXES = [
  "/api/graphql", "/api/mcp", "/api/control", "/api/entity-configuration", "/api/browser-client",
];

function pathOf(request: FastifyRequest): string {
  const url = request.url ?? "/";
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** Whether this path is part of the REST surface this module covers. */
export function coveredPath(path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function presentsIntegrationKey(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && /^Bearer\s+/i.test(authorization) &&
    authorization.replace(/^Bearer\s+/i, "").startsWith(API_KEY_PREFIX);
}

export function registerApiKeyCors(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "OPTIONS") return;
    const origin = request.headers.origin;
    const requested = request.headers["access-control-request-method"];
    if (typeof origin !== "string" || typeof requested !== "string") return;
    const method = requested.toUpperCase();
    if (!(PREFLIGHT_METHODS as readonly string[]).includes(method)) return;
    const path = pathOf(request);
    if (!coveredPath(path)) return;
    // A route that answers its own OPTIONS keeps it. Whether a GET/POST route
    // exists is not checked: Fastify matches route PATTERNS, not paths, and a
    // preflight for a path that does not exist admits nothing but a 404.
    if (app.hasRoute({ method: "OPTIONS", url: path })) return;
    return reply
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-methods", PREFLIGHT_METHODS.join(", "))
      .header("access-control-allow-headers", ALLOWED_HEADERS)
      .header("access-control-max-age", MAX_AGE_SECONDS)
      .header("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
      .header("cache-control", "no-store")
      .status(204)
      .send();
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || request.method === "OPTIONS") return payload;
    if (!coveredPath(pathOf(request)) || !presentsIntegrationKey(request)) return payload;
    if (reply.hasHeader("access-control-allow-origin")) return payload;
    // The resolver already refused every key that does not admit this origin
    // (restrictions.ts), so a response made with an integration key here was
    // either made for an admitted origin or is that refusal: both readable.
    reply.header("access-control-allow-origin", origin);
    const vary = reply.getHeader("vary");
    reply.header("vary", vary ? `${String(vary)}, Origin` : "Origin");
    return payload;
  });
}
