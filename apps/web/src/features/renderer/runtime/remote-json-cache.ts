// SPDX-License-Identifier: BUSL-1.1
"use client";

type RemoteJsonCacheEntry = {
  expiresAt: number;
  promise?: Promise<unknown>;
  value?: unknown;
};

const REMOTE_JSON_CACHE_TTL_MS = 30_000;
const remoteJsonCache = new Map<string, RemoteJsonCacheEntry>();

export function clearRemoteJsonCacheForTests(): void {
  if (process.env.NODE_ENV === "test") {
    remoteJsonCache.clear();
  }
}

export async function loadRemoteJson<T>(url: string): Promise<T> {
  const now = Date.now();
  const existing = remoteJsonCache.get(url);

  if (existing?.value !== undefined && existing.expiresAt > now) {
    return existing.value as T;
  }

  if (existing?.promise) {
    return existing.promise as Promise<T>;
  }

  const promise = fetch(url, { cache: "no-store" }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  });

  remoteJsonCache.set(url, {
    expiresAt: now + REMOTE_JSON_CACHE_TTL_MS,
    promise,
  });

  try {
    const value = await promise;
    remoteJsonCache.set(url, {
      expiresAt: Date.now() + REMOTE_JSON_CACHE_TTL_MS,
      value,
    });
    return value;
  } catch (error) {
    remoteJsonCache.delete(url);
    throw error;
  }
}
