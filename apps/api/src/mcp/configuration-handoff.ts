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
  storeElicitedValues,
  type ElicitOnCreateEntry,
} from "./elicitation.js";
import { renderNoticePage } from "./browser-pages.js";

export {
  renderConfigurationExpiredPage,
  renderConfigurationFailedPage,
  renderConfigurationForm,
  renderConfigurationSavedPage,
  type ConfigurationFormOptions,
} from "./browser-pages.js";
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

/**
 * The already-stored row a submission belongs to, if any: the row in the
 * target table whose `key` equals the key the model supplied when it minted
 * the handoff. A second submission for that key - a retried form, a rotated
 * secret - must update this row, never create a duplicate beside it.
 */
export function findExistingConfiguration(
  rows: readonly JsonRecord[],
  pending: Pick<PendingConfiguration, "modelValues">,
): JsonRecord | undefined {
  const wanted = pending.modelValues.key;
  if (typeof wanted !== "string" || wanted.length === 0) return undefined;
  return rows.find((row) => row.key === wanted);
}

/**
 * Merge a submission into the values a row already holds: every submitted
 * key replaces the stored value under that key (a secret submitted again is
 * the new secret, once), keys the form did not carry stay as they were.
 */
export function mergeConfigurationValues(
  existing: unknown,
  submitted: JsonRecord,
): JsonRecord {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as JsonRecord)
      : {};
  return { ...base, ...submitted };
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

/**
 * A branded single-sentence page. Call sites that know the outcome should
 * use the dedicated pages in browser-pages.ts (saved / expired / failed).
 */
export function renderMessagePage(message: string): string {
  return renderNoticePage(message);
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
