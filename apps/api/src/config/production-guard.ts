/**
 * Fail-closed production environment validator.
 *
 * The dev defaults that make local work frictionless — an unset bearer
 * audience, the well-known trusted-context secret — are catastrophic in
 * production: they let any same-issuer token in, or let anyone who knows the
 * public dev secret forge a trusted-context header. `assertProductionEnv`
 * refuses to let the process serve traffic in production until those are
 * closed. In dev/test it is a no-op.
 *
 * Called from startApiRole (src/roles/api.ts) BEFORE the server starts
 * listening, alongside the generated-schema drift check.
 */

/** The public dev default for the trusted-context HMAC secret. Never valid in prod. */
export const DEV_CONTEXT_SECRET_DEFAULT = "openshapeforge-local-dev-context-secret";

/**
 * Throws a clear, multi-line error when NODE_ENV === 'production' and the auth
 * configuration is unsafe. Returns cleanly in every other environment.
 *
 * Fails if ANY of:
 *   (a) bearer verification is intended (JWKS_URI or ISSUER set) but AUDIENCE
 *       is unset — an unpinned audience accepts sibling-client tokens;
 *   (b) the trusted-context secret is unset OR still equals the dev default —
 *       a forgeable trusted-context path;
 *   (c) no auth method is fully configured — neither a COMPLETE bearer verifier
 *       (jwks + issuer + audience) nor a non-default context secret — which
 *       would leave the service with no trustworthy way to authenticate.
 */
export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") {
    return;
  }

  const jwksUri = env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  const issuer = env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  const audience = env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE;
  const contextSecret = env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;

  const bearerIntended = Boolean(jwksUri || issuer);
  const bearerComplete = Boolean(jwksUri && issuer && audience);
  const contextSecretConfigured =
    Boolean(contextSecret) && contextSecret !== DEV_CONTEXT_SECRET_DEFAULT;

  const problems: string[] = [];

  // (a) Bearer intended but audience unpinned.
  if (bearerIntended && !audience) {
    problems.push(
      "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE is unset while bearer verification " +
        "is configured (JWKS_URI/ISSUER present). Without an audience, any " +
        "same-issuer token — including sibling-client tokens — is accepted. " +
        "Pin it to the expected `aud` value.",
    );
  }

  // (b) Trusted-context secret unset or still the dev default.
  if (!contextSecret) {
    problems.push(
      "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is unset. Trusted-context headers " +
        "cannot be verified; set a strong, randomized secret.",
    );
  } else if (contextSecret === DEV_CONTEXT_SECRET_DEFAULT) {
    problems.push(
      "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET is still the public dev default " +
        `('${DEV_CONTEXT_SECRET_DEFAULT}'). Anyone can forge trusted-context ` +
        "headers. Set a strong, randomized secret.",
    );
  }

  // (c) No complete auth method at all.
  if (!bearerComplete && !contextSecretConfigured) {
    problems.push(
      "No complete authentication method is configured: neither a full bearer " +
        "verifier (JWKS_URI + ISSUER + AUDIENCE) nor a non-default " +
        "OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET. The service has no trustworthy " +
        "way to authenticate requests.",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "Refusing to start in production: unsafe auth configuration.",
        "",
        ...problems.map((p) => `  - ${p}`),
        "",
        "Fix the environment and restart. These checks are enforced only when " +
          "NODE_ENV=production.",
      ].join("\n"),
    );
  }
}
