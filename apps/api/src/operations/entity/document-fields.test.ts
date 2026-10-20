// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { documentPolicyViolation } from "./document-fields.js";
const image = { documentType: "logo", artifactId: "file", mimeType: "image/png", byteSize: 100, hasBlocks: false };
test("a Document policy refuses a wrong content shape, file type and file size", () => {
  expect(documentPolicyViolation({ content: "file", mimeTypes: ["image/png"], maxBytes: 100 }, image)).toBeUndefined();
  expect(documentPolicyViolation({ content: "blocks" }, image)).toContain("blocks");
  expect(documentPolicyViolation({ content: "file", mimeTypes: ["image/jpeg"] }, image)).toContain("type");
  expect(documentPolicyViolation({ content: "file", maxBytes: 99 }, image)).toContain("large");
  expect(documentPolicyViolation({ content: "file" }, { ...image, hasBlocks: true })).toContain("file");
  expect(documentPolicyViolation({ content: "blocks" }, { ...image, artifactId: null, hasBlocks: true })).toBeUndefined();
});
