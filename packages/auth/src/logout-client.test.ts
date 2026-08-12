// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  requestLogout,
  type LogoutClientDependencies,
} from "./logout-client.js";

const APP_ORIGIN = "https://app.example.test";

function dependencies(
  responses: Response[],
  calls: Array<{ input: string; init?: RequestInit }>,
  waits: number[],
  redirects: string[],
): LogoutClientDependencies {
  return {
    fetch: async (input, init) => {
      calls.push({ input: String(input), ...(init ? { init } : {}) });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch");
      return response;
    },
    getLocation: () => ({
      origin: APP_ORIGIN,
      assign: (url) => redirects.push(url),
    }),
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
  };
}

function csrfResponse(token: string): Response {
  return Response.json({ csrfToken: token });
}

function logoutResponse(reason?: "session_expired"): Response {
  const url = new URL("/login", APP_ORIGIN);
  if (reason) url.searchParams.set("reason", reason);
  return Response.json({ url: url.href });
}

describe("browser logout retry", () => {
  test("automatic logout retries one temporary 503 with a fresh CSRF token", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const waits: number[] = [];
    const redirects: string[] = [];
    const deps = dependencies([
      csrfResponse("first-csrf"),
      new Response(null, { status: 503 }),
      csrfResponse("second-csrf"),
      logoutResponse("session_expired"),
    ], calls, waits, redirects);

    const result = await requestLogout(
      "session_expired",
      { retryOnceOnServiceUnavailable: true, retryDelayMs: 25 },
      deps,
    );

    expect(result).toBe(true);
    expect(calls.map(({ input }) => input)).toEqual([
      "/api/auth/csrf",
      "/api/logout",
      "/api/auth/csrf",
      "/api/logout",
    ]);
    expect(waits).toEqual([25]);
    const firstBody = calls[1]?.init?.body as URLSearchParams;
    const secondBody = calls[3]?.init?.body as URLSearchParams;
    expect(firstBody.get("csrfToken")).toBe("first-csrf");
    expect(secondBody.get("csrfToken")).toBe("second-csrf");
    expect(redirects).toEqual([
      `${APP_ORIGIN}/login?reason=session_expired`,
    ]);
  });

  test("automatic logout stops after one retry", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const waits: number[] = [];
    const redirects: string[] = [];
    const deps = dependencies([
      csrfResponse("first-csrf"),
      new Response(null, { status: 503 }),
      csrfResponse("second-csrf"),
      new Response(null, { status: 503 }),
    ], calls, waits, redirects);

    const result = await requestLogout(
      "session_expired",
      { retryOnceOnServiceUnavailable: true },
      deps,
    );

    expect(result).toBe(false);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([1_000]);
    expect(redirects).toEqual([]);
  });

  test("does not retry a non-transient rejection", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const waits: number[] = [];
    const redirects: string[] = [];
    const deps = dependencies([
      csrfResponse("test-csrf"),
      new Response(null, { status: 403 }),
    ], calls, waits, redirects);

    const result = await requestLogout(
      "session_expired",
      { retryOnceOnServiceUnavailable: true },
      deps,
    );

    expect(result).toBe(false);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([]);
    expect(redirects).toEqual([]);
  });
});
