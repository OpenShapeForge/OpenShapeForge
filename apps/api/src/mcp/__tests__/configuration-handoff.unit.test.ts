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
  renderConfigurationApp,
  renderConfigurationForm,
  renderMessagePage,
  storeSubmission,
  type PendingConfiguration,
} from "../configuration-handoff.js";
import {
  keyringFromEnv,
  redactElicitedValues,
  SECRET_SET_SENTINEL,
} from "../../connectors/secrets.js";

const KEYRING = keyringFromEnv(
  `test:${Buffer.alloc(32, 5).toString("base64")}`,
)!;

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
  {
    key: "retries",
    valueType: "integer",
    required: false,
    label: { en: "Retries" },
  },
  {
    key: "sandbox",
    valueType: "boolean",
    required: false,
    label: { en: "Sandbox" },
  },
];

async function mint(overrides: Partial<PendingConfiguration> = {}) {
  const { token } = await mintConfiguration({
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
    modelValues: {
      key: "zendesk-production",
      name: "Zendesk production",
      adapterId: "a-1",
    },
    definitions: DEFINITIONS,
    displayName: "Zendesk",
    ...overrides,
  });
  return token;
}

describe("token lifecycle", () => {
  it("peek does not consume; consume does; unknown and empty are null", async () => {
    const token = await mint();
    expect((await peekConfiguration(token))?.displayName).toBe("Zendesk");
    expect(await peekConfiguration(token)).not.toBeNull();
    await consumeConfiguration(token);
    expect(await peekConfiguration(token)).toBeNull();
    expect(await peekConfiguration("nope")).toBeNull();
    expect(await peekConfiguration(undefined)).toBeNull();
  });
});

describe("parseSubmission", () => {
  it("coerces types, flags missing required values, treats checkboxes as presence", async () => {
    const pending = (await peekConfiguration(await mint()))!;
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
  it("encrypts secret-classified values and merges the model identity args", async () => {
    const pending = (await peekConfiguration(await mint()))!;
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
    const redacted = redactElicitedValues(
      { configurationValues: configuration },
      "configurationValues",
    );
    expect(
      (redacted.configurationValues as Record<string, unknown>).clientSecret,
    ).toBe(SECRET_SET_SENTINEL);
  });
});

describe("renderConfigurationForm", () => {
  it("bundles the official MCP App without embedding a handoff URL", async () => {
    const html = await renderConfigurationApp();
    expect(html).toContain('id="configuration-frame"');
    expect(html).toContain("ui/initialize");
    expect(html).toContain("Secure configuration");
    expect(html).toContain(
      "Values go directly to the secure configuration service and never through the model.",
    );
    expect(html).not.toContain("/api/entity-configuration/");
  });

  it("keeps the signed-in web form copy adopter-neutral", async () => {
    const source = await Bun.file(
      new URL(
        "../../../../web/src/app/configuration/page.tsx",
        import.meta.url,
      ),
    ).text();
    expect(source).toContain(
      'subtitle="Deze waarden gaan rechtstreeks naar de veilige configuratieservice en niet via het model."',
    );
    expect(source).toContain('title="Veilige configuratie"');
  });

  it("masks secrets, marks required fields, posts to the token path, escapes content", async () => {
    const token = await mint({
      displayName: `Zendesk <&> "prod"`,
      messagePrefix: "Register <this> URL first",
    });
    const pending = (await peekConfiguration(token))!;
    const html = renderConfigurationForm(
      pending,
      `/api/entity-configuration/${token}`,
    );
    expect(html).toContain(`type="password" name="clientSecret"`);
    expect(html).toContain(`type="text" name="subdomain" required`);
    expect(html).toContain(`type="number" name="retries"`);
    expect(html).toContain(`type="checkbox" name="sandbox"`);
    expect(html).toContain(`action="/api/entity-configuration/${token}"`);
    expect(html).toContain("Zendesk &lt;&amp;&gt;");
    expect(html).toContain("Register &lt;this&gt; URL first");
    expect(html).not.toContain("<this>");
    expect(html).toContain("never through any chat");

    const withErrors = renderConfigurationForm(pending, "/x", {
      subdomain: "This value is required.",
    });
    expect(withErrors).toContain("This value is required.");
  });

  it("renders a plain message page with escaping", () => {
    expect(renderMessagePage("done & <safe>")).toContain(
      "done &amp; &lt;safe&gt;",
    );
  });

  it("escapes definition keys before placing them in control names", async () => {
    const token = await mint({
      definitions: [
        {
          key: `x" autofocus onfocus="alert(1)`,
          valueType: "string",
          required: true,
        },
      ],
    });
    const pending = (await peekConfiguration(token))!;
    const html = renderConfigurationForm(pending, "/x");
    expect(html).toContain(`name="x&quot; autofocus onfocus=&quot;alert(1)"`);
    expect(html).not.toContain(`name="x" autofocus`);
  });
});

describe("retry rendering after a rejected verification", () => {
  it("shows the banner, prefills non-secrets, never echoes secrets", async () => {
    const token = await mint();
    const pending = (await peekConfiguration(token))!;
    const html = renderConfigurationForm(
      pending,
      "/x",
      {},
      {
        errorBanner: "Zendesk refused these values — probe: answered 401.",
        prefill: { subdomain: "acme-typo", clientSecret: "s3cret" },
      },
    );
    expect(html).toContain("Zendesk refused these values");
    expect(html).toContain("Nothing was saved");
    expect(html).toContain('name="subdomain"');
    expect(html).toContain('value="acme-typo"');
    expect(html).not.toContain("s3cret");
  });
});
