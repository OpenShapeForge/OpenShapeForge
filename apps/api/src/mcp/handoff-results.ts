// SPDX-License-Identifier: BUSL-1.1
/**
 * The results a create tool answers with when the values have to come from
 * the person: the MCP App handoff and the configuration URL. Split out of
 * tool-results.ts.
 */

import { connectionFieldsOf } from "./connection-guidance.js";
import { ENTITY_CONFIGURATION_PATH, callbackOrigin, configurationWebUrl } from "./handoff-config.js";
import { ok, type ToolResult } from "./tool-results.js";
import { configurationFormDefinitions } from "./configuration-submission.js";
export function configurationAppResult(
  payload: unknown,
  token: string,
  displayName: string,
  definitions?: unknown,
  messagePrefix?: string,
  configurationId?: string,
): ToolResult {
  const configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${token}`;
  // Capability advertisement does not acknowledge that the host rendered a
  // card. Keep a recovery path outside that card, without exposing its bearer
  // token. The ordinary web session must still match the pending form owner.
  const webUrl = configurationWebUrl();
  const externalUrl = webUrl && configurationId ? `${webUrl}?formId=${encodeURIComponent(configurationId)}` : undefined;
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
 * the person exactly where to go. The URL is the single-use, time-bound
 * handoff token; the values are entered in the browser and never pass
 * through the chat or the model.
 */
export function configurationHandoffResult(input: {
  continuation: Record<string, unknown>;
  token: string;
  expiresInSeconds: number;
  definitions: unknown;
  instructions: string;
  nowMs?: number;
}): ToolResult {
  const configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${input.token}`;
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
          `Configuration needed: open ${configurationUrl} in a browser and enter the ` +
          `values there (link valid until ${expiresAt}); they never pass through the chat.`,
      },
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

export const __configurationHandoffResultForTests = configurationHandoffResult;
