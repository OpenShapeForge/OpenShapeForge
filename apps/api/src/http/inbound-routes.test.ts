// SPDX-License-Identifier: BUSL-1.1
/**
 * The public delivery route, against a real Fastify instance.
 *
 * Two things are only provable here. First, that the handler sees the EXACT
 * bytes a provider sent — the whole scheme rests on it, and a stray body
 * parser anywhere in the chain would quietly break every signature. Second,
 * that an unknown endpoint and a forged signature produce byte-identical
 * answers, so the route cannot be used to enumerate registrations.
 */
import { expect, test } from "bun:test";
import Fastify from "fastify";
import type { RuntimeInboundAdmission } from "@openshapeforge/plugin-runtime";
import { INBOUND_MAX_BODY_BYTES } from "../platform/inbound-signature.js";
import { inboundEndpointPath, registerInboundRoutes } from "./inbound-routes.js";
import { useRawJsonBody } from "./raw-json-body.js";

const ENDPOINT = "00000000-0000-4000-8000-0000000000c3";
const DELIVERY = "00000000-0000-4000-8000-0000000000e5";
const PATH = inboundEndpointPath("jira-admin", ENDPOINT);

type Seen = { body: Buffer; signature: string | undefined; endpointKey: string; endpointId: string };

/** `answer: undefined` stands for a host with no database: no admission at all. */
async function server(
  answer: RuntimeInboundAdmission | undefined, seen: Seen[] = [],
) {
  const app = Fastify();
  // The same raw-body configuration roles/api.ts gives the whole API.
  useRawJsonBody(app);
  if (answer === undefined) {
    registerInboundRoutes(app, {});
  } else {
    const given: RuntimeInboundAdmission = answer;
    registerInboundRoutes(app, {
      admit: async (request) => {
        seen.push({
          body: Buffer.from(request.body), signature: request.header("x-hub-signature"),
          endpointKey: request.endpointKey, endpointId: request.endpointId,
        });
        return given;
      },
    });
  }
  await app.ready();
  return { app, seen };
}

test("the handler receives the exact bytes, whitespace and all", async () => {
  const { app, seen } = await server({ outcome: "accepted", deliveryId: DELIVERY });
  // Spelled with the whitespace and key order a provider actually sends: this
  // string, and not an equal JSON value, is what the signature covers.
  const payload = '{ "webhookEvent": "user_created",  "nested": { "b": 2, "a": 1 } }';
  for (const contentType of ["application/json", "application/json; charset=utf-8"]) {
    const response = await app.inject({
      method: "POST", url: PATH, payload,
      headers: { "content-type": contentType, "x-hub-signature": "sha256=abc" },
    });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ status: "accepted" });
  }
  expect(seen).toHaveLength(2);
  for (const entry of seen) {
    expect(entry.body.toString("utf8")).toBe(payload);
    expect(entry.signature).toBe("sha256=abc");
    expect(entry.endpointKey).toBe("jira-admin");
    expect(entry.endpointId).toBe(ENDPOINT);
  }
  await app.close();
});

test("a content type whose bytes cannot be proven is refused, never guessed at", async () => {
  const { app, seen } = await server({ outcome: "accepted", deliveryId: DELIVERY });
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    const response = await app.inject({
      method: "POST", url: PATH, payload: '{ "a": 1 }', headers: { "content-type": contentType },
    });
    // Fastify's own 415 for an unregistered type, or the route's refusal to
    // read a parsed object. Either way nothing reached admission.
    expect(response.statusCode).toBe(415);
  }
  expect(seen).toHaveLength(0);
  await app.close();
});

test("a duplicate is acknowledged too, because the delivery is durably kept", async () => {
  const { app } = await server({ outcome: "duplicate", deliveryId: DELIVERY });
  const response = await app.inject({ method: "POST", url: PATH, payload: "{}", headers: { "content-type": "application/json" } });
  expect(response.statusCode).toBe(202);
  expect(JSON.parse(response.body)).toEqual({ status: "duplicate" });
  await app.close();
});

test("a rejection is terminal and discloses nothing a stranger could enumerate", async () => {
  const { app } = await server({ outcome: "rejected" });
  const refused = await app.inject({ method: "POST", url: PATH, payload: "{}", headers: { "content-type": "application/json" } });
  expect(refused.statusCode).toBe(404);
  const body = JSON.parse(refused.body);
  expect(body).toEqual({
    error: { code: "NOT_FOUND", message: "No inbound endpoint accepted this delivery.", retryable: false },
  });
  // Nothing in the answer names the endpoint, the tenant or a reason.
  expect(refused.body).not.toContain(ENDPOINT);
  expect(refused.body).not.toContain("signature");
  await app.close();
});

test("the host's own problems are retryable, and never answered as a refusal", async () => {
  for (const answer of [{ outcome: "unavailable" } as const, undefined]) {
    const { app } = await server(answer);
    const response = await app.inject({ method: "POST", url: PATH, payload: "{}", headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(JSON.parse(response.body).error.retryable).toBe(true);
    await app.close();
  }
});

test("an over-sized body is refused by the server before the handler runs", async () => {
  const { app, seen } = await server({ outcome: "accepted", deliveryId: DELIVERY });
  const response = await app.inject({
    method: "POST", url: PATH, payload: Buffer.alloc(INBOUND_MAX_BODY_BYTES + 1, 0x61),
    headers: { "content-type": "application/json" },
  });
  expect(response.statusCode).toBe(413);
  expect(seen).toHaveLength(0);
  await app.close();
});

test("only POST is served, so a provider's probe cannot reach the handler another way", async () => {
  const { app, seen } = await server({ outcome: "accepted", deliveryId: DELIVERY });
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    expect((await app.inject({ method, url: PATH })).statusCode).toBe(404);
  }
  expect(seen).toHaveLength(0);
  await app.close();
});

test("the path a registration publishes is the path the route serves", async () => {
  expect(PATH).toBe(`/api/inbound/jira-admin/${ENDPOINT}`);
  const { app, seen } = await server({ outcome: "accepted", deliveryId: DELIVERY });
  await app.inject({ method: "POST", url: PATH, payload: "{}", headers: { "content-type": "application/json" } });
  expect(seen).toHaveLength(1);
  await app.close();
});
