// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  RUNTIME_NATIVE_MCP_EFFECTS,
  nativeMcpToolProblem,
  parseNativeMcpToolResult,
} from "./native-mcp-tool.js";

const usable = {
  intent: "invoke",
  input: { kind: "json-schema", schema: { type: "object" } },
  effects: RUNTIME_NATIVE_MCP_EFFECTS,
  reliability: { idempotency: { mode: "none" } },
  nativeMcpTool: { name: "getJiraIssue", connectionId: "33333333-3333-4333-8333-333333333333" },
};

test("accepts a definition that claims only what core can know", () => {
  expect(nativeMcpToolProblem(usable)).toBeUndefined();
});

test.each([
  ["a dotted name", { nativeMcpTool: { ...usable.nativeMcpTool, name: "module.tool" } }],
  ["an empty name", { nativeMcpTool: { ...usable.nativeMcpTool, name: "" } }],
  ["an overlong name", { nativeMcpTool: { ...usable.nativeMcpTool, name: "a".repeat(129) } }],
  ["no Connection", { nativeMcpTool: { name: "tool" } }],
  ["a malformed Connection", { nativeMcpTool: { ...usable.nativeMcpTool, connectionId: "personal" } }],
  ["a non-object output schema", { nativeMcpTool: { ...usable.nativeMcpTool, outputSchema: { type: "string" } } }],
  ["list-shaped annotations", { nativeMcpTool: { ...usable.nativeMcpTool, annotations: [] } }],
  ["a non-invoke intent", { intent: "list" }],
  ["a non-object input", { input: { kind: "json-schema", schema: { type: "array" } } }],
  ["a read-only claim", { effects: { data: "read", external: "read" } }],
  ["no external effect", { effects: { data: "read", external: "none" } }],
  ["natural idempotency", { reliability: { idempotency: { mode: "natural" } } }],
  ["keyed idempotency", { reliability: { idempotency: { mode: "keyed" } } }],
  ["an interaction control", { interaction: { confirmation: {} } }],
  ["a prerequisite", { prerequisites: [] }],
  ["a concurrency control", { concurrency: {} }],
])("refuses %s", (_, change) => {
  expect(nativeMcpToolProblem({ ...usable, ...change })).toBeString();
});

test("reads a CallToolResult unchanged, including blocks this build has not heard of", () => {
  const result = {
    content: [{ type: "text", text: "hi" }, { type: "video", uri: "x" }],
    structuredContent: { issue: "A-1" },
    isError: true,
    _meta: { "upstream/trace": "t" },
    upstreamExtra: 1,
  };
  expect(parseNativeMcpToolResult(result)).toBe(result as never);
  expect(parseNativeMcpToolResult({ content: [] })).toEqual({ content: [] });
});

test.each([
  ["nothing", undefined],
  ["no content", {}],
  ["content that is not a list", { content: "text" }],
  ["an untyped block", { content: [{ text: "hi" }] }],
  ["list-shaped structured content", { content: [], structuredContent: [] }],
  ["a non-boolean isError", { content: [], isError: "true" }],
  ["list-shaped metadata", { content: [], _meta: [] }],
])("does not read %s as a result", (_, value) => {
  expect(parseNativeMcpToolResult(value)).toBeUndefined();
});
