// SPDX-License-Identifier: BUSL-1.1
export const GRAPHQL_CACHE_VERSION_COOKIE = "openshapeforge.graphql-cache-version";

export function bumpGraphqlCacheVersionCookie() {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${GRAPHQL_CACHE_VERSION_COOKIE}=${Date.now()}; Path=/; SameSite=Lax`;
}
