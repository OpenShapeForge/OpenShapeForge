import { expect, test, beforeEach, afterEach } from "bun:test";
import { retainConfigurationAppResult } from "../configuration-app-state.js";
import { mintConfiguration, consumeConfiguration } from "../configuration-handoff.js";
import { configurationAppResult } from "../handoff-results.js";

const originalOrigin = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
beforeEach(() => { process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN="https://example.test"; });
afterEach(() => { if (originalOrigin === undefined) delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN; else process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN=originalOrigin; });

test("fresh read cards retain private fields only in the owning session until consumed", async () => {
  const owner = { tenantId: "tenant", userId: "user" };
  const minted = await mintConfiguration({ tenantId: "tenant", userId: "user", table: "Connection", elicit: {} as any,
    modelValues: {}, definitions: [{ key: "secret", osfType: "string", required: true, secret: true }], displayName: "Provider" });
  const create = configurationAppResult({}, minted.token, "Provider", [{ key: "secret", osfType: "string" }]);
  await retainConfigurationAppResult(create, owner);
  const read = { content: [{ type: "text" as const, text: "ordinary read" }], structuredContent: { data: [], operations: [] } };
  const retained = await retainConfigurationAppResult(read, owner);
  expect(retained._meta?.configurationUrl).toBe(create._meta?.configurationUrl);
  expect(retained._meta?.configuration).toBeDefined();
  expect(retained.content).toEqual(read.content);
  expect(retained.structuredContent).toEqual(read.structuredContent);
  expect(JSON.stringify({content:retained.content, structuredContent:retained.structuredContent})).not.toContain(minted.token);
  expect((await retainConfigurationAppResult(read, { ...owner }))._meta).toBeUndefined();
  expect((await retainConfigurationAppResult({...read,isError:true}, owner))._meta).toBeUndefined();
  await consumeConfiguration(minted.token);
  expect((await retainConfigurationAppResult(read, owner))._meta).toBeUndefined();
});

test("a changed owner cannot receive the former handoff", async () => {
  const owner = { tenantId: "tenant", userId: "user" };
  const minted = await mintConfiguration({ ...owner, table: "Connection", elicit: {} as any, modelValues: {}, definitions: [], displayName: "Provider" });
  await retainConfigurationAppResult(configurationAppResult({},minted.token,"Provider",[]), owner);
  owner.tenantId="other";
  expect((await retainConfigurationAppResult({content:[]},owner))._meta).toBeUndefined();
  await consumeConfiguration(minted.token);
});
