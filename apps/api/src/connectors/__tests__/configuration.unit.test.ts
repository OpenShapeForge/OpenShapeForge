// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  ConnectorConfigurationError,
  ConnectorConfigurationValidator,
  type ConfigurationContract,
} from "../configuration.js";
import { SECRET_SET_SENTINEL } from "../secrets.js";

/** Mirrors what the compiler emits for a connector with one secret field. */
const CONTRACT: ConfigurationContract = {
  slug: "object-store",
  configuration: {
    fields: [
      { key: "endpoint" },
      { key: "region" },
      { key: "accessKeyId", secret: true },
      { key: "secretAccessKey", secret: true },
    ],
    secretFields: ["accessKeyId", "secretAccessKey"],
    schema: {
      type: "object",
      properties: {
        endpoint: { type: "string", format: "uri" },
        region: { type: "string", enum: ["eu-west", "eu-central"] },
        accessKeyId: { type: "string", minLength: 4 },
        secretAccessKey: { type: "string", minLength: 8 },
      },
      required: ["endpoint"],
      additionalProperties: false,
    },
  },
};

const validator = new ConnectorConfigurationValidator(CONTRACT);

describe("configuration validation", () => {
  it("splits secrets out of the stored configuration", () => {
    const split = validator.parse({
      endpoint: "https://store.example",
      region: "eu-west",
      accessKeyId: "AKIA1234",
      secretAccessKey: "supersecretvalue",
    });

    expect(split.config).toEqual({
      endpoint: "https://store.example",
      region: "eu-west",
    });
    expect(split.secrets).toEqual({
      accessKeyId: "AKIA1234",
      secretAccessKey: "supersecretvalue",
    });
    // The whole point: nothing secret is in the half that becomes a jsonb column.
    expect(JSON.stringify(split.config)).not.toContain("supersecretvalue");
  });

  // Silently dropping is how a misspelled key becomes a connector pointing
  // somewhere the operator does not expect.
  it("rejects an unknown field rather than dropping it", () => {
    expect(() =>
      validator.parse({ endpoint: "https://store.example", endpoin: "typo" }),
    ).toThrow(/unknown field "endpoin"/);
  });

  it("enforces 2020-12 unevaluatedProperties closure", () => {
    const strictValidator = new ConnectorConfigurationValidator({
      slug: "strict-object",
      configuration: {
        fields: [{ key: "known" }],
        secretFields: [],
        schema: {
          type: "object",
          allOf: [{ properties: { known: { type: "string" } } }],
          unevaluatedProperties: false,
        },
      },
    });

    expect(strictValidator.parse({ known: "ok" }).config).toEqual({ known: "ok" });
    expect(() => strictValidator.parse({ known: "ok", unexpected: true })).toThrow(
      /unknown field "unexpected"/,
    );
  });

  it("rejects a missing required field and a violated enum", () => {
    expect(() => validator.parse({ region: "eu-west" })).toThrow(/required/);
    expect(() =>
      validator.parse({ endpoint: "https://store.example", region: "mars" }),
    ).toThrow(/\/region/);
  });

  it("rejects a non-object submission", () => {
    for (const value of [null, "string", 42, ["a"]]) {
      expect(() => validator.parse(value)).toThrow(ConnectorConfigurationError);
    }
  });

  it("never echoes a submitted value in the error", () => {
    const secret = "AK";
    try {
      validator.parse({ endpoint: "https://store.example", accessKeyId: secret });
      throw new Error("expected a validation error");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("/accessKeyId");
      expect(message).not.toContain(`"${secret}"`);
    }
  });
});

describe("the already-set sentinel", () => {
  // A UI round-trips the form without asking the operator to retype every
  // credential; the sentinel must not be validated as a value, nor stored.
  it("leaves an unchanged secret alone instead of overwriting it", () => {
    const split = validator.parse({
      endpoint: "https://store.example",
      accessKeyId: SECRET_SET_SENTINEL,
      secretAccessKey: "brand-new-value",
    });

    expect(split.secrets).toEqual({ secretAccessKey: "brand-new-value" });
    expect(split.unchangedSecrets).toEqual(["accessKeyId"]);
    expect(split.config.accessKeyId).toBeUndefined();
  });

  it("does not let the sentinel fail a minLength the real value would pass", () => {
    // The sentinel is shorter than minLength: 8 on secretAccessKey.
    expect(() =>
      validator.parse({
        endpoint: "https://store.example",
        secretAccessKey: SECRET_SET_SENTINEL,
      }),
    ).not.toThrow();
  });
});

describe("required secrets", () => {
  const required = ["accessKeyId", "secretAccessKey"];

  it("reports secrets that are neither submitted nor already stored", () => {
    const split = validator.parse({ endpoint: "https://store.example" });
    expect(validator.missingSecrets(split, new Set(), required)).toEqual([
      "accessKeyId",
      "secretAccessKey",
    ]);
  });

  it("accepts secrets that are already stored", () => {
    const split = validator.parse({ endpoint: "https://store.example" });
    expect(
      validator.missingSecrets(split, new Set(["accessKeyId", "secretAccessKey"]), required),
    ).toEqual([]);
  });

  it("counts a sentinel as present", () => {
    const split = validator.parse({
      endpoint: "https://store.example",
      accessKeyId: SECRET_SET_SENTINEL,
      secretAccessKey: "value-long-enough",
    });
    expect(validator.missingSecrets(split, new Set(), required)).toEqual([]);
  });
});
