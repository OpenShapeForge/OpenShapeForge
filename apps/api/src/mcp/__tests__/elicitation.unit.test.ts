// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for create-time elicitation: the FieldDefinition → form
 * schema translation, secret storage that fails closed without a keyring,
 * and the read-side sentinel redaction. The transport round-trip (the
 * elicitation/create exchange itself) is the SDK's contract, exercised
 * end-to-end by the host repo's proof flow.
 */
import { describe, expect, it } from "bun:test";
import {
  elicitationSchemaFromDefinitions,
  redactElicitedValues,
  storeElicitedValues,
} from "../elicitation.js";
import { decryptSecret, keyringFromEnv, type StoredSecret } from "../../connectors/secrets.js";

const KEYRING = keyringFromEnv(`test:${Buffer.alloc(32, 7).toString("base64")}`);

const DEFINITIONS = [
  {
    key: "subdomain",
    valueType: "string",
    required: true,
    label: { en: "Subdomain" },
    description: { en: "Tenant subdomain." },
  },
  {
    key: "apiToken",
    valueType: "string",
    required: true,
    label: { en: "API token" },
    classification: { sensitivity: "confidential" },
  },
  {
    key: "region",
    valueType: "string",
    options: { items: [{ value: "eu" }, { value: "us" }] },
  },
  { key: "nested", valueType: "object", children: [] },
  { key: "tags", valueType: "string", cardinality: "collection" },
];

describe("elicitationSchemaFromDefinitions", () => {
  it("builds a flat primitive schema and reports what the form cannot express", () => {
    const { schema, elicitable, skipped } = elicitationSchemaFromDefinitions(DEFINITIONS);
    expect(Object.keys(schema.properties)).toEqual(["subdomain", "apiToken", "region"]);
    expect(schema.required).toEqual(["subdomain", "apiToken"]);
    expect((schema.properties.region as { enum: string[] }).enum).toEqual(["eu", "us"]);
    expect(elicitable.map((definition) => definition.key)).toEqual([
      "subdomain",
      "apiToken",
      "region",
    ]);
    expect(skipped).toEqual(["nested", "tags"]);
  });

  it("yields nothing for absent or malformed definitions", () => {
    expect(elicitationSchemaFromDefinitions(null).elicitable).toEqual([]);
    expect(elicitationSchemaFromDefinitions([{ valueType: "string" }]).elicitable).toEqual([]);
  });
});

describe("storeElicitedValues", () => {
  const elicitable = elicitationSchemaFromDefinitions(DEFINITIONS).elicitable;
  const content = { subdomain: "acme", apiToken: "s3cret", region: "eu" };

  it("encrypts secret-classified values and stores the rest as answered", () => {
    const stored = storeElicitedValues("erp.connections", elicitable, content, KEYRING);
    expect(stored.subdomain).toBe("acme");
    expect(stored.region).toBe("eu");
    const secret = stored.apiToken as StoredSecret;
    expect(secret.ciphertext).toBeDefined();
    expect(
      decryptSecret(KEYRING!, "erp.connections", "apiToken", secret),
    ).toBe("s3cret");
  });

  it("fails closed on a secret without a keyring and on a missing required value", () => {
    expect(() => storeElicitedValues("erp.connections", elicitable, content, undefined)).toThrow(
      /never stored in plaintext/,
    );
    expect(() =>
      storeElicitedValues("erp.connections", elicitable, { apiToken: "x" }, KEYRING),
    ).toThrow(/"subdomain" is required/);
  });
});

describe("redactElicitedValues", () => {
  it("replaces stored secrets with the sentinel and leaves plain values", () => {
    const elicitable = elicitationSchemaFromDefinitions(DEFINITIONS).elicitable;
    const stored = storeElicitedValues("erp.connections", elicitable, {
      subdomain: "acme",
      apiToken: "s3cret",
    }, KEYRING);
    const row = redactElicitedValues(
      { id: "1", configurationValues: stored },
      "configurationValues",
    );
    const values = row.configurationValues as Record<string, unknown>;
    expect(values.subdomain).toBe("acme");
    expect(values.apiToken).toBe("__set__");
  });

  it("leaves rows without the field untouched", () => {
    expect(redactElicitedValues({ id: "1" }, "configurationValues")).toEqual({ id: "1" });
  });
});
