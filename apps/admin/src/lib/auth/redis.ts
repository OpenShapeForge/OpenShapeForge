// SPDX-License-Identifier: BUSL-1.1
/**
 * Server-side session store for the control plane.
 *
 * A faithful port of `apps/web/src/lib/auth/redis.ts` — same client options,
 * same cluster/TLS handling, same read-through cache — kept faithful on
 * purpose: the two apps run against the same Redis, and a divergence in
 * timeouts or cluster handling here would only ever be discovered as an
 * operational surprise in whichever app got it wrong.
 *
 * TWO deliberate differences, both about not sharing state with apps/web:
 *
 *  1. `SESSION_PREFIX` / `REFRESH_LOCK_PREFIX` are namespaced under
 *     `openshapeforge-admin:`, so a control-plane session and a tenant-app
 *     session can never collide on a key, and flushing one app's sessions
 *     cannot take out the other's.
 *  2. `StoredSession` has NO `tenantId`, `actorType`, or `groups`. Control-realm
 *     tokens carry no `tid` claim and the realm has no groups (see
 *     `packages/compiler/config/authoring/authorization.control.yaml`), so
 *     rather than storing empty strings that read like "tenant unknown", the
 *     fields do not exist. An operator belongs to no tenant; that is the point
 *     of the realm.
 */
import { Cluster, Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import {
  DEV_REDIS_URL,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_MAX_RETRY_ATTEMPTS,
  redisRetryStrategy,
} from "./redis-config";

// Single-node Redis for local dev, sharded Redis Cluster on Scaleway managed
// (cluster_size > 1). Both expose the same Commander surface for the
// commands this module uses (set/get/del), so we union the two types and let
// the same call sites work for either.
type RedisClient = Redis | Cluster;

/**
 * The session payload stored in Redis.
 *
 * Everything that would otherwise be baked into the encrypted session cookie.
 * The cookie holds only an opaque session id that references this record.
 */
export interface StoredSession {
  sub?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
  email?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  /**
   * Realm roles plus every client role, flattened. The control plane authorizes
   * on exactly one of them — `platform-operator` — but the whole list is kept
   * so a future gate does not have to re-derive it from the raw token.
   */
  roles?: string[];
  expiresAt?: number;
  refreshExpiresAt?: number;
  error?: string;
}

const SESSION_PREFIX = "openshapeforge-admin:session:";
/** Default TTL when refreshExpiresAt is unknown (30 minutes). */
const DEFAULT_SESSION_TTL_S = 1800;
export const SESSION_ATOMIC_COMMAND_KEY_COUNT = 1;
export const SESSION_COMPARE_AND_SET_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1 else return 0 end";
export const SESSION_GET_AND_DELETE_SCRIPT =
  "local value = redis.call('get', KEYS[1]); if value then redis.call('del', KEYS[1]) end; return value";

function sessionTtlSeconds(data: StoredSession): number {
  const nowS = Math.floor(Date.now() / 1000);
  return data.refreshExpiresAt
    ? Math.max(data.refreshExpiresAt - nowS, 60)
    : DEFAULT_SESSION_TTL_S;
}

function parseStoredSession(raw: unknown): StoredSession | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

// Lazy singleton — connection is created on first use.
let client: RedisClient | null = null;

function resetRedisClient(): void {
  const current = client as (RedisClient & { disconnect?: () => void }) | null;
  client = null;
  current?.disconnect?.();
}

function shouldRetryRedisOperation(error: unknown): boolean {
  return error instanceof Error && /connection is closed/i.test(error.message);
}

async function withRedis<T>(operation: (redis: RedisClient) => Promise<T>): Promise<T> {
  try {
    return await operation(getRedis());
  } catch (error) {
    if (!shouldRetryRedisOperation(error)) {
      throw error;
    }

    resetRedisClient();
    return operation(getRedis());
  }
}

function getRedis(): RedisClient {
  if (!client) {
    const url = process.env.REDIS_URL ?? DEV_REDIS_URL;
    // Managed Redis presents a cert signed by the provider's own CA on its
    // private-network endpoint; REDIS_CA_CERT carries that PEM so ioredis can
    // validate the server with strict rejectUnauthorized. Plain redis://
    // (local dev) skips the tls block entirely.
    const parsed = new URL(url);
    const useTls = parsed.protocol === "rediss:";
    const ca = process.env.REDIS_CA_CERT;
    // A managed Redis is often a sharded cluster (cluster_size > 1), and
    // single-node ioredis throws MOVED on the first cross-shard command. The
    // deployed environment sets REDIS_CLUSTER_MODE=true; local dev's
    // single-node Redis leaves it unset.
    const useCluster = process.env.REDIS_CLUSTER_MODE === "true";
    if (useCluster) {
      const port = parsed.port ? Number(parsed.port) : 6379;
      client = new Cluster([{ host: parsed.hostname, port }], {
        redisOptions: {
          username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
          password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
          commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
          maxRetriesPerRequest: REDIS_MAX_RETRY_ATTEMPTS,
          tls: useTls ? { ca, rejectUnauthorized: true } : undefined,
        },
        enableReadyCheck: true,
        lazyConnect: false,
        clusterRetryStrategy: redisRetryStrategy,
      });
    } else {
      client = new Redis(url, {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
        maxRetriesPerRequest: REDIS_MAX_RETRY_ATTEMPTS,
        enableReadyCheck: true,
        lazyConnect: false,
        retryStrategy: redisRetryStrategy,
        tls: useTls ? { ca, rejectUnauthorized: true } : undefined,
      });
    }
    client.on("error", (err: Error) => {
      console.error("[admin-auth:redis] Connection error:", err.message);
    });
  }
  return client;
}

/**
 * Store a session payload in Redis.
 * TTL is derived from the session's refreshExpiresAt field, with a minimum of 60s
 * and a fallback of DEFAULT_SESSION_TTL_S when refreshExpiresAt is unknown.
 */
export async function setSession(
  sessionId: string,
  data: StoredSession,
): Promise<void> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  await withRedis((redis) =>
    redis.set(key, JSON.stringify(data), "EX", sessionTtlSeconds(data)),
  );
}

/** Cluster-safe compare-and-set; see apps/web's equivalent for the race. */
export async function replaceSessionIfUnchanged(
  sessionId: string,
  expected: StoredSession,
  replacement: StoredSession,
): Promise<boolean> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  const result = await withRedis((redis) =>
    redis.eval(
      SESSION_COMPARE_AND_SET_SCRIPT,
      SESSION_ATOMIC_COMMAND_KEY_COUNT,
      key,
      JSON.stringify(expected),
      JSON.stringify(replacement),
      String(sessionTtlSeconds(replacement)),
    ),
  );
  return result === 1;
}

/**
 * Retrieve a session payload from Redis. Returns null if missing or expired.
 * This intentionally has no per-process cache so logout is immediate across
 * control-plane replicas.
 */
export async function getSession(
  sessionId: string,
): Promise<StoredSession | null> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  const raw = await withRedis((redis) => redis.get(key));
  return parseStoredSession(raw);
}

/** Delete a session from Redis immediately (used on logout). */
export async function deleteSession(sessionId: string): Promise<void> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  await withRedis((redis) => redis.del(key));
}

/**
 * Remove and return the exact session being logged out.
 *
 * The refresh lock reduces refresh/revoke overlap. Local session fencing does
 * not depend on its TTL: the single-key deletion and compare-and-set writers
 * prevent a deleted session from being recreated. The TTL does not guarantee
 * identity-provider revocation when an upstream refresh outlives the lock.
 */
export async function consumeSessionForLogout(
  sessionId: string,
): Promise<StoredSession | null> {
  const lockOwnerToken = await acquireRefreshLock(sessionId);
  if (!lockOwnerToken) {
    throw new Error("Session refresh is in progress; logout can be retried.");
  }

  try {
    const key = `${SESSION_PREFIX}${sessionId}`;
    const raw = await withRedis((redis) =>
      redis.eval(
        SESSION_GET_AND_DELETE_SCRIPT,
        SESSION_ATOMIC_COMMAND_KEY_COUNT,
        key,
      ),
    );
    return parseStoredSession(raw);
  } finally {
    try {
      await releaseRefreshLock(sessionId, lockOwnerToken);
    } catch {
      console.warn("[admin-auth:logout] Session lock release did not complete.");
    }
  }
}

const REFRESH_LOCK_PREFIX = "openshapeforge-admin:refresh-lock:";
export const REFRESH_LOCK_TTL_MS = 10_000;

/**
 * Acquire a distributed refresh lock for the given session.
 * Returns an owner token if the lock was acquired, null if another process holds it.
 */
export async function acquireRefreshLock(sessionId: string): Promise<string | null> {
  const key = `${REFRESH_LOCK_PREFIX}${sessionId}`;
  const ownerToken = randomUUID();
  const result = await withRedis((redis) =>
    redis.set(key, ownerToken, "PX", REFRESH_LOCK_TTL_MS, "NX"),
  );
  return result === "OK" ? ownerToken : null;
}

/** Release the distributed refresh lock for the given session. */
export async function releaseRefreshLock(
  sessionId: string,
  ownerToken: string,
): Promise<void> {
  const key = `${REFRESH_LOCK_PREFIX}${sessionId}`;
  await withRedis((redis) =>
    redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      ownerToken,
    ),
  );
}
