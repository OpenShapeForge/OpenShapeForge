// SPDX-License-Identifier: BUSL-1.1
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  isKnowledgeApiPath,
  isKnownKnowledgeApiDocsPath,
  isKnownPublicPath,
} from "@/lib/public-routes";

// proxy.ts runs in the Node.js runtime, so process.env.NODE_ENV here is the
// *runtime* value (set via Helm env on the Deployment). The Dockerfile bakes
// "production" into the build, which is what client bundles see at compile
// time — so this cookie is how we surface the runtime env to the client-only
// error boundaries below (error.tsx / global-error.tsx).
const ENV_COOKIE = "__openshapeforge_env";
const RUNTIME_ENV = process.env.NODE_ENV ?? "production";

function tagEnv(res: NextResponse): NextResponse {
  res.cookies.set(ENV_COOKIE, RUNTIME_ENV, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
  });
  return res;
}

/**
 * Web Client Proxy (Next.js 16 — replaces middleware.ts)
 *
 * 1. Route protection: redirects unauthenticated users to /login.
 * 2. Session error recovery: redirects to /login when token refresh fails.
 * 3. Header injection: injects tenant context and pathname headers into every
 *    request so Server Components and Server Actions can read them.
 * 4. Tags every response with a __openshapeforge_env cookie reflecting runtime
 *    NODE_ENV so client error UIs can show stack details on dev.
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-app-pathname", pathname);

  const legacyGeneratedRouteRedirects: Record<string, string> = {
    "/process-templates": "/case-templates",
    "/process-template-steps": "/case-step-templates",
  };
  for (const [legacyPrefix, targetPrefix] of Object.entries(legacyGeneratedRouteRedirects)) {
    if (pathname === legacyPrefix || pathname.startsWith(`${legacyPrefix}/`)) {
      const redirectUrl = req.nextUrl.clone();
      redirectUrl.pathname = `${targetPrefix}${pathname.slice(legacyPrefix.length)}`;
      return tagEnv(NextResponse.redirect(redirectUrl));
    }
  }

  const isKnowledgeGraphqlPlayground =
    pathname === "/knowledge/api/graphql/playground";
  const isKnowledgeGraphqlEndpoint = pathname === "/knowledge/api/graphql";
  if (
    isKnowledgeApiPath(pathname) &&
    !isKnownKnowledgeApiDocsPath(pathname) &&
    !isKnowledgeGraphqlPlayground &&
    !isKnowledgeGraphqlEndpoint
  ) {
    return tagEnv(
      NextResponse.json(
        { error: { message: "Knowledge API documentation artifact not found." } },
        { status: 404 },
      ),
    );
  }

  // Paths that must remain accessible without a session.
  const isPublicPath = isKnownPublicPath(pathname);
  const session = isPublicPath ? null : await auth();

  // No session → redirect to login (preserve the intended URL as callbackUrl).
  if (!session && !isPublicPath) {
    const loginUrl = new URL("/login", req.url);
    // Validate callbackPath is a safe relative path — prevent open redirects
    // via crafted pathnames like "//evil.com" or "https://evil.com".
    const isSafeRelativePath =
      pathname.startsWith("/") &&
      !pathname.startsWith("//") &&
      !pathname.includes("://");
    const callbackUrl =
      isSafeRelativePath ? `${pathname}${search}` : "/";
    loginUrl.searchParams.set(
      "callbackUrl",
      callbackUrl,
    );
    return tagEnv(NextResponse.redirect(loginUrl));
  }

  // Token refresh failed → redirect to login with session_expired reason.
  if (session?.error === "RefreshTokenError" && !isPublicPath) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("reason", "session_expired");
    return tagEnv(NextResponse.redirect(loginUrl));
  }

  // Authenticated — inject tenant context headers so Server Components and
  // Server Actions can access them.
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  if (session) {
    const { tenantId, roles, sub } = session;
    if (tenantId) response.headers.set("x-tenant-id", tenantId);
    if (sub) response.headers.set("x-user-id", sub);
    if (Array.isArray(roles) && roles.length > 0) {
      response.headers.set("x-user-roles", roles.join(","));
    }
  }

  return tagEnv(response);
}

export const config = {
  matcher: [
    // Run on all paths except Next.js internals, static file extensions,
    // and the NextAuth API routes (which handle their own auth flow).
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|css)$).*)",
  ],
};
