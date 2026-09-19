// SPDX-License-Identifier: BUSL-1.1
/**
 * The SMTP provider against an in-process fake server, one behaviour per
 * test: what matters is not that mail goes out but WHICH phase a failure is
 * reported in, because that phase is what `mail.deliver` turns into retry,
 * failed or outcome_unknown.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/jobs/mail/smtp.test.ts 2>&1
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { createMailDeliverHandler } from "./deliver.js";
import { createNullMailProvider, isMailAddress, MailDeliveryError, renderMailMessage, type MailMessage } from "./provider.js";
import { createSmtpMailProvider, readSmtpConfig } from "./smtp.js";
import type { ModuleJobHandlerContext } from "../../modules/contract.js";

type Script = {
  /** Reply per command verb; the default accepts everything. */
  replies?: Partial<Record<"EHLO" | "MAIL" | "RCPT" | "DATA" | "AUTH", string>>;
  /** After the message body arrives: reply normally, hang, or drop the socket. */
  afterData?: "accept" | "hang" | "drop" | "tempfail";
  received?: string[];
};

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function fakeSmtp(script: Script = {}): Promise<number> {
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          script.received?.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          const mode = script.afterData ?? "accept";
          if (mode === "hang") return;
          if (mode === "drop") return socket.destroy();
          socket.write(mode === "tempfail" ? "451 try later\r\n" : "250 queued as 1\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(/[ :]/)[0]!.toUpperCase();
        const reply = script.replies?.[verb as keyof NonNullable<Script["replies"]>];
        if (verb === "EHLO") socket.write(reply ?? "250-fake\r\n250 8BITMIME\r\n");
        else if (verb === "DATA") { socket.write(reply ?? "354 go\r\n"); inData = !reply; }
        else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write(reply ?? "250 ok\r\n");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const message: MailMessage = { to: ["someone@example.test"], subject: "Hallo wereld ✓", text: "line one\n.leading dot\n" };

function provider(port: number, timeoutMs = 400) {
  return createSmtpMailProvider(
    { host: "127.0.0.1", port, secure: false, from: "sender@example.test", timeoutMs, rejectUnauthorized: true },
    { messageId: () => "fixed-id@test", hostname: "test.local" },
  );
}

/** The failure a send ends in; a send that succeeds is the test's failure. */
async function failure(port: number): Promise<MailDeliveryError> {
  const outcome = await provider(port).send(message).then(() => undefined, (cause: unknown) => cause);
  if (!(outcome instanceof MailDeliveryError)) throw new Error(`expected a MailDeliveryError, got ${String(outcome)}`);
  return outcome;
}

describe("smtp provider", () => {
  test("delivers a message and reports the id it was sent under", async () => {
    const received: string[] = [];
    const port = await fakeSmtp({ received });
    await expect(provider(port).send(message)).resolves.toEqual({ providerMessageId: "fixed-id@test" });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("From: sender@example.test\r\n");
    expect(received[0]).toContain("Subject: =?utf-8?B?");
    expect(received[0]).toContain("Message-ID: <fixed-id@test>");
  });

  test("a refused connection is before-data", async () => {
    const port = await fakeSmtp();
    servers.pop()!.close();
    expect((await failure(port)).phase).toBe("before-data");
  });

  test("a permanent refusal of the envelope is rejected; a temporary one is before-data", async () => {
    const permanent = await fakeSmtp({ replies: { RCPT: "550 no such user\r\n" } });
    const rejected = await failure(permanent);
    expect(rejected.phase).toBe("rejected");
    expect(rejected.message).toContain("550 no such user");
    const temporary = await fakeSmtp({ replies: { MAIL: "451 greylisted\r\n" } });
    const deferred = await failure(temporary);
    expect(deferred.phase).toBe("before-data");
  });

  test("silence after the message body is after-data — the one outcome nobody may retry", async () => {
    const hang = await fakeSmtp({ afterData: "hang" });
    const timedOut = await failure(hang);
    expect(timedOut.phase).toBe("after-data");
    expect(timedOut.code).toBe("MAIL_OUTCOME_UNKNOWN");
    const drop = await fakeSmtp({ afterData: "drop" });
    const dropped = await failure(drop);
    expect(dropped.phase).toBe("after-data");
    // A temporary refusal AFTER the body was read is a clear "not accepted": retry.
    const tempfail = await fakeSmtp({ afterData: "tempfail" });
    const refused = await failure(tempfail);
    expect(refused.phase).toBe("before-data");
  });

  test("the URL carries scheme, port and credentials; the sender is separate", () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(() => readSmtpConfig({ OPENSHAPEFORGE_SMTP_URL: "smtp://localhost:1025" })).toThrow(/OPENSHAPEFORGE_MAIL_FROM/);
    expect(readSmtpConfig({ OPENSHAPEFORGE_SMTP_URL: "smtps://u%40x:p@relay.test", OPENSHAPEFORGE_MAIL_FROM: "a@b.test" })).toMatchObject({
      host: "relay.test", port: 465, secure: true, auth: { user: "u@x", pass: "p" }, from: "a@b.test",
    });
    expect(() => readSmtpConfig({ OPENSHAPEFORGE_SMTP_URL: "http://x", OPENSHAPEFORGE_MAIL_FROM: "a@b.test" })).toThrow(/scheme/);
  });
});

describe("message rendering", () => {
  test("headers cannot carry line breaks and bodies are base64", () => {
    const rendered = renderMailMessage({ ...message, from: "s@x.test", html: "<b>hi</b>", headers: { "X-Trace": "abc" } }, { messageId: "id@x", date: new Date(0) });
    expect(rendered).toContain("Content-Type: multipart/alternative;");
    expect(rendered).toContain("X-Trace: abc\r\n");
    expect(rendered).not.toContain("\n.leading");
    // A line break in a subject or custom header is encoded away, never emitted.
    const smuggled = renderMailMessage({ ...message, from: "s@x.test", subject: "a\r\nBcc: x@y.test", headers: { "X-Note": "b\nBcc: y@z.test" } }, { messageId: "id@x" });
    expect(smuggled).not.toContain("Bcc:");
    expect(() => renderMailMessage({ ...message, from: "s@x.test", headers: { "Bad Name": "v" } }, { messageId: "id@x" })).toThrow(/invalid/);
    expect(isMailAddress("Name <a@b.test>")).toBe(false);
    expect(isMailAddress("a@b.test")).toBe(true);
  });
});

describe("mail.deliver handler", () => {
  const context = { job: { id: "j", tenantId: "t", actorId: "u", kind: "mail.deliver", attempt: 1, maxAttempts: 5, subject: null }, log: { info() {}, warn() {}, error() {} } } as unknown as ModuleJobHandlerContext;

  test("maps the provider's phases onto job outcomes and refuses bad payloads without retrying", async () => {
    const sent: MailMessage[] = [];
    const ok = createMailDeliverHandler(createNullMailProvider({ sent, log: () => {} }));
    await expect(ok({ to: "a@b.test", subject: "s", text: "t" }, context)).resolves.toMatchObject({ outcome: "done", result: { provider: "null" } });
    expect(sent).toHaveLength(1);
    await expect(ok({ to: "not an address", subject: "s", text: "t" }, context)).resolves.toMatchObject({ outcome: "failed", error: { code: "MAIL_INVALID" } });
    const phase = (which: "before-data" | "after-data" | "rejected") =>
      createMailDeliverHandler({ name: "fake", send: async () => { throw new MailDeliveryError(which, `phase ${which}`); } });
    await expect(phase("before-data")({ to: "a@b.test", subject: "s", text: "t" }, context)).resolves.toMatchObject({ outcome: "retry" });
    await expect(phase("after-data")({ to: "a@b.test", subject: "s", text: "t" }, context)).resolves.toMatchObject({ outcome: "outcome_unknown", error: { code: "MAIL_OUTCOME_UNKNOWN" } });
    await expect(phase("rejected")({ to: "a@b.test", subject: "s", text: "t" }, context)).resolves.toMatchObject({ outcome: "failed" });
  });
});
