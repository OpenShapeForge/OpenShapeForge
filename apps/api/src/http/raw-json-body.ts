// SPDX-License-Identifier: BUSL-1.1
/**
 * The API's `application/json` body parser: hand the route the exact bytes.
 *
 * Fastify's default parses JSON into an object, which two surfaces cannot
 * live with:
 *
 *  - GraphQL, which forwards the request to Yoga and would otherwise forward a
 *    reserialization of it (`roles/api.ts`, `bodyFromFastify`);
 *  - inbound provider deliveries, whose HMAC covers the bytes a provider sent.
 *    A body parsed and re-encoded on the way in looks exactly like a provider
 *    sending a wrong signature, which is the worst failure to debug.
 *
 * Extracted so both the server and a focused test configure the same thing
 * rather than a lookalike, and so the reason is written down once.
 */
import type { FastifyInstance } from "fastify";

export function useRawJsonBody(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
}
