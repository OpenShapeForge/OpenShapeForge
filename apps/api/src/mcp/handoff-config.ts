// SPDX-License-Identifier: BUSL-1.1
/**
 * Deployment configuration the browser handoffs depend on: the callback and
 * configuration paths, the public and web origins, whether the MCP App can
 * render, and the elicitation fallback texts.
 *
 * Split out of generated-mcp-server.ts.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { keyringFromEnv } from "../connectors/secrets.js";
import { HttpError } from "../rest/http-error.js";

export const ENTITY_OAUTH_CALLBACK_PATH = "/api/entity-oauth/callback";
export const ENTITY_CONFIGURATION_PATH = "/api/entity-configuration";
export { ENTITY_CONFIGURATION_APP_URI } from "@openshapeforge/operations";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";

export function schemaUsesArtifactUpload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as Record<string, unknown>)["x-osf-control"] === "artifact-upload") return true;
  return Object.values(value as Record<string, unknown>).some(schemaUsesArtifactUpload);
}

/**
 * Whether a failed elicitation should fall back to the browser handoff.
 * Unsupported clients, auto-answering clients (declared the capability, then
 * "declined" in machine time), dismissed forms and timed-out forms all land
 * here; a person who genuinely declined simply never opens the link and its
 * token expires. Every other failure (missing source row, keyring problems)
 * stays an error.
 */
export function elicitationFallback(
  error: unknown,
): "unsupported" | "declined" | "timeout" | null {
  if (error instanceof HttpError) {
    if (error.code === "ELICITATION_UNSUPPORTED") return "unsupported";
    if (error.code === "ELICITATION_DECLINED") return "declined";
    return null;
  }
  const message = error instanceof Error ? error.message : "";
  return /timed?\s*out|timeout/i.test(message) ? "timeout" : null;
}

export function configurationFallbackLead(
  reason: "unsupported" | "declined" | "timeout",
  delivery: "app" | "external",
): string {
  const prefix =
    reason === "timeout"
      ? "The secure form expired before it was completed — anything typed into it was NOT saved. "
      : "The secure form could not be completed in this client. ";
  if (delivery === "app") {
    return (
      prefix +
      "The client has received a private MCP App for the secure form; the " +
      "URL is not exposed to this chat. The app also offers an external-browser fallback."
    );
  }
  return (
    prefix +
    "Give the person configurationUrl: open this link in a browser and enter " +
    "the values there; they never pass through the chat."
  );
}

export const __configurationFallbackLeadForTests = configurationFallbackLead;

export function elicitedKeyring() {
  return keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
}

/**
 * The OAuth redirect URL the server instructions state, or null when this
 * deployment has no public origin. Null rather than thrown: the origin is
 * optional everywhere else on this surface (the onboarding step answers
 * `null`, the configuration handoff is skipped), so its absence must not turn
 * every MCP request into a 503. buildServerInstructions says so in words.
 */
export function oauthCallbackUrlForInstructions(): string | null {
  try {
    return `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`;
  } catch {
    return null;
  }
}

export function callbackOrigin(): string {
  const configured = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN?.trim().replace(
    /\/$/,
    "",
  );
  if (configured) return configured;
  throw new HttpError(
    503,
    "PUBLIC_ORIGIN_NOT_CONFIGURED",
    "OPENSHAPEFORGE_PUBLIC_ORIGIN is not configured, so no browser callback URL can be built.",
  );
}

/**
 * The signed-in host web form, when a web origin is deployed. Optional: the
 * handoff page is served on the API's own origin, so the runtime never needs
 * a web origin to hand a person a working form.
 */
export function configurationWebUrl(): string | undefined {
  const configured = process.env.OPENSHAPEFORGE_WEB_ORIGIN?.trim().replace(
    /\/$/,
    "",
  );
  return configured ? `${configured}/configuration` : undefined;
}

/**
 * The MCP App renders the handoff form in an iframe inside the host's own
 * (https) sandbox, so the form's origin must be https as well: an http or
 * loopback origin — local development, a tunnel-less laptop — is blocked by
 * the browser and leaves the person with a blank panel. Such deployments
 * skip the app and hand out the URL directly instead.
 */
export function publicOriginIsHttps(): boolean {
  const configured = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN?.trim() ?? "";
  return /^https:\/\//i.test(configured);
}

export const __publicOriginIsHttpsForTests = publicOriginIsHttps;

export function clientSupportsMcpApp(capabilities: unknown): boolean {
  const typed = capabilities as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const ui = typed?.extensions?.[MCP_APP_EXTENSION_ID] as
    | { mimeTypes?: unknown }
    | undefined;
  return (
    Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(MCP_APP_MIME_TYPE)
  );
}

export function supportsMcpApp(server: Server): boolean {
  return clientSupportsMcpApp(server.getClientCapabilities());
}

export const __clientSupportsMcpAppForTests = clientSupportsMcpApp;
