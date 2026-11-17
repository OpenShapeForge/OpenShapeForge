// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Fastify, { type FastifyRequest } from "fastify";
import { withConfigurationCredential, configurationCredential, configurationCredentialExpiry } from "../configuration-credential.js";
import { mintConfiguration, peekConfiguration, consumeConfiguration } from "../configuration-handoff.js";
import { registerConfigurationHandoffRoutes } from "../configuration-handoff-routes.js";
import { HttpError } from "../../rest/http-error.js";

const issuing = {method:"POST",url:"/org-test",hostname:"api.example.test",protocol:"https",params:{alias:"org-test"},
  headers:{authorization:"Bearer synthetic-original"}} as FastifyRequest;
const mint = () => mintConfiguration({tenantId:"tenant",userId:"person",table:"test",elicit:{} as never,modelValues:{},definitions:[],displayName:"Test"});

test("only the active issuing request can attach a private credential", async () => {
  let late: () => unknown;
  const pending = await withConfigurationCredential(issuing, async () => { late = configurationCredential; return mint(); });
  try {
    expect(late!()).toBeUndefined();
    expect((await peekConfiguration(pending.token))?.submissionCredential).toMatchObject({authorization:"Bearer synthetic-original",path:"/org-test",alias:"org-test"});
    expect(pending).not.toHaveProperty("submissionCredential");
  } finally { await consumeConfiguration(pending.token); }
});

test("app submission revalidates the original bearer and resource before touching storage", async () => {
  const pending = await withConfigurationCredential(issuing, mint);
  let calls = 0;
  const app = Fastify();
  await registerConfigurationHandoffRoutes({instance:app,options:{},requireMcpSession:async request => {
    calls++; expect(request.url).toBe("/org-test"); expect(request.params).toEqual({alias:"org-test"});
    expect(request.headers.authorization).toBe("Bearer synthetic-original");
    expect(request.headers.cookie).toBeUndefined(); throw new HttpError(401,"UNAUTHENTICATED","Sign in again.");
  }});
  try {
    const result=await app.inject({method:"POST",url:"/api/entity-configuration/app",
      headers:{"content-type":"application/x-www-form-urlencoded",cookie:"untrusted",authorization:`Form ${pending.token}`},payload:"secret=synthetic"});
    expect(result.statusCode).toBe(401); expect(result.headers["access-control-allow-origin"]).toBe("*");
    expect(calls).toBe(1); expect(await peekConfiguration(pending.token)).not.toBeNull();
    expect(result.body).not.toContain("synthetic-original");
  } finally { await consumeConfiguration(pending.token); await app.close(); }
});

test("an unknown, consumed or non-app handoff never accepts a cookie as authorization", async () => {
  const pending=await mint(); const app=Fastify();let calls=0;
  await registerConfigurationHandoffRoutes({instance:app,options:{},requireMcpSession:async()=>{calls++;throw Error("must not reach admission");}});
  try {
    for (const token of [pending.token,"unknown"]) {
      const result=await app.inject({method:"POST",url:"/api/entity-configuration/app",headers:{"content-type":"application/x-www-form-urlencoded",cookie:"session=fake",authorization:`Form ${token}`},payload:"secret=synthetic"});
      expect(result.statusCode).toBe(404);
    }
    expect(calls).toBe(0);
  } finally {await consumeConfiguration(pending.token);await app.close();}
});

test("form capability preflight grants no cookie access and bad content stays unconsumed", async () => {
  const pending=await withConfigurationCredential(issuing,mint);const app=Fastify();
  await registerConfigurationHandoffRoutes({instance:app,options:{},requireMcpSession:async()=>({db:{} as never,session:{tenantId:"tenant",userId:"person"},resource:"/org-test"}) as never});
  try {
    const preflight=await app.inject({method:"OPTIONS",url:"/api/entity-configuration/app",headers:{origin:"https://app.example.test","access-control-request-method":"POST","access-control-request-headers":"authorization"}});
    expect(preflight.statusCode).toBe(204);expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(preflight.headers["access-control-allow-headers"]).toContain("authorization");
    const result=await app.inject({method:"POST",url:"/api/entity-configuration/app",headers:{authorization:`Form ${pending.token}`,"content-type":"text/plain"},payload:"secret=synthetic"});
    expect(result.statusCode).toBe(415);expect(await peekConfiguration(pending.token)).not.toBeNull();
  } finally {await consumeConfiguration(pending.token);await app.close();}
});

test("an issuing JWT can shorten the form lifetime but cannot extend it",()=>{
  const maximum=Date.now()+30*60*1000;
  for(const exp of [Math.floor(Date.now()/1000)+60,Math.floor(maximum/1000)+3600]){
    const credential={authorization:`Bearer e30.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.synthetic`,path:"/api/mcp",hostname:"localhost",protocol:"http"};
    expect(configurationCredentialExpiry(credential,maximum)).toBe(Math.min(exp*1000,maximum));
  }
});
