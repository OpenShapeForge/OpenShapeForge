// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector contract loader.
 *
 * Lists and parses `connectors/<slug>.yaml` from the RESOLVED authoring tree
 * (post layer merge), then validates every identifier that will reach codegen.
 *
 * Why the checks live here rather than in the JSON schema: the schemas under
 * `config/schemas/` are not enforced anywhere today (see #182), so a loader
 * that trusted them would trust nothing. These names are emitted verbatim into
 * GraphQL SDL, Fastify route strings, OpenAPI paths and MCP tool names, so they
 * get the same fail-closed treatment `loader.ts` gives entity names, field keys
 * and `rest.basePath`.
 *
 * Connectors raise the stakes over other authoring artifacts: an entity YAML is
 * written by whoever owns this repo, while a connector contract is designed to
 * arrive from outside it — shipped by a package, or by a host repo's own
 * authoring layer. Validation at load is therefore the only point that sees
 * every contract regardless of origin.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ConnectorDefinition } from "./types/connector.js";

/** PascalCase — becomes the GraphQL namespace type and type-name prefix. */
const CONNECTOR_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** Operation, config field, and event keys — GraphQL field names. */
const CONNECTOR_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
/** REST path segments, emitted verbatim into route strings and OpenAPI paths. */
const CONNECTOR_PATH_PATTERN = /^[a-z][a-z0-9-]*$/;
/** MCP tool prefixes; the protocol constrains tool names and the runtime dispatches on them. */
const CONNECTOR_TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;
/** File stems. Also the catalog key and the installation's connector_slug. */
const CONNECTOR_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * Egress allowlist entries: a hostname, optionally with a single leftmost `*`
 * label. Anything else — schemes, ports, paths, CIDR, bare `*` — is refused,
 * because the entry is compared against a resolved request host and a loose
 * pattern silently widens the grant.
 */
const CONNECTOR_EGRESS_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function fail(
  value: unknown,
  pattern: RegExp,
  what: string,
  origin: string,
): never {
  throw new Error(
    `Unsafe ${what} ${JSON.stringify(value)} in ${origin} — must match ${pattern}. ` +
      `Connector identifiers are emitted verbatim into generated code (GraphQL SDL, ` +
      `REST routes, OpenAPI paths, MCP tool names) and cannot contain other characters.`,
  );
}

function requireIdentifier(
  value: unknown,
  pattern: RegExp,
  what: string,
  origin: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(value, pattern, what, origin);
  }
  return value;
}

/**
 * Recursively validates every field `key` in a field array, including the
 * nested `children` / `item` / `shape` positions the field vocabulary allows.
 * Mirrors validateFieldKeys in loader.ts.
 */
function validateFieldKeys(fields: unknown, origin: string): void {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const candidate = field as {
      key?: unknown;
      children?: unknown;
      item?: unknown;
      shape?: unknown;
    };
    requireIdentifier(candidate.key, CONNECTOR_KEY_PATTERN, "field key", origin);
    validateFieldKeys(candidate.children, origin);
    if (candidate.item) validateFieldKeys([candidate.item], origin);
    validateFieldKeys(candidate.shape, origin);
  }
}

/**
 * Validates every identifier on a parsed connector contract. Exported so the
 * compiler can re-assert the invariant for callers that bypass the YAML loader
 * (tests, programmatic authoring), matching how buildRest and buildMcp re-check
 * their own patterns.
 */
export function validateConnectorContentIdentifiers(
  definition: ConnectorDefinition,
  origin: string,
): void {
  requireIdentifier(
    definition.connector,
    CONNECTOR_NAME_PATTERN,
    "connector name",
    origin,
  );

  for (const operation of definition.operations ?? []) {
    requireIdentifier(operation?.key, CONNECTOR_KEY_PATTERN, "operation key", origin);
    validateFieldKeys(operation?.input, origin);
    validateFieldKeys(operation?.output?.fields, origin);
    if (operation?.rest?.path !== undefined) {
      requireIdentifier(
        operation.rest.path,
        CONNECTOR_PATH_PATTERN,
        "operation rest path",
        origin,
      );
    }
  }

  for (const event of definition.events ?? []) {
    requireIdentifier(event?.key, CONNECTOR_KEY_PATTERN, "event key", origin);
    validateFieldKeys(event?.payload, origin);
  }

  validateFieldKeys(definition.configuration?.fields, origin);

  const rest = definition.exposure?.rest;
  if (typeof rest === "object" && rest !== null && rest.basePath !== undefined) {
    requireIdentifier(rest.basePath, CONNECTOR_PATH_PATTERN, "rest basePath", origin);
  }

  const mcp = definition.exposure?.mcp;
  if (typeof mcp === "object" && mcp !== null && mcp.toolPrefix !== undefined) {
    requireIdentifier(
      mcp.toolPrefix,
      CONNECTOR_TOOL_PREFIX_PATTERN,
      "mcp toolPrefix",
      origin,
    );
  }

  for (const host of definition.network?.egress ?? []) {
    if (typeof host !== "string" || !CONNECTOR_EGRESS_PATTERN.test(host)) {
      throw new Error(
        `Unsafe egress host ${JSON.stringify(host)} in ${origin} — must match ` +
          `${CONNECTOR_EGRESS_PATTERN}. The allowlist is compared against a resolved ` +
          `request host; schemes, ports, paths and bare wildcards would widen the grant.`,
      );
    }
  }
}

/**
 * Lists connector contracts under `connectors/`. Subfolders are organizational
 * only — the slug is the file stem and must be unique across the whole tree,
 * exactly like entity slugs. `_`-prefixed files are reserved for shared meta
 * definitions and are never contracts.
 */
export function listConnectorFiles(
  authoringDir: string,
): { slug: string; path: string }[] {
  const root = join(authoringDir, "connectors");
  const results: { slug: string; path: string }[] = [];

  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".yaml") &&
        !entry.name.startsWith("_")
      ) {
        results.push({ slug: entry.name.slice(0, -".yaml".length), path: fullPath });
      }
    }
  };
  walk(root);

  results.sort((a, b) => a.slug.localeCompare(b.slug));

  const seen = new Map<string, string>();
  for (const file of results) {
    const existing = seen.get(file.slug);
    if (existing) {
      throw new Error(
        `Duplicate connector slug "${file.slug}" (${existing} vs ${file.path}). ` +
          "Connector slugs must be unique across the whole connectors/ tree.",
      );
    }
    seen.set(file.slug, file.path);
  }

  return results;
}

/** Parses and validates one connector contract. */
export function loadConnector(
  filePath: string,
  slug: string,
  origin: string,
): ConnectorDefinition {
  const parsed = parseYaml(readFileSync(filePath, "utf8")) as ConnectorDefinition | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Connector contract ${origin} is empty or not a YAML mapping.`);
  }
  if (parsed.kind !== "connector") {
    throw new Error(
      `Connector contract ${origin} must declare kind: connector (got ${JSON.stringify(parsed.kind)}).`,
    );
  }
  if (!CONNECTOR_SLUG_PATTERN.test(slug)) {
    fail(slug, CONNECTOR_SLUG_PATTERN, "connector slug (file name)", origin);
  }
  validateConnectorContentIdentifiers(parsed, origin);
  return parsed;
}
