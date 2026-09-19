// SPDX-License-Identifier: BUSL-1.1
/**
 * A deliberately small SMTP client (RFC 5321) for the `mail.deliver` job.
 *
 * Written rather than depended on for one reason: the job needs to know
 * WHERE a failure happened. A library that reports "send failed" cannot tell a
 * refused connection (retry) from a timeout after the message body was
 * handed over (the recipient may have it — `outcome_unknown`). This client
 * tracks that boundary explicitly: everything up to and including the `DATA`
 * greeting is `before-data`; from the moment the terminating `.` is written
 * until the server's reply is read it is `after-data`.
 *
 * Supported: plain `smtp://`, implicit TLS `smtps://`, STARTTLS when the
 * server advertises it on a plain connection, and AUTH PLAIN from the URL's
 * credentials. Enough for a relay and for Mailpit in the compose stack; a
 * deployment with other needs supplies its own MailProvider.
 */
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { MailDeliveryError, renderMailMessage, type MailAddress, type MailMessage, type MailProvider } from "./provider.js";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: MailAddress;
  timeoutMs: number;
  /** Local-dev only: accept a self-signed relay certificate. */
  rejectUnauthorized: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `smtp://user:pass@host:port` or `smtps://…`; the sender is a separate
 * variable because it is a policy of the deployment, not of the relay.
 */
export function readSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const raw = env.OPENSHAPEFORGE_SMTP_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPENSHAPEFORGE_SMTP_URL is not a valid URL.");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("OPENSHAPEFORGE_SMTP_URL must use the smtp:// or smtps:// scheme.");
  }
  const from = env.OPENSHAPEFORGE_MAIL_FROM?.trim();
  if (!from) throw new Error("OPENSHAPEFORGE_MAIL_FROM is required when OPENSHAPEFORGE_SMTP_URL is set.");
  const secure = url.protocol === "smtps:";
  const timeout = Number.parseInt(env.OPENSHAPEFORGE_SMTP_TIMEOUT_MS ?? "", 10);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : secure ? 465 : 25,
    secure,
    ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
    from,
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    rejectUnauthorized: url.searchParams.get("rejectUnauthorized") !== "false",
  };
}

type Reply = { code: number; lines: string[] };

/** One connection's line reader: replies arrive as `250-…` continuation lines ending in `250 …`. */
class SmtpConnection {
  #socket: Socket | TLSSocket;
  #buffer = "";
  #waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  #closed: Error | null = null;

  constructor(socket: Socket | TLSSocket, private readonly timeoutMs: number) {
    this.#socket = socket;
    this.#attach();
  }

  #attach() {
    this.#socket.setEncoding("utf8");
    this.#socket.setTimeout(this.timeoutMs);
    this.#socket.on("data", (chunk: string) => this.#onData(chunk));
    this.#socket.on("timeout", () => this.#fail(new Error("SMTP connection timed out.")));
    this.#socket.on("error", (error: Error) => this.#fail(error));
    this.#socket.on("close", () => this.#fail(new Error("SMTP connection closed.")));
  }

  #fail(error: Error) {
    if (!this.#closed) this.#closed = error;
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.reject(error);
    this.#socket.destroy();
  }

  #onData(chunk: string) {
    this.#buffer += chunk;
    // Replies stay buffered until someone reads: the greeting arrives before
    // the first read() is issued.
    if (!this.#waiting) return;
    let cursor = 0;
    const lines: string[] = [];
    for (;;) {
      const end = this.#buffer.indexOf("\r\n", cursor);
      if (end < 0) return; // the reply is not complete yet
      const line = this.#buffer.slice(cursor, end);
      lines.push(line);
      cursor = end + 2;
      if (/^\d{3}(?: |$)/.test(line)) break;
      if (!/^\d{3}-/.test(line)) {
        this.#fail(new Error(`Malformed SMTP reply: ${line.slice(0, 80)}`));
        return;
      }
    }
    this.#buffer = this.#buffer.slice(cursor);
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting.resolve({
      code: Number.parseInt(lines[lines.length - 1]!.slice(0, 3), 10),
      lines: lines.map((line) => line.slice(4)),
    });
  }

  read(): Promise<Reply> {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#onData("");
    });
  }

  async command(line: string): Promise<Reply> {
    if (this.#closed) throw this.#closed;
    this.#socket.write(`${line}\r\n`);
    return this.read();
  }

  write(data: string) {
    if (this.#closed) throw this.#closed;
    this.#socket.write(data);
  }

  async upgradeTls(host: string, rejectUnauthorized: boolean): Promise<void> {
    const plain = this.#socket;
    plain.removeAllListeners();
    plain.setTimeout(0);
    this.#socket = await new Promise<TLSSocket>((resolve, reject) => {
      const tls = connectTls({ socket: plain, servername: host, rejectUnauthorized }, () => resolve(tls));
      tls.once("error", reject);
    });
    this.#buffer = "";
    this.#attach();
  }

  end() {
    this.#socket.end();
    this.#socket.destroy();
  }
}

async function open(config: SmtpConfig): Promise<SmtpConnection> {
  const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    if (config.secure) {
      const tls = connectTls({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: config.rejectUnauthorized }, () => resolve(tls));
      tls.once("error", onError);
    } else {
      const tcp = connectTcp({ host: config.host, port: config.port }, () => resolve(tcp));
      tcp.once("error", onError);
    }
  });
  return new SmtpConnection(socket, config.timeoutMs);
}

function expect(reply: Reply, accepted: number[], what: string): void {
  if (accepted.includes(reply.code)) return;
  const text = `${what}: ${reply.code} ${reply.lines.join(" ")}`.trim();
  throw new MailDeliveryError(reply.code >= 500 ? "rejected" : "before-data", text, { code: reply.code >= 500 ? "MAIL_REJECTED" : "MAIL_UNAVAILABLE" });
}

export function createSmtpMailProvider(config: SmtpConfig, options: { messageId?: () => string; hostname?: string } = {}): MailProvider {
  const hostname = options.hostname ?? "openshapeforge.local";
  const messageId = options.messageId ?? (() => `${crypto.randomUUID()}@${hostname}`);
  return {
    name: "smtp",
    async send(message: MailMessage) {
      const id = messageId();
      const from = message.from ?? config.from;
      const rendered = renderMailMessage({ ...message, from }, { messageId: id });
      let phase: "before-data" | "after-data" = "before-data";
      let connection: SmtpConnection | undefined;
      try {
        connection = await open(config);
        expect(await connection.read(), [220], "SMTP greeting");
        let ehlo = await connection.command(`EHLO ${hostname}`);
        expect(ehlo, [250], "EHLO");
        if (!config.secure && ehlo.lines.some((line) => line.toUpperCase() === "STARTTLS")) {
          expect(await connection.command("STARTTLS"), [220], "STARTTLS");
          await connection.upgradeTls(config.host, config.rejectUnauthorized);
          ehlo = await connection.command(`EHLO ${hostname}`);
          expect(ehlo, [250], "EHLO after STARTTLS");
        }
        if (config.auth) {
          const credentials = Buffer.from(`\0${config.auth.user}\0${config.auth.pass}`, "utf8").toString("base64");
          expect(await connection.command(`AUTH PLAIN ${credentials}`), [235], "AUTH");
        }
        expect(await connection.command(`MAIL FROM:<${from}>`), [250], "MAIL FROM");
        for (const recipient of message.to) {
          expect(await connection.command(`RCPT TO:<${recipient}>`), [250, 251], `RCPT TO ${recipient}`);
        }
        expect(await connection.command("DATA"), [354], "DATA");
        // From here on the message is leaving. A failure before the reply is
        // read is the one outcome nobody can retry safely.
        phase = "after-data";
        connection.write(`${rendered}\r\n.\r\n`);
        const accepted = await connection.read();
        if (accepted.code !== 250) {
          const text = `Message not accepted: ${accepted.code} ${accepted.lines.join(" ")}`.trim();
          throw new MailDeliveryError(accepted.code >= 500 ? "rejected" : "before-data", text, { code: accepted.code >= 500 ? "MAIL_REJECTED" : "MAIL_UNAVAILABLE" });
        }
        phase = "before-data";
        try {
          await connection.command("QUIT");
        } catch {
          // The message was accepted; a broken QUIT changes nothing.
        }
        return { providerMessageId: id };
      } catch (error) {
        if (error instanceof MailDeliveryError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new MailDeliveryError(
          phase,
          phase === "after-data"
            ? `The SMTP server did not acknowledge the message after it was sent: ${detail}`
            : `SMTP delivery to ${config.host}:${config.port} failed: ${detail}`,
          { cause: error },
        );
      } finally {
        connection?.end();
      }
    },
  };
}
