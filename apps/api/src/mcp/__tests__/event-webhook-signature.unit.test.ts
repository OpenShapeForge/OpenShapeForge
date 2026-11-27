// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { decodeEventWebhookSecret, signEventWebhook } from "../event-webhook-signature.js";

const key = decodeEventWebhookSecret("whsec_" + Buffer.alloc(32, 7).toString("base64"));
const delivery = { key, messageId: "evt_test", subscriptionId: "sub_test",
  value: { eventId: "evt_test", text: "é" }, signedAt: new Date("2026-11-27T15:00:00Z") };

test("signs the exact UTF-8 event body with the Standard Webhooks envelope", () => {
  const { body, headers } = signEventWebhook(delivery);
  expect(body).toBe('{"eventId":"evt_test","text":"é"}');
  expect(headers).toEqual({
    "Content-Type": "application/json", "webhook-id": "evt_test",
    "webhook-timestamp": "1795791600", "X-MCP-Subscription-Id": "sub_test",
    "webhook-signature": "v1,mkSgkJaIENx+K9V/G5EvV129PLBoKX8OTfqXE2zXcj8=",
  });
});

test("rejects malformed or undersized keys and invalid delivery inputs", () => {
  for (const secret of ["bad", "whsec_AA==", "whsec_" + Buffer.alloc(32).toString("base64").replace(/=$/, "")]) {
    expect(() => decodeEventWebhookSecret(secret)).toThrow("Invalid webhook signing secret");
  }
  expect(() => signEventWebhook({ ...delivery, messageId: "test\r\n" })).toThrow("Invalid webhook identifier");
  expect(() => signEventWebhook({ ...delivery, value: { text: "é".repeat(132_000) } })).toThrow("256 KiB");
});
