// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Fastify from "fastify";
import { mintConfiguration, consumeConfiguration } from "../configuration-handoff.js";
import { registerConfigurationHandoffRoutes } from "../configuration-handoff-routes.js";

test("browser handoff redirects the exact pending form to authenticated web admission", async () => {
  const previous = process.env.OPENSHAPEFORGE_WEB_ORIGIN;
  process.env.OPENSHAPEFORGE_WEB_ORIGIN = "https://app.example.test";
  const minted = await mintConfiguration({tenantId:"tenant",userId:"actor",table:"test",elicit:{} as never,modelValues:{},definitions:[],displayName:"Test"});
  const app = Fastify();
  await registerConfigurationHandoffRoutes({instance:app,options:{},requireMcpSession:async()=>{throw Error("Identity still required");}});
  try {
    const response = await app.inject(`/api/entity-configuration/${minted.token}`);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`https://app.example.test/configuration?formId=${minted.id}`);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body).not.toContain(minted.token);
    const submission = await app.inject({method:"POST",url:`/api/entity-configuration/${minted.token}`,headers:{"content-type":"application/x-www-form-urlencoded"},payload:"secret=value"});
    expect(submission.statusCode).not.toBe(200);
    delete process.env.OPENSHAPEFORGE_WEB_ORIGIN;
    expect((await app.inject(`/api/entity-configuration/${minted.token}`)).statusCode).toBe(503);
  } finally {
    if (previous === undefined) delete process.env.OPENSHAPEFORGE_WEB_ORIGIN; else process.env.OPENSHAPEFORGE_WEB_ORIGIN = previous;
    await consumeConfiguration(minted.token); await app.close();
  }
});
