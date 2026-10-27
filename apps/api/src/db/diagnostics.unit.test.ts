// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";

test("diagnostic dialect preserves driver receivers, hooks and explicit logging", async () => {
  const script = `
    const {bootstrapOpenTelemetry,shutdownOpenTelemetry,withRuntimeSpan}=await import('@openshapeforge/observability');
    const {databaseDiagnosticConfig}=await import('./diagnostics.ts');
    const {Kysely,PostgresDialect}=await import('kysely');
    const events=[], calls=[], connection={};
    class Driver {
      #identity=7;
      async init(){calls.push(['init',this.#identity])}
      async acquireConnection(){calls.push(['acquire',this.#identity]);return connection}
      async releaseConnection(value){if(value!==connection)throw Error('Connection changed');calls.push(['release',this.#identity])}
      async destroy(){calls.push(['destroy',this.#identity])}
    }
    const adapter={}, compiler={}, introspector={}, dialect={createAdapter:()=>adapter,createQueryCompiler:()=>compiler,createIntrospector:()=>introspector,createDriver:()=>new Driver()};
    if(databaseDiagnosticConfig(dialect).dialect!==dialect)throw Error('Disabled path changed');
    bootstrapOpenTelemetry({serviceName:'db-diagnostics-test',traceExporter:{export(spans,done){events.push(...spans.map(s=>({name:s.name,events:s.events})));done({code:0})},shutdown:async()=>{}}});
    const explicit=()=>{}, config=databaseDiagnosticConfig(dialect);
    if(databaseDiagnosticConfig(dialect,explicit).log!==explicit)throw Error('Explicit logger replaced');
    if(config.dialect.createAdapter()!==adapter||config.dialect.createQueryCompiler()!==compiler||config.dialect.createIntrospector({})!==introspector)throw Error('Dialect delegate changed');
    const driver=config.dialect.createDriver();
    await withRuntimeSpan('mcp.request',async()=>{
      await driver.init();const c=await driver.acquireConnection();await driver.releaseConnection(c);await driver.destroy();
      const query=new Kysely({dialect:new PostgresDialect({pool:{}})}).selectFrom('platform.entity_events').selectAll().compile();
      config.log({level:'query',query,queryDurationMillis:2});
      config.log({level:'error',query,queryDurationMillis:3,error:Error('private-error')});
    });
    await shutdownOpenTelemetry();
    console.log(JSON.stringify({events,calls}));
  `;
  const child = Bun.spawn([process.execPath,"--eval",script],{cwd:import.meta.dir,stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,stderr).toBe(0);
  const {events,calls}=JSON.parse(stdout);
  expect(calls).toEqual([["init",7],["acquire",7],["release",7],["destroy",7]]);
  expect(events.filter((x:{name:string})=>x.name==="database.acquire")).toHaveLength(1);
  const queries=events.find((x:{name:string})=>x.name==="mcp.request").events;
  expect(queries.map((x:{attributes:Record<string,unknown>})=>x.attributes)).toEqual([
    {"db.operation.name":"select","osf.db.area":"platform","osf.db.duration_ms":2,"osf.db.failed":false},
    {"db.operation.name":"select","osf.db.area":"platform","osf.db.duration_ms":3,"osf.db.failed":true},
  ]);
  expect(stdout).not.toContain("entity_events");
  expect(stdout).not.toContain("private-error");
});
