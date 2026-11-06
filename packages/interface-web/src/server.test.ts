// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { createServer, type RequestListener, type Server } from "node:http";
import { forwardRuntimeRequest } from "./server.js";

const servers: Server[] = [];
async function upstream(listener: RequestListener): Promise<URL> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return new URL(`http://127.0.0.1:${address.port}/api/test`);
}
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); } });

test("early API refusal reaches the caller while its upload remains open", async () => {
  const target = await upstream((_req, res) => { res.writeHead(401); res.end("Sign in"); });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  const response = await forwardRuntimeRequest(new Request("http://host.test/api/test", { method: "POST", body }), target);
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Sign in");
  expect(cancelled).toBe(true);
}, 3000);

test("upload reaches the API before EOF and respects byte limits without Content-Length", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let received = 0;
  const target = await upstream((req, res) => {
    req.on("data", chunk => { received += chunk.length; controller.close(); });
    req.on("end", () => res.end(String(received)));
  });
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new Uint8Array(100)); } });
  const response = await forwardRuntimeRequest(new Request("http://host.test", { method: "POST", body }), target);
  expect(await response.text()).toBe("100");
  const tooBig = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(101)); c.close(); } });
  const denied = await forwardRuntimeRequest(new Request("http://host.test", { method: "POST", body: tooBig }), target, { maxBodyBytes: 100 });
  expect(denied.status).toBe(413);
}, 3000);

test("declared oversized bodies are rejected before opening an upstream socket", async () => {
  const target = await upstream(() => { throw new Error("Must not contact API"); });
  const response = await forwardRuntimeRequest(new Request("http://host.test", { method: "POST", headers: { "content-length": "101" }, body: "x" }), target, { maxBodyBytes: 100 });
  expect(response.status).toBe(413);
});

test("streamed responses preserve cookies and remove nominated hop headers in both directions", async () => {
  const target = await upstream((req, res) => {
    expect(req.headers.host).toBe("host.test");
    expect(req.headers["x-private-hop"]).toBeUndefined();
    res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": ["one=1; HttpOnly", "two=2; HttpOnly"], connection: "x-response-hop", "x-response-hop": "private" });
    res.write("data: ready\n\n");
  });
  const response = await forwardRuntimeRequest(new Request("http://host.test", { headers: { connection: "x-private-hop", "x-private-hop": "private" } }), target);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.has("x-response-hop")).toBe(false);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n");
  await reader.cancel();
}, 3000);

test("caller cancellation closes an unfinished upload and its upstream socket", async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const abort = new AbortController();
  const target = await upstream(req => { req.on("close", closed); abort.abort(); });
  let cancelled = false;
  const request = new Request("http://host.test", { method: "POST", signal: abort.signal,
    body: new ReadableStream({ cancel() { cancelled = true; } }) });
  await expect(forwardRuntimeRequest(request, target)).rejects.toThrow();
  await disconnected;
  expect(cancelled).toBe(true);
}, 3000);
