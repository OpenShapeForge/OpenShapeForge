// SPDX-License-Identifier: BUSL-1.1
/**
 * What the MCP client said about itself at `initialize`, kept beside the
 * session it opened.
 *
 * The `initialize` request carries `params.clientInfo` ({ name, version })
 * and `params.capabilities` (elicitation, sampling, roots, …). The SDK keeps
 * both on the `Server` it builds, but only after it has answered — and the
 * `instructions` in that answer are written when the server is BUILT. So the
 * HTTP entry point reads them from the request body first, hangs them on the
 * session context (the same object `session-identity.ts` keys the credential's
 * facts by), and everything built for that session can see them: the opening
 * instructions, `whoami`, the presentation rules.
 *
 * Display facts only. A client name is what the client chose to send and is
 * never a reason to allow or refuse anything.
 */
import type { TrustedSessionContext } from "../auth/trusted-context.js";

export type McpClientInfo = {
  /** `clientInfo.name` as sent, e.g. "claude-desktop", "Claude Code". */
  name: string;
  /** `clientInfo.version` as sent; null when the client sent none. */
  version: string | null;
  /**
   * The top-level keys of `params.capabilities` the client declared, sorted:
   * `["elicitation", "roots", "sampling"]`. Names only — what a capability's
   * options say is the SDK's business, and it reads them from its own copy.
   */
  capabilities: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The client's self-description from a parsed JSON-RPC body — one message or
 * a batch. Null when the body holds no `initialize`, or when its `clientInfo`
 * has no name: a nameless client is no client to speak of, and nothing
 * downstream should have to guard against an empty name.
 */
export function clientInfoFromInitializeBody(body: unknown): McpClientInfo | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const envelope = record(message);
    if (!envelope || envelope.method !== "initialize") continue;
    const params = record(envelope.params);
    const clientInfo = record(params?.clientInfo);
    const name = nonEmptyString(clientInfo?.name);
    if (!name) return null;
    const capabilities = record(params?.capabilities);
    return {
      name,
      version: nonEmptyString(clientInfo?.version),
      capabilities: capabilities ? Object.keys(capabilities).sort() : [],
    };
  }
  return null;
}

// Keyed by the session context object for the same reason the identities
// are: the entry lives exactly as long as the session it describes.
const clients = new WeakMap<TrustedSessionContext, McpClientInfo>();

/**
 * Attach what the client said at `initialize` to the session context the
 * server for that session is about to be built on. A null clears nothing:
 * a later request never carries `initialize` again, so the first answer is
 * the one that stands.
 */
export function rememberSessionClient(
  session: TrustedSessionContext,
  client: McpClientInfo | null,
): void {
  if (client) clients.set(session, client);
}

/** The client attached by `rememberSessionClient`, or null when none introduced itself. */
export function sessionClientOf(session: TrustedSessionContext): McpClientInfo | null {
  return clients.get(session) ?? null;
}

/**
 * "Claude Desktop 1.2.3" — the client as a person would name it. The name is
 * shown as sent; a client that calls itself `claude-desktop` is not renamed,
 * because guessing a product name from an identifier is how a wrong one
 * gets stated with confidence.
 */
export function connectedViaLabel(client: McpClientInfo | null): string | null {
  if (!client) return null;
  return client.version ? `${client.name} ${client.version}` : client.name;
}
