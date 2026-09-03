// SPDX-License-Identifier: BUSL-1.1
/**
 * Swagger UI for the generated REST API, at `/api/rest/docs`.
 *
 * Assets are served from THIS origin, out of the swagger-ui-dist package, not
 * from a CDN. A CDN would put a third-party script on the API's own domain —
 * able to read anything a user pastes into "Try it out", including a bearer
 * token — and would make the docs page depend on a host outside this
 * deployment. The cost is ~2 MB in the image, which is not worth trading for
 * either of those.
 *
 * Served unauthenticated, like the spec it renders. The page describes the API;
 * it does not grant access to it. Every request "Try it out" issues still has
 * to carry a valid bearer token, and the API refuses it otherwise.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST_OPENAPI_PATH } from "./rest-paths.js";

export const REST_DOCS_PATH = "/api/rest/docs";
export const REST_DOCS_OAUTH2_REDIRECT_PATH =
  `${REST_DOCS_PATH}/oauth2-redirect.html`;

/**
 * Assets are read ONCE at registration, not per request: they are immutable for
 * the life of the process, and a disk read per request would make a public,
 * unauthenticated endpoint into a trivial way to generate IO load.
 */
type Asset = { body: Buffer; type: string };

function loadAssets(oauth2Enabled: boolean): Record<string, Asset> | null {
  try {
    // createRequire rather than a bare import: swagger-ui-dist ships plain
    // files with no module entry point, so it is resolved for its location.
    const require = createRequire(import.meta.url);
    const dir = join(require.resolve("swagger-ui-dist/package.json"), "..");
    const read = (file: string, type: string): Asset => ({
      body: readFileSync(join(dir, file)),
      type,
    });
    const assets = {
      "swagger-ui.css": read("swagger-ui.css", "text/css; charset=utf-8"),
      "swagger-ui-bundle.js": read("swagger-ui-bundle.js", "text/javascript; charset=utf-8"),
      "swagger-ui-standalone-preset.js": read(
        "swagger-ui-standalone-preset.js",
        "text/javascript; charset=utf-8",
      ),
    };
    return oauth2Enabled
      ? {
          ...assets,
          "oauth2-redirect.html": read("oauth2-redirect.html", "text/html; charset=utf-8"),
          "oauth2-redirect.js": read(
            "oauth2-redirect.js",
            "text/javascript; charset=utf-8",
          ),
        }
      : assets;
  } catch {
    // Missing assets must not take the API down. The docs are a convenience;
    // the endpoints they document are not.
    return null;
  }
}

type SwaggerOAuthConfig = {
  clientId: string;
  redirectUrl?: string;
};

function swaggerOAuthConfig(openApiSpec: unknown): SwaggerOAuthConfig | null {
  if (!openApiSpec || typeof openApiSpec !== "object") return null;
  const components = (openApiSpec as Record<string, unknown>).components;
  if (!components || typeof components !== "object") return null;
  const schemes = (components as Record<string, unknown>).securitySchemes;
  if (!schemes || typeof schemes !== "object") return null;
  const oauth2 = (schemes as Record<string, unknown>).oauth2Auth;
  if (!oauth2 || typeof oauth2 !== "object") return null;
  const candidate = oauth2 as Record<string, unknown>;
  if (candidate.type !== "oauth2" || typeof candidate["x-swagger-ui-client-id"] !== "string") {
    return null;
  }
  const redirectUrl = candidate["x-swagger-ui-redirect-url"];
  return {
    clientId: candidate["x-swagger-ui-client-id"],
    ...(typeof redirectUrl === "string" ? { redirectUrl } : {}),
  };
}

/** Keep generated JavaScript literals inert even if copied into an HTML context later. */
function scriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const BASE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenShapeForge REST API</title>
    <link rel="stylesheet" href="${REST_DOCS_PATH}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${REST_DOCS_PATH}/swagger-ui-bundle.js"></script>
    <script src="${REST_DOCS_PATH}/swagger-ui-standalone-preset.js"></script>
    <script src="${REST_DOCS_PATH}/swagger-initializer.js"></script>
  </body>
</html>
`;

export function renderRestDocsPage(): string {
  return BASE_PAGE;
}

export function renderRestDocsInitializer(openApiSpec: unknown): string {
  const oauth2 = swaggerOAuthConfig(openApiSpec);
  const redirectUrl = oauth2?.redirectUrl
    ? scriptString(oauth2.redirectUrl)
    : `window.location.origin + ${scriptString(REST_DOCS_OAUTH2_REDIRECT_PATH)}`;
  const oauthOption = oauth2
    ? `\n  oauth2RedirectUrl: ${redirectUrl},`
    : "";
  const oauthInitialization = oauth2
    ? `\nwindow.ui.initOAuth({\n  clientId: ${scriptString(oauth2.clientId)},\n  usePkceWithAuthorizationCodeGrant: true,\n});`
    : "";

  return `window.ui = SwaggerUIBundle({
  url: ${JSON.stringify(REST_OPENAPI_PATH)},
  dom_id: "#swagger-ui",
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: "BaseLayout",
  deepLinking: true,${oauthOption}
  // Keep validation local: never disclose the generated spec URL to Swagger's hosted validator.
  validatorUrl: null,
  // Authorization is held in memory only and is discarded on reload.
  persistAuthorization: false,
});${oauthInitialization}
`;
}

export function registerRestDocs(app: FastifyInstance, openApiSpec: unknown): void {
  const oauth2Enabled = swaggerOAuthConfig(openApiSpec) !== null;
  const assets = loadAssets(oauth2Enabled);
  if (!assets) {
    app.log.warn(
      "swagger-ui-dist assets not found; REST docs UI disabled (the OpenAPI spec is still served)",
    );
    return;
  }

  app.get(REST_DOCS_PATH, async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(renderRestDocsPage()),
  );
  app.get(`${REST_DOCS_PATH}/swagger-initializer.js`, async (_request, reply) =>
    reply
      .type("text/javascript; charset=utf-8")
      .send(renderRestDocsInitializer(openApiSpec)),
  );

  for (const [name, asset] of Object.entries(assets)) {
    app.get(`${REST_DOCS_PATH}/${name}`, async (_request, reply) =>
      reply.type(asset.type).send(asset.body),
    );
  }
}
