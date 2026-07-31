// SPDX-License-Identifier: BUSL-1.1
/**
 * Authorization for the connector configuration surface.
 *
 * Configuring a connector means handing credentials for another system to the
 * platform and deciding what it may reach. That is an administrative act, so it
 * is gated on an explicit CAPABILITY the session must hold — not on being a
 * particular client, not on merely having reached an internal endpoint. That
 * distinction is the finding closed in #56: authenticating as the right caller
 * is not the same as being authorized for the operation.
 *
 * Fail closed everywhere: no roles, no capability, no session ⇒ denied.
 */

/** Role that may install, configure, enable, disable and verify connectors. */
export const CONNECTOR_ADMIN_ROLE = "Platform.ConnectorAdmin";

/**
 * Role that may read the connector catalog (which connectors exist, their
 * license and status). Separate from the admin role so an operator dashboard
 * can list connectors without being able to touch credentials.
 */
export const CONNECTOR_READER_ROLE = "Platform.ConnectorReader";

export type ConnectorSessionLike = {
  tenantId: string | null;
  userId: string | null;
  roles: readonly string[];
};

export type ConnectorAuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN";

export class ConnectorAuthorizationError extends Error {
  readonly code: ConnectorAuthErrorCode;
  constructor(code: ConnectorAuthErrorCode, message: string) {
    super(message);
    this.name = "ConnectorAuthorizationError";
    this.code = code;
  }
}

function requireSession(session: ConnectorSessionLike): void {
  if (!session.tenantId || !session.userId) {
    throw new ConnectorAuthorizationError(
      "UNAUTHENTICATED",
      "A tenant-scoped session is required for connector operations.",
    );
  }
}

/**
 * Reading the catalog. An admin implicitly reads — requiring both roles to be
 * granted separately is the kind of papercut that gets solved by granting
 * everyone everything.
 */
export function requireConnectorRead(session: ConnectorSessionLike): void {
  requireSession(session);
  const roles = new Set(session.roles);
  if (!roles.has(CONNECTOR_READER_ROLE) && !roles.has(CONNECTOR_ADMIN_ROLE)) {
    throw new ConnectorAuthorizationError(
      "FORBIDDEN",
      "Not authorized to read the connector catalog.",
    );
  }
}

/** Any write to connector configuration, including enable/disable and verify. */
export function requireConnectorAdmin(session: ConnectorSessionLike): void {
  requireSession(session);
  if (!new Set(session.roles).has(CONNECTOR_ADMIN_ROLE)) {
    // The message names the capability, not who holds it, and never the
    // connector — an authenticated prober learns nothing about the catalog.
    throw new ConnectorAuthorizationError(
      "FORBIDDEN",
      "Not authorized to administer connectors.",
    );
  }
}
