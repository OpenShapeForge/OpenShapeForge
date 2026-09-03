// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  REST_DOCS_OAUTH2_REDIRECT_PATH,
  REST_DOCS_PATH,
  registerRestDocs,
  renderRestDocsInitializer,
} from "./rest-docs.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function oauthSpec(redirectUrl?: string): Record<string, unknown> {
  return {
    components: {
      securitySchemes: {
        oauth2Auth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://identity.example.com/oauth/authorize",
              tokenUrl: "https://identity.example.com/oauth/token",
              scopes: { openid: "Sign in" },
            },
          },
          "x-swagger-ui-client-id": "public-docs-client",
          ...(redirectUrl ? { "x-swagger-ui-redirect-url": redirectUrl } : {}),
        },
      },
    },
  };
}

async function registeredDocs(spec: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerRestDocs(app, spec);
  await app.ready();
  return app;
}

describe("REST Swagger OAuth runtime", () => {
  test("preserves the bearer-only page and routes when OAuth is absent", async () => {
    const app = await registeredDocs({
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    });

    const page = await app.inject({ method: "GET", url: REST_DOCS_PATH });
    expect(page.statusCode).toBe(200);
    expect(page.body.match(/<script\b[^>]*>/g)).toEqual([
      `<script src="${REST_DOCS_PATH}/swagger-ui-bundle.js">`,
      `<script src="${REST_DOCS_PATH}/swagger-ui-standalone-preset.js">`,
      `<script src="${REST_DOCS_PATH}/swagger-initializer.js">`,
    ]);
    expect(page.body).not.toContain("<script>");
    const initializer = await app.inject({
      method: "GET",
      url: `${REST_DOCS_PATH}/swagger-initializer.js`,
    });
    expect(initializer.statusCode).toBe(200);
    expect(initializer.body).toContain("persistAuthorization: false");
    expect(initializer.body).toContain("validatorUrl: null");
    expect(initializer.body).not.toContain("validator.swagger.io");
    expect(initializer.body).not.toContain("initOAuth");
    expect(initializer.body).not.toContain("oauth2RedirectUrl");
    expect(
      (await app.inject({ method: "GET", url: REST_DOCS_OAUTH2_REDIRECT_PATH })).statusCode,
    ).toBe(404);
  });

  test("serves the packaged callback and initializes a public PKCE client", async () => {
    const app = await registeredDocs(oauthSpec());

    const page = await app.inject({ method: "GET", url: REST_DOCS_PATH });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("<script>");
    const initializer = await app.inject({
      method: "GET",
      url: `${REST_DOCS_PATH}/swagger-initializer.js`,
    });
    expect(initializer.statusCode).toBe(200);
    expect(initializer.headers["content-type"]).toContain("text/javascript");
    expect(initializer.body).toContain(
      `oauth2RedirectUrl: window.location.origin + "${REST_DOCS_OAUTH2_REDIRECT_PATH}"`,
    );
    expect(initializer.body).toContain("window.ui.initOAuth({");
    expect(initializer.body).toContain('clientId: "public-docs-client"');
    expect(initializer.body).toContain("usePkceWithAuthorizationCodeGrant: true");
    expect(initializer.body).toContain("persistAuthorization: false");
    expect(initializer.body).toContain("validatorUrl: null");
    expect(initializer.body).not.toContain("validator.swagger.io");
    expect(initializer.body).not.toContain("clientSecret");

    const callback = await app.inject({
      method: "GET",
      url: REST_DOCS_OAUTH2_REDIRECT_PATH,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.headers["content-type"]).toContain("text/html");
    expect(callback.body).toContain('<script src="oauth2-redirect.js"></script>');
    const callbackScripts = [...callback.body.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    )];
    expect(callbackScripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of callbackScripts) {
      expect(attributes).toMatch(/\bsrc\s*=/i);
      expect(body?.trim()).toBe("");
    }

    const callbackScript = await app.inject({
      method: "GET",
      url: `${REST_DOCS_PATH}/oauth2-redirect.js`,
    });
    expect(callbackScript.statusCode).toBe(200);
    expect(callbackScript.headers["content-type"]).toContain("text/javascript");
  });

  test("uses an explicit callback URL and safely embeds public authoring strings", () => {
    const initializer = renderRestDocsInitializer({
      components: {
        securitySchemes: {
          oauth2Auth: {
            type: "oauth2",
            "x-swagger-ui-client-id": "docs</script><script>alert(1)</script>",
            "x-swagger-ui-redirect-url":
              "https://api.example.com/api/rest/docs/oauth2-redirect.html",
          },
        },
      },
    });

    expect(initializer).toContain(
      'oauth2RedirectUrl: "https://api.example.com/api/rest/docs/oauth2-redirect.html"',
    );
    expect(initializer).toContain("docs\\u003c/script\\u003e");
    expect(initializer).not.toContain("docs</script>");
  });
});
