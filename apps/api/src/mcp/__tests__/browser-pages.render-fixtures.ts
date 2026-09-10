// SPDX-License-Identifier: BUSL-1.1
/**
 * Renders every browser page variant to files for visual review:
 *   bun apps/api/src/mcp/__tests__/browser-pages.render-fixtures.ts <outDir>
 * Uses the same in-memory mint helpers the unit tests use, so no database
 * or live handoff is needed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  mintConfiguration,
  peekConfiguration,
  renderConfigurationForm,
  renderConfigurationExpiredPage,
  renderConfigurationFailedPage,
  renderConfigurationSavedPage,
} from "../configuration-handoff.js";
import { renderEntityOAuthCallbackPage } from "../browser-pages.js";

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: render-fixtures <outDir>");
mkdirSync(outDir, { recursive: true });
const write = (name: string, html: string) => {
  writeFileSync(join(outDir, `${name}.html`), html);
  console.log(`${name}.html ${html.length} bytes`);
};

const providerName = "Google";
write(
  "oauth-connected",
  renderEntityOAuthCallbackPage({
    outcome: "connected",
    providerName,
    connectionScope: "user",
  }),
);
write(
  "oauth-invalid-state",
  renderEntityOAuthCallbackPage({ outcome: "invalid_state" }),
);
write(
  "oauth-provider-refused",
  renderEntityOAuthCallbackPage({ outcome: "provider_refused", providerName }),
);
write(
  "oauth-no-code",
  renderEntityOAuthCallbackPage({ outcome: "no_code", providerName }),
);
write(
  "oauth-store-failed",
  renderEntityOAuthCallbackPage({ outcome: "store_failed", providerName }),
);

const { token } = await mintConfiguration({
  tenantId: "tenant",
  userId: "user",
  table: "adapter",
  elicit: {
    into: "configuration",
    sourceTable: "provider",
    sourceField: "providerId",
    sourceEntity: "Provider",
  } as never,
  modelValues: {},
  definitions: [
    {
      key: "clientId",
      valueType: "string",
      required: true,
      label: { en: "OAuth client ID" },
      description: { en: "From the Google Cloud console, under Credentials." },
    },
    {
      key: "clientSecret",
      valueType: "string",
      required: true,
      label: { en: "OAuth client secret" },
      classification: { sensitivity: "confidential" },
    },
    {
      key: "region",
      valueType: "string",
      required: false,
      label: { en: "Data region" },
      options: {
        items: [
          { value: "eu", label: { en: "Europe" } },
          { value: "us", label: { en: "United States" } },
        ],
      },
    },
    {
      key: "sandbox",
      valueType: "boolean",
      required: false,
      label: { en: "Use the sandbox environment" },
    },
  ],
  displayName: "Google Workspace",
  messagePrefix:
    "Register http://localhost:3171/api/entity-oauth/callback as the redirect URL of the OAuth client first.",
});
const pending = (await peekConfiguration(token))!;
const action = `/api/entity-configuration/${token}`;
write("config-form", renderConfigurationForm(pending, action));
write(
  "config-form-errors",
  renderConfigurationForm(pending, action, {
    clientId: "This value is required.",
    clientSecret: "This value is required.",
  }),
);
write(
  "config-form-refused",
  renderConfigurationForm(
    pending,
    action,
    {},
    {
      errorBanner: "Google refused these values — probe: answered 401.",
      prefill: { clientId: "1234.apps.googleusercontent.com", region: "eu" },
    },
  ),
);
write("config-saved", renderConfigurationSavedPage(pending.displayName));
write("config-expired", renderConfigurationExpiredPage());
write("config-failed", renderConfigurationFailedPage(pending.displayName));
