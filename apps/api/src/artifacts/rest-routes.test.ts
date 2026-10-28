// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { __resetSessionResolverForTests } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { registerArtifactRestRoutes } from "./rest-routes.js";
import { ARTIFACT_UPLOAD_LIMIT_BYTES, assertUploadFileName, limitUploadBody } from "./upload-input.js";

const SECRET = "artifact-route-test-secret";
const ARTIFACT_ID = "1658ad0b-e44b-4ef3-86ca-953dc6783885";
const DOCUMENT_ID = "6180f0f3-b637-4b9b-ac44-eb00cf30570a";

function authorizationHeaders(tenantId = "tenant-a"): Record<string, string> {
  const headers = new Headers({ "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("bewijs.pdf") });
  applyTrustedContextHeaders(headers, {
    tenantId,
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

  test("refuses a body over the upload limit before storage is called", async () => {
    const app = Fastify();
    let called = false;
    registerArtifactRestRoutes(app, {
      artifacts: {
        async stage() { called = true; throw new Error("must not run"); },
        async bind() { throw new Error("unused"); },
        async read() { throw new Error("unused"); },
      },
    });
    const response = await app.inject({
      method: "POST", url: "/api/artifacts", headers: authorizationHeaders(),
      payload: Buffer.alloc(ARTIFACT_UPLOAD_LIMIT_BYTES + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("ARTIFACT_TOO_LARGE");
    expect(called).toBeFalse();
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
test("a stalled tenant cannot occupy every download slot", async () => {
  const app = Fastify();
  let finish!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const bothStarted = new Promise<void>((resolve) => { started = resolve; });
  let pendingA = 0;
  registerArtifactRestRoutes(app, { artifacts: {
    stage: async () => { throw Error("unused"); }, bind: async () => { throw Error("unused"); },
    read: async (session, input) => {
      if (session.tenantId === "tenant-a") { if (++pendingA === 2) started(); await gate; }
      const bytes = Uint8Array.of(1);
      return { descriptor: { artifactId: ARTIFACT_ID, version: 1, fileName: "a.bin", mediaType: "application/octet-stream", sha256: "a".repeat(64), byteSize: 1 }, bytes, owner: input.owner };
    },
  } });
  const path = `/api/artifacts/${ARTIFACT_ID}/contents?ownerEntity=Document&ownerId=${DOCUMENT_ID}`;
  const request = (tenant: string) => app.inject({ method: "GET", url: path, headers: authorizationHeaders(tenant) });
  const pending = [Promise.resolve(request("tenant-a")), Promise.resolve(request("tenant-a"))];
  try {
    await bothStarted;
    expect((await request("tenant-a")).statusCode).toBe(429);
    expect((await request("tenant-b")).statusCode).toBe(200);
  } finally { finish(); await Promise.all(pending); await app.close(); }
});

test("download capacity includes in-flight reads and recovers after they finish",async()=>{
 const app=Fastify(); let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered=0;
 let enteredAll!:()=>void; const all=new Promise<void>(r=>{enteredAll=r;});
 registerArtifactRestRoutes(app,{artifacts:{stage:async()=>{throw Error('unused');},bind:async()=>{throw Error('unused');},read:async(_s,input)=>{
  if(++entered===4)enteredAll();await gate;const bytes=Uint8Array.of(1,2,3);
  return {descriptor:{artifactId:ARTIFACT_ID,version:1,fileName:'test.bin',mediaType:'application/octet-stream',sha256:'a'.repeat(64),byteSize:3},bytes,owner:input.owner};
 }}});
 const headers=authorizationHeaders();delete headers['content-type'];
 const request=(tenant = "tenant-a")=>app.inject({method:'GET',url:`/api/artifacts/${ARTIFACT_ID}/contents?ownerEntity=Document&ownerId=${DOCUMENT_ID}`,headers:tenant === "tenant-a" ? headers : authorizationHeaders(tenant)});
 const pending=Array.from({length:4},(_,i)=>Promise.resolve(request(i < 2 ? "tenant-a" : "tenant-b")));
 await all;
 try {expect((await request()).statusCode).toBe(429);}finally{release();}
 expect((await Promise.all(pending)).map(x=>x.statusCode)).toEqual([200,200,200,200]);
 expect((await request()).statusCode).toBe(200);await app.close();
});

 test("a response close cannot release reads still buffering provider data", async () => {
   const app = Fastify();
   const responses: import("node:http").ServerResponse[] = [];
   let finishRead!: () => void, allStarted!: () => void;
   const gate = new Promise<void>(r => { finishRead = r; });
   const startedGate = new Promise<void>(r => { allStarted = r; });
   let started = 0;
   app.addHook("onRequest", async (_request, reply) => { responses.push(reply.raw); });
   registerArtifactRestRoutes(app, {artifacts:{stage:async()=>{throw Error("unused");},bind:async()=>{throw Error("unused");},read:async(_s,input)=>{
     if (++started === 4) allStarted();
     await gate;
     return {descriptor:{artifactId:ARTIFACT_ID,version:1,fileName:"a.bin",mediaType:"application/octet-stream",sha256:"a".repeat(64),byteSize:1},bytes:Uint8Array.of(1),owner:input.owner};
   }}});
   const headers = authorizationHeaders(); delete headers["content-type"];
   const path = `/api/artifacts/${ARTIFACT_ID}/contents?ownerEntity=Document&ownerId=${DOCUMENT_ID}`;
   const pending = Array.from({length:4},(_,i)=>Promise.resolve(app.inject({method:"GET",url:path,headers:i < 2 ? headers : authorizationHeaders("tenant-b")})).catch(error => { expect(error.code).toBe("LIGHT_ECONNRESET"); }));
   try {
     await startedGate;
     // Deterministically reproduce the socket-close event while storage is suspended.
     for (const response of responses) response.emit("close");
     expect((await app.inject({method:"GET",url:path,headers})).statusCode).toBe(429);
     expect(started).toBe(4);
   } finally { finishRead(); await Promise.all(pending); await app.close(); }
 });

});
