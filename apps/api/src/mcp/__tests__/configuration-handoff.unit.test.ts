// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the browser configuration handoff: token lifecycle
 * (single-use on success, reload-safe before it, TTL-bound), submission
 * parsing against the pending definitions, encryption parity with the
 * in-band form, and a form rendering that masks secrets and escapes
 * everything person-controlled.
 */
import { describe, expect, it } from "bun:test";
import {
  consumeConfiguration,
  mintConfiguration,
  parseSubmission,
  peekConfiguration,
  renderConfigurationForm,
  renderMessagePage,
  storeSubmission,
  type PendingConfiguration,
} from "../configuration-handoff.js";
import { keyringFromEnv, SECRET_SET_SENTINEL } from "../../connectors/secrets.js";
import { redactElicitedValues } from "../elicitation.js";

const KEYRING = keyringFromEnv(`test:${Buffer.alloc(32, 5).toString("base64")}`)!;

const DEFINITIONS = [
  {
    key: "subdomain",
    valueType: "string",
    required: true,
    label: { en: "Zendesk subdomain" },
    description: { en: "The part before .zendesk.com." },
  },
  {
    key: "clientSecret",
    valueType: "string",
    required: true,
    label: { en: "OAuth client secret" },
    classification: { sensitivity: "confidential" },
  },
  { key: "retries", valueType: "integer", required: false, label: { en: "Retries" } },
  { key: "sandbox", valueType: "boolean", required: false, label: { en: "Sandbox" } },
];

function mint(overrides: Partial<PendingConfiguration> = {}) {
  const { token } = mintConfiguration({
    tenantId: "t-1",
    userId: "u-1",
    table: "erp.connections",
    elicit: {
      sourceField: "adapterId",
      sourceEntity: "Adapter",
      sourceTable: "erp.adapters",
      definitionsField: "configurationFields",
      into: "configurationValues",
    },
    modelValues: { key: "zendesk-production", name: "Zendesk production", adapterId: "a-1" },
    definitions: DEFINITIONS,
    displayName: "Zendesk",
    ...overrides,
  });
  return token;
}

describe("token lifecycle", () => {
  it("peek does not consume; consume does; unknown and empty are null", () => {
    const token = mint();
    expect(peekConfiguration(token)?.displayName).toBe("Zendesk");
    expect(peekConfiguration(token)).not.toBeNull();
    consumeConfiguration(token);
    expect(peekConfiguration(token)).toBeNull();
    expect(peekConfiguration("nope")).toBeNull();
    expect(peekConfiguration(undefined)).toBeNull();
  });
});

describe("parseSubmission", () => {
  it("coerces types, flags missing required values, treats checkboxes as presence", () => {
    const pending = peekConfiguration(mint())!;
    const good = parseSubmission(
      pending,
      "subdomain=acme&clientSecret=s3cret&retries=3&sandbox=on",
    );
    expect(good.errors).toEqual({});
    expect(good.content).toEqual({
      subdomain: "acme",
      clientSecret: "s3cret",
      retries: 3,
      sandbox: true,
    });

    const missing = parseSubmission(pending, "retries=x");
    expect(missing.errors.subdomain).toContain("required");
    expect(missing.errors.clientSecret).toContain("required");
    expect(missing.errors.retries).toContain("whole number");
    expect(missing.content.sandbox).toBe(false);
  });
});

describe("storeSubmission", () => {
  it("encrypts secret-classified values and merges the model identity args", () => {
    const pending = peekConfiguration(mint())!;
    const values = storeSubmission(
      pending,
      { subdomain: "acme", clientSecret: "s3cret", sandbox: false },
      KEYRING,
    );
    expect(values.key).toBe("zendesk-production");
    const configuration = values.configurationValues as Record<string, unknown>;
    expect(configuration.subdomain).toBe("acme");
    expect(typeof configuration.clientSecret).toBe("object");
    expect(JSON.stringify(configuration)).not.toContain("s3cret");
    const redacted = redactElicitedValues({ configurationValues: configuration }, "configurationValues");
    expect((redacted.configurationValues as Record<string, unknown>).clientSecret).toBe(
      SECRET_SET_SENTINEL,
    );
  });
});

describe("renderConfigurationForm", () => {
  it("masks secrets, marks required fields, posts to the token path, escapes content", () => {
    const token = mint({ displayName: `Zendesk <&> "prod"`, messagePrefix: "Register <this> URL first" });
    const pending = peekConfiguration(token)!;
    const html = renderConfigurationForm(pending, `/api/entity-configuration/${token}`);
    expect(html).toContain(`type="password" name="clientSecret"`);
    expect(html).toContain(`type="text" name="subdomain" required`);
    expect(html).toContain(`type="number" name="retries"`);
    expect(html).toContain(`type="checkbox" name="sandbox"`);
    expect(html).toContain(`action="/api/entity-configuration/${token}"`);
    expect(html).toContain("Zendesk &lt;&amp;&gt;");
    expect(html).toContain("Register &lt;this&gt; URL first");
    expect(html).not.toContain("<this>");
    expect(html).toContain("never through any chat");

    const withErrors = renderConfigurationForm(pending, "/x", { subdomain: "This value is required." });
    expect(withErrors).toContain("This value is required.");
  });

  it("renders a plain message page with escaping", () => {
    expect(renderMessagePage("done & <safe>")).toContain("done &amp; &lt;safe&gt;");
  });
});

describe("retry rendering after a rejected verification", () => {
  it("shows the banner, prefills non-secrets, never echoes secrets", () => {
    const token = mint();
    const pending = peekConfiguration(token)!;
    const html = renderConfigurationForm(pending, "/x", {}, {
      errorBanner: "Zendesk refused these values — probe: answered 401.",
      prefill: { subdomain: "acme-typo", clientSecret: "s3cret" },
    });
    expect(html).toContain("Zendesk refused these values");
    expect(html).toContain("Nothing was saved");
    expect(html).toContain('name="subdomain"');
    expect(html).toContain('value="acme-typo"');
    expect(html).not.toContain("s3cret");
  });
});
