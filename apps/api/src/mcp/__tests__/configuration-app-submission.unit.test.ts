// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Fastify, { type FastifyRequest } from "fastify";
import { withConfigurationCredential, configurationCredential } from "../configuration-credential.js";
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
    const result=await app.inject({method:"POST",url:`/api/entity-configuration/app/${pending.token}`,
      headers:{"content-type":"application/x-www-form-urlencoded",cookie:"untrusted",authorization:"Bearer attacker"},payload:"secret=synthetic"});
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
      const result=await app.inject({method:"POST",url:`/api/entity-configuration/app/${token}`,headers:{"content-type":"application/x-www-form-urlencoded",cookie:"session=fake"},payload:"secret=synthetic"});
      expect(result.statusCode).toBe(404);
    }
    expect(calls).toBe(0);
  } finally {await consumeConfiguration(pending.token);await app.close();}
});
