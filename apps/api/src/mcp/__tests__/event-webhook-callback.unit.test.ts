// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  eventWebhookDestination,
  sendEventWebhook,
  verifyEventWebhook,
} from "../event-webhook-callback.js";
import type { ModuleEgressDispatch } from "../../modules/egress.js";

const key = Buffer.alloc(32, 7);
const scope = { tenantId: "tenant", actorId: "actor", provider: "mcp-events", operation: "delivery", kind: "mutation" } as const;

test("requires HTTPS, an address-pinning owner and a public allowlisted destination", async () => {
  let called = false;
  const dispatch: ModuleEgressDispatch = { purpose: "probe", scope, owner: {
    pinsResolvedAddresses: true,
    fetch: async () => { called = true; return new Response(); },
  } };
  expect(() => eventWebhookDestination("http://8.8.8.8", dispatch, ["8.8.8.8"])).toThrow("Invalid webhook callback URL");
  expect(() => eventWebhookDestination("https://8.8.8.8", { purpose: "probe", scope }, ["8.8.8.8"])).toThrow("address-pinning");
  const target = eventWebhookDestination("https://127.0.0.1", dispatch, ["127.0.0.1"]);
  await expect(verifyEventWebhook(target, key, "sub_test")).rejects.toThrow("destination was refused");
  expect(called).toBe(false);
  await expect(verifyEventWebhook(eventWebhookDestination("https://8.8.8.8", dispatch, []), key, "sub_test"))
    .rejects.toThrow("destination was refused");
  expect(called).toBe(false);
});

test("verifies the challenge over the same pinned, signed transport used for delivery", async () => {
  const submitted: Array<{ value: any; signature: string | null }> = [];
  const dispatch: ModuleEgressDispatch = { purpose: "probe", scope, owner: {
    pinsResolvedAddresses: true,
    fetch: async ({ init, resolvedAddresses }) => {
      expect(resolvedAddresses).toEqual(["8.8.8.8"]);
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("X-MCP-Subscription-Id")).toBe("sub_test");
      const value = await new Response(init.body).json();
      submitted.push({ value, signature: headers.get("webhook-signature") });
      return value.type === "verification" ? Response.json({ challenge: value.challenge }) : new Response(null, { status: 204 });
    },
  } };
  const target = eventWebhookDestination("https://8.8.8.8/callback", dispatch, ["8.8.8.8"]);
  await verifyEventWebhook(target, key, "sub_test");
  expect(await sendEventWebhook(target, { key, messageId: "evt_test", subscriptionId: "sub_test",
    value: { eventId: "evt_test" }, signedAt: new Date() })).toBe(204);
  expect(submitted.map(item => item.signature?.startsWith("v1,"))).toEqual([true, true]);
  expect(submitted.map(item => item.value.type ?? item.value.eventId)).toEqual(["verification", "evt_test"]);
});

test("rejects a callback that fails to echo the challenge", async () => {
  const dispatch: ModuleEgressDispatch = { purpose: "probe", scope, owner: {
    pinsResolvedAddresses: true, fetch: async () => Response.json({ challenge: "wrong" }),
  } };
  const target = eventWebhookDestination("https://8.8.8.8", dispatch, ["8.8.8.8"]);
  await expect(verifyEventWebhook(target, key, "sub_test")).rejects.toThrow("did not verify");
});
