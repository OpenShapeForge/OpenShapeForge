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
import { type ElicitOnCreateEntry } from "./elicitation.js";

export {
  renderConfigurationExpiredPage,
  renderConfigurationFailedPage,
  renderConfigurationForm,
  renderConfigurationSavedPage,
  type ConfigurationFormOptions,
} from "./browser-pages.js";
import { keyringFromEnv } from "../connectors/secrets.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import {
  consumeHandoff,
  consumeHandoffForSession,
  createHandoff,
  readHandoff,
  readLatestHandoffForSession,
} from "./handoff-store.js";

export type JsonRecord = Record<string, unknown>;

// Long enough for the person's detour through a provider portal (registering
// an OAuth client, fetching values from a password manager) — ten minutes
// proved too short for that in live testing.
const TOKEN_TTL_MS = 30 * 60 * 1000;
export const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";

export type StoredFieldDefinition = {
  key?: unknown;
  osfType?: unknown;
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


