// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  decryptSecret,
  encryptSecret,
  type SecretKeyring,
} from "../connectors/secrets.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256(value: string): string {
  return base64url(createHash("sha256").update(value).digest());
}

function parseToken(
  token: unknown,
): { tenantId: string; userId: string; hash: string } | null {
  if (typeof token !== "string") return null;
  const [tenantId, userId, secret, ...rest] = token.split(".");
  if (rest.length > 0 || !tenantId || !userId || !secret) return null;
  if (!UUID.test(tenantId) || !UUID.test(userId)) return null;
  return { tenantId, userId, hash: sha256(secret) };
}

export async function createHandoff(input: {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  kind: "entity_oauth" | "entity_configuration";
  tenantId: string;
  userId: string;
  payload: Record<string, unknown>;
  expiresAtMs: number;
}): Promise<string> {
  const secret = base64url(randomBytes(32));
  const token = `${input.tenantId}.${input.userId}.${secret}`;
  const id = randomUUID();
  const encrypted = encryptSecret(
    input.keyring,
    id,
    "payload",
    JSON.stringify(input.payload),
  );
  const session: DbSessionInput = {
    tenantId: input.tenantId,
    userId: input.userId,
    roles: [],
    groups: [],
    scope: "self",
  };
  await withDbSession(input.db, session, async (trx) => {
    await sql`
      insert into platform.mcp_handoffs
        (id, tenant_id, user_id, kind, token_hash, payload_ciphertext,
         payload_key_id, payload_algorithm, expires_at)
      values
        (${id}::uuid, ${input.tenantId}::uuid, ${input.userId}::uuid, ${input.kind},
         ${sha256(secret)}, ${encrypted.ciphertext}, ${encrypted.keyId},
         ${encrypted.algorithm}, ${new Date(input.expiresAtMs)})
    `.execute(trx);
  });
  return token;
}

export async function readHandoff<T extends Record<string, unknown>>(input: {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  kind: "entity_oauth" | "entity_configuration";
  token: unknown;
  consume: boolean;
}): Promise<T | null> {
  const parsed = parseToken(input.token);
  if (!parsed) return null;
  const session: DbSessionInput = {
    tenantId: parsed.tenantId,
    userId: parsed.userId,
    roles: [],
    groups: [],
    scope: "self",
  };
  const row = await withDbSession(input.db, session, async (trx) => {
    const result = input.consume
      ? await sql<{
          id: string;
          payload_ciphertext: string;
          payload_key_id: string;
          payload_algorithm: string;
        }>`
          update platform.mcp_handoffs
             set consumed_at = now()
           where token_hash = ${parsed.hash}
             and kind = ${input.kind}
             and consumed_at is null
             and expires_at > now()
          returning id, payload_ciphertext, payload_key_id, payload_algorithm
        `.execute(trx)
      : await sql<{
          id: string;
          payload_ciphertext: string;
          payload_key_id: string;
          payload_algorithm: string;
        }>`
          select id, payload_ciphertext, payload_key_id, payload_algorithm
            from platform.mcp_handoffs
           where token_hash = ${parsed.hash}
             and kind = ${input.kind}
             and consumed_at is null
             and expires_at > now()
           limit 1
        `.execute(trx);
    return result.rows[0] ?? null;
  });
  if (!row) return null;
  try {
    return JSON.parse(
      decryptSecret(input.keyring, row.id, "payload", {
        ciphertext: row.payload_ciphertext,
        keyId: row.payload_key_id,
        algorithm: row.payload_algorithm,
      }),
    ) as T;
  } catch {
    return null;
  }
}

/**
 * Read the newest live handoff for an already-authenticated person. Unlike the
 * token lookup, this path is for the KERN web fallback: the browser proves the
 * tenant/user through its normal login, so no bearer handoff token needs to be
 * exposed in the assistant conversation.
 */
export async function readLatestHandoffForSession<
  T extends Record<string, unknown>,
>(input: {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  kind: "entity_oauth" | "entity_configuration";
  session: DbSessionInput;
}): Promise<{ id: string; payload: T } | null> {
  const row = await withDbSession(input.db, input.session, async (trx) => {
    const result = await sql<{
      id: string;
      payload_ciphertext: string;
      payload_key_id: string;
      payload_algorithm: string;
    }>`
      select id, payload_ciphertext, payload_key_id, payload_algorithm
        from platform.mcp_handoffs
       where kind = ${input.kind}
         and consumed_at is null
         and expires_at > now()
       order by created_at desc
       limit 1
    `.execute(trx);
    return result.rows[0] ?? null;
  });
  if (!row) return null;
  try {
    return {
      id: row.id,
      payload: JSON.parse(
        decryptSecret(input.keyring, row.id, "payload", {
          ciphertext: row.payload_ciphertext,
          keyId: row.payload_key_id,
          algorithm: row.payload_algorithm,
        }),
      ) as T,
    };
  } catch {
    return null;
  }
}

/** Consume an authenticated person's handoff by its non-secret database id. */
export async function consumeHandoffForSession(input: {
  db: OpenShapeForgeDatabase;
  kind: "entity_oauth" | "entity_configuration";
  id: unknown;
  session: DbSessionInput;
}): Promise<boolean> {
  if (typeof input.id !== "string" || !UUID.test(input.id)) return false;
  return withDbSession(input.db, input.session, async (trx) => {
    const result = await sql`
      update platform.mcp_handoffs
         set consumed_at = now()
       where id = ${input.id}::uuid
         and kind = ${input.kind}
         and consumed_at is null
         and expires_at > now()
    `.execute(trx);
    return Number(result.numAffectedRows) === 1;
  });
}

export async function consumeHandoff(input: {
  db: OpenShapeForgeDatabase;
  kind: "entity_oauth" | "entity_configuration";
  token: unknown;
}): Promise<void> {
  const parsed = parseToken(input.token);
  if (!parsed) return;
  const session: DbSessionInput = {
    tenantId: parsed.tenantId,
    userId: parsed.userId,
    roles: [],
    groups: [],
    scope: "self",
  };
  await withDbSession(input.db, session, async (trx) => {
    await sql`
      update platform.mcp_handoffs
         set consumed_at = now()
       where token_hash = ${parsed.hash}
         and kind = ${input.kind}
         and consumed_at is null
    `.execute(trx);
  });
}
