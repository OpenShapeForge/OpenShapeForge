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

/**
 * Assets are read ONCE at registration, not per request: they are immutable for
 * the life of the process, and a disk read per request would make a public,
 * unauthenticated endpoint into a trivial way to generate IO load.
 */
type Asset = { body: Buffer; type: string };

function loadAssets(): Record<string, Asset> | null {
  try {
    // createRequire rather than a bare import: swagger-ui-dist ships plain
    // files with no module entry point, so it is resolved for its location.
    const require = createRequire(import.meta.url);
    const dir = join(require.resolve("swagger-ui-dist/package.json"), "..");
    const read = (file: string, type: string): Asset => ({
      body: readFileSync(join(dir, file)),
      type,
    });
    return {
      "swagger-ui.css": read("swagger-ui.css", "text/css; charset=utf-8"),
      "swagger-ui-bundle.js": read("swagger-ui-bundle.js", "text/javascript; charset=utf-8"),
      "swagger-ui-standalone-preset.js": read(
        "swagger-ui-standalone-preset.js",
        "text/javascript; charset=utf-8",
      ),
    };
  } catch {
    // Missing assets must not take the API down. The docs are a convenience;
    // the endpoints they document are not.
    return null;
  }
}

const PAGE = `<!doctype html>
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
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(REST_OPENAPI_PATH)},
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "BaseLayout",
        deepLinking: true,
        // The API authenticates with a bearer token, so offer the box for one.
        persistAuthorization: false,
      });
    </script>
  </body>
</html>
`;

export function registerRestDocs(app: FastifyInstance): void {
  const assets = loadAssets();
  if (!assets) {
    app.log.warn(
      "swagger-ui-dist assets not found; REST docs UI disabled (the OpenAPI spec is still served)",
    );
    return;
  }

  app.get(REST_DOCS_PATH, async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(PAGE),
  );

  for (const [name, asset] of Object.entries(assets)) {
    app.get(`${REST_DOCS_PATH}/${name}`, async (_request, reply) =>
      reply.type(asset.type).send(asset.body),
    );
  }
}
