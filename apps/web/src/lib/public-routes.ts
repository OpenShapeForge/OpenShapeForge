// SPDX-License-Identifier: BUSL-1.1
const PUBLIC_PATH_PREFIXES = ["/login", "/form-render"] as const;
const PUBLIC_PATH_EXACT = new Set(["/api/health"]);
const KNOWLEDGE_API_DOC_PATHS = new Set([
  "/knowledge/api",
  "/knowledge/api/index.json",
  "/knowledge/api/vera/openapi.json",
  "/knowledge/api/vera/swagger",
  "/knowledge/api/vera/adapter-contract.json",
  "/knowledge/api/graphql/schema.graphql",
  "/knowledge/api/graphql/schema.json",
]);

export function isKnowledgeApiPath(pathname: string | null | undefined): boolean {
  return Boolean(
    pathname &&
      (pathname === "/knowledge/api" || pathname.startsWith("/knowledge/api/")),
  );
}

export function isKnownKnowledgeApiDocsPath(
  pathname: string | null | undefined,
): boolean {
  return Boolean(pathname && KNOWLEDGE_API_DOC_PATHS.has(pathname));
}

export function isKnownPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) {
    return false;
  }

  if (PUBLIC_PATH_EXACT.has(pathname)) {
    return true;
  }

  if (pathname.startsWith("/api/auth")) {
    return true;
  }

  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
