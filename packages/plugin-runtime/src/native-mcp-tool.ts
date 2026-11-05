// SPDX-License-Identifier: BUSL-1.1
/**
 * One tool of an external MCP server, projected to a signed-in person as the
 * tool it natively is.
 *
 * A record-derived Operation is a contract core owns: its tool name is derived
 * from its key, its annotations from its effects, and its answer is the
 * Operation envelope. None of that survives contact with a tool discovered at
 * runtime, whose name, schemas, annotations and `CallToolResult` belong to the
 * upstream server. `RuntimeOperationDefinition.nativeMcpTool` marks that case.
 * The definition stays an ordinary provider Operation — same session-scoped
 * listing, same live `get`, same execution policies and interceptors — and only
 * the MCP projection of its contract and result becomes verbatim.
 *
 * What a provider owes core:
 *
 *   - `list` and `get` answer from what was stored at discovery, under the
 *     caller's session. They never reach the upstream server: `tools/list` and
 *     every tool call resolve through them. A provider that fails or stalls is
 *     left out; it does not take the session's other tools with it.
 *   - The definition names the Connection the tool belongs to. Core binds the
 *     execution to it, so `resolveConnectionValues` inside `execute` refuses
 *     any other row, and that call is where the caller's ownership is decided.
 *     This binding covers core's credential resolver; providers must also use
 *     core's grant-bound egress and must not maintain a separate credential or
 *     transport path that bypasses it.
 *   - `effects` and `reliability` say what core can actually know about an
 *     unverified upstream tool: it may write, and retrying it is not safe.
 *     Upstream annotations are the server's own hints; they are projected
 *     unchanged and never decide anything here.
 *   - A successful Operation answers `data: RuntimeNativeMcpToolResult`. A tool
 *     that reports `isError` still completed: it is a result, not a failure of
 *     the Operation, so nothing retries it.
 */

export type RuntimeNativeMcpTool = {
  /** The exact name offered to this session; unique in it, and not a module namespace. */
  name: string;
  /** The Connection every credential of this tool must come from. */
  connectionId: string;
  title?: string;
  /** The upstream `outputSchema`, unchanged. */
  outputSchema?: Readonly<Record<string, unknown>>;
  /** The upstream `annotations`, unchanged: hints, never a policy input. */
  annotations?: Readonly<Record<string, unknown>>;
  /** The upstream tool `_meta`, unchanged. */
  meta?: Readonly<Record<string, unknown>>;
};

/** An MCP `CallToolResult`, as the upstream server answered it. */
export type RuntimeNativeMcpToolResult = {
  content: readonly Readonly<Record<string, unknown>>[];
  structuredContent?: Readonly<Record<string, unknown>>;
  isError?: boolean;
  _meta?: Readonly<Record<string, unknown>>;
};

/** The only effects core accepts: nothing proves an upstream tool does not write. */
export const RUNTIME_NATIVE_MCP_EFFECTS = Object.freeze({ data: "read", external: "write" } as const);

/** The canonical output of a native tool, for every caller that is not its dedicated MCP tool. */
export const RUNTIME_NATIVE_MCP_OUTPUT = Object.freeze({
  kind: "json-schema",
  schema: Object.freeze({
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object", properties: { type: { type: "string" } }, required: ["type"] } },
      structuredContent: { type: "object" },
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  }),
});

/** No dots: a dotted name is a module's namespace, and resolves to a module tool. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, accepts: (value: unknown) => boolean): boolean {
  return value === undefined || accepts(value);
}

function isObjectSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "object";
}

type NativeToolDefinition = {
  intent: string;
  nativeMcpTool?: unknown;
  input: Readonly<Record<string, unknown>>;
  effects: { data: string; external: string };
  reliability: { idempotency: { mode: string } };
  interaction?: unknown;
  prerequisites?: unknown;
  concurrency?: unknown;
};

/**
 * Why this definition cannot be a native tool, or `undefined` when it can.
 * Discovered data, so a bad entry is refused one definition at a time.
 *
 * Interaction, prerequisite and concurrency controls are refused rather than
 * ignored: a native tool takes exactly its upstream arguments, so it has nowhere
 * to carry them and would run without the control its definition promised.
 */
export function nativeMcpToolProblem(definition: NativeToolDefinition): string | undefined {
  const tool = definition.nativeMcpTool;
  if (!isRecord(tool)) return "nativeMcpTool is not an object";
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) return "the tool name is not usable";
  if (typeof tool.connectionId !== "string" || !UUID.test(tool.connectionId)) return "the Connection id is not a UUID";
  if (!optional(tool.title, (title) => typeof title === "string")) return "the title is not a string";
  if (!optional(tool.outputSchema, isObjectSchema)) return "the output schema is not an object schema";
  if (!optional(tool.annotations, isRecord)) return "the annotations are not an object";
  if (!optional(tool.meta, isRecord)) return "the metadata is not an object";
  if (definition.intent !== "invoke") return "the intent is not invoke";
  if (definition.input.kind !== "json-schema" || !isObjectSchema(definition.input.schema)) {
    return "the input is not a JSON Schema object";
  }
  if (
    definition.effects.data !== RUNTIME_NATIVE_MCP_EFFECTS.data ||
    definition.effects.external !== RUNTIME_NATIVE_MCP_EFFECTS.external
  ) {
    return "the effects claim more than core can know";
  }
  if (definition.reliability.idempotency.mode !== "none") return "the tool claims idempotency";
  if (
    definition.interaction !== undefined ||
    definition.prerequisites !== undefined ||
    definition.concurrency !== undefined
  ) {
    return "the tool declares controls it cannot carry";
  }
  return undefined;
}

/**
 * The value as an upstream `CallToolResult`, unchanged, or `undefined`.
 * Only the protocol's own shape is checked: a block type this build has not
 * heard of is still the upstream server's to send.
 */
export function parseNativeMcpToolResult(value: unknown): RuntimeNativeMcpToolResult | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const wellFormed = value.content.every((block) => isRecord(block) && typeof block.type === "string") &&
    optional(value.structuredContent, isRecord) &&
    optional(value.isError, (isError) => typeof isError === "boolean") &&
    optional(value._meta, isRecord);
  return wellFormed ? value as RuntimeNativeMcpToolResult : undefined;
}
