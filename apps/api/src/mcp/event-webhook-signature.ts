// SPDX-License-Identifier: BUSL-1.1
import { createHmac } from "node:crypto";

const MAX_BODY_BYTES = 256 * 1024;
const CLEAN_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const SECRET = /^whsec_([A-Za-z0-9+/]+={0,2})$/;

/** Decode only canonical Standard Webhooks signing keys. */
export function decodeEventWebhookSecret(secret: string): Buffer {
  const match = SECRET.exec(secret);
  if (!match) throw new Error("Invalid webhook signing secret.");
  const key = Buffer.from(match[1]!, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== match[1]) {
    throw new Error("Invalid webhook signing secret.");
  }
  return key;
}

/** The returned body is the exact sequence of bytes covered by the signature. */
export function signEventWebhook(input: {
  key: Uint8Array;
  messageId: string;
  subscriptionId: string;
  value: object;
  signedAt: Date;
}): { body: string; headers: Record<string, string> } {
  const { key, messageId, subscriptionId, value, signedAt } = input;
  if (!CLEAN_ID.test(messageId) || !CLEAN_ID.test(subscriptionId)) throw new Error("Invalid webhook identifier.");
  if (key.byteLength < 24 || key.byteLength > 64) throw new Error("Invalid webhook signing secret.");
  const seconds = Math.floor(signedAt.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Invalid webhook timestamp.");
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("Webhook body exceeds 256 KiB.");
  const timestamp = String(seconds);
  const signature = createHmac("sha256", key).update(`${messageId}.${timestamp}.`).update(body).digest("base64");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
      "X-MCP-Subscription-Id": subscriptionId,
    },
  };
}
