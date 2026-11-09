// SPDX-License-Identifier: BUSL-1.1
import type { Session } from "next-auth";

type Continuation =
  | { state: "ready"; session: Session }
  | { state: "expired" }
  | { state: "unavailable"; session?: Session };

/** A transport failure or rate limit must not trigger the logout endpoint. */
export async function readSessionContinuation(fetchSession: () => Promise<Response>): Promise<Continuation> {
  try {
    const response = await fetchSession();
    if (!response.ok) return { state: response.status === 401 || response.status === 403 ? "expired" : "unavailable" };
    const session = await response.json() as Session | null;
    if (session?.error === "RefreshTokenUnavailable") return { state: "unavailable", session };
    if (!session?.accessToken || session.error === "RefreshTokenError") return { state: "expired" };
    return { state: "ready", session };
  } catch {
    return { state: "unavailable" };
  }
}

/** Respect server pacing while bounding repeated recovery traffic during an outage. */
export function sessionContinuationRetryAt(now: number, attempt: number, serverRetryAt?: number): number {
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, attempt)));
  return Math.max(now + delay, Number.isFinite(serverRetryAt) ? serverRetryAt! : 0);
}
