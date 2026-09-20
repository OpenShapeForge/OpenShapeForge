// SPDX-License-Identifier: BUSL-1.1
/**
 * The results a create tool answers with when the values have to come from
 * the person: the MCP App handoff and the configuration URL. Split out of
 * tool-results.ts.
 */

import { connectionFieldsOf } from "./connection-guidance.js";
import { ENTITY_CONFIGURATION_PATH, callbackOrigin, configurationWebUrl } from "./handoff-config.js";
import { type ToolResult } from "./tool-results.js";
export function configurationAppResult(
  payload: unknown,
  token: string,
  displayName: string,
): ToolResult {
  const configurationUrl = `${callbackOrigin()}${ENTITY_CONFIGURATION_PATH}/${token}`;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    _meta: {
      configurationUrl,
      displayName,
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
