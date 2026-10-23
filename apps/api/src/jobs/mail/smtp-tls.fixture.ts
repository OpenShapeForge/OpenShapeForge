// SPDX-License-Identifier: BUSL-1.1
// Separate process so NODE_EXTRA_CA_CERTS is loaded before TLS initializes.
import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createSmtpMailProvider } from "./smtp.js";
import { MailDeliveryError } from "./provider.js";

const [certPath, keyPath, mode, expected] = process.argv.slice(2);
const credentials = { cert: readFileSync(certPath!), key: readFileSync(keyPath!) };
const sockets = new Set<Socket>();
function serve(socket: Socket, greeting = true, upgraded = false) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  if (greeting) socket.write("220 fixture ESMTP\r\n");
  let buffer = "", data = false;
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      if (data) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        buffer = buffer.slice(end + 5); data = false;
        socket.write("250 queued\r\n"); continue;
      }
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const verb = buffer.slice(0, end).split(" ")[0]; buffer = buffer.slice(end + 2);
      if (verb === "EHLO") socket.write(mode === "starttls" && !upgraded ? "250-fixture\r\n250 STARTTLS\r\n" : "250 fixture\r\n");
      else if (verb === "STARTTLS") {
        socket.write("220 upgrade\r\n"); socket.off("data", onData);
        const secure = new TLSSocket(socket, { ...credentials, isServer: true });
        serve(secure, false, true); return;
      } else if (verb === "DATA") { data = true; socket.write("354 body\r\n"); }
      else if (verb === "QUIT") { socket.end("221 bye\r\n"); }
      else socket.write("250 ok\r\n");
    }
  };
  socket.on("data", onData);
}
const server = mode === "smtps" ? createTlsServer(credentials, socket => serve(socket)) : createServer(socket => serve(socket));
server.on("tlsClientError", () => {});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const port = (server.address() as { port: number }).port;
  const provider = createSmtpMailProvider({ host: "127.0.0.1", port, secure: mode === "smtps", from: "fixture@example.test", timeoutMs: 2_000, rejectUnauthorized: true });
  let failure: unknown;
  try { await provider.send({ to: ["recipient@example.test"], subject: "TLS identity", text: "fixture" }); }
  catch (error) { failure = error; }
  if (expected === "accept") assert.equal(failure, undefined);
  else {
    assert(failure instanceof MailDeliveryError);
    assert.equal(failure.phase, "before-data");
    assert.match(failure.message, /altnames|altname|IP address mismatch/i);
  }
  console.log(JSON.stringify({ mode, expected, passed: true }));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
