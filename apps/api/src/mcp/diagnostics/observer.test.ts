// SPDX-License-Identifier: BUSL-1.1
import {test,expect}from"bun:test";
import Fastify from "fastify";
import {mkdtemp,rm}from"node:fs/promises";
import {tmpdir}from"node:os";
import {join}from"node:path";
import {randomUUID}from"node:crypto";
import type {TrustedSessionContext}from"../../auth/trusted-context.js";
import {DiagnosticJournal}from"./journal.js";
import {McpDiagnosticObserver,observeMcpHttp,bindDiagnosticSession,observeDiagnosticContract,diagnosticHeaders,beginMcpDiagnosticRequest,observeMcpDiagnosticHttpError}from"./observer.js";
import {diagnosticServices}from"./services.js";
const tenant=randomUUID(),actor=randomUUID();
const session={tenantId:tenant,userId:actor,roles:[]} as unknown as TrustedSessionContext;
test("real HTTP writes preserve an HTTP-200 tool failure, raw values and safe client headers",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-mcp-http-")),j=new DiagnosticJournal(path),app=Fastify();
 app.post('/mcp',async(request,reply)=>observeMcpHttp(request,reply,async()=>{
  bindDiagnosticSession(session);
  observeDiagnosticContract({name:'sample',description:'Exact offered words',inputSchema:{type:'object'}},undefined);
  reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream'});
  const data=JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:true,structuredContent:{error:{code:'VALIDATION',message:'Bad range'}},content:[]}});
  // Frame boundaries may be anywhere in the byte stream.
  reply.raw.write('event: message\r\ndata: '+data.slice(0,60));reply.raw.end(data.slice(60)+'\r\n\r\n');
 },j));
 try{
  await app.listen({port:0,host:'127.0.0.1'});
  const url=app.listeningOrigin+'/mcp';
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer real-looking-private-value','x-codex-turn-metadata':JSON.stringify({model:'test',turn_id:'turn-1'})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sample',arguments:{range:'wrong',unknownField:'valuable context',apiKey:'private'},_meta:{threadId:'chat-A',newClientField:{value:'retain'}}}})});
  expect(await response.text()).toContain('VALIDATION');
  const batch=await j.read(tenant),e=batch.events.find(event=>event.delivery==='sent')!;
  expect(e.httpStatus).toBe(200);expect(e.outcome).toBe('input_error');expect(e.delivery).toBe('sent');
  expect(e.arguments).toEqual({range:'wrong',unknownField:'valuable context',apiKey:{redacted:true,type:'string'}});
  expect(e.metadata.newClientField).toEqual({value:'retain'});expect(e.correlation.model).toBe('test');expect(e.correlation.conversationId).toBe('chat-A');
  expect(JSON.stringify(batch)).not.toContain('real-looking-private-value');
  expect(batch.snapshots.some(s=>JSON.stringify(s.content).includes('Exact offered words'))).toBe(true);
 }finally{await app.close();await rm(path,{recursive:true,force:true});}
});
test("authentication failures remain unassigned and schema-declared secrets are not written",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-mcp-http-"));try{
  const j=new DiagnosticJournal(path);
  const denied=new McpDiagnosticObserver(j,{method:'tools/call',params:{name:'sample',arguments:{name:'context'}}},{},'POST');
  denied.headers(401,'application/json');denied.chunk(JSON.stringify({error:{code:'UNAUTHORIZED',message:'Login required'}}));denied.finish();
  expect((await j.read(tenant)).events).toHaveLength(0);
  const allowed=new McpDiagnosticObserver(j,{method:'tools/call',params:{name:'sample',arguments:{ordinary:'keep',privateValue:'hide'}}},{},'POST');
  allowed.bind(session);allowed.contract({inputSchema:{properties:{privateValue:{type:'string',writeOnly:true}}}},undefined,'Exact instructions');
  allowed.operation({id:'sample.read',input:{schema:{properties:{ordinary:{type:'string'}}}}});
  allowed.headers(200,'application/json');allowed.chunk(JSON.stringify({id:2,result:{content:[]}}));allowed.finish();
  const batch=await j.read(tenant);expect(JSON.stringify(batch)).not.toContain('"hide"');expect(JSON.stringify(batch)).toContain('Exact instructions');
  expect(batch.events[0]!.arguments).toEqual({ordinary:'keep',privateValue:{redacted:true,type:'string'}});
 }finally{await rm(path,{recursive:true,force:true});}
});
test("the journal capability rejects forged or unprivileged sessions before touching storage",async()=>{
 const forged=diagnosticServices(()=>false),denied=diagnosticServices(()=>true);
 await expect(forged.read({...session,roles:['McpInsights.Manage']})).rejects.toThrow('live authorized');
 await expect(denied.read(session)).rejects.toThrow('live authorized');
 expect(diagnosticHeaders({authorization:'secret',cookie:'secret',traceparent:'trace','x-codex-token':'secret'})).toEqual({traceparent:'trace'});
});
test("a background task's terminal tool failure is distinguished from start acceptance",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-mcp-task-"));try{
  const j=new DiagnosticJournal(path),observer=new McpDiagnosticObserver(j,{method:'tasks/get',params:{taskId:'task-1'}},{},'POST');
  observer.bind(session);observer.headers(200,'application/json');
  observer.chunk(JSON.stringify({id:1,result:{status:'completed',taskId:'task-1',result:{isError:true,structuredContent:{error:{code:'UPSTREAM_TIMEOUT',message:'Provider unavailable'}},content:[{type:'text',text:JSON.stringify({apiKey:'must-hide',context:'keep me'})}]}}}));observer.finish();
  const b=await j.read(tenant);expect(b.events[0]!.outcome).toBe('runtime_error');expect(b.events[0]!.taskId).toBe('task-1');expect(JSON.stringify(b)).not.toContain('must-hide');expect(JSON.stringify(b)).toContain('keep me');
 }finally{await rm(path,{recursive:true,force:true});}
});
test("a masked HTTP error retains the underlying server failure in the separate journal",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-mcp-error-")),j=new DiagnosticJournal(path),app=Fastify();
 app.setErrorHandler((_error,_request,reply)=>{reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'Unexpected server error'}});});
 app.post('/mcp',async(request,reply)=>observeMcpHttp(request,reply,async()=>{bindDiagnosticSession(session);throw new Error('Synthetic parser failed at amount');},j));
 try{
  await app.listen({port:0,host:'127.0.0.1'});
  const response=await fetch(app.listeningOrigin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:1,method:'tools/call',params:{name:'sample',arguments:{amount:'bad'}}})});
  expect(await response.text()).not.toContain('Synthetic parser');
  const batch=await j.read(tenant);expect(JSON.stringify(batch)).toContain('Synthetic parser failed at amount');expect(batch.events.at(-1)!.outcome).toBe('runtime_error');
 }finally{await app.close();await rm(path,{recursive:true,force:true});}
});

test("malformed JSON is observed before the MCP handler or tenant authentication can run",async()=>{
 const path=await mkdtemp(join(tmpdir(),"osf-mcp-parse-")),journal=new DiagnosticJournal(path),app=Fastify();let called=false;
 app.route({url:'/mcp',method:'POST',onRequest:async(request,reply)=>beginMcpDiagnosticRequest(request,reply,journal),onError:async(request,_reply,error)=>observeMcpDiagnosticHttpError(request,error),handler:async()=>{called=true;return {};}});
 try{
  await app.listen({port:0,host:'127.0.0.1'});
  const response=await fetch(app.listeningOrigin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{"broken":'});await response.text();
  expect(response.status).toBe(400);expect(called).toBe(false);await journal.flush();
  const {readFile,readdir}=await import('node:fs/promises');const names=await readdir(join(path,'unassigned'));
  const record=JSON.parse(await readFile(join(path,'unassigned',names[0]!),'utf8'));
  expect(record.event.httpStatus).toBe(400);expect(record.event.tenantId).toBeNull();expect(record.event.truncated).toContain('/arguments/unparsedBody');expect(record.event.metadata.serverFailures.length).toBeGreaterThan(0);
 }finally{await app.close();await rm(path,{recursive:true,force:true});}
});
