// SPDX-License-Identifier: BUSL-1.1
/**
 * Non-JSON content out of a derived (Service) tool: a native binding may run
 * a plugin operation by key, its MCP projection rides as the output
 * `content`, and a Service whose merged outputs carry well-formed content
 * blocks under `content` answers with those blocks instead of JSON text.
 */
import { describe, expect, it } from "bun:test";
import { nativeOperationKey } from "../declarative-execution.js";
import { __derivedToolResultForTests as derivedToolResult } from "../generated-mcp-server.js";

describe("nativeOperationKey", () => {
  it("accepts a generated entity tool name and a plugin operation key", () => {
    expect(nativeOperationKey({ operation: { nativeOperation: "finding_create" } })).toBe(
      "finding_create",
    );
    expect(
      nativeOperationKey({
        operation: { nativeOperation: "osf-integration.mail.read-attachment" },
      }),
    ).toBe("osf-integration.mail.read-attachment");
  });
  it("refuses anything else as OPERATION_MISCONFIGURED", () => {
    for (const nativeOperation of [undefined, "", "Finding_Create", "a.", ".a", "a..b", "a-b", "x y"]) {
      expect(() => nativeOperationKey({ operation: { nativeOperation } })).toThrow(
        expect.objectContaining({ status: 400, code: "OPERATION_MISCONFIGURED" }),
      );
    }
  });
});

describe("derivedToolResult", () => {
  it("answers JSON outputs as one text block", () => {
    const result = derivedToolResult({ findings: [], totalCount: 0 });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ findings: [], totalCount: 0 }, null, 2) },
    ]);
    expect(result.structuredContent).toEqual({ findings: [], totalCount: 0 });
  });
  it("hands well-formed content blocks to the model and keeps the rest structured", () => {
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const result = derivedToolResult({
      filename: "site.png",
      delivery: "image",
      content: [{ type: "text", text: "{\"filename\":\"site.png\"}" }, image],
    });
    expect(result.content).toEqual([{ type: "text", text: "{\"filename\":\"site.png\"}" }, image]);
    expect(result.structuredContent).toEqual({ filename: "site.png", delivery: "image" });
    expect(result.isError).toBeUndefined();
  });
  it("leaves a `content` output that is not a block list as plain JSON", () => {
    for (const content of ["hello", [], [{ type: "video", data: "AAAA" }], { type: "text", text: "x" }]) {
      const result = derivedToolResult({ content, other: 1 });
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ content, other: 1 }, null, 2) },
      ]);
    }
  });
});
