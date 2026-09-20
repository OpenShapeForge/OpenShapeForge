// SPDX-License-Identifier: BUSL-1.1
/**
 * Server-side session store on Redis.
 *
 * The encrypted session cookie holds only an opaque session id; everything
 * else lives in the record stored here. Each app constructs its own store with
 * its own key prefix, so a control-plane session and a tenant-app session can
 * never collide on a key and flushing one app's sessions cannot take out the
 * other's. The client options, cluster/TLS handling and read-through cache are
 * the same for every app on purpose: they all run against the same Redis, and
 * a divergence in timeouts or cluster handling would only ever be discovered
 * as an operational surprise in whichever app got it wrong.
 */
import { Cluster, Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import {
  DEV_REDIS_URL,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_MAX_RETRY_ATTEMPTS,
  redisRetryStrategy,
} from "./redis-config.js";

// Single-node Redis for local dev, sharded Redis Cluster when managed
// (cluster_size > 1). Both expose the same Commander surface for the commands
// this module uses (set/get/del/eval), so the same call sites work for either.
type RedisClient = Redis | Cluster;

/** What every app stores; an app extends it with its own fields. */
export interface StoredSessionBase {
  sub?: string | undefined;
  name?: string | undefined;
  givenName?: string | undefined;
  familyName?: string | undefined;
  preferredUsername?: string | undefined;
  email?: string | undefined;
  accessToken?: string | undefined;
  idToken?: string | undefined;
  refreshToken?: string | undefined;
  /** Realm roles plus every client role, flattened. */
  roles?: string[] | undefined;
  expiresAt?: number | undefined;
  refreshExpiresAt?: number | undefined;
  error?: string | undefined;
}

export type StoredSession<Extra extends object = {}> = StoredSessionBase & Extra;

export type SessionStore<Extra extends object = {}> = {
  getSession(sessionId: string): Promise<StoredSession<Extra> | null>;
  setSession(sessionId: string, data: StoredSession<Extra>): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  acquireRefreshLock(sessionId: string): Promise<string | null>;
  releaseRefreshLock(sessionId: string, ownerToken: string): Promise<void>;
  resetForTests(): void;
};

export type SessionStoreOptions = {
  /** Namespaces every key: `<keyPrefix>:session:` and `<keyPrefix>:refresh-lock:`. */
  keyPrefix: string;
  /** Log tag: `auth` prefixes lines with `[auth]` and `[auth:redis]`. */
  logTag: string;
};

const SESSION_CACHE_TTL_MS = 1_000;
/** Default TTL when refreshExpiresAt is unknown (30 minutes). */
const DEFAULT_SESSION_TTL_S = 1800;
export const REFRESH_LOCK_TTL_MS = 10_000;

function shouldRetryRedisOperation(error: unknown): boolean {
  return error instanceof Error && /connection is closed/i.test(error.message);
}

function connect(logTag: string): RedisClient {
  const url = process.env.REDIS_URL ?? DEV_REDIS_URL;
  // A managed Redis presents a cert signed by the provider's own CA on its
  // private-network endpoint; REDIS_CA_CERT carries that PEM so ioredis can
  // validate the server with strict rejectUnauthorized. Plain redis:// (local
  // dev) skips the tls block entirely.
  const parsed = new URL(url);
  const useTls = parsed.protocol === "rediss:";
  const ca = process.env.REDIS_CA_CERT;
  // A managed Redis is often a sharded cluster (cluster_size > 1), and
  // single-node ioredis throws MOVED on the first cross-shard command. The
  // deployed environment sets REDIS_CLUSTER_MODE=true; local dev's single-node
  // Redis leaves it unset.
  const useCluster = process.env.REDIS_CLUSTER_MODE === "true";
  let client: RedisClient;
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
    console.error(`[${logTag}:redis] Connection error:`, err.message);
  });
  return client;
}

export function createSessionStore<Extra extends object = {}>(
  options: SessionStoreOptions,
): SessionStore<Extra> {
  const sessionPrefix = `${options.keyPrefix}:session:`;
  const refreshLockPrefix = `${options.keyPrefix}:refresh-lock:`;

  // Lazy singleton — the connection is created on first use.
  let client: RedisClient | null = null;
  const sessionCache = new Map<
    string,
    { value: StoredSession<Extra> | null; expiresAt: number }
  >();

  function getRedis(): RedisClient {
    client ??= connect(options.logTag);
    return client;
  }

  function resetRedisClient(): void {
    const current = client as (RedisClient & { disconnect?: () => void }) | null;
    client = null;
    current?.disconnect?.();
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

  function readSessionCache(sessionId: string): StoredSession<Extra> | null | undefined {
    const cached = sessionCache.get(sessionId);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      sessionCache.delete(sessionId);
      return undefined;
    }
    return cached.value;
  }

  function writeSessionCache(sessionId: string, value: StoredSession<Extra> | null): void {
    sessionCache.set(sessionId, { value, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  }

  return {
    /**
     * TTL is derived from refreshExpiresAt, with a minimum of 60s and a
     * fallback of DEFAULT_SESSION_TTL_S when refreshExpiresAt is unknown.
     */
    async setSession(sessionId, data) {
      const key = `${sessionPrefix}${sessionId}`;
      const nowS = Math.floor(Date.now() / 1000);
      const ttl = data.refreshExpiresAt
        ? Math.max(data.refreshExpiresAt - nowS, 60)
        : DEFAULT_SESSION_TTL_S;
      await withRedis((redis) => redis.set(key, JSON.stringify(data), "EX", ttl));
      writeSessionCache(sessionId, data);
    },

    /** Null when missing or expired. */
    async getSession(sessionId) {
      const cached = readSessionCache(sessionId);
      if (cached !== undefined) return cached;

      const key = `${sessionPrefix}${sessionId}`;
      const raw = await withRedis((redis) => redis.get(key));
      if (!raw) {
        writeSessionCache(sessionId, null);
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as StoredSession<Extra>;
        writeSessionCache(sessionId, parsed);
        return parsed;
      } catch {
        sessionCache.delete(sessionId);
        return null;
      }
    },

    /** Immediate removal, used on logout. */
    async deleteSession(sessionId) {
      const key = `${sessionPrefix}${sessionId}`;
      await withRedis((redis) => redis.del(key));
      sessionCache.delete(sessionId);
    },

    /**
     * An owner token when the lock was acquired, null when another process
     * holds it. Holding the lock means the next read must see what the
     * previous holder wrote, so the local cache entry is dropped with it.
     */
    async acquireRefreshLock(sessionId) {
      const key = `${refreshLockPrefix}${sessionId}`;
      const ownerToken = randomUUID();
      const result = await withRedis((redis) =>
        redis.set(key, ownerToken, "PX", REFRESH_LOCK_TTL_MS, "NX"),
      );
      if (result !== "OK") return null;
      sessionCache.delete(sessionId);
      return ownerToken;
    },

    async releaseRefreshLock(sessionId, ownerToken) {
      const key = `${refreshLockPrefix}${sessionId}`;
      await withRedis((redis) =>
        redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          ownerToken,
        ),
      );
    },

    resetForTests() {
      resetRedisClient();
      sessionCache.clear();
    },
  };
}
