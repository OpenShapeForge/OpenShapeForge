// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser pages of the MCP flows: one shared layout, every variant
 * rendered, everything person- or admin-controlled escaped, no script and no
 * external asset, and copy that says what happened and what to do next
 * without leaking internals.
 */
import { describe, expect, it } from "bun:test";
import {
  escapeHtml,
  hostDisplayName,
  renderBrowserPage,
  renderConfigurationExpiredPage,
  renderConfigurationFailedPage,
  renderConfigurationForm,
  renderConfigurationSavedPage,
  renderEntityOAuthCallbackPage,
  renderNoticePage,
  type EntityOAuthOutcome,
} from "../browser-pages.js";
import type { PendingConfiguration } from "../configuration-handoff.js";

const HOST = "Kern";

function expectBrandedDocument(html: string): void {
  expect(html.startsWith("<!doctype html><html lang=\"en\">")).toBe(true);
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain('name="viewport"');
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toContain("<h1>");
  expect(html).toContain("Hubble");
  expect(html).toContain("Powered by OpenShapeForge");
  expect(html).toContain("prefers-color-scheme:dark");
  expect(html).not.toContain("<script");
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toMatch(/src="https?:/);
  expect(html).not.toMatch(/href="https?:/);
  expect(html).not.toContain("@import");
}

describe("escapeHtml", () => {
  it("escapes every character that could break out of text or attributes", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;",
    );
  });
});

describe("hostDisplayName", () => {
  it("prefers OSF_INTEGRATION_HOST_NAME and falls back to Hubble", () => {
    expect(hostDisplayName({ OSF_INTEGRATION_HOST_NAME: "  Kern " })).toBe(
      "Kern",
    );
    expect(hostDisplayName({ OSF_INTEGRATION_HOST_NAME: "" })).toBe("Hubble");
    expect(hostDisplayName({})).toBe("Hubble");
  });
});

describe("renderBrowserPage", () => {
  it("escapes every interpolated value and keeps the body slot verbatim", () => {
    const html = renderBrowserPage({
      title: `T <"&">`,
      heading: `H <script>alert(1)</script>`,
      lead: `L 'quoted'`,
      next: `N & more`,
      eyebrow: `E <b>`,
      tone: "success",
      hostName: `Host <x>`,
      bodyHtml: `<form id="kept"></form>`,
    });
    expectBrandedDocument(html);
    expect(html).toContain("<title>T &lt;&quot;&amp;&quot;&gt; · Host &lt;x&gt;</title>");
    expect(html).toContain("<h1>H &lt;script&gt;alert(1)&lt;/script&gt;</h1>");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("L &#39;quoted&#39;");
    expect(html).toContain('<p class="next">N &amp; more</p>');
    expect(html).toContain('<p class="eyebrow">E &lt;b&gt;</p>');
    expect(html).toContain('<form id="kept"></form>');
    expect(html).toContain("<strong>Host &lt;x&gt;</strong>");
  });

  it("shows the host name next to the product name only when they differ", () => {
    const hubble = renderBrowserPage({
      title: "t",
      heading: "h",
      lead: "l",
      hostName: "Hubble",
    });
    expect(hubble).toContain("<strong>Hubble</strong>");
    expect(hubble.match(/Hubble/g)?.length).toBe(2); // title + brand line
    const kern = renderBrowserPage({
      title: "t",
      heading: "h",
      lead: "l",
      hostName: HOST,
    });
    expect(kern).toContain("<strong>Kern</strong>");
    expect(kern).toContain("<span>Hubble</span>");
  });

  it("marks the tone with an icon and label; neutral pages carry none", () => {
    const success = renderBrowserPage({
      title: "t",
      heading: "h",
      lead: "l",
      tone: "success",
    });
    expect(success).toContain('class="status success"');
    expect(success).toContain("Done");
    const error = renderBrowserPage({
      title: "t",
      heading: "h",
      lead: "l",
      tone: "error",
    });
    expect(error).toContain('class="status error"');
    expect(error).toContain("Something went wrong");
    const neutral = renderBrowserPage({ title: "t", heading: "h", lead: "l" });
    expect(neutral).not.toContain('class="status');
  });
});

describe("renderEntityOAuthCallbackPage", () => {
  const outcomes: EntityOAuthOutcome[] = [
    "connected",
    "invalid_state",
    "provider_refused",
    "no_code",
    "store_failed",
  ];

  it.each(outcomes)("renders a branded page for %s", (outcome) => {
    const html = renderEntityOAuthCallbackPage({
      outcome,
      providerName: "Google",
      hostName: HOST,
    });
    expectBrandedDocument(html);
    expect(html).toContain("Google");
    expect(html).toContain("Kern");
    expect(html).toContain('<p class="next">');
  });

  it("connected: names the provider, the host and the next step", () => {
    const html = renderEntityOAuthCallbackPage({
      outcome: "connected",
      providerName: "Google",
      connectionScope: "user",
      hostName: HOST,
    });
    expect(html).toContain('class="status success"');
    expect(html).toContain("<h1>Google is connected</h1>");
    expect(html).toContain(
      "Google is now connected for your account in Kern.",
    );
    expect(html).toContain(
      "Go back to your chat and run the tool again. You can close this window.",
    );
    expect(html).toContain("<title>Google connected · Kern</title>");
  });

  it("connected on a tenant connection says organization", () => {
    const html = renderEntityOAuthCallbackPage({
      outcome: "connected",
      providerName: "Slack",
      connectionScope: "tenant",
      hostName: HOST,
    });
    expect(html).toContain("connected for your organization in Kern");
  });

  it("invalid_state: no provider is known, so it stays generic and says what to do", () => {
    const html = renderEntityOAuthCallbackPage({
      outcome: "invalid_state",
      hostName: HOST,
    });
    expect(html).toContain('class="status error"');
    expect(html).toContain("This sign-in link is no longer valid");
    expect(html).toContain("nothing was stored");
    expect(html).toContain("start the sign-in again");
    expect(html).toContain("ask your administrator");
    expect(html).not.toContain('class="eyebrow">The provider');
  });

  it("provider_refused and no_code: nothing stored, retry from chat", () => {
    const refused = renderEntityOAuthCallbackPage({
      outcome: "provider_refused",
      providerName: "Google",
      hostName: HOST,
    });
    expect(refused).toContain("Google did not approve the sign-in");
    expect(refused).toContain("nothing was stored");
    expect(refused).toContain("start the Google sign-in again");
    const noCode = renderEntityOAuthCallbackPage({
      outcome: "no_code",
      providerName: "Google",
      hostName: HOST,
    });
    expect(noCode).toContain("returned without an authorization code");
    expect(noCode).toContain("nothing was stored");
  });

  it("store_failed: says the host could not store it, without internals", () => {
    const html = renderEntityOAuthCallbackPage({
      outcome: "store_failed",
      providerName: "Google",
      hostName: HOST,
    });
    expect(html).toContain("Kern could not store the connection");
    expect(html).not.toMatch(/stack|state=|database/i);
  });

  it("escapes the provider name everywhere it appears", () => {
    const html = renderEntityOAuthCallbackPage({
      outcome: "connected",
      providerName: `Goo<gle> "prod"`,
      hostName: HOST,
    });
    expect(html).not.toContain("<gle>");
    expect(html).toContain("Goo&lt;gle&gt; &quot;prod&quot;");
  });

  it("falls back to the environment host name", () => {
    const previous = process.env.OSF_INTEGRATION_HOST_NAME;
    process.env.OSF_INTEGRATION_HOST_NAME = "EnvHost";
    try {
      const html = renderEntityOAuthCallbackPage({
        outcome: "connected",
        providerName: "Google",
      });
      expect(html).toContain("in EnvHost.");
    } finally {
      if (previous === undefined) delete process.env.OSF_INTEGRATION_HOST_NAME;
      else process.env.OSF_INTEGRATION_HOST_NAME = previous;
    }
  });
});

const PENDING: PendingConfiguration = {
  token: "tok",
  tenantId: "t",
  userId: "u",
  table: "adapter",
  elicit: {
    into: "configuration",
    sourceTable: "provider",
    sourceField: "providerId",
    sourceEntity: "Provider",
  } as PendingConfiguration["elicit"],
  modelValues: {},
  definitions: [
    {
      key: "clientId",
      valueType: "string",
      required: true,
      label: { en: "Client ID" },
      description: { en: "From the provider's developer console." },
    },
    {
      key: "clientSecret",
      valueType: "string",
      required: true,
      label: { en: "Client secret" },
      classification: { sensitivity: "confidential" },
    },
    {
      key: "region",
      valueType: "string",
      required: false,
      label: { en: "Region" },
      options: {
        items: [
          { value: "eu", label: { en: "Europe" } },
          { value: "us", label: { en: "United States" } },
        ],
      },
    },
    { key: "retries", valueType: "integer", required: false, label: "Retries" },
    { key: "sandbox", valueType: "boolean", required: false, label: "Sandbox" },
  ],
  displayName: "Google Workspace",
  messagePrefix: "Register https://kern.example/api/entity-oauth/callback first.",
  expiresAtMs: Date.now() + 60_000,
};

describe("renderConfigurationForm", () => {
  it("renders a labelled, described, masked form inside the branded layout", () => {
    const html = renderConfigurationForm(
      PENDING,
      "/api/entity-configuration/tok",
      {},
      { hostName: HOST },
    );
    expectBrandedDocument(html);
    expect(html).toContain("<title>Configure Google Workspace · Kern</title>");
    expect(html).toContain("<h1>Configure Google Workspace</h1>");
    expect(html).toContain("go directly to Kern — never through any chat or model");
    expect(html).toContain('<form method="post" action="/api/entity-configuration/tok">');
    // Labels bound to controls, descriptions bound through aria-describedby.
    expect(html).toContain('<label for="field-0">Client ID<span class="req"');
    expect(html).toContain('id="field-0-hint">From the provider&#39;s developer console.');
    expect(html).toMatch(
      /<input id="field-0" type="text" name="clientId" required autocomplete="off" spellcheck="false" aria-describedby="field-0-hint">/,
    );
    // Secrets: password input plus the "never shown again" note.
    expect(html).toContain('type="password" name="clientSecret"');
    expect(html).toContain("stored encrypted and never shown again");
    expect(html).toContain('aria-describedby="field-1-secret"');
    // Select, number, checkbox.
    expect(html).toContain('<select id="field-2" name="region">');
    expect(html).toContain('<option value="eu">Europe</option>');
    expect(html).toContain('type="number" name="retries"');
    expect(html).toContain('type="checkbox" name="sandbox"');
    expect(html).toContain('<label for="field-4">Sandbox</label>');
    // Context note and submit.
    expect(html).toContain('<div class="callout"><p>Register https://kern.example/api/entity-oauth/callback first.</p></div>');
    expect(html).toContain('<button type="submit">Save configuration</button>');
    expect(html).toContain("are required.");
  });

  it("renders field errors inline with aria-invalid and a summary", () => {
    const html = renderConfigurationForm(PENDING, "/x", {
      clientId: "This value is required.",
    });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="field-0-hint field-0-error"');
    expect(html).toContain('<span class="error" id="field-0-error">This value is required.</span>');
    expect(html).toContain("Some values need attention. Nothing was saved yet.");
  });

  it("renders the verification banner, prefills non-secrets and selects, never echoes secrets", () => {
    const html = renderConfigurationForm(
      PENDING,
      "/x",
      {},
      {
        errorBanner: "Google refused these values — probe: answered 401.",
        prefill: {
          clientId: "abc",
          clientSecret: "s3cret",
          region: "us",
          sandbox: true,
        },
      },
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Google refused these values");
    expect(html).toContain("Nothing was saved; correct the values and save again.");
    expect(html).toContain('value="abc"');
    expect(html).toContain('<option value="us" selected>');
    expect(html).toContain('name="sandbox" checked');
    expect(html).not.toContain("s3cret");
  });

  it("escapes keys, labels, descriptions, options and the display name", () => {
    const html = renderConfigurationForm(
      {
        ...PENDING,
        displayName: `Zen<desk> & "co"`,
        messagePrefix: "<b>prefix</b>",
        definitions: [
          {
            key: `x" autofocus onfocus="alert(1)`,
            valueType: "string",
            required: true,
            label: "<em>lbl</em>",
            description: "<i>desc</i>",
            options: { items: [{ value: `"><s>`, label: "<u>o</u>" }] },
          },
        ],
      },
      `/x?"><script>`,
    );
    expect(html).toContain(`name="x&quot; autofocus onfocus=&quot;alert(1)"`);
    expect(html).not.toContain(`name="x" autofocus`);
    expect(html).toContain("Zen&lt;desk&gt; &amp; &quot;co&quot;");
    expect(html).toContain("&lt;b&gt;prefix&lt;/b&gt;");
    expect(html).toContain("&lt;em&gt;lbl&lt;/em&gt;");
    expect(html).toContain('value="&quot;&gt;&lt;s&gt;"');
    expect(html).toContain("&lt;u&gt;o&lt;/u&gt;");
    expect(html).toContain('action="/x?&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<em>");
  });
});

describe("configuration result pages", () => {
  it("saved: names the entity and the host, tells the person to go back", () => {
    const html = renderConfigurationSavedPage("Google Workspace", HOST);
    expectBrandedDocument(html);
    expect(html).toContain('class="status success"');
    expect(html).toContain("<h1>Google Workspace is configured</h1>");
    expect(html).toContain("The values were saved in Kern.");
    expect(html).toContain("Go back to your chat and run the tool again.");
  });

  it("expired: says the link is used up and how to get a new one", () => {
    const html = renderConfigurationExpiredPage(HOST);
    expectBrandedDocument(html);
    expect(html).toContain('class="status error"');
    expect(html).toContain("This configuration link is no longer valid");
    expect(html).toContain("ask your assistant to start the configuration again");
  });

  it("failed: nothing stored, retry or ask the admin, no internals", () => {
    const html = renderConfigurationFailedPage("Google <Workspace>", HOST);
    expectBrandedDocument(html);
    expect(html).toContain("Kern could not store the values for Google &lt;Workspace&gt;.");
    expect(html).toContain("Nothing was stored.");
    expect(html).toContain("ask your administrator");
  });

  it("notice: branded wrapper for a plain sentence, escaped", () => {
    const html = renderNoticePage("done & <safe>", HOST);
    expectBrandedDocument(html);
    expect(html).toContain("done &amp; &lt;safe&gt;");
  });
});
