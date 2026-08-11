// SPDX-License-Identifier: BUSL-1.1
import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

function isLegacySignOut(request: NextRequest): boolean {
  return request.nextUrl.pathname.split("/").filter(Boolean).at(-1) === "signout";
}

function useLogoutRoute(): Response {
  return Response.json(
    { error: "Use the application logout endpoint." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: NextRequest): Promise<Response> | Response {
  return isLegacySignOut(request) ? useLogoutRoute() : handlers.GET(request);
}

export function POST(request: NextRequest): Promise<Response> | Response {
  return isLegacySignOut(request) ? useLogoutRoute() : handlers.POST(request);
}
