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
 * So the decline path becomes a handoff instead of an error. MCP App clients
 * receive the single-use token only in private UI metadata. Other clients get
 * a stable host web URL; the signed-in web app resolves the newest handoff by
 * tenant/user, so no bearer handoff URL enters model context. Both paths render
 * the same field definitions. Values post straight to the runtime (secrets
 * encrypted at rest, never through any MCP client); submitting creates the row
 * and consumes the handoff.
 *
 * This mirrors the entity-oauth handoff: production persists the encrypted
 * pending payload in the database while only the token hash is stored for
 * lookup. The in-memory store below exists only for dependency-free unit tests.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  elicitationSchemaFromDefinitions,
  isSecretDefinition,
  storeElicitedValues,
  type ElicitOnCreateEntry,
} from "./elicitation.js";
import { keyringFromEnv, type SecretKeyring } from "../connectors/secrets.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  consumeHandoff,
  consumeHandoffForSession,
  createHandoff,
  readHandoff,
  readLatestHandoffForSession,
} from "./handoff-store.js";

type JsonRecord = Record<string, unknown>;

// Long enough for the person's detour through a provider portal (registering
// an OAuth client, fetching values from a password manager) — ten minutes
// proved too short for that in live testing.
const TOKEN_TTL_MS = 30 * 60 * 1000;
const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";

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

/** Unit-test fallback; production callers always pass a database. */
const pendingByToken = new Map<string, PendingConfiguration>();

function sweep(): void {
  const now = Date.now();
  for (const [token, pending] of pendingByToken) {
    if (pending.expiresAtMs < now) pendingByToken.delete(token);
  }
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint the handoff. The URL path is the caller's to compose from the token. */
export async function mintConfiguration(
  input: Omit<PendingConfiguration, "token" | "expiresAtMs"> & {
    db?: OpenShapeForgeDatabase;
  },
): Promise<{ token: string; expiresInSeconds: number }> {
  sweep();
  const expiresAtMs = Date.now() + TOKEN_TTL_MS;
  const { db, ...payload } = input;
  let token: string;
  if (db) {
    const keyring = keyringFromEnv(process.env[KEYRING_ENV]);
    if (!keyring) throw new Error(`Set ${KEYRING_ENV}.`);
    token = await createHandoff({
      db,
      keyring,
      kind: "entity_configuration",
      tenantId: input.tenantId,
      userId: input.userId,
      payload: { ...payload, expiresAtMs },
      expiresAtMs,
    });
  } else {
    token = base64url(randomBytes(24));
    pendingByToken.set(token, { ...payload, token, expiresAtMs });
  }
  return { token, expiresInSeconds: TOKEN_TTL_MS / 1000 };
}

/** Non-consuming lookup: the person may reload the form or fix a mistake. */
export async function peekConfiguration(
  token: unknown,
  db?: OpenShapeForgeDatabase,
): Promise<PendingConfiguration | null> {
  sweep();
  if (typeof token !== "string" || token.length === 0) return null;
  if (db) {
    const keyring = keyringFromEnv(process.env[KEYRING_ENV]);
    if (!keyring) return null;
    const payload = await readHandoff<Omit<PendingConfiguration, "token">>({
      db,
      keyring,
      kind: "entity_configuration",
      token,
      consume: false,
    });
    return payload ? { ...payload, token } : null;
  }
  return pendingByToken.get(token) ?? null;
}

/** Burn the token after a successful submission. */
export async function consumeConfiguration(
  token: string,
  db?: OpenShapeForgeDatabase,
): Promise<void> {
  if (db) {
    await consumeHandoff({ db, kind: "entity_configuration", token });
    return;
  }
  pendingByToken.delete(token);
}

/** Resolve the latest handoff through the normal authenticated web session. */
export async function latestConfigurationForSession(
  session: DbSessionInput,
  db: OpenShapeForgeDatabase,
): Promise<{ id: string; pending: PendingConfiguration } | null> {
  const keyring = keyringFromEnv(process.env[KEYRING_ENV]);
  if (!keyring) return null;
  const found = await readLatestHandoffForSession<
    Omit<PendingConfiguration, "token">
  >({
    db,
    keyring,
    kind: "entity_configuration",
    session,
  });
  return found
    ? { id: found.id, pending: { ...found.payload, token: "" } }
    : null;
}

/** Consume a handoff already authorized by the signed-in web session. */
export async function consumeConfigurationForSession(
  id: string,
  session: DbSessionInput,
  db: OpenShapeForgeDatabase,
): Promise<boolean> {
  return consumeHandoffForSession({
    db,
    kind: "entity_configuration",
    id,
    session,
  });
}

function localized(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const en = (value as JsonRecord).en;
    if (typeof en === "string") return en;
    const first = Object.values(value as JsonRecord).find(
      (entry) => typeof entry === "string",
    );
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
  const valueType =
    typeof definition.valueType === "string" ? definition.valueType : "string";
  if (valueType === "boolean") return { value: raw !== null };
  if (raw === null || raw === "") {
    return definition.required === true
      ? { error: "This value is required." }
      : {};
  }
  if (valueType === "integer") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed)
      ? { error: "Enter a whole number." }
      : { value: parsed };
  }
  if (valueType === "number") {
    const parsed = Number.parseFloat(raw);
    return Number.isNaN(parsed)
      ? { error: "Enter a number." }
      : { value: parsed };
  }
  return { value: raw };
}

export type ParsedSubmission = {
  content: JsonRecord;
  errors: Record<string, string>;
};

/** The exact field subset both browser renderers and submission parsing use. */
export function configurationFormDefinitions(
  pending: PendingConfiguration,
): JsonRecord[] {
  return elicitationSchemaFromDefinitions(pending.definitions)
    .elicitable as JsonRecord[];
}

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

let configurationAppScript: Promise<string> | undefined;

async function bundledConfigurationApp(): Promise<string> {
  configurationAppScript ??= (async () => {
    const result = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL("./configuration-app-client.ts", import.meta.url),
        ),
      ],
      target: "browser",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success || !result.outputs[0]) {
      throw new Error(
        `MCP App bundle failed: ${result.logs.map(String).join("; ")}`,
      );
    }
    return result.outputs[0].text();
  })();
  return configurationAppScript;
}

/** Single-file MCP App; tool-result metadata supplies the private form URL. */
export async function renderConfigurationApp(): Promise<string> {
  const script = await bundledConfigurationApp();
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Secure configuration</title>` +
    `<body style="${PAGE_STYLE}"><h2 id="configuration-title" style="font-size:1.2rem">Secure configuration</h2>` +
    `<p id="configuration-message">Preparing the secure form…</p>` +
    `<button id="configuration-open" hidden type="button" ` +
    `style="padding:.6rem 1rem;border:1px solid #777;border-radius:6px;background:transparent">` +
    `Open in browser</button>` +
    `<iframe id="configuration-frame" hidden title="Secure configuration" ` +
    `style="width:100%;min-height:32rem;border:1px solid #ccc;border-radius:6px"></iframe>` +
    `<script type="module">${script}</script></body>`
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
  options: {
    /** Verification failure shown above the form after a rejected submit. */
    errorBanner?: string;
    /** Non-secret values to prefill on a retry; secrets are never echoed. */
    prefill?: Record<string, unknown>;
  } = {},
): string {
  const { elicitable, skipped } = elicitationSchemaFromDefinitions(
    pending.definitions,
  );
  const rows = (elicitable as StoredFieldDefinition[])
    .map((definition) => {
      const key = definition.key as string;
      const escapedKey = escapeHtml(key);
      const label = escapeHtml(localized(definition.label) || key);
      const description = escapeHtml(localized(definition.description));
      const required = definition.required === true;
      const error = errors[key];
      const valueType =
        typeof definition.valueType === "string"
          ? definition.valueType
          : "string";
      const optionItems = definition.options?.items;

      let control: string;
      if (Array.isArray(optionItems) && optionItems.length > 0) {
        const options = optionItems
          .filter((item) => typeof item?.value === "string")
          .map((item) => {
            const value = escapeHtml(item.value as string);
            const text = escapeHtml(
              localized(item.label) || (item.value as string),
            );
            return `<option value="${value}">${text}</option>`;
          })
          .join("");
        control = `<select name="${escapedKey}" style="width:100%;padding:.5rem">${required ? "" : `<option value=""></option>`}${options}</select>`;
      } else if (valueType === "boolean") {
        control = `<input type="checkbox" name="${escapedKey}">`;
      } else {
        const secret = isSecretDefinition(definition as never);
        const type = secret
          ? "password"
          : valueType === "integer" || valueType === "number"
            ? "number"
            : "text";
        const step = valueType === "number" ? ` step="any"` : "";
        const prefillValue = !secret && options.prefill?.[key];
        const valueAttribute =
          prefillValue !== undefined &&
          prefillValue !== null &&
          prefillValue !== false
            ? ` value="${escapeHtml(String(prefillValue))}"`
            : "";
        control =
          `<input type="${type}" name="${escapedKey}"${step}${valueAttribute}${required ? " required" : ""} ` +
          `autocomplete="off" style="width:100%;padding:.5rem;box-sizing:border-box">`;
      }

      return (
        `<label style="display:block;margin:1rem 0">` +
        `<span style="font-weight:600">${label}${required ? " *" : ""}</span>` +
        (description ? `<br><small>${description}</small>` : "") +
        `<br>${control}` +
        (error
          ? `<br><small style="color:#b00">${escapeHtml(error)}</small>`
          : "") +
        `</label>`
      );
    })
    .join("");

  const banner = options.errorBanner
    ? `<p style="background:#fde8e8;border:1px solid #d08c8c;padding:.75rem;border-radius:6px">` +
      `${escapeHtml(options.errorBanner)} Nothing was saved; correct the values and save again.</p>`
    : "";
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
    banner +
    prefix +
    `<form method="post" action="${escapeHtml(actionPath)}">${rows}` +
    `<button type="submit" style="padding:.5rem 1.5rem">Save</button></form>` +
    skippedNote +
    `</body>`
  );
}
