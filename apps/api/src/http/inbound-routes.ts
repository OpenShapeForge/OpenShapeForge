// SPDX-License-Identifier: BUSL-1.1
/**
 * The public inbound delivery route: `POST /api/inbound/:endpointKey/:endpointId`.
 *
 * UNAUTHENTICATED by necessity, like the connector OAuth callback — a provider
 * attaches none of our credentials. Everything that makes it safe is the HMAC
 * over the exact bytes (modules/inbound-admission.ts): the URL selects a
 * candidate registration and proves nothing, and the tenant is read from that
 * registration rather than from the path.
 *
 * ## The bytes
 *
 * A signature is over what the provider sent, so the handler must see those
 * bytes and never a reserialization of them. It does, because the host installs
 * `useRawJsonBody` (http/raw-json-body.ts), which hands every route a Buffer.
 * This route deliberately does NOT install or remove parsers of its own: a
 * parser registered here would be one more place where the API's body handling
 * is decided, and it would still have to agree with the one above.
 *
 * For the same reason the route serves `application/json` and nothing else.
 * Jira Cloud's admin webhooks are JSON; a provider that signs some other
 * content type is a concrete gap to close by widening the host's raw-body
 * parsing deliberately, not by accepting whatever a parser happens to produce.
 *
 * ## The answers
 *
 *   202  accepted | duplicate — the receipt and its dispatch work are COMMITTED.
 *   404  rejected — unknown, revoked, unsigned, malformed or forged, all alike,
 *        so the route cannot be used to enumerate registrations. Terminal: a
 *        forged delivery must not be retried by the provider forever.
 *   415  a body this route cannot prove the bytes of.
 *   503  unavailable — the host's own problem. Retryable, and never the answer
 *        to a delivery that was in fact kept.
 */
import type { FastifyInstance } from "fastify";
import { INBOUND_MAX_BODY_BYTES } from "../platform/inbound-signature.js";
import type { InboundAdmission } from "../modules/inbound-admission.js";
import { INBOUND_MOUNT_PATH } from "./inbound-path.js";

export { INBOUND_MOUNT_PATH, inboundEndpointPath } from "./inbound-path.js";

export type InboundRouteOptions = {
  /** Absent without a database: the route then answers 503, never 404. */
  admit?: InboundAdmission | undefined;
};

const NOT_FOUND = {
  error: { code: "NOT_FOUND", message: "No inbound endpoint accepted this delivery.", retryable: false },
} as const;

const UNAVAILABLE = {
  error: { code: "SERVICE_UNAVAILABLE", message: "The delivery could not be stored; please retry.", retryable: true },
} as const;

export function registerInboundRoutes(app: FastifyInstance, options: InboundRouteOptions): void {
  app.post<{ Params: { endpointKey: string; endpointId: string } }>(
    `${INBOUND_MOUNT_PATH}/:endpointKey/:endpointId`,
    { bodyLimit: INBOUND_MAX_BODY_BYTES },
    async (request, reply) => {
      if (!options.admit) {
        return reply.code(503).header("retry-after", "30").send(UNAVAILABLE);
      }
      // Bytes or nothing. A parsed object means the original bytes are gone,
      // and a signature over a reserialization would be a different message —
      // so this is a refusal to guess, not a refusal of the delivery.
      const body = request.body instanceof Uint8Array ? request.body : undefined;
      if (!body) {
        return reply.code(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "An inbound delivery must be sent as application/json.",
            retryable: false,
          },
        });
      }
      const admission = await options.admit({
        endpointKey: request.params.endpointKey,
        endpointId: request.params.endpointId,
        // Only the registration's declared headers are ever read, and only
        // through here: the handler hands over a reader, not the header bag.
        header: (name) => {
          const value = request.headers[name];
          return Array.isArray(value) ? value[0] : value;
        },
        body,
      });
      switch (admission.outcome) {
        case "accepted":
        case "duplicate":
          // 202 for both: the provider's delivery is durably kept either way,
          // and nothing about the work it started is promised here.
          return reply.code(202).send({ status: admission.outcome });
        case "unavailable":
          return reply.code(503).header("retry-after", "30").send(UNAVAILABLE);
        default:
          return reply.code(404).send(NOT_FOUND);
      }
    },
  );
}
