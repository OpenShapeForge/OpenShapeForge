// SPDX-License-Identifier: BUSL-1.1
/**
 * The mail port the `mail.deliver` job kind sends through.
 *
 * A provider does one thing: hand one message to a transport and say what it
 * knows about the outcome. It throws `MailDeliveryError` with a `phase`, and
 * the phase is the whole reason the port exists here rather than as a bare
 * `send`: whether the message may have left is a question only the transport
 * can answer, and the job that called it must end differently for each answer
 * (docs/jobs.md).
 *
 *   - `before-data`: nothing was handed over — a refused connection, a failed
 *     handshake, a rejected envelope. Retrying is safe.
 *   - `after-data`: the message body was handed over and the acceptance was
 *     never read — a timeout or a dropped connection after the final `.`.
 *     The recipient may have it. Retrying may send it twice.
 *   - `rejected`: the transport refused permanently. Retrying will not help.
 */
export type MailAddress = string;

export type MailMessage = {
  to: readonly MailAddress[];
  subject: string;
  text: string;
  html?: string;
  from?: MailAddress;
  replyTo?: MailAddress;
  headers?: Readonly<Record<string, string>>;
};

export type MailDeliveryPhase = "before-data" | "after-data" | "rejected";

export class MailDeliveryError extends Error {
  constructor(readonly phase: MailDeliveryPhase, message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MailDeliveryError";
    this.code = options?.code ?? (phase === "after-data" ? "MAIL_OUTCOME_UNKNOWN" : phase === "rejected" ? "MAIL_REJECTED" : "MAIL_UNAVAILABLE");
  }
  readonly code: string;
}

export type MailProvider = {
  readonly name: string;
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
};

export type NullMailProviderOptions = {
  log?: (payload: Record<string, unknown>, message: string) => void;
  /** Tests: observe what would have been sent. */
  sent?: MailMessage[];
};

/**
 * The provider a deployment without OPENSHAPEFORGE_SMTP_URL gets: it logs the
 * envelope and reports success. Loud on purpose — a deployment that enqueues
 * mail and never configured a transport should see every message it dropped
 * in its log, not a quietly `done` job.
 */
export function createNullMailProvider(options: NullMailProviderOptions = {}): MailProvider {
  const log = options.log ?? ((payload, message) => console.log(JSON.stringify({ level: "warn", ...payload, msg: message })));
  return {
    name: "null",
    async send(message) {
      options.sent?.push(message);
      const providerMessageId = `null-${crypto.randomUUID()}`;
      log(
        { provider: "null", to: [...message.to], subject: message.subject, providerMessageId },
        "No mail transport is configured (OPENSHAPEFORGE_SMTP_URL); the message was logged and not sent.",
      );
      return { providerMessageId };
    },
  };
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** A bare address; display names are not accepted so a header can never be forged through one. */
export function isMailAddress(value: unknown): value is MailAddress {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

function assertHeaderSafe(name: string, value: string) {
  if (/[\r\n]/.test(value)) throw new MailDeliveryError("rejected", `Mail header ${name} contains a line break.`, { code: "MAIL_INVALID" });
}

function encodedWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
}

/**
 * Render the message as an RFC 5322 document with CRLF line ends. Bodies are
 * base64 so no line can start with a dot or exceed the SMTP line limit, and
 * every header value is checked for line breaks so a payload cannot smuggle
 * a header of its own.
 */
export function renderMailMessage(message: MailMessage & { from: MailAddress }, options: { messageId: string; date?: Date }): string {
  const headers: [string, string][] = [
    ["From", message.from],
    ["To", message.to.join(", ")],
    ["Subject", encodedWord(message.subject)],
    ["Date", (options.date ?? new Date()).toUTCString()],
    ["Message-ID", `<${options.messageId}>`],
    ["MIME-Version", "1.0"],
  ];
  if (message.replyTo) headers.push(["Reply-To", message.replyTo]);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) throw new MailDeliveryError("rejected", `Mail header name "${name}" is invalid.`, { code: "MAIL_INVALID" });
    headers.push([name, encodedWord(value)]);
  }
  for (const [name, value] of headers) assertHeaderSafe(name, value);

  const part = (type: string, body: string) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}\r\n`;
  let body: string;
  if (message.html === undefined) {
    body = part("text/plain", message.text);
  } else {
    const boundary = `=_${options.messageId.replace(/[^A-Za-z0-9]/g, "")}`;
    body =
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n${part("text/plain", message.text)}` +
      `--${boundary}\r\n${part("text/html", message.html)}` +
      `--${boundary}--\r\n`;
  }
  return headers.map(([name, value]) => `${name}: ${value}\r\n`).join("") + body;
}
