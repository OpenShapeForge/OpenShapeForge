// SPDX-License-Identifier: BUSL-1.1
/**
 * Which generated entity Operation a native Capability reference names.
 *
 * `operation.nativeOperation` accepts a canonical entity Operation id
 * (`Finding.create`) or a generated entity tool name still included in this
 * deployment (`finding_create`). Execution (dispatch-native-binding.ts) and
 * the module Operation lookup (modules/platform.ts) both read the reference
 * through this one match, so metadata never describes a different Operation
 * than the one that runs. It reads the generated tool catalogue only; the
 * caller still applies the session's authorization to the canonical contract.
 */
import rawCatalog from "../generated/mcp/tools.json" with { type: "json" };

/** The identity fields of a generated entity tool this match reads. */
export type NativeCrudToolIdentity = {
  name: string;
  operationId: string;
  entity: string;
};

export type NativeCrudToolMatch<Tool extends NativeCrudToolIdentity> =
  | { kind: "tool"; tool: Tool }
  | { kind: "none" }
  /** More than one generated Operation carries the id. */
  | { kind: "duplicate-id"; candidates: readonly Tool[] }
  /** A tool name shared by several entities, and `entity` picks none of them. */
  | { kind: "shared-name"; candidates: readonly Tool[] };

/** The generated entity tools of this deployment. */
export const generatedCrudTools: readonly NativeCrudToolIdentity[] =
  (rawCatalog as unknown as { tools: NativeCrudToolIdentity[] }).tools;

/**
 * Match `reference` against `tools`: a canonical Operation id first, then a
 * generated tool name. A name shared by several entities resolves only when
 * `entity` names one of them, exactly as a direct call of that tool requires.
 */
export function matchNativeCrudTool<Tool extends NativeCrudToolIdentity>(
  tools: readonly Tool[],
  reference: string,
  entity?: unknown,
): NativeCrudToolMatch<Tool> {
  const canonical = tools.filter((tool) => tool.operationId === reference);
  if (canonical.length > 1) return { kind: "duplicate-id", candidates: canonical };
  if (canonical.length === 1) return { kind: "tool", tool: canonical[0]! };
  const candidates = tools.filter((tool) => tool.name === reference);
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "tool", tool: candidates[0]! };
  const match = candidates.find((tool) => tool.entity === entity);
  return match ? { kind: "tool", tool: match } : { kind: "shared-name", candidates };
}
