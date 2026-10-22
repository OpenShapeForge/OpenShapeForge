// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { Server, SdkError, SdkErrorCode, createMcpHandler } from "@modelcontextprotocol/server";
import { collectElicitedValues } from "../elicitation.js";
import { elicitationFallback } from "../handoff-config.js";
import { HttpError } from "../../rest/http-error.js";

test("a modern tools/call classifies the SDK's push-elicitation refusal as a handoff condition", async () => {
  let refusal: unknown;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "secure-input-regression", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/call", async () => {
      try {
        await collectElicitedValues({ server, relatedRequestId: 1,
          elicit: { sourceField: "definitionId", sourceEntity: "Example", sourceTable: "example", definitionsField: "definitions", into: "values" },
          sourceRow: { definitions: [{ key: "clientSecret", osfType: "string", required: true, classification: { sensitivity: "confidential" } }] },
          values: {},
        });
        throw new Error("The modern protocol must not send server-push elicitation.");
      } catch (error) {
        refusal = error;
        if (!elicitationFallback(error)) throw error;
        return { content: [{ type: "text", text: "Private form required" }], structuredContent: { data: { status: "awaiting_person" }, operations: [] } };
      }
    });
    return server;
  }, { legacy: "reject" });
  try {
    const response = await handler.fetch(new Request("https://example.test/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "configure" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "configure", arguments: {}, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
        "io.modelcontextprotocol/clientInfo": { name: "regression", version: "1" },
      } } }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { structuredContent: { data: { status: "awaiting_person" }, operations: [] } } });
    expect(refusal).toMatchObject({ code: SdkErrorCode.MethodNotSupportedByProtocolVersion });
  } finally { await handler.close(); }
});

test("only unsupported protocol or capability errors select the form handoff", () => {
  expect(elicitationFallback(new SdkError(SdkErrorCode.CapabilityNotSupported, "Form unsupported"))).toBe("unsupported");
  expect(elicitationFallback(new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"))).toBeNull();
  expect(elicitationFallback(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"))).toBe("timeout");
  expect(elicitationFallback(new HttpError(500, "SECRET_KEYRING_MISSING", "Missing keyring"))).toBeNull();
  expect(elicitationFallback(new Error("Provider configuration is invalid"))).toBeNull();
});
