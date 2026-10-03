// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { __resetSessionResolverForTests } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { registerArtifactRestRoutes } from "./rest-routes.js";
import { assertUploadFileName, limitUploadBody } from "./upload-input.js";

const SECRET = "artifact-route-test-secret";
const ARTIFACT_ID = "1658ad0b-e44b-4ef3-86ca-953dc6783885";
const DOCUMENT_ID = "6180f0f3-b637-4b9b-ac44-eb00cf30570a";

function authorizationHeaders(): Record<string, string> {
  const headers = new Headers({ "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("bewijs.pdf") });
  applyTrustedContextHeaders(headers, {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["CaseFile.All.ReadWrite"],
  }, { secret: SECRET });
  return Object.fromEntries(headers.entries());
}

describe("artifact REST adapter", () => {
  beforeEach(() => {
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = SECRET;
    __resetSessionResolverForTests();
  });
  afterEach(() => {
    delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    __resetSessionResolverForTests();
  });

  test("streams an authenticated upload into provider-neutral staging", async () => {
    let staged: { name: string; bytes: string; purpose: string } | undefined;
    const app = Fastify();
    registerArtifactRestRoutes(app, {
      artifacts: {
        async stage(_session: TrustedSessionContext, input) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of input.source) chunks.push(chunk);
          staged = { name: input.fileName, bytes: Buffer.concat(chunks).toString("utf8"), purpose: input.purpose };
          return { artifactId: ARTIFACT_ID, version: 1, fileName: input.fileName, mediaType: "application/pdf", sha256: "a".repeat(64), byteSize: 9 };
        },
        async bind() { throw new Error("unused"); },
        async read() { throw new Error("unused"); },
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/artifacts", headers: authorizationHeaders(), payload: "%PDF-test" });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ artifactId: ARTIFACT_ID, version: 1, fileName: "bewijs.pdf" });
    expect(staged).toEqual({ name: "bewijs.pdf", bytes: "%PDF-test", purpose: "record-upload" });
    await app.close();
  });

  test("downloads only through the bound document-version lookup", async () => {
    const app = Fastify();
    let owner: unknown;
    registerArtifactRestRoutes(app, {
      artifacts: {
        async stage() { throw new Error("unused"); },
        async bind() { throw new Error("unused"); },
        async read(_session, input) {
          owner = input;
          const bytes = new TextEncoder().encode("download");
          return { descriptor: { artifactId: ARTIFACT_ID, version: 2, fileName: "rapport.pdf", mediaType: "application/pdf", sha256: "b".repeat(64), byteSize: bytes.byteLength }, bytes, owner: input.owner };
        },
      },
    });
    const headers = authorizationHeaders();
    delete headers["content-type"];
    delete headers["x-file-name"];
    const response = await app.inject({ method: "GET", url: `/api/artifacts/${ARTIFACT_ID}/contents?ownerEntity=Document&ownerId=${DOCUMENT_ID}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("download");
    expect(response.headers["content-disposition"]).toContain('filename="rapport.pdf"');
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(owner).toEqual({ artifactId: ARTIFACT_ID, owner: { entity: "Document", id: DOCUMENT_ID } });
    await app.close();
  });

  test("rejects unauthenticated staging before storage is called", async () => {
    const app = Fastify();
    let called = false;
    registerArtifactRestRoutes(app, {
      artifacts: {
        async stage() { called = true; throw new Error("must not run"); },
        async bind() { throw new Error("unused"); },
        async read() { throw new Error("unused"); },
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/artifacts", headers: { "content-type": "application/octet-stream", "x-file-name": "a.pdf" }, payload: "x" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    expect(called).toBeFalse();
    await app.close();
  });

  test("enforces the upload limit the route declares", async () => {
    async function* chunks(...sizes: number[]) {
      for (const size of sizes) yield new Uint8Array(size);
    }
    async function drain(source: AsyncIterable<Uint8Array>): Promise<number> {
      let total = 0;
      for await (const chunk of source) total += chunk.byteLength;
      return total;
    }
    expect(await drain(limitUploadBody(chunks(4, 4), "8", 8))).toBe(8);
    expect(() => limitUploadBody(chunks(1), "9", 8)).toThrow("exceeds the upload limit");
    await expect(drain(limitUploadBody(chunks(4, 4, 1), undefined, 8))).rejects.toMatchObject({ status: 413, code: "ARTIFACT_TOO_LARGE" });
  });

  test("refuses file names that would display differently than they are", () => {
    expect(() => assertUploadFileName("bewijs.pdf")).not.toThrow();
    expect(() => assertUploadFileName("Offerte 2026 – définitief (v2).pdf")).not.toThrow();
    expect(() => assertUploadFileName("a\tb.pdf")).not.toThrow();
    for (const name of ["", "a/b.pdf", "a\\b.pdf", "a\nb.pdf", "a\u001bb.pdf", "invoice\u202Efdp.exe", "a\u2066b.pdf", "a\u200Fb.pdf",
      "a\u061Cb.pdf", "a\u2028b.pdf", "a\u0085b.pdf", "x".repeat(256)]) {
      expect(() => assertUploadFileName(name)).toThrow("The file name is invalid.");
    }
  });
});
