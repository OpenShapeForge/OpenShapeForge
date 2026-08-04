// SPDX-License-Identifier: BUSL-1.1
import { redirect } from "next/navigation";
import { getCachedSession } from "@/lib/cached-session";
import { probeKeycloak } from "@/lib/server/health-probes";
import { signInWithKeycloak } from "./actions";

interface LoginPageProps {
  searchParams: Promise<{
    callbackUrl?: string | string[];
    reason?: string | string[];
    error?: string | string[];
  }>;
}

const REASON_MESSAGES: Record<string, string> = {
  session_expired: "Your session expired. Sign in again to continue.",
};

/**
 * The `AccessDenied` entry is the one that carries weight here.
 *
 * NextAuth maps a `false` from the `signIn` callback onto `?error=AccessDenied`,
 * and that callback returns false for exactly one reason: the account
 * authenticated against the control realm but does not hold `platform-operator`
 * (the control realm's `platform-noaccess` user is there to exercise it). So
 * this message must say what is actually wrong — the credentials were fine and
 * the role is missing — rather than the generic "login failed" that would send
 * an operator hunting for a typo in a password that worked.
 */
const ERROR_MESSAGES: Record<string, { title: string; detail: string }> = {
  AccessDenied: {
    title: "Not a platform operator",
    detail:
      "You signed in successfully, but this account does not hold the platform-operator role. The control plane is restricted to platform operators.",
  },
  CallbackRouteError: {
    title: "Sign-in could not be completed",
    detail:
      "The login callback failed. On localhost, clear this app's auth cookies or try a private window.",
  },
  Configuration: {
    title: "Authentication configuration is invalid",
    detail:
      "The control-realm auth configuration looks incomplete. Check AUTH_KEYCLOAK_ISSUER, AUTH_KEYCLOAK_ID and AUTH_KEYCLOAK_SECRET against authorization.control.yaml.",
  },
  OAuthCallbackError: {
    title: "Sign-in could not be completed",
    detail:
      "The OAuth callback from Keycloak failed. On localhost, clear this app's auth cookies or try a private window.",
  },
  OAuthSignin: {
    title: "Could not redirect to Keycloak",
    detail: "The application could not start the sign-in flow.",
  },
  Verification: {
    title: "Verification failed",
    detail: "The authentication could not be confirmed. Try again.",
  },
};

function getFirstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return undefined;
}

function getSafeCallbackUrl(value: string | string[] | undefined): string {
  const resolved = getFirstQueryValue(value);

  if (
    resolved &&
    resolved.startsWith("/") &&
    !resolved.startsWith("//") &&
    !resolved.includes("://")
  ) {
    return resolved;
  }

  return "/";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await getCachedSession();
  // Only a session that is ALSO authorized may skip the login page. Sending an
  // authenticated non-operator to "/" would just bounce them to
  // /not-authorized, and bouncing off the login page is how redirect loops
  // start.
  if (session && session.error !== "RefreshTokenError" && session.isPlatformOperator) {
    redirect("/");
  }

  const { callbackUrl, reason, error } = await searchParams;
  const errorCode = getFirstQueryValue(error);
  const safeCallbackUrl = getSafeCallbackUrl(callbackUrl);
  const reasonCode = getFirstQueryValue(reason);
  const message = reasonCode ? REASON_MESSAGES[reasonCode] : undefined;
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? {
        title: "Sign-in failed",
        detail: `The authentication flow returned error code "${errorCode}".`,
      })
    : undefined;

  // Pre-flight: if Keycloak is unreachable, the sign-in click would otherwise
  // bounce the browser into ERR_CONNECTION_REFUSED. Probe the OIDC discovery
  // URL server-side and replace the button with a clear unavailable panel.
  const keycloakProbe = await probeKeycloak();
  const authUnavailable = !keycloakProbe.ok;

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <div
        className="w-full max-w-md rounded-[var(--radius-large)] p-8 outline outline-1 outline-[var(--color-border-muted)]"
        style={{ backgroundColor: "var(--color-card)" }}
      >
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-[var(--color-foreground-muted)]">
            OpenShapeForge
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Control plane</h1>
          <p className="text-sm text-[var(--color-foreground-muted)]">
            Sign in with your platform operator account.
          </p>
        </div>

        {message ? (
          <div className="mt-6 rounded-[var(--radius-medium)] border border-[var(--color-functional-orange-20)] bg-[var(--color-functional-orange-5)] px-4 py-3 text-sm">
            {message}
          </div>
        ) : null}

        {errorMessage ? (
          <div
            className="mt-6 rounded-[var(--radius-medium)] border border-[var(--color-functional-red-20)] bg-[var(--color-functional-red-5)] px-4 py-3 text-sm"
            data-testid="login-error"
          >
            <p className="font-medium">{errorMessage.title}</p>
            <p className="mt-1">{errorMessage.detail}</p>
          </div>
        ) : null}

        <div className="mt-8">
          {authUnavailable ? (
            <div className="rounded-[var(--radius-medium)] border border-[var(--color-functional-red-20)] bg-[var(--color-functional-red-5)] px-4 py-3 text-sm">
              <p className="font-medium">Authentication temporarily unavailable</p>
              <p className="mt-1">
                The control realm is not responding
                {keycloakProbe.error ? ` (${keycloakProbe.error})` : ""}. Signing in
                is not possible right now.
              </p>
              <p className="mt-3">
                <a href="/login" className="underline underline-offset-4">
                  Try again
                </a>
              </p>
            </div>
          ) : (
            <form action={signInWithKeycloak}>
              <input type="hidden" name="callbackUrl" value={safeCallbackUrl} />
              <button
                type="submit"
                className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-small)] bg-[var(--color-brand-indigo-100)] px-4 py-2 text-base font-medium text-[var(--color-white)] outline-none transition-colors hover:bg-[var(--color-brand-indigo-120)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-brand-indigo-80)_35%,transparent)]"
              >
                Sign in with Keycloak
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
