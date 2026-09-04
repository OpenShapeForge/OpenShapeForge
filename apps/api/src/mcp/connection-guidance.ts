// SPDX-License-Identifier: BUSL-1.1
/**
 * One vocabulary for "a connection is needed" — shared by the derived tool
 * descriptions, every connection failure the generated server raises, and
 * the administrator step of the onboarding checklist, so the three can never
 * disagree about what an Adapter needs or who may provide it.
 *
 * Two kinds of need, derived from the Adapter's auth block and its
 * configuration contract rather than assumed:
 *
 *   organization — the tenant-level Connection an administrator creates with
 *                  the entity's create tool (`create_connection`): required
 *                  when the Adapter declares configuration fields, or when
 *                  its auth profile references credential values (an API
 *                  key, basic credentials, an OAuth client for sign-in).
 *   personal     — the per-employee sign-in (`connect_service`): required
 *                  when connections are scoped per user (explicit
 *                  `connectionScope: user`, or a sign-in profile without an
 *                  explicit tenant scope).
 *
 * Every message names the Adapter, the tool to use and who may use it, so an
 * assistant can tell the person what to do instead of reporting a code.
 */
import { HttpError } from "../rest/http-error.js";
import { SECRET_SENSITIVITY } from "./declarative-execution.js";
import { requiredAuthValueKeys } from "./publication-validation.js";

type JsonRecord = Record<string, unknown>;

export type ConnectionNeeds = {
  /** A tenant-level Connection row with the Adapter's configuration values. */
  organization: boolean;
  /** A per-person sign-in captured through the connect tool. */
  personal: boolean;
  /** The Adapter signs people in with OAuth; a redirect URL must be registered. */
  oauthClient: boolean;
};

/**
 * Mirrors connectionScopeOf in generated-mcp-server.ts: explicit
 * auth.connectionScope wins; absent, a sign-in profile implies "user".
 */
export function connectionScopeOfAuth(auth: unknown): "user" | "tenant" {
  const record = auth && typeof auth === "object" ? (auth as JsonRecord) : null;
  if (record?.connectionScope === "user" || record?.connectionScope === "tenant") {
    return record.connectionScope;
  }
  return record?.profile === "oauth2AuthorizationCode" ? "user" : "tenant";
}

export function connectionNeedsOf(auth: unknown, definitions: unknown): ConnectionNeeds {
  const record = auth && typeof auth === "object" ? (auth as JsonRecord) : null;
  const declaredFields = Array.isArray(definitions) ? definitions.length : 0;
  return {
    organization: declaredFields > 0 || requiredAuthValueKeys(auth).length > 0,
    personal: connectionScopeOfAuth(auth) === "user",
    oauthClient: record?.profile === "oauth2AuthorizationCode",
  };
}

export type ConnectionField = {
  key: string;
  label: string;
  required: boolean;
  /** Classified confidential/secret: entered only in the secure form, stored encrypted. */
  secret: boolean;
};

function localized(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    const first = record.en ?? Object.values(record).find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return undefined;
}

/** The fields the Connection form asks for, as a person would read them. */
export function connectionFieldsOf(definitions: unknown): ConnectionField[] {
  if (!Array.isArray(definitions)) return [];
  const fields: ConnectionField[] = [];
  for (const definition of definitions as JsonRecord[]) {
    const key = definition?.key;
    if (typeof key !== "string" || key.length === 0) continue;
    const sensitivity = (definition.classification as JsonRecord | undefined)?.sensitivity;
    fields.push({
      key,
      label: localized(definition.label) ?? key,
      required: definition.required === true,
      secret: typeof sensitivity === "string" && SECRET_SENSITIVITY.has(sensitivity),
    });
  }
  return fields;
}

function hasValue(values: JsonRecord, key: string): boolean {
  const value = values[key];
  return value !== undefined && value !== null && value !== "";
}

/**
 * The required-values check test_connection runs on a tenant Connection:
 * every required definition plus every credential key the auth block
 * references must hold a value (a stored secret marker counts). Sorted.
 */
export function missingRequiredConnectionValues(
  definitions: unknown,
  auth: unknown,
  values: unknown,
): string[] {
  const stored = values && typeof values === "object" ? (values as JsonRecord) : {};
  const required = new Set<string>(requiredAuthValueKeys(auth));
  for (const field of connectionFieldsOf(definitions)) {
    if (field.required) required.add(field.key);
  }
  return [...required].filter((key) => !hasValue(stored, key)).sort();
}

/** The tool names the guidance refers to; the create tool is per connection entity. */
export type ConnectionTools = {
  /** The connection entity's create tool, e.g. create_connection. */
  create: string;
  /** The personal sign-in tool, e.g. connect_service; null when the projection has none. */
  connect: string | null;
};

/**
 * One generated sentence per need, appended to a derived tool's description:
 * "Requires the organization's Google connection; administrators set it up
 * with create_connection. Sign in once with connect_service." Empty when the
 * Adapter needs nothing.
 */
export function describeConnectionNeeds(
  adapter: string,
  needs: ConnectionNeeds,
  tools: ConnectionTools,
): string {
  const sentences: string[] = [];
  if (needs.organization) {
    sentences.push(
      `Requires the organization's ${adapter} connection; administrators set it up with ${tools.create}.`,
    );
  }
  if (needs.personal && tools.connect) {
    sentences.push(`Sign in once with ${tools.connect}.`);
  }
  return sentences.join(" ");
}

/** Append the generated sentences under an authored description. */
export function withConnectionNeeds(description: string, needs: string): string {
  if (!needs) return description;
  return description.length > 0 ? `${description}\n\n${needs}` : needs;
}

export type ConnectionProblem =
  | {
      kind: "organization_missing";
      adapter: string;
      adapterId: string;
      createTool: string;
      /** The create tool's argument naming the Adapter (elicit.sourceField). */
      adapterArgument: string;
      administrator: boolean;
      /** Values a present but incomplete Connection lacks; empty when no row exists. */
      missingValues?: string[];
      /** A minted browser handoff for an administrator; never for others. */
      configurationUrl?: string;
      expiresAt?: string;
    }
  | {
      kind: "personal_missing";
      adapter: string;
      toolName: string;
      connectTool: string | null;
    }
  | {
      kind: "tenant_sign_in";
      adapter: string;
      toolName: string;
      connectTool: string | null;
      administrator: boolean;
    }
  | {
      kind: "reauthorization";
      adapter: string;
      toolName: string;
      connectTool: string | null;
      scope: "user" | "tenant";
      /** Why, in past tense: "expired", "no longer covers the scopes a, b". */
      reason: string;
    };

const HTTP_BY_KIND: Record<ConnectionProblem["kind"], { status: number; code: string }> = {
  organization_missing: { status: 400, code: "CONNECTION_MISSING" },
  personal_missing: { status: 403, code: "CONNECTION_REQUIRED" },
  tenant_sign_in: { status: 403, code: "CONNECTION_REQUIRED" },
  reauthorization: { status: 403, code: "REAUTHORIZATION_REQUIRED" },
};

function connectCall(tool: string | null, toolName: string): string {
  return tool ? `${tool} { tool: ${JSON.stringify(toolName)} }` : "the connect tool";
}

export function connectionProblemMessage(problem: ConnectionProblem): string {
  switch (problem.kind) {
    case "organization_missing": {
      const state =
        problem.missingValues && problem.missingValues.length > 0
          ? `The organization's ${problem.adapter} connection is incomplete (missing values: ${problem.missingValues.join(", ")}).`
          : `The organization's ${problem.adapter} connection is not set up.`;
      if (!problem.administrator) {
        return `${state} Ask an organization administrator to set up the ${problem.adapter} connection (${problem.createTool}).`;
      }
      const create =
        `As an organization administrator, set it up with ${problem.createTool} ` +
        `{ ${problem.adapterArgument}: ${JSON.stringify(problem.adapterId)} }`;
      const browser = problem.configurationUrl
        ? `, or open ${problem.configurationUrl} in a browser and enter the values there` +
          (problem.expiresAt ? ` (link valid until ${problem.expiresAt})` : "") +
          `; they never pass through the chat.`
        : ".";
      return `${state} ${create}${browser}`;
    }
    case "personal_missing":
      return (
        `This tool needs your personal ${problem.adapter} sign-in. ` +
        `Call ${connectCall(problem.connectTool, problem.toolName)} and open the returned URL to approve at ${problem.adapter}.`
      );
    case "tenant_sign_in":
      return (
        `${problem.adapter} needs a one-time sign-in for the whole organization. ` +
        (problem.administrator
          ? `As an organization administrator, call ${connectCall(problem.connectTool, problem.toolName)} and approve at ${problem.adapter}.`
          : `Ask an organization administrator to call ${connectCall(problem.connectTool, problem.toolName)} and approve at ${problem.adapter}.`)
      );
    case "reauthorization":
      return problem.scope === "user"
        ? `Your ${problem.adapter} sign-in ${problem.reason}. ` +
            `Call ${connectCall(problem.connectTool, problem.toolName)} again and approve at ${problem.adapter}.`
        : `The organization's ${problem.adapter} sign-in ${problem.reason}. ` +
            `An organization administrator calls ${connectCall(problem.connectTool, problem.toolName)} again and approves at ${problem.adapter}.`;
  }
}

/** The failure every connection gap is raised as: stable code, actionable message. */
export function connectionProblemError(problem: ConnectionProblem): HttpError {
  const { status, code } = HTTP_BY_KIND[problem.kind];
  return new HttpError(status, code, connectionProblemMessage(problem));
}

const CONNECTION_CODES = new Set(Object.values(HTTP_BY_KIND).map((entry) => entry.code));

/** Whether an error is one of the connection failures this module authors. */
export function isConnectionProblemCode(code: unknown): boolean {
  return typeof code === "string" && CONNECTION_CODES.has(code);
}
