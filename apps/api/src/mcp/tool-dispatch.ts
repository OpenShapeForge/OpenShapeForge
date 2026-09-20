// SPDX-License-Identifier: BUSL-1.1
/**
 * One tool call, dispatched to the surface that owns the name. The sections
 * run in the order the former single handler tried them: the static tools
 * (whoami, upload, edit leases, the searchable Operation tools, provider
 * and catalogue Operations, connectors), the derived-tool helpers (connect,
 * preferences, dry run), the platform tools (identity link, organization
 * profile, invitations, onboarding, update notices, guides, discovery,
 * tests) and finally the entity tools with the derived tools behind them.
 * A section answers `undefined` when the name is not its own; the entity
 * section always answers.
 *
 * Split out of generated-mcp-server.ts: each section is the former block of
 * the direct-call handler, verbatim, reading what it captured from the
 * call scope.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ModuleToolExecutionOptions,
  ModuleToolExecutionResult,
} from "../modules/contract.js";
import {
  egressSourceFromResolvedInvocation,
  type ResolvedInvocationSource,
} from "../modules/invocation-sources.js";
import type { CapturedDerivedExecution } from "./catalog.js";
import type { DerivedToolsCatalogEntry } from "./derived-tools.js";
import type { ServerScope } from "./server-scope.js";
import type { ListedTool, SessionSurface } from "./session-surface.js";
import { staticToolCall } from "./dispatch-static-tools.js";
import { connectToolCall } from "./dispatch-connect-tool.js";
import { dryRunToolCall } from "./dispatch-dry-run-tool.js";
import { personalizationToolCall } from "./dispatch-personalization-tool.js";
import { platformToolCall } from "./dispatch-platform-tools.js";
import { entityToolCall } from "./dispatch-entity-tools.js";

export type DispatchTool = (
  name: string,
  args: Record<string, unknown>,
  requestId: string | number,
  internal: boolean,
  selectedOptions?: ModuleToolExecutionOptions,
  assertParentInvocationActive?: () => void,
  signal?: AbortSignal,
  bypassInterceptors?: boolean,
  idempotencyKey?: string,
  compatibilityCall?: boolean,
  internalDerivedDefinition?: {
    entry: DerivedToolsCatalogEntry;
    row: Record<string, unknown>;
  },
) => Promise<ModuleToolExecutionResult>;

/** What one direct call sees: the session's scope and surface plus the call's own facts. */
export type DirectCallScope = ServerScope &
  SessionSurface & {
    dispatchTool: DispatchTool;
    name: string;
    args: Record<string, unknown>;
    requestId: string | number;
    internal: boolean;
    selectedOptions: ModuleToolExecutionOptions | undefined;
    assertParentInvocationActive: (() => void) | undefined;
    signal: AbortSignal | undefined;
    bypassInterceptors: boolean;
    idempotencyKey: string | undefined;
    compatibilityCall: boolean;
    internalDerivedDefinition:
      | { entry: DerivedToolsCatalogEntry; row: Record<string, unknown> }
      | undefined;
    request: { params: { name: string; arguments: Record<string, unknown> } };
    extra: { requestId: string | number };
    /** The listed tool the name resolved to, set before the direct call runs. */
    current: ListedTool | undefined;
    selected: ResolvedInvocationSource | undefined;
    assertInterceptorActive: (() => void) | undefined;
    selectedReference: string | undefined;
    egressSource: ReturnType<typeof egressSourceFromResolvedInvocation>;
    leadCapture: CapturedDerivedExecution | undefined;
  };

export type DispatchSection = (call: DirectCallScope) => Promise<CallToolResult | undefined>;

const SECTIONS: readonly DispatchSection[] = [
  staticToolCall,
  connectToolCall,
  personalizationToolCall,
  dryRunToolCall,
  platformToolCall,
  entityToolCall,
];

export async function directToolCall(
  call: Omit<DirectCallScope, "selected" | "assertInterceptorActive" | "selectedReference" | "egressSource" | "leadCapture">,
  _options: ModuleToolExecutionOptions | undefined,
  selected: ResolvedInvocationSource | undefined,
  assertInterceptorActive: (() => void) | undefined,
): Promise<CallToolResult> {
  call.signal?.throwIfAborted();
  call.assertParentInvocationActive?.();
  assertInterceptorActive?.();
  const scoped: DirectCallScope = {
    ...call,
    selected,
    assertInterceptorActive,
    selectedReference: selected?.sourceReference,
    egressSource: egressSourceFromResolvedInvocation(selected),
    leadCapture: selected?.internal as CapturedDerivedExecution | undefined,
  };
  for (const section of SECTIONS) {
    const outcome = await section(scoped);
    if (outcome !== undefined) return outcome;
  }
  // The entity section answers every name it is reached with.
  throw new Error(`Tool "${call.name}" was not dispatched.`);
}
