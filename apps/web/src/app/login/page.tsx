// SPDX-License-Identifier: BUSL-1.1
import { signInWithKeycloak } from "./actions";
import { Card, CardContent } from "@/components/ui/display/card";
import { getCachedSession } from "@/lib/cached-session";
import { probeKeycloak } from "@/lib/server/health-probes";
import { redirect } from "next/navigation";

interface LoginPageProps {
  searchParams: Promise<{
    callbackUrl?: string | string[];
    reason?: string | string[];
    error?: string | string[];
  }>;
}

const REASON_MESSAGES: Record<string, { en: string; nl: string }> = {
  session_expired: {
    en: "Your session expired. Sign in again to continue.",
    nl: "Je sessie is verlopen. Log opnieuw in om verder te gaan.",
  },
};

const ERROR_MESSAGES: Record<string, { title: string; detail: string }> = {
  AccessDenied: {
    title: "Toegang geweigerd",
    detail: "Je account heeft geen toegang tot deze applicatie of omgeving.",
  },
  CallbackRouteError: {
    title: "Inloggen kon niet worden afgerond",
    detail:
      "De login-callback is mislukt. Verwijder voor localhost de auth-cookies of probeer een privévenster.",
  },
  Configuration: {
    title: "Authenticatieconfiguratie ongeldig",
    detail: "De lokale auth-configuratie lijkt onvolledig of ongeldig.",
  },
  OAuthCallbackError: {
    title: "Inloggen kon niet worden afgerond",
    detail:
      "De OAuth-callback vanaf Keycloak is mislukt. Verwijder voor localhost de auth-cookies of probeer een privévenster.",
  },
  OAuthSignin: {
    title: "Doorsturen naar Keycloak mislukt",
    detail: "De applicatie kon de aanmeldflow niet starten.",
  },
  Verification: {
    title: "Verificatie mislukt",
    detail: "De authenticatie kon niet worden bevestigd. Probeer het opnieuw.",
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
  if (session && session.error !== "RefreshTokenError") {
    redirect("/");
  }

  const { callbackUrl, reason, error } = await searchParams;
  const errorCode = getFirstQueryValue(error);
  const safeCallbackUrl = getSafeCallbackUrl(callbackUrl);
  const reasonCode = getFirstQueryValue(reason);
  const message = reasonCode ? REASON_MESSAGES[reasonCode] : undefined;
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? {
        title: "Inloggen is mislukt",
        detail: `De authenticatieflow gaf foutcode "${errorCode}" terug.`,
      })
    : undefined;

  // Pre-flight: if Keycloak is unreachable, the sign-in click would otherwise
  // bounce the browser into ERR_CONNECTION_REFUSED. Probe the OIDC discovery
  // URL server-side and replace the button with a clear unavailable panel.
  const keycloakProbe = await probeKeycloak();
  const authUnavailable = !keycloakProbe.ok;

  return (
    <main className="fixed inset-0 z-50 flex min-h-screen items-center justify-center overflow-y-auto bg-gradient-to-br from-background via-muted/30 to-background px-6 py-10">
      <Card className="w-full max-w-md rounded-3xl bg-card/95 p-8 shadow-lg backdrop-blur">
        <CardContent className="space-y-0">
          <div className="space-y-3 text-center">
            <p className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
              OpenShapeForge
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground">
              Use your Keycloak account to access the ERP workspace.
            </p>
          </div>

          {message ? (
            <div className="mt-6 rounded-2xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              {message.nl}
            </div>
          ) : null}

          {errorMessage ? (
            <div className="mt-6 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <p className="font-medium">{errorMessage.title}</p>
              <p className="mt-1 text-destructive/90">{errorMessage.detail}</p>
            </div>
          ) : null}

          <div className="mt-8">
            {authUnavailable ? (
              <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <p className="font-medium">Authenticatie tijdelijk niet beschikbaar</p>
                <p className="mt-1 text-destructive/90">
                  De Keycloak-server reageert niet
                  {keycloakProbe.error ? ` (${keycloakProbe.error})` : ""}. Inloggen
                  is op dit moment niet mogelijk.
                </p>
                <p className="mt-3">
                  <a
                    href="/login"
                    className="underline underline-offset-4 hover:text-destructive/80"
                  >
                    Opnieuw proberen
                  </a>
                </p>
              </div>
            ) : (
              <form action={signInWithKeycloak}>
                <input type="hidden" name="callbackUrl" value={safeCallbackUrl} />
                <button
                  type="submit"
                  className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-action-primary px-4 py-2 text-base font-medium text-action-primary-foreground outline-none transition-all hover:bg-action-primary-hover focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-action-primary/20 disabled:pointer-events-none disabled:opacity-50"
                >
                  Sign in with Keycloak
                </button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
