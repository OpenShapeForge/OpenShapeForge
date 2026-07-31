// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector operations projected onto the EXISTING MCP transport.
 *
 * Not a second MCP surface: the same server, the same `tools/list`, the same
 * per-session filtering, the same NOT_FOUND answer for a tool the caller may
 * not invoke. Connector tools differ from entity tools in exactly one way that
 * matters — each carries its own input schema and dispatches outside CRUD — so
 * they are described and invoked here while everything about how the transport
 * behaves stays where it was.
 *
 * Two properties of that transport must survive the extension, and are tested:
 *
 *   1. `tools/list` is resolved per session, so a caller is shown only the
 *      operations its roles allow. A read-only session sees no mutation tools.
 *   2. An unauthorized tool and an unknown tool get the SAME answer, so the
 *      error cannot be used to enumerate which connectors a deployment has.
 *
 * The tool budget is enforced at compile time (generate-connectors.ts counts
 * connector tools against the same 60-tool limit as entity tools), so nothing
 * here has to police it.
 */
import type { ConnectorContract, ConnectorOperationContract } from "./catalog.js";

export type McpSessionLike = { roles: readonly string[] };

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
export function annotationsFor(
  operation: ConnectorOperationContract,
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
  contract: ConnectorContract,
  operation: ConnectorOperationContract,
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

/** Every connector tool this build advertises, before session filtering. */
export function connectorMcpTools(contracts: ConnectorContract[]): ConnectorMcpTool[] {
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
          annotations: annotationsFor(operation),
        })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a session may invoke an operation — the same role intersection the
 * REST and GraphQL paths use, so the three surfaces cannot disagree.
 *
 * Fail closed: an operation with no declared roles is invocable by nobody.
 */
export function sessionMayInvokeConnectorTool(
  operation: ConnectorOperationContract | undefined,
  session: McpSessionLike,
): boolean {
  const required = operation?.roles.invoke ?? [];
  if (required.length === 0) return false;
  const granted = new Set(session.roles);
  return required.some((role) => granted.has(role));
}

export type ResolvedConnectorTool = {
  tool: ConnectorMcpTool;
  contract: ConnectorContract;
  operation: ConnectorOperationContract;
};

function index(contracts: ConnectorContract[]): Map<string, ResolvedConnectorTool> {
  const byName = new Map<string, ResolvedConnectorTool>();
  for (const tool of connectorMcpTools(contracts)) {
    const contract = contracts.find((candidate) => candidate.slug === tool.connectorSlug);
    const operation = contract?.operations.find(
      (candidate) => candidate.key === tool.operationKey,
    );
    if (contract && operation) byName.set(tool.name, { tool, contract, operation });
  }
  return byName;
}

/** The tools this session may see. Everything else is simply absent. */
export function connectorToolsForSession(
  contracts: ConnectorContract[],
  session: McpSessionLike,
): ConnectorMcpTool[] {
  return [...index(contracts).values()]
    .filter((entry) => sessionMayInvokeConnectorTool(entry.operation, session))
    .map((entry) => entry.tool);
}

/**
 * Resolve a tool name for invocation.
 *
 * Returns undefined both for an unknown tool and for one this session may not
 * invoke, so the caller answers identically in either case — the listing
 * already omitted both, and distinguishing them here would leak which
 * connectors exist to anyone willing to guess names.
 */
export function resolveConnectorTool(
  contracts: ConnectorContract[],
  name: string,
  session: McpSessionLike,
): ResolvedConnectorTool | undefined {
  const entry = index(contracts).get(name);
  if (!entry) return undefined;
  return sessionMayInvokeConnectorTool(entry.operation, session) ? entry : undefined;
}
