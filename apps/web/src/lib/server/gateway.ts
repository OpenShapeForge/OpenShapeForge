// SPDX-License-Identifier: BUSL-1.1
import "server-only";

// Default: direct `apps/api` dev server (`bun run dev:api`, PORT default 3001).
// Use 127.0.0.1 (not "localhost") so Node fetch does not prefer ::1 while the API
// process is often bound IPv4-only — avoids intermittent ECONNREFUSED on macOS.
// Set OPENSHAPEFORGE_GATEWAY_URL to your APISIX base when routing via gateway.
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3001";
const DEFAULT_GRAPHQL_GATEWAY_PATH = "/api/graphql";

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function normalizeGatewayPath(raw: string): string {
  if (!raw.trim()) {
    return DEFAULT_GRAPHQL_GATEWAY_PATH;
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function getGatewayBaseUrl(): string {
  const raw =
    process.env.OPENSHAPEFORGE_GATEWAY_URL ??
    process.env.GATEWAY_URL ??
    DEFAULT_GATEWAY_URL;

  return normalizeBaseUrl(raw);
}

export function buildGatewayUrl(path: string): URL {
  return new URL(path.replace(/^\//, ""), getGatewayBaseUrl());
}

export function getGatewayGraphqlPath(): string {
  const raw =
    process.env.OPENSHAPEFORGE_GRAPHQL_GATEWAY_PATH ??
    process.env.GRAPHQL_GATEWAY_PATH ??
    DEFAULT_GRAPHQL_GATEWAY_PATH;

  return normalizeGatewayPath(raw);
}

export function buildGatewayGraphqlUrl(): URL {
  return buildGatewayUrl(getGatewayGraphqlPath());
}
