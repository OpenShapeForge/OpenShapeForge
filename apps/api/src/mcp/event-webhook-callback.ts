// SPDX-License-Identifier: BUSL-1.1
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fetchValidatedOutbound, type ModuleEgressDispatch } from "../modules/egress.js";
import { signEventWebhook } from "./event-webhook-signature.js";

type Destination = Readonly<{ url: URL; allowlist: readonly string[]; dispatch: ModuleEgressDispatch }>;

export function eventWebhookDestination(value: string, dispatch: ModuleEgressDispatch, allowlist: readonly string[]): Destination {
  const url = new URL(value);
  if (value.length > 4096 || url.protocol !== "https:" || url.port || url.username || url.password || url.hash) {
    throw new Error("Invalid webhook callback URL.");
  }
  if (!dispatch.owner?.pinsResolvedAddresses) throw new Error("MCP event callbacks require an address-pinning egress owner.");
  return { url, allowlist, dispatch };
}

async function postEventWebhook(destination: Destination, input: Parameters<typeof signEventWebhook>[0]): Promise<Response> {
  const { headers, body } = signEventWebhook(input);
  return fetchValidatedOutbound({
    target: destination.url,
    init: { method: "POST", redirect: "error", headers, body, signal: AbortSignal.timeout(10_000) },
    allowlist: destination.allowlist,
    dispatch: destination.dispatch,
    fallback: async () => { throw new Error("MCP event callback has no egress owner."); },
    denied: () => new Error("Webhook callback destination was refused."),
  });
}

/** Read the small challenge reply without accepting a buffered, unbounded body. */
async function readChallenge(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      length += chunk.value.byteLength;
      if (length > 4096) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function verifyEventWebhook(destination: Destination, key: Uint8Array, subscriptionId: string): Promise<void> {
  const challenge = randomBytes(32).toString("base64url");
  const reply = await readChallenge(await postEventWebhook(destination, {
    key, subscriptionId, messageId: `msg_verification_${randomBytes(18).toString("base64url")}`,
    value: { type: "verification", challenge }, signedAt: new Date(),
  }));
  const echoed = (reply as { challenge?: unknown } | null)?.challenge;
  if (typeof echoed !== "string" || Buffer.byteLength(echoed) !== Buffer.byteLength(challenge)
      || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) {
    throw new Error("Webhook callback did not verify the challenge.");
  }
}

export async function sendEventWebhook(destination: Destination, input: Parameters<typeof signEventWebhook>[0]): Promise<number> {
  const response = await postEventWebhook(destination, input);
  await response.body?.cancel();
  return response.status;
}
