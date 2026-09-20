// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector operations projected onto the MCP tool list: one tool per
 * operation that opted in, with the contract's own input schema and
 * annotations derived from its kind and reliability. Shared by the runtime,
 * which lists them, and the compiler, which budgets the listing; typed on
 * the contract fields it reads so either side's contract type fits.
 */
import { compareCodeUnits } from "./ordering.js";

/** A text or a per-language map; read loosely, as either side's contract type spells it. */
type LocalizedText = string | Readonly<{ [language: string]: string | undefined }> | object;

export type ConnectorMcpOperationShape = {
  key: string;
  kind: "query" | "mutation";
  label?: LocalizedText | undefined;
  description?: LocalizedText | undefined;
  mcp?: { toolName: string } | undefined;
  schemas: { input: Record<string, unknown> };
  reliability: { idempotency?: unknown };
};

export type ConnectorMcpContractShape = {
  slug: string;
  title: string;
  exposure: { mcp?: unknown };
  operations: readonly ConnectorMcpOperationShape[];
};

export type ConnectorMcpTool = {
  name: string;
  connectorSlug: string;
  operationKey: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};

function localized(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const text = value as Record<string, string>;
    return (text.en ?? text.nl ?? text.fr)?.trim() || undefined;
  }
  return undefined;
}

/**
 * Annotations derived mechanically from the operation, matching how the entity
 * tools derive theirs.
 *
 * A query is read-only and idempotent. A mutation is neither by default —
 * `idempotentHint` is claimed only when the contract declares an idempotency
 * strategy, because that hint tells a model a retry is safe, and saying so
 * without the contract backing it is how a model double-charges a customer.
 */
export function connectorToolAnnotations(
  operation: Pick<ConnectorMcpOperationShape, "kind" | "reliability">,
): ConnectorMcpTool["annotations"] {
  if (operation.kind === "query") {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  }
  return {
    readOnlyHint: false,
    // The platform cannot know whether a connector mutation destroys anything,
    // and the contract has no vocabulary for it yet. Claiming false would be a
    // guess in the direction that makes a model bolder.
    destructiveHint: true,
    idempotentHint: operation.reliability.idempotency !== undefined,
  };
}

function describeOperation(
  contract: ConnectorMcpContractShape,
  operation: ConnectorMcpOperationShape,
): string {
  const parts = [
    localized(operation.description) ??
      localized(operation.label) ??
      `${operation.key} on ${contract.title}`,
  ];
  if (operation.kind === "mutation" && operation.reliability.idempotency === undefined) {
    // A model reading this decides whether to retry. Tell it plainly.
    parts.push("Not safe to repeat: this operation declares no idempotency strategy.");
  }
  return parts.join(" ");
}

/** Every connector tool a build advertises, before session filtering. */
export function connectorMcpTools(
  contracts: readonly ConnectorMcpContractShape[],
): ConnectorMcpTool[] {
  return contracts
    .filter((contract) => contract.exposure.mcp)
    .flatMap((contract) =>
      contract.operations
        .filter((operation) => operation.mcp)
        .map((operation) => ({
          name: operation.mcp!.toolName,
          connectorSlug: contract.slug,
          operationKey: operation.key,
          title: localized(operation.label) ?? operation.key,
          description: describeOperation(contract, operation),
          inputSchema: operation.schemas.input,
          annotations: connectorToolAnnotations(operation),
        })),
    )
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}
