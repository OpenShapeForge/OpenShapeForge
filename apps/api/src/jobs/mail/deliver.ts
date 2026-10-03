// SPDX-License-Identifier: BUSL-1.1
/**
 * The `mail.deliver` job kind: one message, one provider call, and an outcome
 * that says what the provider knew.
 *
 * Payload: `{ to, subject, text, html?, replyTo?, headers? }` — `to` is one
 * address or a list. Validation failures are `failed`, not `retry`: a payload
 * that was wrong when it was enqueued will be wrong on every attempt.
 */
import type { RuntimeJobOutcome } from "@openshapeforge/plugin-runtime";
import type { ModuleJobHandler } from "../../modules/contract.js";
import { isMailAddress, MailDeliveryError, type MailMessage, type MailProvider } from "./provider.js";

export const MAIL_DELIVER_KIND = "mail.deliver";

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 998;
const MAX_BODY = 5 * 1024 * 1024;

type Invalid = { ok: false; message: string };

function parseMailMessage(payload: Record<string, unknown>): { ok: true; message: MailMessage } | Invalid {
  const invalid = (message: string): Invalid => ({ ok: false, message });
  const to = Array.isArray(payload.to) ? payload.to : [payload.to];
  if (to.length === 0 || to.length > MAX_RECIPIENTS || !to.every(isMailAddress)) {
    return invalid(`"to" must be one address or up to ${MAX_RECIPIENTS} addresses.`);
  }
  if (typeof payload.subject !== "string" || payload.subject.length === 0 || payload.subject.length > MAX_SUBJECT) {
    return invalid('"subject" must be a non-empty string.');
  }
  if (typeof payload.text !== "string" || payload.text.length > MAX_BODY) return invalid('"text" must be a string.');
  if (payload.html !== undefined && (typeof payload.html !== "string" || payload.html.length > MAX_BODY)) {
    return invalid('"html" must be a string when present.');
  }
  if (payload.replyTo !== undefined && !isMailAddress(payload.replyTo)) return invalid('"replyTo" must be an address.');
  if (payload.from !== undefined && !isMailAddress(payload.from)) return invalid('"from" must be an address.');
  let headers: Record<string, string> | undefined;
  if (payload.headers !== undefined) {
    if (!payload.headers || typeof payload.headers !== "object" || Array.isArray(payload.headers)) {
      return invalid('"headers" must be an object of strings.');
    }
    headers = {};
    for (const [name, value] of Object.entries(payload.headers as Record<string, unknown>)) {
      if (typeof value !== "string") return invalid(`header "${name}" must be a string.`);
      headers[name] = value;
    }
  }
  return {
    ok: true,
    message: {
      to: to as string[],
      subject: payload.subject,
      text: payload.text,
      ...(payload.html !== undefined ? { html: payload.html as string } : {}),
      ...(payload.replyTo !== undefined ? { replyTo: payload.replyTo as string } : {}),
      ...(payload.from !== undefined ? { from: payload.from as string } : {}),
      ...(headers ? { headers } : {}),
    },
  };
}

/**
 * The provider's phase decides the outcome: nothing sent → retry; sent and
 * unacknowledged → outcome_unknown; refused for good → failed. The bare
 * `retry` for an unclassified error is right because the only way to reach
 * it is before the provider was asked to send.
 */
export function createMailDeliverHandler(provider: MailProvider): ModuleJobHandler {
  return async (payload, { job, log }): Promise<RuntimeJobOutcome> => {
    const parsed = parseMailMessage(payload);
    if (!parsed.ok) return { outcome: "failed", error: { code: "MAIL_INVALID", message: parsed.message } };
    try {
      const { providerMessageId } = await provider.send(parsed.message);
      log.info({ job: job.id, provider: provider.name, providerMessageId, recipients: parsed.message.to.length }, "Mail delivered to the transport.");
      return { outcome: "done", result: { provider: provider.name, providerMessageId } };
    } catch (error) {
      if (error instanceof MailDeliveryError) {
        const detail = { provider: provider.name, phase: error.phase };
        if (error.phase === "after-data") {
          return { outcome: "outcome_unknown", error: { code: error.code, message: error.message, detail } };
        }
        if (error.phase === "rejected") return { outcome: "failed", error: { code: error.code, message: error.message, detail } };
        return { outcome: "retry", error: { code: error.code, message: error.message, detail } };
      }
      throw error;
    }
  };
}
