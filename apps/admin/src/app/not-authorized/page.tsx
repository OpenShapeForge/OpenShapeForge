// SPDX-License-Identifier: BUSL-1.1
import { PLATFORM_OPERATOR_ROLE } from "@/lib/auth";
import { getCachedSession } from "@/lib/cached-session";

/**
 * The refusal page: authenticated against the control realm, but not a platform
 * operator.
 *
 * This exists so the answer to "authenticated but unauthorized" is a REFUSAL
 * and not an empty console. An admin app that renders its chrome, its nav and
 * an empty tenant list to someone who holds no role has told them the console
 * exists, told them its shape, and left them to conclude the list is genuinely
 * empty. Say no instead.
 *
 * It shows the account it is refusing, because the most common cause is being
 * signed in as the wrong one, and it does NOT show a "request access" path —
 * the control realm authors `registrationAllowed: false` and
 * `resetPasswordAllowed: false` precisely so an unauthenticated or
 * under-privileged visitor has no self-service lever here at all.
 */
export default async function NotAuthorizedPage() {
  const session = await getCachedSession();
  const account =
    session?.user?.preferredUsername ?? session?.user?.email ?? session?.sub ?? null;

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <div
        className="w-full max-w-md rounded-[var(--radius-large)] p-8 outline outline-1 outline-[var(--color-border-muted)]"
        style={{ backgroundColor: "var(--color-card)" }}
        data-testid="not-authorized"
      >
        <div className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-[var(--color-foreground-muted)]">
            OpenShapeForge
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Access denied</h1>
          <p className="text-sm text-[var(--color-foreground-muted)]">
            This account is not a platform operator, so it cannot use the control
            plane.
          </p>
        </div>

        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-foreground-muted)]">Signed in as</dt>
            <dd className="font-medium">{account ?? "unknown"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-foreground-muted)]">Required role</dt>
            <dd className="font-mono">{PLATFORM_OPERATOR_ROLE}</dd>
          </div>
        </dl>

        <p className="mt-6 text-sm text-[var(--color-foreground-muted)]">
          Ask a platform administrator to grant the role, then sign in again.
        </p>
      </div>
    </main>
  );
}
