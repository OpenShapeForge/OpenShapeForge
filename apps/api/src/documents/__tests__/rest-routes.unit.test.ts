// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { parseDocumentCommandBody, parseVersionCommandBody } from "../rest-routes.js";

describe("document command input", () => {
  test("accepts the minimum first-version command from a raw JSON buffer", () => {
    const input = {
      document: { title: "Offer", documentType: "quote", status: "draft" },
      version: { versionLabel: "1.0", status: "published" },
    };
    expect(parseDocumentCommandBody(Buffer.from(JSON.stringify(input)))).toEqual(input);
  });

  test("rejects unknown and legacy artifact fields on Document", () => {
    expect(() =>
      parseDocumentCommandBody({
        document: {
          title: "Offer",
          documentType: "quote",
          status: "draft",
          checksum: "must-live-on-version",
        },
        version: { versionLabel: "1.0", status: "draft" },
      }),
    ).toThrow(/Unknown document field "checksum"/);
  });

  test("rejects malformed identifiers, booleans and dates before SQL", () => {
    expect(() =>
      parseDocumentCommandBody({
        document: {
          title: "Offer",
          documentType: "quote",
          status: "draft",
          relationId: "not-a-uuid",
        },
        version: { versionLabel: "1.0", status: "draft" },
      }),
    ).toThrow(/relationId must be a UUID/);
    expect(() =>
      parseVersionCommandBody({
        version: { versionLabel: "1.1", status: "draft", isMajorVersion: "yes" },
      }),
    ).toThrow(/isMajorVersion must be a boolean/);
  });

  test("enforces authored string limits before SQL", () => {
    expect(() =>
      parseDocumentCommandBody({
        document: { title: "x".repeat(301), documentType: "quote", status: "draft" },
        version: { versionLabel: "1.0", status: "draft" },
      }),
    ).toThrow(/document.title must be at most 300 characters/);
    expect(() =>
      parseVersionCommandBody({
        version: { versionLabel: "x".repeat(51), status: "draft" },
      }),
    ).toThrow(/version.versionLabel must be at most 50 characters/);
  });

  test("does not echo malformed JSON", () => {
    try {
      parseVersionCommandBody(Buffer.from('{"version":{"versionLabel":"private-value"'));
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toBe("Request body is not valid JSON.");
      expect((error as Error).message).not.toContain("private-value");
    }
  });
});
