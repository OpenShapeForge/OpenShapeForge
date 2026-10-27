// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("runtime spans retain timing and nesting without SQL, operation names or failure details", async () => {
  const script = `
    const collected = [];
    const { bootstrapOpenTelemetry, shutdownOpenTelemetry, withRuntimeSpan, recordDatabaseQuery } = await import('./src/index.ts');
    let calls = 0;
    await withRuntimeSpan('mcp.request', async () => ++calls);
    const exporter = { export(spans, done) {
      collected.push(...spans.map(s => ({name:s.name,id:s.spanContext().spanId,parent:s.parentSpanContext?.spanId,attributes:s.attributes,events:s.events,status:s.status,duration:s.duration})));
      done({code:0});
    }, shutdown: async () => {} };
    bootstrapOpenTelemetry({serviceName:'runtime-test',traceExporter:exporter});
    const original = new Error('credential-secret-in-error');
    await withRuntimeSpan('mcp.request', async () => {
      await Promise.all(['secret-service-A','secret-service-B'].map(operationId => withRuntimeSpan('operation.execute', async () => {
        await new Promise(r => setTimeout(r, 5));
        recordDatabaseQuery(4.5, ${JSON.stringify('select secret_personal_field from "platform"."services" where token=\'sql-secret\'')});
        recordDatabaseQuery(NaN, 'select bad');
        recordDatabaseQuery(-1, 'select bad');
      }, {operationId})));
      try { await withRuntimeSpan('external.headers', async () => { throw original; }, {provider:'jira'}); }
      catch(e) { if(e !== original) throw Error('Failure identity changed'); }
    });
    await shutdownOpenTelemetry();
    process.stdout.write(JSON.stringify({calls,collected}));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const { calls, collected } = JSON.parse(stdout);
  expect(calls).toBe(1);
  expect(collected).toHaveLength(4);
  const root = collected.find((s: {name: string}) => s.name === "mcp.request");
  const operations = collected.filter((s: {name: string}) => s.name === "operation.execute");
  expect(operations).toHaveLength(2);
  expect(new Set(operations.map((s: {attributes: Record<string,string>}) => s.attributes["osf.operation.hash"])).size).toBe(2);
  for (const operation of operations) {
    expect(operation.parent).toBe(root.id);
    expect(operation.events).toHaveLength(1);
    expect(operation.events[0].attributes).toEqual({"db.operation.name":"select","osf.db.area":"platform","osf.db.duration_ms":4.5,"osf.db.failed":false});
  }
  expect(collected.find((s: {name: string}) => s.name === "external.headers").status).toEqual({code:2});
  for (const secret of ["secret-service-A","secret-service-B","secret_personal_field","sql-secret","credential-secret-in-error"]) expect(stdout).not.toContain(secret);
});
