// SPDX-License-Identifier: BUSL-1.1
/**
 * The OAuth authorize round trip.
 *
 * Two routes with very different threat models, which is why they are together
 * in one file — reading either without the other invites getting the second one
 * wrong.
 *
 *   POST .../installations/:instanceKey/authorize   authenticated, ConnectorAdmin
 *   GET  .../oauth/callback                          UNAUTHENTICATED, by necessity
 *
 * The callback cannot be authenticated. It is a cross-site navigation the
 * provider sends the user's browser on, so none of our cookies or headers are
 * attached and there is no session to check. Everything that makes it safe is in
 * `oauth-state.ts`: the state is unguessable, single-use, expiring, stored as a
 * hash, and carries the tenant it belongs to.
 *
 * The callback also never trusts anything else in its own query string. The
 * connector, the installation and the redirect URI all come from the claimed
 * row, never from parameters — a callback that read its target from the URL
 * would let anyone holding one tenant's state write tokens into another
 * tenant's installation.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import { REST_MOUNT_PATH } from "../rest/rest-paths.js";
import { ConnectorAuthorizationError, requireConnectorAdmin } from "./authorization.js";
import { findConnectorContract } from "./catalog.js";
import { createBoundFetch } from "./executor.js";
import {
  ConnectorOAuthError,
  exchangeAuthorizationCode,
  resolveEndpoint,
  writeOAuthTokens,
} from "./oauth.js";
import { consumeAuthorizationState, createAuthorizationState } from "./oauth-state.js";
import { listInstallations } from "./store.js";
import type { ConnectorRuntimeConfig } from "./service.js";

const CONNECTOR_MOUNT = `${REST_MOUNT_PATH}/connectors`;
export const OAUTH_CALLBACK_PATH = `${CONNECTOR_MOUNT}/oauth/callback`;

export type ConnectorOAuthRouteOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  config: ConnectorRuntimeConfig;
  /**
   * Public origin this API is reached at, e.g. `https://app.example.com`.
   *
   * The redirect URI must match what was registered with the provider
   * character for character, so it is configured rather than derived from the
   * request: deriving it from Host would let a caller with a forged header aim
   * the provider's redirect wherever it liked.
   */
  publicOrigin?: string | undefined;
  /** Where the browser lands after the callback finishes. */
  appOrigin?: string | undefined;
  now?: () => number;
};

function callbackUri(options: ConnectorOAuthRouteOptions): string {
  if (!options.publicOrigin) {
    throw new ConnectorOAuthError(
      "CONNECTOR_OAUTH_FAILED",
      "OPENSHAPEFORGE_PUBLIC_ORIGIN is not configured, so no OAuth redirect URI can be built.",
    );
  }
  return `${options.publicOrigin.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Where the browser is sent once the callback is done.
 *
 * Always our own configured origin with a fixed path — never anything derived
 * from the request or the state. An open redirect on the one endpoint a
 * stranger can reach is exactly the shape phishing wants.
 */
function landingUrl(
  options: ConnectorOAuthRouteOptions,
  slug: string | undefined,
  outcome: "connected" | "failed",
): string {
  const base = (options.appOrigin ?? options.publicOrigin ?? "").replace(/\/+$/, "");
  const path = slug ? `/integrations/${encodeURIComponent(slug)}` : "/integrations";
  return `${base}${path}?oauth=${outcome}`;
}

export function registerConnectorOAuthRoutes(
  app: FastifyInstance,
  options: ConnectorOAuthRouteOptions,
): void {
  const now = options.now ?? (() => Date.now());

  /**
   * Start a flow: mint a state, and answer with the provider URL to visit.
   *
   * The URL is RETURNED rather than redirected to, so the caller is a normal
   * authenticated API client and the browser navigation is the front end's
   * decision. A 302 here would make the authenticated half of the flow a
   * cross-site navigation too, and lose the session that authorizes it.
   */
  app.post(
    `${CONNECTOR_MOUNT}/:slug/installations/:instanceKey/authorize`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug, instanceKey } = request.params as {
        slug: string;
        instanceKey: string;
      };
      try {
        const resolved = await resolveSessionContext(headersFromFastify(request.headers));
        requireConnectorAdmin({
          tenantId: resolved.tenantId,
          userId: resolved.userId,
          roles: [...resolved.roles],
        });

        if (!options.db) {
          return reply
            .status(503)
            .send({ error: { code: "DATABASE_NOT_CONFIGURED", message: "Database is not configured." } });
        }
        if (!options.config.keyring) {
          return reply.status(503).send({
            error: {
              code: "CONNECTOR_SECRETS_NOT_CONFIGURED",
              message: "Connector secret encryption is not configured on this deployment.",
            },
          });
        }

        const contract = findConnectorContract(slug);
        if (!contract) {
          return reply
            .status(404)
            .send({ error: { code: "CONNECTOR_NOT_FOUND", message: `Unknown connector "${slug}".` } });
        }
        if (!contract.auth) {
          return reply.status(400).send({
            error: {
              code: "CONNECTOR_OAUTH_FAILED",
              message: `Connector "${slug}" does not use OAuth.`,
            },
          });
        }

        const session = {
          tenantId: resolved.tenantId ?? "",
          userId: resolved.userId ?? "",
          roles: [...resolved.roles],
          groups: [...resolved.groups],
          scope: resolved.scope,
        };

        // The installation must exist first: its configuration holds the client
        // id and the endpoint template's values, and starting a flow without
        // them would send an operator to a provider URL that cannot work.
        const installations = await listInstallations(options.db, session);
        const installation = installations.find(
          (candidate) =>
            candidate.connectorSlug === slug && candidate.instanceKey === instanceKey,
        );
        if (!installation) {
          return reply.status(409).send({
            error: {
              code: "CONNECTOR_NOT_CONFIGURED",
              message: `Configure connector "${slug}" before authorizing it.`,
            },
          });
        }

        const clientId = installation.config[contract.auth.clientIdField];
        if (typeof clientId !== "string" || clientId === "") {
          return reply.status(409).send({
            error: {
              code: "CONNECTOR_NOT_CONFIGURED",
              message: `Set "${contract.auth.clientIdField}" before authorizing this connector.`,
            },
          });
        }

        const redirectUri = callbackUri(options);
        const { state, challenge } = await createAuthorizationState({
          db: options.db,
          session,
          keyring: options.config.keyring,
          connectorSlug: slug,
          instanceKey,
          redirectUri,
          now: now(),
        });

        const authorizeUrl = new URL(
          resolveEndpoint(contract.auth.authorizeUrl, installation.config),
        );
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        if (contract.auth.scopes.length > 0) {
          authorizeUrl.searchParams.set("scope", contract.auth.scopes.join(" "));
        }

        return reply.status(200).send({ authorizeUrl: authorizeUrl.toString() });
      } catch (error) {
        if (error instanceof ConnectorAuthorizationError) {
          return reply
            .status(error.code === "UNAUTHENTICATED" ? 401 : 403)
            .send({ error: { code: error.code, message: error.message } });
        }
        if (error instanceof ConnectorOAuthError) {
          return reply
            .status(500)
            .send({ error: { code: error.code, message: error.message } });
        }
        request.log.error({ err: error }, "Connector OAuth authorize failed.");
        return reply
          .status(500)
          .send({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
      }
    },
  );

  /**
   * The provider's redirect.
   *
   * Answers with a 302 to our own app in every case, success or failure: the
   * thing at the other end is a browser that followed a redirect, and showing
   * it a JSON error body would be a dead end for the person looking at it. The
   * reason travels in the audit trail and the logs, not in the URL.
   */
  app.get(OAUTH_CALLBACK_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const state = typeof query.state === "string" ? query.state : "";
    const code = typeof query.code === "string" ? query.code : "";
    let slug: string | undefined;

    try {
      // A provider that refused consent redirects with `error` and no code.
      // That is a normal outcome, not a fault.
      if (typeof query.error === "string") {
        request.log.info({ oauthError: query.error }, "Connector OAuth consent was refused.");
        return reply.redirect(landingUrl(options, undefined, "failed"), 302);
      }
      if (state === "" || code === "") {
        return reply.redirect(landingUrl(options, undefined, "failed"), 302);
      }
      if (!options.db || !options.config.keyring) {
        request.log.error("Connector OAuth callback reached with no database or keyring.");
        return reply.redirect(landingUrl(options, undefined, "failed"), 302);
      }

      // Claims the state, single-use, and yields the ONLY trustworthy account of
      // what this callback is for.
      const { tenantId, userId, record } = await consumeAuthorizationState({
        db: options.db,
        keyring: options.config.keyring,
        state,
        now: now(),
      });
      slug = record.connectorSlug;

      const contract = findConnectorContract(record.connectorSlug);
      if (!contract?.auth) {
        request.log.error(
          { slug: record.connectorSlug },
          "Connector OAuth callback for a contract that no longer declares auth.",
        );
        return reply.redirect(landingUrl(options, slug, "failed"), 302);
      }

      // The identity the state carried: the ConnectorAdmin who started the flow.
      const session = { tenantId, userId, roles: [] as string[] };
      const installations = await listInstallations(options.db, session);
      const installation = installations.find(
        (candidate) =>
          candidate.connectorSlug === record.connectorSlug &&
          candidate.instanceKey === record.instanceKey,
      );
      if (!installation) {
        request.log.error(
          { slug: record.connectorSlug },
          "Connector OAuth callback for an installation that no longer exists.",
        );
        return reply.redirect(landingUrl(options, slug, "failed"), 302);
      }

      const clientSecret = await readClientSecret(
        options,
        session,
        installation.id,
        contract.auth.clientSecretField,
      );
      const clientId = installation.config[contract.auth.clientIdField];
      if (typeof clientId !== "string" || clientSecret === undefined) {
        request.log.error(
          { slug: record.connectorSlug },
          "Connector OAuth callback with client credentials no longer configured.",
        );
        return reply.redirect(landingUrl(options, slug, "failed"), 302);
      }

      const controller = new AbortController();
      const tokens = await exchangeAuthorizationCode({
        contract,
        tokenUrl: resolveEndpoint(contract.auth.tokenUrl, installation.config),
        code,
        codeVerifier: record.codeVerifier,
        // From the row, not from the request: it has to be the exact string the
        // authorize call sent, and the provider refuses anything else.
        redirectUri: record.redirectUri,
        clientId,
        clientSecret,
        boundFetch: createBoundFetch(contract, controller.signal),
        now: now(),
      });

      await writeOAuthTokens({
        db: options.db,
        session,
        keyring: options.config.keyring,
        installationId: installation.id,
        tokens,
      });

      return reply.redirect(landingUrl(options, slug, "connected"), 302);
    } catch (error) {
      // Never surfaced to the browser: a provider's error text can carry the
      // code, the client id, or an account identifier.
      request.log.error({ err: error }, "Connector OAuth callback failed.");
      return reply.redirect(landingUrl(options, slug, "failed"), 302);
    }
  });
}

/** The client secret, decrypted for the one exchange that needs it. */
async function readClientSecret(
  options: ConnectorOAuthRouteOptions,
  session: { tenantId: string; userId: string; roles: string[] },
  installationId: string,
  field: string,
): Promise<string | undefined> {
  if (!options.db || !options.config.keyring) return undefined;
  const { readSecrets } = await import("./store.js");
  const secrets = await readSecrets(
    options.db,
    session,
    options.config.keyring,
    installationId,
  );
  return secrets[field];
}
