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
