// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { parseDocumentCommandBody, parseVersionCommandBody } from "../rest-routes.js";

describe("legacy document command envelopes", () => {
  test("preserves the historical request shape from a raw JSON buffer", () => {
    const input = {
      document: { title: "Offer", documentType: "incoming_mail", status: "draft" },
      version: { versionLabel: "1.0", status: "draft" },
    };
    expect(parseDocumentCommandBody(Buffer.from(JSON.stringify(input)))).toEqual(input);
    expect(parseVersionCommandBody({ version: input.version })).toEqual(input.version);
  });

  test("does not duplicate canonical nested-field validation", () => {
    const nested = {
      document: { anyFutureCanonicalField: { nested: true } },
      version: { fileName: "canonical-schema-decides.pdf" },
    };
    expect(parseDocumentCommandBody(nested)).toEqual(nested);
  });

  test("rejects unknown or missing transport-envelope fields", () => {
    expect(() =>
      parseDocumentCommandBody({
        document: {},
        version: {},
        idempotencyKey: "body-keys-are-not-authoritative",
      }),
    ).toThrow(/Unknown request field "idempotencyKey"/);
    expect(() => parseVersionCommandBody({})).toThrow(/Request field "version" is required/);
    expect(() => parseVersionCommandBody({ version: {}, documentId: "body-value" })).toThrow(
      /Unknown request field "documentId"/,
    );
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
