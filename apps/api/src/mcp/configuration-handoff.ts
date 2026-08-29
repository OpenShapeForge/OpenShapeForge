// SPDX-License-Identifier: BUSL-1.1
/**
 * Browser handoff for elicited configuration — the fallback when the client
 * cannot show the secure form.
 *
 * Create-time elicitation is the fast path: a capable client renders the
 * form in place and the values never touch the model. But elicitation is the
 * least-deployed client capability, and several clients DECLARE it and then
 * auto-decline every request — indistinguishable, server-side, from a person
 * saying no. Dead-ending there strands the person on exactly the step that
 * needs them.
 *
 * So the decline path becomes a handoff instead of an error: the server
 * mints a single-use, short-TTL token bound to the tenant, user and pending
 * create, and answers with a URL to a runtime-hosted form built from the
 * same field definitions that drive the elicitation schema. The person opens
 * it in a browser; values post straight to the runtime (secrets encrypted at
 * rest, never in the URL, never through any MCP client); submitting creates
 * the row and burns the token. A person who genuinely declined simply never
 * opens the link and the token expires.
 *
 * This mirrors the entity-oauth handoff — same trust shape, same in-memory
 * single-replica pending store — and anticipates MCP URL-mode elicitation
 * (SEP-1036), which standardizes exactly this pattern for sensitive values.
 */
import { randomBytes } from "node:crypto";
import {
  elicitationSchemaFromDefinitions,
  isSecretDefinition,
  storeElicitedValues,
  type ElicitOnCreateEntry,
} from "./elicitation.js";
import type { SecretKeyring } from "../connectors/secrets.js";

type JsonRecord = Record<string, unknown>;

// Long enough for the person's detour through a provider portal (registering
// an OAuth client, fetching values from a password manager) — ten minutes
// proved too short for that in live testing.
const TOKEN_TTL_MS = 30 * 60 * 1000;

type StoredFieldDefinition = {
  key?: unknown;
  valueType?: unknown;
  required?: unknown;
  label?: unknown;
  description?: unknown;
  options?: { items?: { value?: unknown; label?: unknown }[] };
};

export type PendingConfiguration = {
  token: string;
  tenantId: string;
  userId: string;
  /** Physical table the created row is written to. */
  table: string;
  elicit: ElicitOnCreateEntry;
  /** The model-supplied identity arguments, target field already removed. */
  modelValues: JsonRecord;
  /** Snapshot of the source row's field definitions at mint time. */
  definitions: JsonRecord[];
  /** Display name of the entity being configured, for the page title. */
  displayName: string;
  /** Server-known context shown above the form (e.g. the redirect URL note). */
  messagePrefix?: string | undefined;
  expiresAtMs: number;
};

const pendingByToken = new Map<string, PendingConfiguration>();

function sweep(): void {
  const now = Date.now();
  for (const [token, pending] of pendingByToken) {
    if (pending.expiresAtMs < now) pendingByToken.delete(token);
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint the handoff. The URL path is the caller's to compose from the token. */
export function mintConfiguration(
  input: Omit<PendingConfiguration, "token" | "expiresAtMs">,
): { token: string; expiresInSeconds: number } {
  sweep();
  const token = base64url(randomBytes(24));
  pendingByToken.set(token, { ...input, token, expiresAtMs: Date.now() + TOKEN_TTL_MS });
  return { token, expiresInSeconds: TOKEN_TTL_MS / 1000 };
}

/** Non-consuming lookup: the person may reload the form or fix a mistake. */
export function peekConfiguration(token: unknown): PendingConfiguration | null {
  sweep();
  if (typeof token !== "string" || token.length === 0) return null;
  return pendingByToken.get(token) ?? null;
}

/** Burn the token after a successful submission. */
export function consumeConfiguration(token: string): void {
  pendingByToken.delete(token);
}

function localized(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const en = (value as JsonRecord).en;
    if (typeof en === "string") return en;
    const first = Object.values(value as JsonRecord).find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Translate one submitted form value to the definition's type. Returns
 * undefined for an absent optional value; a string error for a bad one.
 */
function coerceValue(
  definition: StoredFieldDefinition,
  raw: string | null,
): { value?: unknown; error?: string } {
  const valueType = typeof definition.valueType === "string" ? definition.valueType : "string";
  if (valueType === "boolean") return { value: raw !== null };
  if (raw === null || raw === "") {
    return definition.required === true ? { error: "This value is required." } : {};
  }
  if (valueType === "integer") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? { error: "Enter a whole number." } : { value: parsed };
  }
  if (valueType === "number") {
    const parsed = Number.parseFloat(raw);
    return Number.isNaN(parsed) ? { error: "Enter a number." } : { value: parsed };
  }
  return { value: raw };
}

export type ParsedSubmission = {
  content: JsonRecord;
  errors: Record<string, string>;
};

/** Parse a urlencoded submission against the pending definitions. */
export function parseSubmission(
  pending: PendingConfiguration,
  body: string,
): ParsedSubmission {
  const params = new URLSearchParams(body);
  const { elicitable } = elicitationSchemaFromDefinitions(pending.definitions);
  const content: JsonRecord = {};
  const errors: Record<string, string> = {};
  for (const definition of elicitable as StoredFieldDefinition[]) {
    const key = definition.key as string;
    const { value, error } = coerceValue(definition, params.get(key));
    if (error) errors[key] = error;
    else if (value !== undefined) content[key] = value;
  }
  return { content, errors };
}

/** Encrypt-and-shape the parsed values exactly as the in-band form would. */
export function storeSubmission(
  pending: PendingConfiguration,
  content: JsonRecord,
  keyring?: SecretKeyring,
): JsonRecord {
  const { elicitable } = elicitationSchemaFromDefinitions(pending.definitions);
  return {
    ...pending.modelValues,
    [pending.elicit.into]: storeElicitedValues(
      pending.elicit.sourceTable,
      elicitable,
      content,
      keyring,
    ),
  };
}

const PAGE_STYLE =
  "font-family:system-ui;margin:3rem auto;max-width:30rem;padding:0 1rem;line-height:1.5";

export function renderMessagePage(message: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>Configuration</title>` +
    `<body style="${PAGE_STYLE}"><p>${escapeHtml(message)}</p></body>`
  );
}

/**
 * The form itself, generated from the same definitions the elicitation
 * schema uses. Secret-classified fields render as password inputs; values
 * travel only in the POST body, never in the URL.
 */
export function renderConfigurationForm(
  pending: PendingConfiguration,
  actionPath: string,
  errors: Record<string, string> = {},
): string {
  const { elicitable, skipped } = elicitationSchemaFromDefinitions(pending.definitions);
  const rows = (elicitable as StoredFieldDefinition[])
    .map((definition) => {
      const key = definition.key as string;
      const label = escapeHtml(localized(definition.label) || key);
      const description = escapeHtml(localized(definition.description));
      const required = definition.required === true;
      const error = errors[key];
      const valueType = typeof definition.valueType === "string" ? definition.valueType : "string";
      const optionItems = definition.options?.items;

      let control: string;
      if (Array.isArray(optionItems) && optionItems.length > 0) {
        const options = optionItems
          .filter((item) => typeof item?.value === "string")
          .map((item) => {
            const value = escapeHtml(item.value as string);
            const text = escapeHtml(localized(item.label) || (item.value as string));
            return `<option value="${value}">${text}</option>`;
          })
          .join("");
        control = `<select name="${key}" style="width:100%;padding:.5rem">${required ? "" : `<option value=""></option>`}${options}</select>`;
      } else if (valueType === "boolean") {
        control = `<input type="checkbox" name="${key}">`;
      } else {
        const type = isSecretDefinition(definition as never)
          ? "password"
          : valueType === "integer" || valueType === "number"
            ? "number"
            : "text";
        const step = valueType === "number" ? ` step="any"` : "";
        control =
          `<input type="${type}" name="${key}"${step}${required ? " required" : ""} ` +
          `autocomplete="off" style="width:100%;padding:.5rem;box-sizing:border-box">`;
      }

      return (
        `<label style="display:block;margin:1rem 0">` +
        `<span style="font-weight:600">${label}${required ? " *" : ""}</span>` +
        (description ? `<br><small>${description}</small>` : "") +
        `<br>${control}` +
        (error ? `<br><small style="color:#b00">${escapeHtml(error)}</small>` : "") +
        `</label>`
      );
    })
    .join("");

  const prefix = pending.messagePrefix
    ? `<p style="background:#fff6d8;border:1px solid #e0c869;padding:.75rem;border-radius:6px">${escapeHtml(pending.messagePrefix)}</p>`
    : "";
  const skippedNote =
    skipped.length > 0
      ? `<p><small>Not collected in this form: ${escapeHtml(skipped.join(", "))}.</small></p>`
      : "";

  return (
    `<!doctype html><meta charset="utf-8"><title>Configuration</title>` +
    `<body style="${PAGE_STYLE}">` +
    `<h2 style="font-size:1.2rem">Configuration for ${escapeHtml(pending.displayName)}</h2>` +
    `<p><small>Entered here, these values go directly to the runtime — never through any ` +
    `chat or model. Secret values are stored encrypted and never shown back.</small></p>` +
    prefix +
    `<form method="post" action="${escapeHtml(actionPath)}">${rows}` +
    `<button type="submit" style="padding:.5rem 1.5rem">Save</button></form>` +
    skippedNote +
    `</body>`
  );
}
