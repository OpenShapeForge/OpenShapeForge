// SPDX-License-Identifier: BUSL-1.1
/**
 * Schema discovery for provider rows — a compact, model-readable summary of
 * what a provider's declared API offers, so operations can be authored (by a
 * person or a model) from facts instead of guesses.
 *
 * Canonical row fields interpreted here: `discovery` ("openapi" |
 * "graphqlIntrospection" | "none"), `schemaUrl`, `egressHosts`. The fetch is
 * egress-checked against the row's own allow-list and unauthenticated in
 * this slice — public schema documents cover the common case; discovery
 * through a connection's credentials is a later step.
 */
import { parse as parseYaml } from "yaml";
import { HttpError } from "../rest/http-error.js";
import { hostAllowed } from "../connectors/executor.js";
import { fetchWithAllowedRedirects } from "./declarative-execution.js";
import type { ModuleEgressDispatch } from "../modules/egress.js";

type JsonRecord = Record<string, unknown>;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_OPERATIONS = 300;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type DiscoveredOperation = {
  method: string;
  path: string;
  summary?: string;
  operationId?: string;
  parameters?: string[];
  hasBody?: boolean;
};

/** OpenAPI (JSON) → flat operation list, capped and explicit about it. */
export function summarizeOpenApi(document: unknown): {
  operations: DiscoveredOperation[];
  truncated: boolean;
} {
  const paths = (document as JsonRecord | null)?.paths;
  const operations: DiscoveredOperation[] = [];
  let truncated = false;
  if (paths && typeof paths === "object") {
    for (const [path, item] of Object.entries(paths as JsonRecord)) {
      if (!item || typeof item !== "object") continue;
      for (const method of HTTP_METHODS) {
        const operation = (item as JsonRecord)[method];
        if (!operation || typeof operation !== "object") continue;
        if (operations.length >= MAX_OPERATIONS) {
          truncated = true;
          break;
        }
        const details = operation as JsonRecord;
        const parameters = Array.isArray(details.parameters)
          ? (details.parameters as JsonRecord[])
              .map((parameter) => parameter?.name)
              .filter((name): name is string => typeof name === "string")
          : [];
        operations.push({
          method: method.toUpperCase(),
          path,
          ...(typeof details.summary === "string"
            ? { summary: details.summary }
            : {}),
          ...(typeof details.operationId === "string"
            ? { operationId: details.operationId }
            : {}),
          ...(parameters.length > 0 ? { parameters } : {}),
          ...(details.requestBody ? { hasBody: true } : {}),
        });
      }
      if (truncated) break;
    }
  }
  return { operations, truncated };
}

const INTROSPECTION_QUERY = `
  query DiscoverySummary {
    __schema {
      queryType { fields { name description } }
      mutationType { fields { name description } }
    }
  }
`;

type IntrospectionField = { name?: unknown; description?: unknown };

function fieldSummaries(
  fields: unknown,
): { name: string; description?: string }[] {
  if (!Array.isArray(fields)) return [];
  return (fields as IntrospectionField[])
    .filter(
      (field): field is { name: string } => typeof field.name === "string",
    )
    .slice(0, MAX_OPERATIONS)
    .map((field) => ({
      name: field.name,
      ...(typeof (field as IntrospectionField).description === "string"
        ? { description: (field as IntrospectionField).description as string }
        : {}),
    }));
}

/**
 * Run discovery for one provider row. The result is a plain JSON summary a
 * model can turn into operation definitions.
 */
export async function discoverProviderSchema(
  row: JsonRecord,
  fetchImpl: typeof fetch = fetch,
  egressDispatch?: ModuleEgressDispatch,
): Promise<JsonRecord> {
  const mode = row.discovery;
  if (mode !== "openapi" && mode !== "graphqlIntrospection") {
    throw new HttpError(
      400,
      "DISCOVERY_UNAVAILABLE",
      `This record declares discovery "${String(mode)}"; only openapi and ` +
        `graphqlIntrospection are discoverable.`,
    );
  }
  const schemaUrlRaw = typeof row.schemaUrl === "string" ? row.schemaUrl : "";
  if (schemaUrlRaw === "") {
    throw new HttpError(
      400,
      "DISCOVERY_UNAVAILABLE",
      "This record declares no schemaUrl.",
    );
  }
  const schemaUrl = new URL(schemaUrlRaw);
  if (schemaUrl.protocol !== "https:" && schemaUrl.protocol !== "http:") {
    throw new HttpError(
      400,
      "EGRESS_DENIED",
      "Only http(s) schema documents are supported.",
    );
  }
  const egress = Array.isArray(row.egressHosts)
    ? (row.egressHosts as string[])
    : [];
  if (!hostAllowed(schemaUrl.hostname, egress)) {
    throw new HttpError(
      403,
      "EGRESS_DENIED",
      `Schema host ${schemaUrl.hostname} is not in the record's egress allow-list.`,
    );
  }

  const response = await fetchWithAllowedRedirects(
    schemaUrl,
    {
      ...(mode === "graphqlIntrospection"
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ query: INTROSPECTION_QUERY }),
          }
        : { method: "GET", headers: { accept: "application/json" } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    egress,
    fetchImpl,
    egressDispatch,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      502,
      "DISCOVERY_FAILED",
      `Schema endpoint answered ${response.status}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Real providers routinely publish their OpenAPI documents as YAML.
    try {
      parsed = parseYaml(text);
    } catch {
      throw new HttpError(
        502,
        "DISCOVERY_FAILED",
        "Schema document is neither JSON nor YAML.",
      );
    }
  }

  if (mode === "openapi") {
    const { operations, truncated } = summarizeOpenApi(parsed);
    return {
      discovery: "openapi",
      operationCount: operations.length,
      ...(truncated ? { truncated: true } : {}),
      operations,
    };
  }

  const schema = ((parsed as JsonRecord).data as JsonRecord | undefined)
    ?.__schema as JsonRecord | undefined;
  return {
    discovery: "graphqlIntrospection",
    queries: fieldSummaries(
      (schema?.queryType as JsonRecord | undefined)?.fields,
    ),
    mutations: fieldSummaries(
      (schema?.mutationType as JsonRecord | undefined)?.fields,
    ),
  };
}
