// SPDX-License-Identifier: BUSL-1.1

export type ConnectorExecutionErrorCode =
  | "CONNECTOR_PROVENANCE_REFUSED"
  | "CONNECTOR_EGRESS_DENIED"
  | "CONNECTOR_TIMEOUT"
  | "CONNECTOR_RATE_LIMITED"
  | "CONNECTOR_CIRCUIT_OPEN"
  | "CONNECTOR_UPSTREAM_ERROR"
  | "CONNECTOR_OAUTH_FAILED"
  // Distinct from every other failure because it is the only one a retry can
  // never fix and a person can always fix: the refresh token is spent or
  // revoked, and somebody has to authorize the installation again.
  | "CONNECTOR_REAUTHORIZATION_REQUIRED";

export class ConnectorExecutionError extends Error {
  readonly code: ConnectorExecutionErrorCode;
  readonly connector: string;
  readonly operation: string | undefined;

  constructor(
    code: ConnectorExecutionErrorCode,
    connector: string,
    message: string,
    operation?: string,
  ) {
    super(message);
    this.name = "ConnectorExecutionError";
    this.code = code;
    this.connector = connector;
    this.operation = operation;
  }
}
