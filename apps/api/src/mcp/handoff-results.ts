// SPDX-License-Identifier: BUSL-1.1
/**
 * The results a create tool answers with when the values have to come from
 * the person: the MCP App handoff and the configuration URL. Split out of
 * tool-results.ts.
 */

import { connectionFieldsOf } from "./connection-guidance.js";
import { ENTITY_CONFIGURATION_PATH, callbackOrigin, configurationWebUrl, signedInConfigurationUrl } from "./handoff-config.js";
import { HttpError } from "../rest/http-error.js";
import { ok, type ToolResult } from "./tool-results.js";
import { configurationFormDefinitions } from "./configuration-submission.js";
import { configurationCredential } from "./configuration-credential.js";
export function configurationAppResult(
  payload: unknown,
  token: string,
  displayName: string,
  definitions?: unknown,
  messagePrefix?: string,
  configurationId?: string,
  submissionAvailable = Boolean(configurationCredential()),
): ToolResult {
  // Capability advertisement does not acknowledge that the host rendered a
  // card. Keep a recovery path outside that card, without exposing its bearer
  // token. The ordinary web session must still match the pending form owner.
  const externalUrl = signedInConfigurationUrl(configurationId);
  const configurationUrl = externalUrl ?? `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/pending/${configurationId ?? ""}`;
  const result = ok(externalUrl && payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload, externalUrl }
    : payload);
  return {
    ...result,
    content: [
      ...result.content,
      ...(externalUrl ? [{
        type: "text" as const,
        text: `If the secure form is not visible, open ${externalUrl} in a browser. ` +
          "Sign in as the same person in the same organization to complete the pending form. " +
          "Enter credentials only in that form, never in chat.",
      }] : []),
    ],
    _meta: {
      configurationUrl,
      ...(submissionAvailable ? { submissionUrl: `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/app`, submissionToken: token } : {}),
      ...(externalUrl ? { externalUrl } : {}),
      displayName,
      ...(configurationId ? { configurationId } : {}),
      ...(definitions !== undefined ? { configuration: {
        fields: configurationFormDefinitions({ definitions: Array.isArray(definitions) ? definitions : [] }),
        ...(messagePrefix ? { messagePrefix } : {}),
      } } : {}),
    },
  };
}

export const __configurationAppResultForTests = configurationAppResult;

/**
 * The model-visible handoff for clients without a usable secure form: the
 * configuration URL in plain text AND structured, so an assistant can tell
 * the person exactly where to go. Everything here is readable by the model
 * and by anyone who reads the tool result, so the URL is the signed-in web
 * form addressed by the pending form's id — never the handoff token. The
 * person signs in as the form's owner; the values are entered in the browser
 * and never pass through the chat or the model. Without a deployed web origin
 * there is no such form and the handoff is refused rather than downgraded to
 * a bearer link.
 */
export function configurationHandoffResult(input: {
  continuation: Record<string, unknown>;
  configurationId: string | undefined;
  expiresInSeconds: number;
  definitions: unknown;
  instructions: string;
  nowMs?: number;
}): ToolResult {
  const configurationUrl = signedInConfigurationUrl(input.configurationId);
  if (!configurationUrl) {
    throw new HttpError(
      503,
      "CONFIGURATION_UNAVAILABLE",
      "This client cannot show the secure form, and no signed-in configuration web client is deployed to complete it in a browser.",
    );
  }
  const expiresAt = new Date(
    (input.nowMs ?? Date.now()) + input.expiresInSeconds * 1000,
  ).toISOString();
  const externalUrl = configurationWebUrl();
  const payload = {
    ...input.continuation,
    pending: true,
    configurationUrl,
    expiresAt,
    fields: connectionFieldsOf(input.definitions).map(({ key, label, secret }) => ({
      key,
      label,
      secret,
    })),
    ...(externalUrl ? { externalUrl } : {}),
    instructions: input.instructions,
  };
  return {
    content: [
      {
        type: "text",
        text:
          `Configuration needed: open ${configurationUrl} in a browser, sign in as the ` +
          `same person in the same organization and enter the values there (valid until ` +
          `${expiresAt}); they never pass through the chat.`,
      },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

export const __configurationHandoffResultForTests = configurationHandoffResult;
