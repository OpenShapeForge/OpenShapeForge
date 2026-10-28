// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { assertOutboundTls, readBoundedResponse } from "./outbound-response.js";

describe("provider response budgets", () => {
  test("counts bytes across chunks, cancels oversized chunked responses", async () => {
    let cancelled = false;
    let pulls = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    }));
    await expect(readBoundedResponse(response, 6)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(5);
  });
  test("rejects declared size and accepts exact UTF-8 byte budget", async () => {
    await expect(readBoundedResponse(new Response("x", {headers:{"content-length":"99"}}), 4)).rejects.toThrow();
    expect(await readBoundedResponse(new Response("éé"), 4)).toBe("éé");
    await expect(readBoundedResponse(new Response("éé"), 3)).rejects.toThrow();
  });
  test("TLS is mandatory in production even for allowlisted loopback", () => {
    expect(() => assertOutboundTls(new URL("http://127.0.0.1/token"), true)).toThrow();
    expect(() => assertOutboundTls(new URL("https://provider.example/token"), true)).not.toThrow();
    expect(() => assertOutboundTls(new URL("http://localhost/token"), false)).not.toThrow();
  });
});
