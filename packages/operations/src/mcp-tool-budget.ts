// SPDX-License-Identifier: BUSL-1.1
/**
 * The byte budget of the MCP tool list.
 *
 * The dedicated-tool count bounds how many choices a model weighs; it says
 * nothing about how much schema each choice carries, and a `tools/list` of
 * a megabyte is truncated or refused by hosted clients and eats the context
 * of a model that does receive it. The compiler measures the listing a
 * session holding every role receives — every tool it can derive from the
 * catalogue and the connector contracts, projected with the same functions
 * the runtime lists them with — and fails the build over the budget.
 *
 * Two parts of the listing are not in the catalogue and are reserved for
 * instead:
 *
 *   - the platform's fixed tools (whoami, the onboarding trio, the identity
 *     link and organization profile tools, invitations, update notices);
 *     their definitions live in the runtime and a runtime test holds them
 *     under PLATFORM_TOOL_BYTES_ALLOWANCE;
 *   - what only exists at run time: tools derived from rows (Services),
 *     runtime provider Operations, module tools and decorations. Those are a
 *     deployment's own and DYNAMIC_TOOL_BYTES_ALLOWANCE is the room the
 *     static listing leaves them.
 */

/**
 * The listing a client receives, all in: static projection plus both
 * allowances. 640 KB is where the reference catalogue sits with headroom:
 * its dedicated tools alone are 420 KB because every entity's record schema
 * is repeated in four output contracts (list, get, create, update). Tighten
 * this once those contracts share one record definition, or switch the
 * heaviest entities to the generic tools.
 */
export const MAX_ADVERTISED_TOOL_BYTES = 640 * 1024;

/**
 * The platform's fixed tools, measured at 12 KB on the reference runtime;
 * the allowance leaves room for their texts to grow. The runtime test
 * `tool-budget.unit.test.ts` fails when they no longer fit.
 */
export const PLATFORM_TOOL_BYTES_ALLOWANCE = 32 * 1024;

/**
 * Row-derived, runtime-provider and module tools. A deployment that lists
 * more than this at run time exceeds the budget without the compiler seeing
 * it; the number is a documented reservation, not a measurement.
 */
export const DYNAMIC_TOOL_BYTES_ALLOWANCE = 128 * 1024;

/** What the static projection may use once both allowances are reserved. */
export const MAX_STATIC_TOOL_BYTES =
  MAX_ADVERTISED_TOOL_BYTES - PLATFORM_TOOL_BYTES_ALLOWANCE - DYNAMIC_TOOL_BYTES_ALLOWANCE;

/** The bytes a tool takes on the wire, as `tools/list` serialises it. */
export function advertisedToolBytes(tool: unknown): number {
  return new TextEncoder().encode(JSON.stringify(tool)).length;
}
