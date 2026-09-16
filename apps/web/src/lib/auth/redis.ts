// SPDX-License-Identifier: BUSL-1.1
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
 * Contains everything that was previously baked into the encrypted session cookie.
 * The cookie now holds only an opaque session ID that references this record.
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
  tenantId?: string;
  actorType?: string;
  roles?: string[];
  /**
   * Keycloak group paths the user belongs to, e.g.
   * "/openshapeforge-demo/tenant-acme/role-directie". Forwarded to the API in
   * trusted-context headers so app/API gates can authorize on group
   * membership. Translation to internal org-unit UUIDs (for RLS) happens
   * downstream once the path→org-unit lookup lands.
   */
  groups?: string[];
  expiresAt?: number;
  refreshExpiresAt?: number;
  error?: string;
}

const SESSION_PREFIX = "openshapeforge:session:";
const SESSION_CACHE_TTL_MS = 1_000;

/** Default TTL when refreshExpiresAt is unknown (30 minutes). */
const DEFAULT_SESSION_TTL_S = 1800;

// Lazy singleton — connection is created on first use.
let client: RedisClient | null = null;
const sessionCache = new Map<
  string,
  { value: StoredSession | null; expiresAt: number }
>();

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

function readSessionCache(sessionId: string): StoredSession | null | undefined {
  const cached = sessionCache.get(sessionId);
  if (!cached) return undefined;

  if (cached.expiresAt <= Date.now()) {
    sessionCache.delete(sessionId);
    return undefined;
  }

  return cached.value;
}

function writeSessionCache(sessionId: string, value: StoredSession | null): void {
  sessionCache.set(sessionId, {
    value,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

function clearSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export function __resetRedisStateForTests(): void {
  resetRedisClient();
  sessionCache.clear();
}

function getRedis(): RedisClient {
  if (!client) {
    const url = process.env.REDIS_URL ?? DEV_REDIS_URL;
    // Scaleway managed Redis presents a cert signed by Scaleway's own CA on
    // its private-network endpoint. The platform repo ships that CA's PEM
    // alongside REDIS_URL as REDIS_CA_CERT (Scaleway secret redis-ca-cert
    // → ESO → this env var) so ioredis can validate the server with strict
    // rejectUnauthorized. Plain redis:// (local dev) skips the tls block.
    const parsed = new URL(url);
    const useTls = parsed.protocol === "rediss:";
    const ca = process.env.REDIS_CA_CERT;
    // Scaleway's managed Redis on dev/prod is a sharded cluster
    // (cluster_size > 1). Single-node ioredis throws MOVED on the first
    // cross-shard command. Helm sets REDIS_CLUSTER_MODE=true on the
    // deployed env; local dev's single-node Redis leaves it unset.
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
      console.error("[auth:redis] Connection error:", err.message);
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
  const nowS = Math.floor(Date.now() / 1000);
  const ttl = data.refreshExpiresAt
    ? Math.max(data.refreshExpiresAt - nowS, 60)
    : DEFAULT_SESSION_TTL_S;
  await withRedis((redis) => redis.set(key, JSON.stringify(data), "EX", ttl));
  writeSessionCache(sessionId, data);
}

/** Retrieve a session payload from Redis. Returns null if missing or expired. */
export async function getSession(
  sessionId: string,
): Promise<StoredSession | null> {
  const cached = readSessionCache(sessionId);
  if (cached !== undefined) {
    return cached;
  }

  const key = `${SESSION_PREFIX}${sessionId}`;
  const raw = await withRedis((redis) => redis.get(key));
  if (!raw) {
    writeSessionCache(sessionId, null);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    writeSessionCache(sessionId, parsed);
    return parsed;
  } catch {
    clearSessionCache(sessionId);
    return null;
  }
}

/** Delete a session from Redis immediately (used on logout). */
export async function deleteSession(sessionId: string): Promise<void> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  await withRedis((redis) => redis.del(key));
  clearSessionCache(sessionId);
}

const REFRESH_LOCK_PREFIX = "openshapeforge:refresh-lock:";
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
